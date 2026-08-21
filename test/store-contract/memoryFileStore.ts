// A test-only storage adapter, built to the SAME assembly shape as production:
// required base, declared facets, declared accelerators.
//
// It exists so the facet contracts have a second implementation to run against.
// One implementation cannot show that a contract is about the PORT rather than
// about LocalFS, and a second one that reproduced LocalFS would show it even
// less: this one keeps its whole tree in a Map, so anything the contract asks of
// it is answerable only from the port's own promises.
//
// Deliberately not exported from any package and deliberately not named
// `engine-memory`: production composes exactly one FileStore backend.

import { createHash } from 'node:crypto'

import type {
  FileClaim,
  FileClaimedRemoval,
  FileConditionalMutation,
  FileDirectoryNoReplaceMove,
  FileEntryIdentity,
  FileExactRead,
  FileNoReplaceMove,
  FilePackagePublication,
  FilePublicationResult,
  FileResourceExport,
  FileResourceObservation,
  FileResourcePublication,
  FileStat,
  FileStore,
  FileStoreAssembly,
  FileStrictPublication,
  FileStrictStageHeader,
  FileStrictStageState,
  FileWatch,
} from '@notarium/engine'

/** Which facets this adapter declares. Absent ones are absent from the object,
 *  so a contract attaches to what is really there. */
export type MemoryFileStoreFacets = {
  exactRead?: boolean
  resourceExport?: boolean
  conditionalFileMutation?: boolean
  entryIdentity?: boolean
  fileNoReplaceMove?: boolean
  directoryNoReplaceMove?: boolean
  resourceObservation?: boolean
  resourcePublication?: boolean
  claimedRemoval?: boolean
  packagePublication?: boolean
  strictPublication?: boolean
  watch?: boolean
  exactDirectorySpelling?: boolean
}

type MemoryFile = {
  bytes: Uint8Array
  version: number
  mtimeMs: number
}

type StrictRecord = {
  state: Exclude<FileStrictStageState, { status: 'missing' }>
  content: Uint8Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Every ancestor of a storage-relative path, nearest last, root excluded. */
const ancestorsOf = (path: string): string[] => {
  const parts = path.split('/').slice(0, -1)

  return parts.map((_part, index) => parts.slice(0, index + 1).join('/'))
}

const hashOf = (chunks: readonly Uint8Array[]): string => {
  const hash = createHash('sha256')

  for (const chunk of chunks) {
    hash.update(chunk)
  }

  return hash.digest('hex')
}

const sameClaim = (left: FileClaim, right: FileClaim): boolean =>
  left.kind === right.kind && left.value === right.value

export const createMemoryFileStore = (facets: MemoryFileStoreFacets = {}): FileStoreAssembly => {
  /** Pathname → bytes for a file, or `null` for a directory. One map, because a
   *  pathname belongs to exactly one entry — which is the fact every no-replace
   *  answer below rests on. */
  const entries = new Map<string, MemoryFile | null>()
  const strictRecords = new Map<string, StrictRecord>()
  let clock = 1_000
  let version = 0
  let observation = 0

  const isDirectory = (path: string) => entries.has(path) && entries.get(path) === null
  const fileAt = (path: string): MemoryFile | null => entries.get(path) ?? null
  const isFile = (path: string) => entries.get(path) != null

  const mkdirp = (path: string) => {
    for (const ancestor of ancestorsOf(`${path}/leaf`)) {
      if (!entries.has(ancestor)) {
        entries.set(ancestor, null)
      }
    }
  }

  const setFile = (path: string, bytes: Uint8Array) => {
    mkdirp(path)
    clock += 1
    version += 1
    entries.set(path, { bytes: Uint8Array.from(bytes), version, mtimeMs: clock })
  }

  const presentClaim = (path: string): FileClaim & { kind: 'present' } => {
    const entry = entries.get(path)

    return {
      kind: 'present',
      value: entry == null ? `memory:directory:${path}` : `memory:file:${entry.version}`,
    }
  }

  const absentClaim = (path: string): FileClaim & { kind: 'absent' } => ({
    kind: 'absent',
    value: `memory:absent:${path}`,
  })

  const claimAt = (path: string): FileClaim =>
    entries.has(path) ? presentClaim(path) : absentClaim(path)

  const statOf = (path: string): FileStat | null => {
    const file = fileAt(path)

    return file
      ? {
          path,
          mtimeMs: file.mtimeMs,
          size: file.bytes.byteLength,
          changeToken: `memory:${file.version}`,
          birthtimeMs: null,
        }
      : null
  }

  const removeSubtree = (path: string) => {
    for (const key of [...entries.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        entries.delete(key)
      }
    }
  }

  const moveSubtree = (from: string, to: string) => {
    const moving = [...entries.entries()].filter(
      ([key]) => key === from || key.startsWith(`${from}/`),
    )

    for (const [key] of moving) {
      entries.delete(key)
    }
    for (const [key, entry] of moving) {
      const moved = key === from ? to : `${to}${key.slice(from.length)}`

      entries.set(moved, entry)
    }
  }

  const base: FileStore = {
    scan: async () =>
      [...entries.keys()]
        .filter((path) => isFile(path) && path.endsWith('.md'))
        .map((path) => statOf(path)!),
    listDirs: async () => [...entries.keys()].filter(isDirectory).sort(),
    stat: async (path) => statOf(path),
    read: async (path) => {
      const file = fileAt(path)

      return file ? decoder.decode(file.bytes) : null
    },
    write: async (path, content) => setFile(path, encoder.encode(content)),
    rename: async (from, to) => {
      const source = fileAt(from)

      if (!source) {
        throw Object.assign(new Error(`no such file: ${from}`), { code: 'ENOENT' })
      }
      setFile(to, source.bytes)
      entries.delete(from)
    },
    renameDir: async (from, to) => {
      if (!isDirectory(from)) {
        throw Object.assign(new Error(`no such directory: ${from}`), { code: 'ENOTDIR' })
      }
      removeSubtree(to)
      mkdirp(to)
      moveSubtree(from, to)
    },
    remove: async (path) => {
      if (isFile(path)) {
        entries.delete(path)
      }
    },
    makeDir: async (path) => {
      if (entries.has(path)) {
        return false
      }
      mkdirp(path)
      entries.set(path, null)
      return true
    },
    removeDir: async (path) => removeSubtree(path),
    exists: async (path) => entries.has(path),
    dirExists: async (path) => path === '' || isDirectory(path),
  }

  const exactRead: FileExactRead = {
    readBytes: async (path) => {
      const file = fileAt(path)

      return file ? Uint8Array.from(file.bytes) : null
    },
  }

  const resourceExport: FileResourceExport = {
    async *exportFiles() {
      for (const path of [...entries.keys()].filter(isFile).sort()) {
        yield { path, content: Uint8Array.from(fileAt(path)!.bytes) }
      }
    },
  }

  const conditionalFileMutation: FileConditionalMutation = {
    writeIfAbsent: async (path, content) => {
      if (entries.has(path)) {
        return false
      }
      setFile(path, encoder.encode(content))
      return true
    },
    replaceIfAbsent: async (from, to, expectedSource, content) => {
      if (from !== to && entries.has(to)) {
        return false
      }
      const source = fileAt(from)

      if (!source || decoder.decode(source.bytes) !== expectedSource) {
        throw Object.assign(new Error('source changed during move'), { code: 'ESTALE' })
      }
      if (from !== to) {
        entries.delete(from)
      }
      setFile(to, encoder.encode(content))
      return true
    },
    removeIfUnchanged: async (path, expectedContent) => {
      if (!entries.has(path)) {
        return true
      }
      const file = fileAt(path)

      if (!file || decoder.decode(file.bytes) !== expectedContent) {
        return false
      }
      entries.delete(path)
      return true
    },
  }

  const entryIdentity: FileEntryIdentity = {
    sameEntry: async (left, right) => left === right && entries.has(left),
  }

  const fileNoReplaceMove: FileNoReplaceMove = {
    renameIfAbsent: async (from, to) => {
      if (from === to) {
        return isFile(from)
      }
      if (entries.has(to)) {
        return false
      }
      await base.rename(from, to)
      return true
    },
  }

  const directoryNoReplaceMove: FileDirectoryNoReplaceMove = {
    renameDirIfAbsent: async (from, to) => {
      if (entries.has(to)) {
        return false
      }
      await base.renameDir(from, to)
      return true
    },
  }

  const resourceObservation: FileResourceObservation = {
    observe: async (path, options) => {
      const file = fileAt(path)

      if (file) {
        if (options?.maxBytes != null && file.bytes.byteLength > options.maxBytes) {
          return { kind: 'unavailable', reason: 'too-large', mtimeMs: null }
        }

        return {
          kind: 'present',
          bytes: Uint8Array.from(file.bytes),
          claim: presentClaim(path),
          mtimeMs: file.mtimeMs,
        }
      }
      if (isDirectory(path)) {
        return {
          kind: 'occupied',
          claim: presentClaim(path),
          entryType: 'directory',
          mtimeMs: null,
        }
      }

      return { kind: 'absent', claim: absentClaim(path), mtimeMs: null }
    },
  }

  const resourcePublication: FileResourcePublication = {
    publish: async (request): Promise<FilePublicationResult> => {
      if (request.kind === 'put') {
        const before = claimAt(request.path)

        if (!sameClaim(before, request.expected)) {
          return { status: 'conflict' }
        }
        setFile(request.path, request.content)

        return {
          status: 'published',
          candidateHash: hashOf([request.content]),
          transitions: [
            {
              path: request.path,
              before,
              after: presentClaim(request.path),
              mtimeMs: fileAt(request.path)!.mtimeMs,
            },
          ],
        }
      }

      const source = fileAt(request.sourcePath)
      const sourceBefore = claimAt(request.sourcePath)
      const targetBefore = claimAt(request.targetPath)

      if (
        !source ||
        !sameClaim(sourceBefore, request.expectedSource) ||
        !sameClaim(targetBefore, request.expectedTarget)
      ) {
        return { status: 'conflict' }
      }
      entries.delete(request.sourcePath)
      setFile(request.targetPath, request.content)

      return {
        status: 'published',
        candidateHash: hashOf([request.content]),
        transitions: [
          {
            path: request.sourcePath,
            before: sourceBefore,
            after: absentClaim(request.sourcePath),
            mtimeMs: null,
          },
          {
            path: request.targetPath,
            before: targetBefore,
            after: presentClaim(request.targetPath),
            mtimeMs: fileAt(request.targetPath)!.mtimeMs,
          },
        ],
      }
    },
  }

  const claimedRemoval: FileClaimedRemoval = {
    removeIfClaimed: async (path, expectedContent, expectedClaim) => {
      const file = fileAt(path)

      if (
        !file ||
        decoder.decode(file.bytes) !== expectedContent ||
        !sameClaim(presentClaim(path), expectedClaim)
      ) {
        return false
      }
      entries.delete(path)
      return true
    },
  }

  const packagePublication: FilePackagePublication = {
    publishPackageIfAbsent: async (request) => {
      const before = claimAt(request.rootPath)

      if (entries.has(request.rootPath) || !sameClaim(before, request.expectedRoot)) {
        return { status: 'conflict' }
      }
      if (
        !request.files.length ||
        new Set(request.files.map((file) => file.path)).size !== request.files.length
      ) {
        throw new Error('package publication requires unique resource paths')
      }
      mkdirp(request.rootPath)
      entries.set(request.rootPath, null)
      for (const file of request.files) {
        setFile(`${request.rootPath}/${file.path}`, file.content)
      }

      return {
        status: 'published',
        candidateHash: hashOf(request.files.map((file) => file.content)),
        transitions: [
          {
            path: request.rootPath,
            before,
            after: presentClaim(request.rootPath),
            mtimeMs: clock,
          },
          ...request.files.map((file) => {
            const path = `${request.rootPath}/${file.path}`

            return {
              path,
              before: absentClaim(path),
              after: presentClaim(path),
              mtimeMs: fileAt(path)!.mtimeMs,
            }
          }),
        ],
      }
    },
  }

  const strictPublication: FileStrictPublication = {
    restartDurable: false,
    stage: async (request) => {
      const candidateHash = hashOf([request.content])
      const existing = strictRecords.get(request.operationId)

      if (existing) {
        const same =
          existing.state.stage.binding === request.binding &&
          existing.state.stage.path === request.path &&
          sameClaim(existing.state.stage.expected, request.expected) &&
          existing.state.stage.candidateHash === candidateHash

        return same
          ? { status: 'accepted', created: false, state: existing.state }
          : { status: 'idempotency-conflict' }
      }
      const stage: FileStrictStageHeader = {
        operationId: request.operationId,
        binding: request.binding,
        path: request.path,
        expected: { ...request.expected },
        candidateHash,
      }
      const state = { status: 'staged' as const, stage }

      strictRecords.set(request.operationId, {
        state,
        content: Uint8Array.from(request.content),
      })
      return { status: 'accepted', created: true, state }
    },
    inspect: async (operationId, binding) => {
      const record = strictRecords.get(operationId)

      if (!record) {
        return { status: 'missing' }
      }
      if (record.state.stage.binding !== binding) {
        throw Object.assign(new Error('strict publication binding conflict'), {
          code: 'IDEMPOTENCY_BINDING_CONFLICT',
        })
      }

      return record.state
    },
    publish: async (operationId, binding) => {
      const record = strictRecords.get(operationId)

      if (!record) {
        throw Object.assign(new Error('strict publication stage is missing'), {
          code: 'STRICT_STAGE_MISSING',
        })
      }
      const { stage } = record.state

      if (stage.binding !== binding) {
        throw Object.assign(new Error('strict publication binding conflict'), {
          code: 'IDEMPOTENCY_BINDING_CONFLICT',
        })
      }
      if (record.state.status === 'published') {
        return { status: 'published', receipt: record.state.receipt }
      }
      const published = await resourcePublication.publish({
        kind: 'put',
        path: stage.path,
        content: record.content,
        expected: stage.expected,
      })

      if (published.status === 'conflict') {
        return { status: 'conflict', stage }
      }
      observation += 1
      const receipt = {
        operationId,
        binding,
        observationId: `memory:${observation}`,
        semanticEventTime: new Date(clock).toISOString(),
        restartDurable: true as const,
        candidateHash: stage.candidateHash,
        transitions: published.transitions,
      }
      const state = { status: 'published' as const, stage, receipt }

      strictRecords.set(operationId, { ...record, state })
      return { status: 'published', receipt }
    },
    discard: async (operationId, binding) => {
      const record = strictRecords.get(operationId)

      if (!record || record.state.stage.binding !== binding) {
        return false
      }
      strictRecords.delete(operationId)
      return true
    },
  }

  const watch: FileWatch = {
    watch: () => () => {},
  }

  return {
    base,
    capabilities: {
      ...(facets.exactRead ? { exactRead } : {}),
      ...(facets.resourceExport ? { resourceExport } : {}),
      ...(facets.conditionalFileMutation ? { conditionalFileMutation } : {}),
      ...(facets.entryIdentity ? { entryIdentity } : {}),
      ...(facets.fileNoReplaceMove ? { fileNoReplaceMove } : {}),
      ...(facets.directoryNoReplaceMove ? { directoryNoReplaceMove } : {}),
      ...(facets.resourceObservation ? { resourceObservation } : {}),
      ...(facets.resourcePublication ? { resourcePublication } : {}),
      ...(facets.claimedRemoval ? { claimedRemoval } : {}),
      ...(facets.packagePublication ? { packagePublication } : {}),
      ...(facets.strictPublication ? { strictPublication } : {}),
      ...(facets.watch ? { watch } : {}),
    },
    accelerators: {
      ...(facets.exactDirectorySpelling
        ? { exactDirectorySpelling: { dirExistsExact: async (path) => isDirectory(path) } }
        : {}),
    },
  }
}
