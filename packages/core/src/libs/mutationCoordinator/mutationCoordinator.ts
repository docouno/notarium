import { AsyncLocalStorage } from 'node:async_hooks'

export type MutationClaim = {
  global?: boolean
  /** Opaque process-local resources that are neither note ids nor paths. */
  resources?: Iterable<string | null | undefined>
  noteIds?: Iterable<string | null | undefined>
  paths?: Iterable<string | null | undefined>
  prefixes?: Iterable<string | null | undefined>
}

type Claim = {
  global: boolean
  resources: Set<string>
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

type HeldClaim = {
  active: boolean
  claim: Claim
  children: Set<Promise<unknown>>
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
  resources: values(claim.resources),
  noteIds: values(claim.noteIds),
  paths: values(claim.paths, cleanPath),
  prefixes: values(claim.prefixes, cleanPath),
})

const union = (a: Claim, b: Claim): Claim => ({
  global: a.global || b.global,
  resources: new Set([...a.resources, ...b.resources]),
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

const isUnder = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`)

const pathsCover = (held: Claim, paths: Set<string>): boolean => {
  for (const path of paths) {
    if (!held.paths.has(path) && ![...held.prefixes].some((prefix) => isUnder(path, prefix))) {
      return false
    }
  }

  return true
}

/** A global lease fences everything, so it covers any candidate. Below that, a
 *  candidate PATH may also fall under a held prefix — the same reach `conflicts`
 *  gives that prefix — while a candidate PREFIX must be one the lease itself took. */
const covers = (held: Claim, current: Claim): boolean =>
  held.global ||
  (!current.global &&
    contains(held.resources, current.resources) &&
    contains(held.noteIds, current.noteIds) &&
    pathsCover(held, current.paths) &&
    contains(held.prefixes, current.prefixes))

const intersects = (a: Set<string>, b: Set<string>): boolean => {
  for (const value of a) {
    if (b.has(value)) {
      return true
    }
  }

  return false
}

const conflicts = (a: Claim, b: Claim): boolean => {
  if (a.global || b.global) {
    return true
  }
  if (
    intersects(a.resources, b.resources) ||
    intersects(a.noteIds, b.noteIds) ||
    intersects(a.paths, b.paths)
  ) {
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
  /** Tracks the active normalized claim of THIS coordinator per async call chain.
   * Claims are not re-entrant and the queue is fair, so a task that takes one while
   * holding another can wait forever behind a waiter that wants what it holds.
   * Each admitted callback owns a child scope: detached descendants retain its
   * async-local object, but cannot join after that callback completes. */
  private readonly leased = new AsyncLocalStorage<HeldClaim>()

  /** Whether this call chain inherited a claim context, including one whose
   * lease has already expired. A late detached descendant must not mistake an
   * inactive inherited context for a fresh top-level caller. */
  hasClaimContext(): boolean {
    return this.leased.getStore() !== undefined
  }

  /** Whether the caller runs inside a still-ACTIVE lease of this coordinator.
   * An inherited context alone does not answer that: a detached descendant keeps
   * the async-local object after the lease callback it was started from has
   * already returned. Coverage of a specific candidate is not asked here — the
   * only thing that adopts one, `runWithinHeld`, tests it where it acts on it. */
  holds(): boolean {
    return this.leased.getStore()?.active === true
  }

  /** Run a callback inside the caller's already-held covering claim and join its
   * lifetime to that lease. This does not acquire or re-enter the fair queue: it
   * is the scoped adoption point used by exact-note compound operations only. */
  runWithinHeld<T>(candidate: MutationClaim, task: () => Promise<T>): Promise<T> {
    const parent = this.leased.getStore()

    if (!parent?.active || !covers(parent.claim, normalizeClaim(candidate))) {
      return Promise.reject(new Error('mutation claim is not covered by an active caller lease'))
    }

    const child: HeldClaim = {
      active: true,
      claim: parent.claim,
      children: new Set(),
    }
    const pending = this.runHeld(child, task)

    parent.children.add(pending)
    void pending.then(
      () => parent.children.delete(pending),
      () => parent.children.delete(pending),
    )
    return pending
  }

  async run<T>(claim: MutationClaim, task: () => Promise<T>): Promise<T> {
    const normalized = normalizeClaim(claim)
    const lease = await this.acquireNormalized(normalized)
    const held: HeldClaim = { active: true, claim: normalized, children: new Set() }

    try {
      return await this.runHeld(held, task)
    } finally {
      lease.release()
    }
  }

  /** Hold a claim across a host-owned causal publication whose physical and
   * metadata checkpoints live outside the ordinary write engine. The caller
   * must release it; process crash drops the lease and durable host recovery
   * remains the source of correctness. */
  async acquire(claim: MutationClaim): Promise<() => void> {
    const lease = await this.acquireNormalized(normalizeClaim(claim))

    return lease.release
  }

  /** Acquire resources derived from mutable read-model state. A queued move may
   *  change a note's path or a destination's owner while this waiter sleeps; in
   *  that case no side effect has started yet, so retain every observed
   *  resource and requeue the original ticket until the held claim covers a
   *  fresh derivation. Requeue is atomic with releasing the old claim, so its
   *  ticket keeps priority over later waiters still in the queue. */
  async runStable<T>(claimFor: () => MutationClaim, task: () => Promise<T>): Promise<T> {
    let claim = normalizeClaim(claimFor())
    let lease = await this.acquireNormalized(claim)

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
      const held: HeldClaim = { active: true, claim, children: new Set() }

      try {
        return await this.runHeld(held, task)
      } finally {
        lease.release()
      }
    }
  }

  private async runHeld<T>(held: HeldClaim, task: () => Promise<T>): Promise<T> {
    try {
      return await this.leased.run(held, task)
    } finally {
      held.active = false
      await Promise.allSettled([...held.children])
    }
  }

  private acquireNormalized(claim: Claim): Promise<Lease> {
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
