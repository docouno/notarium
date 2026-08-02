import type { WatchControllerOptions } from './types'

/** Quiet window for external-change watcher signals: a trailing debounce —
 *  each signal resets it, so a burst (git checkout, bulk write, an editor's
 *  write+rename pair, our OWN write-through fsync) collapses into ONE reconcile
 *  ~this long after the burst goes quiet. A single external edit still reconciles
 *  ~this fast. The MAX_WAIT cap below keeps a never-quiet stream from starving the
 *  reconcile. */
const WATCH_DEBOUNCE_MS = 250

/** Hard cap on how long the trailing debounce can defer a reconcile under a
 *  continuous event stream: a bulk import / a log file appended every
 *  100 ms would keep resetting WATCH_DEBOUNCE_MS forever, so we force a reconcile
 *  at least this often during a sustained burst. Bounds worst-case external-edit
 *  latency during a storm to ~this, while still coalescing the storm to a handful
 *  of reconciles instead of one per event. */
const WATCH_MAX_WAIT_MS = 2_000

/** The external-change watcher: coalesces a burst of watcher signals into
 *  one reconcile with a trailing debounce + a max-wait cap, and owns the watcher
 *  handle + timers so the read-model's cadence can't drift from whether the watcher
 *  engaged. The class keeps the derived poll cadence (effectiveIntervalMs) since it
 *  also depends on the operator's poll interval.
 *  @see docs/core.md#cooperative */
export class WatchController {
  private readonly watch?: (onChange: () => void) => (() => void) | null
  private readonly reconcile: () => void
  private readonly reconcileReady: () => boolean
  private readonly stopped: () => boolean
  private unwatch: (() => void) | null = null
  private active = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null

  constructor({ watch, reconcile, reconcileReady, stopped }: WatchControllerOptions) {
    this.watch = watch
    this.reconcile = reconcile
    this.reconcileReady = reconcileReady
    this.stopped = stopped
  }

  /** True once the engine's watcher engaged — decides the poll cadence. NB even a
   *  `true` watcher can engage yet silently miss (inotify overflow), which is why a
   *  watched host still keeps a periodic reconcile backstop. */
  get isActive(): boolean {
    return this.active
  }

  /** Engage the engine's watcher (at start). No-op on an engine without watch(). */
  engage(): void {
    if (this.watch) {
      this.unwatch = this.watch(() => this.onSignal())
      this.active = !!this.unwatch
    }
  }

  /** Release the watcher first so an evicted space drops its inotify handle
   *  promptly, and drop both coalescing timers (at stop). */
  disengage(): void {
    this.unwatch?.()
    this.unwatch = null
    this.active = false
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    if (this.maxTimer) {
      clearTimeout(this.maxTimer)
    }
    this.debounceTimer = null
    this.maxTimer = null
  }

  /** An external-change watcher signal: a trailing debounce that coalesces
   *  a burst into ONE reconcile after it goes quiet, with a max-wait cap so a
   *  never-quiet stream (bulk import, our own write-through fsyncs, a churning log)
   *  still reconciles within WATCH_MAX_WAIT_MS instead of being deferred forever —
   *  this is what keeps the watcher from drowning on a bulk write while staying
   *  instant for a single edit. The watcher is only an INVITATION; the
   *  poll it triggers reconciles by a full rescan (the truth arbiter, P3). */
  private onSignal(): void {
    if (this.stopped()) {
      return
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => this.fire(), WATCH_DEBOUNCE_MS)
    this.debounceTimer.unref?.()
    // Arm the cap once per burst (not reset by later signals) so a continuous
    // stream can't keep pushing the debounce out indefinitely.
    if (!this.maxTimer) {
      this.maxTimer = setTimeout(() => this.fire(), WATCH_MAX_WAIT_MS)
      this.maxTimer.unref?.()
    }
  }

  /** Fire a watcher-driven reconcile: clear both coalescing timers, then
   *  reconcile — UNLESS boot still owns the snapshot (cold/notes) or a poll is
   *  already in flight, in which case re-arm a short retry so the signal isn't lost
   *  in the boot-window gap or behind an in-flight rescan that already walked past
   *  the change. The retry is bounded (single-flight poll, unref'd timer), so it
   *  can't busy-spin; an 'error'-phase poll re-runs the full boot scan, which
   *  catches the change itself. */
  private fire(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    if (this.maxTimer) {
      clearTimeout(this.maxTimer)
    }
    this.debounceTimer = null
    this.maxTimer = null
    if (this.stopped()) {
      return
    }
    if (!this.reconcileReady()) {
      this.debounceTimer = setTimeout(() => this.fire(), WATCH_DEBOUNCE_MS)
      this.debounceTimer.unref?.()
      return
    }
    this.reconcile()
  }
}
