// The process-global background scheduler: one cooperative gate so CPU-heavy background work
// (embed backfill today) yields to interactive traffic instead of starving it. PROCESS-GLOBAL,
// not per-space — cores and the event loop are shared, so a backfill in one space must yield to
// navigation in another. A worker calls `awaitTurn()` between units; the gate holds it while
// interactive requests are in flight (counted via the server's request hooks). Two guarantees:
// QUIET WINDOW — background runs only once the in-flight count has stayed 0 for `quietMs`; DRIP
// FLOOR — even under unrelenting load a worker gets a turn every `dripMs`, so a never-idle instance
// still finishes (and a leaked counter can only delay a turn, never wedge it).
// canon: docs/core.md#cooperative

import type { BackgroundGate, BackgroundSchedulerOptions, InteractiveSignal } from './types'

const macrotaskYield = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

export class BackgroundScheduler implements BackgroundGate, InteractiveSignal {
  /** In-flight interactive requests. >0 ⇒ the process is actively serving a user. */
  private interactive = 0
  /** The last instant interactive traffic was observed (an enter OR an exit) — the
   *  quiet window is measured from here, so the count must stay 0 for `quietMs`
   *  AFTER the last request settled, not merely be 0 right now. */
  private lastBusyAt: number
  /** The last instant a background worker was granted a turn — the drip floor is
   *  measured from here. */
  private lastTurnAt: number
  /** Sleepers in awaitTurn, woken to recompute when the interactive state changes. */
  private readonly wakers = new Set<() => void>()
  private stopped = false

  private readonly quietMs: number
  private readonly dripMs: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(opts: BackgroundSchedulerOptions = {}) {
    this.quietMs = opts.quietMs ?? 100
    this.dripMs = opts.dripMs ?? 1_000
    this.now = opts.now ?? Date.now
    // Default timer is unref'd: a background pacing sleep must never keep the process
    // alive on its own (the server's socket does), so a graceful shutdown with a
    // parked embed loop isn't held open until the drip deadline. Tests inject their own.
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref?.()
        return t
      })
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h))
    // Seed both stamps in the past so a worker that boots into a quiet process gets
    // its first turn immediately (the backfill must NOT be slowed on an idle box —
    // it only yields once real traffic appears).
    this.lastBusyAt = this.now() - this.quietMs
    this.lastTurnAt = this.now() - this.dripMs
  }

  enterInteractive(): void {
    this.interactive++
    this.lastBusyAt = this.now()
    this.wake()
  }

  exitInteractive(): void {
    // Clamp at 0: a double-exit (a belt-and-braces decrement on a hijacked path)
    // must never drive the count negative and pin the gate "busy" forever.
    if (this.interactive > 0) {
      this.interactive--
    }
    this.lastBusyAt = this.now()
    this.wake()
  }

  /** True iff a background worker may run RIGHT NOW (no wait) — the same predicate
   *  awaitTurn resolves on, exposed synchronously. A caller CAN use it to skip
   *  queueing work while busy; the embed loop today just calls awaitTurn (which
   *  yields regardless), so this is a peek helper, not yet wired into a kick path. */
  canRunNow(): boolean {
    if (this.stopped) {
      return true
    }
    const t = this.now()
    const quietOk = this.interactive === 0 && t - this.lastBusyAt >= this.quietMs
    const dripOk = t - this.lastTurnAt >= this.dripMs
    return quietOk || dripOk
  }

  async awaitTurn(): Promise<void> {
    while (!this.stopped) {
      const t = this.now()
      const quietOk = this.interactive === 0 && t - this.lastBusyAt >= this.quietMs
      const dripOk = t - this.lastTurnAt >= this.dripMs

      if (quietOk || dripOk) {
        break
      }
      // Sleep until the earliest condition that could flip: the quiet window
      // elapsing (only meaningful while idle — an enter wakes us to recompute), or
      // the drip deadline. min() so whichever comes first wins; the wake() on any
      // enter/exit re-evaluates before the timer in case the picture changed.
      const untilQuiet =
        this.interactive === 0 ? this.quietMs - (t - this.lastBusyAt) : Number.POSITIVE_INFINITY
      const untilDrip = this.dripMs - (t - this.lastTurnAt)
      await this.sleep(Math.max(0, Math.min(untilQuiet, untilDrip)))
    }
    this.lastTurnAt = this.now()
    // Always release the loop once before the worker proceeds, so a worker whose
    // turn was granted with no wait (the quiet/idle path) still can't monopolise the
    // event loop across iterations — this subsumes the loop's old per-note setImmediate.
    await macrotaskYield()
  }

  /** Wake every sleeper so each awaitTurn recomputes against the new state. */
  private wake(): void {
    if (!this.wakers.size) {
      return
    }
    const woken = [...this.wakers]
    this.wakers.clear()
    for (const w of woken) {
      w()
    }
  }

  /** A timer-bounded sleep that any wake() cuts short. Resolves on the timer OR the
   *  next interactive transition, whichever is first; the awaitTurn loop then
   *  re-tests its conditions. */
  private sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const waker = (): void => {
        this.clearTimer(handle)
        resolve()
      }
      const handle = this.setTimer(() => {
        this.wakers.delete(waker)
        resolve()
      }, ms)
      this.wakers.add(waker)
    })
  }

  /** Release every sleeper and refuse further waits — graceful shutdown / tests.
   *  awaitTurn resolves promptly so a worker's `while (pending && !stopped)` exits. */
  stop(): void {
    this.stopped = true
    this.wake()
  }
}
