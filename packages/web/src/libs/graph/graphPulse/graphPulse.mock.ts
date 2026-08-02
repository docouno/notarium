// A Web Audio stand-in for the unit layer: enough of the API for the engine to
// build its chain and schedule a cycle, and a clock the test drives by hand. The
// real thing needs a browser; what we assert here is the engine's CONTRACT (does
// it start, does it hand the keyboard back), not the sound.

/** One scheduled change on a gain/frequency parameter, recorded so a test can ask
 *  what the code actually automated (and when) rather than trusting that it did. */
export type ParamOp = { op: 'set' | 'ramp' | 'cancel'; value: number; at: number }

type Param = {
  value: number
  ops: ParamOp[]
  setValueAtTime: (v: number, t: number) => void
  exponentialRampToValueAtTime: (v: number, t: number) => void
  cancelScheduledValues: (t: number) => void
}

const param = (value = 0): Param => {
  const p: Param = {
    value,
    ops: [],
    setValueAtTime: (v, t) => {
      p.ops.push({ op: 'set', value: v, at: t })
    },
    exponentialRampToValueAtTime: (v, t) => {
      p.ops.push({ op: 'ramp', value: v, at: t })
    },
    cancelScheduledValues: (t) => {
      p.ops.push({ op: 'cancel', value: 0, at: t })
    },
  }

  return p
}

const node = () => ({ connect: () => {}, disconnect: () => {} })

export type FakeAudioContext = {
  currentTime: number
  sampleRate: number
  destination: object
  closed: boolean
  started: number
  /** Every stop() call, including the natural one each voice is scheduled with;
   *  a SECOND call on the same source is what "cut short" looks like. */
  stopped: number
  /** Sources stopped more than once — i.e. actually silenced ahead of their end. */
  cutShort: number
  /** Every scheduled start/stop time, so timing fixes are assertable and not just
   *  countable: a cycle queued into the past, or a riser with no room, shows here. */
  startTimes: number[]
  stopTimes: number[]
  /** The gains handed out, newest last — `gains[0]` is the output node. */
  gains: { gain: Param; connect: () => void; disconnect: () => void }[]
  createGain: () => { gain: Param; connect: () => void; disconnect: () => void }
  createBiquadFilter: () => object
  createDelay: () => object
  createOscillator: () => object
  createBufferSource: () => object
  createBuffer: (ch: number, len: number) => { getChannelData: () => Float32Array }
  resume: () => Promise<void>
  close: () => Promise<void>
}

export const createFakeAudioContext = (): FakeAudioContext => {
  const ctx: FakeAudioContext = {
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    closed: false,
    started: 0,
    stopped: 0,
    cutShort: 0,
    startTimes: [],
    stopTimes: [],
    gains: [],
    createGain: () => {
      const g = { gain: param(1), ...node() }
      ctx.gains.push(g)

      return g
    },
    createBiquadFilter: () => ({ type: '', frequency: param(1000), Q: param(1), ...node() }),
    createDelay: () => ({ delayTime: param(0), ...node() }),
    createOscillator: () => {
      let stops = 0

      return {
        type: '',
        frequency: param(440),
        detune: param(0),
        ...node(),
        start: (t = ctx.currentTime) => {
          ctx.started++
          ctx.startTimes.push(t)
        },
        stop: (t = ctx.currentTime) => {
          ctx.stopped++
          ctx.stopTimes.push(t)
          stops++

          if (stops > 1) {
            ctx.cutShort++
          }
        },
      }
    },
    createBufferSource: () => {
      let stops = 0

      return {
        buffer: null,
        loop: false,
        ...node(),
        start: (t = ctx.currentTime) => {
          ctx.started++
          ctx.startTimes.push(t)
        },
        stop: (t = ctx.currentTime) => {
          ctx.stopped++
          ctx.stopTimes.push(t)
          stops++

          if (stops > 1) {
            ctx.cutShort++
          }
        },
      }
    },
    createBuffer: (_ch: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
    resume: () => Promise.resolve(),
    close: () => {
      ctx.closed = true

      return Promise.resolve()
    },
  }

  return ctx
}

/** A prefers-reduced-motion query the test can flip, and which counts its own
 *  listeners — so "the engine unsubscribes on every exit" is assertable. */
export type FakeMotionQuery = {
  matches: boolean
  listeners: number
  /** Flip the setting the way an OS toggle would, mid-run. */
  set: (on: boolean) => void
  addEventListener: (type: string, fn: (e: { matches: boolean }) => void) => void
  removeEventListener: (type: string, fn: (e: { matches: boolean }) => void) => void
}

const createMotionQuery = (reduced: boolean): FakeMotionQuery => {
  const fns = new Set<(e: { matches: boolean }) => void>()
  const q: FakeMotionQuery = {
    matches: reduced,
    get listeners() {
      return fns.size
    },
    set: (on: boolean) => {
      q.matches = on
      fns.forEach((fn) => fn({ matches: on }))
    },
    addEventListener: (_type, fn) => {
      fns.add(fn)
    },
    removeEventListener: (_type, fn) => {
      fns.delete(fn)
    },
  } as FakeMotionQuery

  return q
}

/** Install a browser-ish global for one test: a fake AudioContext, a flippable
 *  prefers-reduced-motion query, and animation-frame stubs. Returns both handles and
 *  a restore function. Pass `audio: false` for a browser without Web Audio. */
export const installAudioEnv = ({
  audio = true,
  reduced = false,
}: { audio?: boolean; reduced?: boolean } = {}): {
  ctx: FakeAudioContext | null
  motion: FakeMotionQuery
  restore: () => void
} => {
  const ctx = audio ? createFakeAudioContext() : null
  const motion = createMotionQuery(reduced)
  const prevWindow = (globalThis as { window?: unknown }).window
  const prevRaf = globalThis.requestAnimationFrame
  const prevCancel = globalThis.cancelAnimationFrame

  // Constructible on purpose: the engine does `new Ctor()`, which an arrow
  // function cannot satisfy (TypeError: not a constructor).
  class AudioContextStub {
    constructor() {
      return ctx as unknown as AudioContextStub
    }
  }

  ;(globalThis as { window?: unknown }).window = {
    AudioContext: audio ? AudioContextStub : undefined,
    matchMedia: () => motion,
  }
  globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame

  return {
    ctx,
    motion,
    restore: () => {
      ;(globalThis as { window?: unknown }).window = prevWindow
      globalThis.requestAnimationFrame = prevRaf
      globalThis.cancelAnimationFrame = prevCancel
    },
  }
}
