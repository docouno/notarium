import { describe, expect, it } from 'vitest'

import { AXES } from './axes'
import { coverageGaps, renderCoverage } from './coverage'
import { CASES } from './registry'

// The catalog must reflect ALL our axes: a surface with no seed case, a case that
// forgot to tag its axes, or a markdown feature with no fragment are all coverage
// holes that would let the stand look complete while missing something. Fail loud.
describe('seed catalog coverage (#175)', () => {
  it('every product axis is covered by at least one case', () => {
    expect(coverageGaps().uncoveredAxes).toEqual([])
  })

  it('every registered case declares at least one axis', () => {
    expect(coverageGaps().untaggedCases).toEqual([])
  })

  it('every markdown feature has at least one corpus fragment', () => {
    expect(coverageGaps().emptyFeatures).toEqual([])
  })

  it('renders a coverage matrix naming every axis and the case count', () => {
    const md = renderCoverage()

    for (const a of AXES) {
      expect(md).toContain(a.axis)
    }
    expect(md).toContain(`${CASES.length} cases`)
  })
})
