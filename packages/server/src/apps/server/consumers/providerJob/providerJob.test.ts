import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_CALL_ERROR, PROVIDER_DELIVERY_STATE, WIRE } from '@notarium/contract'

import type { ArtifactStore } from '../../../../libs/artifactStore'
import type { JobRecord } from '../../../../services/metaDb'
import { PROVIDER_CALL_KIND, ProviderCallError } from '../../../../services/providerRuntime'
import { JobAbortedError, type JobContext, JobRetryError, TerminalJobError } from '../jobRunner'
import { runProviderJobCall } from './providerJob'

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'job-1',
  space: 'space-1',
  kind: 'provider-test',
  status: 'running',
  principal: 'user:alice',
  params: { resourceId: 'resource-1', model: 'model-1' },
  progressDone: 0,
  progressTotal: 1,
  phase: null,
  attempts: 1,
  maxAttempts: 3,
  runAt: '2026-08-25T00:00:00.000Z',
  lockedAt: '2026-08-25T00:00:00.000Z',
  lockedBy: 'lease-1',
  artifactRef: null,
  artifactBytes: null,
  artifactName: null,
  result: null,
  error: null,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
  startedAt: '2026-08-25T00:00:00.000Z',
  completedAt: null,
  expiresAt: null,
  ...over,
})

const context = (signal = new AbortController().signal): JobContext => ({
  job: job(),
  lease: 'lease-1',
  signal,
  artifacts: {} as ArtifactStore,
  report: vi.fn(async () => {}),
})

const call = {
  resourceId: 'resource-1',
  jobCallKey: 'reply',
  operation: {
    kind: PROVIDER_CALL_KIND.chat,
    model: 'model-1',
    messages: [{ role: 'user' as const, content: 'test' }],
    stream: true,
    maxOutputTokens: 32,
  },
  inputUpperBound: 8,
  outputTokenBudget: 32,
}

describe('provider durable-job adapter', () => {
  it('derives scope, principal, signal, and the stable replay key from JobContext', async () => {
    const executeForScope = vi.fn(async () => ({
      kind: 'chat' as const,
      text: 'ok',
      finishReason: 'stop',
      usage: null,
    }))
    const ctx = context()

    await expect(runProviderJobCall(ctx, { executeForScope }, call)).resolves.toMatchObject({
      kind: PROVIDER_CALL_KIND.chat,
      text: 'ok',
    })
    expect(executeForScope).toHaveBeenCalledWith(
      expect.objectContaining({
        space: 'space-1',
        principal: 'user:alice',
        resourceId: 'resource-1',
        signal: ctx.signal,
        job: { jobId: 'job-1', jobCallKey: 'reply' },
        retryMode: 'none',
      }),
    )
    expect(ctx.report).toHaveBeenNthCalledWith(1, {
      done: 0,
      total: 1,
      phase: 'calling-provider',
    })
    expect(ctx.report).toHaveBeenNthCalledWith(2, {
      done: 1,
      total: 1,
      phase: 'done',
    })
  })

  it.each([
    PROVIDER_CALL_ERROR.credentialRejected,
    PROVIDER_CALL_ERROR.quotaExhausted,
    PROVIDER_CALL_ERROR.modelUnavailable,
    PROVIDER_CALL_ERROR.fallback,
    PROVIDER_CALL_ERROR.streamInterrupted,
  ])('makes an answered %s failure terminal and persists only its class', async (code) => {
    const secret = 'sk-secret-must-not-reach-the-job'
    const executeForScope = vi.fn(async () => {
      throw new ProviderCallError(code, {
        deliveryState: PROVIDER_DELIVERY_STATE.sent,
        diagnostic: `provider echoed ${secret}`,
      })
    })

    const failure = await runProviderJobCall(context(), { executeForScope }, call).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(TerminalJobError)
    expect((failure as Error).message).toBe(code)
    expect(JSON.stringify(failure)).not.toContain(secret)
  })

  it('keeps a proven not-sent failure retryable and carries bounded Retry-After', async () => {
    const executeForScope = vi.fn(async () => {
      throw new ProviderCallError(PROVIDER_CALL_ERROR.providerRateLimited, {
        deliveryState: PROVIDER_DELIVERY_STATE.sent,
        retrySafe: true,
        retryAfterMs: 12_345,
      })
    })

    const failure = await runProviderJobCall(context(), { executeForScope }, call).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(JobRetryError)
    expect(failure).toMatchObject({
      message: PROVIDER_CALL_ERROR.providerRateLimited,
      retryAfterMs: 12_345,
    })
  })

  it('keeps a proven not-sent failure without Retry-After on the runner retry path', async () => {
    const executeForScope = vi.fn(async () => {
      throw new ProviderCallError(PROVIDER_CALL_ERROR.policyDenied, {
        deliveryState: PROVIDER_DELIVERY_STATE.notSent,
        retrySafe: true,
      })
    })

    const failure = await runProviderJobCall(context(), { executeForScope }, call).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(TerminalJobError)
    expect(failure).not.toBeInstanceOf(JobRetryError)
    expect((failure as Error).message).toBe(PROVIDER_CALL_ERROR.policyDenied)
  })

  it('turns an unclassified throw into bounded outcome-unknown instead of persisting it', async () => {
    const secret = 'Bearer live-secret'
    const executeForScope = vi.fn(async () => {
      throw new Error(`socket exploded with ${secret}`)
    })

    const failure = await runProviderJobCall(context(), { executeForScope }, call).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(TerminalJobError)
    expect((failure as Error).message).toBe(PROVIDER_CALL_ERROR.outcomeUnknown)
    expect(JSON.stringify(failure)).not.toContain(secret)
  })

  it('maps an aborted job signal to a clean JobAbortedError', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancel'))
    const executeForScope = vi.fn(async () => {
      throw new ProviderCallError(PROVIDER_CALL_ERROR.canceled, {
        deliveryState: PROVIDER_DELIVERY_STATE.notSent,
      })
    })

    await expect(
      runProviderJobCall(context(controller.signal), { executeForScope }, call),
    ).rejects.toBeInstanceOf(JobAbortedError)
  })

  it('does not couple the adapter to a provider wire', async () => {
    const executeForScope = vi.fn(async () => ({
      kind: 'chat' as const,
      text: WIRE.ollama,
      finishReason: null,
      usage: null,
    }))

    await expect(runProviderJobCall(context(), { executeForScope }, call)).resolves.toMatchObject({
      text: WIRE.ollama,
    })
  })
})
