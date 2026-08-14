// The import summary collector: exact totals, bounded details.
//
// A 10 000-note import must not answer with a 10 000-element result — not on the
// wire, not in a job row, not in the DOM. So every DETAIL collection here stops
// at `IMPORT_DETAIL_CAP` while the counters keep counting, and each truncated
// collection says how much it dropped. The collector is INCREMENTAL on purpose:
// a terminal plan conflict after N writes must still report those N.
// canon: docs/import.md#what-an-import-reports-302

import type { ImportFormat } from '@notarium/core'

import { IMPORT_DETAIL_CAP } from './consts'

export type ImportFileResult = {
  file: string
  format: ImportFormat | 'unsupported'
  imported: number
  skipped: number
  warnings: string[]
}

export type ImportSummary = {
  imported: number
  skipped: number
  failed: number
  files: ImportFileResult[]
  /** Recognised members not present in `files` — only when > 0. */
  filesOmitted?: number
  errors: Array<{ title?: string; error: string }>
  /** Per-note failures not present in `errors` — only when > 0. */
  errorsOmitted?: number
  /** Notes imported with their links still pointing at the source — only when > 0.
   *  A COUNTER, not a sample: the per-file warning saying the same thing lives in
   *  `files`, which stops at the cap, so past the first `IMPORT_DETAIL_CAP`
   *  members this is the only thing that still reports the loss. */
  repointFailed?: number
  /** Non-Markdown members a Markdown-tree archive carried: counted exactly,
   *  sampled boundedly, never imported. Absent for every other format. */
  ignored?: { count: number; files: string[]; filesOmitted?: number }
  created: string[]
}

export type SummaryCollector = {
  imported(file: string, id?: string): void
  skipped(file: string): void
  failed(title: string | undefined, error: string): void
  /** Register a member's identity/warnings — for the tree path one call per
   *  planned member, for the foreign path one per recognised archive member. */
  file(file: string, format: ImportFormat | 'unsupported', warnings?: string[]): void
  /** One note landed with its internal links unrewritten. Called once per such
   *  note, BESIDE the per-file warning rather than instead of it: the warning is
   *  capped with `files`, this count is not. */
  repointFailed(): void
  ignored(ignored: { count: number; files: string[]; filesOmitted?: number }): void
  /** The current snapshot. Safe to take mid-run: it is what a terminal failure
   *  reports about the work already done. */
  snapshot(): ImportSummary
  readonly importedCount: number
}

export const createSummaryCollector = (): SummaryCollector => {
  const totals = { imported: 0, skipped: 0, failed: 0 }
  // Insertion-ordered and capped: the map IS the sample, so a 10 000-member
  // archive never builds 10 000 result objects to throw most of them away.
  const files = new Map<string, ImportFileResult>()
  // The names beyond the cap, not a running counter: `filesOmitted` must count
  // FILES, and a counter cannot tell a second mention of one member from a
  // second member. (A per-call counter reported a 2 000-member archive as 3 600
  // omitted files — more files than it had.) Bounded by the archive's entry
  // ceiling, which the plan already enforces; only the RESULT must stay small.
  const omittedFiles = new Set<string>()
  const errors: Array<{ title?: string; error: string }> = []
  let errorsOmitted = 0
  let repointFailed = 0
  const created: string[] = []
  let ignored: ImportSummary['ignored']

  /** The result row for `file`, or undefined once the cap is spent. */
  const rowOf = (
    file: string,
    format?: ImportFormat | 'unsupported',
  ): ImportFileResult | undefined => {
    const existing = files.get(file)

    if (existing) {
      if (format && existing.format !== format) {
        existing.format = format
      }

      return existing
    }
    if (files.size >= IMPORT_DETAIL_CAP) {
      omittedFiles.add(file)

      return undefined
    }
    const row: ImportFileResult = {
      file,
      format: format ?? 'unsupported',
      imported: 0,
      skipped: 0,
      warnings: [],
    }

    files.set(file, row)

    return row
  }

  return {
    get importedCount() {
      return totals.imported
    },
    imported: (file, id) => {
      totals.imported++
      const row = rowOf(file)

      if (row) {
        row.imported++
      }
      if (id && created.length < IMPORT_DETAIL_CAP) {
        created.push(id)
      }
    },
    skipped: (file) => {
      totals.skipped++
      const row = rowOf(file)

      if (row) {
        row.skipped++
      }
    },
    failed: (title, error) => {
      totals.failed++
      if (errors.length < IMPORT_DETAIL_CAP) {
        errors.push({ ...(title ? { title } : {}), error })
      } else {
        errorsOmitted++
      }
    },
    file: (file, format, warnings) => {
      const row = rowOf(file, format)

      if (row && warnings?.length) {
        row.warnings.push(...warnings)
      }
    },
    repointFailed: () => {
      repointFailed++
    },
    ignored: (value) => {
      ignored = value
    },
    snapshot: () => ({
      ...totals,
      // Copied row by row, not just the array: the rows are the collector's own
      // live counters, and a spread of the map's values hands them out by
      // reference. "Safe to take mid-run" then held only for a snapshot nobody
      // kept — the next `imported()` would edit a result already handed to a
      // caller as the record of an earlier moment.
      files: [...files.values()].map((row) => ({ ...row, warnings: [...row.warnings] })),
      ...(omittedFiles.size ? { filesOmitted: omittedFiles.size } : {}),
      errors: [...errors],
      ...(errorsOmitted ? { errorsOmitted } : {}),
      // Absent, not zero, when every repoint held: an optional field a reader may
      // never have seen must be missing from the result of a run that has nothing
      // to say with it — that is what makes adding it a non-event for every stored
      // result and every reader written before it existed.
      ...(repointFailed ? { repointFailed } : {}),
      // Copied for the same reason the rows are, and one step further: this object
      // is not even the collector's — the tree path hands it straight off the PLAN,
      // so handing it out by reference makes the summary a live window onto the
      // frozen plan, editable from either end.
      ...(ignored ? { ignored: { ...ignored, files: [...ignored.files] } } : {}),
      created: [...created],
    }),
  }
}
