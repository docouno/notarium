import { useEffect, useState } from 'react'
import { parseColor } from '../../helpers/color'
import type { Rgb } from '../../types'

/** The canvas accent + bg, resolved from the theme CSS variables. Read in an
 *  effect on the NEXT frame (not during render): App flips the document's
 *  data-theme in its own effect, which lands after this component's render, so a
 *  synchronous read here would see the OLD theme — that's what left graph label
 *  plates stuck on the previous theme's colour until reload. The rAF read runs
 *  after the attribute is applied, and the state update repaints the canvas. */
export const useThemePalette = (theme?: string): { accentRgb: Rgb; bgRgb: Rgb } => {
  const dark = theme === 'dark'
  const fallback = dark
    ? { accentRgb: { r: 139, g: 124, b: 246 }, bgRgb: { r: 21, g: 21, b: 23 } }
    : { accentRgb: { r: 109, g: 78, b: 224 }, bgRgb: { r: 255, g: 255, b: 255 } }
  const [pal, setPal] = useState(fallback)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const cs = getComputedStyle(document.documentElement)
      setPal({
        accentRgb: parseColor(cs.getPropertyValue('--accent'), fallback.accentRgb),
        bgRgb: parseColor(cs.getPropertyValue('--bg'), fallback.bgRgb),
      })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  return pal
}
