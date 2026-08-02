import type { NoteName } from '../../types'

// Note names ↔ MIDI numbers ↔ frequencies. Scientific pitch notation throughout
// ("C4" = middle C = MIDI 60), so the score reads like sheet music and every
// transposition is plain integer arithmetic on semitones.
const SEMI: Record<string, number> = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11,
}
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const midiOf = (name: NoteName): number =>
  SEMI[name.slice(0, -1)] + (Number(name.slice(-1)) + 1) * 12

const nameOfMidi = (m: number): NoteName => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1)

export const transpose = (name: NoteName, semis: number): NoteName =>
  nameOfMidi(midiOf(name) + semis)

// Equal temperament off A4 = 440 Hz (MIDI 69).
export const freqOf = (name: NoteName): number => 440 * Math.pow(2, (midiOf(name) - 69) / 12)
