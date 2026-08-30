// Online backup and fresh-root restore for the canonical one-root Docker layout.
// The live SQLite WAL is never copied: node:sqlite produces a standalone database,
// while notes and durable job files are admitted only after a stable quiet window.
// canon: docs/backup.md

import { ZipArchive } from 'archiver'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { type Entry, openPromise, type ZipFile } from 'yauzl'

import { type BackupGenerationBundle, isAtomicInstallTempPath } from '@notarium/core'
import { buildInfo } from '../buildInfo'
import { publishArchive } from './archivePublication'

const FORMAT = 'notarium-backup'
const FORMAT_VERSION = 1
const DATA = 'data'
const META_DB = `${DATA}/meta.db`
const REPLAY_KEYRING = `${DATA}/replay-keyring`
const CREDENTIAL_KEYRING = `${DATA}/secret-keyring`
const MANIFEST = 'manifest.json'
const ATOMIC_NOTE_TEMP = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i
// A per-run temp of the import contour: the half-written upload, and the plan
// sidecar a claim writes before publishing it atomically. Neither is data a
// backup should carry — they exist only until their atomic publication lands.
const IMPORT_PART = /^imports\/[^/]+\/[^/]+\.import(?:\.part|-plan\.part-.+)$/
const EXPORT_PART = /^[^/]+\/[^/]+\.[^/]+\.part$/
export const DEFAULT_MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024
export const DEFAULT_MAX_BACKUP_ENTRIES = 1_000_000
export const DEFAULT_MAX_BACKUP_METADATA_BYTES = 32 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 10_000

export const createBackupInputLimiter = (maxBytes: number): Transform => {
  let bytes = 0

  return new Transform({
    transform: (chunk: Buffer, _encoding, callback) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        callback(new Error('backup archive exceeds configured resource limits'))
      } else {
        callback(null, chunk)
      }
    },
  })
}

export type BackupLayout = {
  dataDir: string
  metaDbPath: string
  spacesDir: string
  jobsDir: string
  /** Present for generation-consistent backups. Optional keeps the reusable
   *  library able to verify and restore pre-keyring archives. */
  keyringDir?: string
}

export type BackupFile = {
  path: string
  size: number
  sha256: string
  /** Canonical note modifiedAt comes from the file timestamp. */
  mtimeMs: number
}

export type BackupManifest = {
  format: typeof FORMAT
  formatVersion: typeof FORMAT_VERSION
  createdAt: string
  notariumVersion: string
  files: BackupFile[]
  directories: string[]
  omitted: string[]
  installationGeneration?: BackupGenerationBundle
}

export type BackupGenerationLease = {
  bundle: BackupGenerationBundle
  renew(): Promise<unknown>
  release(): Promise<void>
}

export type CreateBackupOptions = {
  layout: BackupLayout
  output: string
  quietMs?: number
  maxAttempts?: number
  /** Briefly fences live mutations and drains the server's write-behind state. */
  checkpoint: () => Promise<void>
  /** Holds the registry/keyring generation while one immutable stage is built. */
  generationCut?: () => Promise<BackupGenerationLease>
  scratchDir?: string
  maxArchiveBytes?: number
  maxArchiveEntries?: number
  maxMetadataBytes?: number
  onAttempt?: (attempt: number) => void
}

export type CreateBackupResult = {
  output: string
  manifest: BackupManifest
  attempts: number
  bytes: number
}

export type RestoreBackupOptions = {
  layout: BackupLayout
  input: string
  maxArchiveBytes?: number
  maxArchiveEntries?: number
  maxMetadataBytes?: number
}

export type RestoreBackupResult = {
  input: string
  dataDir: string
  manifest: BackupManifest
}

export type VerifyBackupOptions = {
  input: string
  scratchDir?: string
  maxArchiveBytes?: number
  maxArchiveEntries?: number
  maxMetadataBytes?: number
}

export type VerifyBackupResult = {
  input: string
  manifest: BackupManifest
  bytes: number
}

type TreeSnapshot = {
  files: BackupFile[]
  directories: string[]
}

type ResourceLimits = {
  maxArchiveBytes: number
  maxArchiveEntries: number
  maxMetadataBytes: number
}

type ResourceBudget = ResourceLimits & {
  bytes: number
  entries: number
  metadataBytes: number
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

const generationLeaseGuard = (lease: BackupGenerationLease) => {
  let released = false

  return {
    assert: (): Promise<unknown> => lease.renew(),
    release: async (): Promise<void> => {
      if (released) {
        return
      }
      released = true
      await lease.release()
    },
  }
}

const under = (path: string, root: string): boolean => path === root || path.startsWith(root + sep)

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256')

  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
  }

  return hash.digest('hex')
}

const sha256Handle = async (handle: Awaited<ReturnType<typeof open>>): Promise<string> => {
  const hash = createHash('sha256')

  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
    hash.update(chunk as Buffer)
  }

  return hash.digest('hex')
}

const syncFile = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY)

  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)

  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const syncTree = async (root: string): Promise<void> => {
  const info = await lstat(root)

  if (info.isDirectory()) {
    for (const entry of await readdir(root)) {
      await syncTree(join(root, entry))
    }
    await syncDirectory(root)
  } else {
    await syncFile(root)
  }
}

const underRoleSkills = (archiveRoot: string, relPath: string): boolean => {
  if (archiveRoot !== `${DATA}/spaces`) {
    return false
  }
  const parts = relPath.split('/')
  const mount = parts.indexOf('.notarium')

  return mount === 1 && parts[mount + 1] === 'skills'
}

const roleInstallStagingDirectory = (
  archiveRoot: string,
  relPath: string,
  name: string,
  directory: boolean,
): boolean => {
  if (!directory || !underRoleSkills(archiveRoot, relPath)) {
    return false
  }
  const parts = relPath.split('/')
  const mount = parts.indexOf('.notarium')

  return isAtomicInstallTempPath(parts.slice(mount + 2).join('/'))
}

const transient = (
  archiveRoot: string,
  relPath: string,
  name: string,
  directory: boolean,
): boolean =>
  (ATOMIC_NOTE_TEMP.test(name) && !underRoleSkills(archiveRoot, relPath)) ||
  roleInstallStagingDirectory(archiveRoot, relPath, name, directory) ||
  (archiveRoot === `${DATA}/jobs` && (IMPORT_PART.test(relPath) || EXPORT_PART.test(relPath)))

const retryableMutation = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ESTALE'
}

const resourceLimits = (
  maxArchiveBytes = DEFAULT_MAX_BACKUP_BYTES,
  maxArchiveEntries = DEFAULT_MAX_BACKUP_ENTRIES,
  maxMetadataBytes = DEFAULT_MAX_BACKUP_METADATA_BYTES,
): ResourceLimits => {
  if (
    !Number.isSafeInteger(maxArchiveBytes) ||
    maxArchiveBytes < 1 ||
    !Number.isSafeInteger(maxArchiveEntries) ||
    maxArchiveEntries < 1 ||
    !Number.isSafeInteger(maxMetadataBytes) ||
    maxMetadataBytes < 1
  ) {
    throw new Error('backup resource limits must be positive safe integers')
  }

  return { maxArchiveBytes, maxArchiveEntries, maxMetadataBytes }
}

const resourceBudget = (limits: ResourceLimits): ResourceBudget => ({
  ...limits,
  bytes: 0,
  entries: 0,
  metadataBytes: 0,
})

const reserveBytes = (budget: ResourceBudget, bytes: number): void => {
  budget.bytes += bytes
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > budget.maxArchiveBytes) {
    throw new Error('backup data exceeds configured resource limits')
  }
}

const reserveEntry = (budget: ResourceBudget, path: string, bytes = 0): void => {
  budget.entries += 1
  // JSON escaping can expand control characters up to sixfold. Charge the exact
  // escaped token plus a conservative fixed record overhead before constructing
  // the whole manifest, so serialization itself stays within the memory bound.
  budget.metadataBytes += Buffer.byteLength(JSON.stringify(path)) + 256
  if (budget.entries > budget.maxArchiveEntries || budget.metadataBytes > budget.maxMetadataBytes) {
    throw new Error('backup metadata exceeds configured resource limits')
  }
  reserveBytes(budget, bytes)
}

const createBudgetLimiter = (budget: ResourceBudget): Transform =>
  new Transform({
    transform: (chunk: Buffer, _encoding, callback) => {
      try {
        reserveBytes(budget, chunk.length)
        callback(null, chunk)
      } catch (err) {
        callback(err as Error)
      }
    },
  })

const scratchRoot = async (path = tmpdir()): Promise<string> => {
  const root = resolve(path)
  await mkdir(root, { recursive: true })
  const info = await lstat(root)

  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`backup scratch path must be a real directory: ${root}`)
  }

  return root
}

const walk = async (
  root: string,
  archiveRoot: string,
  budget: ResourceBudget,
  copyRoot?: string,
  includeTransient = false,
): Promise<TreeSnapshot> => {
  const files: BackupFile[] = []
  const directories: string[] = []
  const rootInfo = await lstat(root)

  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`backup source root must be a real directory: ${root}`)
  }
  const canonicalRoot = await realpath(root)

  const visit = async (dir: string, relDir: string): Promise<void> => {
    const dirInfo = await lstat(dir)

    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      throw new Error(`refusing to back up non-directory path: ${dir}`)
    }
    const canonicalDir = await realpath(dir)

    if (!under(canonicalDir, canonicalRoot)) {
      throw new Error(`backup source escapes its root: ${dir}`)
    }
    let entries

    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw err
    }

    if (relDir) {
      const archivePath = `${archiveRoot}/${relDir}`
      reserveEntry(budget, archivePath)
      directories.push(archivePath)
      if (copyRoot) {
        await mkdir(join(copyRoot, relDir), { recursive: true })
      }
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      const source = join(dir, entry.name)

      if (!validArchivePath(`${archiveRoot}/${relPath}`)) {
        throw new Error(`source path cannot be represented safely in a backup: ${source}`)
      }
      if (!includeTransient && transient(archiveRoot, relPath, entry.name, entry.isDirectory())) {
        continue
      }
      const sourceInfo = await lstat(source)

      if (sourceInfo.isSymbolicLink()) {
        throw new Error(`refusing to back up symbolic link: ${source}`)
      }
      if (sourceInfo.isDirectory()) {
        await visit(source, relPath)
        continue
      }
      if (!sourceInfo.isFile()) {
        throw new Error(`refusing to back up non-regular file: ${source}`)
      }
      const destination = copyRoot ? join(copyRoot, relPath) : source
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)

      try {
        const opened = await handle.stat()
        const current = await lstat(source)
        const canonicalSource = await realpath(source)

        if (
          !opened.isFile() ||
          opened.dev !== current.dev ||
          opened.ino !== current.ino ||
          !under(canonicalSource, canonicalRoot)
        ) {
          throw Object.assign(new Error(`backup source changed while opening: ${source}`), {
            code: 'ESTALE',
          })
        }
        const mtimeMs = Math.trunc(opened.mtimeMs)
        reserveEntry(budget, `${archiveRoot}/${relPath}`, copyRoot ? 0 : opened.size)

        if (copyRoot) {
          await mkdir(dirname(destination), { recursive: true })
          await pipeline(
            handle.createReadStream({ autoClose: false, start: 0 }),
            createBudgetLimiter(budget),
            createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
          )
          await utimes(destination, opened.atimeMs / 1000, mtimeMs / 1000)
        }
        const measured = copyRoot ? await stat(destination) : opened

        files.push({
          path: `${archiveRoot}/${relPath}`,
          size: measured.size,
          sha256: copyRoot ? await sha256File(destination) : await sha256Handle(handle),
          mtimeMs,
        })
      } finally {
        await handle.close()
      }
    }
    const after = await lstat(dir)

    if (after.dev !== dirInfo.dev || after.ino !== dirInfo.ino) {
      throw Object.assign(new Error(`backup directory changed while reading: ${dir}`), {
        code: 'ESTALE',
      })
    }
  }

  await visit(root, '')
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    directories: directories.sort(),
  }
}

const sameFiles = (a: readonly BackupFile[], b: readonly BackupFile[]): boolean =>
  a.length === b.length &&
  a.every(
    (file, index) =>
      file.path === b[index]?.path &&
      file.size === b[index]?.size &&
      file.sha256 === b[index]?.sha256 &&
      Math.abs(file.mtimeMs - (b[index]?.mtimeMs ?? Number.NaN)) <= 1,
  )

const sameTree = (a: TreeSnapshot, b: TreeSnapshot): boolean =>
  sameFiles(a.files, b.files) &&
  a.directories.length === b.directories.length &&
  a.directories.every((directory, index) => directory === b.directories[index])

const snapshotSource = async (
  layout: BackupLayout,
  limits: ResourceLimits,
): Promise<TreeSnapshot> => {
  const budget = resourceBudget(limits)
  reserveEntry(budget, `${DATA}/jobs`)
  reserveEntry(budget, `${DATA}/spaces`)
  if (layout.keyringDir) {
    reserveEntry(budget, REPLAY_KEYRING)
  }
  const [spacesResult, jobsResult, keyringResult] = await Promise.allSettled([
    walk(layout.spacesDir, `${DATA}/spaces`, budget),
    walk(layout.jobsDir, `${DATA}/jobs`, budget),
    ...(layout.keyringDir ? [walk(layout.keyringDir, REPLAY_KEYRING, budget)] : []),
  ])

  if (spacesResult.status === 'rejected') {
    throw spacesResult.reason
  }
  if (jobsResult.status === 'rejected') {
    throw jobsResult.reason
  }
  if (keyringResult?.status === 'rejected') {
    throw keyringResult.reason
  }
  const spaces = spacesResult.value
  const jobs = jobsResult.value
  const keyring = keyringResult?.status === 'fulfilled' ? keyringResult.value : undefined

  return {
    files: [...spaces.files, ...jobs.files, ...(keyring?.files ?? [])].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
    directories: [
      `${DATA}/jobs`,
      `${DATA}/spaces`,
      ...(keyring ? [REPLAY_KEYRING] : []),
      ...spaces.directories,
      ...jobs.directories,
      ...(keyring?.directories ?? []),
    ].sort(),
  }
}

const copySource = async (
  layout: BackupLayout,
  stageData: string,
  budget: ResourceBudget,
): Promise<TreeSnapshot> => {
  await Promise.all([
    mkdir(join(stageData, 'spaces'), { recursive: true }),
    mkdir(join(stageData, 'jobs'), { recursive: true }),
    ...(layout.keyringDir ? [mkdir(join(stageData, 'replay-keyring'), { recursive: true })] : []),
  ])
  reserveEntry(budget, `${DATA}/jobs`)
  reserveEntry(budget, `${DATA}/spaces`)
  if (layout.keyringDir) {
    reserveEntry(budget, REPLAY_KEYRING)
  }
  // Await BOTH walkers even when one fails. Promise.all would reject early while
  // the sibling still writes into the stage, racing the attempt's cleanup.
  const [spacesResult, jobsResult, keyringResult] = await Promise.allSettled([
    walk(layout.spacesDir, `${DATA}/spaces`, budget, join(stageData, 'spaces')),
    walk(layout.jobsDir, `${DATA}/jobs`, budget, join(stageData, 'jobs')),
    ...(layout.keyringDir
      ? [walk(layout.keyringDir, REPLAY_KEYRING, budget, join(stageData, 'replay-keyring'))]
      : []),
  ])

  if (spacesResult.status === 'rejected') {
    throw spacesResult.reason
  }
  if (jobsResult.status === 'rejected') {
    throw jobsResult.reason
  }
  if (keyringResult?.status === 'rejected') {
    throw keyringResult.reason
  }
  const spaces = spacesResult.value
  const jobs = jobsResult.value
  const keyring = keyringResult?.status === 'fulfilled' ? keyringResult.value : undefined

  return {
    files: [...spaces.files, ...jobs.files, ...(keyring?.files ?? [])].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
    directories: [
      `${DATA}/jobs`,
      `${DATA}/spaces`,
      ...(keyring ? [REPLAY_KEYRING] : []),
      ...spaces.directories,
      ...jobs.directories,
      ...(keyring?.directories ?? []),
    ].sort(),
  }
}

const dataVersion = (db: DatabaseSync): number => {
  const row = db.prepare('PRAGMA data_version').get() as { data_version: number }
  return Number(row.data_version)
}

const assertIntegrity = (path: string): void => {
  const db = new DatabaseSync(path, { readOnly: true })

  try {
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }

    if (row.integrity_check !== 'ok') {
      throw new Error(`SQLite integrity_check failed: ${row.integrity_check}`)
    }
  } finally {
    db.close()
  }
}

const writeArchive = async (
  stage: string,
  output: string,
  manifest: BackupManifest,
  serializedManifest: string,
  verifyOptions: Pick<
    VerifyBackupOptions,
    'scratchDir' | 'maxArchiveBytes' | 'maxArchiveEntries' | 'maxMetadataBytes'
  >,
): Promise<number> => {
  const absolute = resolve(output)
  const partial = `${absolute}.partial-${randomUUID()}`

  await mkdir(dirname(absolute), { recursive: true })
  try {
    await lstat(absolute)
    throw new Error(`backup output already exists: ${absolute}`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }

  await writeFile(join(stage, MANIFEST), serializedManifest, { mode: 0o600 })

  try {
    const outputStream = createWriteStream(partial, { flags: 'wx', mode: 0o600 })
    const archive = new ZipArchive({ zlib: { level: 9 } })
    const writing = pipeline(
      archive,
      createBackupInputLimiter(verifyOptions.maxArchiveBytes ?? DEFAULT_MAX_BACKUP_BYTES),
      outputStream,
    )

    archive.file(join(stage, MANIFEST), { name: MANIFEST })
    for (const directory of manifest.directories) {
      archive.append('', { name: `${directory}/` })
    }
    for (const file of manifest.files) {
      archive.file(join(stage, file.path), { name: file.path })
    }
    await Promise.all([archive.finalize(), writing])
    await syncFile(partial)
    // Producer and consumer share the exact contract: never publish an archive
    // that our own verifier would refuse (unsafe source names, structure drift).
    await verifyDataBackup({ input: partial, ...verifyOptions })
    return await publishArchive(partial, absolute)
  } catch (err) {
    await rm(partial, { force: true })
    throw err
  }
}

/** Build an immutable stage while the service remains online, then compress it. */
export const createOnlineDataBackup = async ({
  layout,
  output,
  quietMs = 750,
  maxAttempts = 12,
  checkpoint,
  generationCut,
  scratchDir,
  maxArchiveBytes,
  maxArchiveEntries,
  maxMetadataBytes,
  onAttempt,
}: CreateBackupOptions): Promise<CreateBackupResult> => {
  if (
    !Number.isInteger(quietMs) ||
    quietMs < 0 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1
  ) {
    throw new Error('quietMs must be >= 0 and maxAttempts must be >= 1')
  }
  if (Boolean(layout.keyringDir) !== Boolean(generationCut)) {
    throw new Error('generation-consistent backup requires both keyringDir and generationCut')
  }
  const absoluteOutput = resolve(output)
  const dataInfo = await lstat(layout.dataDir)

  if (dataInfo.isSymbolicLink() || !dataInfo.isDirectory()) {
    throw new Error(`DATA_DIR must be a real directory: ${layout.dataDir}`)
  }
  const canonicalData = await realpath(layout.dataDir)
  await mkdir(dirname(absoluteOutput), { recursive: true })
  const canonicalOutputParent = await realpath(dirname(absoluteOutput))

  if (
    under(absoluteOutput, resolve(layout.dataDir)) ||
    under(canonicalOutputParent, canonicalData)
  ) {
    throw new Error('backup output must be outside DATA_DIR')
  }
  await stat(layout.metaDbPath)
  const limits = resourceLimits(maxArchiveBytes, maxArchiveEntries, maxMetadataBytes)
  const work = await mkdtemp(join(await scratchRoot(scratchDir), 'notarium-backup-'))
  const sourceDb = new DatabaseSync(layout.metaDbPath, { readOnly: true })

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      onAttempt?.(attempt)
      const stage = join(work, `attempt-${attempt}`)
      const stageData = join(stage, DATA)
      const budget = resourceBudget(limits)
      const lease = await generationCut?.()
      const leaseGuard = lease ? generationLeaseGuard(lease) : undefined

      try {
        await leaseGuard?.assert()
        await checkpoint()
        await mkdir(stageData, { recursive: true })
        const copied = await copySource(layout, stageData, budget)
        await sleep(quietMs)
        await leaseGuard?.assert()
        const before = await snapshotSource(layout, limits)
        const versionBefore = dataVersion(sourceDb)

        if (!sameTree(copied, before)) {
          await rm(stage, { recursive: true, force: true })
          continue
        }

        const stagedDb = join(stage, META_DB)
        const pageSize = Number(
          (sourceDb.prepare('PRAGMA page_size').get() as { page_size: number }).page_size,
        )
        const pageCount = Number(
          (sourceDb.prepare('PRAGMA page_count').get() as { page_count: number }).page_count,
        )
        let reservedDbBytes = pageSize * pageCount
        reserveEntry(budget, META_DB, reservedDbBytes)
        await sqliteBackup(sourceDb, stagedDb, {
          rate: 1,
          progress: ({ totalPages }) => {
            const currentBytes = totalPages * pageSize

            if (currentBytes > reservedDbBytes) {
              reserveBytes(budget, currentBytes - reservedDbBytes)
              reservedDbBytes = currentBytes
            }
          },
        })
        assertIntegrity(stagedDb)
        await sleep(quietMs)
        await checkpoint()
        const after = await snapshotSource(layout, limits)
        const versionAfter = dataVersion(sourceDb)

        if (!sameTree(before, after) || versionBefore !== versionAfter) {
          await rm(stage, { recursive: true, force: true })
          continue
        }
        await leaseGuard?.assert()

        const dbStat = await stat(stagedDb)

        if (dbStat.size > reservedDbBytes) {
          reserveBytes(budget, dbStat.size - reservedDbBytes)
        }
        const manifest: BackupManifest = {
          format: FORMAT,
          formatVersion: FORMAT_VERSION,
          createdAt: new Date().toISOString(),
          notariumVersion: buildInfo.version,
          files: [
            {
              path: META_DB,
              size: dbStat.size,
              sha256: await sha256File(stagedDb),
              mtimeMs: Math.trunc(dbStat.mtimeMs),
            },
            ...copied.files,
          ].sort((a, b) => a.path.localeCompare(b.path)),
          directories: copied.directories,
          omitted: [`${DATA}/engine`],
          ...(lease ? { installationGeneration: lease.bundle } : {}),
        }
        const serializedManifest = JSON.stringify(manifest, null, 2) + '\n'
        const manifestBytes = Buffer.byteLength(serializedManifest)

        if (manifestBytes > limits.maxMetadataBytes) {
          throw new Error('backup manifest exceeds configured metadata limits')
        }
        reserveEntry(budget, MANIFEST, manifestBytes)
        // The immutable stage now contains both sides of the witnessed cut. No
        // generation lease is needed while CPU-only ZIP publication proceeds.
        await leaseGuard?.assert()
        await leaseGuard?.release()
        const bytes = await writeArchive(stage, absoluteOutput, manifest, serializedManifest, {
          scratchDir,
          ...limits,
        })

        return { output: absoluteOutput, manifest, attempts: attempt, bytes }
      } catch (err) {
        await rm(stage, { recursive: true, force: true })
        if (retryableMutation(err)) {
          continue
        }
        throw err
      } finally {
        await leaseGuard?.release().catch(() => {})
      }
    }
  } finally {
    sourceDb.close()
    await rm(work, { recursive: true, force: true })
  }

  throw new Error(
    `data kept changing during ${maxAttempts} backup attempts; no archive was published — retry when writes are quieter`,
  )
}

const validArchivePath = (name: string): boolean => {
  if (!name || name.includes('\\') || name.includes('\0') || isAbsolute(name)) {
    return false
  }
  const directory = name.endsWith('/')
  const parts = name.split('/').filter(Boolean)
  const canonical = `${parts.join('/')}${directory ? '/' : ''}`

  return (
    parts.length > 0 && name === canonical && parts.every((part) => part !== '.' && part !== '..')
  )
}

const openEntry = (zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> =>
  new Promise((resolveStream, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error(`cannot read ZIP entry ${entry.fileName}`))
      } else {
        resolveStream(stream)
      }
    })
  })

const extractArchive = async (
  input: string,
  stage: string,
  limits: ResourceLimits,
): Promise<void> => {
  const zip = await openPromise(input, { lazyEntries: true, validateEntrySizes: true })
  const seen = new Set<string>()
  let entries = 0
  let expandedBytes = 0
  let metadataBytes = 0

  try {
    await new Promise<void>((resolveExtract, reject) => {
      zip.on('error', reject)
      zip.on('end', resolveExtract)
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          entries += 1
          expandedBytes += entry.uncompressedSize
          metadataBytes += Buffer.byteLength(entry.fileName) + 128

          if (
            entries > limits.maxArchiveEntries ||
            !Number.isSafeInteger(expandedBytes) ||
            expandedBytes > limits.maxArchiveBytes ||
            !Number.isSafeInteger(metadataBytes) ||
            metadataBytes > limits.maxMetadataBytes
          ) {
            throw new Error('backup archive exceeds configured resource limits')
          }
          if (entry.fileName === MANIFEST && entry.uncompressedSize > limits.maxMetadataBytes) {
            throw new Error('backup manifest exceeds configured metadata limits')
          }
          if (
            entry.compressedSize > 0 &&
            entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO
          ) {
            throw new Error(`suspicious ZIP compression ratio: ${entry.fileName}`)
          }
          if (!validArchivePath(entry.fileName)) {
            throw new Error(`unsafe ZIP entry path: ${entry.fileName}`)
          }
          const canonicalEntry = entry.fileName.replace(/\/+$/, '')

          if (seen.has(canonicalEntry)) {
            throw new Error(`duplicate ZIP entry: ${entry.fileName}`)
          }
          seen.add(canonicalEntry)
          if (entry.fileName !== MANIFEST && !entry.fileName.startsWith(`${DATA}/`)) {
            throw new Error(`unexpected ZIP entry: ${entry.fileName}`)
          }
          const target = join(stage, entry.fileName)
          const targetResolved = resolve(target)

          if (!under(targetResolved, stage)) {
            throw new Error(`unsafe ZIP entry path: ${entry.fileName}`)
          }
          if (entry.fileName.endsWith('/')) {
            await mkdir(target, { recursive: true })
          } else {
            await mkdir(dirname(target), { recursive: true })
            const stream = await openEntry(zip, entry)
            await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o600 }))
          }
          zip.readEntry()
        })().catch(reject)
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}

const parseManifest = async (stage: string, limits: ResourceLimits): Promise<BackupManifest> => {
  const manifestPath = join(stage, MANIFEST)
  const manifestStat = await stat(manifestPath)

  if (manifestStat.size > limits.maxMetadataBytes) {
    throw new Error('backup manifest exceeds configured metadata limits')
  }
  const raw = await readFile(manifestPath, 'utf8')
  const value = JSON.parse(raw) as Partial<BackupManifest>

  if (
    value.format !== FORMAT ||
    value.formatVersion !== FORMAT_VERSION ||
    typeof value.createdAt !== 'string' ||
    typeof value.notariumVersion !== 'string' ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.directories) ||
    !Array.isArray(value.omitted)
  ) {
    throw new Error('unsupported or malformed Notarium backup manifest')
  }
  const generation = value.installationGeneration

  if (
    generation !== undefined &&
    (!Number.isSafeInteger(generation.generation) ||
      generation.generation < 1 ||
      typeof generation.keyId !== 'string' ||
      !/^rk_[0-9a-f]{24}$/.test(generation.keyId) ||
      typeof generation.activeHash !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(generation.activeHash) ||
      generation.candidateKeyId !== null ||
      generation.candidateHash !== null)
  ) {
    throw new Error('backup contains a malformed or unstable installation generation')
  }
  const seen = new Set<string>()

  for (const file of value.files) {
    if (
      typeof file?.path === 'string' &&
      (file.path === CREDENTIAL_KEYRING || file.path.startsWith(`${CREDENTIAL_KEYRING}/`))
    ) {
      throw new Error('backup must not contain the provider credential keyring')
    }
    if (
      !file ||
      typeof file.path !== 'string' ||
      !validArchivePath(file.path) ||
      (file.path !== META_DB &&
        !file.path.startsWith(`${DATA}/spaces/`) &&
        !file.path.startsWith(`${DATA}/jobs/`) &&
        !file.path.startsWith(`${REPLAY_KEYRING}/`)) ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.mtimeMs !== 'number' ||
      !Number.isSafeInteger(file.mtimeMs) ||
      file.mtimeMs < 0 ||
      seen.has(file.path)
    ) {
      throw new Error('malformed file entry in Notarium backup manifest')
    }
    seen.add(file.path)
  }
  const seenDirectories = new Set<string>()

  for (const directory of value.directories) {
    if (
      typeof directory === 'string' &&
      (directory === CREDENTIAL_KEYRING || directory.startsWith(`${CREDENTIAL_KEYRING}/`))
    ) {
      throw new Error('backup must not contain the provider credential keyring')
    }
    if (
      typeof directory !== 'string' ||
      !validArchivePath(directory) ||
      (directory !== `${DATA}/spaces` &&
        directory !== `${DATA}/jobs` &&
        directory !== REPLAY_KEYRING &&
        !directory.startsWith(`${DATA}/spaces/`) &&
        !directory.startsWith(`${DATA}/jobs/`) &&
        !directory.startsWith(`${REPLAY_KEYRING}/`)) ||
      seen.has(directory) ||
      seenDirectories.has(directory)
    ) {
      throw new Error('malformed directory entry in Notarium backup manifest')
    }
    seenDirectories.add(directory)
  }
  if (!seen.has(META_DB)) {
    throw new Error('backup does not contain data/meta.db')
  }
  if (!seenDirectories.has(`${DATA}/spaces`) || !seenDirectories.has(`${DATA}/jobs`)) {
    throw new Error('backup does not contain the canonical data directories')
  }
  if (generation && !seenDirectories.has(REPLAY_KEYRING)) {
    throw new Error('generation-consistent backup does not contain the replay keyring')
  }
  if (!generation && seenDirectories.has(REPLAY_KEYRING)) {
    throw new Error('backup contains a replay keyring without a generation bundle')
  }

  return value as BackupManifest
}

const verifyExtracted = async (
  stage: string,
  manifest: BackupManifest,
  limits: ResourceLimits,
): Promise<void> => {
  for (const file of manifest.files) {
    await utimes(join(stage, file.path), file.mtimeMs / 1000, file.mtimeMs / 1000)
  }
  // Source backups omit incomplete writer temps; restore verification must not.
  // Otherwise an unmanifested *.part payload could hide from the checksum set.
  const actual = await walk(join(stage, DATA), DATA, resourceBudget(limits), undefined, true)
  const expected = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path))
  const expectedDirectories = [...manifest.directories].sort()

  if (
    !sameFiles(actual.files, expected) ||
    actual.directories.length !== expectedDirectories.length ||
    actual.directories.some((directory, index) => directory !== expectedDirectories[index])
  ) {
    const mismatchedFiles = actual.files
      .map((file, index) => ({ actual: file, expected: expected[index] }))
      .filter(
        ({ actual: file, expected: wanted }) =>
          !wanted ||
          file.path !== wanted.path ||
          file.size !== wanted.size ||
          file.sha256 !== wanted.sha256 ||
          Math.abs(file.mtimeMs - wanted.mtimeMs) > 1,
      )
    throw new Error(
      `backup contents do not match manifest checksums (files=${JSON.stringify(mismatchedFiles)}, directories=${JSON.stringify(actual.directories)} expected=${JSON.stringify(expectedDirectories)})`,
    )
  }
  assertIntegrity(join(stage, META_DB))
  const generation = manifest.installationGeneration

  if (generation) {
    const keyPath = `${REPLAY_KEYRING}/keys/${generation.keyId}.json`
    const key = manifest.files.find((file) => file.path === keyPath)

    if (!key || `sha256:${key.sha256}` !== generation.activeHash) {
      throw new Error('backup replay key does not match the generation bundle')
    }
    let keyPayload: { format?: unknown; formatVersion?: unknown; keyId?: unknown; secret?: unknown }

    try {
      keyPayload = JSON.parse(await readFile(join(stage, keyPath), 'utf8')) as typeof keyPayload
    } catch {
      throw new Error('backup active replay key is corrupt')
    }
    const secret =
      typeof keyPayload.secret === 'string' ? Buffer.from(keyPayload.secret, 'base64url') : null
    const derivedKeyId = secret
      ? `rk_${createHash('sha256')
          .update('notarium-replay-key-id\0')
          .update(secret)
          .digest('hex')
          .slice(0, 24)}`
      : null

    if (
      keyPayload.format !== 'notarium-replay-key' ||
      keyPayload.formatVersion !== 1 ||
      keyPayload.keyId !== generation.keyId ||
      !secret ||
      secret.length !== 32 ||
      secret.toString('base64url') !== keyPayload.secret ||
      derivedKeyId !== generation.keyId
    ) {
      throw new Error('backup active replay key is invalid')
    }
    const pointerPath = join(stage, REPLAY_KEYRING, 'active.json')
    let pointer: {
      format?: unknown
      formatVersion?: unknown
      generation?: unknown
      keyId?: unknown
      keyHash?: unknown
    }

    try {
      pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as typeof pointer
    } catch {
      throw new Error('backup active replay-key pointer is missing or corrupt')
    }
    if (
      pointer.format !== 'notarium-replay-key-pointer' ||
      pointer.formatVersion !== 1 ||
      pointer.generation !== generation.generation ||
      pointer.keyId !== generation.keyId ||
      pointer.keyHash !== generation.activeHash
    ) {
      throw new Error('backup active replay-key pointer does not match the generation bundle')
    }
    const db = new DatabaseSync(join(stage, META_DB), { readOnly: true })

    try {
      const row = db
        .prepare(
          `SELECT generation, phase, active_key_id, active_hash,
                  candidate_key_id, candidate_hash
             FROM installation_generation
            WHERE singleton = 1`,
        )
        .get() as
        | {
            generation: number
            phase: string
            active_key_id: string
            active_hash: string
            candidate_key_id: string | null
            candidate_hash: string | null
          }
        | undefined

      if (
        !row ||
        Number(row.generation) !== generation.generation ||
        row.phase !== 'active-installed' ||
        row.active_key_id !== generation.keyId ||
        row.active_hash !== generation.activeHash ||
        row.candidate_key_id !== null ||
        row.candidate_hash !== null
      ) {
        throw new Error('backup meta-DB does not match the installation generation bundle')
      }
    } finally {
      db.close()
    }
  }
}

/** Validate an archive without reading or mutating the configured data root. */
export const verifyDataBackup = async ({
  input,
  scratchDir,
  maxArchiveBytes,
  maxArchiveEntries,
  maxMetadataBytes,
}: VerifyBackupOptions): Promise<VerifyBackupResult> => {
  const absoluteInput = resolve(input)
  const inputStat = await stat(absoluteInput)
  const limits = resourceLimits(maxArchiveBytes, maxArchiveEntries, maxMetadataBytes)

  if (inputStat.size > limits.maxArchiveBytes) {
    throw new Error('backup archive exceeds configured resource limits')
  }
  const stage = await mkdtemp(join(await scratchRoot(scratchDir), 'notarium-backup-verify-'))

  try {
    await extractArchive(absoluteInput, stage, limits)
    const manifest = await parseManifest(stage, limits)
    await verifyExtracted(stage, manifest, limits)

    return {
      input: absoluteInput,
      manifest,
      bytes: inputStat.size,
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

type InstalledPath = {
  path: string
  directory: boolean
}

const installNoClobber = async (
  source: string,
  destination: string,
  installed: InstalledPath[],
): Promise<void> => {
  const info = await lstat(source)

  if (info.isDirectory()) {
    await mkdir(destination, { mode: 0o700 })
    installed.push({ path: destination, directory: true })
    for (const entry of (await readdir(source)).sort()) {
      await installNoClobber(join(source, entry), join(destination, entry), installed)
    }

    return
  }
  if (!info.isFile()) {
    throw new Error(`restore stage contains a non-regular path: ${source}`)
  }
  await link(source, destination)
  installed.push({ path: destination, directory: false })
}

/** Restore is intentionally offline and fresh-target-only: disaster recovery may stop; backup may not. */
export const restoreDataBackup = async ({
  layout,
  input,
  maxArchiveBytes,
  maxArchiveEntries,
  maxMetadataBytes,
}: RestoreBackupOptions): Promise<RestoreBackupResult> => {
  const absoluteInput = resolve(input)
  const limits = resourceLimits(maxArchiveBytes, maxArchiveEntries, maxMetadataBytes)

  const inputStat = await stat(absoluteInput)

  if (inputStat.size > limits.maxArchiveBytes) {
    throw new Error('backup archive exceeds configured resource limits')
  }
  await mkdir(layout.dataDir, { recursive: true })
  const dataInfo = await lstat(layout.dataDir)

  if (dataInfo.isSymbolicLink() || !dataInfo.isDirectory()) {
    throw new Error(`restore target must be a real directory: ${layout.dataDir}`)
  }
  const existing = await readdir(layout.dataDir)

  if (existing.length > 0) {
    if (existing.some((name) => name.startsWith('.notarium-restore-'))) {
      throw new Error(
        `restore target contains an interrupted restore; discard this fresh target and restore into a new empty DATA_DIR, then place the matching secret-keyring before first start: ${layout.dataDir}`,
      )
    }
    throw new Error(
      `restore target must be a fresh empty DATA_DIR; restore the archive first, then place the matching secret-keyring before first start: ${layout.dataDir}`,
    )
  }

  const stage = join(layout.dataDir, `.notarium-restore-${randomUUID()}`)
  await mkdir(stage, { mode: 0o700 })
  await syncDirectory(layout.dataDir)
  const installed: InstalledPath[] = []

  try {
    await extractArchive(absoluteInput, stage, limits)
    const manifest = await parseManifest(stage, limits)
    await verifyExtracted(stage, manifest, limits)

    const stagedData = join(stage, DATA)
    const installNames = [
      'meta.db',
      'spaces',
      'jobs',
      ...(manifest.installationGeneration ? ['replay-keyring'] : []),
    ]

    for (const name of installNames) {
      await installNoClobber(join(stagedData, name), join(layout.dataDir, name), installed)
    }
    for (const name of installNames) {
      await syncTree(join(layout.dataDir, name))
    }
    await syncDirectory(layout.dataDir)
    await rm(stage, { recursive: true, force: true })
    await syncDirectory(layout.dataDir)

    return { input: absoluteInput, dataDir: layout.dataDir, manifest }
  } catch (err) {
    const rollbackErrors: unknown[] = []

    for (const entry of installed.reverse()) {
      const remove = entry.directory ? rmdir(entry.path) : unlink(entry.path)
      await remove.catch((rollback) => rollbackErrors.push(rollback))
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [err, ...rollbackErrors],
        `restore failed and rollback was incomplete; discard this target: ${layout.dataDir}`,
      )
    }
    await rm(stage, { recursive: true, force: true })
    await syncDirectory(layout.dataDir)
    throw err
  }
}
