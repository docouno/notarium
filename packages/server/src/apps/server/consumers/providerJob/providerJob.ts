import { PROVIDER_CALL_ERROR } from '@notarium/contract'

import type { ProviderRegistry } from '../../../../services/providerRegistry'
import {
  PROVIDER_RETRY_MODE,
  ProviderCallError,
  type ProviderOperation,
  type ProviderTextChunk,
} from '../../../../services/providerRuntime'
import {
  JobAbortedError,
  type JobContext,
  type JobResult,
  JobRetryError,
  TerminalJobError,
} from '../jobRunner'

export type ProviderJobCallInput = {
  resourceId: string
  /** Stable within one logical side effect and recomputed unchanged on re-claim. */
  jobCallKey: string
  operation: ProviderOperation
  inputUpperBound: number
  outputTokenBudget: number
  agent?: string | null
  onText?: (chunk: ProviderTextChunk) => void | Promise<void>
}

export type ProviderJobRegistry = Pick<ProviderRegistry, 'executeForScope'>

const asJobFailure = (error: unknown, signal: AbortSignal): Error => {
  if (signal.aborted) {
    return new JobAbortedError()
  }
  if (!(error instanceof ProviderCallError)) {
    // An unclassified throw has no delivery proof at this boundary. Persisting its
    // message could also copy a request/header dump into the job's public fields.
    return new TerminalJobError(PROVIDER_CALL_ERROR.outcomeUnknown)
  }
  if (!error.retrySafe) {
    return new TerminalJobError(error.code)
  }

  return error.retryAfterMs === null
    ? new Error(error.code)
    : new JobRetryError(error.code, error.retryAfterMs, { cause: error })
}

/** One durable provider side effect over the generic at-least-once runner.
 *
 * The provider journal, not the queue attempt count, decides whether a re-claim may
 * send. This adapter only maps that decision onto the runner's retry vocabulary and
 * keeps all four persisted job fields bounded to server-authored values. */
export const runProviderJobCall = async (
  ctx: JobContext,
  registry: ProviderJobRegistry,
  input: ProviderJobCallInput,
): Promise<JobResult['result']> => {
  await ctx.report({ done: 0, total: 1, phase: 'calling-provider' })

  try {
    const result = await registry.executeForScope({
      space: ctx.job.space,
      principal: ctx.job.principal,
      agent: input.agent ?? null,
      resourceId: input.resourceId,
      operation: input.operation,
      retryMode: PROVIDER_RETRY_MODE.none,
      job: { jobId: ctx.job.id, jobCallKey: input.jobCallKey },
      rateLimit: {
        inputUpperBound: input.inputUpperBound,
        outputTokenBudget: input.outputTokenBudget,
      },
      signal: ctx.signal,
      onText: input.onText,
    })
    await ctx.report({ done: 1, total: 1, phase: 'done' })
    return result
  } catch (error) {
    throw asJobFailure(error, ctx.signal)
  }
}
