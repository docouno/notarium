import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImportSummary, Job } from '@notarium/contract'
import { SSE_EVENT } from '@notarium/contract/events'

import {
  api,
  ApiError,
  type ImportProgressLine,
  type ImportStartOptions,
  type ImportUploadSource,
  JOB_POLL_MS,
  normalizeImportSummary,
} from '../../services/api'

// The durable-import client hook (#191 [JOBS][B]) — the inverse of useExportJob.
// Drives one import job through its lifecycle for the Import tab: upload → enqueue →
// track phase/progress (a live written-note count) → surface the summary. Progress
// comes from BOTH a dedicated `job` SSE stream (low latency) and a poll (the fallback
// if the stream drops); both stop once terminal. It survives leaving the tab (the
// reconnect effect re-adopts the principal's latest import on mount) and a server
// restart (the job is durable). Cancel is cooperative. When the host has no durable
// jobs (no meta-DB) the POST answers with the synchronous NDJSON stream instead, which
// this hook drives into the SAME shape (a synthetic job) so the tab renders uniformly.

export type ImportOptions = ImportStartOptions

export type ImportJobState = {
  job: Job | null
  /** Set when the job ended in error / was canceled, or enqueue failed. */
  error: string | null
  /** True while a job is pending or running. */
  busy: boolean
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

export const useImportJob = (space: string, targetJobId?: string | null) => {
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
  // A job id can return after route/reset (A → … → A), so it cannot itself identify
  // one watcher session. stopWatch() invalidates every callback from the old generation.
  const watchGenRef = useRef(0)

  const stopWatch = useCallback(() => {
    watchGenRef.current++
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
      const watchGen = watchGenRef.current

      activeId.current = id
      const applyWatched = (job: Job) => {
        if (watchGenRef.current === watchGen && activeId.current === id && job.id === id) {
          apply(job)
        }
      }

      // Live updates via the named `job` SSE event (a dedicated short-lived stream for
      // this tab; auto-reconnects, torn frames ignored).
      try {
        const es = new EventSource(api.spaceEventsUrl(space))
        es.addEventListener(SSE_EVENT.JOB, (e) => {
          try {
            const job = JSON.parse((e as MessageEvent).data as string) as Job

            applyWatched(job)
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
        if (watchGenRef.current !== watchGen || activeId.current !== id) {
          return
        }
        void api
          .jobGet(space, id)
          .then(applyWatched)
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
    async (source: ImportUploadSource, opts: ImportOptions) => {
      const gen = ++genRef.current
      const live = () => gen === genRef.current // false once torn down / superseded
      setState({ job: null, error: null, busy: true })
      const ac = new AbortController()
      syncAbort.current = ac
      try {
        const started = await api.importStart(space, source, opts, ac.signal)

        if (!live()) {
          return
        } // unmounted / space-switched while the upload streamed
        if (started.mode === 'job') {
          apply(started.job)
          if (started.job.status === 'pending' || started.job.status === 'running') {
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
    const gen = genRef.current
    const watchGen = watchGenRef.current

    try {
      const canceled = await api.jobCancel(space, id)

      if (
        genRef.current === gen &&
        watchGenRef.current === watchGen &&
        activeId.current === id &&
        canceled.id === id
      ) {
        apply(canceled)
      }
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
  // A job-addressed route owns exactly that job. The ordinary route keeps the
  // established reconnect behavior and adopts the newest import.
  useEffect(() => {
    reset()
    // Snapshot the generation right after reset(): onChoose()/start()/reset() all bump
    // genRef, so if the user picks a file or launches an import while this jobsList is in
    // flight, the snapshot is STALE and must not clobber the fresh in-flight import.
    // activeId can't guard this — it stays null through the whole pre-202 upload window.
    const gen0 = genRef.current
    let cancelled = false

    const adopt = (job: Job) => {
      if (cancelled || activeId.current || genRef.current !== gen0) {
        return
      }
      apply(job)
      if (job.status === 'pending' || job.status === 'running') {
        watch(job.id)
      }
    }

    if (targetJobId) {
      void api
        .jobGet(space, targetJobId)
        .then(adopt)
        .catch((error) => {
          if (!cancelled && genRef.current === gen0) {
            setState({
              job: null,
              busy: false,
              error: error instanceof Error ? error.message : 'Import job could not be loaded',
            })
          }
        })
    } else {
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
            adopt(active)
            return
          }
          // The NEWEST terminal import, not the newest SUCCESSFUL one: a failed
          // partial import is the outcome the user needs to see, and falling back to
          // an older success would quietly claim everything went fine.
          const terminal = list.find(
            (j) => j.status === 'succeeded' || j.status === 'failed' || j.status === 'canceled',
          )

          if (terminal) {
            adopt(terminal)
          }
        })
        .catch(() => {
          // no durable jobs on this host / transient — nothing to resume
        })
    }

    return () => {
      cancelled = true
      stopWatch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, targetJobId])

  return { ...state, summary: summaryOf(state.job), start, cancel, reset }
}
