// A job handler throws this to fail the job terminally — no backoff/retry; untagged errors stay retryable.
// canon: docs/jobs.md#delivery-and-recovery

export class TerminalJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminalJobError'
  }
}
