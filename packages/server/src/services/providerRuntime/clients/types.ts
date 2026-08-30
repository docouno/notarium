import type { IncomingHttpHeaders } from 'node:http'

import type { ProviderCallResult, ProviderEndpoint, ProviderOperation } from '../types'

export type ProviderClientRequest = {
  endpoint: ProviderEndpoint
  operation: ProviderOperation
  signal: AbortSignal
  beforeSend?: (signal: AbortSignal) => Promise<void>
  onText?: (text: string) => void | Promise<void>
}

export type ProviderClientFailure = {
  kind: 'response' | 'malformed' | 'stream-interrupted'
  statusCode: number
  headers: IncomingHttpHeaders
  bodyText: string
  effectiveCallTimeoutMs: number
}

export type ProviderClientOutcome =
  { ok: true; result: ProviderCallResult } | { ok: false; failure: ProviderClientFailure }
