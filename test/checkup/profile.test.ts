import { describe, expect, it } from 'vitest'
import {
  COMMITTED_CHECKUP_PROFILE,
  expandCpuList,
  resolveCheckupProfile,
  selectedAffinity,
} from '../../scripts/checkup/profile.mjs'

describe('checkup resource profile', () => {
  it('uses the measured committed tuple without scaling up on a larger runtime', () => {
    const profile = resolveCheckupProfile({ env: {}, availableCpu: 64 })

    expect(profile.requested).toMatchObject(COMMITTED_CHECKUP_PROFILE)
    expect(profile.effective).toMatchObject({
      cpu: 4,
      vitestWorkers: 4,
      coverageProcessingConcurrency: 4,
      playwrightWorkers: 1,
      fileParallelism: true,
    })
  })

  it('clamps every concurrency component coherently on smaller runtimes', () => {
    expect(resolveCheckupProfile({ env: {}, availableCpu: 1 }).effective).toEqual({
      cpu: 1,
      vitestWorkers: 1,
      coverageProcessingConcurrency: 1,
      playwrightWorkers: 1,
      fileParallelism: false,
    })
  })

  it.each([
    [{ CHECKUP_CPU_CEILING: '0' }, /positive integer/u],
    [{ CHECKUP_CPU_CEILING: '5' }, /exceeds the committed ceiling/u],
    [{ CHECKUP_CPU_CEILING: '2', CHECKUP_VITEST_WORKERS: '3' }, /WORKERS=3 exceeds CPU ceiling 2/u],
    [
      {
        CHECKUP_CPU_CEILING: '2',
        CHECKUP_VITEST_WORKERS: '2',
        CHECKUP_COVERAGE_CONCURRENCY: '3',
      },
      /CONCURRENCY=3 exceeds CPU ceiling 2/u,
    ],
  ])('rejects an invalid or oversized override before Vitest', (env, expected) => {
    expect(() => resolveCheckupProfile({ env, availableCpu: 8 })).toThrow(expected)
  })

  it('selects real CPUs from ranges instead of assuming a zero-based affinity', () => {
    expect(expandCpuList('2-3,7,9-10')).toEqual([2, 3, 7, 9, 10])
    expect(selectedAffinity('2-3,7,9-10', 4)).toBe('2,3,7,9')
    expect(() => selectedAffinity('4-5', 3)).toThrow(/cannot provide 3 CPU/u)
  })
})
