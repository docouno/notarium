// A job handler throws this to fail the job terminally — no backoff/retry; untagged errors stay retryable.
// canon: docs/jobs.md#delivery-and-recovery · docs/jobs.md#a-terminal-failure-may-carry-a-result-302

export class TerminalJobError extends Error {
  constructor(
    message: string,
    /** What the run DID finish before failing, bounded. An import that wrote N
     *  notes and then hit a deterministic conflict must report those N: the error
     *  is the outcome, but the notes are real. Absent for a failure with nothing
     *  to show, and never set on a RETRYABLE failure — that is an attempt, not an
     *  outcome. canon: docs/jobs.md#a-terminal-failure-may-carry-a-result-302 */
    readonly result?: unknown,
  ) {
    super(message)
    this.name = 'TerminalJobError'
  }
}
