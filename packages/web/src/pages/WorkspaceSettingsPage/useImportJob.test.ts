// The Import tab's own result normalizer (#302). It is deliberately hand-written
// rather than the contract's Zod schema — the web bundle ships no Zod — and it
// re-applies the detail cap the server applies, because a result persisted by an
// older build predates that cap and a 10 000-row Notice is a frozen tab.

import { describe, expect, it } from 'vitest'

import { normalizeImportSummary } from './useImportJob'

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    file: `f${i}.md`,
    format: 'markdown',
    imported: 1,
    skipped: 0,
    warnings: [],
  }))

describe('normalizeImportSummary', () => {
  it('reads a minimal result and defaults every optional collection', () => {
    expect(normalizeImportSummary({ imported: 3, skipped: 1, failed: 0 })).toEqual({
      imported: 3,
      skipped: 1,
      failed: 0,
      files: [],
      filesOmitted: undefined,
      errors: [],
      errorsOmitted: undefined,
      repointFailed: undefined,
      ignored: undefined,
      created: [],
    })
  })

  // The one counter that is NOT recoverable from the rows: the per-file warnings
  // saying the same thing are capped on both sides, so a 10 000-file import that
  // lost a repoint arrives with 200 clean rows and this number.
  it('carries the repoint refusals through, capped rows or not', () => {
    const summary = normalizeImportSummary({
      imported: 10_000,
      skipped: 0,
      failed: 0,
      files: rows(200),
      filesOmitted: 9_800,
      errors: [],
      repointFailed: 1,
    })!

    expect(summary.files.flatMap((file) => file.warnings)).toEqual([])
    expect(summary.repointFailed).toBe(1)
  })

  it('keeps the server’s exact totals and its own omitted counters', () => {
    const summary = normalizeImportSummary({
      imported: 10_000,
      skipped: 0,
      failed: 2,
      files: rows(200),
      filesOmitted: 9_800,
      errors: [{ error: 'one' }],
      ignored: { count: 500, files: ['a.png'], filesOmitted: 499 },
    })!

    expect(summary.imported).toBe(10_000)
    expect(summary.files).toHaveLength(200)
    expect(summary.filesOmitted).toBe(9_800)
    expect(summary.ignored).toEqual({ count: 500, files: ['a.png'], filesOmitted: 499 })
  })

  it('caps an oversized legacy result and folds the excess into the omitted count', () => {
    const summary = normalizeImportSummary({
      imported: 250,
      skipped: 0,
      failed: 250,
      files: rows(250),
      errors: Array.from({ length: 250 }, (_, i) => ({ error: `e${i}` })),
      ignored: { count: 250, files: Array.from({ length: 250 }, (_, i) => `x${i}.png`) },
      created: Array.from({ length: 250 }, (_, i) => `id-${i}`),
    })!

    expect(summary.files).toHaveLength(200)
    expect(summary.filesOmitted).toBe(50)
    expect(summary.errors).toHaveLength(200)
    expect(summary.errorsOmitted).toBe(50)
    expect(summary.ignored?.files).toHaveLength(200)
    expect(summary.ignored?.filesOmitted).toBe(50)
    expect(summary.created).toHaveLength(200)
    // The counters the server states are never recomputed from the capped rows.
    expect(summary.failed).toBe(250)
  })

  it('adds a local truncation to a declared one instead of replacing it', () => {
    const summary = normalizeImportSummary({
      imported: 0,
      skipped: 0,
      failed: 0,
      files: rows(210),
      filesOmitted: 1_000,
    })!

    expect(summary.filesOmitted).toBe(1_010)
  })

  it('answers null for a result that is not one', () => {
    expect(normalizeImportSummary(null)).toBeNull()
    expect(normalizeImportSummary('nope')).toBeNull()
  })
})
