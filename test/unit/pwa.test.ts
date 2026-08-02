// PWA helpers (#40): the pure pieces behind the install/standalone/theme-color
// behaviour. Window-injectable on purpose, so they're exercised here without a
// DOM (the unit layer is node-environment, #18).

import { describe, expect, it } from 'vitest'

import { isIOS, isStandalone, THEME_COLOR, themeColor } from '../../packages/web/src/libs/pwa'

// A minimal window stand-in: only the bits the helpers read.
const fakeWin = (opts: { standaloneMedia?: boolean; navStandalone?: boolean }): Window =>
  ({
    matchMedia: (q: string) => ({
      matches: q.includes('standalone') ? !!opts.standaloneMedia : false,
    }),
    navigator: { standalone: opts.navStandalone },
  }) as unknown as Window

describe('themeColor', () => {
  it('maps each theme to its --bg, tracking tokens.scss', () => {
    expect(themeColor('dark')).toBe('#151517')
    expect(themeColor('light')).toBe('#ffffff')
    expect(themeColor('dark')).toBe(THEME_COLOR.dark)
  })

  it('falls back to the dark colour for an unknown value', () => {
    expect(themeColor('sepia' as 'dark')).toBe('#151517')
  })
})

describe('isStandalone', () => {
  it('is true when the standalone display-mode media matches (Chromium/Android)', () => {
    expect(isStandalone(fakeWin({ standaloneMedia: true }))).toBe(true)
  })

  it('is true via the legacy iOS navigator.standalone flag', () => {
    expect(isStandalone(fakeWin({ navStandalone: true }))).toBe(true)
  })

  it('is false in a normal browser tab', () => {
    expect(isStandalone(fakeWin({}))).toBe(false)
  })
})

describe('isIOS', () => {
  it('matches iPhone/iPad/iPod user agents', () => {
    expect(isIOS('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5)).toBe(true)
    expect(isIOS('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 5)).toBe(true)
  })

  it('matches iPadOS 13+ which reports a desktop Macintosh UA but has touch', () => {
    const iPadOSUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
    expect(isIOS(iPadOSUa, 5)).toBe(true)
    // A real Mac: same UA, no touch points → not iOS.
    expect(isIOS(iPadOSUa, 0)).toBe(false)
  })

  it('does not match desktop or Android', () => {
    expect(isIOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0)).toBe(false)
    expect(isIOS('Mozilla/5.0 (Linux; Android 14)', 5)).toBe(false)
  })
})
