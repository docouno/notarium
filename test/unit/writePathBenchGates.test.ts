import { describe, expect, it } from 'vitest'
import { candidateFloorFailure } from '../../scripts/writePathBenchGates'

describe('write-path relative timing gate', () => {
  const sample = (medianRatio: number, candidateP95: number, floorP95: number) => ({
    candidate: { medianMs: 1, p95Ms: candidateP95, maxMs: 1 },
    floor: { medianMs: 1, p95Ms: floorP95, maxMs: 1 },
    candidateFloorRatios: { medianMs: medianRatio, p95Ms: 9.5, maxMs: 10 },
  })

  it('gates stable median and p95 ratios without pairing unrelated tail samples', () => {
    expect(candidateFloorFailure('stable', sample(3.23, 7, 2))).toBeNull()
    expect(candidateFloorFailure('edge', sample(3.5, 7, 2))).toBeNull()
    expect(candidateFloorFailure('median-regressed', sample(3.51, 7, 2))).toBe(
      'median-regressed: candidate/floor median=3.51 p95=3.50 exceeds 3.5 (paired-ratio p95=9.50 diagnostic)',
    )
    expect(candidateFloorFailure('tail-regressed', sample(3.2, 7.02, 2))).toBe(
      'tail-regressed: candidate/floor median=3.20 p95=3.51 exceeds 3.5 (paired-ratio p95=9.50 diagnostic)',
    )
  })
})
