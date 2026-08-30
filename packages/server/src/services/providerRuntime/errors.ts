import type { ProviderCallErrorCode, ProviderDeliveryState } from '@notarium/contract'

export type ProviderCallErrorOptions = {
  retrySafe?: boolean
  retryAfterMs?: number | null
  deliveryState: ProviderDeliveryState
  diagnostic?: string | null
  cause?: unknown
}

export class ProviderCallError extends Error {
  readonly code: ProviderCallErrorCode
  readonly retrySafe: boolean
  readonly retryAfterMs: number | null
  readonly deliveryState: ProviderDeliveryState
  readonly diagnostic: string | null

  constructor(code: ProviderCallErrorCode, options: ProviderCallErrorOptions) {
    super(code, { cause: options.cause })
    this.name = 'ProviderCallError'
    this.code = code
    this.retrySafe = options.retrySafe ?? false
    this.retryAfterMs = options.retryAfterMs ?? null
    this.deliveryState = options.deliveryState
    this.diagnostic = options.diagnostic ?? null
  }
}
