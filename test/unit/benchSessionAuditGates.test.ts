import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  benchmarkGateFailures,
  type BenchmarkGateProbe,
  type BenchmarkGateReport,
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

const report = (over: Partial<BenchmarkGateReport> = {}): BenchmarkGateReport => ({
  phase: 'post',
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
  ...over,
})

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
    const empty = benchmarkGateFailures(report({ cells: [], probes: [] }), baseline)
    expect(empty).toContain('post report is missing benchmark cells')
    expect(empty).toContain('post report is missing benchmark probes')

    const incomplete = report()
    incomplete.cells.pop()
    incomplete.probes.pop()
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
    lastDetail.medianMs = 2.01
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
    cell.medianMs = 2.01

    expect(
      benchmarkGateFailures(regressed, baseline).some((failure) =>
        failure.includes('regression sqlite:500000:session:all:first'),
      ),
    ).toBe(true)
    expect(benchmarkGateFailures(report(), baseline)).toEqual([])
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
