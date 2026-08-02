import type { NoteName, PulseBus, PulseStyle } from '../../types'
import { bass, boom808, hat, hatRoll, kick, openHat, pad, snare, sub } from '../instruments'
import { transpose } from '../pitch'

type BarContext = {
  // Start of the bar on the audio clock.
  t: number
  // Seconds per beat.
  spb: number
  // Beats in a bar.
  beats: number
  // The bar's (already transposed) chord root, in the bass octave.
  root: NoteName
  // False on the bare-lead intro pass: bass only, so the lead breathes.
  full: boolean
  // Bar index within the segment — drives the every-fourth-bar fill.
  index: number
}

// Schedule one bar of the rhythm section for the given style. Returns the source
// nodes it started so the caller can cut the tune off cleanly.
export const groove = (
  bus: PulseBus,
  style: PulseStyle,
  { t, spb, beats, root, full, index }: BarContext,
): AudioScheduledSourceNode[] => {
  const out: AudioScheduledSourceNode[] = []
  const push = (v: AudioScheduledSourceNode[]) => out.push(...v)
  const rootUp = transpose(root, 12)
  const low = transpose(root, -12)

  if (style === 'lofi') {
    // Laid-back boom-bap: warm sub + pad, kick/snare backbeat, soft swung hats.
    push(sub(bus, low, t, beats * spb * 0.95))

    if (!full) {
      return out
    }
    push(pad(bus, rootUp, t, beats * spb * 0.98))
    push(kick(bus, t))
    push(kick(bus, t + 2.5 * spb))
    push(snare(bus, t + 1 * spb))
    push(snare(bus, t + 3 * spb))

    for (let e = 0; e < beats * 2; e++) {
      const swing = e % 2 ? 0.06 : 0 // nudge offbeats late for the lazy feel
      push(hat(bus, t + (e * 0.5 + swing) * spb, e % 2 ? 0.05 : 0.07))
    }

    return out
  }

  if (style === 'trap') {
    // Dark, heavy half-time trap: a deep gliding 808 on the (already low) root,
    // hard kick + clap on the half-time backbeat, sparse hats with rolls (the
    // trap "rrr"). Sparse and ominous — no pad, no rock bass.
    if (!full) {
      push(sub(bus, low, t, beats * spb * 0.95))

      return out
    }
    push(boom808(bus, root, t, 1.6 * spb))
    push(boom808(bus, root, t + 2.5 * spb, 1.3 * spb))
    push(kick(bus, t))
    push(kick(bus, t + 2.5 * spb))
    push(snare(bus, t + 2 * spb)) // clap on beat 3 (half-time)

    for (let e = 0; e < beats * 2; e++) {
      push(hat(bus, t + e * 0.5 * spb, 0.045))
    }
    push(hatRoll(bus, t + 1.5 * spb, 0.5 * spb, 3, 0.06))
    push(hatRoll(bus, t + 3.5 * spb, 0.5 * spb, 6, 0.07))

    if (index % 4 === 3) {
      push(hatRoll(bus, t + 3 * spb, spb, 8, 0.08))
    }

    return out
  }

  // 'band' — the rock kit. The intro (lead-only) pass stays clean: just a warm
  // sustained sub under the lead, no percussive bass, so the suspense builds
  // without the tapping (matching the lo-fi intro). The full pass then brings in
  // the octave-bouncing eighth bass, pad, backbeat snare, accented hats (open hat
  // at the turnaround) and a fill every fourth bar.
  if (!full) {
    push(sub(bus, low, t, beats * spb * 0.95))

    return out
  }

  for (let e = 0; e < beats * 2; e++) {
    push(bass(bus, e % 2 ? rootUp : root, t + e * 0.5 * spb, 0.5 * spb * 0.85))
  }
  push(pad(bus, rootUp, t, beats * spb * 0.98))
  push(kick(bus, t))
  push(kick(bus, t + 2 * spb))
  push(snare(bus, t + 1 * spb))
  push(snare(bus, t + 3 * spb))

  for (let e = 0; e < beats * 2; e++) {
    const ht = t + e * 0.5 * spb

    if (e === 7) {
      push(openHat(bus, ht, 0.13))
    } else {
      push(hat(bus, ht, e % 2 === 0 ? 0.15 : 0.08))
    }
  }

  if (index % 4 === 3) {
    push(hatRoll(bus, t + 3 * spb, spb, 4, 0.13))
  }

  return out
}
