import type { PulseSegment, ScoreBar } from './types'

// Glow decay time-constant (s) — punchy, so mostly one strike is lit at a time.
export const GLOW_TAU = 0.28

// The nominal level of the output node every voice passes through. It is the ONE
// place the mix level is stated: the exit fade and the melody-toggle duck both
// restore to it rather than to whatever the gain happens to read mid-ramp.
export const MIX_LEVEL = 1

// The same decay under prefers-reduced-motion: several times longer, so strikes
// overlap into a slow swell instead of a strobe.
export const REDUCED_GLOW_TAU = 1.6

// A riser sweeps into every downbeat that has room in front of it.
export const RISER_SEC = 1.4
// How far ahead of the current cycle's end the next one is queued. It MUST exceed
// RISER_SEC by more than one poll interval, or the riser at the loop seam has no
// room to start and every repeat of the medley begins on a hard cut. The margin
// covers a backgrounded tab, where the poll itself is throttled to about a second.
export const REQUEUE_LEAD_SEC = 3.5
// How often the re-queue check runs. Background tabs throttle timers to ~1s, which
// still leaves the lookahead above plenty of margin.
export const REQUEUE_POLL_MS = 250

// The GarageBand "Musical Typing" layout, keyed by KeyboardEvent.code (the
// PHYSICAL key, not .key — so it plays the same in any keyboard layout, Cyrillic
// included). Home row = white keys, the row above = the black keys that exist
// (E–F and B–C have none, hence the gaps); the comma/period/slash extend a few
// notes higher. Z / X shift the whole keyboard an octave down / up, so the full
// range is reachable from one familiar hand position.
//   w e   t y u   o p
//  a s d f g h j k l ;  , . /
export const KEYMAP: Record<string, string> = {
  // white keys (home row) + black keys (row above)
  KeyA: 'C4',
  KeyW: 'C#4',
  KeyS: 'D4',
  KeyE: 'D#4',
  KeyD: 'E4',
  KeyF: 'F4',
  KeyT: 'F#4',
  KeyG: 'G4',
  KeyY: 'G#4',
  KeyH: 'A4',
  KeyU: 'A#4',
  KeyJ: 'B4',
  KeyK: 'C5',
  KeyO: 'C#5',
  KeyL: 'D5',
  KeyP: 'D#5',
  Semicolon: 'E5',
  // a few keys reaching up high
  Comma: 'F5',
  Period: 'G5',
  Slash: 'A5',
}

// Korobeiniki (Tetris) — the shared score for all three arrangements. Full theme:
// part A (bars 1–8) + the lower part-B bridge (bars 9–16). Each bar is 4 beats;
// `root` is the bar's bass/chord root (low octave).
export const KOROBEINIKI: readonly ScoreBar[] = [
  {
    lead: [
      ['E5', 1],
      ['B4', 0.5],
      ['C5', 0.5],
      ['D5', 1],
      ['C5', 0.5],
      ['B4', 0.5],
    ],
    root: 'E2',
  },
  {
    lead: [
      ['A4', 1],
      ['A4', 0.5],
      ['C5', 0.5],
      ['E5', 1],
      ['D5', 0.5],
      ['C5', 0.5],
    ],
    root: 'A1',
  },
  {
    lead: [
      ['B4', 1.5],
      ['C5', 0.5],
      ['D5', 1],
      ['E5', 1],
    ],
    root: 'E2',
  },
  {
    lead: [
      ['C5', 1],
      ['A4', 1],
      ['A4', 1],
      [null, 1],
    ],
    root: 'A1',
  },
  {
    lead: [
      [null, 0.5],
      ['D5', 1],
      ['F5', 0.5],
      ['A5', 1],
      ['G5', 0.5],
      ['F5', 0.5],
    ],
    root: 'D2',
  },
  {
    lead: [
      ['E5', 1.5],
      ['C5', 0.5],
      ['E5', 1],
      ['D5', 0.5],
      ['C5', 0.5],
    ],
    root: 'C2',
  },
  {
    lead: [
      ['B4', 1],
      ['B4', 0.5],
      ['C5', 0.5],
      ['D5', 1],
      ['E5', 1],
    ],
    root: 'E2',
  },
  {
    lead: [
      ['C5', 1],
      ['A4', 1],
      ['A4', 1],
      [null, 1],
    ],
    root: 'A1',
  },
  {
    lead: [
      ['E5', 2],
      ['C5', 2],
    ],
    root: 'A1',
  },
  {
    lead: [
      ['D5', 2],
      ['B4', 2],
    ],
    root: 'G1',
  },
  {
    lead: [
      ['C5', 2],
      ['A4', 2],
    ],
    root: 'A1',
  },
  {
    lead: [
      ['G#4', 2],
      ['B4', 2],
    ],
    root: 'E2',
  },
  {
    lead: [
      ['E5', 2],
      ['C5', 2],
    ],
    root: 'A1',
  },
  {
    lead: [
      ['D5', 2],
      ['B4', 2],
    ],
    root: 'G1',
  },
  {
    lead: [
      ['C5', 1],
      ['E5', 1],
      ['A5', 1],
      ['A5', 1],
    ],
    root: 'A1',
  },
  {
    lead: [
      ['G#4', 2],
      [null, 2],
    ],
    root: 'E2',
  },
]

// The looping medley: the same Korobeiniki theme through three arrangements, each
// in its own key, chained seamlessly and repeated forever. `semis` transposes the
// segment so the loop wanders through keys. Segments share one tempo so the lead
// never lurches — the contrast lives in the drums and the key, not the speed. A
// riser sweeps between them to smooth the cut; only the first segment plays the
// bare-lead intro (the build-up), and on every loop after that it's groove-only.
export const MEDLEY: readonly PulseSegment[] = [
  { style: 'band', bpm: 130, semis: 0, intro: true }, // the entry — rock kit
  { style: 'lofi', bpm: 130, semis: 5, intro: false }, // up a fourth, laid-back boom-bap
  { style: 'trap', bpm: 130, semis: -5, intro: false }, // down a fourth, dark/heavy trap
]

// Beats per bar — the whole score is in 4/4.
export const BEATS_PER_BAR = 4
