import { describe, expect, it } from 'vitest'

import { createMutationGate } from './mutationGate'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('mutation gate', () => {
  it('queues new mutations while a checkpoint drains active work', async () => {
    const gate = createMutationGate()
    const active = deferred()
    const checkpointStarted = deferred()
    const checkpointDone = deferred()
    const order: string[] = []
    const first = gate.run(async () => {
      order.push('first')
      await active.promise
    })
    await Promise.resolve()
    const checkpoint = gate.checkpoint(async () => {
      order.push('checkpoint')
      checkpointStarted.resolve()
      await checkpointDone.promise
    })
    const second = gate.run(async () => {
      order.push('second')
    })

    await Promise.resolve()
    expect(order).toEqual(['first'])
    active.resolve()
    await checkpointStarted.promise
    expect(order).toEqual(['first', 'checkpoint'])
    checkpointDone.resolve()
    await Promise.all([first, checkpoint, second])
    expect(order).toEqual(['first', 'checkpoint', 'second'])
  })

  it('releases the queue when checkpoint work fails', async () => {
    const gate = createMutationGate()
    const failed = gate.checkpoint(async () => {
      throw new Error('flush failed')
    })
    await expect(failed).rejects.toThrow('flush failed')
    await expect(gate.run(async () => 'open')).resolves.toBe('open')
  })

  it('cancels a checkpoint waiting on long work and immediately releases queued mutations', async () => {
    const gate = createMutationGate()
    const active = await gate.enter()
    const controller = new AbortController()
    const checkpoint = gate.checkpoint(
      async () => {
        throw new Error('must not run before the active mutation drains')
      },
      { signal: controller.signal },
    )
    const queued = gate.enter()

    await Promise.resolve()
    controller.abort(new Error('checkpoint deadline exceeded'))
    await expect(checkpoint).rejects.toThrow('checkpoint deadline exceeded')
    const queuedRelease = await queued
    queuedRelease()
    active()
  })

  it('releases queued mutations when already-started checkpoint work exceeds its deadline', async () => {
    const gate = createMutationGate()
    const started = deferred()
    const neverFinishes = deferred()
    const controller = new AbortController()
    const checkpoint = gate.checkpoint(
      async () => {
        started.resolve()
        await neverFinishes.promise
      },
      { signal: controller.signal },
    )

    await started.promise
    const queued = gate.enter()
    controller.abort(new Error('checkpoint task deadline exceeded'))
    await expect(checkpoint).rejects.toThrow('checkpoint task deadline exceeded')
    let settled = false
    void checkpoint.settlement.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    const queuedRelease = await queued
    queuedRelease()
    await expect(gate.checkpoint(async () => {})).rejects.toThrow(/already in progress/)
    neverFinishes.resolve()
    await checkpoint.settlement
    expect(settled).toBe(true)
    await expect(gate.checkpoint(async () => {})).resolves.toBeUndefined()
  })

  it('removes a disconnected mutation from the admission queue without leaking active work', async () => {
    const gate = createMutationGate()
    const checkpointStarted = deferred()
    const checkpointDone = deferred()
    const checkpoint = gate.checkpoint(async () => {
      checkpointStarted.resolve()
      await checkpointDone.promise
    })
    await checkpointStarted.promise
    const controller = new AbortController()
    const disconnected = gate.enter({ signal: controller.signal })

    controller.abort(new Error('request disconnected'))
    await expect(disconnected).rejects.toThrow('request disconnected')
    checkpointDone.resolve()
    await checkpoint
    await expect(gate.checkpoint(async () => {})).resolves.toBeUndefined()
  })
})
