import { describe, expect, it } from 'vitest'
import { mix, parseColor, toRgb } from './color'

const FALLBACK = { r: 1, g: 2, b: 3 }

describe('parseColor', () => {
  it('reads hex in both lengths and rgb()', () => {
    expect(parseColor('#ff8800', FALLBACK)).toEqual({ r: 255, g: 136, b: 0 })
    expect(parseColor('#f80', FALLBACK)).toEqual({ r: 255, g: 136, b: 0 })
    expect(parseColor('rgb(10, 20, 30)', FALLBACK)).toEqual({ r: 10, g: 20, b: 30 })
  })

  it('falls back on anything it cannot read', () => {
    expect(parseColor('var(--accent)', FALLBACK)).toEqual(FALLBACK)
    expect(parseColor('', FALLBACK)).toEqual(FALLBACK)
  })
})

describe('toRgb', () => {
  // The group palette is authored in HSL (see graphColors), so the glow pass can
  // only blend a node's own colour if this recovers channels from that form.
  it('converts the palette hsl form', () => {
    expect(toRgb('hsl(0, 100%, 50%)', FALLBACK)).toEqual({ r: 255, g: 0, b: 0 })
    expect(toRgb('hsl(120, 100%, 50%)', FALLBACK)).toEqual({ r: 0, g: 255, b: 0 })
    expect(toRgb('hsl(240, 100%, 50%)', FALLBACK)).toEqual({ r: 0, g: 0, b: 255 })
  })

  it('handles the palette values as actually emitted (rounded hue, 58-64% s/l)', () => {
    const c = toRgb('hsl(217, 60%, 64%)', FALLBACK)
    expect(c.r).toBeGreaterThanOrEqual(0)
    expect(c.b).toBeGreaterThan(c.r) // a blue hue stays blue-dominant
  })

  it('wraps hue and clamps the achromatic ends', () => {
    expect(toRgb('hsl(360, 100%, 50%)', FALLBACK)).toEqual(toRgb('hsl(0, 100%, 50%)', FALLBACK))
    expect(toRgb('hsl(200, 50%, 0%)', FALLBACK)).toEqual({ r: 0, g: 0, b: 0 })
    expect(toRgb('hsl(200, 50%, 100%)', FALLBACK)).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('still accepts the non-hsl colours the canvas also holds', () => {
    expect(toRgb('#ff8800', FALLBACK)).toEqual({ r: 255, g: 136, b: 0 })
    expect(toRgb('rgb(10, 20, 30)', FALLBACK)).toEqual({ r: 10, g: 20, b: 30 })
    expect(toRgb('nonsense', FALLBACK)).toEqual(FALLBACK)
  })
})

describe('mix', () => {
  it('interpolates and hits both ends exactly', () => {
    const a = { r: 0, g: 0, b: 0 }
    const b = { r: 100, g: 200, b: 40 }
    expect(mix(a, b, 0)).toEqual(a)
    expect(mix(a, b, 1)).toEqual(b)
    expect(mix(a, b, 0.5)).toEqual({ r: 50, g: 100, b: 20 })
  })
})
