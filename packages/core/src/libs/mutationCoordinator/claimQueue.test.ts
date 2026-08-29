import { describe, expect, it, vi } from 'vitest'

import {
  type ClaimLease,
  ClaimQueue,
  claimsConflict,
  type NormalizedMutationClaim,
  normalizeMutationClaim,
  unionMutationClaims,
} from './claimQueue'

const flushStarts = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

type TestKeyNode = {
  waiter: { ticket: number }
  next: TestKeyNode | null
}

type QueueInternals = {
  activeCount: number
  activeExact: Map<string, unknown>
  activePrefixes: Map<string, unknown>
  keyQueues: Map<string, { head: TestKeyNode | null }>
  liveHead: unknown
  liveTail: unknown
  tryStart: (waiter: unknown) => void
  waiters: Map<number, unknown>
}

const queueInternals = (queue: ClaimQueue): QueueInternals => queue as unknown as QueueInternals

const queueState = (queue: ClaimQueue) => {
  const state = queueInternals(queue)

  return {
    active: state.activeCount,
    activeExact: state.activeExact.size,
    activePrefixes: state.activePrefixes.size,
    keyQueues: state.keyQueues.size,
    live: state.waiters.size,
    liveHead: state.liveHead,
    liveTail: state.liveTail,
  }
}

const keyQueueTickets = (queue: ClaimQueue, key: string): number[] => {
  const tickets: number[] = []
  let node = queueInternals(queue).keyQueues.get(key)?.head ?? null

  while (node) {
    tickets.push(node.waiter.ticket)
    node = node.next
  }

  return tickets
}

describe('ClaimQueue', () => {
  it('opens 1000 independent exact waiters behind a global in one linear pass', async () => {
    const queue = new ClaimQueue()
    const global = await queue.acquire(normalizeMutationClaim({ global: true }))
    const order: number[] = []
    const pending = Array.from({ length: 1_000 }, (_, index) =>
      queue
        .acquire(
          normalizeMutationClaim({
            noteIds: [`note-${index}`],
            paths: [`folder-${index % 10}/note-${index}.md`],
          }),
        )
        .then((lease) => {
          order.push(index)
          return lease
        }),
    )

    await flushStarts()
    expect(order).toEqual([])
    const tryStart = vi.spyOn(queueInternals(queue), 'tryStart')

    global.release()
    const leases = await Promise.all(pending)

    expect(order).toEqual(Array.from({ length: 1_000 }, (_, index) => index))
    expect(tryStart).toHaveBeenCalledTimes(1_000)
    leases.forEach((lease) => lease.release())
    expect(queueState(queue)).toEqual({
      active: 0,
      activeExact: 0,
      activePrefixes: 0,
      keyQueues: 0,
      live: 0,
      liveHead: null,
      liveTail: null,
    })
  })

  it('advances a 1000-waiter same-key chain through queue heads', async () => {
    const queue = new ClaimQueue()
    let lease = await queue.acquire(normalizeMutationClaim({ noteIds: ['same'] }))
    const order = [0]
    const pending = Array.from({ length: 999 }, (_, index) =>
      queue.acquire(normalizeMutationClaim({ noteIds: ['same'] })).then((next) => {
        order.push(index + 1)
        return next
      }),
    )
    const tryStart = vi.spyOn(queueInternals(queue), 'tryStart')

    for (const next of pending) {
      lease.release()
      lease = await next
    }
    lease.release()

    expect(order).toEqual(Array.from({ length: 1_000 }, (_, index) => index))
    expect(tryStart).toHaveBeenCalledTimes(999)
    expect(queueState(queue).live).toBe(0)
  })

  it('inserts a retry new atom at the original ticket without preempting active work', async () => {
    const queue = new ClaimQueue()
    const first = await queue.acquire(normalizeMutationClaim({ noteIds: ['a'] }))
    const laterActive = await queue.acquire(normalizeMutationClaim({ noteIds: ['b'] }))
    const order: string[] = []
    const contender = queue.acquire(normalizeMutationClaim({ noteIds: ['b'] })).then((lease) => {
      order.push('contender')
      return lease
    })
    const retried = first.retry(normalizeMutationClaim({ noteIds: ['a', 'b'] })).then((lease) => {
      order.push('retry')
      return lease
    })

    await flushStarts()
    expect(order).toEqual([])
    expect(keyQueueTickets(queue, 'note\u0000b')).toEqual([0, 1, 2])
    laterActive.release()
    const retryLease = await retried

    expect(order).toEqual(['retry'])
    retryLease.release()
    const contenderLease = await contender

    expect(order).toEqual(['retry', 'contender'])
    contenderLease.release()
    expect(queueState(queue).live).toBe(0)
  })

  it('matches the previous drain scheduler over 16000 deterministic transitions', async () => {
    const queue = new ClaimQueue()
    const reference = new ReferenceQueue()
    const actualActive = new Set<number>()
    const actualLeases = new Map<number, ClaimLease>()
    const actualStarts: number[] = []
    let seed = 0x405c0de
    let nextTicket = 0

    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed / 0x1_0000_0000
    }
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]

    const randomClaim = (): NormalizedMutationClaim => {
      const axis = Math.floor(random() * 12)
      const group = Math.floor(random() * 7)
      const leaf = Math.floor(random() * 5)

      if (axis === 0) {
        return normalizeMutationClaim({ global: true })
      }
      if (axis <= 2) {
        return normalizeMutationClaim({ prefixes: [`tree/${group}`] })
      }
      if (axis <= 5) {
        return normalizeMutationClaim({ paths: [`tree/${group}/${leaf}.md`] })
      }
      if (axis <= 8) {
        return normalizeMutationClaim({ noteIds: [`note-${group}`] })
      }

      return normalizeMutationClaim({ resources: [`resource-${group}`] })
    }

    const track = (ticket: number, pending: Promise<ClaimLease>): void => {
      void pending.then((lease) => {
        actualActive.add(ticket)
        actualLeases.set(ticket, lease)
        actualStarts.push(ticket)
      })
    }

    const assertSame = (step: number): void => {
      const active = [...actualActive].sort((left, right) => left - right)
      const expectedActive = [...reference.active.keys()].sort((left, right) => left - right)

      if (
        JSON.stringify(active) !== JSON.stringify(expectedActive) ||
        JSON.stringify(actualStarts) !== JSON.stringify(reference.starts)
      ) {
        throw new Error(
          `scheduler diverged at step ${step}: active=${JSON.stringify(active)} expected=${JSON.stringify(expectedActive)}`,
        )
      }
    }

    for (let step = 0; step < 16_000; step++) {
      const active = [...actualActive]
      const live = reference.live.size
      const choice = random()

      if (live < 50 && (live === 0 || choice < 0.48)) {
        const claim = randomClaim()
        const ticket = nextTicket++

        track(ticket, queue.acquire(claim))
        reference.enqueue(ticket, claim)
      } else if (active.length && (choice < 0.78 || live >= 50)) {
        const ticket = pick(active)

        actualActive.delete(ticket)
        actualLeases.get(ticket)!.release()
        actualLeases.delete(ticket)
        reference.release(ticket)
      } else if (active.length) {
        const ticket = pick(active)
        const next = unionMutationClaims(reference.active.get(ticket)!.claim, randomClaim())

        actualActive.delete(ticket)
        const lease = actualLeases.get(ticket)!
        actualLeases.delete(ticket)
        track(ticket, lease.retry(next))
        reference.retry(ticket, next)
      }
      await flushStarts()
      assertSame(step)
    }

    let drainStep = 16_000

    while (reference.live.size) {
      const ticket = [...actualActive].sort((left, right) => left - right)[0]

      actualActive.delete(ticket)
      actualLeases.get(ticket)!.release()
      actualLeases.delete(ticket)
      reference.release(ticket)
      await flushStarts()
      assertSame(drainStep++)
    }
    expect(queueState(queue)).toEqual({
      active: 0,
      activeExact: 0,
      activePrefixes: 0,
      keyQueues: 0,
      live: 0,
      liveHead: null,
      liveTail: null,
    })
  })
})

type ReferenceWaiter = { claim: NormalizedMutationClaim; ticket: number }

class ReferenceQueue {
  readonly active = new Map<number, ReferenceWaiter>()
  readonly live = new Map<number, ReferenceWaiter>()
  readonly starts: number[] = []
  private waiting: ReferenceWaiter[] = []

  enqueue(ticket: number, claim: NormalizedMutationClaim): void {
    const waiter = { claim, ticket }

    this.live.set(ticket, waiter)
    this.waiting.push(waiter)
    this.waiting.sort((left, right) => left.ticket - right.ticket)
    this.drain()
  }

  release(ticket: number): void {
    this.active.delete(ticket)
    this.live.delete(ticket)
    this.drain()
  }

  retry(ticket: number, claim: NormalizedMutationClaim): void {
    const waiter = this.active.get(ticket)!

    this.active.delete(ticket)
    waiter.claim = claim
    this.waiting.push(waiter)
    this.waiting.sort((left, right) => left.ticket - right.ticket)
    this.drain()
  }

  private drain(): void {
    const stillWaiting: ReferenceWaiter[] = []

    for (const waiter of this.waiting) {
      const activeConflict = [...this.active.values()].some((entry) =>
        claimsConflict(entry.claim, waiter.claim),
      )
      const earlierConflict = stillWaiting.some((entry) =>
        claimsConflict(entry.claim, waiter.claim),
      )

      if (activeConflict || earlierConflict) {
        stillWaiting.push(waiter)
        continue
      }
      this.active.set(waiter.ticket, waiter)
      this.starts.push(waiter.ticket)
    }
    this.waiting = stillWaiting
  }
}
