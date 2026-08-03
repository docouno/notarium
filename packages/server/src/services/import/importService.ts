// Import orchestration: stream-parse an uploaded export, then write each note
// through store.write.
// canon: docs/import.md#data-path · docs/import.md#idempotency-dedup-on-re-import

import { NOTE_CLASS } from '@notarium/contract'
import {
  IF_EXISTS,
  type IfExists,
  IMPORT_SOURCE,
  type ImportFormat,
  type ImportNote,
  type KnowledgeStore,
  STORE_ERROR_REASON,
  type WriteInput,
} from '@notarium/core'

import { safeRelPath } from '../../libs/relPath'
import { streamImportFile } from './streamImport'

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
  errors: Array<{ title?: string; error: string }>
  created: string[]
}

/** Cap on collected `created` ids: the sole consumer opens only the first, so the
 *  full list is never needed. */
const CREATED_CAP = 200

/** Destination for memory.json entities: user-doc folder, the space's agent-memory
 *  mount, or skip. canon: docs/note-model.md#agent-memory */
export type MemoryMode = 'folder' | 'space' | 'skip'

/** Map an ImportNote to a create WriteInput.
 */
const toWriteInput = (
  n: ImportNote,
  directory: string,
  principal: string,
  opts: { targetClass?: 'agent-memory'; ifExists: IfExists },
): WriteInput => ({
  title: n.title,
  content: n.body,
  directory,
  noteType: n.noteType,
  tags: n.tags,
  fileName: n.fileName,
  // Only `created:` is threaded; `modified` is left to file mtime so it never goes
  // stale or fights the journal.
  // canon: docs/import.md#dates-as-data
  createdAt: n.createdAt,
  principal,
  targetClass: opts.targetClass,
  ifExists: opts.ifExists,
})

export type RunImportArgs = {
  /** Write port + optional bulk-mode bracket (beginBulk/endBulk).
   *  canon: docs/import.md#cooperative-responsiveness-on-large-imports-192 */
  store: Pick<KnowledgeStore, 'write'> & {
    beginBulk?: () => void
    endBulk?: () => void | Promise<void>
  }
  uploadPath: string
  /** Temp dir for extracted ZIP members; owned and cleaned by the caller. */
  tempDir: string
  /** Original filename — a hint only; format is detected from content. */
  filename: string
  principal: string
  format?: ImportFormat
  /** Root folder the default structure nests under; empty = the space root.
   *  Untrusted — normalised and traversal-rejected. */
  root?: string
  skipExisting?: boolean
  memoryMode?: MemoryMode
  /** Running imported count, fired every `progressEvery` notes — keeps a long
   *  import alive against the endpoint idle-timeout. */
  onProgress?: (imported: number) => void | Promise<void>
  /** Drain the read-model's write-behind (journal) queue every `progressEvery`
   *  notes so a bulk import doesn't accumulate un-flushed revisions. */
  settle?: () => void | Promise<void>
  progressEvery?: number
  /** Cooperative cancel: checked before each note write. A throw unwinds the bulk
   *  bracket (endBulk still drains the deferred work) and maps to JobAbortedError.
   *  canon: docs/import.md#durable-import-via-the-jobs-layer-191 */
  signal?: AbortSignal
}

const underRoot = (root: string, dir: string) => (root ? `${root}/${dir}` : dir)

/** Run a streaming import. Throws ImportError (from streamImportFile) when nothing
 *  recognisable was uploaded. */
export const runImport = async ({
  store,
  uploadPath,
  tempDir,
  filename,
  principal,
  format,
  root = '',
  skipExisting = false,
  memoryMode = 'folder',
  onProgress,
  settle,
  progressEvery = 200,
  signal,
}: RunImportArgs): Promise<ImportSummary> => {
  const summary: ImportSummary = {
    imported: 0,
    skipped: 0,
    failed: 0,
    files: [],
    errors: [],
    created: [],
  }
  const perFile = new Map<string, { imported: number; skipped: number }>()

  const bump = (file: string, key: 'imported' | 'skipped') => {
    const c = perFile.get(file) ?? { imported: 0, skipped: 0 }
    c[key]++
    perFile.set(file, c)
  }

  // Bracket the whole import in bulk-write mode; the finally guarantees we leave it
  // (and drain deferred work) even if the parse throws mid-stream.
  store.beginBulk?.()
  try {
    return await runStream()
  } finally {
    // A throw from endBulk here would mask the original parse/stream failure (JS
    // finally semantics), so swallow and log; the import's own error propagates.
    try {
      await store.endBulk?.()
    } catch (err) {
      console.error('[import] endBulk failed:', (err as Error).message)
    }
  }

  // Function declaration (not an arrow const) on purpose: hoisting lets the try
  // above reach it; an arrow const would be in the TDZ when the try runs.
  // eslint-disable-next-line prefer-arrow-functions/prefer-arrow-functions
  async function runStream(): Promise<ImportSummary> {
    const metas = await streamImportFile({
      uploadPath,
      tempDir,
      filename,
      format,
      signal,
      onNote: async (note, ctx) => {
        // Cancel check BEFORE the write's try/catch, so an abort propagates (stops the
        // stream) instead of being counted as a per-note failure.
        if (signal?.aborted) {
          throw new Error('import canceled')
        }
        const isMemory = note.source === IMPORT_SOURCE.memory

        if (isMemory && memoryMode === 'skip') {
          return
        } // dropped, not counted
        // Memory → space agent-mount: root namespaces user-doc notes only, so drop the
        // `memory/` prefix and force class to agent-memory.
        const toSpaceMemory = isMemory && memoryMode === 'space'
        const dirRaw = toSpaceMemory
          ? note.directory.replace(/^memory\//, '')
          : underRoot(root, note.directory)
        const dir = safeRelPath(dirRaw)

        if (dir === null) {
          summary.failed++
          summary.errors.push({ title: note.title, error: `unsafe directory: ${dirRaw}` })
          return
        }
        // The ONE place a create is allowed to clobber, and it is stated out loud:
        // idempotency rests on the deterministic fileName, so a re-import must land on
        // the SAME file. `skipExisting` is the user's opt-out.
        // canon: docs/import.md#idempotency-dedup-on-re-import
        const input = toWriteInput(note, dir, principal, {
          targetClass: toSpaceMemory ? NOTE_CLASS.agentMemory : undefined,
          ifExists: skipExisting ? IF_EXISTS.fail : IF_EXISTS.overwrite,
        })

        try {
          const w = await store.write(input)
          summary.imported++
          if (w.id && summary.created.length < CREATED_CAP) {
            summary.created.push(w.id)
          }
          bump(ctx.file, 'imported')
          if (summary.imported % progressEvery === 0) {
            await settle?.()
            await onProgress?.(summary.imported)
          }
        } catch (err) {
          if (
            skipExisting &&
            (err as { reason?: string }).reason === STORE_ERROR_REASON.noteAlreadyExists
          ) {
            summary.skipped++
            bump(ctx.file, 'skipped')
            return
          }
          // A single note's write failure is recorded, not fatal — the rest import.
          summary.failed++
          summary.errors.push({ title: note.title, error: (err as Error).message })
        }
        // Cooperative yield after each write so an interactive request that arrived
        // mid-import is serviced now, not queued behind the stream.
        await new Promise((resolve) => setImmediate(resolve))
      },
    })

    summary.files = metas.map((m) => {
      const c = perFile.get(m.file) ?? { imported: 0, skipped: 0 }
      return {
        file: m.file,
        format: m.format,
        imported: c.imported,
        skipped: c.skipped,
        warnings: m.warnings,
      }
    })
    return summary
  }
}
