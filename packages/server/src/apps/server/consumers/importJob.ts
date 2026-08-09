// The `import` job handler: reads a staged upload and writes notes through the store,
// producing no artifact — the outcome is the ImportSummary carried in `result`.
// canon: docs/import.md#durable-import-via-the-jobs-layer-191 · docs/import.md#idempotency-dedup-on-re-import

import { rm } from 'node:fs/promises'

import { ImportError, type ImportFormat } from '@notarium/core'

import type { ImportStagingStore } from '../../../libs/importStaging'
import { makeImportTempDir, runImport } from '../../../services/import'
import type { SpaceStore } from '../../../services/spaces'
import { JobAbortedError, type JobHandler, TerminalJobError } from './jobRunner'

/** The validated multipart fields an import job carries, plus the staging upload ref. */
export type ImportParams = {
  uploadRef: string
  /** A hint only — the parser is detected from content, not this name. */
  filename: string
  format?: ImportFormat
  root?: string
  skipExisting?: boolean
  memoryMode?: 'folder' | 'space' | 'skip'
  /** The dropped file's own mtime (ISO), validated at the route — the creation
   *  date a `markdown` note falls back to. canon: docs/import.md#dates-as-data */
  sourceModifiedAt?: string
}

export type ImportHandlerDeps = {
  resolveStore: (space: string) => Promise<SpaceStore>
  staging: ImportStagingStore
}

export const createImportHandler =
  (deps: ImportHandlerDeps): JobHandler =>
  async (ctx) => {
    const { job, signal, report } = ctx
    const params = (job.params ?? {}) as ImportParams

    if (!params.uploadRef) {
      throw new Error('import job missing uploadRef')
    }
    const store = await deps.resolveStore(job.space)
    const uploadPath = deps.staging.pathOf(params.uploadRef)

    // Extracted members are re-derivable from the durable upload → this temp dir is
    // ephemeral (cleaned in finally); only the upload itself is durable.
    const tempDir = await makeImportTempDir()

    try {
      const summary = await runImport({
        store,
        uploadPath,
        tempDir,
        filename: params.filename,
        principal: job.principal,
        format: params.format,
        root: params.root,
        skipExisting: params.skipExisting,
        memoryMode: params.memoryMode,
        sourceModifiedAt: params.sourceModifiedAt,
        signal,
        // total stays null — a ZIP's note count is unknown upfront (indeterminate bar).
        // report() heartbeats and throws JobAbortedError on cancel/reap, so a cancel
        // lands within one progress batch.
        // canon: docs/import.md#cooperative-responsiveness-on-large-imports-192
        onProgress: (imported) => report({ done: imported, total: null, phase: 'writing' }),
        settle: () => store.settle?.(),
      })
      // Notes are durable-complete here; embedding/graph enrich runs in the
      // background off the job.
      await report({ done: summary.imported, total: summary.imported, phase: 'done' })
      return { result: summary }
    } catch (err) {
      // signal.aborted → JobAbortedError, which the runner treats as a stop, not a failure.
      if (signal.aborted) {
        throw new JobAbortedError()
      }
      // ImportError = deterministic bad-upload failure: a retry re-reads the same bytes
      // and fails identically, so fail terminally rather than burn the retry budget.
      if (err instanceof ImportError) {
        throw new TerminalJobError(err.message)
      }
      throw err
    } finally {
      // The durable upload is deliberately NOT removed here — a retry / reap-reclaim
      // needs it; the staging store's row-aware sweep reclaims it once the job is terminal.
      // canon: docs/jobs.md#input-staging-191
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }
