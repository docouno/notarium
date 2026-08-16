import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'

import type { ImportSummary, Job } from '@notarium/contract'
import { IMPORT_FORMAT } from '@notarium/core'

import { type ToastApi, useToast } from '../../core/Toast'
import { noteRoute, workspaceSettingsRoute } from '../../libs/routing/routePaths'
import {
  api,
  ApiError,
  type ImportUploadSource,
  normalizeImportSummary,
  pollJobToTerminal,
} from '../../services/api'
import { useSpace } from '../SpaceProvider'
import {
  type CapturedDrop,
  DROP_ENTRIES_ERROR,
  DropEntriesError,
  expandDrop,
  prepareDrop,
} from './dropEntries'

const folderLabel = (folder: string): string => folder || 'the workspace root'
const EMPTY_SUMMARY: ImportSummary = { imported: 0, skipped: 0, failed: 0, files: [], errors: [] }

type DropImportPhase = 'preparing' | 'uploading' | 'sync' | 'job'
type DropImportLease = symbol
type ActiveDropImport = {
  lease: DropImportLease
  phase: DropImportPhase
  space: string
  jobId?: string
}

// Both drop surfaces live for the whole tab and instantiate their own hook. The
// current-tab operation therefore has to live at module scope to remain one operation.
let activeDropImport: ActiveDropImport | null = null

const claimDropImport = (phase: DropImportPhase, space: string): DropImportLease | null => {
  if (activeDropImport) {
    return null
  }
  const lease = Symbol('drop-import')

  activeDropImport = { lease, phase, space }
  return lease
}

const updateDropImport = (lease: DropImportLease, phase: DropImportPhase, jobId?: string): void => {
  if (activeDropImport?.lease === lease) {
    activeDropImport = { ...activeDropImport, phase, jobId }
  }
}

const releaseDropImport = (lease: DropImportLease): void => {
  if (activeDropImport?.lease === lease) {
    activeDropImport = null
  }
}

const progressAction = (
  space: string,
  jobId: string,
  navigate: ReturnType<typeof useNavigate>,
) => ({
  label: 'View progress',
  onClick: () => navigate(workspaceSettingsRoute(space, 'import', { job: jobId })),
})

const showAlreadyRunning = (toast: ToastApi, navigate: ReturnType<typeof useNavigate>): void => {
  const jobId = activeDropImport?.phase === 'job' ? activeDropImport.jobId : undefined
  const space = activeDropImport?.space

  toast.info('An import is already running.', {
    ...(jobId && space ? { action: progressAction(space, jobId, navigate) } : {}),
  })
}

const lastSummaryError = (summary: ImportSummary): string | null =>
  summary.errors.at(-1)?.error ?? null

const summaryText = (summary: ImportSummary, folder?: string): string => {
  const ignored = summary.ignored?.count ?? 0
  const parts = [
    `Imported ${summary.imported} note${summary.imported === 1 ? '' : 's'}${folder === undefined ? '' : ` into ${folderLabel(folder)}`}`,
  ]

  if (summary.skipped) {
    parts.push(`${summary.skipped} skipped (already exists; content not compared)`)
  }
  if (summary.failed) {
    parts.push(`${summary.failed} failed`)
  }
  if (ignored) {
    parts.push(`${ignored} unsupported`)
  }
  if (summary.repointFailed) {
    parts.push(`${summary.repointFailed} with links left pointing at the source`)
  }

  return `${parts.join(', ')}.`
}

const showSummary = (toast: ToastApi, summary: ImportSummary, folder: string): void => {
  const ignored = summary.ignored?.count ?? 0
  const message = summaryText(summary, folder)

  if (summary.imported === 0 && summary.failed > 0) {
    const reason = lastSummaryError(summary)

    toast.error(reason ? `${message} ${reason}` : message)
    return
  }
  const warning =
    summary.failed > 0 ||
    summary.skipped > 0 ||
    ignored > 0 ||
    (summary.repointFailed ?? 0) > 0 ||
    summary.files.some((file) => file.warnings.length > 0)

  toast[warning ? 'warning' : 'success'](message)
}

const showFailed = (toast: ToastApi, error: string, partial: ImportSummary | null): void => {
  if (
    partial &&
    (partial.imported > 0 ||
      partial.skipped > 0 ||
      partial.failed > 0 ||
      (partial.ignored?.count ?? 0) > 0 ||
      (partial.repointFailed ?? 0) > 0)
  ) {
    toast.warning(`${summaryText(partial)} Import failed: ${error}`)
    return
  }
  toast.error(error)
}

const terminal = (job: Job): boolean =>
  job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled'

type RunImport = (
  source: ImportUploadSource,
  folder: string,
  lease: DropImportLease,
  openSingleText: boolean,
  controller: AbortController,
) => Promise<void>

const useImportRunner = (): RunImport => {
  const { space } = useSpace()
  const toast = useToast()
  const navigate = useNavigate()

  return useCallback<RunImport>(
    async (source, folder, lease, openSingleText, controller) => {
      updateDropImport(lease, 'uploading')
      let pending: string | null = toast.info(
        `Importing ${source.kind === 'tree' ? source.entries.length : 1} item${source.kind === 'tree' && source.entries.length !== 1 ? 's' : ''}…`,
        { duration: 0 },
      )

      try {
        const started = await api.importStart(
          space,
          source,
          {
            format: source.kind === 'tree' || openSingleText ? IMPORT_FORMAT.markdown : undefined,
            root: folder,
            skipExisting: true,
            sendLastModified: source.kind === 'file' && openSingleText,
          },
          controller.signal,
        )

        if (controller.signal.aborted) {
          return
        }

        let summary: ImportSummary

        if (started.mode === 'job') {
          updateDropImport(lease, 'job', started.job.id)
          toast.dismiss(pending)
          pending = null
          toast.info('Import started.', {
            action: progressAction(space, started.job.id, navigate),
          })
          const job = terminal(started.job)
            ? started.job
            : await pollJobToTerminal(space, started.job.id, {
                signal: controller.signal,
                ...(openSingleText ? { intervalMs: 400 } : {}),
              })

          if (controller.signal.aborted) {
            return
          }

          if (job.status === 'canceled') {
            toast.info('Import canceled.')
            return
          }
          if (job.status === 'failed') {
            showFailed(toast, job.error ?? 'Import failed', normalizeImportSummary(job.result))
            return
          }
          summary = normalizeImportSummary(job.result) ?? EMPTY_SUMMARY
        } else {
          updateDropImport(lease, 'sync')
          summary = await started.run(() => {})
          if (controller.signal.aborted) {
            return
          }
          toast.dismiss(pending)
          pending = null
        }

        if (openSingleText && summary.created?.[0]) {
          navigate(noteRoute(summary.created[0])!)
        }
        showSummary(toast, summary, folder)
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }
        const message = error instanceof Error ? error.message : 'Import failed'
        const partial = error instanceof ApiError ? normalizeImportSummary(error.partial) : null

        showFailed(toast, message, partial)
      } finally {
        if (pending) {
          toast.dismiss(pending)
        }
        releaseDropImport(lease)
      }
    },
    [space, toast, navigate],
  )
}

export type ImportDrop = (capture: CapturedDrop, folder: string) => Promise<void>

/** Expand a synchronous DataTransfer snapshot, then hand its one source to the importer. */
export const useDropImport = (): ImportDrop => {
  const { canWrite, space } = useSpace()
  const toast = useToast()
  const navigate = useNavigate()
  const run = useImportRunner()
  const owned = useRef<{ lease: DropImportLease; controller: AbortController } | null>(null)

  useEffect(
    () => () => {
      const operation = owned.current

      if (operation) {
        operation.controller.abort()
        releaseDropImport(operation.lease)
        owned.current = null
      }
    },
    [space],
  )

  return useCallback<ImportDrop>(
    async (capture, folder) => {
      if (!canWrite) {
        toast.error('You have read-only access to this space, so importing isn’t available.')
        return
      }
      const lease = claimDropImport('preparing', space)

      if (!lease) {
        showAlreadyRunning(toast, navigate)
        return
      }
      const controller = new AbortController()

      owned.current = { lease, controller }
      try {
        const prepared = prepareDrop(await expandDrop(capture))

        if (controller.signal.aborted) {
          return
        }
        await run(prepared.source, folder, lease, prepared.openSingleText, controller)
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }
        if (
          error instanceof DropEntriesError &&
          error.code === DROP_ENTRIES_ERROR.capabilityUnavailable
        ) {
          toast.info(error.message, {
            action: {
              label: 'Open Import settings',
              onClick: () => navigate(workspaceSettingsRoute(space, 'import')),
            },
          })
          return
        }
        if (
          error instanceof DropEntriesError &&
          (error.code === DROP_ENTRIES_ERROR.unsupportedOnly ||
            error.code === DROP_ENTRIES_ERROR.mixedArchive)
        ) {
          toast.info(error.message)
          return
        }
        toast.error(
          error instanceof Error ? error.message : 'The dropped folder could not be read.',
        )
      } finally {
        releaseDropImport(lease)
        if (owned.current?.lease === lease) {
          owned.current = null
        }
      }
    },
    [canWrite, toast, space, navigate, run],
  )
}
