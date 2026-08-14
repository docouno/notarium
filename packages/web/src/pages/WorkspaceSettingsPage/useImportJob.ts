import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImportSummary, Job } from '@notarium/contract'
import { SSE_EVENT } from '@notarium/contract/events'

import { api, ApiError, type ImportProgressLine, JOB_POLL_MS } from '../../services/api'

// The durable-import client hook (#191 [JOBS][B]) — the inverse of useExportJob.
// Drives one import job through its lifecycle for the Import tab: upload → enqueue →
// track phase/progress (a live written-note count) → surface the summary. Progress
// comes from BOTH a dedicated `job` SSE stream (low latency) and a poll (the fallback
// if the stream drops); both stop once terminal. It survives leaving the tab (the
// reconnect effect re-adopts the principal's latest import on mount) and a server
// restart (the job is durable). Cancel is cooperative. When the host has no durable
// jobs (no meta-DB) the POST answers with the synchronous NDJSON stream instead, which
// this hook drives into the SAME shape (a synthetic job) so the tab renders uniformly.

export type ImportOptions = {
  format?: string
  root?: string
  skipExisting?: boolean
  memory?: 'folder' | 'space' | 'skip'
}

export type ImportJobState = {
  job: Job | null
  /** Set when the job ended in error / was canceled, or enqueue failed. */
  error: string | null
  /** True while a job is pending or running. */
  busy: boolean
}

/** How many detail rows this tab will ever render per collection. The server caps
 *  the same way, but a result persisted by an older build predates that cap — and
 *  a 10 000-row Notice is a frozen tab, not a diagnostic. */
const DETAIL_CAP = 200

const cap = <T>(rows: readonly T[] | undefined): { rows: T[]; omitted: number } => {
  const all = Array.isArray(rows) ? rows : []

  return { rows: all.slice(0, DETAIL_CAP), omitted: Math.max(0, all.length - DETAIL_CAP) }
}

/** Structurally normalize a result the server (or an older server) produced.
 *  Deliberately hand-written rather than the contract's Zod schema: the web bundle
 *  does not ship Zod (canon: docs/contract.md), and a stricter parser would throw
 *  away a real outcome over a field it did not expect. */
export const normalizeImportSummary = (raw: unknown): ImportSummary | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const value = raw as Record<string, unknown>
  const count = (key: string) => (typeof value[key] === 'number' ? (value[key] as number) : 0)
  const files = cap(value.files as ImportSummary['files'])
  const errors = cap(value.errors as ImportSummary['errors'])
  const ignoredRaw = value.ignored as ImportSummary['ignored']
  const ignoredFiles = cap(ignoredRaw?.files)
  const omitted = (declared: unknown, local: number) =>
    (typeof declared === 'number' ? declared : 0) + local

  return {
    imported: count('imported'),
    skipped: count('skipped'),
    failed: count('failed'),
    files: files.rows,
    filesOmitted: omitted(value.filesOmitted, files.omitted) || undefined,
    errors: errors.rows,
    errorsOmitted: omitted(value.errorsOmitted, errors.omitted) || undefined,
    // Not derived from the rows: the per-file warnings that say the same thing are
    // capped on both sides, so recomputing this from what survived the cap would
    // under-report exactly the imports big enough for it to matter. A result from
    // a server that predates the field simply has none, and reads as zero.
    repointFailed: count('repointFailed') || undefined,
    ignored: ignoredRaw
      ? {
          count: typeof ignoredRaw.count === 'number' ? ignoredRaw.count : 0,
          files: ignoredFiles.rows,
          filesOmitted: omitted(ignoredRaw.filesOmitted, ignoredFiles.omitted) || undefined,
        }
      : undefined,
    created: Array.isArray(value.created) ? (value.created as string[]).slice(0, DETAIL_CAP) : [],
  }
}

/** The import outcome — read off job.result. A FAILED job may carry one too: an
 *  import that wrote N notes and then hit a terminal conflict reports both the
 *  error and those N. A canceled job has no honest result to show. */
const summaryOf = (job: Job | null): ImportSummary | null =>
  job && (job.status === 'succeeded' || job.status === 'failed')
    ? normalizeImportSummary(job.result)
    : null

/** A synthetic Job for the synchronous fallback (none-mode) so the tab renders the
 *  same progress bar / summary as a real durable job. `id:'sync'` is never sent to the
 *  server (cancel aborts the fetch instead). */
const syncJob = (
  status: Job['status'],
  progress: { done: number; total?: number | null; phase?: string },
  extra?: Partial<Job>,
): Job => ({
  id: 'sync',
  kind: 'import',
  status,
  progress: {
    done: progress.done,
    total: progress.total ?? null,
    ratio:
      progress.total && progress.total > 0 ? Math.min(1, progress.done / progress.total) : null,
    phase: progress.phase ?? (status === 'succeeded' ? 'done' : 'writing'),
  },
  artifact: null,
  result: null,
  error: null,
  createdAt: '',
  updatedAt: '',
  completedAt: null,
  ...extra,
})

export const useImportJob = (space: string) => {
  const [state, setState] = useState<ImportJobState>({ job: null, error: null, busy: false })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const activeId = useRef<string | null>(null)
  // Aborts the in-flight upload/stream in the synchronous fallback (its Cancel).
  const syncAbort = useRef<AbortController | null>(null)
  // Generation token: bumped on reset / unmount / space switch to invalidate an
  // in-flight start(). Because start() awaits the WHOLE upload before installing its
  // watchers, an unmount mid-upload must not let the resolved 202 open an SSE + poll on
  // a dead hook, nor paint a stale terminal state on a new space.
  const genRef = useRef(0)

  const stopWatch = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
    }
    pollRef.current = null
    esRef.current?.close()
    esRef.current = null
  }, [])

  const apply = useCallback(
    (job: Job) => {
      if (activeId.current && job.id !== activeId.current) {
        return
      }
      const terminal =
        job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled'
      setState({
        job,
        busy: !terminal,
        error:
          job.status === 'failed'
            ? job.error || 'import failed'
            : job.status === 'canceled'
              ? 'import canceled'
              : null,
      })
      if (terminal) {
        activeId.current = null
        stopWatch()
      }
    },
    [stopWatch],
  )

  const watch = useCallback(
    (id: string) => {
      stopWatch()
      activeId.current = id
      // Live updates via the named `job` SSE event (a dedicated short-lived stream for
      // this tab; auto-reconnects, torn frames ignored).
      try {
        const es = new EventSource(api.spaceEventsUrl(space))
        es.addEventListener(SSE_EVENT.JOB, (e) => {
          try {
            apply(JSON.parse((e as MessageEvent).data as string) as Job)
          } catch {
            // a torn frame mid-reconnect is noise
          }
        })
        esRef.current = es
      } catch {
        // EventSource unavailable → poll-only, still correct
      }
      // Poll fallback — catches a missed SSE frame, a dropped stream, or a job that
      // finished between enqueue and the stream opening.
      pollRef.current = setInterval(() => {
        if (!activeId.current) {
          return
        }
        void api
          .jobGet(space, id)
          .then(apply)
          .catch(() => {
            // transient — the next tick retries; a 404 means it was GC'd/gone
          })
      }, JOB_POLL_MS)
    },
    [space, apply, stopWatch],
  )

  /** Upload + start an import. Durable when jobs are available, else the synchronous
   *  fallback driven into the same synthetic-job shape. */
  const start = useCallback(
    async (file: File, opts: ImportOptions) => {
      const gen = ++genRef.current
      const live = () => gen === genRef.current // false once torn down / superseded
      setState({ job: null, error: null, busy: true })
      const ac = new AbortController()
      syncAbort.current = ac
      try {
        const started = await api.importStart(space, file, opts, ac.signal)

        if (!live()) {
          return
        } // unmounted / space-switched while the upload streamed
        if (started.mode === 'job') {
          apply(started.job)
          if (started.job.status !== 'succeeded') {
            watch(started.job.id)
          }

          return
        }
        // Synchronous fallback (none-mode): drive the NDJSON stream into a synthetic job.
        setState({ job: syncJob('running', { done: 0 }), busy: true, error: null })
        const summary = await started.run((p: ImportProgressLine) => {
          if (live()) {
            setState({
              job: syncJob('running', {
                done: p.done ?? p.imported,
                total: p.total,
                phase: p.phase,
              }),
              busy: true,
              error: null,
            })
          }
        })

        if (live()) {
          setState({
            job: syncJob('succeeded', { done: summary.imported }, { result: summary }),
            busy: false,
            error: null,
          })
        }
      } catch (err) {
        if (!live()) {
          return
        } // torn down — don't paint stale state (e.g. on a new space)
        if (ac.signal.aborted) {
          setState({ job: syncJob('canceled', { done: 0 }), busy: false, error: 'import canceled' })
          return
        }
        const message = err instanceof Error ? err.message : 'import failed'
        // A synchronous failure that carried a partial summary becomes a synthetic
        // FAILED job holding it: the notes it did write are real, and dropping the
        // result here would tell the user nothing happened.
        const partial = err instanceof ApiError ? err.partial : undefined

        setState({
          job: partial
            ? syncJob('failed', { done: partial.imported }, { result: partial, error: message })
            : null,
          busy: false,
          error: message,
        })
      } finally {
        if (live()) {
          syncAbort.current = null
        } // don't clobber a newer start's controller
      }
    },
    [space, apply, watch],
  )

  const cancel = useCallback(async () => {
    // Sync fallback: abort the in-flight upload/stream (no job row to cancel).
    if (syncAbort.current) {
      syncAbort.current.abort()
      return
    }
    const id = state.job?.id

    if (!id || id === 'sync') {
      return
    }
    try {
      apply(await api.jobCancel(space, id))
    } catch {
      // best-effort — the poll/SSE will reflect the real state
    }
  }, [space, state.job?.id, apply])

  const reset = useCallback(() => {
    genRef.current++ // invalidate any in-flight start()
    syncAbort.current?.abort()
    syncAbort.current = null
    stopWatch()
    activeId.current = null
    setState({ job: null, error: null, busy: false })
  }, [stopWatch])

  // Tear everything down on unmount: abort the in-flight upload/stream, invalidate a
  // pending start(), and close the SSE/poll watchers.
  useEffect(
    () => () => {
      genRef.current++
      syncAbort.current?.abort()
      stopWatch()
    },
    [stopWatch],
  )
  // Reconnect ("leave and come back", #191): on mount / space switch, resume the
  // principal's most recent import. An in-flight one keeps streaming progress; a
  // finished one shows its summary again. A none-mode host (jobs 404) or a transient
  // error just leaves a clean slate.
  useEffect(() => {
    reset()
    // Snapshot the generation right after reset(): onChoose()/start()/reset() all bump
    // genRef, so if the user picks a file or launches an import while this jobsList is in
    // flight, the snapshot is STALE and must not clobber the fresh in-flight import.
    // activeId can't guard this — it stays null through the whole pre-202 upload window.
    const gen0 = genRef.current
    let cancelled = false
    void api
      .jobsList(space, 'import')
      .then((list) => {
        // Bail if unmounted/space-switched, or if the user picked a file / started a job
        // while jobsList was in flight — a stale snapshot must never tear down a fresh import.
        if (cancelled || activeId.current || genRef.current !== gen0) {
          return
        }
        const active = list.find((j) => j.status === 'pending' || j.status === 'running')

        if (active) {
          apply(active)
          watch(active.id)
          return
        }
        // The NEWEST terminal import, not the newest SUCCESSFUL one: a failed
        // partial import is the outcome the user needs to see, and falling back to
        // an older success would quietly claim everything went fine.
        const terminal = list.find(
          (j) => j.status === 'succeeded' || j.status === 'failed' || j.status === 'canceled',
        )

        if (terminal) {
          apply(terminal)
        }
      })
      .catch(() => {
        // no durable jobs on this host / transient — nothing to resume
      })
    return () => {
      cancelled = true
      stopWatch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space])

  return { ...state, summary: summaryOf(state.job), start, cancel, reset }
}
