import { type RefObject, useEffect, useState } from 'react'

// Track an element's content width via ResizeObserver — the clean way to react to
// available space (vs. listening to window resize, which misses sidebar/aside
// toggles and panel drags). Returns 0 until first measured.
export const useElementWidth = (ref: RefObject<HTMLElement | null>): number => {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current

    if (!el) {
      return undefined
    }
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
        setWidth(w)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}
