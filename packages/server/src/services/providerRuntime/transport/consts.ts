export const PROVIDER_TRANSPORT_ERROR = {
  policyDenied: 'policy-denied',
  invalidRequest: 'invalid-request',
  networkError: 'network-error',
  redirectDenied: 'redirect-denied',
  canceled: 'canceled',
  firstByteTimeout: 'first-byte-timeout',
  callTimeout: 'call-timeout',
  requestTooLarge: 'request-too-large',
  responseTooLarge: 'response-too-large',
  headersTooLarge: 'headers-too-large',
} as const

export type ProviderTransportErrorCode =
  (typeof PROVIDER_TRANSPORT_ERROR)[keyof typeof PROVIDER_TRANSPORT_ERROR]

export const PROVIDER_TRANSPORT_LIMIT = {
  localFirstByteMs: 120_000,
  externalFirstByteMs: 30_000,
  localCallMs: 600_000,
  externalCallMs: 300_000,
  nonStreamResponseBytes: 256 * 1024 * 1024,
  streamResponseBytes: 64 * 1024 * 1024,
  requestBytes: 1024 * 1024,
  headerCount: 32,
  headerBytes: 8 * 1024,
  concurrentPerPrincipal: 4,
  queuedPerPrincipal: 12,
} as const

export type ProviderTransportLimits = {
  [Key in keyof typeof PROVIDER_TRANSPORT_LIMIT]: number
}
