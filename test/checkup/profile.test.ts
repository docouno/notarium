import { describe, expect, it } from 'vitest'

import {
  CHECKUP_RESOURCE_PLANS,
  COMMITTED_CHECKUP_PROFILE,
  expandCpuList,
  requiresCheckupAffinity,
  resolveCheckupProfile,
  resolveResourceAllocation,
  selectedAffinity,
} from '../../scripts/checkup/profile.mjs'

const cpuPositions = ({ offset, count }: { offset: number; count: number }): number[] =>
  Array.from({ length: count }, (_, index) => offset + index)

describe('checkup resource profile', () => {
  it('keeps a conservative unprofiled fallback for direct Vitest invocation', () => {
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

  it('clamps the unprofiled fallback coherently on a smaller runtime', () => {
    expect(resolveCheckupProfile({ env: {}, availableCpu: 1 }).effective).toEqual({
      cpu: 1,
      vitestWorkers: 1,
      coverageProcessingConcurrency: 1,
      playwrightWorkers: 1,
      fileParallelism: false,
      cpuOffset: 0,
    })
  })

  it.each([
    [{ CHECKUP_CPU_CEILING: '0' }, 8, /positive integer/u],
    [{ CHECKUP_CPU_CEILING: '9' }, 8, /exceeds 8 available/u],
    [
      { CHECKUP_CPU_CEILING: '2', CHECKUP_VITEST_WORKERS: '3' },
      8,
      /WORKERS=3 exceeds CPU ceiling 2/u,
    ],
    [
      {
        CHECKUP_CPU_CEILING: '2',
        CHECKUP_VITEST_WORKERS: '2',
        CHECKUP_COVERAGE_CONCURRENCY: '3',
      },
      8,
      /CONCURRENCY=3 exceeds CPU ceiling 2/u,
    ],
  ])('rejects invalid overrides before work', (env, availableCpu, expected) => {
    expect(() => resolveCheckupProfile({ env, availableCpu })).toThrow(expected)
  })

  it('selects positions from a non-zero sparse affinity instead of inventing CPU ids', () => {
    expect(expandCpuList('2-3,7,9-10')).toEqual([2, 3, 7, 9, 10])
    expect(selectedAffinity('2-3,7,9-10', 4)).toBe('2,3,7,9')
    expect(selectedAffinity('2-3,7,9-10', 2, 2)).toBe('7,9')
    expect(selectedAffinity('8-11,20,24-26', 4, 4)).toBe('20,24,25,26')
    expect(() => selectedAffinity('4-5', 3)).toThrow(/cannot provide 3 CPU/u)
  })

  it('declares resource policy as shares rather than hardware positions', () => {
    expect(CHECKUP_RESOURCE_PLANS['ci-extended-wave1'].lanes).toEqual({
      coverage: { startShare: 0, endShare: 0.5 },
      wave: { startShare: 0.5, endShare: 1 },
      postgres: { startShare: 0.5, endShare: 0.75 },
      visual: { startShare: 0.75, endShare: 1, playwrightWorkers: 1 },
    })
    expect(CHECKUP_RESOURCE_PLANS['local-heavy'].lanes).toEqual({
      postgres: { startShare: 0, endShare: 0.5 },
      browser: {
        startShare: 0.5,
        endShare: 1,
        playwrightWorkerShare: 0.5,
        playwrightWorkersMax: 3,
      },
    })
  })

  it.each([
    [4, 2, 1],
    [8, 4, 2],
    [16, 8, 4],
  ])('maps the complete CI topology over %i allowed CPUs', (availableCpu, half, quarter) => {
    const allocation = (plan: string, lane: string) =>
      resolveResourceAllocation({ plan, lane, availableCpu }).effective
    const coverage = allocation('ci-extended-wave1', 'coverage')
    const wave = allocation('ci-extended-wave1', 'wave')
    const postgres = allocation('ci-extended-wave1', 'postgres')
    const visual = allocation('ci-extended-wave1', 'visual')

    expect(coverage).toEqual({ offset: 0, count: half })
    expect(wave).toEqual({ offset: half, count: half })
    expect(postgres).toEqual({ offset: half, count: quarter })
    expect(visual).toEqual({ offset: half + quarter, count: half - quarter })
    expect([...cpuPositions(coverage), ...cpuPositions(wave)]).toEqual(
      Array.from({ length: availableCpu }, (_, cpu) => cpu),
    )
    expect([...cpuPositions(postgres), ...cpuPositions(visual)]).toEqual(cpuPositions(wave))
    expect(allocation('ci-lean-wave1', 'static')).toEqual(wave)
    expect(allocation('ci-lean-wave2', 'build')).toEqual(wave)
    expect(allocation('ci-extended-wave2', 'browser')).toEqual(wave)
    expect(allocation('ci-heavy-tail', 'backup')).toEqual(coverage)
  })

  it('preserves complete disjoint coverage on non-power-of-two capacities', () => {
    for (let availableCpu = 4; availableCpu <= 17; availableCpu += 1) {
      const allocation = (lane: string) =>
        resolveResourceAllocation({
          plan: 'ci-extended-wave1',
          lane,
          availableCpu,
        }).effective
      const coverage = allocation('coverage')
      const wave = allocation('wave')
      const postgres = allocation('postgres')
      const visual = allocation('visual')

      expect(coverage.offset + coverage.count).toBe(wave.offset)
      expect(wave.offset + wave.count).toBe(availableCpu)
      expect(postgres.offset).toBe(wave.offset)
      expect(postgres.offset + postgres.count).toBe(visual.offset)
      expect(visual.offset + visual.count).toBe(availableCpu)
    }
  })

  it.each([
    [4, 3, 1],
    [8, 6, 2],
    [16, 12, 3],
  ])(
    'uses all %i local CPUs while scaling measured worker density',
    (availableCpu, isolatedWorkers, browserWorkers) => {
      const isolated = resolveCheckupProfile({
        env: {
          CHECKUP_RESOURCE_PLAN: 'local-isolated',
          CHECKUP_RESOURCE_LANE: 'coverage',
        },
        availableCpu,
      })
      const staticLane = resolveResourceAllocation({
        plan: 'local-static',
        lane: 'static',
        availableCpu,
      })
      const postgres = resolveResourceAllocation({
        plan: 'local-heavy',
        lane: 'postgres',
        availableCpu,
      })
      const browser = resolveCheckupProfile({
        env: {
          CHECKUP_RESOURCE_PLAN: 'local-heavy',
          CHECKUP_RESOURCE_LANE: 'browser',
        },
        availableCpu,
      })

      expect(staticLane.effective).toEqual({ offset: 0, count: availableCpu })
      expect(isolated.effective).toMatchObject({
        cpu: availableCpu,
        vitestWorkers: isolatedWorkers,
        coverageProcessingConcurrency: isolatedWorkers,
        cpuOffset: 0,
      })
      expect(postgres.effective).toEqual({ offset: 0, count: availableCpu / 2 })
      expect(browser.effective).toMatchObject({
        cpu: availableCpu / 2,
        playwrightWorkers: browserWorkers,
        cpuOffset: availableCpu / 2,
      })
    },
  )

  it('rejects only capacities too small for the requested disjoint workload', () => {
    expect(() =>
      resolveResourceAllocation({
        plan: 'ci-extended-wave1',
        lane: 'postgres',
        availableCpu: 3,
      }),
    ).toThrow(/requires at least 4 CPU/u)
    expect(() =>
      resolveResourceAllocation({ plan: 'ci-lean-wave1', lane: 'coverage', availableCpu: 1 }),
    ).toThrow(/requires at least 2 CPU/u)
    expect(() =>
      resolveResourceAllocation({ plan: 'local-heavy', lane: 'postgres', availableCpu: 1 }),
    ).toThrow(/requires at least 2 CPU/u)
    expect(
      resolveResourceAllocation({
        plan: 'ci-extended-wave1',
        lane: 'postgres',
        availableCpu: 4,
      }).effective,
    ).toEqual({ offset: 2, count: 1 })
  })

  it('requires exact affinity for CI plans without requiring a fixed machine size', () => {
    const ci = resolveCheckupProfile({
      env: {
        CHECKUP_RESOURCE_PLAN: 'ci-extended-wave1',
        CHECKUP_RESOURCE_LANE: 'coverage',
      },
      availableCpu: 16,
    })
    const local = resolveCheckupProfile({
      env: {
        CHECKUP_RESOURCE_PLAN: 'local-isolated',
        CHECKUP_RESOURCE_LANE: 'coverage',
      },
      availableCpu: 16,
    })

    expect(ci.effective.cpu).toBe(8)
    expect(requiresCheckupAffinity(ci, { env: {} })).toBe(true)
    expect(requiresCheckupAffinity(local, { env: {} })).toBe(false)
    expect(requiresCheckupAffinity(local, { env: { CHECKUP_REQUIRE_AFFINITY: '1' } })).toBe(true)
  })
})
