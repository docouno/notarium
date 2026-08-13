import { describe, expect, it, vi } from 'vitest'

import { InMemoryCausalOutboxPersistence } from '@notarium/core'

import { CausalOutboxProjector } from './causalOutboxProjector'

const append = (outbox: InMemoryCausalOutboxPersistence, resourceId = 'note-a') =>
  outbox.append({
    space: 'space-a',
    generation: 1,
    kind: 'restore-terminal',
    operationId: 'operation-a',
    resourceId,
    createdAt: '2026-08-11T00:00:00.000Z',
  })

describe('CausalOutboxProjector', () => {
  it('strictly repairs and acknowledges pending events before start returns', async () => {
    const outbox = new InMemoryCausalOutboxPersistence()
    await append(outbox)
    const project = vi.fn(async () => {})
    const projector = new CausalOutboxProjector({
      outbox,
      subscriberId: 'replica-a',
      project,
      pollMs: 60_000,
      now: () => new Date('2026-08-11T00:01:00.000Z'),
    })

    await projector.start()

    expect(project).toHaveBeenCalledWith(
      expect.objectContaining({ space: 'space-a', resourceId: 'note-a' }),
    )
    expect(await outbox.pending('replica-a', 10)).toEqual([])
    await projector.stop()
  })

  it('fails startup closed and leaves an unprojected event pending', async () => {
    const outbox = new InMemoryCausalOutboxPersistence()
    await append(outbox)
    const projector = new CausalOutboxProjector({
      outbox,
      subscriberId: 'replica-a',
      project: async () => {
        throw new Error('projection unavailable')
      },
      pollMs: 60_000,
      onError: () => {},
    })

    await expect(projector.start()).rejects.toThrow('projection unavailable')
    expect(await outbox.pending('replica-a', 10)).toHaveLength(1)
    await projector.stop()
  })

  it('retries a runtime failure on the next wake without acknowledging early', async () => {
    const outbox = new InMemoryCausalOutboxPersistence()
    const project = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined)
    const projector = new CausalOutboxProjector({
      outbox,
      subscriberId: 'replica-a',
      project,
      pollMs: 60_000,
      onError: () => {},
    })
    await projector.start()
    await append(outbox)

    projector.wake()
    await vi.waitFor(async () => {
      expect(project).toHaveBeenCalledTimes(1)
      expect(await outbox.pending('replica-a', 10)).toHaveLength(1)
    })
    projector.wake()
    await vi.waitFor(async () => {
      expect(project).toHaveBeenCalledTimes(2)
      expect(await outbox.pending('replica-a', 10)).toEqual([])
    })
    await projector.stop()
  })

  it('delivers every event independently to all replicas', async () => {
    const outbox = new InMemoryCausalOutboxPersistence()
    await append(outbox)
    const seenA: string[] = []
    const seenB: string[] = []
    const replicaA = new CausalOutboxProjector({
      outbox,
      subscriberId: 'replica-a',
      project: async ({ id }) => void seenA.push(id),
      pollMs: 60_000,
    })
    const replicaB = new CausalOutboxProjector({
      outbox,
      subscriberId: 'replica-b',
      project: async ({ id }) => void seenB.push(id),
      pollMs: 60_000,
    })

    await Promise.all([replicaA.start(), replicaB.start()])

    expect(seenA).toEqual(['1'])
    expect(seenB).toEqual(['1'])
    expect(await outbox.pending('replica-a', 10)).toEqual([])
    expect(await outbox.pending('replica-b', 10)).toEqual([])
    expect(await outbox.pending('late-replica', 10)).toHaveLength(1)
    await Promise.all([replicaA.stop(), replicaB.stop()])
  })
})
