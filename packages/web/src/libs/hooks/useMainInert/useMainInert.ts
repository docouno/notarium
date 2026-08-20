import { useLayoutEffect } from 'react'

// `inert` on the main column, with ONE owner for an attribute two surfaces need.
// A narrow modal aside and the narrow explorer panel both cover the page, and each
// used to set and clear the attribute itself: whichever closed first cleared it for
// the other, and the content under a still-open overlay took focus again. Ownership
// is counted here instead — the attribute goes on for the first holder and comes off
// only when the last one lets go.
const holders = new Set<symbol>()

const apply = () => {
  const main = document.querySelector<HTMLElement>('main.main')

  if (!main) {
    return
  }
  main.toggleAttribute('inert', holders.size > 0)
  if (holders.size > 0) {
    main.setAttribute('aria-hidden', 'true')
  } else {
    main.removeAttribute('aria-hidden')
  }
}

/** Hold the main column inert (and hidden from assistive tech) while `active`. */
export const useMainInert = (active: boolean) => {
  useLayoutEffect(() => {
    if (!active) {
      // A main column that just mounted starts clean, so re-assert whatever the
      // other holders are still asking for.
      apply()
      return undefined
    }
    const holder = Symbol('main-inert')
    holders.add(holder)
    apply()

    return () => {
      holders.delete(holder)
      apply()
    }
  }, [active])
}
