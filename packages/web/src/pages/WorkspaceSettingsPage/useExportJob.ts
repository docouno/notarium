import { useCallback, useEffect, useRef, useState } from 'react'
import type { Job } from '@notarium/contract'
import { SSE_EVENT } from '@notarium/contract/events'
import { HTTP_STATUS } from '@notarium/contract/http'

import { api, ApiError, JOB_POLL_MS } from '../../services/api'

// The async-export client hook (#105 [JOBS][A]). Drives one export job through its
// lifecycle for the Export tab: enqueue → track progress → download the finished
// archive. Progress comes from BOTH a dedicated `job` SSE stream (low latency) and
// a poll (the resilience fallback if the stream drops) — whichever updates first
// wins; both stop once the job is terminal. When the host has no durable jobs
// (no meta-DB), enqueue 404s and `start` reports `fallback: true` so the caller
// drops to the synchronous streaming download (#17).

export type ExportOptions = {
  frontmatter?: 'keep' | 'strip'
  scope?: 'user' | 'all'
  folder?: string
}

export type ExportJobState = {
  job: Job | null
  /** Set when the job ended in error / was canceled, or enqueue failed. */
  error: string | null
  /** True while a job is pending or running. */
  busy: boolean
}

export const useExportJob = (space: string) => {
  const [state, setState] = useState<ExportJobState>({ job: null, error: null, busy: false })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const activeId = useRef<string | null>(null)

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
            ? job.error || 'export failed'
            : job.status === 'canceled'
              ? 'export canceled'
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
      // Live updates via the named `job` SSE event (a dedicated short-lived stream
      // for this tab; auto-reconnects, torn frames ignored).
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
      // Poll fallback — catches a missed SSE frame, a dropped stream, or a job
      // that finished between enqueue and the stream opening.
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

  /** Enqueue an export. Returns `{ fallback: true }` when the host has no durable
   *  jobs (404) so the caller can drop to the synchronous download. */
  const start = useCallback(
    async (opts: ExportOptions): Promise<{ fallback: boolean }> => {
      setState({ job: null, error: null, busy: true })
      try {
        const job = await api.exportEnqueue(space, opts)
        apply(job)
        if (job.status !== 'succeeded') {
          watch(job.id)
        }

        return { fallback: false }
      } catch (err) {
        if (err instanceof ApiError && err.status === HTTP_STATUS.NOT_FOUND) {
          setState({ job: null, error: null, busy: false })
          return { fallback: true }
        }
        setState({
          job: null,
          busy: false,
          error: err instanceof Error ? err.message : 'export failed',
        })
        return { fallback: false }
      }
    },
    [space, apply, watch],
  )

  const cancel = useCallback(async () => {
    const id = state.job?.id

    if (!id) {
      return
    }
    try {
      apply(await api.jobCancel(space, id))
    } catch {
      // best-effort — the poll/SSE will reflect the real state
    }
  }, [space, state.job?.id, apply])

  const reset = useCallback(() => {
    stopWatch()
    activeId.current = null
    setState({ job: null, error: null, busy: false })
  }, [stopWatch])

  // Tear the watchers down on unmount / space switch.
  useEffect(() => () => stopWatch(), [stopWatch])
  // Reconnect (#105 "leave and come back"): on mount / space switch, resume the
  // principal's most recent export. An in-flight one keeps streaming progress; a
  // finished one is surfaced ready-to-download (the tab's auto-download only fires for a
  // job it watched go busy→ready, so a reconnect shows the button without re-downloading).
  // A none-mode host (jobs 404) or a transient error just leaves a clean slate.
  useEffect(() => {
    reset()
    let cancelled = false
    void api
      .jobsList(space)
      .then((list) => {
        // Bail if unmounted/space-switched, or if the user already started (or we already
        // adopted) a job while jobsList was in flight — a stale snapshot must never tear
        // down the watcher of a freshly-launched export.
        if (cancelled || activeId.current) {
          return
        }
        const active = list.find((j) => j.status === 'pending' || j.status === 'running')

        if (active) {
          apply(active)
          watch(active.id)
          return
        }
        const ready = list.find((j) => j.status === 'succeeded' && j.artifact)

        if (ready) {
          apply(ready)
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

  return { ...state, start, cancel, reset }
}
