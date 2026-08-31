import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InMemoryAgentCalls } from './agentCalls'
import { createApp, type Fixture } from './app'

const fixture = (): Fixture => ({
  now: '2026-08-30T12:00:00.000Z',
  spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
})

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('agent trace cleanup continuation', () => {
  it('waits for the maintenance tick, then resumes pending batches after a yield', async () => {
    vi.useFakeTimers()
    const resume = vi
      .spyOn(InMemoryAgentCalls.prototype, 'resumeCleanup')
      .mockResolvedValueOnce({ completedOwners: [], processed: 500, pending: true })
      .mockResolvedValueOnce({ completedOwners: ['alice'], processed: 500, pending: false })
    app = await createApp(fixture())

    expect(resume).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(resume).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(resume).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(resume).toHaveBeenCalledTimes(2)
  })
})
