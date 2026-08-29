export type MutationClaim = {
  global?: boolean
  resources?: Iterable<string | null | undefined>
  noteIds?: Iterable<string | null | undefined>
  paths?: Iterable<string | null | undefined>
  prefixes?: Iterable<string | null | undefined>
}

export type NormalizedMutationClaim = {
  global: boolean
  resources: Set<string>
  noteIds: Set<string>
  paths: Set<string>
  prefixes: Set<string>
}

export type ClaimLease = {
  release: () => void
  retry: (claim: NormalizedMutationClaim) => Promise<ClaimLease>
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

export const normalizeMutationClaim = (claim: MutationClaim): NormalizedMutationClaim => ({
  global: claim.global === true,
  resources: values(claim.resources),
  noteIds: values(claim.noteIds),
  paths: values(claim.paths, cleanPath),
  prefixes: values(claim.prefixes, cleanPath),
})

export const unionMutationClaims = (
  left: NormalizedMutationClaim,
  right: NormalizedMutationClaim,
): NormalizedMutationClaim => ({
  global: left.global || right.global,
  resources: new Set([...left.resources, ...right.resources]),
  noteIds: new Set([...left.noteIds, ...right.noteIds]),
  paths: new Set([...left.paths, ...right.paths]),
  prefixes: new Set([...left.prefixes, ...right.prefixes]),
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

const pathsCover = (held: NormalizedMutationClaim, paths: Set<string>): boolean => {
  for (const path of paths) {
    if (!held.paths.has(path) && ![...held.prefixes].some((prefix) => isUnder(path, prefix))) {
      return false
    }
  }

  return true
}

export const claimCovers = (
  held: NormalizedMutationClaim,
  current: NormalizedMutationClaim,
): boolean =>
  held.global ||
  (!current.global &&
    contains(held.resources, current.resources) &&
    contains(held.noteIds, current.noteIds) &&
    pathsCover(held, current.paths) &&
    contains(held.prefixes, current.prefixes))

const intersects = (left: Set<string>, right: Set<string>): boolean => {
  for (const value of left) {
    if (right.has(value)) {
      return true
    }
  }

  return false
}

export const claimsConflict = (
  left: NormalizedMutationClaim,
  right: NormalizedMutationClaim,
): boolean => {
  if (left.global || right.global) {
    return true
  }
  if (
    intersects(left.resources, right.resources) ||
    intersects(left.noteIds, right.noteIds) ||
    intersects(left.paths, right.paths)
  ) {
    return true
  }
  for (const path of left.paths) {
    for (const prefix of right.prefixes) {
      if (isUnder(path, prefix)) {
        return true
      }
    }
  }
  for (const path of right.paths) {
    for (const prefix of left.prefixes) {
      if (isUnder(path, prefix)) {
        return true
      }
    }
  }
  for (const leftPrefix of left.prefixes) {
    for (const rightPrefix of right.prefixes) {
      if (isUnder(leftPrefix, rightPrefix) || isUnder(rightPrefix, leftPrefix)) {
        return true
      }
    }
  }

  return false
}

type WaiterState = 'waiting' | 'active' | 'released'

type OrderNode = {
  waiter: Waiter
  previous: OrderNode | null
  next: OrderNode | null
}

type KeyNode = {
  waiter: Waiter
  key: string
  previous: KeyNode | null
  next: KeyNode | null
}

type KeyQueue = { head: KeyNode | null; tail: KeyNode | null }

type Waiter = {
  claim: NormalizedMutationClaim
  ticket: number
  state: WaiterState
  start: ((lease: ClaimLease) => void) | null
  orderNode: OrderNode
  keyNodes: Map<string, KeyNode>
}

const GLOBAL_KEY = 'global'
const resourceKey = (value: string): string => `resource\u0000${value}`
const noteKey = (value: string): string => `note\u0000${value}`
const pathKey = (value: string): string => `path\u0000${value}`
const prefixKey = (value: string): string => `prefix\u0000${value}`

const exactKeys = (claim: NormalizedMutationClaim): string[] => [
  ...[...claim.resources].map(resourceKey),
  ...[...claim.noteIds].map(noteKey),
  ...[...claim.paths].map(pathKey),
]

const membershipKeys = (claim: NormalizedMutationClaim): string[] => [
  ...(claim.global ? [GLOBAL_KEY] : []),
  ...exactKeys(claim),
  ...[...claim.prefixes].map(prefixKey),
]

const pathAncestors = (path: string): string[] => {
  const out = [path]
  let separator = path.lastIndexOf('/')

  while (separator !== -1) {
    out.push(path.slice(0, separator))
    separator = path.lastIndexOf('/', separator - 1)
  }

  return out
}

/** Indexed fair queue used only by MutationCoordinator. It is intentionally not re-exported. */
export class ClaimQueue {
  private nextTicket = 0
  private liveHead: OrderNode | null = null
  private liveTail: OrderNode | null = null
  private readonly waiters = new Map<number, Waiter>()
  private readonly keyQueues = new Map<string, KeyQueue>()
  private readonly activeExact = new Map<string, Waiter>()
  private readonly activePrefixes = new Map<string, Waiter>()
  private activeGlobal: Waiter | null = null
  private activeCount = 0
  private prefixWaiterCount = 0

  acquire(claim: NormalizedMutationClaim): Promise<ClaimLease> {
    return new Promise((start) => {
      const waiter = this.createWaiter(claim, this.nextTicket++, start)

      this.waiters.set(waiter.ticket, waiter)
      this.appendLive(waiter)
      this.addMemberships(waiter)
      if (claim.prefixes.size > 0) {
        this.prefixWaiterCount++
      }
      this.tryStart(waiter)
    })
  }

  private createWaiter(
    claim: NormalizedMutationClaim,
    ticket: number,
    start: (lease: ClaimLease) => void,
  ): Waiter {
    const waiter = {} as Waiter
    const orderNode: OrderNode = { waiter, previous: null, next: null }

    Object.assign(waiter, {
      claim,
      ticket,
      state: 'waiting' as const,
      start,
      orderNode,
      keyNodes: new Map<string, KeyNode>(),
    })
    return waiter
  }

  private appendLive(waiter: Waiter): void {
    const node = waiter.orderNode

    node.previous = this.liveTail
    if (this.liveTail) {
      this.liveTail.next = node
    } else {
      this.liveHead = node
    }
    this.liveTail = node
  }

  private removeLive(waiter: Waiter): void {
    const { previous, next } = waiter.orderNode

    if (previous) {
      previous.next = next
    } else {
      this.liveHead = next
    }
    if (next) {
      next.previous = previous
    } else {
      this.liveTail = previous
    }
    waiter.orderNode.previous = null
    waiter.orderNode.next = null
  }

  private addMemberships(waiter: Waiter): void {
    for (const key of membershipKeys(waiter.claim)) {
      if (waiter.keyNodes.has(key)) {
        continue
      }
      let queue = this.keyQueues.get(key)

      if (!queue) {
        queue = { head: null, tail: null }
        this.keyQueues.set(key, queue)
      }
      const node: KeyNode = { waiter, key, previous: null, next: null }

      waiter.keyNodes.set(key, node)
      if (!queue.tail || queue.tail.waiter.ticket < waiter.ticket) {
        node.previous = queue.tail
        if (queue.tail) {
          queue.tail.next = node
        } else {
          queue.head = node
        }
        queue.tail = node
        continue
      }
      let before: KeyNode | null = queue.tail

      while (before && before.waiter.ticket > waiter.ticket) {
        before = before.previous
      }
      if (!before) {
        node.next = queue.head
        queue.head!.previous = node
        queue.head = node
      } else {
        node.previous = before
        node.next = before.next
        if (before.next) {
          before.next.previous = node
        } else {
          queue.tail = node
        }
        before.next = node
      }
    }
  }

  private removeMemberships(waiter: Waiter): void {
    for (const node of waiter.keyNodes.values()) {
      const queue = this.keyQueues.get(node.key)!

      if (node.previous) {
        node.previous.next = node.next
      } else {
        queue.head = node.next
      }
      if (node.next) {
        node.next.previous = node.previous
      } else {
        queue.tail = node.previous
      }
      if (!queue.head) {
        this.keyQueues.delete(node.key)
      }
    }
    waiter.keyNodes.clear()
  }

  private canStart(waiter: Waiter): boolean {
    if (waiter.state !== 'waiting') {
      return false
    }
    const claim = waiter.claim

    if (claim.global) {
      return this.activeCount === 0 && this.liveHead?.waiter === waiter
    }
    if (this.activeGlobal) {
      return false
    }
    const firstGlobal = this.keyHead(GLOBAL_KEY)

    if (firstGlobal && firstGlobal.ticket < waiter.ticket) {
      return false
    }
    for (const key of exactKeys(claim)) {
      const active = this.activeExact.get(key)

      if (active && active !== waiter) {
        return false
      }
      if (this.keyHead(key) !== waiter) {
        return false
      }
    }
    for (const path of claim.paths) {
      for (const ancestor of pathAncestors(path)) {
        const active = this.activePrefixes.get(ancestor)

        if (active && active !== waiter) {
          return false
        }
        const earlier = this.keyHead(prefixKey(ancestor))

        if (earlier && earlier !== waiter && earlier.ticket < waiter.ticket) {
          return false
        }
      }
    }
    if (claim.prefixes.size > 0) {
      for (let node = this.liveHead; node; node = node.next) {
        const other = node.waiter

        if (
          other === waiter ||
          other.state === 'released' ||
          (other.state === 'waiting' && other.ticket > waiter.ticket)
        ) {
          continue
        }
        if (claimsConflict(other.claim, claim)) {
          return false
        }
      }
    }

    return true
  }

  private keyHead(key: string): Waiter | undefined {
    return this.keyQueues.get(key)?.head?.waiter
  }

  private tryStart(waiter: Waiter): void {
    if (!this.canStart(waiter)) {
      return
    }
    waiter.state = 'active'
    this.activeCount++
    if (waiter.claim.global) {
      this.activeGlobal = waiter
    }
    for (const key of exactKeys(waiter.claim)) {
      this.activeExact.set(key, waiter)
    }
    for (const prefix of waiter.claim.prefixes) {
      this.activePrefixes.set(prefix, waiter)
    }
    const start = waiter.start

    waiter.start = null
    start!(this.leaseFor(waiter))
  }

  private leaseFor(waiter: Waiter): ClaimLease {
    let held = true

    return {
      release: () => {
        if (!held) {
          return
        }
        held = false
        this.finalRelease(waiter)
      },
      retry: (claim) => {
        if (!held) {
          return Promise.reject(new Error('mutation lease is no longer held'))
        }
        held = false
        return this.retry(waiter, claim)
      },
    }
  }

  private removeActive(waiter: Waiter): void {
    this.activeCount--
    if (waiter.claim.global) {
      this.activeGlobal = null
    }
    for (const key of exactKeys(waiter.claim)) {
      if (this.activeExact.get(key) === waiter) {
        this.activeExact.delete(key)
      }
    }
    for (const prefix of waiter.claim.prefixes) {
      if (this.activePrefixes.get(prefix) === waiter) {
        this.activePrefixes.delete(prefix)
      }
    }
  }

  private finalRelease(waiter: Waiter): void {
    const releasedClaim = waiter.claim

    this.removeActive(waiter)
    waiter.state = 'released'
    this.removeMemberships(waiter)
    this.removeLive(waiter)
    this.waiters.delete(waiter.ticket)
    if (releasedClaim.prefixes.size > 0) {
      this.prefixWaiterCount--
    }
    this.wakeAfter(releasedClaim)
  }

  private retry(waiter: Waiter, claim: NormalizedMutationClaim): Promise<ClaimLease> {
    return new Promise((start) => {
      const previousClaim = waiter.claim
      const gainedPrefixes = previousClaim.prefixes.size === 0 && claim.prefixes.size > 0

      this.removeActive(waiter)
      waiter.claim = claim
      waiter.state = 'waiting'
      waiter.start = start
      this.addMemberships(waiter)
      if (gainedPrefixes) {
        this.prefixWaiterCount++
      }
      this.tryStart(waiter)
      this.wakeAfter(previousClaim, waiter)
    })
  }

  private wakeAfter(claim: NormalizedMutationClaim, skip?: Waiter): void {
    if (claim.global) {
      for (let node = this.liveHead; node; node = node.next) {
        if (node.waiter.state === 'waiting' && node.waiter !== skip) {
          this.tryStart(node.waiter)
        }
      }

      return
    }
    const candidates = new Set<Waiter>()

    for (const key of [...exactKeys(claim), ...[...claim.prefixes].map(prefixKey)]) {
      const head = this.keyHead(key)

      if (head?.state === 'waiting' && head !== skip) {
        candidates.add(head)
      }
    }
    const global = this.keyHead(GLOBAL_KEY)

    if (global?.state === 'waiting' && global !== skip) {
      candidates.add(global)
    }
    if (claim.prefixes.size > 0 || (claim.paths.size > 0 && this.prefixWaiterCount > 0)) {
      for (let node = this.liveHead; node; node = node.next) {
        const candidate = node.waiter

        if (candidate === skip || candidate.state !== 'waiting') {
          continue
        }
        if (claimsConflict(claim, candidate.claim)) {
          candidates.add(candidate)
        }
      }
    }
    this.tryCandidates([...candidates])
  }

  private tryCandidates(candidates: Waiter[]): void {
    candidates.sort((left, right) => left.ticket - right.ticket)
    for (const candidate of candidates) {
      this.tryStart(candidate)
    }
  }
}
