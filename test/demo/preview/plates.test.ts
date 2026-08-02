import { describe, expect, it } from 'vitest'
import { OG_DOC, OG_HERO, type Plate } from './template'

// The plates are the one export in this repository whose consumer is OUTSIDE it: the docs
// site decodes one, sets its own type over it and never sees this code. The images
// themselves are git-ignored here — they are committed in the repository that reads them —
// so what is left to protect at this end is the GEOMETRY, which is the actual contract:
// the canvas an unfurl scales from, and the line the consumer's text must clear.
//
// The other half of the contract is checked at the far end, where it can be: the docs
// build compares the plate it imported against the manifest that came with it, which is
// the only place a stale import can be caught.

const PLATES: Plate[] = [OG_HERO, OG_DOC]

describe('the plate geometry', () => {
  it('is the canvas Open Graph documents', () => {
    // 1200×630 is what every unfurl scales from; a plate cut at another aspect ratio
    // would be letterboxed by the consumer, not cropped.
    for (const plate of PLATES) {
      expect(plate.width).toBe(1200)
      expect(plate.height).toBe(630)
    }
  })

  it('leaves the hero plate a window worth showing', () => {
    // The text zone and the product window split one canvas: give the type everything
    // and the plate becomes an empty backdrop with a sliver of application at the bottom.
    expect(OG_HERO.textZone).toBeLessThan(OG_HERO.height - 180)
    expect(OG_HERO.shotWidth).not.toBeNull()
  })

  it('gives the doc plate its whole canvas', () => {
    expect(OG_DOC.textZone).toBe(OG_DOC.height)
    expect(OG_DOC.shotWidth).toBeNull()
  })

  it('names each plate distinctly — the manifest is keyed by name', () => {
    expect(new Set(PLATES.map((p) => p.name)).size).toBe(PLATES.length)
  })
})
