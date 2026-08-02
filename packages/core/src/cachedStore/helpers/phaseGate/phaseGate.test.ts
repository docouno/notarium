import { describe, expect, it } from 'vitest'
import { PhaseGate, type PhaseGateMode } from './phaseGate'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

describe('PhaseGate', () => {
  it('batches peers but hands the next phase to an earlier opposite waiter', async () => {
    const gate = new PhaseGate()
    const entered: string[] = []
    const releases: Array<() => void> = []

    const enter = async (label: string, mode: PhaseGateMode) => {
      const release = await gate.acquire(mode)

      entered.push(label)
      releases.push(release)
    }

    await Promise.all([enter('read-1', 'read'), enter('read-2', 'read')])
    const mutation = enter('mutation', 'mutation')
    const lateRead = enter('read-3', 'read')

    expect(entered).toEqual(['read-1', 'read-2'])
    releases.shift()!()
    releases.shift()!()
    await mutation
    expect(entered).toEqual(['read-1', 'read-2', 'mutation'])
    releases.shift()!()
    await lateRead
    expect(entered).toEqual(['read-1', 'read-2', 'mutation', 'read-3'])
    releases.shift()!()
    await gate.settle()
  })

  it('settle joins active and queued cohorts', async () => {
    const gate = new PhaseGate()
    const firstRelease = await gate.acquire('mutation')
    const second = gate.acquire('read')
    const settled = deferred()
    let isSettled = false

    void gate.settle().then(() => {
      isSettled = true
      settled.resolve()
    })
    firstRelease()
    const secondRelease = await second
    await Promise.resolve()
    expect(isSettled).toBe(false)
    secondRelease()
    await settled.promise
  })
})
