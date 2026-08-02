import { describe, expect, it } from 'vitest'
import { readFont, readHeadline, readMark, readThemeTokens } from './sources'

// The preview reads four files it does not own — README.md, tokens.scss, the Inter face
// and favicon.svg — and every one of those reads is a coupling that nothing else in the
// repo would notice breaking. Without these, a re-worded tagline or a moved font is a
// surprise at shoot time, on the day someone is trying to publish a release.
//
// These assert the COUPLING, not the values: what has to stay true about those files for
// `make demo-preview` to keep producing a correct banner.

describe('README.md → the banner headline', () => {
  it('parses the tagline under the title', async () => {
    const headline = await readHeadline()

    expect(headline.length).toBeGreaterThan(0)
    // No markdown may survive into the picture — it has no renderer.
    expect(headline).not.toMatch(/[*_`[\]]/)
    // It is a title on the banner, not a sentence in prose.
    expect(headline.endsWith('.')).toBe(false)
  })

  it('stays short enough for the two-line composition', async () => {
    const headline = await readHeadline()

    // BANNER wraps at 22ch and the vertical rhythm is built for two lines: a third line
    // pushes the product window down and the crop starts eating the application. There
    // is no way to catch that from inside the render — the page just composes lower.
    expect(headline.length).toBeLessThanOrEqual(60)
  })
})

describe('tokens.scss → the banner palette', () => {
  it('is still two flat :root blocks, injectable as CSS', async () => {
    const css = await readThemeTokens()

    expect(css.match(/\{/g)).toHaveLength(2)
    expect(css).toContain(":root[data-theme='dark']")
  })

  it('carries the custom properties the composition actually references', async () => {
    const css = await readThemeTokens()

    // Renaming any of these leaves the banner rendering with unresolved var() — a
    // transparent plate and default-black type, which still produces a PNG.
    for (const token of [
      '--bg:',
      '--text:',
      '--text-dim:',
      '--accent:',
      '--border-strong:',
      '--glass-highlight:',
      '--radius-lg:',
    ]) {
      expect(css).toContain(token)
    }
  })
})

describe('the inlined assets', () => {
  it('finds the variable Inter face the app ships', async () => {
    const uri = await readFont()

    expect(uri.startsWith('data:font/woff2;base64,')).toBe(true)
    // A truncated or placeholder file would still base64 into a valid data URI.
    expect(uri.length).toBeGreaterThan(10_000)
  })

  it('finds the brand mark', async () => {
    const uri = await readMark()

    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(Buffer.from(uri.split(',')[1], 'base64').toString('utf8')).toContain('<svg')
  })
})
