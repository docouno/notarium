import { describe, expect, it } from 'vitest'

import {
  CONTEXT_OPEN_FROZEN_COMMIT,
  contextOpenBenchmarkGateFailures,
  type ContextOpenBenchmarkReport,
  contextOpenContainerFailures,
  contextOpenRuntimeFailures,
  type ContextOpenStats,
  contextOpenStats,
} from '../../scripts/contextOpenBenchGates'

const samples = (value: number, count = 12) => Array.from({ length: count }, () => value)
const stats = (value: number, count = 12) => contextOpenStats(samples(value, count))
/** A liveness series shaped like the ones the harness records: a long quiet run with
 *  one blocked stretch in it, so that its p95 and its max are different numbers. */
const heartbeatStats = (spikeMs: number, quietMs = 1.5, count = 65) =>
  contextOpenStats([...samples(quietMs, count), spikeMs])
/** A surface series as the harness really records one: a quiet run with a single slow
 *  sample in it, so that its median, its p95 and its max are three different numbers. */
const spikedStats = (typicalMs: number, spikeMs = 900) =>
  contextOpenStats([...samples(typicalMs, 11), spikeMs])
/** Which baseline axis each post surface is measured against. */
const BASELINE_AXIS = {
  noteOpen: 'noteOpen',
  personalContext: 'personalContext',
  projectContext: 'projectContext',
  dashboard: 'warmDashboard',
  graphHealth: 'warmGraphHealth',
} as const

type AbilityEdit = ContextOpenBenchmarkReport['abilityEdit']
type MeasuredCycle = AbilityEdit['raw'][number]

const withoutOperation = (cycle: MeasuredCycle, key: keyof MeasuredCycle): MeasuredCycle =>
  Object.fromEntries(
    Object.entries(cycle).filter(([name]) => name !== key),
  ) as unknown as MeasuredCycle

const absent = <T>(): T => undefined as unknown as T

const report = (phase: 'pre' | 'post'): ContextOpenBenchmarkReport => {
  const operation = (outcome: 'applied' | 'skipped' | 'failed') => ({
    call: {
      ms: 10,
      status: 200,
      step: { step: 'document', outcome },
    },
    unrelatedNote: { ms: 2, status: 200 },
    healthHeartbeat: [
      { ms: 1, status: 200 },
      { ms: 1, status: 200 },
    ],
  })

  return {
    phase,
    provenance: {
      commit:
        phase === 'pre' ? CONTEXT_OPEN_FROZEN_COMMIT : 'dda63efdbe8d961fcc22417fdb3522126f8686f2',
      builtAt: phase === 'pre' ? '2026-08-25T00:00:00.000Z' : '2026-08-26T00:00:00.000Z',
      image: `sha256:${(phase === 'pre' ? 'a' : 'b').repeat(64)}`,
      imageRevision:
        phase === 'pre' ? CONTEXT_OPEN_FROZEN_COMMIT : 'dda63efdbe8d961fcc22417fdb3522126f8686f2',
      imageBuiltAt: phase === 'pre' ? '2026-08-25T00:00:00.000Z' : '2026-08-26T00:00:00.000Z',
      container: 'notarium-wt-399-notarium-1',
      dataRoot: 'context-open-data',
      baseUrl: 'https://context-open.test',
    },
    measured: 12,
    warmDashboard: spikedStats(10),
    warmGraphHealth: spikedStats(10),
    personalContext: spikedStats(10),
    projectContext: spikedStats(10),
    noteOpen: spikedStats(10),
    abilityEdit: {
      completed: phase === 'post',
      failure: phase === 'post' ? null : 'AbortError: This operation was aborted',
      timeoutMs: 1_000,
      targetRef: 'context-benchmark-ref',
      applied: phase === 'post' ? stats(20) : null,
      noOp: phase === 'post' ? stats(10) : null,
      conflict: phase === 'post' ? stats(10) : null,
      healthHeartbeat: { stats: heartbeatStats(40), failures: [] },
      raw:
        phase === 'post'
          ? Array.from({ length: 12 }, () => ({
              phase: 'measured' as const,
              applied: operation('applied'),
              noOp: operation('skipped'),
              conflict: operation('failed'),
            }))
          : [
              {
                phase: 'warmup' as const,
                applied: {
                  call: {
                    ms: 1_000,
                    status: null,
                    error: 'AbortError: This operation was aborted',
                  },
                  unrelatedNote: { ms: 2, status: 200 },
                  healthHeartbeat: [{ ms: 1, status: 200 }],
                },
              },
            ],
    },
    postAbilitySurfaces:
      phase === 'post'
        ? {
            noteOpen: stats(10),
            personalContext: stats(10),
            projectContext: stats(10),
            dashboard: stats(10),
            graphHealth: stats(10),
          }
        : null,
    gate: { baseline: null, failures: [], passed: true },
  }
}

describe('context-open benchmark gates', () => {
  it('uses nearest-rank p95 so one outlier in twelve is visible', () => {
    const measured = contextOpenStats([...samples(1, 11), 900])

    expect(measured.medianMs).toBe(1)
    expect(measured.p95Ms).toBe(900)
    expect(measured.maxMs).toBe(900)
  })

  it('requires a pre report and passes the complete bounded post report', () => {
    expect(contextOpenBenchmarkGateFailures(report('post'))).toEqual([
      'post phase requires BENCH_BASELINE',
      'baseline abilityEdit heartbeat stats are missing',
    ])
    expect(contextOpenBenchmarkGateFailures(report('post'), report('post'))).toContain(
      'BENCH_BASELINE must be a pre report',
    )
    expect(contextOpenBenchmarkGateFailures(report('post'), report('pre'))).toEqual([])
  })

  it('rejects unknown phases and a successful report relabelled as the baseline', () => {
    const unknown = report('post') as unknown as { phase: string }

    unknown.phase = 'psot'
    expect(
      contextOpenBenchmarkGateFailures(unknown as unknown as ContextOpenBenchmarkReport),
    ).toContain('unknown benchmark phase: psot')

    const relabelled = report('post')

    relabelled.phase = 'pre'
    const failures = contextOpenBenchmarkGateFailures(relabelled)
    expect(failures).toContain('pre phase must capture the frozen ability-edit failure')
    expect(failures).toContain(
      'pre phase must not claim post-edit surfaces after the frozen timeout',
    )
  })

  it('binds post comparison to the frozen commit, data root and base URL', () => {
    const post = report('post')
    const baseline = report('pre')

    post.provenance.commit = baseline.provenance.commit
    post.provenance.image = baseline.provenance.image
    post.provenance.dataRoot = 'other-root'
    post.provenance.baseUrl = 'https://other.test'
    const failures = contextOpenBenchmarkGateFailures(post, baseline)

    expect(failures).toContain('post commit must differ from the frozen baseline commit')
    expect(failures).toContain('post image must differ from the frozen baseline image')
    expect(failures).toContain('post and baseline must use the same data root')
    expect(failures).toContain('post and baseline must use the same base URL')
  })

  it('rejects a fabricated image and a non-timeout pre failure', () => {
    const baseline = report('pre')
    const post = report('post')

    baseline.abilityEdit.failure = 'MCP 500'
    baseline.abilityEdit.raw[0]!.applied.call.error = 'MCP 500'
    post.provenance.image = 'claimed-image'
    post.provenance.imageRevision = 'other-commit'
    const baselineFailures = contextOpenBenchmarkGateFailures(baseline)
    const postFailures = contextOpenBenchmarkGateFailures(post, report('pre'))

    expect(baselineFailures).toContain(
      'pre phase must capture the exact frozen AbortError: This operation was aborted',
    )
    expect(postFailures).toContain('benchmark provenance.image must be an observed sha256 digest')
    expect(postFailures).toContain('benchmark OCI revision must match runtime commit')
  })

  it('rejects a baseline that was not emitted unchanged by the pre harness', () => {
    const baseline = report('pre')

    delete baseline.gate
    expect(contextOpenBenchmarkGateFailures(report('post'), baseline)).toContain(
      'BENCH_BASELINE must be an unchanged passing pre harness output',
    )
  })

  it('fails closed on an incomplete edit and missing post surfaces', () => {
    const post = report('post')

    post.abilityEdit.completed = false
    post.abilityEdit.failure = 'timeout'
    post.abilityEdit.applied = null
    post.postAbilitySurfaces = null
    const failures = contextOpenBenchmarkGateFailures(post, report('pre'))

    expect(failures).toContain('abilityEdit did not complete: timeout')
    expect(failures).toContain('abilityEdit.applied is missing')
    expect(failures).toContain('postAbilitySurfaces is missing')

    post.abilityEdit.failure = null
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toContain(
      'abilityEdit did not complete: unknown failure',
    )
  })

  it('rejects absolute edit, heartbeat and relative surface regressions', () => {
    const post = report('post')

    post.abilityEdit.applied = contextOpenStats([...samples(10, 11), 1_000])
    post.abilityEdit.healthHeartbeat.stats = heartbeatStats(251)
    post.postAbilitySurfaces!.projectContext = stats(16)
    const failures = contextOpenBenchmarkGateFailures(post, report('pre'))

    expect(failures).toContain('abilityEdit.applied.p95Ms must be below 500 ms')
    expect(failures).toContain('abilityEdit.applied.maxMs must be below 1000 ms')
    expect(failures.some((failure) => failure.startsWith('projectContext.medianMs'))).toBe(true)
    expect(failures.some((failure) => failure.startsWith('abilityEdit heartbeat max'))).toBe(true)
  })

  it('rejects incomplete samples and failed concurrent probes', () => {
    const post = report('post')

    post.abilityEdit.applied = stats(20, 10)
    post.abilityEdit.noOp = stats(10, 11)
    post.abilityEdit.conflict = stats(10, 13)
    post.abilityEdit.raw[0]!.applied.unrelatedNote.status = 500
    post.abilityEdit.raw[1]!.applied.healthHeartbeat[0]!.status = null
    const failures = contextOpenBenchmarkGateFailures(post, report('pre'))

    expect(failures).toContain('abilityEdit.applied has 10 samples, expected 12')
    expect(failures).toContain('abilityEdit.noOp has 11 samples, expected 12')
    expect(failures).toContain('abilityEdit.conflict has 13 samples, expected 12')
    expect(failures).toContain('abilityEdit cycle 0 applied unrelated note failed')
    expect(failures).toContain('abilityEdit cycle 1 applied heartbeat failed')
  })

  // Provenance is the whole claim that the two reports describe the same stand on two
  // builds. A blank field is not a cosmetic gap: it is the field a hand-edited report
  // would leave empty, so each one is named on its own.
  it.each([
    'commit',
    'builtAt',
    'image',
    'imageRevision',
    'imageBuiltAt',
    'container',
    'dataRoot',
    'baseUrl',
  ] as const)('requires benchmark provenance.%s', (field) => {
    const post = report('post')

    post.provenance[field] = '   '
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toContain(
      `benchmark provenance.${field} is required`,
    )
  })

  it('names an unfilled image field once instead of also calling it a bad digest', () => {
    const post = report('post')

    post.provenance.image = ''
    const failures = contextOpenBenchmarkGateFailures(post, report('pre'))

    expect(failures).toContain('benchmark provenance.image is required')
    expect(failures).not.toContain('benchmark provenance.image must be an observed sha256 digest')
  })

  it('rejects an OCI created time that does not match the runtime build time', () => {
    const post = report('post')

    post.provenance.imageBuiltAt = '2026-08-27T00:00:00.000Z'
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toContain(
      'benchmark OCI created time must match runtime build time',
    )
  })

  it('binds the pre report to the frozen commit, timeout and seeded target', () => {
    const commit = report('pre')

    commit.provenance.commit = 'dda63efdbe8d961fcc22417fdb3522126f8686f2'
    commit.provenance.imageRevision = commit.provenance.commit
    expect(contextOpenBenchmarkGateFailures(commit)).toContain(
      `pre phase must use frozen commit ${CONTEXT_OPEN_FROZEN_COMMIT}`,
    )

    const timeout = report('pre')

    timeout.abilityEdit.timeoutMs = 5_000
    expect(contextOpenBenchmarkGateFailures(timeout)).toContain(
      'pre phase must use the 1000 ms correctness timeout',
    )

    const target = report('pre')

    target.abilityEdit.targetRef = '   '
    expect(contextOpenBenchmarkGateFailures(target)).toContain(
      'pre phase must identify the seeded ability target',
    )
  })

  it.each(['applied', 'noOp', 'conflict'] as const)(
    'rejects a pre report that publishes %s stats it never measured',
    (key) => {
      const pre = report('pre')

      pre.abilityEdit[key] = stats(20)
      expect(contextOpenBenchmarkGateFailures(pre)).toContain(
        'pre phase must not publish completed operation stats',
      )
    },
  )

  // The frozen baseline is ONE aborted applied edit and nothing else. Each mutation
  // below is a different way of dressing a richer run up as that baseline.
  it.each([
    [
      'a second cycle',
      (pre: ContextOpenBenchmarkReport) => {
        pre.abilityEdit.raw.push({ ...pre.abilityEdit.raw[0]! })
      },
    ],
    [
      'a measured phase',
      (pre: ContextOpenBenchmarkReport) => {
        pre.abilityEdit.raw[0]!.phase = 'measured'
      },
    ],
    [
      'a call that answered',
      (pre: ContextOpenBenchmarkReport) => {
        pre.abilityEdit.raw[0]!.applied.call.status = 200
      },
    ],
    [
      'a different raw failure',
      (pre: ContextOpenBenchmarkReport) => {
        pre.abilityEdit.raw[0]!.applied.call.error = 'TypeError: fetch failed'
      },
    ],
    [
      'a no-op the frozen build never reached',
      (pre: ContextOpenBenchmarkReport) => {
        pre.abilityEdit.raw[0]!.noOp = pre.abilityEdit.raw[0]!.applied
      },
    ],
    [
      'a conflict the frozen build never reached',
      (pre: ContextOpenBenchmarkReport) => {
        pre.abilityEdit.raw[0]!.conflict = pre.abilityEdit.raw[0]!.applied
      },
    ],
  ])('rejects a pre report carrying %s', (_label, mutate) => {
    const pre = report('pre')

    mutate(pre)
    expect(contextOpenBenchmarkGateFailures(pre)).toContain(
      'pre phase must contain the single frozen applied-timeout cycle',
    )
  })

  it('counts the measured cycles and reads the outcome of every call', () => {
    const post = report('post')

    post.abilityEdit.raw[0]!.phase = 'warmup'
    post.abilityEdit.raw[1]!.applied.call.status = 500
    post.abilityEdit.raw[2]!.noOp!.call.isError = true
    const failures = contextOpenBenchmarkGateFailures(post, report('pre'))

    expect(failures).toContain('abilityEdit has 11 measured cycles, expected 12')
    // Cycle 0 became a warmup, so the failing cycles shift down by one.
    expect(failures).toContain('abilityEdit cycle 0 applied call failed')
    expect(failures).toContain('abilityEdit cycle 1 noOp call failed')

    const extra = report('post')

    extra.abilityEdit.raw.push(extra.abilityEdit.raw[0]!)
    expect(contextOpenBenchmarkGateFailures(extra, report('pre'))).toContain(
      'abilityEdit has 13 measured cycles, expected 12',
    )
  })

  it.each([
    [
      'applied',
      'skipped',
      'document',
      'abilityEdit cycle 0 applied is not a document applied step',
    ],
    ['noOp', 'applied', 'document', 'abilityEdit cycle 0 noOp is not a document skipped step'],
    [
      'conflict',
      'applied',
      'document',
      'abilityEdit cycle 0 conflict is not a document failed step',
    ],
    [
      'applied',
      'applied',
      'metadata',
      'abilityEdit cycle 0 applied is not a document applied step',
    ],
  ] as const)('rejects a %s step reported as %s/%s', (key, outcome, step, expected) => {
    const post = report('post')

    post.abilityEdit.raw[0]![key]!.call.step = { outcome, step }
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toContain(expected)
  })

  it('rejects a whole series of steps that never did what their names say', () => {
    const post = report('post')

    for (const cycle of post.abilityEdit.raw) {
      for (const key of ['applied', 'noOp', 'conflict'] as const) {
        cycle[key]!.call.step = { outcome: 'failed', step: 'document' }
      }
    }

    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toHaveLength(24)
  })

  it('rejects failed liveness samples collected during the edit series', () => {
    const post = report('post')

    post.abilityEdit.healthHeartbeat.failures = [{ ms: 1_000, status: null, error: 'AbortError' }]
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toContain(
      'abilityEdit heartbeat has failed samples',
    )
  })

  // The baseline is validated as a pre report in its own right, not merely compared
  // against: a baseline that its own harness would have rejected proves nothing.
  it('validates the baseline recursively as a pre report', () => {
    const baseline = report('pre')

    baseline.abilityEdit.targetRef = '   '
    expect(contextOpenBenchmarkGateFailures(report('post'), baseline)).toContain(
      'pre phase must identify the seeded ability target',
    )
  })

  // Every baseline axis but the one under test is lifted out of range, so a surface
  // wired to the wrong axis reports nothing at all and the row goes red.
  it.each(Object.keys(BASELINE_AXIS) as Array<keyof typeof BASELINE_AXIS>)(
    'compares post surface %s against its own baseline axis',
    (surface) => {
      const post = report('post')
      const baseline = report('pre')

      for (const axis of Object.values(BASELINE_AXIS)) {
        if (axis !== BASELINE_AXIS[surface]) {
          baseline[axis] = stats(1_000)
        }
      }
      post.postAbilitySurfaces![surface] = stats(16)
      expect(contextOpenBenchmarkGateFailures(post, baseline)).toEqual([
        `${surface}.medianMs 16.000 ms exceeds 15.000 ms`,
      ])
    },
  )

  it('pins the post run to the 1000 ms correctness timeout', () => {
    const post = report('post')

    post.abilityEdit.timeoutMs = 5_000
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toContain(
      'post phase must use the 1000 ms correctness timeout',
    )
  })

  it('bounds the semantic no-op and the stale conflict like the applied edit', () => {
    const post = report('post')

    post.abilityEdit.noOp = stats(4_900)
    post.abilityEdit.conflict = contextOpenStats([...samples(10, 11), 1_000])
    const failures = contextOpenBenchmarkGateFailures(post, report('pre'))

    expect(failures).toContain('abilityEdit.noOp.p95Ms must be below 500 ms')
    expect(failures).toContain('abilityEdit.noOp.maxMs must be below 1000 ms')
    expect(failures).toContain('abilityEdit.conflict.maxMs must be below 1000 ms')
  })

  it('names a baseline that carries no ability-edit section', () => {
    const baseline = report('pre') as Partial<ContextOpenBenchmarkReport>

    delete baseline.abilityEdit
    const failures = contextOpenBenchmarkGateFailures(
      report('post'),
      baseline as ContextOpenBenchmarkReport,
    )

    expect(failures).toContain('pre report has no ability-edit section')
    expect(failures).toContain('baseline abilityEdit heartbeat stats are missing')
  })

  // A section that exists but carries no series is the other half of the same case:
  // without the shape check the gate dies of TypeError deep inside instead of naming
  // which half of the report the operator has to look at.
  it('names an ability-edit section that has no raw series and one with no probe list', () => {
    const rawless = report('pre')

    rawless.abilityEdit.raw = absent<AbilityEdit['raw']>()
    expect(contextOpenBenchmarkGateFailures(report('post'), rawless)).toContain(
      'pre report has no ability-edit section',
    )

    const probeless = report('post')

    probeless.abilityEdit.healthHeartbeat = absent<AbilityEdit['healthHeartbeat']>()
    expect(contextOpenBenchmarkGateFailures(probeless, report('pre'))).toContain(
      'post report has no ability-edit section',
    )
  })

  // The cheapest way to report a fast operation is not to measure it: publish `null`
  // stats and leave the operation out of every cycle. The budget loop skips a `null`
  // operation by design, so the omission has to be named twice over — once for the
  // absent stats, once for every cycle that never ran it.
  it.each(['applied', 'noOp', 'conflict'] as const)(
    'rejects a post report in which %s was never measured at all',
    (key) => {
      const post = report('post')

      post.abilityEdit[key] = null
      post.abilityEdit.raw = post.abilityEdit.raw.map((cycle) => withoutOperation(cycle, key))
      const failures = contextOpenBenchmarkGateFailures(post, report('pre'))

      expect(failures).toContain(`abilityEdit.${key} is missing`)
      expect(failures).toContain(`abilityEdit cycle 0 is missing ${key}`)
      expect(failures).toContain(`abilityEdit cycle 11 is missing ${key}`)
      expect(failures).toHaveLength(13)
    },
  )

  // Stats that are not numbers are the other way a series can be published without
  // being measured: `MEASURED=0` alone yields a `-Infinity` max out of `Math.max()`.
  it.each([
    ['medianMs', Number.NaN],
    ['p95Ms', Number.NaN],
    ['maxMs', Number.NaN],
    ['medianMs', -1],
    ['p95Ms', -1],
    ['maxMs', -1],
    ['medianMs', Number.POSITIVE_INFINITY],
    ['p95Ms', Number.POSITIVE_INFINITY],
    ['maxMs', Number.POSITIVE_INFINITY],
  ] as const)('rejects abilityEdit.applied.%s reported as %s', (metric, value) => {
    const post = report('post')
    const applied = stats(20)

    applied[metric] = value
    post.abilityEdit.applied = applied
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toContain(
      `abilityEdit.applied.${metric} is invalid`,
    )
  })

  it('reports zero percentiles for an empty sample set', () => {
    const empty = contextOpenStats([])

    expect(empty.medianMs).toBe(0)
    expect(empty.p95Ms).toBe(0)
    expect(Number.isFinite(empty.maxMs)).toBe(false)
  })

  it('names a post report that publishes no heartbeat stats', () => {
    const post = report('post')

    post.abilityEdit.healthHeartbeat.stats = null
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toContain(
      'abilityEdit heartbeat stats are missing',
    )
  })

  // The heartbeat limit is a 100 ms headroom over the baseline with a 250 ms floor.
  // Both terms carry weight: the floor keeps a quiet baseline from turning normal
  // jitter into a regression, the headroom keeps a busy one from hiding a real one.
  it('gives the heartbeat a 100 ms headroom over a 250 ms floor', () => {
    const quiet = report('post')

    quiet.abilityEdit.healthHeartbeat.stats = heartbeatStats(250)
    expect(contextOpenBenchmarkGateFailures(quiet, report('pre'))).toEqual([])

    const busy = report('post')
    const busyBaseline = report('pre')

    busyBaseline.abilityEdit.healthHeartbeat.stats = heartbeatStats(400)
    busy.abilityEdit.healthHeartbeat.stats = heartbeatStats(500)
    expect(contextOpenBenchmarkGateFailures(busy, busyBaseline)).toEqual([])

    busy.abilityEdit.healthHeartbeat.stats = heartbeatStats(501)
    expect(contextOpenBenchmarkGateFailures(busy, busyBaseline)).toEqual([
      'abilityEdit heartbeat max 501.000 ms exceeds 500.000 ms',
    ])
  })

  // One blocked stretch in a run of sixty-odd probes is the symptom itself, and it
  // never reaches a percentile taken over the quiet ones — on either side of the
  // comparison.
  it('reads the heartbeat by its worst sample, not by its typical one', () => {
    const blocked = report('post')

    blocked.abilityEdit.healthHeartbeat.stats = heartbeatStats(300)
    expect(contextOpenBenchmarkGateFailures(blocked, report('pre'))).toEqual([
      'abilityEdit heartbeat max 300.000 ms exceeds 250.000 ms',
    ])

    const busy = report('post')
    const busyBaseline = report('pre')

    busyBaseline.abilityEdit.healthHeartbeat.stats = heartbeatStats(400)
    busy.abilityEdit.healthHeartbeat.stats = heartbeatStats(450)
    expect(contextOpenBenchmarkGateFailures(busy, busyBaseline)).toEqual([])
  })

  it('validates post and baseline surface stats before it compares them', () => {
    const post = report('post')
    const baseline = report('pre')

    post.postAbilitySurfaces!.noteOpen = absent<ContextOpenStats>()
    post.postAbilitySurfaces!.dashboard = stats(10, 11)
    baseline.warmGraphHealth = absent<ContextOpenStats>()
    baseline.personalContext = stats(10, 11)
    const failures = contextOpenBenchmarkGateFailures(post, baseline)

    expect(failures).toContain('post noteOpen is missing')
    expect(failures).toContain('post dashboard has 11 samples, expected 12')
    expect(failures).toContain('baseline graphHealth is missing')
    expect(failures).toContain('baseline personalContext has 11 samples, expected 12')
  })

  // A surface axis is judged by its median alone. At MEASURED=12 nearest-rank p95 IS
  // the single worst sample, whose swing between runs of one unchanged image is wider
  // than the allowance — a lone slow sample is what the stand does, not a regression.
  it('lets a lone surface outlier past and judges the median', () => {
    const post = report('post')

    post.postAbilitySurfaces!.noteOpen = contextOpenStats([...samples(10, 11), 2_000])
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toEqual([])

    post.postAbilitySurfaces!.noteOpen = contextOpenStats([...samples(16, 11), 2_000])
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toEqual([
      'noteOpen.medianMs 16.000 ms exceeds 15.000 ms',
    ])
  })

  // The regression limit is the GREATER of 20 % and 5 ms. Drop either term and the
  // gate starts failing runs that never regressed.
  it('allows a surface inside the greater of five milliseconds and twenty percent', () => {
    const small = report('post')

    small.postAbilitySurfaces!.noteOpen = stats(15)
    expect(
      contextOpenBenchmarkGateFailures(small, report('pre')).some((failure) =>
        failure.startsWith('noteOpen.'),
      ),
    ).toBe(false)

    const large = report('post')
    const largeBaseline = report('pre')

    largeBaseline.projectContext = stats(100)
    large.postAbilitySurfaces!.projectContext = stats(120)
    expect(
      contextOpenBenchmarkGateFailures(large, largeBaseline).some((failure) =>
        failure.startsWith('projectContext.'),
      ),
    ).toBe(false)

    large.postAbilitySurfaces!.projectContext = stats(121)
    expect(contextOpenBenchmarkGateFailures(large, largeBaseline)).toContain(
      'projectContext.medianMs 121.000 ms exceeds 120.000 ms',
    )
  })

  // `gate` is the harness's own verdict on the baseline. A file that carries failures
  // it declared passing, or that was itself produced against another baseline, is not
  // the unchanged pre output the post comparison claims to stand on.
  it.each([
    ['failures it declared passing', { baseline: null, failures: ['edited away'], passed: true }],
    ['a baseline of its own', { baseline: '/tmp/other-pre.json', failures: [], passed: true }],
    ['its own harness verdict of failed', { baseline: null, failures: [], passed: false }],
  ] as const)('rejects a baseline carrying %s', (_label, gate) => {
    const baseline = report('pre')

    baseline.gate = { ...gate, failures: [...gate.failures] }
    expect(contextOpenBenchmarkGateFailures(report('post'), baseline)).toContain(
      'BENCH_BASELINE must be an unchanged passing pre harness output',
    )
  })

  // The digest is the one provenance field a hand-written report cannot invent from
  // the numbers around it, so the shape docker prints is the whole of what passes.
  it.each([
    'claimed-image',
    'sha256:',
    `sha256:${'a'.repeat(63)}`,
    `sha256:${'a'.repeat(65)}`,
    `sha256:${'A'.repeat(64)}`,
    `sha256:${'g'.repeat(64)}`,
    'a'.repeat(64),
    `sha256:${'a'.repeat(64)} `,
  ])('rejects provenance.image %s as an unobserved digest', (image) => {
    const post = report('post')

    post.provenance.image = image
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toContain(
      'benchmark provenance.image must be an observed sha256 digest',
    )
  })

  // Both budgets are exclusive bounds, and at MEASURED=12 nearest-rank p95 IS the max:
  // the 1 s bound therefore never fires on its own, and the 500 ms one does the work.
  it('bounds every operation at exactly 500 ms p95 and 1000 ms max', () => {
    const under = report('post')

    under.abilityEdit.applied = stats(499.999)
    expect(contextOpenBenchmarkGateFailures(under, report('pre'))).toEqual([])

    const atBudget = report('post')

    atBudget.abilityEdit.applied = stats(500)
    expect(contextOpenBenchmarkGateFailures(atBudget, report('pre'))).toEqual([
      'abilityEdit.applied.p95Ms must be below 500 ms',
    ])

    const underBound = report('post')

    underBound.abilityEdit.applied = stats(999.999)
    expect(contextOpenBenchmarkGateFailures(underBound, report('pre'))).toEqual([
      'abilityEdit.applied.p95Ms must be below 500 ms',
    ])

    const atBound = report('post')

    atBound.abilityEdit.applied = stats(1_000)
    expect(contextOpenBenchmarkGateFailures(atBound, report('pre'))).toEqual([
      'abilityEdit.applied.p95Ms must be below 500 ms',
      'abilityEdit.applied.maxMs must be below 1000 ms',
    ])
  })

  // Zero is a measurement, not a missing one.
  it('accepts an operation series that measured zero milliseconds', () => {
    const post = report('post')

    post.abilityEdit.applied = stats(0)
    expect(contextOpenBenchmarkGateFailures(post, report('pre'))).toEqual([])
  })

  // The POST run's sample count is the authority on both sides of the comparison: a
  // baseline that declares a shorter series does not get to be measured by it.
  it('holds the baseline surfaces to the post report sample count', () => {
    const post = report('post')
    const baseline = report('pre')

    baseline.measured = 11
    baseline.noteOpen = stats(10, 11)
    expect(contextOpenBenchmarkGateFailures(post, baseline)).toContain(
      'baseline noteOpen has 11 samples, expected 12',
    )
  })
})

describe('context-open benchmark stand identity', () => {
  const observed = {
    builtAt: '2026-08-26T00:00:00.000Z',
    health: 'healthy',
    image: `sha256:${'b'.repeat(64)}`,
    revision: 'dda63efdbe8d961fcc22417fdb3522126f8686f2',
    running: true,
  }
  const declared = { container: 'notarium-wt-399-notarium-1', image: observed.image }
  const runtime = { builtAt: observed.builtAt, commit: observed.revision }

  it('passes a healthy container serving the declared build', () => {
    expect(contextOpenContainerFailures(declared, observed)).toEqual([])
    expect(contextOpenRuntimeFailures({ commit: observed.revision }, observed, runtime)).toEqual([])
  })

  it.each([
    ['is stopped', { running: false }],
    ['is not healthy yet', { health: 'starting' }],
    ['reports no health at all', { health: undefined }],
  ] as const)('refuses a container that %s', (_label, patch) => {
    expect(contextOpenContainerFailures(declared, { ...observed, ...patch })).toEqual([
      `BENCH_CONTAINER ${declared.container} is not a healthy running container`,
    ])
  })

  it('names the declared image against the one the container runs', () => {
    const other = `sha256:${'c'.repeat(64)}`

    expect(contextOpenContainerFailures(declared, { ...observed, image: other })).toEqual([
      `BENCH_IMAGE ${declared.image} does not match running container image ${other}`,
    ])
    expect(contextOpenContainerFailures(declared, { ...observed, image: undefined })).toEqual([
      `BENCH_IMAGE ${declared.image} does not match running container image none`,
    ])
  })

  // An unset BENCH_IMAGE arrives here as an empty string. The env check that names it
  // first is a message, not the boundary: an undeclared image is still a mismatch.
  it('refuses an undeclared image instead of matching it against nothing', () => {
    expect(
      contextOpenContainerFailures({ ...declared, image: '' }, { ...observed, image: '' }),
    ).toEqual(['BENCH_IMAGE  does not match running container image '])
  })

  it.each([
    ['revision', { revision: undefined }],
    ['created time', { builtAt: undefined }],
  ] as const)('refuses an image whose OCI %s label is missing', (_label, patch) => {
    expect(contextOpenContainerFailures(declared, { ...observed, ...patch })).toEqual([
      'running container image has no OCI revision/created provenance',
    ])
  })

  it.each([
    ['commit', { commit: null }],
    ['build time', { builtAt: null }],
  ] as const)('refuses a runtime that exposes no %s', (_label, patch) => {
    expect(
      contextOpenRuntimeFailures({ commit: observed.revision }, observed, { ...runtime, ...patch }),
    ).toEqual(['serving runtime does not expose a commit-bound production build'])
  })

  it('names the declared commit, the OCI revision and the OCI created time', () => {
    expect(contextOpenRuntimeFailures({ commit: 'other-commit' }, observed, runtime)).toEqual([
      `BENCH_COMMIT other-commit does not match serving runtime ${runtime.commit}`,
    ])
    expect(
      contextOpenRuntimeFailures(
        { commit: runtime.commit },
        { ...observed, revision: 'stale-revision' },
        runtime,
      ),
    ).toEqual([`OCI revision stale-revision does not match serving runtime ${runtime.commit}`])
    expect(
      contextOpenRuntimeFailures(
        { commit: runtime.commit },
        { ...observed, builtAt: '2020-01-01T00:00:00.000Z' },
        runtime,
      ),
    ).toEqual([
      `OCI created 2020-01-01T00:00:00.000Z does not match serving runtime ${runtime.builtAt}`,
    ])
  })

  // Labels absent altogether are the container check's finding; restating them here
  // as mismatches against `undefined` would name one fault three times over.
  it('leaves an image with no OCI labels to the container check', () => {
    expect(
      contextOpenRuntimeFailures(
        { commit: runtime.commit },
        { ...observed, builtAt: undefined, revision: undefined },
        runtime,
      ),
    ).toEqual([])
  })
})
