// The `import` job handler: reads a staged upload and writes notes through the store,
// producing no artifact — the outcome is the ImportSummary carried in `result`.
// canon: docs/import.md#durable-import-via-the-jobs-layer-191 · docs/import.md#idempotency-dedup-on-re-import

import { rm } from 'node:fs/promises'

import { ImportError, type ImportFormat } from '@notarium/core'

import type { ImportStagingStore } from '../../../libs/importStaging'
import {
  asSettledPlan,
  IMPORT_PHASE,
  ImportPlanConflictError,
  makeImportTempDir,
  type MarkdownTreePlanV1,
  runImport,
} from '../../../services/import'
import type { MetaDb } from '../../../services/metaDb'
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
  /** Absent on a host without a meta-DB: there is no durable job there either, so
   *  nothing to arbitrate between. */
  metaDb?: Pick<MetaDb, 'importReservations'>
}

export const createImportHandler =
  (deps: ImportHandlerDeps): JobHandler =>
  async (ctx) => {
    const { job, lease, signal, report } = ctx
    const params = (job.params ?? {}) as ImportParams

    if (!params.uploadRef) {
      throw new Error('import job missing uploadRef')
    }
    const uploadRef = params.uploadRef
    const store = await deps.resolveStore(job.space)
    const uploadPath = deps.staging.pathOf(params.uploadRef)

    // Extracted members are re-derivable from the durable upload → this temp dir is
    // ephemeral (cleaned in finally); only the upload itself is durable.
    const tempDir = await makeImportTempDir()
    const reservations = deps.metaDb?.importReservations
    const claimKey = { space: job.space, jobId: job.id, workerLease: lease, uploadRef }
    // Every planned write of this run goes through the fence this claim installs.
    let claimed: { reservationId: string; fence: string } | null = null

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
        uploadRef,
        // The plan is published beside its upload and adopted on every later
        // claim of this job, so a reap-reclaim writes the notes the first run
        // planned. `job.phase` is the phase persisted BEFORE this run claimed the
        // row — the only proof that the write gate was never opened.
        planStore: {
          load: () => deps.staging.readPlan(uploadRef),
          // The publication is told what "executable" means, because the staging
          // store cannot know: a sidecar an older build left behind reads back
          // whole and still describes a plan this build must refuse. Without the
          // predicate, no-clobber kept refusing every rewrite of it and the job
          // died retryably on a message about durable storage, three attempts in a
          // row, with the squatter untouched.
          publish: (plan) =>
            deps.staging.publishPlan(
              uploadRef,
              lease,
              plan,
              (published) =>
                asSettledPlan(published as MarkdownTreePlanV1 | null)?.uploadRef === uploadRef,
            ),
          persistedPhase: job.phase,
        },
        signal,
        // A Markdown tree knows its total once the plan exists (determinate bar);
        // a foreign export never does (indeterminate). report() heartbeats and
        // throws JobAbortedError on cancel/reap, so a cancel lands within one
        // progress batch.
        // canon: docs/import.md#cooperative-responsiveness-on-large-imports-192
        onProgress: (p) => report({ done: p.done, total: p.total, phase: p.phase }),
        settle: () => store.settle?.(),
        reservation: reservations && {
          claim: async (entries) => {
            // ADOPT first, then reserve. A retry must re-fence: the reservation it
            // finds was taken under the previous lease, and reading it back
            // unchanged would leave the previous run's writes still valid.
            const now = new Date().toISOString()
            const adopted = await reservations.adopt({ ...claimKey, now })
            const outcome = adopted.ok
              ? adopted
              : adopted.reason === 'stale_fence'
                ? await reservations.reserve({ ...claimKey, entries, now })
                : adopted

            if (!outcome.ok) {
              // Deterministic by construction: a rival owns the path, or this job
              // is no longer ours. Re-reading the same archive reaches the same
              // answer, so it fails terminally rather than burning the budget.
              throw new ImportError(
                `import destinations refused: ${outcome.detail ?? outcome.reason}`,
              )
            }
            claimed = { reservationId: outcome.reservation.id, fence: outcome.reservation.fence }
          },
          fenced: async (destinationPath, write) => {
            if (!claimed) {
              throw new ImportError('a planned write ran before its destinations were claimed')
            }

            return await reservations.withFencedWrite(
              { ...claimed, jobId: job.id, workerLease: lease, space: job.space, destinationPath },
              write,
            )
          },
        },
      })
      // Notes are durable-complete here; embedding/graph enrich runs in the
      // background off the job.
      const done = summary.imported + summary.skipped + summary.failed
      await report({ done, total: done, phase: IMPORT_PHASE.done })
      return { result: summary }
    } catch (err) {
      // signal.aborted → JobAbortedError, which the runner treats as a stop, not a failure.
      if (signal.aborted) {
        throw new JobAbortedError()
      }
      // ImportError = deterministic bad-upload failure: a retry re-reads the same bytes
      // and fails identically, so fail terminally rather than burn the retry budget.
      if (err instanceof ImportError) {
        // A plan conflict after N writes is deterministic AND partial: fail without
        // retry, carrying the bounded summary of the notes that did land.
        throw new TerminalJobError(
          err.message,
          err instanceof ImportPlanConflictError ? err.partial : undefined,
        )
      }
      throw err
    } finally {
      // The durable upload is deliberately NOT removed here — a retry / reap-reclaim
      // needs it; the staging store's row-aware sweep reclaims it once the job is terminal.
      // canon: docs/jobs.md#input-staging-191
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }
