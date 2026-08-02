import type { Rgb } from '../../types'

// Linear blend between two {r,g,b} colours.
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: Math.round(a.r + (b.r - a.r) * t),
  g: Math.round(a.g + (b.g - a.g) * t),
  b: Math.round(a.b + (b.b - a.b) * t),
})

// hsl(h, s%, l%) → {r,g,b}. Group palettes (graphColors) are authored in HSL, so
// recovering a node's own colour as channels needs this.
const hslToRgb = (h: number, s: number, l: number): Rgb => {
  const hue = (((h % 360) + 360) % 360) / 360

  const f = (n: number) => {
    const k = (n + hue * 12) % 12

    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }

  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) }
}

// Any CSS colour a node can carry (hsl from the group palette, or the rgb/hex
// accent) → {r,g,b}, for the passes that blend a node's own colour by channel.
export const toRgb = (str: string, fallback: Rgb): Rgb => {
  const hsl = (str || '').match(/hsl\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i)

  if (hsl) {
    return hslToRgb(+hsl[1], +hsl[2] / 100, +hsl[3] / 100)
  }

  return parseColor(str, fallback)
}

// Parse the resolved --accent value (hex or rgb()) into {r,g,b}.
export const parseColor = (str: string, fallback: Rgb): Rgb => {
  const s = (str || '').trim()

  if (s.startsWith('#')) {
    const hex = s.slice(1)
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex
    const int = parseInt(full, 16)

    if (Number.isFinite(int)) {
      return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
    }
  }
  const m = s.match(/(\d+)[\s,]+(\d+)[\s,]+(\d+)/)

  if (m) {
    return { r: +m[1], g: +m[2], b: +m[3] }
  }

  return fallback
}
