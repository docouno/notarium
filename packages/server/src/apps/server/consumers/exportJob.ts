// The `export` job handler — first consumer of the durable job layer; reuses the
// `exportNotes` seam and lands the ZIP in the artifact store instead of the response socket.
// canon: docs/export.md#async-export-via-the-jobs-layer-105 · docs/architecture.md#p1

import { ZipArchive } from 'archiver'
import { READ_SCOPE, type ReadScope } from '@notarium/core'

import { exportEntryBody } from '../../../libs/exportEntry'
import { safeRelAddress } from '../../../libs/relPath'
import type { SpaceStore } from '../../../services/spaces'
import { JobAbortedError, type JobHandler } from './jobRunner'

export type ExportParams = {
  scope?: ReadScope
  frontmatter?: 'keep' | 'strip'
  folder?: string
}

export type ExportHandlerDeps = {
  resolveStore: (space: string) => Promise<SpaceStore>
  slugOf: (space: string) => string | null
  now?: () => Date
}

const PROGRESS_EVERY = 50

export const createExportHandler = (deps: ExportHandlerDeps): JobHandler => {
  const nowDate = deps.now ?? (() => new Date())

  return async (ctx) => {
    const { job, artifacts, signal, report } = ctx
    const store = await deps.resolveStore(job.space)

    if (!store.exportNotes) {
      throw new Error('export_unavailable')
    }

    const params = (job.params ?? {}) as ExportParams
    const scope: ReadScope = params.scope === READ_SCOPE.all ? READ_SCOPE.all : READ_SCOPE.user
    const stripFm = params.frontmatter === 'strip'
    let folder = ''

    if (params.folder) {
      const safe = safeRelAddress(params.folder)

      if (safe === null) {
        throw new Error('bad folder path')
      }
      folder = safe
    }

    const slug = deps.slugOf(job.space) ?? job.space
    const filename = `${slug}-notes-${nowDate().toISOString().slice(0, 10)}.zip`
    const ref = `${job.space}/${job.id}.zip`
    // Per-run temp part (keyed by the lease) atomically renamed to `ref` only on success, so a
    // reaped-then-reclaimed re-run owns a DISTINCT temp and, on failure, removes only its OWN temp — never a peer's or `ref`.
    const lease = (job.lockedBy ?? job.id).replace(/[^a-zA-Z0-9._-]/g, '')
    const tmpRef = `${job.space}/${job.id}.${lease}.part`

    const sink = await artifacts.createWriteStream(tmpRef)
    const archive = new ZipArchive({ zlib: { level: 6 } })
    let streamErr: Error | null = null
    archive.on('error', (err: Error) => {
      streamErr ??= err
      // archiver errors fire on ITS Readable and don't propagate through the pipe (Node forwards
      // no Readable 'error'), so destroy the sink to settle the awaiters — else finalize() hangs the worker slot forever.
      sink.destroy(err)
    })
    sink.on('error', (err: Error) => {
      streamErr ??= err
    })
    // The artifact is fully written only on the sink's 'finish'; reject on 'error'/early 'close'
    // so a write failure (ENOSPC/EIO) surfaces instead of hanging the awaiter and pinning the worker slot.
    const sinkFinished = new Promise<void>((res, rej) => {
      sink.once('finish', res)
      sink.once('error', rej)
      sink.once('close', () => rej(streamErr ?? new Error('artifact sink closed before finish')))
    })
    sinkFinished.catch(() => {}) // the awaiter below handles it; avoid an unhandled rejection
    const aborted = new Promise<never>((_, rej) => {
      if (signal.aborted) {
        rej(new JobAbortedError())
      } else {
        signal.addEventListener('abort', () => rej(new JobAbortedError()), { once: true })
      }
    })
    aborted.catch(() => {})
    archive.pipe(sink)

    let done = 0
    const total = job.progressTotal ?? null

    try {
      const prefix = folder ? `${folder}/` : ''

      for await (const entry of store.exportNotes({ scope })) {
        if (signal.aborted) {
          throw new JobAbortedError()
        }
        if (streamErr) {
          throw streamErr
        }
        if (folder && !entry.path.startsWith(prefix)) {
          continue
        }
        archive.append(exportEntryBody(entry, stripFm), { name: entry.path })
        done++
        // Backpressure to bound memory: wait for 'drain', raced against error/close/abort so it can never hang on a dead sink.
        if (sink.writableNeedDrain) {
          await new Promise<void>((res, rej) => {
            const cleanup = () => {
              sink.off('drain', onDrain)
              sink.off('error', onErr)
              sink.off('close', onClose)
              signal.removeEventListener('abort', onAbort)
            }

            const onDrain = () => {
              cleanup()
              res()
            }

            const onErr = (e: Error) => {
              cleanup()
              rej(e)
            }

            const onClose = () => {
              cleanup()
              rej(streamErr ?? new Error('artifact sink closed'))
            }

            const onAbort = () => {
              cleanup()
              rej(new JobAbortedError())
            }

            if (signal.aborted) {
              onAbort()
              return
            }
            sink.once('drain', onDrain)
            sink.once('error', onErr)
            sink.once('close', onClose)
            signal.addEventListener('abort', onAbort, { once: true })
          })
        }
        if (done % PROGRESS_EVERY === 0) {
          await report({ done, total, phase: 'archiving' })
        }
      }
      // Await the SINK's 'finish' (raced with abort), not finalize() directly, so a dead sink
      // surfaces as a rejection rather than a hung finalize().
      void archive.finalize().catch((err: Error) => {
        streamErr ??= err
      })
      await Promise.race([sinkFinished, aborted])
      if (streamErr) {
        throw streamErr
      }

      // The final report re-checks the lease (throws JobAbortedError if this run was reaped), so only
      // the true owner renames its temp over `ref` — atomic, a downloader never sees a half-written archive.
      // total := done so a folder/scope-narrowed export still reports an accurate 100%.
      await report({ done, total: done, phase: 'done' })
      await artifacts.rename(tmpRef, ref)
      const st = await artifacts.stat(ref)
      return {
        artifactRef: ref,
        artifactBytes: st?.size ?? null,
        artifactName: filename,
        result: { count: done },
      }
    } catch (err) {
      // Drop THIS run's temp part so a retry starts clean; never touch `ref` — a peer re-running the job owns it.
      archive.destroy()
      sink.destroy()
      await artifacts.remove(tmpRef).catch(() => {})
      throw err
    }
  }
}
