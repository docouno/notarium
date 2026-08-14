// Streaming import: bounded-memory parse of an arbitrarily large export.
// canon: docs/import.md#data-path

import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { chain } from 'stream-chain'
import { parser } from 'stream-json'
import { streamArray } from 'stream-json/streamers/stream-array.js'
import yauzl from 'yauzl'
import {
  chatGptConversationToNote,
  claudeConversationToNote,
  claudeDesignChatToNote,
  claudeMemoryItemToNotes,
  claudeProjectToNotes,
  detectFromArrayItem,
  detectSingleObject,
  IMPORT_FORMAT,
  ImportError,
  type ImportFormat,
  type ImportNote,
  isMemoryObject,
  isMemoryRecord,
  markdownFileToNote,
  MemoryGraph,
} from '@notarium/core'

import { MEMBER_BYTE_CAP, MEMORY_OBJECT_CAP, TEXT_FILE_CAP } from './consts'

/** `'unsupported'` = recognised JSON we have no parser for; surfaced as a warning
 *  so a skip is never silent data loss. */
export type ImportFileMeta = {
  file: string
  format: ImportFormat | 'unsupported'
  warnings: string[]
}

/** Members that are never importable data — skipped silently (a warning here
 *  would be noise on every Claude/ChatGPT upload). */
const SILENTLY_IGNORED = new Set(['users.json'])

export type StreamImportArgs = {
  uploadPath: string
  /** Private temp dir (mkdtemp 0700) for extracted ZIP members; owned + cleaned
   *  by the caller. */
  tempDir: string
  /** Original filename — only a hint; format is detected from content, not name. */
  filename: string
  format?: ImportFormat
  /** Called once per parsed note, awaited (backpressure). A throw is the consumer's
   *  record failure and does NOT abort the stream (the orchestrator catches/counts). */
  onNote: (note: ImportNote, ctx: { file: string; format: ImportFormat }) => Promise<void>
  /** Called once per recognised member, in ARCHIVE ORDER, as soon as that member
   *  is done. Ordering is the whole reason it exists rather than a loop over the
   *  returned metas: a member that yields no notes registers nothing while it
   *  streams, so registering all metas afterwards sorted the result by "produced
   *  a note first" — and the wire contract says archive order.
   *  canon: docs/import.md#what-an-import-reports-302 */
  onFile?: (meta: ImportFileMeta) => void | Promise<void>
  /** Cooperative cancel; checked before each ZIP member so a canceled import stops
   *  promptly. canon: docs/import.md#durable-import-via-the-jobs-layer-191 */
  signal?: AbortSignal
  /** The dropped file's own timestamp (its mtime, threaded from the browser's
   *  `File.lastModified`) — the creation date a `markdown` note falls back to when
   *  its frontmatter names none. Ignored by every other format: an AI export dates
   *  each note from the conversation itself, and an archive's mtime says nothing
   *  about the notes inside it. canon: docs/import.md#dates-as-data */
  sourceModifiedAt?: string
}

let tmpSeq = 0
const tmpMember = (dir: string) => join(dir, `member-${++tmpSeq}.tmp`)

/** Fresh private temp dir (0700) per import — defeats the /tmp symlink race;
 *  caller removes it. */
export const makeImportTempDir = (): Promise<string> =>
  fs.mkdtemp(join(tmpdir(), 'notarium-import-'))

/** Stream an upload to a temp file WE own — not Fastify's saveRequestFiles, whose
 *  onResponse cleanup races a hijacked response. */
export const saveUploadToTemp = async (stream: Readable, dir: string): Promise<string> => {
  const path = join(dir, `upload-${++tmpSeq}.tmp`)
  await pipeline(stream, createWriteStream(path))
  return path
}

/** True if the file starts with the ZIP magic `PK\x03\x04`. */
export const isZipFile = async (path: string): Promise<boolean> => {
  const fh = await fs.open(path, 'r')

  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(4), 0, 4, 0)
    return (
      bytesRead >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      buffer[2] === 0x03 &&
      buffer[3] === 0x04
    )
  } finally {
    await fh.close()
  }
}

/** First ~256 KB of a file as text — enough to sniff array-vs-object and parse
 *  the first line. */
const peekStart = async (path: string): Promise<string> => {
  const fh = await fs.open(path, 'r')

  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(256 * 1024), 0, 256 * 1024, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Stream a JSON-array member element by element; format detected from the FIRST
 *  element (unless forced). */
const streamArrayMember = async (
  path: string,
  file: string,
  forced: ImportFormat | undefined,
  onNote: StreamImportArgs['onNote'],
): Promise<{ format: ImportFormat | null; count: number; empty: number }> => {
  let format = forced ?? null
  let count = 0
  let empty = 0
  let sniffed = 0
  // stream-chain@4 does NOT cascade destroy to its source: hold the head read
  // stream so a bail-out mid-array (unrecognised head, a thrown onNote) can destroy
  // it in the finally — otherwise the fd leaks.
  const readStream = createReadStream(path)
  const source = chain([readStream, parser(), streamArray()])

  try {
    for await (const { key, value } of source as AsyncIterable<{ key: number; value: unknown }>) {
      if (!format) {
        format = detectFromArrayItem(value)
        // The head may be a stray/empty element — skip a few before concluding the
        // file is unrecognised, then bail with null (a skipped member, not a throw).
        if (!format) {
          if (++sniffed >= 10) {
            return { format: null, count, empty }
          }
          continue
        }
      }
      // A conversation parser returns null for a content-less record → a
      // skipped-empty conversation (counted); other formats' null just yields nothing.
      const isConversation =
        format === IMPORT_FORMAT.chatgpt || format === IMPORT_FORMAT.claudeConversations
      const notes =
        format === IMPORT_FORMAT.claudeProjects
          ? claudeProjectToNotes(value as Parameters<typeof claudeProjectToNotes>[0], key)
          : format === IMPORT_FORMAT.claudeMemory
            ? claudeMemoryItemToNotes(value as Parameters<typeof claudeMemoryItemToNotes>[0])
            : format === IMPORT_FORMAT.chatgpt
              ? [
                  chatGptConversationToNote(
                    value as Parameters<typeof chatGptConversationToNote>[0],
                    key,
                  ),
                ]
              : [
                  claudeConversationToNote(
                    value as Parameters<typeof claudeConversationToNote>[0],
                    key,
                  ),
                ]

      for (const n of notes) {
        if (!n) {
          if (isConversation) {
            empty++
          }
          continue
        }
        await onNote(n, { file, format })
        count++
      }
    }
  } finally {
    readStream.destroy()
  }

  return { format, count, empty }
}

/** Accumulate a memory member into a graph, then one note per entity. Bounded by
 *  graph size, not file size. */
const streamMemoryMember = async (
  path: string,
  file: string,
  prefix: string,
  onNote: StreamImportArgs['onNote'],
): Promise<string[]> => {
  const graph = new MemoryGraph()

  if (looksLikeMemoryObject(prefix)) {
    // The single-object `{entities,relations}` shape can't be streamed
    // element-wise, so it's read whole (size-capped).
    const { size } = await fs.stat(path)

    if (size > MEMORY_OBJECT_CAP) {
      return [`memory-json: object too large (${Math.round(size / 1e6)} MB) — split it into JSONL`]
    }
    try {
      const obj = JSON.parse(await fs.readFile(path, 'utf8'))

      if (isMemoryObject(obj)) {
        graph.ingestObject(obj)
      }
    } catch {
      /* unparseable — yields an empty graph + its "no entities" warning */
    }
  } else {
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })

    for await (const line of rl) {
      const t = line.trim()

      if (!t) {
        continue
      }
      try {
        graph.add(JSON.parse(t))
      } catch {
        /* skip a malformed line */
      }
    }
  }
  for (const note of graph.toNotes()) {
    await onNote(note, { file, format: IMPORT_FORMAT.memoryJson })
  }

  return graph.warnings()
}

/** A single-object member (the evolved Claude export ships one project/design-chat/
 *  memory per file): read whole (size-capped) and parsed in one shot.
 */
const processSingleObject = async (
  path: string,
  forced: ImportFormat | undefined,
  onNote: StreamImportArgs['onNote'],
): Promise<{ format: ImportFormat | null; count: number; empty: number }> => {
  const { size } = await fs.stat(path)

  if (size > MEMORY_OBJECT_CAP) {
    return { format: null, count: 0, empty: 0 }
  } // too big to read whole; treat as unrecognised
  let obj: unknown

  try {
    obj = JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    return { format: null, count: 0, empty: 0 }
  }
  const format = forced ?? detectSingleObject(obj)

  if (!format) {
    return { format: null, count: 0, empty: 0 }
  }
  const notes =
    format === IMPORT_FORMAT.claudeProjects
      ? claudeProjectToNotes(obj as Parameters<typeof claudeProjectToNotes>[0], 0)
      : format === IMPORT_FORMAT.claudeDesignChat
        ? [claudeDesignChatToNote(obj as Parameters<typeof claudeDesignChatToNote>[0], 0)]
        : format === IMPORT_FORMAT.claudeMemory
          ? claudeMemoryItemToNotes(obj as Parameters<typeof claudeMemoryItemToNotes>[0])
          : []
  let count = 0
  let empty = 0

  for (const n of notes) {
    if (!n) {
      if (format === IMPORT_FORMAT.claudeDesignChat) {
        empty++
      }
      continue
    }
    await onNote(n, { file: path, format })
    count++
  }

  return { format, count, empty }
}

/** A dropped text/markdown file → one note (forced `format:'markdown'`, never
 *  auto-detected: an md body can legitimately start with `{`/`[`).
 */
const processTextFile = async (
  path: string,
  file: string,
  onNote: StreamImportArgs['onNote'],
  sourceModifiedAt?: string,
): Promise<ImportFileMeta> => {
  const { size } = await fs.stat(path)

  if (size > TEXT_FILE_CAP) {
    // THROW, don't return an empty meta: an oversize file that silently imports 0
    // notes would read as success to the DnD client. (A ZIP member's ImportError is
    // still tolerated — forEachZipMember catches it.)
    throw new ImportError(
      `${file}: text file too large (${Math.round(size / 1e6)} MB, max ${Math.round(TEXT_FILE_CAP / 1e6)} MB)`,
    )
  }
  const raw = await fs.readFile(path, 'utf8')
  await onNote(markdownFileToNote(raw, file, sourceModifiedAt), {
    file,
    format: IMPORT_FORMAT.markdown,
  })
  return { file, format: IMPORT_FORMAT.markdown, warnings: [] }
}

/** Meta for a JSON member we couldn't parse: an 'unsupported' warning so the skip
 *  is VISIBLE, or null for the known-irrelevant (users.json) that would be noise. */
const skippedMeta = (file: string): ImportFileMeta | null => {
  const base = file.split('/').pop() || file

  if (SILENTLY_IGNORED.has(base)) {
    return null
  }

  return {
    file,
    format: 'unsupported',
    warnings: [`${file}: not a recognised export format — skipped (no notes imported)`],
  }
}

/** Process one on-disk member (a bare upload or an extracted ZIP entry): its meta,
 *  an 'unsupported' meta for unparseable JSON, or null for irrelevant/non-JSON. */
const processMember = async (
  path: string,
  file: string,
  forced: ImportFormat | undefined,
  onNote: StreamImportArgs['onNote'],
  sourceModifiedAt?: string,
): Promise<ImportFileMeta | null> => {
  if (forced === IMPORT_FORMAT.markdown) {
    return processTextFile(path, file, onNote, sourceModifiedAt)
  }
  const full = await peekStart(path)
  const first = full.trimStart()[0]
  const isMemory = first === '{' && (firstLineIsMemory(full) || looksLikeMemoryObject(full))

  if (forced === IMPORT_FORMAT.memoryJson || (!forced && isMemory)) {
    const warnings = await streamMemoryMember(path, file, full, onNote)
    return { file, format: IMPORT_FORMAT.memoryJson, warnings }
  }
  if (first === '[') {
    const { format, count, empty } = await streamArrayMember(path, file, forced, onNote)

    if (!format) {
      return skippedMeta(file)
    }

    return { file, format, warnings: warningsFor(file, count, empty) }
  }
  if (first === '{') {
    // processSingleObject only knows the temp path — re-route ctx.file to the archive name.
    const route: StreamImportArgs['onNote'] = (note, ctx) => onNote(note, { ...ctx, file })
    const { format, count, empty } = await processSingleObject(path, forced, route)

    if (!format) {
      return skippedMeta(file)
    }

    return { file, format, warnings: warningsFor(file, count, empty) }
  }

  return null
}

/** Per-member warnings: "no notes" when nothing landed, plus a count of empty
 *  conversations skipped. */
const warningsFor = (file: string, count: number, empty: number): string[] => {
  const w: string[] = []

  if (!count) {
    w.push(`${file}: no notes found`)
  }
  if (empty) {
    w.push(`${file}: skipped ${empty} conversation(s) with no content`)
  }

  return w
}

const firstLineIsMemory = (prefix: string): boolean => {
  const line = prefix.split(/\r?\n/).find((l) => l.trim())

  if (!line) {
    return false
  }
  try {
    return isMemoryRecord(JSON.parse(line.trim()))
  } catch {
    return false
  }
}

/** Regex sniff for the single-object memory shape in the peeked prefix (chooses
 *  the read-whole path over JSONL streaming). */
const looksLikeMemoryObject = (prefix: string): boolean => /"(entities|relations)"\s*:/.test(prefix)

/** Pipeline stage that caps bytes flowing through — zip-bomb guard, throws past
 *  MEMBER_BYTE_CAP so a member can't inflate to fill the disk. */
async function* capBytes(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let n = 0

  for await (const chunk of source) {
    n += chunk.length
    if (n > MEMBER_BYTE_CAP) {
      throw new ImportError('archive member is too large')
    }
    yield chunk
  }
}

/** Iterate a ZIP's JSON/JSONL members, extracting each (size-capped) to a temp
 *  file and handing it to `handle` — only one member on disk at a time. */
const forEachZipMember = async (
  zipPath: string,
  dir: string,
  handle: (name: string, memberPath: string) => Promise<void>,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        return reject(err ?? new Error('cannot open archive'))
      }
      zipfile.on('error', reject)
      zipfile.on('end', resolve)
      zipfile.readEntry()
      zipfile.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName
        const base = name.split('/').pop() || name
        const skip =
          name.endsWith('/') ||
          name.startsWith('__MACOSX/') ||
          base.startsWith('.') ||
          !/\.(json|jsonl)$/i.test(name) ||
          entry.uncompressedSize > MEMBER_BYTE_CAP // honest-header fast reject; capBytes is the real guard

        if (skip) {
          return zipfile.readEntry()
        }
        zipfile.openReadStream(entry, (e, rs) => {
          if (e || !rs) {
            return reject(e ?? new Error('cannot read archive entry'))
          }
          const memberPath = tmpMember(dir)
          pipeline(rs, capBytes, createWriteStream(memberPath))
            .then(() => handle(name, memberPath))
            .then(() => fs.unlink(memberPath).catch(() => {}))
            .then(() => zipfile.readEntry())
            .catch((err2) => {
              void fs.unlink(memberPath).catch(() => {})
              zipfile.close() // release the archive fd on the failure path
              reject(err2)
            })
        })
      })
    })
  })
}

/** Stream-import the upload, calling `onNote` per parsed note; returns each
 *  recognised member's meta. Throws ImportError when nothing is importable.
 */
export const streamImportFile = async ({
  uploadPath,
  tempDir,
  filename,
  format,
  onNote,
  onFile,
  signal,
  sourceModifiedAt,
}: StreamImportArgs): Promise<ImportFileMeta[]> => {
  const files: ImportFileMeta[] = []

  const record = async (meta: ImportFileMeta): Promise<void> => {
    files.push(meta)
    await onFile?.(meta)
  }

  if (await isZipFile(uploadPath)) {
    await forEachZipMember(uploadPath, tempDir, async (name, memberPath) => {
      // Cancel: throw a plain Error (not ImportError) so it propagates PAST the
      // tolerate-one-bad-member catch below and unwinds the walk.
      if (signal?.aborted) {
        throw new Error('import canceled')
      }
      const meta = await processMember(memberPath, name, format, onNote).catch((err) => {
        if (err instanceof ImportError) {
          return null
        } // tolerate one bad member in an archive
        throw err
      })

      if (meta) {
        await record(meta)
      }
    })
  } else {
    // The upload IS the dropped file here, so its mtime describes this note. Inside
    // a ZIP it would not (the archive's own timestamp), which is why the branch
    // above never threads it.
    const meta = await processMember(
      uploadPath,
      filename || 'upload',
      format,
      onNote,
      sourceModifiedAt,
    )

    if (meta) {
      await record(meta)
    }
  }
  // At least one member must be a RECOGNISED export — an upload of only
  // unsupported/irrelevant members is a no-op the caller must hear about.
  if (!files.some((f) => f.format !== 'unsupported')) {
    throw new ImportError(
      'No recognised export files found in the upload (expected a Claude/ChatGPT conversations.json, a Claude projects.json, an MCP memory.json, or a Claude memories/design-chats export).',
    )
  }

  return files
}
