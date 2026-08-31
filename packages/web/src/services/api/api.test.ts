import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@notarium/contract'

import { api, pollJobToTerminal } from './api'

const runningJob = (): Job => ({
  id: 'job-1',
  kind: 'import',
  status: 'running',
  progress: { done: 0, total: null, ratio: null, phase: null },
  artifact: null,
  result: null,
  error: null,
  createdAt: '',
  updatedAt: '',
  completedAt: null,
})

describe('pollJobToTerminal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('passes cancellation through the real job transport into fetch', async () => {
    let requestSignal: AbortSignal | undefined

    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal ?? undefined

      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
          once: true,
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const polling = pollJobToTerminal('main', 'job-1', { signal: controller.signal })
    const outcome = polling.catch((error: unknown) => error)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/s/main/jobs/job-1',
      expect.objectContaining({ signal: controller.signal }),
    )
    expect(requestSignal).toBe(controller.signal)
    controller.abort()
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
  })

  it('clears the polling delay immediately when canceled', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'jobGet').mockResolvedValue(runningJob())
    const controller = new AbortController()
    const polling = pollJobToTerminal('main', 'job-1', {
      signal: controller.signal,
      intervalMs: 60_000,
    })
    const outcome = polling.catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()

    expect(vi.getTimerCount()).toBe(0)
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
  })
})

describe('agent session deletion transport', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('preserves the server distinction between deleting and complete', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"status":"deleting"}', {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.agentSessionDelete('ses_example0000')).resolves.toBe('deleting')
    await expect(api.agentSessionDelete('ses_example0000', true)).resolves.toBe('complete')
  })
})
