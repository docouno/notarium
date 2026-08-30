import {
  PROVIDER_CALL_ERROR,
  PROVIDER_STATUS,
  PROVIDER_VALIDATE_EMBEDDING_INPUT,
  type ProviderCallErrorCode,
  type ProviderStatus,
  type ProviderVendor,
  PURPOSE,
  type Purpose,
  WIRE,
} from '@notarium/contract'

import { ProviderCallError } from '../errors'
import {
  PROVIDER_CALL_KIND,
  PROVIDER_RETRY_MODE,
  PROVIDER_TOKEN_LIMIT_FIELD,
  type ProviderCallContext,
  type ProviderCallRequest,
  type ProviderCallResult,
  type ProviderEndpoint,
  type ProviderOperation,
} from '../types'

export type ProviderValidateInput = {
  endpoint: ProviderEndpoint
  /** Who is charged for the probe and what it addresses — the journal writes it. */
  call: ProviderCallContext
  purpose: Purpose
  vendor: ProviderVendor
  /** The model the probe names; null when the resource lists none. */
  model: string | null
  signal: AbortSignal
  beforeSend?: () => Promise<boolean>
}

export type ProviderValidateOutcome = {
  status: ProviderStatus
  diagnostic: string | null
  /** True only on a `ready` whose wire actually checks authentication: `ollama`
   *  never does, and a non-ready outcome proved nothing either way. */
  credentialProven: boolean
  /** Measured embedding width, authoritative over any configured value. */
  dimensions: number | null
  /** The probed model is gone; the caller marks it in `models`, not in `lastCheck`. */
  modelUnavailable: boolean
}

export type ProviderCallExecute = (request: ProviderCallRequest) => Promise<ProviderCallResult>

/** `model-unavailable` is a fact about the model, so it never becomes the record's
 *  status: the caller marks the model and the purpose reads `not-configured` —
 *  no listed model serves it any more. Everything the address itself refused keeps
 *  its own literal; everything else it answered unusably reads `unreachable` and
 *  carries the detail in the classified diagnostic. */
const STATUS_OF_CALL_ERROR: Readonly<Record<ProviderCallErrorCode, ProviderStatus>> = {
  [PROVIDER_CALL_ERROR.credentialRejected]: PROVIDER_STATUS.credentialRejected,
  [PROVIDER_CALL_ERROR.quotaExhausted]: PROVIDER_STATUS.quotaExhausted,
  [PROVIDER_CALL_ERROR.providerRateLimited]: PROVIDER_STATUS.providerRateLimited,
  [PROVIDER_CALL_ERROR.notariumRateLimited]: PROVIDER_STATUS.notariumRateLimited,
  [PROVIDER_CALL_ERROR.modelUnavailable]: PROVIDER_STATUS.notConfigured,
  [PROVIDER_CALL_ERROR.parametersRejected]: PROVIDER_STATUS.parametersRejected,
  [PROVIDER_CALL_ERROR.policyDenied]: PROVIDER_STATUS.policyDenied,
  [PROVIDER_CALL_ERROR.unreachable]: PROVIDER_STATUS.unreachable,
  [PROVIDER_CALL_ERROR.modelLoadFailed]: PROVIDER_STATUS.unreachable,
  [PROVIDER_CALL_ERROR.malformedResponse]: PROVIDER_STATUS.unreachable,
  [PROVIDER_CALL_ERROR.streamInterrupted]: PROVIDER_STATUS.unreachable,
  [PROVIDER_CALL_ERROR.invalidRequest]: PROVIDER_STATUS.unreachable,
  // Unreachable from `validate` by construction — the send-fence keys on a durable
  // job call and this route has none — but the table is exhaustive on purpose.
  [PROVIDER_CALL_ERROR.outcomeUnknown]: PROVIDER_STATUS.unreachable,
  [PROVIDER_CALL_ERROR.fallback]: PROVIDER_STATUS.unreachable,
  [PROVIDER_CALL_ERROR.canceled]: PROVIDER_STATUS.unreachable,
}

const chatProbe = (
  model: string,
  tokenLimitField: (typeof PROVIDER_TOKEN_LIMIT_FIELD)[keyof typeof PROVIDER_TOKEN_LIMIT_FIELD],
): ProviderOperation => ({
  kind: PROVIDER_CALL_KIND.chat,
  model,
  messages: [{ role: 'user', content: 'ping' }],
  stream: false,
  maxOutputTokens: 1,
  tokenLimitField,
})

const embeddingProbe = (model: string): ProviderOperation => ({
  kind: PROVIDER_CALL_KIND.embedding,
  model,
  input: [PROVIDER_VALIDATE_EMBEDDING_INPUT],
})

const VALIDATE_INPUT_TOKEN_UPPER_BOUND = 64

const tokenBudgetOf = (
  operation: ProviderOperation,
): { inputUpperBound: number; outputTokenBudget: number } => {
  if (operation.kind === PROVIDER_CALL_KIND.chat) {
    return { inputUpperBound: VALIDATE_INPUT_TOKEN_UPPER_BOUND, outputTokenBudget: 16 }
  }
  if (operation.kind === PROVIDER_CALL_KIND.embedding) {
    return { inputUpperBound: VALIDATE_INPUT_TOKEN_UPPER_BOUND, outputTokenBudget: 0 }
  }

  return { inputUpperBound: 0, outputTokenBudget: 0 }
}

/** There is no single `validate`: each wire × purpose has its own way, and the
 *  table is measured rather than read off vendor docs. `GET /models` is absent on
 *  purpose — three responses (no key, valid key, corrupted key) were byte-identical
 *  at both OpenRouter and Jan, so it proves nothing about the credential. */
const operationOf = (input: ProviderValidateInput): ProviderOperation | 'needs-model' => {
  if (input.purpose === PURPOSE.embedding) {
    return input.model ? embeddingProbe(input.model) : 'needs-model'
  }
  if (input.endpoint.wire === WIRE.ollama) {
    return { kind: PROVIDER_CALL_KIND.models }
  }
  if (input.vendor === 'openrouter') {
    return { kind: PROVIDER_CALL_KIND.key }
  }

  return input.model ? chatProbe(input.model, PROVIDER_TOKEN_LIMIT_FIELD.maxTokens) : 'needs-model'
}

const succeeded = (
  result: ProviderCallResult,
  credentialProven: boolean,
): ProviderValidateOutcome => ({
  status: PROVIDER_STATUS.ready,
  diagnostic: null,
  credentialProven,
  dimensions:
    result.kind === PROVIDER_CALL_KIND.embedding ? (result.embeddings[0]?.length ?? null) : null,
  modelUnavailable: false,
})

const failed = (error: ProviderCallError): ProviderValidateOutcome => ({
  status: STATUS_OF_CALL_ERROR[error.code],
  diagnostic: error.diagnostic,
  credentialProven: false,
  dimensions: null,
  modelUnavailable: error.code === PROVIDER_CALL_ERROR.modelUnavailable,
})

/** Runs the probe and, on a rejected parameter NAME, the one alternative form.
 *  This is not the repeat vertical 09 forbids: that ban is about resending the SAME
 *  request on a frequency class, and these are two different request shapes on a
 *  terminal one. Two paid calls per click, never three — every rung costs money. */
export const probeProvider = async (
  execute: ProviderCallExecute,
  input: ProviderValidateInput,
): Promise<ProviderValidateOutcome> => {
  const credentialProven = input.endpoint.wire !== WIRE.ollama
  const operation = operationOf(input)

  if (operation === 'needs-model') {
    return {
      status: PROVIDER_STATUS.notConfigured,
      diagnostic: null,
      credentialProven: false,
      dimensions: null,
      modelUnavailable: false,
    }
  }
  const call = (shape: ProviderOperation): Promise<ProviderCallResult> =>
    execute({
      endpoint: input.endpoint,
      operation: shape,
      // A click pays for at most the ladder. The executor's own single repeat is a
      // frequency-class measure for ordinary calls; here a provider 429 is itself a
      // reportable outcome, not something to sit and wait out.
      retryMode: PROVIDER_RETRY_MODE.none,
      call: {
        ...input.call,
        rateLimit: { ...input.call.rateLimit, ...tokenBudgetOf(shape) },
      },
      signal: input.signal,
      beforeSend: input.beforeSend,
    })

  try {
    return succeeded(await call(operation), credentialProven)
  } catch (error) {
    if (!(error instanceof ProviderCallError)) {
      throw error
    }
    if (error.code === PROVIDER_CALL_ERROR.canceled) {
      throw error
    }
    if (
      error.code !== PROVIDER_CALL_ERROR.parametersRejected ||
      operation.kind !== PROVIDER_CALL_KIND.chat ||
      !input.model
    ) {
      return failed(error)
    }
    try {
      return succeeded(
        await call(chatProbe(input.model, PROVIDER_TOKEN_LIMIT_FIELD.maxCompletionTokens)),
        credentialProven,
      )
    } catch (second) {
      if (!(second instanceof ProviderCallError)) {
        throw second
      }
      if (second.code === PROVIDER_CALL_ERROR.canceled) {
        throw second
      }

      return failed(second)
    }
  }
}
