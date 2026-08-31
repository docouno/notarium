import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  benchmarkGateFailures,
  type BenchmarkGateProbe,
  type BenchmarkGateReport,
  type BenchmarkGateTraceProbe,
} from '../../scripts/benchSessionAuditGates'

const DRIVERS = ['sqlite', 'postgres'] as const
const DATASETS = [10_000, 100_000, 500_000] as const
const SCOPES = ['all', 'outside', 'session'] as const
const FILTERS = ['all', 'reads', 'writes'] as const
const PAGES = ['first', 'next'] as const
const PROBES: BenchmarkGateProbe['kind'][] = [
  'detail',
  'agent',
  'retrieval-order',
  'outside-reads',
  'outside-writes',
]
const TRACE_PROBES: BenchmarkGateTraceProbe['kind'][] = [
  'compact-write',
  'detailed-write',
  'maintenance',
  'dense-export',
]

const report = (over: Partial<BenchmarkGateReport> = {}): BenchmarkGateReport => {
  const phase = over.phase ?? 'post'
  return {
    phase,
    gitCommit: phase === 'pre' ? 'base-commit' : 'post-commit',
    gitTree: phase === 'pre' ? 'base-tree' : 'post-tree',
    cells: DRIVERS.flatMap((driver) =>
      DATASETS.flatMap((dataset) =>
        SCOPES.flatMap((scope) =>
          FILTERS.flatMap((filter) =>
            PAGES.map((page) => ({
              driver,
              dataset,
              scope,
              filter,
              page,
              mode: 'production' as const,
              medianMs: 1,
            })),
          ),
        ),
      ),
    ),
    probes: DRIVERS.flatMap((driver) =>
      DATASETS.flatMap((dataset) => PROBES.map((kind) => ({ driver, dataset, kind, medianMs: 1 }))),
    ),
    aggregatePairs: DRIVERS.flatMap((driver) =>
      DATASETS.map((dataset) => ({
        driver,
        dataset,
        disabledMedianMs: 1,
        enabledMedianMs: 2,
        ratio: 2,
      })),
    ),
    traceProbes: DRIVERS.flatMap((driver) =>
      DATASETS.flatMap((dataset) =>
        TRACE_PROBES.map((kind) => ({
          driver,
          dataset,
          kind,
          rows: kind === 'dense-export' ? dataset : 1,
          medianMs: 1,
          ...(kind === 'maintenance'
            ? {
                rows: dataset,
                components: {
                  passes: 2,
                  maxPassMs: 1,
                  p99PassMs: 1,
                  processed: dataset,
                  remaining: 0,
                  yields: 1,
                },
              }
            : {}),
        })),
      ),
    ),
    storageProbes: DRIVERS.flatMap((driver) =>
      DATASETS.flatMap((dataset) =>
        (['compact', 'detailed'] as const).map((mode) => {
          const bytesPerRow = mode === 'compact' ? 1_000 : 1_500
          return {
            driver,
            dataset,
            mode,
            method: driver === 'sqlite' ? 'sqlite-json-payload-v1' : 'postgres-row-size-v1',
            rows: 25,
            bytes: bytesPerRow * 25,
            bytesPerRow,
          }
        }),
      ),
    ),
    ...over,
  }
}

describe('session audit benchmark gates', () => {
  it('keeps both bulk revision seeders on the final mandatory row contract', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../scripts/benchSessionAudit.ts', import.meta.url)),
      'utf8',
    )
    const inserts = [...source.matchAll(/INSERT INTO note_revisions\s*\(([^)]*)\)/g)].map((match) =>
      match[1]!.split(',').map((column) => column.trim()),
    )

    expect(inserts).toHaveLength(2)
    for (const columns of inserts) {
      expect(columns).toEqual(expect.arrayContaining(['entry_role', 'state_format', 'integrity']))
    }
  })

  it('requires a real baseline for the post phase', () => {
    expect(benchmarkGateFailures(report())).toContain('post phase requires BENCH_BASELINE')
  })

  it('rejects a stale or non-production baseline', () => {
    const wrongPhase = benchmarkGateFailures(report(), report({ phase: 'post' }))
    const diagnostic = report({ phase: 'pre' })
    const cell = diagnostic.cells.find(
      (candidate) => candidate.driver === 'sqlite' && candidate.scope === 'session',
    )!
    cell.mode = 'diagnostic-reference'

    expect(wrongPhase).toContain('BENCH_BASELINE must be a pre report')
    expect(benchmarkGateFailures(report(), diagnostic)).toContain(
      `baseline used diagnostic-reference for ${cell.driver}:${cell.dataset}:${cell.scope}/${cell.filter}/${cell.page}`,
    )
  })

  it('fails closed on empty or incomplete reports', () => {
    const baseline = report({ phase: 'pre' })
    const empty = benchmarkGateFailures(
      report({ cells: [], probes: [], traceProbes: [], storageProbes: [] }),
      baseline,
    )
    expect(empty).toContain('post report is missing benchmark cells')
    expect(empty).toContain('post report is missing benchmark probes')
    expect(
      empty.some((failure) => failure.startsWith('post report is missing storage probe')),
    ).toBe(true)

    const incomplete = report()
    incomplete.cells.pop()
    incomplete.probes.pop()
    incomplete.traceProbes!.pop()
    const failures = benchmarkGateFailures(incomplete, baseline)
    expect(failures.some((failure) => failure.startsWith('post report is missing cell '))).toBe(
      true,
    )
    expect(failures.some((failure) => failure.startsWith('post report is missing probe '))).toBe(
      true,
    )
  })

  it('rejects duplicate, unexpected and incomplete baseline keys', () => {
    const post = report()
    post.cells.push({ ...post.cells[0]! })
    post.probes.push({ ...post.probes[0]! })
    post.cells[1] = { ...post.cells[1]!, driver: 'other' }
    const baseline = report({ phase: 'pre' })
    baseline.cells.pop()
    baseline.probes.pop()
    const failures = benchmarkGateFailures(post, baseline)

    expect(failures.some((failure) => failure.startsWith('post report has duplicate cell '))).toBe(
      true,
    )
    expect(failures.some((failure) => failure.startsWith('post report has duplicate probe '))).toBe(
      true,
    )
    expect(failures.some((failure) => failure.startsWith('post report has unexpected cell '))).toBe(
      true,
    )
    expect(failures.some((failure) => failure.startsWith('baseline report is missing cell '))).toBe(
      true,
    )
    expect(
      failures.some((failure) => failure.startsWith('baseline report is missing probe ')),
    ).toBe(true)
  })

  it('fails diagnostic fallbacks and history-proportional probes', () => {
    const post = report()
    post.cells[0]!.mode = 'diagnostic-reference'
    const lastDetail = post.probes.find(
      (probe) => probe.driver === 'sqlite' && probe.dataset === 500_000 && probe.kind === 'detail',
    )!
    lastDetail.medianMs = 12.01
    const failures = benchmarkGateFailures(post, report({ phase: 'pre' }))

    expect(failures.some((failure) => failure.includes('diagnostic-reference'))).toBe(true)
    expect(failures.some((failure) => failure.includes('probe sqlite:detail history ratio'))).toBe(
      true,
    )
  })

  it('fails a greater-than-two regression and accepts the complete bounded report', () => {
    const baseline = report({ phase: 'pre' })
    const regressed = report()
    const cell = regressed.cells.find(
      (candidate) =>
        candidate.driver === 'sqlite' &&
        candidate.dataset === 500_000 &&
        candidate.scope === 'session' &&
        candidate.filter === 'all' &&
        candidate.page === 'first',
    )!
    cell.medianMs = 7.01

    expect(
      benchmarkGateFailures(regressed, baseline).some((failure) =>
        failure.includes('regression sqlite:500000:session:all:first'),
      ),
    ).toBe(true)
    expect(benchmarkGateFailures(report(), baseline)).toEqual([])
  })

  it('rejects stale identity and unbounded trace write, maintenance and export probes', () => {
    const baseline = report({ phase: 'pre' })
    const post = report({ gitCommit: baseline.gitCommit, gitTree: baseline.gitTree })
    post.traceProbes!.find((probe) => probe.kind === 'compact-write')!.medianMs = 101
    post.traceProbes!.find((probe) => probe.kind === 'maintenance')!.components!.p99PassMs = 1_001
    post.traceProbes!.find(
      (probe) => probe.driver === 'postgres' && probe.kind === 'maintenance',
    )!.components!.maxPassMs = 5_001
    const exported = post.traceProbes!.find((probe) => probe.kind === 'dense-export')!
    exported.rows = exported.dataset - 1
    exported.medianMs = exported.rows
    post.aggregatePairs![0]!.enabledMedianMs = 1_001
    const oversized = post.storageProbes!.find((probe) => probe.mode === 'compact')!
    oversized.bytesPerRow = 20_000
    oversized.bytes = oversized.rows * oversized.bytesPerRow
    const failures = benchmarkGateFailures(post, baseline)

    expect(failures).toContain('post and baseline report the same git commit')
    expect(failures).toContain('post and baseline report the same git tree')
    expect(failures.some((failure) => failure.includes('compact-write'))).toBe(true)
    expect(failures.some((failure) => failure.includes('maintenance'))).toBe(true)
    expect(failures.some((failure) => failure.includes('exported fewer rows'))).toBe(true)
    expect(failures.some((failure) => failure.includes('ms/1k rows'))).toBe(true)
    expect(failures.some((failure) => failure.includes('aggregates'))).toBe(true)
    expect(failures.some((failure) => failure.includes('storage probe'))).toBe(true)
  })

  it('compares an established aggregate cost to baseline without blessing a new regression', () => {
    const baseline = report({ phase: 'pre' })
    const before = baseline.aggregatePairs!.find(
      (pair) => pair.driver === 'sqlite' && pair.dataset === 500_000,
    )!
    before.enabledMedianMs = 2_500
    const withinBaseline = report()
    withinBaseline.aggregatePairs!.find(
      (pair) => pair.driver === 'sqlite' && pair.dataset === 500_000,
    )!.enabledMedianMs = 2_600
    const regressed = structuredClone(withinBaseline)
    regressed.aggregatePairs!.find(
      (pair) => pair.driver === 'sqlite' && pair.dataset === 500_000,
    )!.enabledMedianMs = 3_100

    expect(benchmarkGateFailures(withinBaseline, baseline)).toEqual([])
    expect(
      benchmarkGateFailures(regressed, baseline).some((failure) =>
        failure.includes('post aggregate sqlite:500000:aggregates'),
      ),
    ).toBe(true)

    const absoluteRegression = report()
    baseline.aggregatePairs!.find(
      (pair) => pair.driver === 'postgres' && pair.dataset === 500_000,
    )!.enabledMedianMs = 250
    absoluteRegression.aggregatePairs!.find(
      (pair) => pair.driver === 'postgres' && pair.dataset === 500_000,
    )!.enabledMedianMs = 301
    expect(
      benchmarkGateFailures(absoluteRegression, baseline).some((failure) =>
        failure.includes('post aggregate postgres:500000:aggregates'),
      ),
    ).toBe(true)
  })

  it('fails closed on malformed benchmark medians before calculating ratios', () => {
    const invalidPost = report()
    invalidPost.probes[0]!.medianMs = null as unknown as number
    invalidPost.probes[1]!.medianMs = Number.POSITIVE_INFINITY
    const invalidBaseline = report({ phase: 'pre' })
    invalidBaseline.cells[0]!.medianMs = -1
    invalidBaseline.probes[0]!.medianMs = null as unknown as number

    expect(benchmarkGateFailures(invalidPost, report({ phase: 'pre' }))).toContain(
      `post probe ${invalidPost.probes[0]!.driver}:${invalidPost.probes[0]!.dataset}:${invalidPost.probes[0]!.kind} has invalid medianMs`,
    )
    expect(benchmarkGateFailures(invalidPost, report({ phase: 'pre' }))).toContain(
      `post probe ${invalidPost.probes[1]!.driver}:${invalidPost.probes[1]!.dataset}:${invalidPost.probes[1]!.kind} has invalid medianMs`,
    )
    expect(benchmarkGateFailures(report(), invalidBaseline)).toContain(
      `baseline cell ${invalidBaseline.cells[0]!.driver}:${invalidBaseline.cells[0]!.dataset}:${invalidBaseline.cells[0]!.scope}:${invalidBaseline.cells[0]!.filter}:${invalidBaseline.cells[0]!.page} has invalid medianMs`,
    )
    expect(benchmarkGateFailures(report(), invalidBaseline)).toContain(
      `baseline probe ${invalidBaseline.probes[0]!.driver}:${invalidBaseline.probes[0]!.dataset}:${invalidBaseline.probes[0]!.kind} has invalid medianMs`,
    )
  })
})
