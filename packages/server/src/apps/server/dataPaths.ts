// Env → the ONE data root and every path derived from it. Pure resolution;
// `ensureDataRoot` owns the filesystem side.
//
// canon: docs/architecture.md#data-root

import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

import {
  assertNotConnectionString,
  IN_MEMORY_DB,
  META_DB_TARGET_KIND,
  metaDbTargetOf,
} from '../../services/metaDb'

const IMPORT_STAGING_SUBDIR = 'imports'

export type DataPaths = {
  dataDir: string
  /** Always canonical: `postgres://…`, `sqlite::memory:`, or `sqlite:<ABSOLUTE path>` —
   *  never the bare-path or relative forms an operator may type. */
  metaDbUrl: string
  engineDataDir: string
  jobsDataDir: string
  /** Import staging — a subtree of jobsDataDir kept as ONE stored field (not a `join()`
   *  each consumer rebuilds), so the write-probe and the store agree on one directory. */
  importStagingDir: string
  /** Candidate only — the zero-config default. An explicit topology
   *  (SPACES_CONFIG / legacy ENGINE+NOTES_DIR) must NOT silently acquire a notes
   *  root; spacesFromEnv owns that decision, not this resolver. */
  defaultSpacesRoot: string
}

/** Data root when DATA_DIR is unset (XDG-style, always user-writable). Per the XDG
 *  spec a relative XDG_DATA_HOME is invalid and ignored. */
const defaultDataDir = (env: NodeJS.ProcessEnv): string => {
  const xdg = env.XDG_DATA_HOME?.trim()

  if (xdg && isAbsolute(xdg)) {
    return join(xdg, 'notarium')
  }
  // HOME from the passed env, not process.env, so this stays a pure function of its argument.
  const home = env.HOME?.trim() || homedir()

  // homedir() returns '' for HOME='' (empty ≠ unset); a relative root would then
  // follow cwd — the defect this resolver exists to remove. Refuse rather than guess.
  if (!isAbsolute(home)) {
    throw new Error(
      'cannot resolve a data root: no usable home directory (HOME is empty).\n' +
        '  Set DATA_DIR=<path> to say where Notarium should keep its data.',
    )
  }

  return join(home, '.local', 'share', 'notarium')
}

/** Canonicalise META_DB_URL to one canonical form. The host's ONE env edge for it,
 *  so a value the classifier refuses stops HERE, before anything derives a path from
 *  it. */
export const metaDbUrlFromEnv = (raw: string | undefined, dataDir: string): string => {
  const trimmed = raw?.trim()

  if (!trimmed) {
    return `sqlite:${join(dataDir, 'meta.db')}`
  }
  const target = metaDbTargetOf(trimmed)

  if (target.kind === META_DB_TARGET_KIND.postgres) {
    return target.url
  }
  // Only a value that classified as a PATH can be a connection string in disguise —
  // a recognised scheme carries its credentials to the driver, where they belong. The
  // PATH is what gets tested, never the raw value: our own `sqlite:` colon would pair
  // with an '@' in a relative path and refuse an ordinary root.
  assertNotConnectionString(target.kind === META_DB_TARGET_KIND.memory ? '' : target.path)

  return target.kind === META_DB_TARGET_KIND.memory
    ? `sqlite:${IN_MEMORY_DB}`
    : `sqlite:${resolve(target.path)}`
}

export const dataPathsFromEnv = (env: NodeJS.ProcessEnv): DataPaths => {
  const dataDir = resolve(env.DATA_DIR?.trim() || defaultDataDir(env))
  const jobsDataDir = resolve(env.JOBS_DATA_DIR?.trim() || join(dataDir, 'jobs'))

  return {
    dataDir,
    metaDbUrl: metaDbUrlFromEnv(env.META_DB_URL, dataDir),
    engineDataDir: resolve(env.ENGINE_DATA_DIR?.trim() || join(dataDir, 'engine')),
    jobsDataDir,
    importStagingDir: join(jobsDataDir, IMPORT_STAGING_SUBDIR),
    defaultSpacesRoot: join(dataDir, 'spaces'),
  }
}

const under = (path: string, root: string): boolean => path === root || path.startsWith(root + sep)

/** Every directory the process will actually WRITE to, labelled. Derived from the
 *  resolved paths, not assumed: an override can put a path outside the root, so
 *  claiming an untouched root would be a lie in the boot log and probe. */
const usedDirs = (
  paths: DataPaths,
  spacesRoot: string | undefined,
): Array<{ dir: string; label: string }> => {
  // Postgres and `:memory:` have no directory to create — only a file target does.
  const target = metaDbTargetOf(paths.metaDbUrl)
  const metaDbDir = target.kind === META_DB_TARGET_KIND.file ? resolve(target.path, '..') : null

  return [
    ...(metaDbDir ? [{ dir: metaDbDir, label: 'meta-DB dir' }] : []),
    { dir: paths.engineDataDir, label: 'engine index dir' },
    { dir: paths.jobsDataDir, label: 'job artifact dir' },
    // Probed separately: a read-only staging subtree would still pass a jobsDataDir probe.
    { dir: paths.importStagingDir, label: 'import staging dir' },
    // Omitted when there's no notes root (explicit topology): those dirs are the
    // operator's to manage, not ours to create.
    ...(spacesRoot ? [{ dir: spacesRoot, label: 'spaces root' }] : []),
  ]
}

/** Legacy meta-DB locations from before the single root; recognition only, nothing
 *  reads or adopts them. Deliberately NOT the docker bind SOURCE
 *  (`docker/volumes/notarium-state/meta.db`): that is the host's path, not one this
 *  process reads — including it made a bare run refuse to start after `make dev`. The
 *  docker layout is the Makefile's to guard. */
const LEGACY_META_DB = ['/state/meta.db', '.data/meta.db']

/** Refuse to start FRESH on top of an un-migrated legacy host. Without this the
 *  upgrade is silent: the derived root is empty but writable, every probe passes,
 *  and a password host with zero users reopens the PUBLIC setup screen — handing
 *  owner to whoever loads it first. The old data is intact and invisible. */
export const legacyMetaDbAt = (env: NodeJS.ProcessEnv, paths: DataPaths): string | null => {
  if (env.META_DB_URL?.trim()) {
    return null
  }
  const ours = metaDbTargetOf(paths.metaDbUrl)

  if (ours.kind !== META_DB_TARGET_KIND.file || existsSync(ours.path)) {
    return null
  }

  return LEGACY_META_DB.map((p) => resolve(p)).find((p) => existsSync(p)) ?? null
}

/** Human-readable data locations for the boot banner: one line normally, the
 *  scattered paths when overrides escape the root. */
export const describeDataPaths = (paths: DataPaths, spacesRoot: string | undefined): string[] => {
  const dirs = usedDirs(paths, spacesRoot)
  const strays = dirs.filter((d) => !under(d.dir, paths.dataDir))

  if (!strays.length) {
    return [`data:   ${paths.dataDir}`]
  }

  return [
    ...(dirs.length > strays.length ? [`data:   ${paths.dataDir}`] : []),
    ...strays.map((d) => `  ${d.label.padEnd(18)} ${d.dir}`),
  ]
}

const probe = async (dir: string, label: string): Promise<void> => {
  const marker = join(dir, `.notarium-write-probe-${process.pid}`)

  try {
    await mkdir(dir, { recursive: true })
    // mkdir succeeding only proves the PARENT is writable — an existing root-owned
    // dir passes it. Only a real write proves this dir.
    await writeFile(marker, '')
  } catch (err) {
    throw new Error(
      `${label} is not writable: ${dir}\n` +
        `  cause: ${(err as Error).message}\n` +
        '  Notarium keeps the meta-DB, engine indexes, job artifacts and spaces under one\n' +
        '  data root. Point it somewhere writable with DATA_DIR=<path>, or mount one:\n' +
        '    docker run -v /host/notarium:/data …\n' +
        '  In Docker the process runs as uid 1000 (node) — the host dir must allow it:\n' +
        '    chown -R 1000:1000 /host/notarium',
    )
  } finally {
    await rm(marker, { force: true }).catch(() => {})
  }
}

/** Create every data directory and PROVE it writable, before anything listens. Each
 *  is probed SEPARATELY: overrides can put them on different mounts, so a writable
 *  root proves nothing about the rest. */
export const ensureDataRoot = async (
  paths: DataPaths,
  spacesRoot: string | undefined,
): Promise<void> => {
  const dirs = usedDirs(paths, spacesRoot)

  // Probe the root first for the clearest common-failure message — but only when
  // something derives from it; otherwise we'd invent an empty dir and blame a root
  // that holds nothing.
  if (dirs.some((d) => under(d.dir, paths.dataDir))) {
    await probe(paths.dataDir, 'data root')
  }
  for (const { dir, label } of dirs) {
    await probe(dir, label)
  }
}
