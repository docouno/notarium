import { MIX_LEVEL } from '../../consts'
import type { PulseBus } from '../../types'

// The persistent tone chain, built once and shared by every note: a low-pass to
// round off the digital edge, a slow shared vibrato, and a soft feedback echo for
// air. Quiet (master ≈ 0.15) so it's a wink, not a blast.
//   voices → master → low-pass ┬───────────────────────┐
//                              └→ delay ⇄ feedback → wet ┼→ out → destination
//   percussion ────────────────────────────────────────┘
// Percussion skips the low-pass so kicks and hats stay crisp, but it still lands on
// `out` — the single node the whole mix passes through, which is what lets the exit
// fade take the drums with it instead of cutting them off mid-hit.
// Returns null where the Web Audio API isn't available (or refuses to build one) —
// the caller then simply doesn't start.
export const createBus = (): PulseBus | null => {
  const Ctor =
    window.AudioContext ||
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  if (!Ctor) {
    return null
  }
  let ctx: AudioContext

  try {
    ctx = new Ctor()
  } catch {
    return null // e.g. too many live contexts, or a hostile embedding
  }
  // Autoplay policy: without a user gesture the context comes up suspended. Ours
  // opens from a keystroke, so this normally resolves at once. Wrapped because a
  // rejected resume() must not surface as an unhandled rejection — and because the
  // legacy WebKit resume() returns undefined, which has no .catch to hang one on.
  try {
    void Promise.resolve(ctx.resume?.()).catch(() => {})
  } catch {
    /* a resume() that throws outright is not worth failing the whole mode over */
  }

  const out = ctx.createGain()
  out.gain.value = MIX_LEVEL
  out.connect(ctx.destination)

  const master = ctx.createGain()
  master.gain.value = 0.15
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 2000
  lp.Q.value = 0.5
  master.connect(lp)
  lp.connect(out)

  const delay = ctx.createDelay(0.6)
  delay.delayTime.value = 0.22
  const feedback = ctx.createGain()
  feedback.gain.value = 0.26
  const wet = ctx.createGain()
  wet.gain.value = 0.16
  lp.connect(delay)
  delay.connect(feedback)
  feedback.connect(delay)
  delay.connect(wet)
  wet.connect(out)

  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 5.2
  const lfoDepth = ctx.createGain()
  lfoDepth.gain.value = 6 // cents of vibrato
  lfo.connect(lfoDepth)
  lfo.start()

  const perc = ctx.createGain()
  perc.gain.value = 0.5
  perc.connect(out)

  // One white-noise buffer behind every hat, snare and riser — built on first use.
  let noiseBuf: AudioBuffer | null = null

  const noise = () => {
    if (!noiseBuf) {
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.3), ctx.sampleRate)
      const d = buf.getChannelData(0)

      for (let i = 0; i < d.length; i++) {
        d[i] = Math.random() * 2 - 1
      }
      noiseBuf = buf
    }

    return noiseBuf
  }

  return { ctx, master, perc, out, lfoDepth, noise }
}

// Duck the whole mix to silence and bring it back, returning the moment at which
// sources can be stopped without a click. Cutting an oscillator mid-cycle snaps the
// waveform to zero, which is exactly what a click IS — so the tune is faded first
// and killed inside the silence.
export const duckOut = (bus: PulseBus, fade = 0.06): number => {
  const { ctx, out } = bus
  const now = ctx.currentTime
  // Duck FROM wherever the ramp currently is (so a second duck inside the first
  // doesn't jump), but always back TO the nominal level. Reading the level to
  // restore off `gain.value` looks equivalent and isn't: mid-automation that
  // getter returns the ducked value, so two quick toggles would restore the mix
  // into its own attenuation and, a couple of repeats later, into silence — with
  // the mode still "playing".
  const from = Math.max(0.0001, out.gain.value)

  try {
    out.gain.cancelScheduledValues(now)
    out.gain.setValueAtTime(from, now)
    out.gain.exponentialRampToValueAtTime(0.0001, now + fade)
    // Back up once the silence has swallowed the cut, so whatever plays next (the
    // piano, or the tune started again) is at full level.
    out.gain.setValueAtTime(0.0001, now + fade + 0.02)
    out.gain.exponentialRampToValueAtTime(MIX_LEVEL, now + fade + 0.1)
  } catch {
    /* already torn down */
  }

  return now + fade
}

// Fade the whole mix out and close the context a beat later, so stopping never
// clicks. The fade is on `out` rather than `master`, so the drums — which bypass
// master — go quiet with everything else instead of playing on for another 220ms
// and then being cut mid-hit by ctx.close(). Tolerant of a context already torn down.
export const closeBus = (bus: PulseBus): void => {
  const { ctx, out } = bus

  try {
    out.gain.cancelScheduledValues(ctx.currentTime)
    out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), ctx.currentTime)
    out.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18)
  } catch {
    /* already torn down */
  }
  setTimeout(() => {
    try {
      ctx.close()
    } catch {
      /* already closed */
    }
  }, 220)
}
