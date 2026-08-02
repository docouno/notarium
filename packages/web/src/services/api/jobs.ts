import type { Job, JobListResponse } from '@notarium/contract'
import { QUERY_KEY } from '@notarium/contract/query'
import { req, sp } from './client'

export const jobsApi = {
  /** Base-export download URL (#17): a GET that streams a ZIP of the space's note
   *  files. Used as an `<a href download>` (cookie-authenticated, the browser
   *  streams to disk) — never fetched into memory, so a large base never sits in
   *  the tab. `frontmatter:'strip'` drops the YAML block (a clean reading copy;
   *  default keeps the full file, incl. notarium-id → round-trippable); `scope:'all'`
   *  adds the agent's private memory mount for a full backup (default: notes only). */
  exportUrl: (
    space: string,
    opts: { frontmatter?: 'keep' | 'strip'; scope?: 'user' | 'all'; folder?: string } = {},
  ) => {
    const q = new URLSearchParams()

    if (opts.frontmatter === 'strip') {
      q.set(QUERY_KEY.frontmatter, 'strip')
    }
    if (opts.scope === 'all') {
      q.set(QUERY_KEY.scope, 'all')
    }
    if (opts.folder) {
      q.set(QUERY_KEY.folder, opts.folder)
    }
    const qs = q.toString()
    return `${sp(space)}/export${qs ? `?${qs}` : ''}`
  },

  // ── Async export via the durable job layer (#105 [JOBS][A]) ──────────────────
  // The primary path when jobs are available: enqueue → track progress (jobGet
  // poll / the `job` SSE event) → download the finished artifact (jobDownloadUrl,
  // a Range-capable GET). A 404 'jobs_unavailable' from enqueue means no meta-DB
  // backs jobs → the caller falls back to the synchronous exportUrl above.
  /** Enqueue an export job; resolves to the created job, or throws ApiError
   *  (status 404 → jobs unavailable, the sync-fallback signal). */
  exportEnqueue: (
    space: string,
    opts: { frontmatter?: 'keep' | 'strip'; scope?: 'user' | 'all'; folder?: string } = {},
  ) => req<Job>(`${sp(space)}/export`, { method: 'POST', body: JSON.stringify(opts) }),
  /** Poll one job's status (the SSE `job` event carries the same shape for live). */
  jobGet: (space: string, id: string) => req<Job>(`${sp(space)}/jobs/${id}`),
  /** Recent jobs of the space (this principal's, newest first). `kind` scopes to one
   *  consumer's jobs (export #105 / import #191); omitted ⇒ export (server default). */
  jobsList: (space: string, kind?: 'export' | 'import') =>
    req<JobListResponse>(`${sp(space)}/jobs${kind ? `?kind=${kind}` : ''}`).then((r) => r.jobs),
  /** Cooperatively cancel a pending/running job; resolves to its updated status. */
  jobCancel: (space: string, id: string) =>
    req<Job>(`${sp(space)}/jobs/${id}/cancel`, { method: 'POST' }),
  /** The artifact download URL — used as an `<a href download>` (cookie-auth, the
   *  browser streams to disk with Range/resume support). */
  jobDownloadUrl: (space: string, id: string) => `${sp(space)}/jobs/${id}/download`,
  /** The per-space SSE endpoint URL (#105) — the export hook opens a dedicated
   *  EventSource on it to listen for the named `job` event (live progress). */
  spaceEventsUrl: (space: string) => `${sp(space)}/events`,
}
