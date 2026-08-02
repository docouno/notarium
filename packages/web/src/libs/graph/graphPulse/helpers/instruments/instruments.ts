import type { NoteName, PulseBus, PulseVoice } from '../../types'
import { freqOf } from '../pitch'

// Every instrument returns the source nodes it started, so a tune can be cut off
// cleanly (stop() on each) when the mode ends or the melody is toggled off.
type Sources = AudioScheduledSourceNode[]

// One warm note: a triangle lead doubled with a sine an octave down for body,
// both fed through the shared vibrato. The fixed-length melody voice.
export const voice = (bus: PulseBus, name: NoteName, s: number, dur: number): Sources => {
  const { ctx } = bus

  const mk = (type: OscillatorType, freq: number, detune: number, level: number) => {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    o.detune.value = detune
    bus.lfoDepth.connect(o.detune)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, s)
    g.gain.exponentialRampToValueAtTime(level, s + 0.025) // soft attack
    g.gain.exponentialRampToValueAtTime(0.0001, s + dur + 0.18) // long, lampy release
    o.connect(g)
    g.connect(bus.master)
    o.start(s)
    o.stop(s + dur + 0.25)

    return o
  }
  const freq = freqOf(name)

  return [mk('triangle', freq, +4, 0.85), mk('sine', freq / 2, -4, 0.6)]
}

// A sustaining version of `voice`: attack then HOLD (no scheduled decay) — the
// oscillators run until releaseVoice. Returns the osc/gain pairs so the release
// can fade them. Separate from `voice` so the melody's timing is untouched.
export const startVoice = (bus: PulseBus, name: NoteName): PulseVoice[] => {
  const { ctx } = bus
  const s = ctx.currentTime

  const mk = (type: OscillatorType, freq: number, detune: number, level: number): PulseVoice => {
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.value = freq
    osc.detune.value = detune
    bus.lfoDepth.connect(osc.detune)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, s)
    gain.gain.exponentialRampToValueAtTime(level, s + 0.02) // attack, then hold
    osc.connect(gain)
    gain.connect(bus.master)
    osc.start(s)

    return { osc, gain }
  }
  const freq = freqOf(name)

  return [mk('triangle', freq, +4, 0.85), mk('sine', freq / 2, -4, 0.6)]
}

// Let a held note go: a quick fade, then stop. Tolerant of an already-stopped
// voice (a lost keyup can release the same key twice).
export const releaseVoice = (ctx: AudioContext, voices: readonly PulseVoice[]): void => {
  const r = ctx.currentTime

  for (const { osc, gain } of voices) {
    try {
      gain.gain.cancelScheduledValues(r)
      gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), r)
      gain.gain.exponentialRampToValueAtTime(0.0001, r + 0.22)
      osc.stop(r + 0.28)
    } catch {
      /* already stopped */
    }
  }
}

// Triangle bass — the NES-style low end. Punchy, no vibrato, drier than the lead.
export const bass = (bus: PulseBus, name: NoteName, s: number, dur: number): Sources => {
  const { ctx } = bus
  const o = ctx.createOscillator()
  o.type = 'triangle'
  o.frequency.value = freqOf(name)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, s)
  g.gain.exponentialRampToValueAtTime(0.55, s + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur)
  o.connect(g)
  g.connect(bus.master)
  o.start(s)
  o.stop(s + dur + 0.04)

  return [o]
}

// A soft sine pad holding the bar's root for warmth/body underneath the lead.
export const pad = (bus: PulseBus, name: NoteName, s: number, dur: number): Sources => {
  const { ctx } = bus
  const o = ctx.createOscillator()
  o.type = 'sine'
  o.frequency.value = freqOf(name)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, s)
  g.gain.exponentialRampToValueAtTime(0.12, s + 0.08)
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur)
  o.connect(g)
  g.connect(bus.master)
  o.start(s)
  o.stop(s + dur + 0.05)

  return [o]
}

// Sub bass — a clean low sine, smooth attack and sustain; the foundation of the
// lo-fi arrangement.
export const sub = (bus: PulseBus, name: NoteName, s: number, dur: number): Sources => {
  const { ctx } = bus
  const o = ctx.createOscillator()
  o.type = 'sine'
  o.frequency.value = freqOf(name)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, s)
  g.gain.exponentialRampToValueAtTime(0.5, s + 0.04)
  g.gain.setValueAtTime(0.5, s + dur * 0.7)
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur)
  o.connect(g)
  g.connect(bus.master)
  o.start(s)
  o.stop(s + dur + 0.05)

  return [o]
}

// 808 — a heavy triangle sub with a quick downward pitch glide and long decay,
// the backbone of the trap arrangement. Triangle (not sine) so its harmonics stay
// audible even when the fundamental is deep sub-bass.
export const boom808 = (bus: PulseBus, name: NoteName, s: number, dur: number): Sources => {
  const { ctx } = bus
  const o = ctx.createOscillator()
  o.type = 'triangle'
  const f = freqOf(name)
  o.frequency.setValueAtTime(f * 1.5, s) // glide down into the note
  o.frequency.exponentialRampToValueAtTime(f, s + 0.08)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, s)
  g.gain.exponentialRampToValueAtTime(0.85, s + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur)
  o.connect(g)
  g.connect(bus.master)
  o.start(s)
  o.stop(s + dur + 0.05)

  return [o]
}

// Kick — a quick pitch-dropping sine thump on the percussion bus.
export const kick = (bus: PulseBus, s: number): Sources => {
  const { ctx } = bus
  const o = ctx.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(140, s)
  o.frequency.exponentialRampToValueAtTime(45, s + 0.11)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.9, s)
  g.gain.exponentialRampToValueAtTime(0.0001, s + 0.16)
  o.connect(g)
  g.connect(bus.perc)
  o.start(s)
  o.stop(s + 0.18)

  return [o]
}

// A noise burst on the percussion bus — the base of hats/snare. `hz`/`decay`
// shape it: high + short = closed hat, lower + longer = open hat / snare.
const burst = (
  bus: PulseBus,
  s: number,
  level: number,
  hz: number,
  decay: number,
  type: BiquadFilterType = 'highpass',
  q = 0.7,
): Sources => {
  const { ctx } = bus
  const src = ctx.createBufferSource()
  src.buffer = bus.noise()
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = hz
  f.Q.value = q
  const g = ctx.createGain()
  g.gain.setValueAtTime(level, s)
  g.gain.exponentialRampToValueAtTime(0.0001, s + decay)
  src.connect(f)
  f.connect(g)
  g.connect(bus.perc)
  src.start(s)
  src.stop(s + decay + 0.02)

  return [src]
}

export const hat = (bus: PulseBus, s: number, level: number): Sources =>
  burst(bus, s, level, 7000, 0.05)

export const openHat = (bus: PulseBus, s: number, level: number): Sources =>
  burst(bus, s, level, 6000, 0.22)

export const snare = (bus: PulseBus, s: number): Sources =>
  burst(bus, s, 0.5, 1800, 0.16, 'bandpass', 0.8)

// A crescendoing burst of hats — the turnaround fill (and the trap "rrr" roll).
export const hatRoll = (
  bus: PulseBus,
  start: number,
  span: number,
  n: number,
  level: number,
): Sources => {
  const out: Sources = []
  const step = span / n

  for (let i = 0; i < n; i++) {
    out.push(...hat(bus, start + i * step, level * (0.55 + (0.45 * i) / n)))
  }

  return out
}

// A riser that crescendos into `end` — a noise band sweeping up in pitch and
// volume, dropping right on the downbeat. Used between medley segments to smooth
// the cut (and mask the key change) instead of a hard transition.
export const riser = (bus: PulseBus, end: number, dur: number): Sources => {
  const { ctx } = bus
  const s = end - dur
  const src = ctx.createBufferSource()
  src.buffer = bus.noise()
  src.loop = true
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.Q.value = 1.1
  bp.frequency.setValueAtTime(400, s)
  bp.frequency.exponentialRampToValueAtTime(6500, end) // sweep up
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, s)
  g.gain.exponentialRampToValueAtTime(0.13, end) // swell to the hit
  g.gain.exponentialRampToValueAtTime(0.0001, end + 0.14) // then drop into the groove
  src.connect(bp)
  bp.connect(g)
  g.connect(bus.perc)
  src.start(s)
  src.stop(end + 0.16)

  return [src]
}
