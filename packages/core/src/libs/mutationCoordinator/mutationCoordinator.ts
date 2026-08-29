import { AsyncLocalStorage } from 'node:async_hooks'

import {
  claimCovers,
  type ClaimLease,
  ClaimQueue,
  type MutationClaim,
  type NormalizedMutationClaim,
  normalizeMutationClaim,
  unionMutationClaims,
} from './claimQueue'

export type { MutationClaim } from './claimQueue'

type HeldClaim = {
  active: boolean
  claim: NormalizedMutationClaim
  children: Set<Promise<unknown>>
}

/** Fair per-process fence: conflicting claims keep arrival order; unrelated claims run in parallel.
 *  @see docs/core.md#write-through */
export class MutationCoordinator {
  private readonly queue = new ClaimQueue()
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

    if (!parent?.active || !claimCovers(parent.claim, normalizeMutationClaim(candidate))) {
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
    const normalized = normalizeMutationClaim(claim)
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
    const lease = await this.acquireNormalized(normalizeMutationClaim(claim))

    return lease.release
  }

  /** Acquire resources derived from mutable read-model state. A queued move may
   *  change a note's path or a destination's owner while this waiter sleeps; in
   *  that case no side effect has started yet, so retain every observed
   *  resource and requeue the original ticket until the held claim covers a
   *  fresh derivation. Requeue is atomic with releasing the old claim, so its
   *  ticket keeps priority over later waiters still in the queue. */
  async runStable<T>(claimFor: () => MutationClaim, task: () => Promise<T>): Promise<T> {
    let claim = normalizeMutationClaim(claimFor())
    let lease = await this.acquireNormalized(claim)

    for (;;) {
      let current: NormalizedMutationClaim

      try {
        current = normalizeMutationClaim(claimFor())
      } catch (err) {
        lease.release()
        throw err
      }

      if (!claimCovers(claim, current)) {
        claim = unionMutationClaims(claim, current)
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

  private acquireNormalized(claim: NormalizedMutationClaim): Promise<ClaimLease> {
    return this.queue.acquire(claim)
  }
}
