import { describe, expect, it } from 'vitest'

import {
  CONTEXT_SET_COST_FROZEN_COMMIT,
  contextSetCostBenchmarkGateFailures,
  type ContextSetCostBenchmarkReport,
  contextSetCostStats,
} from '../../scripts/contextSetCostBenchGates'

const stats = (value: number, count = 8) =>
  contextSetCostStats(Array.from({ length: count }, () => value))

const report = (phase: 'pre' | 'post'): ContextSetCostBenchmarkReport => ({
  phase,
  provenance: {
    commit: phase === 'pre' ? CONTEXT_SET_COST_FROZEN_COMMIT : 'a'.repeat(40),
    builtAt: phase === 'pre' ? '2026-08-29T00:00:00Z' : '2026-08-30T00:00:00Z',
    image: `sha256:${(phase === 'pre' ? 'b' : 'c').repeat(64)}`,
    imageRevision: phase === 'pre' ? CONTEXT_SET_COST_FROZEN_COMMIT : 'a'.repeat(40),
    imageBuiltAt: phase === 'pre' ? '2026-08-29T00:00:00Z' : '2026-08-30T00:00:00Z',
    container: 'notarium-406',
    dataRoot: 'same-data',
    baseUrl: 'https://context-cost.test',
  },
  measured: 8,
  manager: stats(10),
  reorder: stats(10),
  eager: stats(10),
  idleHeartbeat: stats(2),
  bulk:
    phase === 'pre'
      ? { available: false, absentStatus: 404, samples: [] }
      : {
          available: true,
          samples: Array.from({ length: 8 }, (_, index) => ({
            setId: `fresh-${index}`,
            status: 200,
            added: 1000,
            failed: 0,
            items: 1000,
            ms: 30,
            requestStartedAt: 1_000,
            requestEndedAt: 1_030,
            serverStartedAt: 2_000,
            serverEndedAt: 2_030,
            heartbeat: [5, 15, 25].map((offset) => ({
              ms: 3,
              status: 200,
              startedAt: 995 + offset,
              endedAt: 998 + offset,
              serverStartedAt: 2_000 + offset,
              serverEndedAt: 2_003 + offset,
            })),
          })),
        },
  gate: { baseline: null, failures: [], passed: true },
})

describe('context-set cost benchmark gates', () => {
  it('accepts the frozen absent-operation pre and applied fresh-set post', () => {
    expect(contextSetCostBenchmarkGateFailures(report('pre'))).toEqual([])
    expect(contextSetCostBenchmarkGateFailures(report('post'), report('pre'))).toEqual([])
  })

  it('rejects a relabelled baseline and missing post baseline', () => {
    const relabelled = report('post')
    relabelled.phase = 'pre'
    expect(contextSetCostBenchmarkGateFailures(relabelled)).toContain(
      `pre phase must use frozen commit ${CONTEXT_SET_COST_FROZEN_COMMIT}`,
    )
    expect(contextSetCostBenchmarkGateFailures(report('post'))).toContain(
      'post phase requires BENCH_BASELINE',
    )
  })

  it('requires applied 1000-ref writes on distinct fresh sets and live heartbeat', () => {
    const post = report('post')
    post.bulk.samples[1].setId = post.bulk.samples[0].setId
    post.bulk.samples[2].added = 999
    post.bulk.samples[3].heartbeat[0].status = null
    const failures = contextSetCostBenchmarkGateFailures(post, report('pre'))

    expect(failures).toContain('every bulk sample must use a fresh set')
    expect(failures).toContain('bulk sample 2 did not apply 1000 refs')
    expect(failures).toContain('bulk sample 3 heartbeat failed')
  })

  it('binds data provenance and the idle-heartbeat envelope', () => {
    const post = report('post')
    post.provenance.dataRoot = 'other-data'
    post.bulk.samples[0].heartbeat[0].serverEndedAt =
      post.bulk.samples[0].heartbeat[0].serverStartedAt + 40
    const failures = contextSetCostBenchmarkGateFailures(post, report('pre'))

    expect(failures).toContain('post and baseline must use the same data root')
    expect(failures.some((failure) => failure.startsWith('bulk heartbeat server max'))).toBe(true)
  })

  it('does not confuse client scheduling delay with a fast covered server heartbeat', () => {
    const post = report('post')

    post.bulk.samples[0].heartbeat[0].ms = 60
    expect(contextSetCostBenchmarkGateFailures(post, report('pre'))).toEqual([])
  })

  it('rejects an empty measurement and forged derived statistics', () => {
    const pre = report('pre')
    pre.measured = 0
    pre.manager = contextSetCostStats([])
    pre.reorder = contextSetCostStats([])
    pre.eager = contextSetCostStats([])
    pre.idleHeartbeat = contextSetCostStats([])
    expect(contextSetCostBenchmarkGateFailures(pre)).toContain(
      'benchmark measured must be a positive integer',
    )

    const forged = report('post')
    forged.eager.rawMs[0] = 1_000
    expect(contextSetCostBenchmarkGateFailures(forged, report('pre'))).toContain(
      'eager.p95Ms does not match rawMs',
    )
  })

  it('requires an observed heartbeat for every applied bulk sample', () => {
    const post = report('post')
    post.bulk.samples[3].heartbeat = []

    expect(contextSetCostBenchmarkGateFailures(post, report('pre'))).toContain(
      'bulk sample 3 must have repeated heartbeat samples',
    )
  })

  it('rejects a malformed heartbeat duration instead of coercing it through Math.max', () => {
    const post = report('post')
    ;(post.bulk.samples[2].heartbeat[0] as { ms: unknown }).ms = null

    expect(contextSetCostBenchmarkGateFailures(post, report('pre'))).toContain(
      'bulk sample 2 has an invalid heartbeat duration',
    )
  })

  it.each([null, 0, -1, Number.NaN])('rejects malformed bulk duration %s', (duration) => {
    const post = report('post')
    ;(post.bulk.samples[1] as { ms: unknown }).ms = duration

    expect(contextSetCostBenchmarkGateFailures(post, report('pre'))).toContain(
      'bulk sample 1 has an invalid duration',
    )
  })

  it.each([0, -1, Number.NaN])('rejects malformed heartbeat duration %s', (duration) => {
    const post = report('post')

    post.bulk.samples[1].heartbeat[0].ms = duration
    expect(contextSetCostBenchmarkGateFailures(post, report('pre'))).toContain(
      'bulk sample 1 has an invalid heartbeat duration',
    )
  })

  it('requires valid client/server intervals and server-observed heartbeat overlap', () => {
    const post = report('post')

    post.bulk.samples[0].requestEndedAt = post.bulk.samples[0].requestStartedAt
    post.bulk.samples[1].serverEndedAt = post.bulk.samples[1].serverStartedAt
    post.bulk.samples[2].heartbeat[0].serverStartedAt = 1_900
    post.bulk.samples[2].heartbeat[0].serverEndedAt = 1_903
    post.bulk.samples[2].heartbeat[1].serverStartedAt = 1_910
    post.bulk.samples[2].heartbeat[1].serverEndedAt = 1_913
    post.bulk.samples[2].heartbeat[2].serverStartedAt = 1_920
    post.bulk.samples[2].heartbeat[2].serverEndedAt = 1_923
    const failures = contextSetCostBenchmarkGateFailures(post, report('pre'))

    expect(failures).toContain('bulk sample 0 has an invalid request interval')
    expect(failures).toContain('bulk sample 1 has an invalid server interval')
    expect(failures).toContain('bulk sample 2 has no server-overlapping heartbeat')
  })

  it('requires repeated heartbeats and derives duration from the exact request interval', () => {
    const post = report('post')

    post.bulk.samples[0].heartbeat = post.bulk.samples[0].heartbeat.slice(0, 1)
    post.bulk.samples[1].ms = 29
    const failures = contextSetCostBenchmarkGateFailures(post, report('pre'))

    expect(failures).toContain('bulk sample 0 must have repeated heartbeat samples')
    expect(failures).toContain('bulk sample 1 duration does not match its request interval')
  })

  it('accepts a repeated worker sequence when a short operation contains only its first pulse', () => {
    const post = report('post')

    post.bulk.samples[0].heartbeat = [
      post.bulk.samples[0].heartbeat[0],
      {
        ...post.bulk.samples[0].heartbeat[1],
        startedAt: 1_035,
        endedAt: 1_038,
        serverStartedAt: 2_035,
        serverEndedAt: 2_038,
      },
    ]

    expect(contextSetCostBenchmarkGateFailures(post, report('pre'))).toEqual([])
  })

  it('rejects a long unobserved handler tail after healthy early heartbeats', () => {
    const post = report('post')

    for (const sample of post.bulk.samples) {
      sample.serverEndedAt += 5_000
      sample.requestEndedAt += 5_000
      sample.ms += 5_000
    }
    const failures = contextSetCostBenchmarkGateFailures(post, report('pre'))

    expect(failures.some((failure) => failure.includes('heartbeat coverage gap'))).toBe(true)
  })

  it('rejects starvation after request receipt but before route-handler entry', () => {
    const post = report('post')

    for (const sample of post.bulk.samples) {
      // `serverStartedAt` is captured by onRequest before body parsing/auth. A CPU
      // stall there must therefore appear as an uncovered leading server gap.
      sample.serverStartedAt -= 5_000
      sample.requestStartedAt -= 5_000
      sample.ms += 5_000
    }
    const failures = contextSetCostBenchmarkGateFailures(post, report('pre'))

    expect(failures.some((failure) => failure.includes('heartbeat coverage gap'))).toBe(true)
  })

  it('rejects length-correct zero timings as missing measurement evidence', () => {
    const pre = report('pre')

    pre.manager = stats(0)
    pre.reorder = stats(0)
    pre.eager = stats(0)
    pre.idleHeartbeat = stats(0)

    expect(contextSetCostBenchmarkGateFailures(pre)).toEqual(
      expect.arrayContaining([
        'manager.rawMs contains an invalid sample',
        'reorder.rawMs contains an invalid sample',
        'eager.rawMs contains an invalid sample',
        'idleHeartbeat.rawMs contains an invalid sample',
      ]),
    )
  })

  it('keeps endpoint latency observational instead of inventing a portable threshold', () => {
    const post = report('post')

    post.manager = stats(10_000)
    post.reorder = stats(10_000)
    post.eager = stats(10_000)

    expect(contextSetCostBenchmarkGateFailures(post, report('pre'))).toEqual([])
  })

  it('rejects a post population smaller than baseline but permits a wider extended run', () => {
    const baseline = report('pre')
    const narrow = report('post')

    narrow.measured = 1
    narrow.manager = stats(10, 1)
    narrow.reorder = stats(10, 1)
    narrow.eager = stats(10, 1)
    narrow.idleHeartbeat = stats(2, 1)
    narrow.bulk.samples = narrow.bulk.samples.slice(0, 1)
    expect(contextSetCostBenchmarkGateFailures(narrow, baseline)).toContain(
      'post measured population must not be smaller than the baseline',
    )

    const extended = report('post')

    extended.measured = 12
    extended.manager = stats(10, 12)
    extended.reorder = stats(10, 12)
    extended.eager = stats(10, 12)
    extended.idleHeartbeat = stats(2, 12)
    extended.bulk.samples = Array.from({ length: 12 }, (_, index) => ({
      ...extended.bulk.samples[index % 8],
      setId: `extended-${index}`,
    }))
    expect(contextSetCostBenchmarkGateFailures(extended, baseline)).toEqual([])
  })
})
