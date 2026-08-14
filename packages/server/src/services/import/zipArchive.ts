// Bounded ZIP mechanics, shared by the zero-write classification pass and the
// executing pass: open the archive, walk its central directory, and read or
// drain exactly ONE member at a time. Nothing here decides what a member MEANS —
// that is `markdownTree.ts` (tree) and `streamImport.ts` (foreign).
//
// Everything is bounded on purpose: an untrusted archive must never be able to
// make us hold more than one member, trust a header, or keep reading after an
// abort. canon: docs/import.md#data-path

import { createWriteStream, promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

import { ImportError } from '@notarium/core'

/** Clock skew tolerated on an archive-supplied timestamp, matching the route's
 *  `lastModified` rule — one number for "not plausibly in the future". */
const CLOCK_SKEW_MS = 5 * 60_000

/** Info-ZIP "universal timestamp" extra field (`UT`) — the only per-member
 *  timestamp in a ZIP that carries a real epoch instant rather than a
 *  zone-less DOS triple. */
const EXTRA_FIELD_UNIVERSAL_TIME = 0x5455
/** NTFS timestamps extra field — the Windows equivalent, 100-ns since 1601. */
const EXTRA_FIELD_NTFS = 0x000a
const UT_HAS_MTIME = 1
/** Milliseconds between 1601-01-01 and the POSIX epoch. */
const NTFS_EPOCH_OFFSET_MS = 11_644_473_600_000

let tmpSeq = 0

export const tmpMemberPath = (dir: string): string => join(dir, `member-${++tmpSeq}.tmp`)

/** One central-directory record, reduced to what import reasons about. The raw
 *  yauzl entry never escapes this module: a caller that reaches for
 *  `getLastModDate()` gets the library's 1979 clamp instead of an honest null. */
export type ZipMember = {
  /** The member's name, already `/`-separated: yauzl folds `\` to `/` and then
   *  REFUSES any name that still holds one, so there is no second spelling of a
   *  path here to keep in sync. */
  name: string
  isDirectory: boolean
  /** Container noise (`__MACOSX/…`): neither importable nor a user file. */
  isContainerNoise: boolean
  declaredBytes: number
  compressedBytes: number
  /** Validated ISO mtime, or null when the archive states none we can trust. */
  modifiedAt: string | null
}

/** The archive-supplied mtime, or null.
 *
 *  yauzl's `getLastModDate()` cannot express "unknown": a member whose DOS date
 *  and time fields are both zero — what a stream-built ZIP writes when it knows
 *  no timestamp — decodes through `new Date(1980, -1, 0)` into 1979-11-30, and a
 *  fabricated calendar (month 13, day 0) silently rolls over into a real
 *  instant. Both would be indistinguishable from an authored date downstream, so
 *  the raw fields are validated here and an extended timestamp is preferred
 *  whenever the archive carries a TRUSTWORTHY one.
 *
 *  "Trustworthy" is why this is two attempts and not a `??` chain: an extra field
 *  written by a packer with a broken clock (an epoch in the future, or a negative
 *  one) is not better evidence than the DOS pair beside it — and letting it win
 *  merely because it is PRESENT strips the date from every member of that
 *  archive, which is the outcome the fallback exists to prevent.
 *
 *  The DOS triple carries no zone, so it is read as UTC: the alternative (the
 *  library's `new Date(y, m, d, …)`) makes an import's creation dates depend on
 *  the SERVER's timezone, which is neither reproducible nor more correct. */
const memberModifiedAt = (entry: yauzl.Entry, nowMs: number): string | null =>
  trustworthyInstant(extendedTimestampMs(entry), nowMs) ??
  trustworthyInstant(dosTimestampMs(entry), nowMs)

/** An epoch this import is willing to call a real modification time, as ISO. */
const trustworthyInstant = (ms: number | null, nowMs: number): string | null =>
  ms !== null && Number.isFinite(ms) && ms > 0 && ms <= nowMs + CLOCK_SKEW_MS
    ? new Date(ms).toISOString()
    : null

const extendedTimestampMs = (entry: yauzl.Entry): number | null => {
  for (const field of entry.extraFields ?? []) {
    if (field.id === EXTRA_FIELD_UNIVERSAL_TIME) {
      if (field.data.length < 5 || !(field.data[0] & UT_HAS_MTIME)) {
        continue
      }

      return field.data.readInt32LE(1) * 1000
    }
    if (field.id === EXTRA_FIELD_NTFS) {
      // Fixed layout: 4 reserved, tag 1, size 24, then the 8-byte mtime.
      if (field.data.length !== 32 || field.data.readUInt16LE(4) !== 1) {
        continue
      }
      const hundredNs = field.data.readUInt32LE(8) + 4_294_967_296 * field.data.readInt32LE(12)

      return hundredNs / 10_000 - NTFS_EPOCH_OFFSET_MS
    }
  }

  return null
}

/** The raw DOS date/time pair, refused unless it names a real calendar instant.
 *  `0/0` is the archive saying "no timestamp", not the year 1979. */
const dosTimestampMs = (entry: yauzl.Entry): number | null => {
  const date = entry.lastModFileDate
  const time = entry.lastModFileTime

  if (!date && !time) {
    return null
  }
  const day = date & 0x1f
  const month = (date >> 5) & 0xf
  const year = ((date >> 9) & 0x7f) + 1980
  const second = (time & 0x1f) * 2
  const minute = (time >> 5) & 0x3f
  const hour = (time >> 11) & 0x1f

  if (day < 1 || day > 31 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return null
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  const rolled = new Date(ms)

  // Date.UTC rolls an impossible day (Feb 30) into the next month instead of
  // failing. Refuse rather than invent a date the archive never stated.
  if (rolled.getUTCMonth() !== month - 1 || rolled.getUTCDate() !== day) {
    return null
  }

  return ms
}

/** An error the ARCHIVE itself caused — a malformed central directory, a name
 *  that escapes the tree, a member that will not inflate. Deterministic bad
 *  input, so it must reach the job layer as an ImportError (terminal) rather
 *  than as a generic failure worth three retries of the same bytes. */
const archiveError = (err: unknown): unknown =>
  err instanceof ImportError
    ? err
    : Object.assign(new ImportError(`archive is unreadable: ${(err as Error)?.message ?? err}`), {
        cause: err,
      })

/** Open the archive. The handle owns an fd — every caller closes it. */
export const openZip = (path: string): Promise<yauzl.ZipFile> =>
  new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        return reject(archiveError(err ?? new Error('cannot open archive')))
      }
      resolve(zipfile)
    })
  })

/** What a member visitor asks the walker to do next. */
export type MemberVisit = 'continue' | 'stop'

/** The opaque handle a reader needs to open one member. Aliased so a caller can
 *  name it without importing yauzl — the raw entry stays this module's business. */
export type ZipEntry = yauzl.Entry

/** Walk the central directory, handing each member to `visit` in archive order
 *  and awaiting it (backpressure). `visit` may open exactly one read stream on
 *  the member it is handed, via the readers below.
 *
 *  Cancellation destroys the ACTIVE member stream rather than waiting for the
 *  next boundary: a single slow 40 MB member would otherwise keep a canceled
 *  import running to completion. */
export const forEachZipMember = async (
  zipfile: yauzl.ZipFile,
  visit: (member: ZipMember, entry: yauzl.Entry) => Promise<MemberVisit>,
  signal?: AbortSignal,
): Promise<void> => {
  const nowMs = Date.now()

  let detachAbort = () => {}

  await new Promise<void>((resolve, reject) => {
    let settled = false

    const finish = (err?: unknown) => {
      if (settled) {
        return
      }
      settled = true
      if (err) {
        zipfile.close()
        reject(err)
      } else {
        resolve()
      }
    }
    const onAbort = () => finish(new Error('import canceled'))

    signal?.addEventListener('abort', onAbort, { once: true })
    detachAbort = () => signal?.removeEventListener('abort', onAbort)
    // Only the archive's own parse/inflate failures reach this channel; a member
    // visitor's error arrives through the catch below and keeps its own type.
    zipfile.on('error', (err: unknown) => finish(archiveError(err)))
    zipfile.on('end', () => finish())
    zipfile.on('close', () => finish())
    zipfile.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName
      const member: ZipMember = {
        name,
        isDirectory: name.endsWith('/'),
        isContainerNoise: name.startsWith('__MACOSX/') || name.includes('/__MACOSX/'),
        declaredBytes: entry.uncompressedSize,
        compressedBytes: entry.compressedSize,
        modifiedAt: memberModifiedAt(entry, nowMs),
      }

      visit(member, entry)
        .then((next) => {
          if (settled) {
            return
          }
          if (next === 'stop') {
            return finish()
          }
          zipfile.readEntry()
        })
        .catch(finish)
    })
    zipfile.readEntry()
  }).finally(() => {
    detachAbort()
    zipfile.close()
  })
}

/** A read stream over one member, with the abort wired to the stream itself. */
const openMemberStream = (
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  signal?: AbortSignal,
): Promise<Readable> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('import canceled'))
    }
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        return reject(archiveError(err ?? new Error('cannot read archive entry')))
      }
      const onAbort = () => stream.destroy(new Error('import canceled'))

      signal?.addEventListener('abort', onAbort, { once: true })
      stream.on('close', () => signal?.removeEventListener('abort', onAbort))
      resolve(stream)
    })
  })

/** One member crossed the per-read ceiling its caller passed in.
 *
 *  An `ImportError` like any other refusal of bad input — terminal, not worth three
 *  retries of the same bytes — and named only so the throw site and the logs say
 *  which refusal this is. No caller branches on the type: the classification pass
 *  used to retag it into a ceiling and that retag changed no outcome it could name,
 *  so it went. A subclass nobody discriminates would be back to promising one. */
class MemberTooLargeError extends ImportError {
  constructor(message: string) {
    super(message)
    this.name = 'MemberTooLargeError'
  }
}

/** Read a member whole as UTF-8, refusing past `cap`. The cap is enforced on the
 *  bytes that actually arrive — a lying header buys nothing. */
export const readMemberText = async (
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  cap: number,
  onBytes: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<string> => {
  const stream = await openMemberStream(zipfile, entry, signal)
  const chunks: Buffer[] = []
  let read = 0

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    read += chunk.length
    onBytes(chunk.length)
    if (read > cap) {
      stream.destroy()
      throw new MemberTooLargeError(
        `${entry.fileName}: file too large (max ${Math.round(cap / 1e6)} MB)`,
      )
    }
    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf8')
}

/** Read a member's bytes and throw them away, counting them. The ONLY way an
 *  ignored attachment's real size becomes known: `uncompressedSize` is a header
 *  the archive author controls, so a budget that trusts it is not a budget. */
export const drainMember = async (
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  onBytes: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const stream = await openMemberStream(zipfile, entry, signal)

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    onBytes(chunk.length)
  }
}

/** Extract a member to a temp file (the JSON probes and parsers take a path, not
 *  a stream) and hand the path to `use`; the file is removed afterwards.
 *
 *  `use` is handed the SIGNAL as well as the path, and that is not a convenience:
 *  what happens on the extracted file is the expensive half. Destroying the member
 *  stream on abort stops the copy, but a probe that then reads a 256 MB temp file
 *  whole and parses it keeps a canceled import running long after its ZIP was
 *  released. Cancellation has to reach the reader, not only the writer. */
export const withExtractedMember = async <T>(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  dir: string,
  onBytes: (bytes: number) => void,
  use: (path: string, signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  const stream = await openMemberStream(zipfile, entry, signal)
  const path = tmpMemberPath(dir)

  try {
    await pipeline(
      (async function* count() {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          onBytes(chunk.length)
          yield chunk
        }
      })(),
      createWriteStream(path),
    )
    if (signal?.aborted) {
      throw new Error('import canceled')
    }

    return await use(path, signal)
  } finally {
    await fs.unlink(path).catch(() => {})
  }
}
