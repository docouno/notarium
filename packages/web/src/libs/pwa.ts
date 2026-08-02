// PWA helpers (#40) — pure, window-injectable so they unit-test under the
// node-environment vitest. The provider (composers/PwaProvider) wires them to
// the live window; tests pass fakes.

// Structurally identical to ChromeProvider's Theme; declared here (not imported)
// so this lib stays below the composer layer (eslint-plugin-boundaries).
type Theme = 'light' | 'dark'

/** Browser title-bar / splash colour per theme. MUST track tokens.scss `--bg`
 *  (the app paints its shell with it), so an installed window's chrome matches
 *  the page background instead of flashing a mismatched bar. */
export const THEME_COLOR: Record<Theme, string> = {
  dark: '#151517',
  light: '#ffffff',
}

export const themeColor = (theme: Theme): string => THEME_COLOR[theme] ?? THEME_COLOR.dark

/** Running as an installed app: standalone display-mode (Chromium/Android) or
 *  the legacy iOS `navigator.standalone` flag. */
export const isStandalone = (win: Window = window): boolean => {
  const mql = win.matchMedia?.('(display-mode: standalone)')
  // iOS Safari sets navigator.standalone; it isn't in the lib DOM types.
  const iosStandalone = (win.navigator as Navigator & { standalone?: boolean }).standalone === true
  return Boolean(mql?.matches) || iosStandalone
}

/** iOS/iPadOS Safari, which has no beforeinstallprompt — the only place we fall
 *  back to manual "Add to Home Screen" instructions. iPadOS 13+ reports a desktop
 *  "Macintosh" UA, so it's distinguished by touch support (a real Mac has none). */
export const isIOS = (
  ua: string = navigator.userAgent,
  maxTouchPoints: number = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
): boolean => {
  if (/iphone|ipad|ipod/i.test(ua)) {
    return true
  }

  return /Macintosh/.test(ua) && maxTouchPoints > 1
}
