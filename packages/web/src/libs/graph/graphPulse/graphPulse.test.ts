import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIX_LEVEL, REQUEUE_LEAD_SEC, REQUEUE_POLL_MS, RISER_SEC } from './consts'
import { createGraphPulse } from './graphPulse'
import { type FakeAudioContext, type FakeMotionQuery, installAudioEnv } from './graphPulse.mock'

const graph = {
  nodes: [
    { id: 'a', degree: 2 },
    { id: 'b', degree: 1 },
    { id: 'c', degree: 1 },
  ],
  links: [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' },
  ],
}

let env: { restore: () => void } | null = null

const setup = (opts?: { audio?: boolean; reduced?: boolean }) => {
  const installed = installAudioEnv(opts)
  env = installed

  return installed as { ctx: FakeAudioContext; motion: FakeMotionQuery; restore: () => void }
}

afterEach(() => {
  env?.restore()
  env = null
  // A clock test that fails mid-body leaves fake timers installed; reset globally
  // so the next test isn't handed a frozen clock. (No-op when they're already real.)
  vi.useRealTimers()
})

describe('graphPulse — the start contract', () => {
  // The caller hands its keyboard over on the strength of start()'s answer, so a
  // refusal that reads as success would leave the whole app without shortcuts.
  it('reports success and runs onEnd exactly once on stop', () => {
    setup()
    const onEnd = vi.fn()
    const engine = createGraphPulse()

    expect(engine.start(graph, { onEnd })).toBe(true)
    expect(engine.active).toBe(true)

    engine.stop()
    expect(engine.active).toBe(false)
    expect(onEnd).toHaveBeenCalledTimes(1)

    engine.stop() // idempotent: a second exit must not fire the callback again
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('refuses an empty graph WITHOUT claiming to have started', () => {
    setup()
    const onEnd = vi.fn()
    const engine = createGraphPulse()

    expect(engine.start({ nodes: [], links: [] }, { onEnd })).toBe(false)
    expect(engine.active).toBe(false)
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('refuses when the browser has no Web Audio, leaving nothing behind', () => {
    const { motion } = setup({ audio: false })
    const onEnd = vi.fn()
    const engine = createGraphPulse()

    expect(engine.start(graph, { onEnd })).toBe(false)
    expect(engine.active).toBe(false)
    // A refused start must leave no trace: no media-query listener (which would
    // pin the whole graph slice), and no callback firing for a mode that never
    // opened — the caller reads the returned false instead.
    expect(motion.listeners).toBe(0)
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('refuses a second start while one is running (no medley on top of a medley)', () => {
    const { ctx } = setup()
    const engine = createGraphPulse()
    engine.start(graph, {})
    const scheduled = ctx.started

    expect(engine.start(graph, {})).toBe(false)
    expect(ctx.started).toBe(scheduled) // not one extra voice was queued
    engine.stop()
  })

  it('stop() is safe on an engine that never started', () => {
    setup()
    const engine = createGraphPulse()

    expect(() => engine.stop()).not.toThrow()
    expect(engine.active).toBe(false)
  })

  it('unsubscribes from the motion query when it exits', () => {
    const { motion } = setup()
    const engine = createGraphPulse()
    engine.start(graph, {})
    expect(motion.listeners).toBe(1)

    engine.stop()
    expect(motion.listeners).toBe(0)
  })
})

describe('graphPulse — the piano', () => {
  it('answers only for mapped physical keys, and holds one voice per key', () => {
    const { ctx } = setup()
    const engine = createGraphPulse()
    engine.start(graph, {})

    const before = ctx.started
    expect(engine.noteOn('KeyA')).toBe(true) // home row = white keys
    const afterFirst = ctx.started
    expect(afterFirst).toBeGreaterThan(before) // a voice really started

    expect(engine.noteOn('KeyA')).toBe(true) // still ours…
    expect(ctx.started).toBe(afterFirst) // …but auto-repeat adds no second voice

    expect(engine.noteOn('Digit1')).toBe(false) // unmapped: the app may want it
    expect(ctx.started).toBe(afterFirst)

    // A held voice has no scheduled end — releasing it is the ONLY thing that ever
    // stops it, so a release that quietly does nothing is a note droning forever.
    const stoppedBefore = ctx.stopped
    engine.noteOff('KeyA')
    expect(ctx.stopped).toBeGreaterThan(stoppedBefore)

    engine.noteOn('KeyD')
    const beforeBlur = ctx.stopped
    engine.releaseAll() // the window-blur safety
    expect(ctx.stopped).toBeGreaterThan(beforeBlur)
    engine.stop()
  })

  it('is inert once stopped', () => {
    setup()
    const engine = createGraphPulse()
    engine.start(graph, {})
    engine.stop()

    expect(engine.noteOn('KeyA')).toBe(false)
    expect(engine.intensityFor('a')).toBe(0)
  })
})

describe('graphPulse — the glow', () => {
  it('decays from a strike and stays cold for untouched nodes', () => {
    const { ctx } = setup()
    const engine = createGraphPulse()
    engine.start(graph, {})
    // The lowest key is assigned the biggest hub, so KeyA (C4) lights 'a'.
    engine.noteOn('KeyA')

    expect(engine.intensityFor('a')).toBeGreaterThan(0.9)
    expect(engine.intensityFor('nobody')).toBe(0)

    ctx.currentTime += 0.28 // one time-constant later: down to ~1/e
    expect(engine.intensityFor('a')).toBeLessThan(0.5)
    ctx.currentTime += 2 // and long after, fully cold
    expect(engine.intensityFor('a')).toBe(0)
    engine.stop()
  })

  it('breathes instead of strobing under prefers-reduced-motion', () => {
    // Same elapsed time, much more glow left: that IS the anti-strobe behaviour,
    // not merely a flag being copied around.
    const plain = setup()
    const a = createGraphPulse()
    a.start(graph, {})
    a.noteOn('KeyA')
    plain.ctx.currentTime += 0.5
    const normal = a.intensityFor('a')
    a.stop()
    plain.restore()

    const gentle = setup({ reduced: true })
    const b = createGraphPulse()
    b.start(graph, {})
    expect(b.reduced).toBe(true)
    b.noteOn('KeyA')
    gentle.ctx.currentTime += 0.5
    const reduced = b.intensityFor('a')
    b.stop()

    expect(reduced).toBeGreaterThan(normal * 2)
  })

  it('follows the setting when it changes mid-run', () => {
    const { motion } = setup({ reduced: false })
    const engine = createGraphPulse()
    engine.start(graph, {})
    expect(engine.reduced).toBe(false)

    motion.set(true) // the user turns "reduce motion" on without leaving the mode
    expect(engine.reduced).toBe(true)
    engine.stop()
  })
})

describe('graphPulse — the medley clock', () => {
  it('queues the next cycle ahead of time, with room for the riser', () => {
    vi.useFakeTimers()
    const { ctx } = setup()
    const engine = createGraphPulse()
    engine.start(graph, {})
    const firstCycle = ctx.started
    expect(firstCycle).toBeGreaterThan(0) // a whole cycle was scheduled up front

    // Nothing more is queued until the cycle nears its end.
    vi.advanceTimersByTime(REQUEUE_POLL_MS * 2)
    expect(ctx.started).toBe(firstCycle)

    // Jump the audio clock to just inside the lookahead window.
    ctx.currentTime += 200
    vi.advanceTimersByTime(REQUEUE_POLL_MS)
    expect(ctx.started).toBeGreaterThan(firstCycle) // the next cycle is on its way
    engine.stop()
    vi.useRealTimers()
  })

  it('leaves the riser room to sweep into the loop seam', () => {
    // The riser is scheduled only when its full length fits before the downbeat, so
    // a lookahead shorter than the riser means the seam is never smoothed. Assert
    // the behaviour, not just the constants: after a re-queue, something must start
    // a riser's length before the new cycle's downbeat.
    expect(REQUEUE_LEAD_SEC).toBeGreaterThan(RISER_SEC + REQUEUE_POLL_MS / 1000)

    vi.useFakeTimers()
    const { ctx } = setup()
    const engine = createGraphPulse()
    engine.start(graph, {})
    const beforeRequeue = ctx.startTimes.length

    // Land the audio clock deep inside the re-queue window — comfortably after the
    // lookahead opens and well before the riser would run out of room — then let one
    // poll fire. A fixed point (not a stepped loop racing the fake timer against the
    // audio clock) keeps this deterministic. The window is (nextAt−LEAD, nextAt−RISER):
    // the first cycle is 64 bars × 4 beats × (60/130) ≈ 118s, so 115 sits inside it
    // with margin on both sides, and the exact value is not load-bearing.
    ctx.currentTime = 115
    vi.advanceTimersByTime(REQUEUE_POLL_MS)

    const queued = ctx.startTimes.slice(beforeRequeue)
    expect(queued.length).toBeGreaterThan(0) // a re-queue really happened

    // The riser is the earliest thing in the new cycle, and it starts exactly a
    // riser's length before the downbeat — so the two earliest start times are that
    // far apart. Without the room, everything would begin on the downbeat together.
    const times = [...new Set(queued)].sort((a, b) => a - b)
    expect(times[1] - times[0]).toBeCloseTo(RISER_SEC, 2)
    engine.stop()
  })

  it('restores the mix to full even when toggled again mid-fade', () => {
    // The bug this guards: reading the level to restore off the LIVE gain. Mid-ramp
    // that reads as the ducked value, so a second toggle inside the first fade
    // restores the mix into its own attenuation — repeat a few times and the mode
    // plays on in silence, with no way back short of leaving and re-entering.
    const { ctx } = setup()
    const engine = createGraphPulse()
    engine.start(graph, {})
    const out = ctx.gains[0]

    engine.toggleMelody() // duck #1
    out.gain.value = 0.01 // the automation is partway down when the next one lands
    engine.toggleMelody() // melody back on
    engine.toggleMelody() // duck #2, inside the first fade

    // One restore per duck, each aimed at the nominal level — not at whatever the
    // gain happened to read when the second one started.
    const restores = out.gain.ops.filter((o) => o.op === 'ramp' && o.value === MIX_LEVEL)
    expect(restores).toHaveLength(2)
    engine.stop()
  })

  it('never schedules a cycle into the past, however long the tab slept', () => {
    vi.useFakeTimers()
    const { ctx } = setup()
    const engine = createGraphPulse()
    engine.start(graph, {})
    const before = ctx.startTimes.length

    // The audio clock keeps running while a hidden tab freezes rAF and throttles
    // timers: by the time the re-queue fires, the previous cycle may be long over.
    ctx.currentTime += 100_000
    vi.advanceTimersByTime(REQUEUE_POLL_MS)

    const queued = ctx.startTimes.slice(before)
    expect(queued.length).toBeGreaterThan(0)
    // Without the clamp the whole cycle lands in the past — which the audio engine
    // renders as every voice firing at once.
    expect(Math.min(...queued)).toBeGreaterThanOrEqual(ctx.currentTime)
    engine.stop()
    vi.useRealTimers()
  })

  it('stops the clock when the mode exits', () => {
    vi.useFakeTimers()
    const { ctx } = setup()
    const engine = createGraphPulse()
    engine.start(graph, {})
    expect(vi.getTimerCount()).toBe(1) // the re-queue poll is running

    engine.stop()
    const after = ctx.started
    ctx.currentTime += 500
    // Long enough for the one-shot that closes the context to fire and retire.
    vi.advanceTimersByTime(1000)
    // What must NOT survive is the repeating poll: starved of work or not, a zombie
    // interval ticks for the life of the page and holds the engine closure alive.
    expect(vi.getTimerCount()).toBe(0)
    expect(ctx.started).toBe(after) // and nothing schedules music after the exit
    vi.useRealTimers()
  })

  it('silences the tune on toggle — including the cycle still sounding', () => {
    vi.useFakeTimers()
    const { ctx } = setup()
    const engine = createGraphPulse()
    engine.start(graph, {})

    const firstCycle = ctx.started
    // Re-queue once, so there are two generations of voices in flight: the cycle
    // playing out and the one just queued.
    ctx.currentTime += 200
    vi.advanceTimersByTime(REQUEUE_POLL_MS)
    const queued = ctx.started - firstCycle
    expect(queued).toBeGreaterThan(0)

    engine.toggleMelody() // Space: melody off, piano stays live
    // Cutting short means a SECOND stop() on a source (each is scheduled with its
    // natural one at creation). Silencing only the freshly queued cycle would leave
    // the one still sounding to play on — so the count has to exceed it.
    expect(ctx.cutShort).toBeGreaterThan(queued)
    expect(engine.active).toBe(true) // still in the mode

    // And the cut happens inside a fade, not on a live waveform: the output gain
    // is ramped to silence at or before the moment the voices are stopped.
    const out = ctx.gains[0]
    const rampDown = out.gain.ops.filter((o) => o.op === 'ramp' && o.value < 0.01)
    expect(rampDown.length).toBeGreaterThan(0)
    const cutAt = Math.max(...ctx.stopTimes)
    expect(Math.min(...rampDown.map((o) => o.at))).toBeLessThanOrEqual(cutAt)
    // …and it comes back to the nominal level, not to whatever it was mid-duck —
    // otherwise repeated toggles ratchet the mix down to silence.
    expect(out.gain.ops.some((o) => o.op === 'ramp' && o.value === MIX_LEVEL)).toBe(true)

    const before = ctx.started
    engine.toggleMelody() // and it can be started again
    expect(ctx.started).toBeGreaterThan(before)
    engine.stop()
    vi.useRealTimers()
  })
})
