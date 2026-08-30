import type { ProviderUsage, Wire } from '@notarium/contract'

export const PROVIDER_CALL_KIND = {
  chat: 'chat',
  embedding: 'embedding',
  models: 'models',
  key: 'key',
} as const

export type ProviderCallKind = (typeof PROVIDER_CALL_KIND)[keyof typeof PROVIDER_CALL_KIND]

export const PROVIDER_RETRY_MODE = {
  none: 'none',
  interactive: 'interactive',
} as const

export type ProviderRetryMode = (typeof PROVIDER_RETRY_MODE)[keyof typeof PROVIDER_RETRY_MODE]

export const PROVIDER_TOKEN_LIMIT_FIELD = {
  maxTokens: 'max_tokens',
  maxCompletionTokens: 'max_completion_tokens',
} as const

export type ProviderTokenLimitField =
  (typeof PROVIDER_TOKEN_LIMIT_FIELD)[keyof typeof PROVIDER_TOKEN_LIMIT_FIELD]

export type ProviderEndpoint = {
  principalId: string
  wire: Wire
  baseUrl: string
  /** Plaintext values stay non-serializable until the transport request is built. */
  headers: ReadonlyMap<string, string>
  /** Raw secrets are kept separately from rendered header values so response
   *  redaction remains complete for arbitrary user-authored prefixes. A Set is
   *  deliberately not a wire shape: it exists only for this in-process call. */
  sensitiveValues: ReadonlySet<string>
  allowPrivateNetwork: boolean
  firstByteTimeoutMs: number | null
  callTimeoutMs: number | null
}

export type ProviderChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ProviderChatCall = {
  kind: typeof PROVIDER_CALL_KIND.chat
  model: string
  messages: readonly ProviderChatMessage[]
  stream: boolean
  maxOutputTokens: number
  tokenLimitField?: ProviderTokenLimitField
}

export type ProviderEmbeddingCall = {
  kind: typeof PROVIDER_CALL_KIND.embedding
  model: string
  input: readonly string[]
  dimensions?: number | null
}

export type ProviderModelsCall = {
  kind: typeof PROVIDER_CALL_KIND.models
}

/** OpenRouter's key introspection: proves endpoint AND credential without paying
 *  for inference. Measured byte-for-byte — `GET /models` proves neither. */
export type ProviderKeyCall = {
  kind: typeof PROVIDER_CALL_KIND.key
}

export type ProviderOperation =
  ProviderChatCall | ProviderEmbeddingCall | ProviderModelsCall | ProviderKeyCall

export type ProviderChatResult = {
  kind: typeof PROVIDER_CALL_KIND.chat
  text: string
  finishReason: string | null
  usage: ProviderUsage | null
}

export type ProviderEmbeddingResult = {
  kind: typeof PROVIDER_CALL_KIND.embedding
  embeddings: number[][]
  usage: ProviderUsage | null
}

export type ProviderModelsResult = {
  kind: typeof PROVIDER_CALL_KIND.models
  models: string[]
}

export type ProviderKeyResult = {
  kind: typeof PROVIDER_CALL_KIND.key
  limitRemaining: number | null
}

export type ProviderCallResult =
  ProviderChatResult | ProviderEmbeddingResult | ProviderModelsResult | ProviderKeyResult

export type ProviderTextChunk = {
  text: string
}

export type ProviderCallRateLimit = {
  rpm: number | null
  tpm: number | null
  inputUpperBound: number
  outputTokenBudget: number
}

/** Who pays for the call and what it addresses — the identity the call log writes,
 *  carried by the request because the executor is the only layer that sees every
 *  send. `job` is present exactly for a durable job call: it is the logical call the
 *  send-fence keys on, and an interactive call has none. */
export type ProviderCallContext = {
  owner: string
  principal: string
  agent: string | null
  resourceId: string
  /** Historical snapshot: the row survives the credential it names. */
  credentialId: string | null
  /** The Spaces whose content this call may carry. Empty for a probe. */
  spaces: readonly string[]
  job: ProviderJobCall | null
  rateLimit: ProviderCallRateLimit
}

/** The stable address of one logical durable call. The key is supplied by the caller
 *  and must survive a re-claim, or the fence has nothing to recognize. */
export type ProviderJobCall = {
  jobId: string
  jobCallKey: string
}

export type ProviderCallRequest = {
  endpoint: ProviderEndpoint
  operation: ProviderOperation
  retryMode: ProviderRetryMode
  call: ProviderCallContext
  signal: AbortSignal
  /** Rechecks captured liveness after limiter wait and before intent. */
  beforeSend?: () => Promise<boolean>
  onText?: (chunk: ProviderTextChunk) => void | Promise<void>
}
