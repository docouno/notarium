import { useCallback } from 'react'
import { useNavigate } from 'react-router'

import type { ImportSummary } from '@notarium/contract'
import { IMPORT_FORMAT } from '@notarium/core'

import { useToast } from '../../core/Toast'
import { noteRoute } from '../../libs/routing/routePaths'
import { api, ApiError, pollJobToTerminal } from '../../services/api'
import { useSpace } from '../SpaceProvider'

// The shared file-import ACTION (#223), riding the SAME import machinery as the
// Settings tab (#191): `api.importStart` stages the upload + enqueues a durable job
// (prod) or answers with the synchronous NDJSON stream (none-mode) — this drives
// both to the same ImportSummary. Both drop surfaces call it, so the import path
// exists once: the tree section (a folder row) and the window content zone.
//
// Each dropped file is its OWN import (#191 stages one upload per job), so a
// multi-file drop is N imports whose summaries we fold together for the toast. A
// single-file drop opens the imported note (its id comes back in `created`).

/** Accepted text extensions for a dropped-file import (v1). */
export const TEXT_EXT = /\.(md|markdown|mdown|mkd|txt|text)$/i
const ACCEPT_LABEL = '.md and .txt'
const folderLabel = (folder: string): string => folder || 'the workspace root'
const EMPTY_SUMMARY: ImportSummary = { imported: 0, skipped: 0, failed: 0, files: [], errors: [] }

// One drop-import at a time, GLOBALLY. `useFileImport()` is instantiated in two
// components (the Sidebar tree zone + the window content zone), so a per-hook ref
// wouldn't serialise a tree drop against a reader drop — a module-level flag does.
let importInFlight = false

export type ImportFiles = (
  fileList: FileList | File[] | null | undefined,
  folder: string,
) => Promise<void>

export const useFileImport = (): ImportFiles => {
  const { space, canWrite } = useSpace()
  const toast = useToast()
  const navigate = useNavigate()
  return useCallback<ImportFiles>(
    async (fileList, folder) => {
      const all = Array.from(fileList ?? [])

      if (!all.length) {
        return
      }
      if (!canWrite) {
        toast.error('You have read-only access to this space, so importing isn’t available.')
        return
      }
      const files = all.filter((f) => TEXT_EXT.test(f.name))
      const rejected = all.length - files.length

      if (!files.length) {
        toast.info(`Only ${ACCEPT_LABEL} files can be dropped in — for now.`)
        return
      }
      if (importInFlight) {
        return
      } // one drop-import at a time (global) — a second mid-flight is ignored
      importInFlight = true
      try {
        const pending = toast.info(
          `Importing ${files.length} file${files.length === 1 ? '' : 's'}…`,
          { duration: 0 },
        )
        let imported = 0
        let skipped = 0
        let failed = 0
        let firstCreated: string | null = null
        let lastError: string | null = null

        // Sequential — a burst of drops shouldn't flood the job runner. skipExisting
        // is on so a casual drag never clobbers an existing note.
        for (const file of files) {
          try {
            const started = await api.importStart(space, file, {
              format: IMPORT_FORMAT.markdown,
              root: folder,
              skipExisting: true,
            })
            let summary: ImportSummary

            if (started.mode === 'job') {
              // Durable path: the note streams into the tree via SSE as the job writes;
              // we poll (tight interval — one small text file) for the terminal outcome
              // so the toast + open-after-import see the real summary.
              const job = await pollJobToTerminal(space, started.job.id, { intervalMs: 400 })

              if (job.status !== 'succeeded') {
                failed++
                lastError = job.error ?? 'import failed'
                continue
              }
              summary = (job.result as ImportSummary | null) ?? EMPTY_SUMMARY
            } else {
              summary = await started.run(() => {}) // none-mode synchronous stream
            }
            imported += summary.imported
            skipped += summary.skipped
            failed += summary.failed
            if (!firstCreated && summary.created?.[0]) {
              firstCreated = summary.created[0]
            }
          } catch (err) {
            failed++
            lastError = err instanceof ApiError ? err.message : 'import failed'
          }
        }
        toast.dismiss(pending)
        // Open the note right after a SINGLE-file drop — "dropped a file, here it is".
        // A multi-file drop lands them in the tree instead (no jarring jump to one of N).
        const openTo = files.length === 1 && firstCreated ? noteRoute(firstCreated) : null

        if (openTo) {
          navigate(openTo)
        }
        if (imported === 0 && failed > 0) {
          toast.error(lastError ?? 'Import failed')
          return
        }
        // Nothing imported because a same-named note already exists — NOT a clean
        // success: skipExisting compares the PATH, not the body, so the file you
        // dropped may differ from what's there. Warn (yellow) instead of confirming.
        if (imported === 0 && skipped > 0) {
          toast.warning(
            `Nothing imported — ${skipped} note${skipped === 1 ? '' : 's'} with that name already exist${skipped === 1 ? 's' : ''} here (content not compared).`,
          )
          return
        }
        const parts = [
          `Imported ${imported} note${imported === 1 ? '' : 's'} into ${folderLabel(folder)}`,
        ]

        if (skipped) {
          parts.push(`${skipped} skipped (already exists)`)
        }
        if (failed) {
          parts.push(`${failed} failed`)
        }
        if (rejected) {
          parts.push(`${rejected} unsupported`)
        }
        // A skip / reject / failure means it wasn't a clean import → warn (yellow),
        // so a same-named-but-different file is never silently confirmed as "done".
        toast[failed || skipped || rejected ? 'warning' : 'success'](parts.join(', ') + '.')
      } finally {
        importInFlight = false
      }
    },
    [space, canWrite, toast, navigate],
  )
}
