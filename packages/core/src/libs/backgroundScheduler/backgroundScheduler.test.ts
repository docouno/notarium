// The cooperative background scheduler: a worker awaiting a turn must run
// freely on an idle process, hold back while interactive requests are in flight,
// resume only after the quiet window, and still get a drip turn under unrelenting
// load. Driven by an injected clock + timer so the timing is deterministic (the
// codebase injects `now` rather than faking globals).

import { describe, expect, it } from 'vitest'

import { BackgroundScheduler } from './backgroundScheduler'

/** A controllable clock + timer pair: timers fire only when `advance` walks time
 *  past their deadline, microtasks flushed between each so an awaited sleep's
 *  continuation runs before the next timer. */
const fakeClock = (start = 10_000) => {
  let nowMs = start
  let seq = 1
  const timers = new Map<number, { fn: () => void; at: number }>()
  const now = (): number => nowMs
  const setTimer = ((fn: () => void, ms: number) => {
    const h = seq++
    timers.set(h, { fn, at: nowMs + ms })
    return h as unknown as ReturnType<typeof setTimeout>
  }) as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>

  const clearTimer = (h: ReturnType<typeof setTimeout>): void => {
    timers.delete(h as unknown as number)
  }

  const advance = async (ms: number): Promise<void> => {
    const target = nowMs + ms

    for (;;) {
      let dueH: number | null = null
      let dueAt = Number.POSITIVE_INFINITY

      for (const [h, t] of timers) {
        if (t.at <= target && t.at < dueAt) {
          dueAt = t.at
          dueH = h
        }
      }
      if (dueH === null) {
        break
      }
      const t = timers.get(dueH)!
      timers.delete(dueH)
      nowMs = t.at
      t.fn()
      await Promise.resolve()
    }
    nowMs = target
  }

  return { now, setTimer, clearTimer, advance }
}

/** Let the scheduler's macrotask yield (real setImmediate) and any microtasks run.
 *  Two rounds: a worker unparked from a sleep schedules its final yield AFTER this
 *  flush's own setImmediate, so one round isn't always enough to see it resolve. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

const make = (
  clock: ReturnType<typeof fakeClock>,
  opts: { quietMs?: number; dripMs?: number } = {},
) =>
  new BackgroundScheduler({
    quietMs: opts.quietMs ?? 100,
    dripMs: opts.dripMs ?? 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

describe('BackgroundScheduler', () => {
  it('grants a turn promptly on a fully idle process', async () => {
    const clk = fakeClock()
    const s = make(clk)
    let done = false
    void s.awaitTurn().then(() => (done = true))
    await flush()
    // No interactive traffic ever → the seeded past stamps make the very first turn
    // immediate (a backfill must NOT be slowed on an idle box).
    expect(done).toBe(true)
  })

  it('holds the worker back while a request is in flight, resumes after the quiet window', async () => {
    const clk = fakeClock()
    const s = make(clk, { quietMs: 100, dripMs: 1_000 })
    // Spend the initial drip credit so this test isolates the quiet-window behaviour.
    await s.awaitTurn()

    s.enterInteractive()
    let done = false
    void s.awaitTurn().then(() => (done = true))
    await flush()
    expect(done).toBe(false) // busy → parked

    await clk.advance(500)
    await flush()
    expect(done).toBe(false) // still busy, drip not yet due

    s.exitInteractive() // now idle — but the quiet window must elapse first
    await flush()
    expect(done).toBe(false)

    await clk.advance(60)
    await flush()
    expect(done).toBe(false) // 60ms < 100ms quiet window

    await clk.advance(50)
    await flush()
    expect(done).toBe(true) // 110ms of quiet → resumes
  })

  it('a fresh request during the quiet window re-arms the wait', async () => {
    const clk = fakeClock()
    const s = make(clk, { quietMs: 100, dripMs: 10_000 })
    await s.awaitTurn() // spend drip credit

    s.enterInteractive()
    let done = false
    void s.awaitTurn().then(() => (done = true))
    s.exitInteractive() // idle, quiet window starts
    await flush()

    await clk.advance(80) // 80ms quiet
    s.enterInteractive() // a new request lands — busy again, quiet resets
    s.exitInteractive()
    await flush()
    await clk.advance(80) // 80ms since the LAST request — still under 100
    await flush()
    expect(done).toBe(false)

    await clk.advance(30) // now 110ms of uninterrupted quiet
    await flush()
    expect(done).toBe(true)
  })

  it('rechecks the gate after the mandatory macrotask yield', async () => {
    const clk = fakeClock()
    const s = make(clk, { quietMs: 100, dripMs: 1_000 })
    await s.awaitTurn() // spend the initial drip credit
    let done = false

    void s.awaitTurn().then(() => (done = true))
    // The call saw an idle process, but this request arrives before its
    // setImmediate continuation. It must close the gate before the grant lands.
    s.enterInteractive()
    await flush()
    expect(done).toBe(false)

    s.exitInteractive()
    await clk.advance(100)
    await flush()
    expect(done).toBe(true)
  })

  it('lets interactive traffic overtake a parked quiet-window wake', async () => {
    const clk = fakeClock()
    const s = make(clk, { quietMs: 100, dripMs: 1_000 })
    await s.awaitTurn()
    s.enterInteractive()
    s.exitInteractive()
    let done = false

    void s.awaitTurn().then(() => (done = true))
    await flush() // initial check parks on the quiet-window timer
    await clk.advance(100) // timer wakes; the final setImmediate has not run yet
    s.enterInteractive() // poll-phase request must overtake the background grant
    await flush()
    expect(done).toBe(false)

    s.exitInteractive()
    await clk.advance(100)
    await flush()
    expect(done).toBe(true)
  })

  it('still grants a drip turn under unrelenting load', async () => {
    const clk = fakeClock()
    const s = make(clk, { quietMs: 100, dripMs: 1_000 })
    await s.awaitTurn() // lastTurnAt = now

    s.enterInteractive() // permanently busy — never exits
    let done = false
    void s.awaitTurn().then(() => (done = true))
    await flush()
    expect(done).toBe(false)

    await clk.advance(999)
    await flush()
    expect(done).toBe(false) // drip not yet due

    await clk.advance(2)
    await flush()
    expect(done).toBe(true) // >= 1000ms starved → drip floor grants a turn despite load
  })

  it('shares one drip floor across competing background workers', async () => {
    const clk = fakeClock()
    const s = make(clk, { quietMs: 100, dripMs: 1_000 })
    await s.awaitTurn()
    s.enterInteractive()
    let completed = 0

    void s.awaitTurn().then(() => completed++)
    void s.awaitTurn().then(() => completed++)
    await flush()
    expect(completed).toBe(0)

    await clk.advance(1_000)
    await flush()
    expect(completed).toBe(1)

    await clk.advance(1_000)
    await flush()
    expect(completed).toBe(2)
  })

  it('cancels a parked waiter without spending the shared drip turn', async () => {
    const clk = fakeClock()
    const s = make(clk, { quietMs: 100, dripMs: 1_000 })
    await s.awaitTurn()
    s.enterInteractive()
    const abort = new AbortController()
    let cancelled = false
    let worker = false

    void s.awaitTurn(abort.signal).then(() => (cancelled = true))
    void s.awaitTurn().then(() => (worker = true))
    await flush()
    expect(cancelled).toBe(false)
    expect(worker).toBe(false)

    abort.abort()
    await flush()
    expect(cancelled).toBe(true)
    expect(worker).toBe(false)

    await clk.advance(1_000)
    await flush()
    expect(worker).toBe(true)
  })

  it('clamps the interactive count at zero (a double-exit cannot pin it busy)', async () => {
    const clk = fakeClock()
    const s = make(clk, { quietMs: 100, dripMs: 1_000 })
    await s.awaitTurn()

    s.enterInteractive()
    s.exitInteractive()
    s.exitInteractive() // stray extra exit — must NOT drive the count to -1
    await flush()

    // One enter now leaves the count at exactly 1 (not 0), so a turn is gated again.
    s.enterInteractive()
    let done = false
    void s.awaitTurn().then(() => (done = true))
    await flush()
    await clk.advance(150) // past the quiet window, but still busy
    await flush()
    expect(done).toBe(false)
  })

  it('canRunNow reflects the live gate state', async () => {
    const clk = fakeClock()
    const s = make(clk, { quietMs: 100, dripMs: 1_000 })
    expect(s.canRunNow()).toBe(true) // idle
    await s.awaitTurn() // spend the seeded drip credit so a turn isn't auto-granted
    s.enterInteractive()
    expect(s.canRunNow()).toBe(false) // busy and not yet starved → no turn
    await clk.advance(1_000)
    expect(s.canRunNow()).toBe(true) // starved past the drip floor → a turn is owed
  })

  it('stop() releases a parked worker', async () => {
    const clk = fakeClock()
    const s = make(clk, { quietMs: 100, dripMs: 10_000 })
    await s.awaitTurn()
    s.enterInteractive() // busy
    let done = false
    void s.awaitTurn().then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    s.stop()
    await flush()
    expect(done).toBe(true) // shutdown unblocks the loop's while-guard
  })
})
