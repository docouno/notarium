import { PROVIDER_CALL_ERROR, PROVIDER_DELIVERY_STATE } from '@notarium/contract'

import { ProviderCallError } from '../errors'

/** A refusal produced by Notarium before an upstream send. */
export class ProviderRateLimitError extends ProviderCallError {
  override readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super(PROVIDER_CALL_ERROR.notariumRateLimited, {
      retryAfterMs,
      retrySafe: true,
      deliveryState: PROVIDER_DELIVERY_STATE.notSent,
    })
    this.retryAfterMs = retryAfterMs
    this.name = 'ProviderRateLimitError'
  }
}
