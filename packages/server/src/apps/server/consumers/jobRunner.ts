// The durable job runner: one worker per process that drains the `jobs` table.
// canon: docs/jobs.md#delivery-and-recovery · docs/jobs.md#single-flight-the-hard-part

import type { ArtifactStore } from '../../../libs/artifactStore'
import type { JobRecord, JobsPersistence } from '../../../services/metaDb'
import { TerminalJobError } from './terminalJobError'

export { TerminalJobError } from './terminalJobError'

/** Thrown by ctx.report() when the job is no longer ours (canceled/reaped); the runner
 *  treats it as a clean stop, not a failure. */
export class JobAbortedError extends Error {
  constructor(readonly aborted: boolean = true) {
    super('job aborted')
    this.name = 'JobAbortedError'
  }
}

/** What a handler is handed for one job run. */
export type JobContext = {
  job: JobRecord
  /** The lease token THIS run holds in `locked_by` — unique per claim, so a
   *  reap-and-reclaim gives the new run a different one. A handler that mutates
   *  durable state outside the job row proves ownership with it; `job.lockedBy`
   *  is the same value but nullable, and a handler must not have to guess. */
  lease: string
  /** Push progress + keep the lock alive. Throws JobAbortedError on cancel/reap —
   *  handlers must let it propagate (don't swallow). */
  report(p: { done: number; total?: number | null; phase?: string | null }): Promise<void>
  /** Aborted on cancel or shutdown — long loops should check it and bail. */
  signal: AbortSignal
  artifacts: ArtifactStore
}

/** A handler's outcome. canon: docs/jobs.md#artifacts */
export type JobResult = {
  result?: unknown
  artifactRef?: string | null
  artifactBytes?: number | null
  artifactName?: string | null
  expiresAt?: string | null
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult>

export type JobRunnerOptions = {
  jobs: JobsPersistence
  artifacts: ArtifactStore
  /** The runner claims only kinds present here. */
  handlers: Record<string, JobHandler>
  onUpdate?: (job: JobRecord) => void
  /** Consumer cleanup for jobs that have REACHED a terminal state. Called at two
   *  moments, and both are needed: once per maintenance tick (right after the reaper
   *  and, deliberately, before retention prune — the last moment a terminal row
   *  still exists to be read), and once immediately after THIS runner persists a
   *  terminal transition of its own. The tick alone is a net for crashes, but it is
   *  a minute wide, and for a whole minute after a cancel the import contour still
   *  refused the destinations that cancel had just released (#302).
   *
   *  It must therefore be idempotent — it re-reads what is still open, so a close
   *  that already happened finds nothing — and it must not throw a job's outcome
   *  away: a failure here is logged, never propagated. */
  onTerminalCleanup?: () => Promise<void>
  /** Consumer housekeeping run AFTER the built-in reap/GC/prune/temp-sweep each tick.
   *  Best-effort; a throw is logged, not fatal. */
  onMaintenance?: () => void | Promise<void>
  /** Identifies this worker in `locked_by` (default: a fresh random id). */
  workerId?: string
  /** Claim-poll cadence (default 2s). */
  pollIntervalMs?: number
  /** No-heartbeat window before a running job is considered stalled (default 2min). */
  staleAfterMs?: number
  /** Reaper + GC cadence (default 60s). */
  maintenanceIntervalMs?: number
  /** Artifact TTL applied to a successful job (default 7 days, GitHub-ish). */
  artifactTtlMs?: number
  /** Terminal-row retention before prune (default 30 days). */
  retentionMs?: number
  /** Max jobs running at once in this process (default 2). */
  concurrency?: number
  /** Retry backoff base; attempt n waits base·2^(n-1) + jitter (default 5s). */
  backoffBaseMs?: number
  /** Upper bound on stop()'s drain wait; a handler that ignores its AbortSignal must
   *  not wedge shutdown (default 3s, leaving the supervisor grace for store flush). */
  stopTimeoutMs?: number
  /** Age past which an orphaned temp part (`*.part`) is swept (default 1h). MUCH larger
   *  than `staleAfterMs`: a live export's lock stays fresh via heartbeat but its temp's
   *  mtime only advances on writes, so the grace ensures a slow run is never swept out
   *  from under itself. */
  tempSweepAfterMs?: number
  now?: () => Date
  log?: (msg: string, err?: unknown) => void
  /** Bracket handlers and filesystem housekeeping as backup-visible mutations. */
  runMutation?: <T>(task: () => Promise<T>) => Promise<T>
  /** Enter before claiming and release only after that claimed job settles, so a
   *  checkpoint cannot capture a `running` row whose handler is still queued. */
  enterMutation?: () => Promise<() => void>
}

/** Artifact TTL for a successful job (GitHub-ish). Exported so the seed applier ages
 *  seeded artifacts by the SAME window the live GC uses — a copied literal would drift. */
export const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60_000

const DEFAULTS = {
  pollIntervalMs: 2_000,
  staleAfterMs: 2 * 60_000,
  maintenanceIntervalMs: 60_000,
  artifactTtlMs: ARTIFACT_TTL_MS,
  retentionMs: 30 * 24 * 60 * 60_000,
  concurrency: 2,
  backoffBaseMs: 5_000,
  stopTimeoutMs: 3_000,
  tempSweepAfterMs: 60 * 60_000,
}

export type JobRunner = {
  start(): void
  /** Nudge the claim loop (called right after an enqueue for low latency). */
  wake(): void
  /** Stop: abort in-flight handlers, release their jobs, await the drain. */
  stop(): Promise<void>
}

export const createJobRunner = (opts: JobRunnerOptions): JobRunner => {
  const cfg = { ...DEFAULTS, ...opts }
  const { jobs, artifacts, handlers, onUpdate } = opts
  const kinds = Object.keys(handlers)
  const workerId = opts.workerId ?? `w-${Math.random().toString(36).slice(2, 10)}`
  const nowDate = opts.now ?? (() => new Date())
  const nowIso = () => nowDate().toISOString()
  const log =
    opts.log ?? ((msg: string, err?: unknown) => console.error(`[jobs] ${msg}`, err ?? ''))
  // Per-run lease token written into `locked_by` at claim (unique per claim, not a
  // constant workerId).
  let leaseSeq = 0
  const nextLease = () =>
    `${workerId}.${(++leaseSeq).toString(36)}.${Math.random().toString(36).slice(2, 8)}`

  let running = false
  let shuttingDown = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let maintTimer: ReturnType<typeof setInterval> | null = null
  let claiming = false
  // Keyed by per-run LEASE token, not job.id: during a reap-reclaim race a job is briefly
  // present under two leases as two slots, so neither run's cleanup clobbers the other and
  // stop() aborts+awaits BOTH.
  const inflight = new Map<string, { controller: AbortController; done: Promise<void> }>()

  const notify = (job: JobRecord | null) => {
    if (job && onUpdate) {
      try {
        onUpdate(job)
      } catch (err) {
        log('onUpdate threw', err)
      }
    }
  }

  /** Hand the consumers a job that has just ENDED, the moment its terminal row is
   *  durable. The maintenance tick runs the very same pass and remains the net for
   *  a process that dies in this window; what this call removes is the wait, which
   *  was a whole maintenance interval of holding what the job no longer owns.
   *
   *  Deliberately fire-and-log: the row is already terminal, and a cleanup that
   *  threw here would surface as a failure of a job that did not fail. */
  const afterTerminal = async (): Promise<void> => {
    if (!opts.onTerminalCleanup) {
      return
    }
    try {
      await opts.onTerminalCleanup()
    } catch (err) {
      log('terminal cleanup failed', err)
    }
  }

  /** Claim as many runnable jobs as free slots allow, launching each. */
  const claimLoop = async (): Promise<void> => {
    if (claiming || !running || shuttingDown || !kinds.length) {
      return
    }
    claiming = true
    try {
      while (running && !shuttingDown && inflight.size < cfg.concurrency) {
        const release = opts.enterMutation ? await opts.enterMutation() : () => {}
        const job = await jobs.claimNext(nextLease(), kinds, nowIso()).catch((err) => {
          log('claimNext failed', err)
          return null
        })

        if (!job) {
          release()
          break
        }
        launch(job, release)
      }
    } finally {
      claiming = false
    }
  }

  const launch = (job: JobRecord, release: () => void): void => {
    const lease = job.lockedBy ?? job.id
    const controller = new AbortController()
    const done = runJob(job, controller).finally(() => {
      release()
      inflight.delete(lease)
      if (running && !shuttingDown) {
        void claimLoop()
      }
    })
    inflight.set(lease, { controller, done })
    notify(job)
  }

  const runJob = async (job: JobRecord, controller: AbortController): Promise<void> => {
    // The lease token this run holds (claimNext stamped it into locked_by).
    const lease = job.lockedBy ?? workerId
    const handler = handlers[job.kind]

    if (!handler) {
      // Defensive: we only claim known kinds, so this is unreachable. Fail loudly
      // rather than loop the row forever — and hand the consumers the terminal row
      // like every other terminal transition of this runner. Unreachable is not a
      // licence to owe a promise the docblock makes without exception: the moment
      // this branch ever ran, its row would be the one terminal row nothing closed.
      await jobs.fail(job.id, lease, { error: `no handler for kind ${job.kind}`, now: nowIso() })
      notify(await jobs.get(job.id))
      await afterTerminal()
      return
    }

    let lastDone = job.progressDone
    let lastTotal = job.progressTotal
    let lastPhase = job.phase

    // Heartbeat refreshes the lock; a false return ⇒ the row is no longer ours
    // (cancel/reap) → abort.
    const hb = setInterval(
      () => {
        void jobs
          .heartbeat(job.id, lease, {
            done: lastDone,
            total: lastTotal,
            phase: lastPhase,
            now: nowIso(),
          })
          .then((ok) => {
            if (!ok && !controller.signal.aborted) {
              controller.abort()
            }
          })
          .catch((err) => log(`heartbeat ${job.id} failed`, err))
      },
      Math.max(1_000, Math.floor(cfg.staleAfterMs / 3)),
    )
    // A broken handler may ignore AbortSignal forever. The HTTP listener and other
    // service handles keep a healthy process alive; this lease timer must never be the
    // last ref that turns a bounded graceful stop into Docker's eventual SIGKILL.
    hb.unref?.()
    const stopHeartbeat = () => clearInterval(hb)
    controller.signal.addEventListener('abort', stopHeartbeat, { once: true })

    const ctx: JobContext = {
      job,
      lease,
      signal: controller.signal,
      artifacts,
      report: async (p) => {
        lastDone = p.done
        if (p.total !== undefined) {
          lastTotal = p.total
        }
        if (p.phase !== undefined) {
          lastPhase = p.phase
        }
        const ok = await jobs.heartbeat(job.id, lease, {
          done: p.done,
          total: p.total,
          phase: p.phase,
          now: nowIso(),
        })

        if (!ok) {
          if (!controller.signal.aborted) {
            controller.abort()
          }
          throw new JobAbortedError()
        }
        notify({ ...job, progressDone: p.done, progressTotal: lastTotal, phase: lastPhase })
      },
    }

    try {
      const out = await handler(ctx)
      const expiresAt =
        out.expiresAt ??
        (out.artifactRef ? new Date(nowDate().getTime() + cfg.artifactTtlMs).toISOString() : null)
      // Lease-guarded: false ⇒ canceled or reaped-and-reclaimed while we finished — do
      // NOT stamp 'succeeded' over it; report the row's real state instead.
      const ok = await jobs.succeed(job.id, lease, {
        result: out.result,
        artifactRef: out.artifactRef ?? null,
        artifactBytes: out.artifactBytes ?? null,
        artifactName: out.artifactName ?? null,
        expiresAt,
        now: nowIso(),
      })
      const current = await jobs.get(job.id).catch(() => null)

      // Published an artifact but lost the lease to a CANCEL: nobody re-runs a canceled
      // job and its row carries no ref, so the row-driven TTL GC can never reach the file
      // — remove it now. A reaped-and-reclaimed row is left alone: the peer overwrites the
      // same deterministic ref.
      if (!ok && out.artifactRef && current?.status === 'canceled') {
        await artifacts.remove(out.artifactRef).catch(() => {})
      }
      notify(current)
      // The row is terminal when `ok` — and when it is not, it was taken by a
      // cancel (terminal too) or by a reap (not terminal at all). The cleanup reads
      // the row rather than trusting this call, which is what lets one unconditional
      // call cover every one of those without a second predicate to keep in step.
      await afterTerminal()
    } catch (err) {
      // Shutdown: release the job (refunds the claim's attempt bump) so the restart/peer
      // resumes it without burning the retry budget.
      if (shuttingDown) {
        await jobs.release(job.id, lease, nowIso()).catch((e) => log(`release ${job.id}`, e))
        notify(await jobs.get(job.id).catch(() => null))
        return
      }
      const current = await jobs.get(job.id).catch(() => null)

      // Canceled out from under us — the row is already terminal; just report it.
      // A cancel is the case this matters most for: the user cancels an import and
      // starts it again, and until the claims that cancel released are closed the
      // second run is refused its own destinations.
      if (current?.status === 'canceled' || err instanceof JobAbortedError) {
        notify(current)
        await afterTerminal()
        return
      }
      const message = err instanceof Error ? err.message : String(err)

      // TerminalJobError = deterministic bad input — fail NOW, no retry/backoff (a re-run
      // fails identically; surface the real error immediately).
      if (err instanceof TerminalJobError) {
        // A terminal failure may carry what the run finished before it failed;
        // a retryable one below never does.
        await jobs.fail(job.id, lease, { error: message, now: nowIso(), result: err.result })
        notify(await jobs.get(job.id).catch(() => null))
        await afterTerminal()
        return
      }
      log(`job ${job.id} (${job.kind}) failed: ${message}`)
      // attempts was bumped at claim, so it already reflects this run. fail is lease-guarded,
      // so a reviving stale worker can't resurrect a peer's row.
      if (job.attempts < job.maxAttempts) {
        const backoff =
          cfg.backoffBaseMs * 2 ** (job.attempts - 1) + Math.floor(Math.random() * 1_000)
        const retryAt = new Date(nowDate().getTime() + backoff).toISOString()
        await jobs.fail(job.id, lease, { error: message, retryAt, now: nowIso() })
      } else {
        await jobs.fail(job.id, lease, { error: message, now: nowIso() })
      }
      notify(await jobs.get(job.id).catch(() => null))
      // Only the exhausted branch above is terminal; a retryable failure leaves the
      // row pending, and the cleanup reads the row rather than this branch — which
      // is why one call covers both without a second predicate to keep in step.
      await afterTerminal()
      return
    } finally {
      controller.signal.removeEventListener('abort', stopHeartbeat)
      stopHeartbeat()
    }
  }

  const maintenance = async (): Promise<void> => {
    if (!running || shuttingDown) {
      return
    }
    const now = nowIso()

    // Reap stalled workers' jobs (reopened ones get re-claimed by the poll loop).
    try {
      const reaped = await jobs.reapStale(
        new Date(nowDate().getTime() - cfg.staleAfterMs).toISOString(),
        now,
      )

      for (const j of reaped) {
        notify(j)
      }
      if (reaped.length) {
        void claimLoop()
      }
    } catch (err) {
      log('reapStale failed', err)
    }
    // Terminal cleanup before anything reclaims rows or files: a reservation is
    // closed only once its job is observably terminal, and the proof is that row.
    // The same pass a terminal transition runs directly — this tick is what covers
    // the runs that ended without one (a crashed worker, a reaped row).
    await afterTerminal()
    // Delete the file, THEN clear the pointer — clearing on a failed unlink would orphan
    // the file forever (findExpired only returns rows that still carry a ref).
    try {
      for (const j of await jobs.findExpired(now)) {
        if (j.artifactRef) {
          try {
            await artifacts.remove(j.artifactRef)
          } catch (e) {
            log('artifact rm', e)
            continue // leave the pointer; a later tick retries the delete
          }
        }
        await jobs.clearArtifact(j.id, now)
      }
    } catch (err) {
      log('artifact GC failed', err)
    }

    // Sweep orphaned per-run temp parts (`*.part`) — no row references a temp, so only an
    // age-based fs sweep reclaims them.
    try {
      await artifacts.sweepTempParts?.(nowDate().getTime() - cfg.tempSweepAfterMs)
    } catch (err) {
      log('temp sweep failed', err)
    }
    if (opts.onMaintenance) {
      try {
        await opts.onMaintenance()
      } catch (err) {
        log('onMaintenance failed', err)
      }
    }
    // Retention runs LAST of the row-touching steps. Everything above needs the
    // terminal row: the reservation close reads it to know the job ended, and the
    // staging sweep reads it to know an upload is orphaned. Pruning first would
    // delete the evidence they run on — and the drivers refuse it a second time,
    // skipping any row a live reservation still references.
    try {
      await jobs.prune(new Date(nowDate().getTime() - cfg.retentionMs).toISOString())
    } catch (err) {
      log('prune failed', err)
    }
  }

  const scheduleNextPoll = () => {
    if (!running || shuttingDown) {
      return
    }
    if (pollTimer) {
      clearTimeout(pollTimer)
    }
    pollTimer = setTimeout(() => {
      void claimLoop().finally(scheduleNextPoll)
    }, cfg.pollIntervalMs)
  }

  return {
    start: () => {
      if (running) {
        return
      }
      running = true
      shuttingDown = false
      void claimLoop()
      scheduleNextPoll()
      maintTimer = setInterval(
        () => void (opts.runMutation ? opts.runMutation(maintenance) : maintenance()),
        cfg.maintenanceIntervalMs,
      )
      // Run maintenance once at start: recover jobs left 'running' by a previous crash
      // without waiting for the first tick (their locks may already be stale).
      void (opts.runMutation ? opts.runMutation(maintenance) : maintenance())
    },
    wake: () => {
      void claimLoop()
    },
    stop: async () => {
      shuttingDown = true
      running = false
      if (pollTimer) {
        clearTimeout(pollTimer)
      }
      if (maintTimer) {
        clearInterval(maintTimer)
      }
      pollTimer = null
      maintTimer = null
      // Abort every in-flight handler, then wait for the drain — but BOUND the wait: a
      // handler that ignores its AbortSignal must not hang shutdown forever.
      for (const { controller } of inflight.values()) {
        controller.abort()
      }
      const drained = Promise.allSettled([...inflight.values()].map((e) => e.done))
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((res) => {
        timer = setTimeout(() => {
          log('stop: in-flight drain timed out; proceeding to close')
          res()
        }, cfg.stopTimeoutMs)
        timer.unref?.()
      })

      try {
        await Promise.race([drained, timeout])
      } finally {
        // Clear the timer when the drain won, so it can't later log a false 'timed out'
        // (or fire spuriously during a stop()→start() reuse).
        if (timer) {
          clearTimeout(timer)
        }
      }
    },
  }
}
