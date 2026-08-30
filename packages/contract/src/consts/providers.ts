export const CREDENTIAL_KEYRING_STATUS = {
  ready: 'ready',
  unreadable: 'unreadable',
} as const

export type CredentialKeyringStatus =
  (typeof CREDENTIAL_KEYRING_STATUS)[keyof typeof CREDENTIAL_KEYRING_STATUS]

export const WIRE = {
  openaiCompatible: 'openai-compatible',
  ollama: 'ollama',
} as const

export type Wire = (typeof WIRE)[keyof typeof WIRE]

export const CREDENTIAL_KIND = {
  bearer: 'bearer',
  header: 'header',
} as const

export type CredentialKind = (typeof CREDENTIAL_KIND)[keyof typeof CREDENTIAL_KIND]

export const CREDENTIAL_REFERENCE_KIND = {
  providerResource: 'provider-resource',
} as const

export type CredentialReferenceKind =
  (typeof CREDENTIAL_REFERENCE_KIND)[keyof typeof CREDENTIAL_REFERENCE_KIND]

export const PURPOSE = {
  chat: 'chat',
  embedding: 'embedding',
} as const

export type Purpose = (typeof PURPOSE)[keyof typeof PURPOSE]

export const PROVIDER_STATUS = {
  notConfigured: 'not-configured',
  unverified: 'unverified',
  ready: 'ready',
  credentialRejected: 'credential-rejected',
  secretUnreadable: 'secret-unreadable',
  credentialDisabled: 'credential-disabled',
  credentialOriginMismatch: 'credential-origin-mismatch',
  quotaExhausted: 'quota-exhausted',
  unreachable: 'unreachable',
  policyDenied: 'policy-denied',
  providerRateLimited: 'provider-rate-limited',
  notariumRateLimited: 'notarium-rate-limited',
  parametersRejected: 'parameters-rejected',
  disabled: 'disabled',
  /** The account that owns the record is deactivated. A separate word from
   *  `disabled` on purpose: that one says the owner switched the record off, this
   *  one says nobody can switch it back on until the account returns. */
  ownerDisabled: 'owner-disabled',
  spaceArchived: 'space-archived',
  attachmentNotActive: 'attachment-not-active',
} as const

export type ProviderStatus = (typeof PROVIDER_STATUS)[keyof typeof PROVIDER_STATUS]

export const MODEL_STATUS = {
  available: 'available',
  unavailable: 'model-unavailable',
} as const

export type ModelStatus = (typeof MODEL_STATUS)[keyof typeof MODEL_STATUS]

export const ATTACHMENT_STATE = {
  pending: 'pending',
  active: 'active',
  awaitingReconsent: 'awaiting-reconsent',
} as const

export type AttachmentState = (typeof ATTACHMENT_STATE)[keyof typeof ATTACHMENT_STATE]

export const PROVIDER_TARGET_KIND = {
  space: 'space',
  project: 'project',
} as const

export type ProviderTargetKind = (typeof PROVIDER_TARGET_KIND)[keyof typeof PROVIDER_TARGET_KIND]

export const PROVIDER_ATTACHMENT_ACCEPT_OUTCOME = {
  accepted: 'accepted',
  alreadyActive: 'already-active',
} as const

export type ProviderAttachmentAcceptOutcome =
  (typeof PROVIDER_ATTACHMENT_ACCEPT_OUTCOME)[keyof typeof PROVIDER_ATTACHMENT_ACCEPT_OUTCOME]

export const PROVIDER_ATTACHMENT_CONFLICT = {
  alreadyAttached: 'already-attached',
  epochConflict: 'epoch-conflict',
  expired: 'expired',
} as const

export type ProviderAttachmentConflict =
  (typeof PROVIDER_ATTACHMENT_CONFLICT)[keyof typeof PROVIDER_ATTACHMENT_CONFLICT]

export const PROVIDER_RETARGET_RESOLUTION = {
  detach: 'detach',
  fixOrDelete: 'fix-or-delete',
} as const

export type ProviderRetargetResolution =
  (typeof PROVIDER_RETARGET_RESOLUTION)[keyof typeof PROVIDER_RETARGET_RESOLUTION]

export const DEFAULT_CREDENTIAL_HEADER: Readonly<
  Record<CredentialKind, Readonly<Record<Wire, string>>>
> = {
  [CREDENTIAL_KIND.bearer]: {
    [WIRE.openaiCompatible]: 'authorization',
    [WIRE.ollama]: 'authorization',
  },
  [CREDENTIAL_KIND.header]: {
    [WIRE.openaiCompatible]: 'x-api-key',
    [WIRE.ollama]: 'x-api-key',
  },
}

export const PROVIDER_VENDOR_BY_ORIGIN: Readonly<Record<string, 'openrouter'>> = {
  'https://openrouter.ai': 'openrouter',
}

export type ProviderVendor = 'openrouter' | 'generic'

export const providerVendorOf = (origin: string): ProviderVendor =>
  PROVIDER_VENDOR_BY_ORIGIN[origin] ?? 'generic'

export const PROVIDER_LIMIT = {
  cursor: 1024,
  headers: 32,
  headerName: 128,
  headerValue: 8 * 1024,
  models: 512,
  modelName: 512,
  purposes: 2,
  name: 200,
  baseUrl: 2048,
  diagnostic: 512,
} as const

/** Provider inventories use one fixed window. The cursor is opaque and is the only
 * continuation input; callers cannot widen a response with an arbitrary limit. */
export const PROVIDER_LIST_PAGE_SIZE = 100

/** Non-tariff host ceiling on `validate`: it is the only route by which an
 *  arbitrary authenticated principal initiates an outbound connection, and the
 *  per-credential window (#387 vertical 13) is unset by default. */
export const PROVIDER_VALIDATE_HOST_CAP = {
  calls: 20,
  windowMs: 60 * 60 * 1000,
} as const

/** Host-protective fallback when a credential supplies no effective RPM budget. */
export const PROVIDER_CONSERVATIVE_RPM = 6

/** A window queue holds only callers that can still fit inside the longest call budget. */
export const PROVIDER_RATE_LIMIT_MAX_WAITERS = 12

/** Retargeting changes the disclosed recipient and is deliberately slower than editing. */
export const PROVIDER_RETARGET_HOST_CAP = {
  calls: 5,
  windowMs: 60 * 60 * 1000,
} as const

/** One fixed input measures the embedding width without leaking anything. */
export const PROVIDER_VALIDATE_EMBEDDING_INPUT = 'notarium provider validate probe'

export const PROVIDER_TIMEOUT = {
  minimumMs: 100,
  firstByteMaximumMs: 120_000,
  callMaximumMs: 600_000,
} as const

/** How far the request got. `not-sent` and `may-have-sent` are what the transport can
 *  tell — bytes either could not have left the socket or might have. `sent` is a
 *  stronger fact only the executor holds: the provider answered, so the call is on the
 *  bill whatever its class. The call log needs all three; the transport produces the
 *  first two. */
export const PROVIDER_DELIVERY_STATE = {
  notSent: 'not-sent',
  mayHaveSent: 'may-have-sent',
  sent: 'sent',
} as const

export type ProviderDeliveryState =
  (typeof PROVIDER_DELIVERY_STATE)[keyof typeof PROVIDER_DELIVERY_STATE]

/** How a provider call ended, classified from status AND body together. Lives here
 *  rather than beside the executor because the call log persists it and `metaDb` may
 *  not reach into `services/providerRuntime`. */
export const PROVIDER_CALL_ERROR = {
  credentialRejected: 'credential-rejected',
  quotaExhausted: 'quota-exhausted',
  providerRateLimited: 'provider-rate-limited',
  notariumRateLimited: 'notarium-rate-limited',
  modelUnavailable: 'model-unavailable',
  parametersRejected: 'parameters-rejected',
  modelLoadFailed: 'model-load-failed',
  streamInterrupted: 'stream-interrupted',
  malformedResponse: 'malformed-response',
  policyDenied: 'policy-denied',
  unreachable: 'unreachable',
  canceled: 'canceled',
  invalidRequest: 'invalid-request',
  /** A durable job call whose earlier attempt may already have been paid for. The
   *  send-fence refuses the resend and this is what the caller is told instead. */
  outcomeUnknown: 'outcome-unknown',
  fallback: 'fallback',
} as const

export type ProviderCallErrorCode = (typeof PROVIDER_CALL_ERROR)[keyof typeof PROVIDER_CALL_ERROR]

/** What a call-log row says happened. `in-flight` is the intent state a row is born
 *  in; every other value is terminal. Read a stale `in-flight` with
 *  `providerCallOutcomeAsRead` — it does not become `outcome-unknown` in the table. */
export const PROVIDER_CALL_OUTCOME = {
  ok: 'ok',
  inFlight: 'in-flight',
  ...PROVIDER_CALL_ERROR,
} as const

export type ProviderCallOutcome = (typeof PROVIDER_CALL_OUTCOME)[keyof typeof PROVIDER_CALL_OUTCOME]

export const PROVIDER_USAGE_SOURCE = {
  openaiCompatible: 'openai-compatible',
  ollamaNative: 'ollama-native',
} as const

export type ProviderUsageSource = (typeof PROVIDER_USAGE_SOURCE)[keyof typeof PROVIDER_USAGE_SOURCE]

/** Counters as the wire reported them, with the semantics of the wire that reported
 *  them. A null field is "the provider did not say", never zero. */
export type ProviderOpenAiUsage = {
  source: typeof PROVIDER_USAGE_SOURCE.openaiCompatible
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  reasoningTokens: number | null
  cachedPromptTokens: number | null
  cost: number | null
  isByok: boolean | null
  costDetails: Record<string, number> | null
}

export type ProviderOllamaUsage = {
  source: typeof PROVIDER_USAGE_SOURCE.ollamaNative
  totalDurationNs: number | null
  loadDurationNs: number | null
  promptEvalCount: number | null
  promptEvalDurationNs: number | null
  evalCount: number | null
  evalDurationNs: number | null
}

export type ProviderUsage = ProviderOpenAiUsage | ProviderOllamaUsage
