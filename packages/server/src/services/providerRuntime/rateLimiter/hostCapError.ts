import { ProviderRateLimitError } from './errors'

export class ProviderHostCapError extends ProviderRateLimitError {
  constructor(retryAfterMs: number) {
    super(retryAfterMs)
    this.name = 'ProviderHostCapError'
  }
}
