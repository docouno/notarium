import { describe, expect, it } from 'vitest'
import { freqOf, midiOf, transpose } from './pitch'

describe('pitch', () => {
  it('maps scientific pitch to MIDI numbers', () => {
    expect(midiOf('C4')).toBe(60) // middle C, the anchor everything else is checked against
    expect(midiOf('A4')).toBe(69)
    expect(midiOf('C#4')).toBe(61)
    expect(midiOf('B3')).toBe(59)
    expect(midiOf('A1')).toBe(33) // the score's lowest bass root
  })

  it('tunes A4 to 440 Hz and keeps octaves exactly double', () => {
    expect(freqOf('A4')).toBeCloseTo(440, 6)
    expect(freqOf('A5')).toBeCloseTo(880, 6)
    expect(freqOf('A3')).toBeCloseTo(220, 6)
    // Equal temperament: a semitone is the twelfth root of two.
    expect(freqOf('A#4') / freqOf('A4')).toBeCloseTo(Math.pow(2, 1 / 12), 9)
  })

  it('transposes across octave and enharmonic boundaries', () => {
    expect(transpose('C4', 12)).toBe('C5')
    expect(transpose('C4', -12)).toBe('C3')
    expect(transpose('B4', 1)).toBe('C5') // over the octave line
    expect(transpose('C4', -1)).toBe('B3') // and back under it
    expect(transpose('G#4', -5)).toBe('D#4') // the trap segment's transposition
    expect(transpose('A1', 5)).toBe('D2') // a bass root up a fourth (lo-fi segment)
  })

  it('survives the extremes the octave shift can reach', () => {
    // The piano spans C4..A5 and Z/X shift it +-3 octaves: nothing in that range
    // may produce a malformed name (which would silently NaN the frequency).
    for (const base of ['C4', 'A5']) {
      for (let oct = -3; oct <= 3; oct++) {
        const name = transpose(base, oct * 12)
        expect(name).toMatch(/^[A-G]#?-?\d+$/)
        expect(Number.isFinite(freqOf(name))).toBe(true)
        expect(freqOf(name)).toBeGreaterThan(0)
      }
    }
  })

  it('round-trips a transposition', () => {
    expect(transpose(transpose('E5', -5), 5)).toBe('E5')
  })
})
