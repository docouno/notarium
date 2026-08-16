import type { ImportSummary, Job } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { isImportTextPath } from '@notarium/core'

import { ApiError, notifyUnauthorized, sp } from './client'

export type ImportTreeEntry = {
  file: File
  relativePath: string
}

export type ImportUploadSource =
  { kind: 'file'; file: File } | { kind: 'tree'; entries: ImportTreeEntry[] }

/** Browser-owned trees are rejected before either DnD expansion or FormData building. */
export const IMPORT_TREE_ENTRY_LIMIT = 100_000

export type ImportStartOptions = {
  format?: string
  root?: string
  skipExisting?: boolean
  memory?: 'folder' | 'space' | 'skip'
  sendLastModified?: boolean
}

export type ImportProgressLine = {
  imported: number
  phase?: string
  done?: number
  total?: number | null
}

export type ImportStartResult =
  | { mode: 'job'; job: Job }
  | {
      mode: 'sync'
      run: (onProgress: (progress: ImportProgressLine) => void) => Promise<ImportSummary>
    }

const IMPORT_DETAIL_CAP = 200

const cap = <T>(rows: readonly T[] | undefined): { rows: T[]; omitted: number } => {
  const all = Array.isArray(rows) ? rows : []

  return {
    rows: all.slice(0, IMPORT_DETAIL_CAP),
    omitted: Math.max(0, all.length - IMPORT_DETAIL_CAP),
  }
}

/** Tolerant browser-side view of current and legacy persisted job results. */
export const normalizeImportSummary = (raw: unknown): ImportSummary | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const value = raw as Record<string, unknown>
  const count = (key: string) => (typeof value[key] === 'number' ? (value[key] as number) : 0)
  const files = cap(value.files as ImportSummary['files'])
  const errors = cap(value.errors as ImportSummary['errors'])
  const ignoredRaw = value.ignored as ImportSummary['ignored']
  const ignoredFiles = cap(ignoredRaw?.files)
  const omitted = (declared: unknown, local: number) =>
    (typeof declared === 'number' ? declared : 0) + local

  return {
    imported: count('imported'),
    skipped: count('skipped'),
    failed: count('failed'),
    files: files.rows,
    filesOmitted: omitted(value.filesOmitted, files.omitted) || undefined,
    errors: errors.rows,
    errorsOmitted: omitted(value.errorsOmitted, errors.omitted) || undefined,
    repointFailed: count('repointFailed') || undefined,
    ignored: ignoredRaw
      ? {
          count: typeof ignoredRaw.count === 'number' ? ignoredRaw.count : 0,
          files: ignoredFiles.rows,
          filesOmitted: omitted(ignoredRaw.filesOmitted, ignoredFiles.omitted) || undefined,
        }
      : undefined,
    created: Array.isArray(value.created)
      ? (value.created as string[]).slice(0, IMPORT_DETAIL_CAP)
      : [],
  }
}

const readImportStream = async (
  res: Response,
  onProgress: (progress: ImportProgressLine) => void,
): Promise<ImportSummary> => {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let result: ImportSummary | null = null
  let failure: string | null = null
  let partial: ImportSummary | undefined

  const handle = (line: string) => {
    const text = line.trim()

    if (!text) {
      return
    }
    let message: {
      type?: string
      imported?: number
      phase?: string
      done?: number
      total?: number | null
      error?: string
      partial?: ImportSummary
    } & Record<string, unknown>

    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.type === 'progress') {
      onProgress({
        imported: message.imported ?? 0,
        phase: message.phase,
        done: message.done,
        total: message.total ?? null,
      })
    } else if (message.type === 'done') {
      result = message as unknown as ImportSummary
    } else if (message.type === 'error') {
      failure = message.error || 'import failed'
      partial = message.partial
    }
  }

  for (;;) {
    const { value, done } = await reader.read()

    if (done) {
      break
    }
    buf += decoder.decode(value, { stream: true })
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      handle(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  buf += decoder.decode()
  handle(buf)
  if (failure) {
    const error = new ApiError(failure)

    error.partial = partial
    throw error
  }
  if (!result) {
    throw new ApiError('import produced no result')
  }

  return result
}

const appendOptions = (form: FormData, opts: ImportStartOptions, includeMemory: boolean): void => {
  if (opts.format) {
    form.append('format', opts.format)
  }
  if (opts.root) {
    form.append('root', opts.root)
  }
  if (opts.skipExisting) {
    form.append('skipExisting', 'true')
  }
  if (includeMemory && opts.memory) {
    form.append('memory', opts.memory)
  }
}

const appendTree = (form: FormData, source: Extract<ImportUploadSource, { kind: 'tree' }>) => {
  for (const { file, relativePath } of [...source.entries].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  )) {
    const modifiedAt =
      Number.isSafeInteger(file.lastModified) && file.lastModified > 0 ? file.lastModified : 0
    const body = isImportTextPath(relativePath) ? file : file.slice(0, 0)

    form.append(`entry:${modifiedAt}`, body, encodeURIComponent(relativePath))
  }
}

/** Upload one ordinary archive/file or one browser-captured Markdown tree. */
export const importStart = async (
  space: string,
  source: ImportUploadSource,
  opts: ImportStartOptions = {},
  signal?: AbortSignal,
): Promise<ImportStartResult> => {
  const form = new FormData()

  if (source.kind === 'tree') {
    form.append('bundle', 'markdown-tree')
  }
  appendOptions(form, opts, source.kind === 'file')
  if (source.kind === 'file') {
    if (opts.sendLastModified && source.file.lastModified) {
      form.append('lastModified', String(source.file.lastModified))
    }
    form.append('file', source.file)
  } else {
    appendTree(form, source)
  }
  const res = await fetch(`${sp(space)}/import`, { method: 'POST', body: form, signal })

  if (!res.ok || !res.body) {
    if (res.status === HTTP_STATUS.UNAUTHORIZED) {
      notifyUnauthorized()
    }
    const data = (await res.json().catch(() => ({}))) as { error?: unknown }
    const error = new ApiError(
      typeof data.error === 'string' && data.error ? data.error : `HTTP ${res.status}`,
    )

    error.status = res.status
    throw error
  }
  if (res.status === HTTP_STATUS.ACCEPTED) {
    return { mode: 'job', job: (await res.json()) as Job }
  }

  return { mode: 'sync', run: (onProgress) => readImportStream(res, onProgress) }
}

export const importApi = { importStart }
