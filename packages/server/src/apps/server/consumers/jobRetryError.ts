/** A retryable handler failure carrying an already bounded server-requested delay. */
export class JobRetryError extends Error {
  readonly retryAfterMs: number

  constructor(message: string, retryAfterMs: number, options?: ErrorOptions) {
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
      throw new RangeError('job retry delay must be a non-negative safe integer')
    }
    super(message, options)
    this.name = 'JobRetryError'
    this.retryAfterMs = retryAfterMs
  }
}
