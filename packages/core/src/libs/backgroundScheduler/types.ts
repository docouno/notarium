/** The narrow seam a background worker (the embed loop) depends on — it only ever
 *  awaits a turn. Kept separate from the full class so the engine/read-model can be
 *  fed a test double without the timer machinery. */
export type BackgroundGate = {
  /** Resolve when the worker may run its next unit of work — immediately when the
   *  process is quiet, after a wait when interactive traffic is in flight (bounded
   *  by the drip floor). Always yields the macrotask phase at least once before
   *  resolving, so a synchronous work loop can't starve the event loop on its own. */
  awaitTurn(): Promise<void>
}

/** The interactive-traffic side of the scheduler — what the server's request
 *  lifecycle feeds. Balanced enter/exit; a missed exit is bounded by the drip floor,
 *  never fatal. */
export type InteractiveSignal = {
  enterInteractive(): void
  exitInteractive(): void
}

export type BackgroundSchedulerOptions = {
  /** How long the process must stay free of interactive requests before a parked
   *  background worker resumes. Short enough to be invisible on a quiet box, long
   *  enough that a burst of clicks reads as "busy". Default 100ms. */
  quietMs?: number
  /** The hard floor on background starvation: under continuous load the worker
   *  still gets a turn at least this often, so indexing converges on a never-idle
   *  instance (and a leaked counter self-heals within this bound). Default 1000ms. */
  dripMs?: number
  /** Injected clock (ms). Defaults to Date.now; tests pass a controllable one. */
  now?: () => number
  /** Injected timer (for tests). Defaults to setTimeout. Must return a handle the
   *  paired `clearTimer` cancels. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}
