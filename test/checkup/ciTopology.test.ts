import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { resolveResourceAllocation } from '../../scripts/checkup/profile.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

type Rule = { if?: string; when?: string; allow_failure?: boolean }
type Job = {
  after_script?: string[]
  artifacts?: {
    paths?: string[]
    reports?: {
      dotenv?: string
      junit?: string
      coverage_report?: { coverage_format?: string; path?: string }
    }
  }
  before_script?: string[]
  extends?: string | string[]
  image?: string
  resource_group?: string
  services?: Array<{ name?: string; alias?: string }>
  script?: string[]
  variables?: Record<string, string>
  needs?: Array<{ job: string; artifacts?: boolean } | string>
  rules?: Rule[]
  when?: string
}

describe('resource-aware GitLab topology', () => {
  it('uses the existing lean unit job as the canonical coverage and JUnit producer', async () => {
    const pipeline = parse(await readFile(join(repo, '.gitlab-ci.yml'), 'utf8')) as Record<
      string,
      Job
    >
    const unit = pipeline['lean:unit']!

    expect(unit.variables).toMatchObject({
      CHECKUP_RESOURCE_PLAN: 'ci-lean-wave1',
      CHECKUP_RESOURCE_LANE: 'coverage',
    })
    expect((unit.script ?? []).join('\n')).toContain('npm run test:coverage')
    expect((unit.script ?? []).join('\n')).toContain('scripts/checkup/ciReports.mjs')
    expect(unit.rules).toBeUndefined()
    expect(unit.artifacts?.reports).toMatchObject({
      junit: 'test-results/vitest-junit.xml',
      coverage_report: {
        coverage_format: 'cobertura',
        path: 'coverage/cobertura-coverage.xml',
      },
    })
  })

  it('stages static then build on one disjoint four-CPU slice', async () => {
    const source = await readFile(join(repo, '.gitlab-ci.yml'), 'utf8')
    const pipeline = parse(source) as Record<string, Job>

    for (const [name, plan, lane] of [
      ['lean:static', 'ci-lean-wave1', 'static'],
      ['lean:build', 'ci-lean-wave2', 'build'],
    ]) {
      const job = pipeline[name]!

      expect(job.variables?.CHECKUP_RESOURCE_PLAN).toBe(plan)
      expect(job.variables?.CHECKUP_RESOURCE_LANE).toBe(lane)
    }
    expect(pipeline['lean:build']?.needs).toEqual([{ job: 'lean:static', artifacts: false }])
    expect(source).not.toMatch(/CHECKUP_CPUSET:/u)
    expect(source).not.toMatch(/--cpuset-cpus/u)
    expect(pipeline['lean:static']?.artifacts?.paths).toEqual(['test-results/checkup-static.json'])
  })

  it('profiles extended installs and commands under the two-wave plans', async () => {
    const pipeline = parse(await readFile(join(repo, '.gitlab-ci.yml'), 'utf8')) as Record<
      string,
      Job
    >
    const expected = {
      'extended:unit': ['ci-extended-wave1', 'coverage'],
      'extended:postgres+visual': ['ci-extended-wave1', 'wave'],
      'extended:e2e': ['ci-extended-wave2', 'browser'],
    }

    for (const [name, [plan, lane]] of Object.entries(expected)) {
      expect(pipeline[name]?.variables).toMatchObject({
        CHECKUP_RESOURCE_PLAN: plan,
        CHECKUP_RESOURCE_LANE: lane,
      })
    }
    expect((pipeline['extended:postgres+visual']?.script ?? []).join('\n')).toContain(
      'scripts/checkup/ciExtendedWave1.mjs',
    )
    expect(pipeline['extended:postgres+visual']?.needs).toEqual([
      { job: 'lean:static', artifacts: false },
      { job: 'lean:build', artifacts: false },
    ])
    expect(pipeline['extended:postgres+visual']?.services).toEqual([
      { name: 'postgres:16-alpine', alias: 'postgres' },
    ])
    expect(pipeline['extended:postgres+visual']?.image).toBe(
      'mcr.microsoft.com/playwright:v1.60.0-jammy',
    )
    expect((pipeline['extended:postgres+visual']?.script ?? []).join('\n')).toContain(
      '--lane wave npm run deps:lean',
    )
    expect(pipeline['extended:postgres+visual']?.artifacts).toMatchObject({
      reports: { dotenv: 'review.env' },
      paths: ['visual-handoff.json', 'playwright-report/', 'test-results/'],
    })
    expect((pipeline['extended:postgres+visual:gate']?.script ?? []).join('\n')).toContain(
      'scripts/checkup/ciExtendedWave1.mjs gate',
    )
    expect(pipeline['extended:postgres+visual:gate']?.needs).toEqual([
      { job: 'extended:postgres+visual', artifacts: true },
    ])
    expect((pipeline['extended:e2e']?.script ?? []).join('\n')).toContain('npm run e2e')
    expect(pipeline['extended:e2e']?.needs).toEqual([
      { job: 'extended:postgres+visual', artifacts: false },
    ])
    expect(pipeline['extended:e2e']?.when).toBe('always')
    expect(pipeline['extended:postgres']).toBeUndefined()
    expect(pipeline['extended:visual']).toBeUndefined()
    expect(pipeline['extended:unit']?.needs).toEqual([
      { job: 'lean:static', artifacts: false },
      { job: 'lean:unit', artifacts: false },
      { job: 'lean:build', artifacts: false },
    ])
    expect((pipeline['extended:unit']?.script ?? []).join('\n')).toContain(
      'profile.mjs --plan "$CHECKUP_RESOURCE_PLAN" --lane coverage',
    )
    expect((pipeline['extended:unit']?.script ?? []).join('\n')).toContain(
      'ciDockerBuilder.mjs create',
    )
    expect((pipeline['extended:unit']?.script ?? []).join('\n')).toContain(
      'BUILDX_BUILDER="notarium-ci-$CI_JOB_ID" docker build',
    )
    expect((pipeline['extended:unit']?.script ?? []).join('\n')).toContain('ciFullDeps.mjs')
    expect((pipeline['extended:unit']?.script ?? []).join('\n')).not.toContain('ciCoverage.mjs')
    expect(pipeline['extended:unit']?.artifacts?.reports?.coverage_report).toBeUndefined()
    expect((pipeline['extended:unit']?.script ?? []).join('\n')).toContain('util-linux-misc')
  })

  it('reserves both CPU halves across pipelines without flattening the internal DAG', async () => {
    const pipeline = parse(await readFile(join(repo, '.gitlab-ci.yml'), 'utf8')) as Record<
      string,
      Job
    >

    const group = (name: string): string | undefined => {
      const job = pipeline[name]!
      const parents = typeof job.extends === 'string' ? [job.extends] : (job.extends ?? [])

      return job.resource_group ?? parents.map((parent) => group(parent)).find(Boolean)
    }

    const variables = (name: string): Record<string, string> => {
      const job = pipeline[name]!
      const parents = typeof job.extends === 'string' ? [job.extends] : (job.extends ?? [])

      return Object.assign({}, ...parents.map((parent) => variables(parent)), job.variables ?? {})
    }

    expect(pipeline['.ci-lane-a']?.resource_group).toBe('notarium-ci-lane-a')
    expect(pipeline['.ci-lane-b']?.resource_group).toBe('notarium-ci-lane-b')
    for (const name of [
      'lean:unit',
      'extended:unit',
      'verify:backup-smoke',
      'verify:release-smoke',
      'release:rc',
      'release:publish',
    ]) {
      expect(group(name), name).toBe('notarium-ci-lane-a')
    }
    for (const name of ['lean:static', 'lean:build', 'extended:postgres+visual', 'extended:e2e']) {
      expect(group(name), name).toBe('notarium-ci-lane-b')
    }
    const profiledFor = (availableCpu: number) =>
      Object.entries(pipeline)
        .filter(([name]) => {
          const resolved = variables(name)

          return (
            !name.startsWith('.') &&
            resolved.CHECKUP_RESOURCE_PLAN &&
            resolved.CHECKUP_RESOURCE_LANE
          )
        })
        .map(([name]) => {
          const resolved = variables(name)
          const allocation = resolveResourceAllocation({
            plan: resolved.CHECKUP_RESOURCE_PLAN,
            lane: resolved.CHECKUP_RESOURCE_LANE,
            availableCpu,
          })

          return {
            name,
            group: group(name),
            cpus: Array.from(
              { length: allocation.effective.count },
              (_, index) => allocation.effective.offset + index,
            ),
          }
        })
    const expectedNames = [
      'extended:e2e',
      'extended:postgres+visual',
      'extended:unit',
      'lean:build',
      'lean:static',
      'lean:unit',
      'release:publish',
      'release:rc',
      'verify:backup-smoke',
      'verify:release-smoke',
    ]

    for (const availableCpu of [4, 8, 16]) {
      const profiled = profiledFor(availableCpu)

      expect(profiled.map(({ name }) => name).sort()).toEqual(expectedNames)
      for (const left of profiled) {
        expect(left.group, left.name).toBeTruthy()
        for (const right of profiled) {
          if (left.group !== right.group) {
            expect(
              left.cpus.filter((cpu) => right.cpus.includes(cpu)),
              `${availableCpu} CPU: ${left.name} vs ${right.name}`,
            ).toEqual([])
          }
        }
      }
      const coverage = profiled.find(({ name }) => name === 'lean:unit')!.cpus
      const staticLane = profiled.find(({ name }) => name === 'lean:static')!.cpus

      expect([...coverage, ...staticLane]).toEqual(
        Array.from({ length: availableCpu }, (_, cpu) => cpu),
      )
    }
    expect(pipeline['extended:postgres+visual']?.variables).toMatchObject({
      CHECKUP_RESOURCE_PLAN: 'ci-extended-wave1',
      CHECKUP_RESOURCE_LANE: 'wave',
    })
    expect(pipeline['extended:e2e']?.needs).toEqual([
      { job: 'extended:postgres+visual', artifacts: false },
    ])
  })

  it('starts the serial heavy tail from unit without bypassing the release stage', async () => {
    const pipeline = parse(await readFile(join(repo, '.gitlab-ci.yml'), 'utf8')) as Record<
      string,
      Job
    >

    expect(pipeline['verify:backup-smoke']?.needs).toEqual([
      { job: 'extended:unit', artifacts: false },
    ])
    expect(pipeline['verify:release-smoke']?.needs).toEqual([
      { job: 'verify:backup-smoke', artifacts: false },
    ])
    expect(pipeline['verify:backup-smoke']?.variables).toMatchObject({
      CHECKUP_RESOURCE_PLAN: 'ci-heavy-tail',
      CHECKUP_RESOURCE_LANE: 'backup',
    })
    expect(pipeline['verify:release-smoke']?.variables).toMatchObject({
      CHECKUP_RESOURCE_PLAN: 'ci-heavy-tail',
      CHECKUP_RESOURCE_LANE: 'release',
    })
    expect((pipeline['verify:backup-smoke']?.script ?? []).join('\n')).toContain('util-linux-misc')
    expect((pipeline['verify:release-smoke']?.script ?? []).join('\n')).toContain('util-linux-misc')
    for (const name of ['verify:backup-smoke', 'verify:release-smoke']) {
      expect((pipeline[name]?.script ?? []).join('\n'), name).toContain(
        'ciDockerBuilder.mjs create',
      )
      expect((pipeline[name]?.after_script ?? []).join('\n'), name).toContain(
        'ciDockerBuilder.mjs remove',
      )
    }
    expect(pipeline['release:rc']?.needs).toBeUndefined()
    expect(pipeline['release:publish']?.needs).toBeUndefined()
    expect(pipeline['.release-lane']?.variables).toMatchObject({
      CHECKUP_RESOURCE_PLAN: 'ci-heavy-tail',
      CHECKUP_RESOURCE_LANE: 'release',
    })
  })

  it('offers visual acceptance only on the protected default branch', async () => {
    const pipeline = parse(await readFile(join(repo, '.gitlab-ci.yml'), 'utf8')) as Record<
      string,
      Job
    >

    expect(pipeline['visual:accept']?.when).toBeUndefined()
    expect(pipeline['visual:accept']?.rules).toEqual([
      {
        if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH',
        when: 'manual',
        allow_failure: true,
      },
      { when: 'never' },
    ])
  })
})
