import type { Job } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { authApi } from './auth'
import { ApiError, importStart } from './client'
import { contextApi } from './context'
import { foldersApi } from './folders'
import { graphApi } from './graph'
import { jobsApi } from './jobs'
import { meApi } from './me'
import { membersApi } from './members'
import { notesApi } from './notes'
import { projectsApi } from './projects'
import { searchApi } from './search'
import { spacesApi } from './spaces'
import { syncApi } from './sync'
import { trashApi } from './trash'
import { usersApi } from './users'

// The composed API facade: one flat object over every /api/* resource family so
// callers keep writing `api.notesGet(...)`. The families are split by resource
// (services/api/*) and share the typed fetch transport in ./client; this file
// only assembles them (spread) and hosts the job-poll helper. Method naming and
// the #16 space-scoping convention live with the families and ./client.
export { ApiError, type ImportProgressLine } from './client'
export { setSpaceAccessProbe, setUnauthorizedHandler } from './client'
export type { BucketsQueryParams, NotesQueryParams } from './types'

export const api = {
  ...spacesApi,
  ...notesApi,
  ...jobsApi,
  ...graphApi,
  ...searchApi,
  ...syncApi,
  ...trashApi,
  ...foldersApi,
  ...projectsApi,
  ...authApi,
  ...meApi,
  ...contextApi,
  ...usersApi,
  ...membersApi,
  importStart,
}

/** Client fallback cadence (ms) for polling a durable job's status (#105) — the
 *  resilience path behind the job SSE stream. One knob for the export/import hooks
 *  and pollJobToTerminal's default so the three never drift. */
export const JOB_POLL_MS = 1500

/** Poll an export job to a terminal status (#105), shared by the Export tab's poll
 *  fallback and the tree's "Export folder" toast so the two never drift. Transient poll
 *  failures are swallowed (the next tick retries); a run of 404s means the job row is
 *  gone (GC'd / pruned) and polling stops. Cancellation is via `opts.signal` — the
 *  caller aborts on unmount / space switch / an explicit Cancel — so a stuck `running`
 *  job never leaves a zombie poller behind. */
export const pollJobToTerminal = async (
  space: string,
  id: string,
  opts: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<Job> => {
  const interval = opts.intervalMs ?? JOB_POLL_MS
  let last: Job | null = null
  let gone = 0

  for (;;) {
    if (opts.signal?.aborted) {
      throw new DOMException('export polling aborted', 'AbortError')
    }
    try {
      const job = await api.jobGet(space, id)
      last = job
      gone = 0
      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
        return job
      }
    } catch (e) {
      // A 404 = the row is gone (GC'd/pruned/lost); a few in a row and we give up.
      // Any other error is transient — retry on the next tick.
      if (e instanceof ApiError && e.status === HTTP_STATUS.NOT_FOUND && ++gone >= 3) {
        if (last) {
          return last
        }
        throw e
      }
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}
