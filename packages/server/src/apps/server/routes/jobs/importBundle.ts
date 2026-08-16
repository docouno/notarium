import type { Multipart, MultipartFile, MultipartValue } from '@fastify/multipart'
import { ZipArchive } from 'archiver'
import type { FastifyRequest } from 'fastify'
import { type Readable, Transform } from 'node:stream'

import { isCanonicalSafeRelativePath, isImportTextPath } from '@notarium/core'

import {
  FOLDER_MTIME_COMMENT_PREFIX,
  IMPORT_SOURCE_KIND,
  type ImportSourceKind,
} from '../../../../services/import'

const ZIP_FIELD_MAX_BYTES = 0xffff
const CLOCK_SKEW_MS = 5 * 60_000
const DIRECT_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024

export type ImportBundleLimits = {
  maxEntries: number
  maxMemberBytes: number
  maxAggregateBytes: number
  maxMetadataBytes: number
}

export const DEFAULT_IMPORT_BUNDLE_LIMITS: ImportBundleLimits = {
  maxEntries: 100_000,
  maxMemberBytes: 64 * 1024 * 1024,
  maxAggregateBytes: 6 * 1024 * 1024 * 1024,
  maxMetadataBytes: 32 * 1024 * 1024,
}

export class ImportBundleError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413 = 400,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ImportBundleError'
  }
}

export type ImportUploadSink = {
  write(source: Readable): Promise<string>
  remove(ref: string): Promise<void>
}

export type ReceivedImportUpload = {
  uploadRef: string
  filename: string
  fields: Readonly<Record<string, string>>
  sourceKind?: ImportSourceKind
}

type FolderArchive = Pick<ZipArchive, 'append' | 'destroy' | 'finalize' | 'once' | 'off' | 'on'> &
  Readable

export type ImportBundleOptions = {
  limits?: Partial<ImportBundleLimits>
  archiveFactory?: () => FolderArchive
  /** Test seam for the ZIP comment field's independent 16-bit fence. */
  commentForEntry?: (fieldname: string, path: string) => string
  /** Route-owned field policy, run after the prefix and before any sink/archive work. */
  validateFields?: (fields: Readonly<Record<string, string>>) => void
}

const bundleError = (message: string, statusCode: 400 | 413 = 400): ImportBundleError =>
  new ImportBundleError(message, statusCode)

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(typeof value === 'string' ? value : 'import failed')

/** Exact copy of the basename contract Busboy applies when preservePath is false. */
export const legacyMultipartBasename = (path: string): string => {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path.charCodeAt(i) === 0x2f || path.charCodeAt(i) === 0x5c) {
      const name = path.slice(i + 1)

      return name === '.' || name === '..' ? '' : name
    }
  }

  return path === '.' || path === '..' ? '' : path
}

/** The transformations Archiver and zip-stream both apply before writing a name. */
const packerPath = (path: string): string =>
  path
    .split(/[/\\]+/)
    .join('/')
    .replace(/^\w+:/, '')
    .replace(/^(\.\.\/|\/)+/, '')

const parseTreePath = (encoded: string): string => {
  let decoded: string

  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    throw bundleError('folder entry path is not valid percent-encoding')
  }
  if (!decoded || !isCanonicalSafeRelativePath(decoded) || packerPath(decoded) !== decoded) {
    throw bundleError(`${decoded || encoded}: folder entry path is not canonical and portable`)
  }
  if (Buffer.byteLength(decoded) > ZIP_FIELD_MAX_BYTES) {
    throw bundleError('folder entry path is too long for ZIP')
  }

  return decoded
}

const timestampComment = (fieldname: string, path: string): string => {
  const match = /^entry:(0|[1-9]\d*)$/.exec(fieldname)

  if (!match) {
    throw bundleError(`${path}: folder entry timestamp marker is invalid`)
  }
  const raw = match[1]!
  const ms = Number(raw)

  if (raw !== '0' && (!Number.isSafeInteger(ms) || ms <= 0 || ms > Date.now() + CLOCK_SKEW_MS)) {
    throw bundleError(`${path}: folder entry timestamp is invalid`)
  }

  return `${FOLDER_MTIME_COMMENT_PREFIX}${raw === '0' ? 'unknown' : raw}`
}

const waitForEntry = (
  archive: FolderArchive,
  source: Readable | Buffer,
  data: { name: string; comment: string },
): Promise<void> =>
  new Promise((resolve, reject) => {
    const readable = Buffer.isBuffer(source) ? null : source

    const done = () => {
      archive.off('error', failed)
      readable?.off('error', failed)
      resolve()
    }

    const failed = (error: Error) => {
      archive.off('entry', done)
      archive.off('error', failed)
      readable?.off('error', failed)
      reject(error)
    }

    archive.once('entry', done)
    archive.once('error', failed)
    readable?.once('error', failed)
    try {
      archive.append(source, data)
    } catch (error) {
      archive.off('entry', done)
      archive.off('error', failed)
      reject(error)
    }
  })

const drainEmpty = async (part: MultipartFile, path: string): Promise<void> => {
  for await (const chunk of part.file as AsyncIterable<Buffer>) {
    if (chunk.length > 0) {
      part.file.destroy()
      throw bundleError(`${path}: unsupported folder entry must have an empty body`)
    }
  }
  if (part.file.truncated) {
    throw bundleError(`${path}: folder entry is too large`, 413)
  }
}

const isMultipartLimit = (error: unknown): boolean =>
  ['FST_FILES_LIMIT', 'FST_PARTS_LIMIT', 'FST_FIELDS_LIMIT', 'FST_REQ_FILE_TOO_LARGE'].includes(
    (error as { code?: string } | null)?.code ?? '',
  )

const isMalformedMultipart = (error: unknown): boolean =>
  ['FST_MP_PREMATURE_CLOSE', 'FST_PROTO_VIOLATION'].includes(
    (error as { code?: string } | null)?.code ?? '',
  )

const fieldValue = (part: MultipartValue): string => {
  if (part.fieldnameTruncated || part.valueTruncated || typeof part.value !== 'string') {
    throw bundleError(`multipart field ${part.fieldname} is invalid`)
  }

  return part.value
}

const assertFields = (fields: Record<string, string>, tree: boolean): void => {
  const allowed = new Set(
    tree
      ? ['bundle', 'format', 'root', 'skipExisting']
      : ['format', 'root', 'skipExisting', 'memory', 'lastModified'],
  )

  for (const field of Object.keys(fields)) {
    if (!allowed.has(field)) {
      throw bundleError(`unexpected multipart field: ${field}`)
    }
  }
  if (tree && (fields.bundle !== 'markdown-tree' || fields.format !== 'markdown')) {
    throw bundleError('folder upload requires bundle=markdown-tree and format=markdown')
  }
}

const receiveDirect = async (
  first: MultipartFile,
  iterator: AsyncIterableIterator<Multipart>,
  fields: Record<string, string>,
  sink: ImportUploadSink,
  options: ImportBundleOptions,
): Promise<ReceivedImportUpload> => {
  assertFields(fields, false)
  options.validateFields?.(fields)
  if (first.fieldname !== 'file') {
    first.file.destroy()
    throw bundleError('ordinary import requires one file part')
  }
  const filename = legacyMultipartBasename(first.filename)

  if (!filename) {
    first.file.destroy()
    throw bundleError('uploaded file has no usable name')
  }
  let uploadRef: string | null = null

  try {
    uploadRef = await sink.write(first.file)
    if (first.file.truncated) {
      await sink.remove(uploadRef).catch(() => {})
      throw bundleError('upload too large', 413)
    }
    const extra = await iterator.next()

    if (!extra.done) {
      if (extra.value.type === 'file') {
        extra.value.file.destroy()
      }
      await sink.remove(uploadRef).catch(() => {})
      throw bundleError('ordinary import accepts exactly one file part')
    }
  } catch (error) {
    if (uploadRef) {
      await sink.remove(uploadRef).catch(() => {})
    }
    if (isMultipartLimit(error)) {
      throw bundleError('upload too large', 413)
    }
    throw error
  }

  return { uploadRef, filename, fields }
}

const receiveTree = async (
  first: MultipartFile,
  iterator: AsyncIterableIterator<Multipart>,
  fields: Record<string, string>,
  sink: ImportUploadSink,
  options: ImportBundleOptions,
  requestSignal?: AbortSignal,
): Promise<ReceivedImportUpload> => {
  assertFields(fields, true)
  options.validateFields?.(fields)
  const limits = { ...DEFAULT_IMPORT_BUNDLE_LIMITS, ...options.limits }
  const archive = options.archiveFactory?.() ?? new ZipArchive({ store: true })
  let active: MultipartFile['file'] | null = null
  let fatal: Error | null = null
  let storedRef: string | null = null
  let entries = 0
  let aggregateBytes = 0
  let metadataBytes = 0
  const paths = new Set<string>()

  // An archive error is observed even when it happens before a per-entry waiter exists.
  archive.on('error', (error) => {
    fatal ??= asError(error)
  })
  const abort = (reason: unknown) => {
    fatal ??= asError(reason)
    active?.destroy()
    archive.destroy(fatal)
  }
  const onRequestAbort = () => abort(requestSignal?.reason ?? bundleError('upload was aborted'))

  requestSignal?.addEventListener('abort', onRequestAbort, { once: true })
  const destroyActive = () => active?.destroy()
  const staged = sink.write(archive).then(
    (ref) => ({ ok: true as const, ref }),
    (error) => {
      abort(error)
      return { ok: false as const, error: asError(error) }
    },
  )
  const raceStage = async <T>(work: Promise<T>): Promise<T> =>
    await Promise.race([
      work,
      staged.then((outcome) => {
        if (!outcome.ok) {
          throw outcome.error
        }

        return new Promise<never>(() => {})
      }),
    ])

  const appendPart = async (part: MultipartFile): Promise<void> => {
    active = part.file
    if (++entries > limits.maxEntries) {
      throw bundleError(`folder upload has more than ${limits.maxEntries} entries`, 413)
    }
    const path = parseTreePath(part.filename)

    if (paths.has(path)) {
      throw bundleError(`${path}: duplicate folder entry`)
    }
    paths.add(path)
    const comment = (options.commentForEntry ?? timestampComment)(part.fieldname, path)

    if (Buffer.byteLength(comment) > ZIP_FIELD_MAX_BYTES) {
      throw bundleError(`${path}: folder entry timestamp metadata is too long for ZIP`)
    }
    metadataBytes +=
      2 * Buffer.byteLength(path) +
      Buffer.byteLength(part.filename) +
      Buffer.byteLength(comment) +
      256
    if (metadataBytes > limits.maxMetadataBytes) {
      throw bundleError('folder upload metadata is too large', 413)
    }

    if (!isImportTextPath(path)) {
      await raceStage(drainEmpty(part, path))
      await raceStage(waitForEntry(archive, Buffer.alloc(0), { name: path, comment }))
      active = null
      return
    }

    let memberBytes = 0
    const counted = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        memberBytes += chunk.length
        aggregateBytes += chunk.length
        if (memberBytes > limits.maxMemberBytes) {
          callback(bundleError(`${path}: folder entry is too large`, 413))
        } else if (aggregateBytes > limits.maxAggregateBytes) {
          callback(bundleError('folder upload expands past the aggregate limit', 413))
        } else {
          callback(null, chunk)
        }
      },
    })

    part.file.once('error', (error) => counted.destroy(error))
    part.file.pipe(counted)
    await raceStage(waitForEntry(archive, counted, { name: path, comment }))
    if (part.file.truncated) {
      throw bundleError(`${path}: folder entry is too large`, 413)
    }
    active = null
  }

  try {
    let current: IteratorResult<Multipart> = { done: false, value: first }

    while (!current.done) {
      const part = current.value

      if (part.type !== 'file') {
        throw bundleError(`multipart field ${part.fieldname} must precede folder entries`)
      }
      await appendPart(part)
      current = await raceStage(iterator.next())
    }
    if (entries === 0) {
      throw bundleError('folder upload contains no entries')
    }
    await raceStage(archive.finalize())
    const outcome = await staged

    if (!outcome.ok) {
      throw outcome.error
    }
    storedRef = outcome.ref

    return {
      uploadRef: outcome.ref,
      filename: 'folder-tree.zip',
      fields,
      sourceKind: IMPORT_SOURCE_KIND.folderTree,
    }
  } catch (error) {
    abort(error)
    const outcome = await staged

    if (outcome.ok) {
      storedRef = outcome.ref
    }
    if (storedRef) {
      await sink.remove(storedRef).catch(() => {})
    }
    if (isMultipartLimit(error)) {
      throw bundleError('folder upload is too large', 413)
    }
    if (error instanceof ImportBundleError) {
      throw error
    }
    throw fatal ?? error
  } finally {
    requestSignal?.removeEventListener('abort', onRequestAbort)
    destroyActive()
  }
}

export const receiveImportUpload = async (
  req: FastifyRequest,
  sink: ImportUploadSink,
  options: ImportBundleOptions = {},
): Promise<ReceivedImportUpload> => {
  const limits = { ...DEFAULT_IMPORT_BUNDLE_LIMITS, ...options.limits }
  const iterator = req.parts({
    preservePath: true,
    limits: {
      files: limits.maxEntries,
      parts: limits.maxEntries + 4,
      fields: 4,
      // Direct archives keep the existing 2 GiB wire cap; tree members are
      // independently counted against the much smaller injected member limit.
      fileSize: DIRECT_UPLOAD_MAX_BYTES,
      // encodeURIComponent may take three ASCII bytes per decoded UTF-8 byte.
      headerSize: ZIP_FIELD_MAX_BYTES * 3 + 4096,
    },
  })
  const fields: Record<string, string> = {}
  let firstFile: MultipartFile | null = null
  let requestFailure: ImportBundleError | null = null
  let activeFile: MultipartFile['file'] | null = null
  const requestAbort = new AbortController()

  const failRequest = (message: string) => {
    requestFailure ??= bundleError(message)
    requestAbort.abort(requestFailure)
    activeFile?.destroy()
  }
  const onAborted = () => failRequest('upload request was aborted')

  const onClose = () => {
    if (!req.raw.readableEnded) {
      failRequest('upload request closed before its body ended')
    }
  }

  req.raw.once('aborted', onAborted)
  req.raw.once('close', onClose)
  try {
    for (;;) {
      const next = await iterator.next()

      if (next.done) {
        break
      }
      if (requestFailure) {
        throw requestFailure
      }
      if (next.value.type === 'file') {
        firstFile = next.value
        activeFile = firstFile.file
        break
      }
      if (Object.hasOwn(fields, next.value.fieldname)) {
        throw bundleError(`duplicate multipart field: ${next.value.fieldname}`)
      }
      fields[next.value.fieldname] = fieldValue(next.value)
    }
    if (!firstFile) {
      throw bundleError('no file in the upload')
    }
    const tree = Object.hasOwn(fields, 'bundle')

    return tree
      ? await receiveTree(firstFile, iterator, fields, sink, options, requestAbort.signal)
      : await receiveDirect(firstFile, iterator, fields, sink, options)
  } catch (error) {
    activeFile?.destroy()
    if (isMultipartLimit(error)) {
      throw bundleError('upload is too large', 413)
    }
    if (isMalformedMultipart(error)) {
      throw bundleError('upload request ended before the multipart body was complete')
    }
    if (error instanceof ImportBundleError) {
      throw error
    }
    throw error
  } finally {
    req.raw.off('aborted', onAborted)
    req.raw.off('close', onClose)
  }
}
