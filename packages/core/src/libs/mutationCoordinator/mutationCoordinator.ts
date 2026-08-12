import { AsyncLocalStorage } from 'node:async_hooks'

export type MutationClaim = {
  global?: boolean
  noteIds?: Iterable<string | null | undefined>
  paths?: Iterable<string | null | undefined>
  prefixes?: Iterable<string | null | undefined>
}

type Claim = {
  global: boolean
  noteIds: Set<string>
  paths: Set<string>
  prefixes: Set<string>
}

type Waiter = {
  claim: Claim
  ticket: number
  start: (lease: Lease) => void
}

type Lease = {
  release: () => void
  retry: (claim: Claim) => Promise<Lease>
}

const cleanPath = (path: string): string => path.replace(/^\/+|\/+$/g, '')

const values = (
  source: Iterable<string | null | undefined> | undefined,
  normalize: (value: string) => string = (value) => value,
): Set<string> => {
  const out = new Set<string>()

  for (const value of source ?? []) {
    if (value == null) {
      continue
    }
    const normalized = normalize(value)

    if (normalized) {
      out.add(normalized)
    }
  }

  return out
}

const normalizeClaim = (claim: MutationClaim): Claim => ({
  global: claim.global === true,
  noteIds: values(claim.noteIds),
  paths: values(claim.paths, cleanPath),
  prefixes: values(claim.prefixes, cleanPath),
})

const union = (a: Claim, b: Claim): Claim => ({
  global: a.global || b.global,
  noteIds: new Set([...a.noteIds, ...b.noteIds]),
  paths: new Set([...a.paths, ...b.paths]),
  prefixes: new Set([...a.prefixes, ...b.prefixes]),
})

const contains = (superset: Set<string>, subset: Set<string>): boolean => {
  for (const value of subset) {
    if (!superset.has(value)) {
      return false
    }
  }

  return true
}

const covers = (held: Claim, current: Claim): boolean =>
  (!current.global || held.global) &&
  contains(held.noteIds, current.noteIds) &&
  contains(held.paths, current.paths) &&
  contains(held.prefixes, current.prefixes)

const intersects = (a: Set<string>, b: Set<string>): boolean => {
  for (const value of a) {
    if (b.has(value)) {
      return true
    }
  }

  return false
}

const isUnder = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`)

const conflicts = (a: Claim, b: Claim): boolean => {
  if (a.global || b.global) {
    return true
  }
  if (intersects(a.noteIds, b.noteIds) || intersects(a.paths, b.paths)) {
    return true
  }
  for (const path of a.paths) {
    for (const prefix of b.prefixes) {
      if (isUnder(path, prefix)) {
        return true
      }
    }
  }
  for (const path of b.paths) {
    for (const prefix of a.prefixes) {
      if (isUnder(path, prefix)) {
        return true
      }
    }
  }
  for (const aPrefix of a.prefixes) {
    for (const bPrefix of b.prefixes) {
      if (isUnder(aPrefix, bPrefix) || isUnder(bPrefix, aPrefix)) {
        return true
      }
    }
  }

  return false
}

/** Fair per-process fence: conflicting claims keep arrival order; unrelated claims run in parallel.
 *  @see docs/core.md#write-through */
export class MutationCoordinator {
  private readonly active = new Set<Waiter>()
  private waiting: Waiter[] = []
  private nextTicket = 0
  /** Tracks, per async call chain, whether a lease of THIS coordinator is already
   *  held. Claims are not re-entrant and the queue is fair, so a task that takes
   *  one while holding another can wait forever behind a waiter that wants what it
   *  holds. Work that must run claimed but can be reached from either side asks
   *  `holds()` instead of guessing from its call site. */
  private readonly leased = new AsyncLocalStorage<true>()

  /** Whether the caller is already running inside one of this coordinator's leases. */
  holds(): boolean {
    return this.leased.getStore() === true
  }

  async run<T>(claim: MutationClaim, task: () => Promise<T>): Promise<T> {
    const lease = await this.acquire(normalizeClaim(claim))

    try {
      return await this.leased.run(true, task)
    } finally {
      lease.release()
    }
  }

  /** Acquire resources derived from mutable read-model state. A queued move may
   *  change a note's path or a destination's owner while this waiter sleeps; in
   *  that case no side effect has started yet, so retain every observed
   *  resource and requeue the original ticket until the held claim covers a
   *  fresh derivation. Requeue is atomic with releasing the old claim, so its
   *  ticket keeps priority over later waiters still in the queue. */
  async runStable<T>(claimFor: () => MutationClaim, task: () => Promise<T>): Promise<T> {
    let claim = normalizeClaim(claimFor())
    let lease = await this.acquire(claim)

    for (;;) {
      let current: Claim

      try {
        current = normalizeClaim(claimFor())
      } catch (err) {
        lease.release()
        throw err
      }

      if (!covers(claim, current)) {
        claim = union(claim, current)
        lease = await lease.retry(claim)
        continue
      }
      try {
        return await this.leased.run(true, task)
      } finally {
        lease.release()
      }
    }
  }

  private acquire(claim: Claim): Promise<Lease> {
    return this.enqueue(claim, this.nextTicket++)
  }

  private enqueue(claim: Claim, ticket: number): Promise<Lease> {
    return new Promise((start) => {
      this.waiting.push({ claim, ticket, start })
      this.waiting.sort((a, b) => a.ticket - b.ticket)
      this.drain()
    })
  }

  private drain(): void {
    const stillWaiting: Waiter[] = []
    const starters: Waiter[] = []

    for (const waiter of this.waiting) {
      const activeConflict = [...this.active].some((entry) => conflicts(entry.claim, waiter.claim))
      const earlierConflict = stillWaiting.some((entry) => conflicts(entry.claim, waiter.claim))

      if (activeConflict || earlierConflict) {
        stillWaiting.push(waiter)
        continue
      }
      this.active.add(waiter)
      starters.push(waiter)
    }
    this.waiting = stillWaiting

    for (const waiter of starters) {
      let held = true

      waiter.start({
        release: () => {
          if (!held) {
            return
          }
          held = false
          this.active.delete(waiter)
          this.drain()
        },
        retry: (claim) => {
          if (!held) {
            return Promise.reject(new Error('mutation lease is no longer held'))
          }
          held = false
          this.active.delete(waiter)
          return this.enqueue(claim, waiter.ticket)
        },
      })
    }
  }
}
