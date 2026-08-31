import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  canonicalManifestLine,
  comparePathsBytewise,
  isExternalVisualBaseline,
  snapshotDenyRule,
  sourceDigestOf,
} from './contract.mjs'

const execFileAsync = promisify(execFile)

const gitPaths = async (root, args) => {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })

  return stdout.toString('utf8').split('\0').filter(Boolean)
}

const repositoryInventory = (root) => ({
  selected: () => gitPaths(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
  cached: () => gitPaths(root, ['ls-files', '--cached', '-z']),
  deleted: () => gitPaths(root, ['ls-files', '--deleted', '-z']),
  status: async () => {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      {
        cwd: root,
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
      },
    )

    return stdout
  },
})

const safeRepositoryPath = (path) => {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe repository path from git: ${JSON.stringify(path)}`)
  }

  return path
}

const hashFile = (path) =>
  new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)

    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })

const visualBaselines = async (root) => {
  const folder = join(root, 'test/visual/visual.spec.ts-snapshots')
  let names

  try {
    names = await readdir(folder)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return []
    }
    throw error
  }

  return names
    .filter((name) => name.endsWith('.png'))
    .map((name) => `test/visual/visual.spec.ts-snapshots/${name}`)
    .filter(isExternalVisualBaseline)
}

const copySnapshotEntry = async ({ root, sourceRoot, path, beforeCopy }) => {
  const source = join(root, path)
  const destination = join(sourceRoot, path)
  let stat

  try {
    stat = await lstat(source)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  }

  await mkdir(dirname(destination), { recursive: true })

  if (stat.isSymbolicLink()) {
    const target = await readlink(source)

    await beforeCopy?.(path)
    const currentTarget = await readlink(source)

    if (currentTarget !== target) {
      throw new Error(`source drifted while snapshotting symlink ${path}`)
    }
    await symlink(target, destination)

    return {
      path,
      kind: 'symlink',
      mode: stat.mode & 0o777,
      size: Buffer.byteLength(target),
      target,
    }
  }
  if (!stat.isFile()) {
    throw new Error(`unsupported repository entry while snapshotting ${path}`)
  }

  const sha256 = await hashFile(source)

  await beforeCopy?.(path)
  try {
    await copyFile(source, destination)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`source disappeared while snapshotting file ${path}`)
    }
    throw error
  }
  await chmod(destination, stat.mode & 0o777)
  const copiedHash = await hashFile(destination)
  const copiedStat = await lstat(destination)

  if (copiedHash !== sha256 || (copiedStat.mode & 0o777) !== (stat.mode & 0o777)) {
    throw new Error(`source drifted while snapshotting file ${path}`)
  }

  return {
    path,
    kind: 'file',
    mode: stat.mode & 0o777,
    size: copiedStat.size,
    sha256,
  }
}

const materializeSourceSnapshot = async ({
  repositoryRoot,
  sessionRoot,
  beforeCopy,
  inventory,
  signal,
}) => {
  signal?.throwIfAborted()
  const sourceRoot = join(sessionRoot, 'source')
  const sourceInventory = inventory ?? repositoryInventory(repositoryRoot)
  const [selected, cached, deleted, visuals, status] = await Promise.all([
    sourceInventory.selected(),
    sourceInventory.cached(),
    sourceInventory.deleted(),
    visualBaselines(repositoryRoot),
    sourceInventory.status(),
  ])
  const cachedSet = new Set(cached)
  const deletedSet = new Set(deleted)
  const paths = [...new Set([...selected, ...visuals])]
    .map(safeRepositoryPath)
    .sort(comparePathsBytewise)
  const denied = []
  const rows = []

  await mkdir(sourceRoot, { recursive: true })

  for (const path of paths) {
    signal?.throwIfAborted()
    const denyRule = snapshotDenyRule(path)

    if (denyRule) {
      denied.push({ path, rule: denyRule, tracked: cachedSet.has(path) })
      continue
    }

    const row = await copySnapshotEntry({ root: repositoryRoot, sourceRoot, path, beforeCopy })

    if (row) {
      rows.push(row)
      continue
    }
    if (!deletedSet.has(path)) {
      throw new Error(`source disappeared while snapshotting ${path}`)
    }
  }
  signal?.throwIfAborted()

  const sourceDigest = sourceDigestOf(rows)
  const manifestPath = join(sessionRoot, 'manifest.jsonl')
  const manifest = rows.map(canonicalManifestLine).join('')

  await writeFile(manifestPath, manifest)

  const relativeSource = relative(sessionRoot, sourceRoot)

  if (!relativeSource || relativeSource.startsWith(`..${sep}`)) {
    throw new Error('snapshot source root escaped its session root')
  }

  return {
    sessionRoot,
    sourceRoot,
    manifestPath,
    sourceDigest,
    rows,
    denied,
    fileCount: rows.length,
    byteCount: rows.reduce((sum, row) => sum + row.size, 0),
    dirty: status.length > 0,
  }
}

/**
 * @param {{
 *   root?: string,
 *   sessionRoot?: string,
 *   beforeCopy?: ((path: string) => void | Promise<void>),
 *   inventory?: *,
 *   signal?: AbortSignal,
 *   temporaryRootFactory?: (() => Promise<string>)
 * }} [options]
 */
export const createSourceSnapshot = async (options = {}) => {
  const {
    root,
    sessionRoot,
    beforeCopy,
    inventory,
    signal,
    temporaryRootFactory = () => mkdtemp(join(tmpdir(), 'notarium-checkup-')),
  } = options
  const ownsSessionRoot = !sessionRoot
  const resolvedSessionRoot = sessionRoot
    ? resolve(sessionRoot)
    : resolve(await temporaryRootFactory())

  try {
    return await materializeSourceSnapshot({
      repositoryRoot: resolve(root ?? process.cwd()),
      sessionRoot: resolvedSessionRoot,
      beforeCopy,
      inventory,
      signal,
    })
  } catch (error) {
    if (ownsSessionRoot) {
      try {
        await rm(resolvedSessionRoot, { recursive: true, force: true })
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `snapshot failed and its owned session root could not be removed: ${resolvedSessionRoot}`,
        )
      }
    }

    throw error
  }
}

export const readSnapshotManifest = async (manifestPath) =>
  (await readFile(manifestPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

const snapshotInventory = async (sourceRoot, folder = '') => {
  const entries = await readdir(join(sourceRoot, folder), { withFileTypes: true })
  const inventory = []

  for (const entry of entries.sort((left, right) => comparePathsBytewise(left.name, right.name))) {
    const path = folder ? `${folder}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      inventory.push({ path, kind: 'directory' })
      inventory.push(...(await snapshotInventory(sourceRoot, path)))
    } else if (entry.isFile()) {
      inventory.push({ path, kind: 'file' })
    } else if (entry.isSymbolicLink()) {
      inventory.push({ path, kind: 'symlink' })
    } else {
      inventory.push({ path, kind: 'unsupported' })
    }
  }

  return inventory
}

const expectedSnapshotEntries = (rows) => {
  const expected = new Map()

  for (const row of rows) {
    safeRepositoryPath(row.path)
    if (expected.has(row.path)) {
      throw new Error(`snapshot manifest contains duplicate path: ${row.path}`)
    }
    const segments = row.path.split('/')

    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join('/')
      const existing = expected.get(directory)

      if (existing && existing !== 'directory') {
        throw new Error(`snapshot manifest path crosses non-directory entry: ${row.path}`)
      }
      expected.set(directory, 'directory')
    }
    expected.set(row.path, row.kind)
  }

  return expected
}

export const verifySourceSnapshot = async ({ sourceRoot, rows }) => {
  const expected = expectedSnapshotEntries(rows)
  const actual = await snapshotInventory(sourceRoot)

  for (const entry of actual) {
    const expectedKind = expected.get(entry.path)

    if (!expectedKind) {
      throw new Error(`snapshot contains path outside manifest: ${entry.path}`)
    }
    if (expectedKind !== entry.kind) {
      throw new Error(
        `snapshot entry kind changed after verification: ${entry.path} (${expectedKind} -> ${entry.kind})`,
      )
    }
    expected.delete(entry.path)
  }
  if (expected.size) {
    const [missing] = [...expected.keys()].sort(comparePathsBytewise)

    throw new Error(`snapshot manifest path is missing: ${missing}`)
  }

  for (const row of rows) {
    const path = join(sourceRoot, row.path)
    const metadata = await lstat(path)

    if ((metadata.mode & 0o777) !== row.mode) {
      throw new Error(`snapshot mode changed after verification: ${row.path}`)
    }
    if (row.kind === 'symlink') {
      if (!metadata.isSymbolicLink() || (await readlink(path)) !== row.target) {
        throw new Error(`snapshot symlink changed after verification: ${row.path}`)
      }
    } else if (!metadata.isFile() || (await hashFile(path)) !== row.sha256) {
      throw new Error(`snapshot file changed after verification: ${row.path}`)
    }
  }

  return true
}
