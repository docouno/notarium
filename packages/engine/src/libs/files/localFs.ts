// localfs adapter of the storage seam — the only place in the engine that
// touches node:fs (P9: Node-isms live in edge adapters). Owns the safety
// rails: every relative path is resolved against the root and must stay under
// it (second rampart behind the host's relPath normalisation, same belt-and-
// suspenders the bare driver had), writes are tmp+rename atomic.
//
// Directories are DURABLE (#97): they are never auto-pruned when emptied — a
// folder is a first-class organising primitive (file-first, Obsidian-style), so
// moving the last note out of a folder leaves the folder standing. The directory
// channel (`listDirs`) surfaces them into the tree; an explicit `removeDir` is
// the only thing that deletes one. (Pre-#97 the engine rmdir'd emptied dirs so
// the note-derived tree matched the index; the directory
// channel replaces that — the tree shows real on-disk folders now.)

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs, constants as fsConstants, watch as fsWatch } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { clipToBytes, UNNAMED_NOTE_FILENAME } from '@notarium/core'

import type { FileStat, FileStore } from './types'

/** Directory entries the scan never descends into: dotfiles hide editor/state
 *  dirs (.obsidian, .git — and our own tmp files are dot-named, so a mid-write
 *  rescan can't index a half file). */
const hidden = (name: string) => name.startsWith('.')

/** A change event under a hidden path (a dot-segment anywhere in its relative
 *  path) is noise the watcher ignores (#146): the tmp half of our atomic write is
 *  dot-named (`.<uuid>.tmp`), and .git/.obsidian churn never affects the note
 *  index (scan/listDirs skip dot-dirs too). NB the rename TARGET of our own write
 *  is a real `note.md` — non-hidden — so a write-through still self-fires a watch
 *  event; that's harmless (the read-model already patched its snapshot and
 *  coalesces the redundant reconcile via its trailing debounce). A dot-namespaced
 *  sub-mount (.notarium/memory) is watched by its OWN FileStore — rooted there,
 *  its paths carry no leading dot, so this filter on the root watcher doesn't
 *  blind the agent-mount. */
const hiddenPath = (rel: string | null): boolean =>
  rel != null && rel.split('/').some((seg) => seg.startsWith('.'))

const toPosix = (p: string) => p.split(sep).join('/')

const TEMP_WRITE_ATTEMPTS = 8
const MAX_PATH_COMPONENT_BYTES = 255
const FS_OPS_DIR = '.notarium-fs-ops'
const FS_OP_VERSION = 1
const FS_OP_NAME = /^op-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const nsToMs = (ns: bigint): number => Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1_000_000

const errnoCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

type FsMoveIntent = {
  version: typeof FS_OP_VERSION
  kind: 'rename' | 'replace'
  source: string
  target: string
  expectedSourceHash: string
  finalHash: string
  sameEntry: boolean
  legacySourceLinkedTarget: boolean
}

type FsMoveOperation = {
  id: string
  dir: string
  manifest: string
  preparing: string
  active: string
  done: string
  sourceArtifact: string
  finalArtifact: string
  detachedSource: string
  detachedTarget: string
  intent: FsMoveIntent
  source: string
  target: string
}

const execFileAsync = promisify(execFile)

/** Linux syscall numbers are ABI, not kernel-version dependent. Keep the
 * supported set deliberately small: an unknown runtime must fail closed rather
 * than emulate RENAME_NOREPLACE with a check-then-rename sequence. */
const RENAMEAT2_SYSCALL: Partial<Record<NodeJS.Architecture, number>> = {
  arm64: 276,
  x64: 316,
}
const PERL_RENAME_NOREPLACE = String.raw`
  use strict;
  use warnings;
  my ($nr, $from, $to) = @ARGV;
  my $result = syscall(0 + $nr, -100, $from, -100, $to, 1);
  exit 0 if $result == 0;
  print STDERR 0 + $!;
  exit 1;
`

/** Call renameat2(RENAME_NOREPLACE) directly. GNU mv is intentionally not a
 * capability boundary: its portability layer may fall back to a raceable
 * lstat+rename implementation when the syscall or filesystem is unsupported. */
const renameNoReplaceNative = async (source: string, target: string): Promise<boolean> => {
  const syscall = process.platform === 'linux' ? RENAMEAT2_SYSCALL[process.arch] : undefined

  if (syscall === undefined) {
    throw Object.assign(new Error('atomic no-replace rename is unavailable'), {
      code: 'ENOTSUP',
    })
  }

  try {
    await execFileAsync('/usr/bin/perl', [
      '-e',
      PERL_RENAME_NOREPLACE,
      String(syscall),
      source,
      target,
    ])
    return true
  } catch (err) {
    const nativeErrno = Number((err as { stderr?: string }).stderr?.trim())

    if (nativeErrno === 17) {
      return false
    }
    const code =
      nativeErrno === 2
        ? 'ENOENT'
        : nativeErrno === 18
          ? 'EXDEV'
          : [22, 38, 95].includes(nativeErrno)
            ? 'ENOTSUP'
            : 'EIO'

    throw Object.assign(new Error('atomic no-replace rename failed'), {
      cause: err,
      code,
      errno: Number.isFinite(nativeErrno) ? nativeErrno : undefined,
    })
  }
}

type RootLockState = { tail: Promise<void>; pending: number }
const rootLocks = new Map<string, RootLockState>()

/** All LocalFS adapters for one root share one mutation/recovery lane. Without
 * it a freshly-created adapter can interpret another adapter's active journal
 * as a crashed operation and complete it underneath the live caller. */
const withRootLock = async <T>(root: string, task: () => Promise<T>): Promise<T> => {
  const state = rootLocks.get(root) ?? { tail: Promise.resolve(), pending: 0 }

  rootLocks.set(root, state)
  const turn = state.tail
  let release!: () => void
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate
  })

  state.tail = turn.then(() => gate)
  state.pending++
  await turn
  try {
    return await task()
  } finally {
    release()
    state.pending--
    if (state.pending === 0 && rootLocks.get(root) === state) {
      rootLocks.delete(root)
    }
  }
}

const recoveryName = (stem: string, markdown: boolean): string => {
  const suffix = `.recovered-${randomUUID()}${markdown ? '.md' : ''}`
  const boundedStem = clipToBytes(
    stem || 'unnamed',
    MAX_PATH_COMPONENT_BYTES - Buffer.byteLength(suffix),
  )
  return `${boundedStem || 'unnamed'}${suffix}`
}

/** Read only the exact regular pathname entry. A plain readFile follows symlinks
 *  and blocks opening a FIFO; neither is a note body the scanner can index. The
 *  opened-handle identity check closes the lstat→open replacement window. */
const readRegular = async (path: string): Promise<string | null> => {
  let handle

  try {
    const before = await fs.lstat(path, { bigint: true })

    if (!before.isFile() || before.isSymbolicLink()) {
      return null
    }
    handle = await fs.open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const opened = await handle.stat({ bigint: true })

    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      return null
    }

    return await handle.readFile({ encoding: 'utf8' })
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Publishable bytes in a temp file claimed by THIS operation. The random name
 *  makes a collision vanishingly unlikely; `wx` is the correctness boundary —
 *  the filesystem, not probability, proves that no concurrent writer owns it.
 *  An EEXIST file belongs to somebody else and must never be cleaned up here. */
const writeTemp = async (dir: string, content: string): Promise<string> => {
  let collision: unknown

  for (let attempt = 0; attempt < TEMP_WRITE_ATTEMPTS; attempt++) {
    const tmp = join(dir, `.${randomUUID()}.tmp`)
    let handle

    try {
      handle = await fs.open(tmp, 'wx')
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') {
        collision = err
        continue
      }
      throw err
    }

    // Only a successful exclusive open transfers ownership of this pathname to
    // the operation. From here on cleanup is safe; before it, even an existing
    // same-name file is somebody else's and must not be unlinked.
    let failure: { error: unknown } | undefined

    try {
      await handle.writeFile(content, 'utf8')
    } catch (err) {
      failure = { error: err }
    }

    try {
      await handle.close()
    } catch (err) {
      failure ??= { error: err }
    }

    if (failure) {
      // Cleanup is best-effort: the write/close error is the operation's truth
      // and must never be masked by unlink.
      await fs.unlink(tmp).catch(() => {})
      throw failure.error
    }

    return tmp
  }

  throw collision ?? new Error('failed to claim a temporary file')
}

export const createLocalFsFiles = (root: string): FileStore => {
  const rootAbs = resolve(root)

  const withStorageLock = async <T>(task: () => Promise<T>): Promise<T> => {
    const key = await fs.realpath(rootAbs).catch(() => rootAbs)

    return withRootLock(key, task)
  }

  /** Map a storage-relative path onto the disk, refusing lexical escapes. The
   *  configured vault's directory topology is trusted in v1; this is not a
   *  realpath containment check for symlinked parents. */
  const abs = (rel: string): string => {
    // A backslash is a legal legacy POSIX filename byte and therefore survives
    // the domain address grammar. On Windows it is a separator instead: reject
    // it here so one canonical storage key can never resolve to another path.
    if (sep === '\\' && rel.includes('\\')) {
      throw new Error(`path contains a non-canonical Windows separator: ${rel}`)
    }
    const full = resolve(rootAbs, rel)

    if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
      throw new Error(`path escapes the storage root: ${rel}`)
    }

    return full
  }

  const statOf = async (rel: string): Promise<FileStat | null> => {
    try {
      const s = await fs.stat(abs(rel), { bigint: true })

      if (!s.isFile()) {
        return null
      }

      return {
        path: rel,
        mtimeMs: nsToMs(s.mtimeNs),
        size: Number(s.size),
        // An opaque, zero-extra-I/O prefilter. ctime catches in-place rewrites
        // whose mtime was restored; inode catches atomic replacement. Neither is
        // trusted forever — the engine's source hash sweep remains the arbiter.
        changeToken: `${s.dev}:${s.ino}:${s.ctimeNs}`,
        // Filesystems without creation time report 0 (or the epoch) — that is
        // "unknown", never a real date.
        birthtimeMs: s.birthtimeNs > 0n ? nsToMs(s.birthtimeNs) : null,
      }
    } catch {
      return null
    }
  }

  const sameInode = async (left: string, right: string): Promise<boolean> => {
    try {
      const [a, b] = await Promise.all([
        fs.lstat(left, { bigint: true }),
        fs.lstat(right, { bigint: true }),
      ])

      return a.dev === b.dev && a.ino === b.ino
    } catch {
      return false
    }
  }

  const sameEntryOnDisk = async (left: string, right: string): Promise<boolean> => {
    try {
      const [a, b, realLeft, realRight] = await Promise.all([
        fs.lstat(left, { bigint: true }),
        fs.lstat(right, { bigint: true }),
        fs.realpath(left),
        fs.realpath(right),
      ])

      return a.dev === b.dev && a.ino === b.ino && realLeft === realRight
    } catch {
      return false
    }
  }

  const opsRoot = join(rootAbs, FS_OPS_DIR)

  const relativeStoragePath = (path: string): string => {
    const rel = toPosix(relative(rootAbs, path))

    if (!rel || rel === '..' || rel.startsWith('../') || abs(rel) !== path) {
      throw new Error(`operation path escapes the storage root: ${path}`)
    }
    if (rel === FS_OPS_DIR || rel.startsWith(`${FS_OPS_DIR}/`)) {
      throw new Error('operation path enters the LocalFS recovery namespace')
    }

    return rel
  }

  const operationPaths = (id: string, intent: FsMoveIntent): FsMoveOperation => {
    const dir = join(opsRoot, id)

    return {
      id,
      dir,
      manifest: join(dir, 'intent.json'),
      preparing: join(dir, 'preparing'),
      active: join(dir, 'active'),
      done: join(dir, 'done'),
      sourceArtifact: join(dir, 'source'),
      finalArtifact: join(dir, 'final'),
      detachedSource: join(dir, 'detached-source'),
      detachedTarget: join(dir, 'detached-target'),
      intent,
      source: abs(intent.source),
      target: abs(intent.target),
    }
  }

  const pathExists = async (path: string): Promise<boolean> => {
    try {
      await fs.lstat(path)
      return true
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') {
        return false
      }
      throw err
    }
  }

  const writeMarker = async (path: string): Promise<void> => {
    const handle = await fs.open(path, 'wx')

    await handle.close()
  }

  /** A committed/resolved operation keeps `done` until every private artifact is
   *  gone. Removing that marker LAST makes cleanup restart-safe: an interrupted
   *  cleanup can never be mistaken for an uncommitted public transition. */
  const cleanupDoneDir = async (dir: string): Promise<void> => {
    for (const path of [
      join(dir, 'detached-target'),
      join(dir, 'detached-source'),
      join(dir, 'final'),
      join(dir, 'source'),
      join(dir, 'intent.json'),
      join(dir, 'preparing'),
      join(dir, 'active'),
    ]) {
      await fs.unlink(path).catch((err) => {
        if (errnoCode(err) !== 'ENOENT') {
          throw err
        }
      })
    }
    await fs.unlink(join(dir, 'done')).catch((err) => {
      if (errnoCode(err) !== 'ENOENT') {
        throw err
      }
    })
    await fs.rmdir(dir).catch((err) => {
      if (errnoCode(err) !== 'ENOENT') {
        throw err
      }
    })
    await fs.rmdir(opsRoot).catch((err) => {
      if (!['ENOENT', 'ENOTEMPTY'].includes(errnoCode(err) ?? '')) {
        throw err
      }
    })
  }

  const resolveOperation = async (operation: FsMoveOperation): Promise<void> => {
    if (!(await pathExists(operation.done))) {
      try {
        await fs.rename(operation.active, operation.done)
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT' || !(await pathExists(operation.done))) {
          throw err
        }
      }
    }
    // Once `done` exists the namespace transition is committed. Private cleanup
    // is retryable housekeeping and must not turn a successful move into failure.
    await cleanupDoneDir(operation.dir).catch(() => {})
  }

  const createMoveOperation = async (
    kind: FsMoveIntent['kind'],
    source: string,
    target: string,
    expectedSource: string,
    finalContent: string,
    sameEntry: boolean,
    legacySourceLinkedTarget = false,
  ): Promise<FsMoveOperation> => {
    await fs.mkdir(opsRoot, { recursive: true })
    let operation: FsMoveOperation | undefined

    for (let attempt = 0; attempt < TEMP_WRITE_ATTEMPTS; attempt++) {
      const id = `op-${randomUUID()}`
      const intent: FsMoveIntent = {
        version: FS_OP_VERSION,
        kind,
        source: relativeStoragePath(source),
        target: relativeStoragePath(target),
        expectedSourceHash: sha256(expectedSource),
        finalHash: sha256(finalContent),
        sameEntry,
        legacySourceLinkedTarget,
      }
      const candidate = operationPaths(id, intent)

      try {
        await fs.mkdir(candidate.dir)
        operation = candidate
        break
      } catch (err) {
        if (errnoCode(err) !== 'EEXIST') {
          throw err
        }
      }
    }
    if (!operation) {
      throw new Error('failed to claim a LocalFS move journal directory')
    }

    try {
      await writeMarker(operation.preparing)
      await fs.writeFile(operation.manifest, JSON.stringify(operation.intent), { flag: 'wx' })
      await fs.link(source, operation.sourceArtifact)
      if ((await readRegular(operation.sourceArtifact)) !== expectedSource) {
        throw staleMove()
      }
      if (kind === 'replace') {
        await fs.writeFile(operation.finalArtifact, finalContent, { flag: 'wx' })
      } else {
        // A distinct inode is intentional: it is the durable ownership proof for
        // the destination. A pre-existing user hardlink to the source is then
        // distinguishable from OUR publication after a process stop. Preserve the
        // ordinary rename metadata that Node can express; xattrs/ACLs remain outside
        // the FileStore contract (which promises exact bytes).
        const sourceStat = await fs.stat(operation.sourceArtifact, { bigint: true })

        await fs.copyFile(
          operation.sourceArtifact,
          operation.finalArtifact,
          fsConstants.COPYFILE_EXCL,
        )
        await fs.chmod(operation.finalArtifact, Number(sourceStat.mode & 0o777n))
        await fs.utimes(
          operation.finalArtifact,
          Number(sourceStat.atimeNs) / 1_000_000_000,
          Number(sourceStat.mtimeNs) / 1_000_000_000,
        )
      }
      if ((await readRegular(operation.finalArtifact)) !== finalContent) {
        throw staleMove()
      }
      // `active` is the durable permission to inspect/repair public paths. A
      // process stop before this rename leaves only preparation artifacts, which
      // recovery may discard because no public mutation was allowed yet.
      await fs.rename(operation.preparing, operation.active)
      return operation
    } catch (err) {
      await fs.rm(operation.dir, { recursive: true, force: true }).catch(() => {})
      await fs.rmdir(opsRoot).catch(() => {})
      throw err
    }
  }

  const parseMoveIntent = (raw: string): FsMoveIntent => {
    const value: unknown = JSON.parse(raw)

    if (
      typeof value !== 'object' ||
      value === null ||
      (value as Partial<FsMoveIntent>).version !== FS_OP_VERSION ||
      !['rename', 'replace'].includes(String((value as Partial<FsMoveIntent>).kind)) ||
      typeof (value as Partial<FsMoveIntent>).source !== 'string' ||
      typeof (value as Partial<FsMoveIntent>).target !== 'string' ||
      !/^[0-9a-f]{64}$/.test(String((value as Partial<FsMoveIntent>).expectedSourceHash)) ||
      !/^[0-9a-f]{64}$/.test(String((value as Partial<FsMoveIntent>).finalHash)) ||
      typeof (value as Partial<FsMoveIntent>).sameEntry !== 'boolean' ||
      typeof (value as Partial<FsMoveIntent>).legacySourceLinkedTarget !== 'boolean'
    ) {
      throw new Error('invalid LocalFS move recovery intent')
    }

    // The journal lives inside a user-visible vault and may be externally
    // corrupted. Recovery may fail closed, but it must never let a forged
    // manifest alias `a/../b` or point back into the private operation
    // namespace. Fresh intents are canonicalized by relativeStoragePath; require
    // that exact representation again before touching either public pathname.
    for (const rel of [(value as FsMoveIntent).source, (value as FsMoveIntent).target]) {
      if (relativeStoragePath(abs(rel)) !== rel) {
        throw new Error('invalid LocalFS move recovery path')
      }
    }

    return value as FsMoveIntent
  }

  const readMoveOperation = async (id: string): Promise<FsMoveOperation> => {
    const dir = join(opsRoot, id)
    const intent = parseMoveIntent(await fs.readFile(join(dir, 'intent.json'), 'utf8'))

    return operationPaths(id, intent)
  }

  /** Keep a private hardlink to the source inode while the public path remains
   *  available. The successful link is also our proof that cleanup owns `claim`. */
  const claimSource = async (source: string): Promise<string> => {
    let collision: unknown

    for (let attempt = 0; attempt < TEMP_WRITE_ATTEMPTS; attempt++) {
      const claim = join(dirname(source), `.${randomUUID()}.move`)

      try {
        await fs.link(source, claim)
        return claim
      } catch (err) {
        if (errnoCode(err) === 'EEXIST') {
          collision = err
          continue
        }
        throw err
      }
    }

    throw collision ?? new Error('failed to claim a move staging path')
  }

  type DetachResult = { status: 'absent' | 'removed' | 'changed'; recovery?: string }

  /** Remove `path` only while it is still the inode held by `claim`.
   *
   *  lstat alone is not a guard: another writer can replace the pathname before
   *  unlink. Rename it into an operation-owned directory first, compare there,
   *  and unlink only that private pathname. If we captured somebody else's
   *  replacement, put it back with a no-replace hardlink. A second racing owner
   *  wins the original name; the displaced regular file is surfaced beside it
   *  as a recovery note instead of being discarded. */
  const detachClaimedPath = async (
    path: string,
    claim: string,
    expectedContent?: string,
  ): Promise<DetachResult> => {
    try {
      await fs.lstat(path)
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') {
        return { status: 'absent' }
      }
      throw err
    }
    if (!(await sameInode(path, claim))) {
      return { status: 'changed' }
    }

    const quarantine = await fs.mkdtemp(join(dirname(path), '.notarium-move-'))
    const staged = join(quarantine, 'entry')

    try {
      await fs.rename(path, staged)
    } catch (err) {
      await fs.rmdir(quarantine).catch(() => {})
      if (errnoCode(err) === 'ENOENT') {
        return { status: 'absent' }
      }
      throw err
    }

    const stillClaimed = await sameInode(staged, claim)
    const contentUnchanged =
      expectedContent === undefined || (await readRegular(staged)) === expectedContent

    if (stillClaimed && contentUnchanged) {
      try {
        await fs.unlink(staged)
      } catch (err) {
        // The public source is absent at this point. Restore the claimed inode
        // before surfacing the cleanup error; unlinking an operation-owned
        // pathname is safe to retry, while losing the public source is not.
        try {
          await fs.link(staged, path)
          await fs.unlink(staged).catch(() => {})
          await fs.rmdir(quarantine).catch(() => {})
        } catch {
          // `staged` remains as a lossless recovery copy if another writer won
          // the source pathname or the medium rejected the restore.
        }
        throw err
      }
      // The source removal is committed once the private staged pathname is
      // gone. Failure to remove its now-empty container is cleanup noise, not a
      // reason to roll the data move back from a file that no longer exists.
      await fs.rmdir(quarantine).catch(() => {})
      return { status: 'removed' }
    }

    try {
      await fs.link(staged, path)
      await fs.unlink(staged)
      await fs.rmdir(quarantine).catch(() => {})
      return { status: 'changed' }
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') {
        // Continue into the recovery publication below. It is the last
        // lossless option for a non-regular replacement or failed restore.
      }
    }

    const leaf = path.slice(dirname(path).length + 1)
    const markdown = leaf.endsWith('.md')
    const stem = markdown ? leaf.slice(0, -3) || 'unnamed' : leaf || 'entry'

    for (let attempt = 0; attempt < TEMP_WRITE_ATTEMPTS; attempt++) {
      const recovery = join(dirname(path), recoveryName(stem, markdown))

      try {
        await fs.link(staged, recovery)
        await fs.unlink(staged)
        await fs.rmdir(quarantine).catch(() => {})
        return { status: 'changed', recovery }
      } catch (err) {
        if (errnoCode(err) === 'EEXIST') {
          continue
        }
        break
      }
    }

    // The entry is still preserved in this operation-owned directory. Include
    // its path in the error rather than pretending rollback completed.
    throw new Error(`source changed during move; recovery remains at ${staged}`)
  }

  const staleMove = (recovery?: string): NodeJS.ErrnoException =>
    Object.assign(
      new Error(
        recovery
          ? `source changed during move; displaced bytes recovered at ${recovery}`
          : 'source changed during move',
      ),
      { code: 'ESTALE' },
    )

  /** Raw-distinct targets are first claimed with an operation-unique inode. A
   *  pure rename switches that reservation to the original source inode only
   *  after `detached-source` durably proves source removal was ours. */
  const publicationArtifact = (operation: FsMoveOperation): string => operation.finalArtifact

  const committedArtifact = (operation: FsMoveOperation): string =>
    operation.intent.kind === 'rename' ? operation.sourceArtifact : operation.finalArtifact

  const artifactMatches = async (path: string, expectedHash: string): Promise<boolean> => {
    const content = await readRegular(path)
    return content != null && sha256(content) === expectedHash
  }

  const assertOperationArtifacts = async (operation: FsMoveOperation): Promise<void> => {
    if (!(await artifactMatches(operation.sourceArtifact, operation.intent.expectedSourceHash))) {
      throw new Error(`LocalFS recovery source is missing or changed: ${operation.dir}`)
    }
    if (!(await artifactMatches(operation.finalArtifact, operation.intent.finalHash))) {
      throw new Error(`LocalFS recovery final bytes are missing or changed: ${operation.dir}`)
    }
  }

  const recoveryPathFor = (operation: FsMoveOperation, publicPath: string): string => {
    const leaf = publicPath.slice(dirname(publicPath).length + 1)
    const markdown = leaf.endsWith('.md')
    const stem = markdown ? leaf.slice(0, -3) || 'unnamed' : leaf || 'entry'
    const suffix = `.recovered-${operation.id.slice(3)}${markdown ? '.md' : ''}`
    const boundedStem = clipToBytes(stem, MAX_PATH_COMPONENT_BYTES - Buffer.byteLength(suffix))

    return join(dirname(publicPath), `${boundedStem || 'unnamed'}${suffix}`)
  }

  /** Make private bytes visible without replacing any public pathname. The first
   *  candidate is stable per journal id, so recovery may stop and restart without
   *  multiplying copies. */
  const publishRecovery = async (
    operation: FsMoveOperation,
    artifact: string,
    publicPath: string,
  ): Promise<string> => {
    const stable = recoveryPathFor(operation, publicPath)

    for (let attempt = 0; attempt < TEMP_WRITE_ATTEMPTS; attempt++) {
      const candidate =
        attempt === 0 ? stable : join(dirname(publicPath), recoveryName('entry', true))

      try {
        await fs.link(artifact, candidate)
        return candidate
      } catch (err) {
        if (errnoCode(err) === 'EEXIST') {
          if (await sameInode(artifact, candidate)) {
            return candidate
          }
          continue
        }
        throw Object.assign(
          new Error(`recovery remains at ${artifact}; failed to publish beside ${publicPath}`),
          { cause: err },
        )
      }
    }
    throw new Error(`recovery remains at ${artifact}; no free recovery pathname`)
  }

  const restoreCapturedPath = async (
    operation: FsMoveOperation,
    captured: string,
    publicPath: string,
  ): Promise<{ recovery?: string }> => {
    if (await sameInode(captured, publicPath)) {
      await fs.unlink(captured)
      return {}
    }

    try {
      if (await renameNoReplaceNative(captured, publicPath)) {
        return {}
      }
    } catch (err) {
      if (errnoCode(err) !== 'ENOTSUP') {
        throw Object.assign(new Error(`foreign recovery remains at ${captured}`), { cause: err })
      }

      // A regular file still has a portable atomic no-replace primitive. A
      // directory cannot be hard-linked, so an unsupported renameat2 runtime
      // keeps it in the journal and fails closed.
      const stat = await fs.lstat(captured)

      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw Object.assign(new Error(`foreign recovery remains at ${captured}`), { cause: err })
      }
      try {
        await fs.link(captured, publicPath)
        await fs.unlink(captured)
        return {}
      } catch (linkErr) {
        if (errnoCode(linkErr) !== 'EEXIST') {
          throw Object.assign(new Error(`foreign recovery remains at ${captured}`), {
            cause: linkErr,
          })
        }
      }
    }

    const capturedStat = await fs.lstat(captured)

    if (capturedStat.isFile() && !capturedStat.isSymbolicLink()) {
      const recovery = await publishRecovery(operation, captured, publicPath)

      await fs.unlink(captured)
      return { recovery }
    }

    const stable = recoveryPathFor(operation, publicPath)

    for (let attempt = 0; attempt < TEMP_WRITE_ATTEMPTS; attempt++) {
      const candidate =
        attempt === 0 ? stable : join(dirname(publicPath), recoveryName('entry', false))

      if (await renameNoReplaceNative(captured, candidate)) {
        return { recovery: candidate }
      }
    }
    throw new Error(`foreign recovery remains at ${captured}; no free recovery pathname`)
  }

  type StageResult = { status: 'absent' | 'staged' | 'changed'; recovery?: string }

  /** Move a public pathname into a persistent journal slot, then prove which
   *  inode the rename captured. A replacement that wins after the pre-check is
   *  restored with no-replace linking (or surfaced as a recovery file). */
  const stageOwnedPath = async (
    operation: FsMoveOperation,
    publicPath: string,
    claim: string,
    slot: string,
    expectedHash: string,
  ): Promise<StageResult> => {
    if (await pathExists(slot)) {
      if ((await sameInode(slot, claim)) && (await artifactMatches(slot, expectedHash))) {
        return { status: 'staged' }
      }
      throw new Error(`foreign entry occupies LocalFS recovery slot: ${slot}`)
    }
    if (!(await pathExists(publicPath))) {
      return { status: 'absent' }
    }
    if (!(await sameInode(publicPath, claim))) {
      return { status: 'changed' }
    }

    try {
      await fs.rename(publicPath, slot)
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') {
        return { status: 'absent' }
      }
      throw err
    }
    if ((await sameInode(slot, claim)) && (await artifactMatches(slot, expectedHash))) {
      return { status: 'staged' }
    }
    const restored = await restoreCapturedPath(operation, slot, publicPath)
    return { status: 'changed', ...restored }
  }

  const restoreOriginal = async (operation: FsMoveOperation): Promise<{ recovery?: string }> => {
    if (await sameInode(operation.source, operation.sourceArtifact)) {
      return {}
    }
    if (
      operation.intent.legacySourceLinkedTarget &&
      (await sameInode(operation.target, operation.sourceArtifact))
    ) {
      return {}
    }
    try {
      await fs.link(operation.sourceArtifact, operation.source)
      return {}
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') {
        throw Object.assign(
          new Error(`source changed during move; recovery remains at ${operation.sourceArtifact}`),
          { cause: err, code: errnoCode(err) },
        )
      }
    }

    return {
      recovery: await publishRecovery(operation, operation.sourceArtifact, operation.source),
    }
  }

  const removeOwnedTarget = async (operation: FsMoveOperation): Promise<void> => {
    const sourceDetached = await sameInode(operation.detachedSource, operation.sourceArtifact)
    let claim: string | undefined

    if (await sameInode(operation.target, operation.finalArtifact)) {
      claim = operation.finalArtifact
    } else if (sourceDetached && (await sameInode(operation.target, operation.sourceArtifact))) {
      claim = operation.sourceArtifact
    }

    if (await pathExists(operation.detachedTarget)) {
      if (
        !(await sameInode(operation.detachedTarget, operation.finalArtifact)) &&
        !(sourceDetached && (await sameInode(operation.detachedTarget, operation.sourceArtifact)))
      ) {
        throw new Error(`foreign entry occupies LocalFS target recovery slot: ${operation.dir}`)
      }
      await fs.unlink(operation.detachedTarget)
      return
    }
    if (!claim) {
      return
    }
    const staged = await stageOwnedPath(
      operation,
      operation.target,
      claim,
      operation.detachedTarget,
      operation.intent.finalHash,
    )

    if (staged.status === 'staged') {
      await fs.unlink(operation.detachedTarget)
    }
  }

  const abortOperation = async (operation: FsMoveOperation): Promise<{ recovery?: string }> => {
    // When source and target are one medium entry, first take our FINAL inode out
    // of that shared pathname; only then can the original be restored no-replace.
    if (operation.intent.sameEntry && operation.intent.kind === 'replace') {
      await removeOwnedTarget(operation)
      const restored = await restoreOriginal(operation)
      await resolveOperation(operation)
      return restored
    }
    const restored = await restoreOriginal(operation)
    await removeOwnedTarget(operation)
    await resolveOperation(operation)
    return restored
  }

  const publishReservationTarget = async (operation: FsMoveOperation): Promise<boolean> => {
    try {
      await fs.link(publicationArtifact(operation), operation.target)
      return true
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') {
        return false
      }
      throw err
    }
  }

  /** Turn a unique reservation into a metadata-preserving pure rename. The
   *  detached source is the proof that a same-inode target observed after a stop
   *  belongs to this completed transition, not to a pre-existing hardlink. */
  const finishRenamePublication = async (operation: FsMoveOperation): Promise<boolean> => {
    if (await sameInode(operation.target, operation.sourceArtifact)) {
      return true
    }
    if (await sameInode(operation.target, operation.finalArtifact)) {
      const staged = await stageOwnedPath(
        operation,
        operation.target,
        operation.finalArtifact,
        operation.detachedTarget,
        operation.intent.finalHash,
      )

      if (staged.status !== 'staged') {
        return false
      }
    } else if (await pathExists(operation.target)) {
      return false
    }
    if (await pathExists(operation.detachedTarget)) {
      if (!(await sameInode(operation.detachedTarget, operation.finalArtifact))) {
        throw new Error(`foreign entry occupies LocalFS target recovery slot: ${operation.dir}`)
      }
      await fs.unlink(operation.detachedTarget)
    }
    try {
      await fs.link(operation.sourceArtifact, operation.target)
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') {
        throw err
      }
    }

    return sameInode(operation.target, operation.sourceArtifact)
  }

  const recoverActiveOperation = async (operation: FsMoveOperation): Promise<void> => {
    /** A stop may land after rename(public, detached-*) but before the inode
     * check. Classify both slots before normal recovery: anything not owned by
     * this journal is user data and must be restored no-replace or surfaced as a
     * recovery entry before cleanup is ever allowed to unlink the slot. */
    const preserveForeignSlot = async (
      slot: string,
      publicPath: string,
      allowed: Array<{ artifact: string; hash: string }>,
    ): Promise<void> => {
      if (!(await pathExists(slot))) {
        return
      }
      for (const owner of allowed) {
        if ((await sameInode(slot, owner.artifact)) && (await artifactMatches(slot, owner.hash))) {
          return
        }
      }
      await restoreCapturedPath(operation, slot, publicPath)
    }

    await preserveForeignSlot(operation.detachedSource, operation.source, [
      {
        artifact: operation.sourceArtifact,
        hash: operation.intent.expectedSourceHash,
      },
    ])
    await preserveForeignSlot(operation.detachedTarget, operation.target, [
      { artifact: operation.finalArtifact, hash: operation.intent.finalHash },
      ...(operation.intent.kind === 'rename'
        ? [
            {
              artifact: operation.sourceArtifact,
              hash: operation.intent.expectedSourceHash,
            },
          ]
        : []),
    ])
    await assertOperationArtifacts(operation)

    // Compatibility for the one pre-journal crash state the #296 boot heal could
    // already leave: legacy `.md` and its canonical target are hardlinks to the
    // same source inode. The narrow manifest flag is minted only after proving
    // that exact unnamed-source shape; general hardlink destinations remain
    // foreign occupants.
    if (operation.intent.kind === 'rename' && operation.intent.legacySourceLinkedTarget) {
      const targetCarriesSource = await sameInode(operation.target, operation.sourceArtifact)
      const sourceCarriesSource = await sameInode(operation.source, operation.sourceArtifact)
      const sourceDetached = await sameInode(operation.detachedSource, operation.sourceArtifact)

      if (targetCarriesSource && sourceDetached) {
        await resolveOperation(operation)
        return
      }
      if (targetCarriesSource && sourceCarriesSource) {
        const detached = await stageOwnedPath(
          operation,
          operation.source,
          operation.sourceArtifact,
          operation.detachedSource,
          operation.intent.expectedSourceHash,
        )

        if (detached.status === 'staged') {
          await resolveOperation(operation)
          return
        }
      }
      await abortOperation(operation)
      return
    }

    // A pure same-entry rename is one atomic filesystem syscall; the journal is
    // only its durable private claim. Whether the stop landed before or after the
    // rename, there is no publication/detach split to repair.
    if (operation.intent.kind === 'rename' && operation.intent.sameEntry) {
      if (
        !(await sameInode(operation.source, operation.sourceArtifact)) &&
        !(await sameInode(operation.target, operation.sourceArtifact))
      ) {
        await restoreOriginal(operation)
      }
      await resolveOperation(operation)
      return
    }

    const targetReserved = await sameInode(operation.target, operation.finalArtifact)
    const targetCommitted = await sameInode(operation.target, committedArtifact(operation))
    const sourceOwned = await sameInode(operation.source, operation.sourceArtifact)
    const sourceDetached = await sameInode(operation.detachedSource, operation.sourceArtifact)
    const reservedDetached = await sameInode(operation.detachedTarget, operation.finalArtifact)
    const committedDetached = await sameInode(
      operation.detachedTarget,
      committedArtifact(operation),
    )

    if (operation.intent.kind === 'rename') {
      if (sourceDetached) {
        if (targetCommitted) {
          await resolveOperation(operation)
          return
        }
        if (committedDetached) {
          await restoreOriginal(operation)
          await fs.unlink(operation.detachedTarget)
          await resolveOperation(operation)
          return
        }
        if (
          (targetReserved || reservedDetached || !(await pathExists(operation.target))) &&
          (await finishRenamePublication(operation))
        ) {
          await resolveOperation(operation)
          return
        }
        await abortOperation(operation)
        return
      }
      if (reservedDetached) {
        await restoreOriginal(operation)
        await fs.unlink(operation.detachedTarget)
        await resolveOperation(operation)
        return
      }
      if (targetReserved && sourceOwned) {
        const detached = await stageOwnedPath(
          operation,
          operation.source,
          operation.sourceArtifact,
          operation.detachedSource,
          operation.intent.expectedSourceHash,
        )

        if (detached.status === 'staged' && (await finishRenamePublication(operation))) {
          await resolveOperation(operation)
          return
        }
      }
      await abortOperation(operation)
      return
    }

    if (reservedDetached) {
      const restored = await restoreOriginal(operation)
      await fs.unlink(operation.detachedTarget)
      await resolveOperation(operation)
      void restored
      return
    }

    if (operation.intent.sameEntry) {
      if (sourceDetached) {
        if (targetCommitted) {
          await resolveOperation(operation)
          return
        }
        if (!(await pathExists(operation.target))) {
          try {
            if (await publishReservationTarget(operation)) {
              await resolveOperation(operation)
              return
            }
          } catch {
            await abortOperation(operation)
            return
          }
        }
      }
      await abortOperation(operation)
      return
    }

    if (sourceDetached) {
      if (targetCommitted) {
        await resolveOperation(operation)
      } else {
        await abortOperation(operation)
      }

      return
    }

    if (targetReserved && sourceOwned) {
      const detached = await stageOwnedPath(
        operation,
        operation.source,
        operation.sourceArtifact,
        operation.detachedSource,
        operation.intent.expectedSourceHash,
      )

      if (detached.status === 'staged') {
        await resolveOperation(operation)
        return
      }
    }
    await abortOperation(operation)
  }

  const recoverMoveOperations = async (): Promise<void> => {
    let entries

    try {
      entries = await fs.readdir(opsRoot, { withFileTypes: true })
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') {
        return
      }
      throw err
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !FS_OP_NAME.test(entry.name)) {
        continue
      }
      const dir = join(opsRoot, entry.name)
      const preparing = join(dir, 'preparing')
      const active = join(dir, 'active')
      const done = join(dir, 'done')

      if (await pathExists(done)) {
        await cleanupDoneDir(dir)
        continue
      }
      if (await pathExists(active)) {
        await recoverActiveOperation(await readMoveOperation(entry.name))
        continue
      }
      if (await pathExists(preparing)) {
        // Public mutation is forbidden until preparing -> active. Incomplete
        // setup can therefore be discarded without inspecting user paths.
        await fs.rm(dir, { recursive: true, force: true })
        continue
      }
      const leftovers = await fs.readdir(dir)

      if (leftovers.length === 0) {
        await fs.rmdir(dir)
      } else {
        throw new Error(`unrecognised LocalFS recovery state: ${dir}`)
      }
    }
    await fs.rmdir(opsRoot).catch((err) => {
      if (!['ENOENT', 'ENOTEMPTY'].includes(errnoCode(err) ?? '')) {
        throw err
      }
    })
  }

  const replaceAbsent = async (
    source: string,
    target: string,
    expectedSource: string,
    content: string,
  ): Promise<boolean> => {
    await fs.mkdir(dirname(target), { recursive: true })
    const sameEntry = await sameEntryOnDisk(source, target)
    const operation = await createMoveOperation(
      'replace',
      source,
      target,
      expectedSource,
      content,
      sameEntry,
    )

    try {
      if (sameEntry) {
        const detached = await stageOwnedPath(
          operation,
          source,
          operation.sourceArtifact,
          operation.detachedSource,
          operation.intent.expectedSourceHash,
        )

        if (detached.status !== 'staged') {
          const restored = await abortOperation(operation)
          throw staleMove(detached.recovery ?? restored.recovery)
        }
        let published: boolean

        try {
          published = await publishReservationTarget(operation)
        } catch (err) {
          const restored = await abortOperation(operation)

          if (restored.recovery) {
            throw staleMove(restored.recovery)
          }
          throw err
        }
        if (!published) {
          const restored = await abortOperation(operation)

          if (restored.recovery) {
            throw staleMove(restored.recovery)
          }

          return false
        }
      } else {
        if (!(await publishReservationTarget(operation))) {
          await abortOperation(operation)
          return false
        }
        const detached = await stageOwnedPath(
          operation,
          source,
          operation.sourceArtifact,
          operation.detachedSource,
          operation.intent.expectedSourceHash,
        )

        if (detached.status !== 'staged') {
          const restored = await abortOperation(operation)
          throw staleMove(detached.recovery ?? restored.recovery)
        }
      }
      if (!(await sameInode(target, operation.finalArtifact))) {
        const restored = await abortOperation(operation)
        throw staleMove(restored.recovery)
      }
      await resolveOperation(operation)
      return true
    } catch (err) {
      if (await pathExists(operation.active)) {
        await abortOperation(operation)
      }
      throw err
    }
  }

  /** Pure no-replace rename. Unlike replaceAbsent this publishes the source
   *  inode itself, preserving mode/timestamps/xattrs and leaving a recognisable
   *  same-inode source+target pair if the process stops between publication and
   *  source detach. */
  const renameAbsent = async (
    source: string,
    target: string,
    expectedSource: string,
  ): Promise<boolean> => {
    await fs.mkdir(dirname(target), { recursive: true })
    const sameEntry = await sameEntryOnDisk(source, target)
    const legacySourceLinkedTarget =
      !sameEntry &&
      source.slice(dirname(source).length + 1) === UNNAMED_NOTE_FILENAME &&
      (await sameInode(source, target))
    const operation = await createMoveOperation(
      'rename',
      source,
      target,
      expectedSource,
      expectedSource,
      sameEntry,
      legacySourceLinkedTarget,
    )

    try {
      if (legacySourceLinkedTarget) {
        const detached = await stageOwnedPath(
          operation,
          source,
          operation.sourceArtifact,
          operation.detachedSource,
          operation.intent.expectedSourceHash,
        )

        if (detached.status !== 'staged') {
          const restored = await abortOperation(operation)
          throw staleMove(detached.recovery ?? restored.recovery)
        }
        if (!(await sameInode(target, operation.sourceArtifact))) {
          const restored = await abortOperation(operation)
          throw staleMove(restored.recovery)
        }
        await resolveOperation(operation)
        return true
      }
      if (sameEntry) {
        if (!(await sameInode(source, operation.sourceArtifact))) {
          await abortOperation(operation)
          throw staleMove()
        }
        // Exact-path rename is a no-op; alternate case/NFC spelling on an
        // insensitive medium is changed atomically without a hidden-only gap.
        await fs.rename(source, target)
        if (!(await sameInode(target, operation.sourceArtifact))) {
          const restored = await restoreOriginal(operation)
          throw staleMove(restored.recovery)
        }
        await resolveOperation(operation)
        return true
      }

      if (!(await publishReservationTarget(operation))) {
        await abortOperation(operation)
        return false
      }
      const detached = await stageOwnedPath(
        operation,
        source,
        operation.sourceArtifact,
        operation.detachedSource,
        operation.intent.expectedSourceHash,
      )

      if (detached.status !== 'staged') {
        const restored = await abortOperation(operation)
        throw staleMove(detached.recovery ?? restored.recovery)
      }
      if (!(await finishRenamePublication(operation))) {
        const restored = await abortOperation(operation)
        throw staleMove(restored.recovery)
      }
      await resolveOperation(operation)
      return true
    } catch (err) {
      if (await pathExists(operation.active)) {
        await abortOperation(operation)
      }
      throw err
    }
  }

  let recoveryInFlight: Promise<void> | undefined

  const ensureRecoveredUnlocked = (): Promise<void> => {
    recoveryInFlight ??= recoverMoveOperations()
    return recoveryInFlight
  }
  const ensureRecovered = (): Promise<void> => withStorageLock(ensureRecoveredUnlocked)

  return {
    scan: async () => {
      await ensureRecovered()
      const out: FileStat[] = []

      const walk = async (dirAbs: string): Promise<void> => {
        let entries

        try {
          entries = await fs.readdir(dirAbs, { withFileTypes: true })
        } catch {
          return // the dir vanished mid-scan — the next rescan reconverges
        }
        for (const e of entries) {
          // The ONE dot-file the scan does not hide is UNNAMED_NOTE_FILENAME: not
          // somebody's hidden state but our own legacy note (#296), and hiding it is
          // what made the reconcile read a live file as an external delete. Surfacing
          // it lets the engine re-adopt/index the legacy identity instead of producing
          // a tombstone. LocalFS can now migrate it with the no-replace primitive
          // below. Narrow on purpose:
          // EXACTLY `.md`, never `.anything.md`, so atomic-write temps stay hidden.
          if (hidden(e.name) && !(e.isFile() && e.name === UNNAMED_NOTE_FILENAME)) {
            continue
          }
          const full = join(dirAbs, e.name)

          if (e.isDirectory()) {
            await walk(full)
          } else if (e.isFile() && e.name.endsWith('.md')) {
            const s = await statOf(toPosix(relative(rootAbs, full)))

            if (s) {
              out.push(s)
            }
          }
        }
      }
      await walk(rootAbs)
      return out
    },

    listDirs: async () => {
      await ensureRecovered()
      // The directory channel (#97): every non-dot directory under the root, on
      // its OWN typed walk — never mixed into scan()'s FileStat[] (the index =
      // notes-only invariant #78). Dot-dirs are skipped (.git/.obsidian and the
      // .notarium agent-mount), so only user-visible folders surface into the
      // tree. The root itself ('') is not a folder node — it is excluded.
      const out: string[] = []

      const walk = async (dirAbs: string): Promise<void> => {
        let entries

        try {
          entries = await fs.readdir(dirAbs, { withFileTypes: true })
        } catch {
          return // vanished mid-walk — the next listing reconverges
        }
        for (const e of entries) {
          if (!e.isDirectory() || hidden(e.name)) {
            continue
          }
          const full = join(dirAbs, e.name)
          out.push(toPosix(relative(rootAbs, full)))
          await walk(full)
        }
      }
      await walk(rootAbs)
      return out
    },

    stat: async (rel) => {
      await ensureRecovered()
      return statOf(rel)
    },

    read: async (rel) => {
      await ensureRecovered()
      return readRegular(abs(rel))
    },

    write: async (rel, content) => {
      await ensureRecovered()
      const target = abs(rel)
      const dir = dirname(target)
      await fs.mkdir(dir, { recursive: true })
      const tmp = await writeTemp(dir, content)

      try {
        await fs.rename(tmp, target)
      } catch (err) {
        // A failed publish leaves no owned temp behind when cleanup is possible;
        // cleanup failure never replaces the actionable rename error.
        await fs.unlink(tmp).catch(() => {})
        throw err
      }
    },

    writeIfAbsent: async (rel, content) => {
      await ensureRecovered()
      const target = abs(rel)
      const dir = dirname(target)
      await fs.mkdir(dir, { recursive: true })
      const tmp = await writeTemp(dir, content)

      try {
        // A hard-link publish is one atomic no-replace filesystem operation. The
        // target can never expose partial bytes, and EEXIST includes dangling
        // symlinks/directories — pathname ownership, not readability, is the guard.
        await fs.link(tmp, target)
      } catch (err) {
        await fs.unlink(tmp).catch(() => {})
        if (errnoCode(err) === 'EEXIST') {
          return false
        }
        throw err
      }
      await fs.unlink(tmp).catch(() => {})
      return true
    },

    // dev+ino alone also equates two distinct hardlink pathnames. A rename
    // between those is a POSIX no-op, while realpath preserves distinct hardlink
    // names and canonicalizes alternate case/NFC spellings of one entry on an
    // insensitive filesystem.
    sameEntry: async (left, right) => {
      await ensureRecovered()
      return sameEntryOnDisk(abs(left), abs(right))
    },

    rename: async (from, to) => {
      await ensureRecovered()
      const target = abs(to)
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.rename(abs(from), target)
      // #97: no prune — the emptied source folder is durable (the directory
      // channel surfaces it; an explicit removeDir is the only delete).
    },

    renameIfAbsent: (from, to) =>
      withStorageLock(async () => {
        await ensureRecoveredUnlocked()
        const source = abs(from)
        const expectedSource = await readRegular(source)

        if (expectedSource == null) {
          throw Object.assign(new Error('move source is missing or is not a regular file'), {
            code: 'ENOENT',
          })
        }

        return renameAbsent(source, abs(to), expectedSource)
      }),

    replaceIfAbsent: (from, to, expectedSource, content) =>
      withStorageLock(async () => {
        await ensureRecoveredUnlocked()
        return replaceAbsent(abs(from), abs(to), expectedSource, content)
      }),

    removeIfUnchanged: (rel, expectedContent) =>
      withStorageLock(async () => {
        await ensureRecoveredUnlocked()
        const source = abs(rel)
        let sourceClaim: string

        try {
          sourceClaim = await claimSource(source)
        } catch (err) {
          if (errnoCode(err) === 'ENOENT') {
            return true
          }
          throw err
        }

        try {
          if ((await readRegular(sourceClaim)) !== expectedContent) {
            return false
          }
          const detached = await detachClaimedPath(source, sourceClaim, expectedContent)

          if (detached.status === 'removed') {
            return true
          }
          // Once the source pathname vanished outside this operation we cannot
          // prove whether it was unlinked or renamed elsewhere (hardlinks make
          // nlink deltas non-local). Fail closed; a retry observes a true absence.
          if (detached.status === 'absent') {
            return false
          }

          return false
        } finally {
          await fs.unlink(sourceClaim).catch(() => {})
        }
      }),

    renameDir: async (from, to) => {
      await ensureRecovered()
      const target = abs(to)
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.rename(abs(from), target)
    },

    renameDirIfAbsent: (from, to) =>
      withStorageLock(async () => {
        await ensureRecoveredUnlocked()
        const source = abs(from)
        const target = abs(to)
        await fs.mkdir(dirname(target), { recursive: true })
        const [sourceBefore, targetParent] = await Promise.all([
          fs.lstat(source, { bigint: true }),
          fs.stat(dirname(target), { bigint: true }),
        ])

        if (!sourceBefore.isDirectory() || sourceBefore.isSymbolicLink()) {
          throw Object.assign(new Error('directory move source is not a directory entry'), {
            code: 'ENOTDIR',
          })
        }
        // On a case/NFC-insensitive medium two raw spellings can denote this one
        // directory entry. That is the sole occupied-target exception admitted by
        // the engine. GNU mv -n reports it as an ordinary no-clobber collision, so
        // perform the atomic spelling rename directly and verify that the observed
        // source inode — not an external replacement — won the pathname.
        if (await sameEntryOnDisk(source, target)) {
          await fs.rename(source, target)
          const after = await fs.lstat(target, { bigint: true })

          if (after.dev === sourceBefore.dev && after.ino === sourceBefore.ino) {
            return true
          }
          throw Object.assign(new Error('directory move source changed externally'), {
            code: 'ESTALE',
          })
        }
        if (sourceBefore.dev !== targetParent.dev) {
          throw Object.assign(new Error('atomic directory no-replace cannot cross filesystems'), {
            code: 'ENOTSUP',
          })
        }
        const moved = await renameNoReplaceNative(source, target)

        if (!moved) {
          return false
        }
        const targetAfter = await fs.lstat(target, { bigint: true })

        if (targetAfter.dev === sourceBefore.dev && targetAfter.ino === sourceBefore.ino) {
          return true
        }
        throw Object.assign(new Error('directory move source changed externally'), {
          code: 'ESTALE',
        })
      }),

    remove: async (rel) => {
      await ensureRecovered()
      try {
        await fs.unlink(abs(rel))
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') {
          return // already gone — removing a missing file is a no-op
        }
        throw err
      }
    },

    makeDir: async (rel) => {
      await ensureRecovered()
      // Create parents freely, but claim the requested leaf itself exactly once.
      // Recursive mkdir on the leaf reports success for an existing alternate
      // case/NFC spelling on an insensitive filesystem and made the cache invent a
      // second folder that did not exist on disk.
      const target = abs(rel)
      await fs.mkdir(dirname(target), { recursive: true })

      try {
        await fs.mkdir(target)
        return true
      } catch (err) {
        if (errnoCode(err) === 'EEXIST') {
          return false
        }
        throw err
      }
    },

    removeDir: async (rel) => {
      await ensureRecovered()
      // Delete a folder subtree wholesale (#97 folder delete): notes, any sibling
      // markers (.notariummeta) and nested empty dirs go with it. force so a
      // missing dir is a no-op (idempotent, mirrors remove()).
      await fs.rm(abs(rel), { recursive: true, force: true })
    },

    exists: async (rel) => {
      await ensureRecovered()
      try {
        // Pathname occupancy, not target readability: a dangling symlink still owns
        // the destination and must fence a no-clobber move/create.
        await fs.lstat(abs(rel))
        return true
      } catch {
        return false
      }
    },

    dirExists: async (rel) => {
      await ensureRecovered()
      if (!rel) {
        return true
      } // the storage root always exists as a directory
      try {
        return (await fs.stat(abs(rel))).isDirectory()
      } catch {
        return false
      }
    },

    watch: (onChange) => {
      // The fast path (#146): a recursive fs.watch turns an external edit into an
      // early reconcile instead of waiting out the poll interval. It is ONLY a
      // hint (P3) — the caller still reconciles by a full scan(), so we don't
      // need per-event accuracy, just a wake-up; a dropped event is caught by the
      // periodic backstop. fs.watch can throw synchronously where recursive watch
      // is unavailable (some platforms) or inotify is exhausted (ENOSPC/EMFILE);
      // we return null so the caller degrades to polling (honest P5), never crash.
      let watcher: ReturnType<typeof fsWatch>

      try {
        watcher = fsWatch(rootAbs, { recursive: true }, (_event, filename) => {
          // filename is root-relative (a Buffer becomes a string with the default
          // encoding); on the rare null we can't tell where it fired, so treat it
          // as a real change rather than dropping it.
          const rel = filename == null ? null : toPosix(filename.toString())

          if (hiddenPath(rel)) {
            return
          } // own tmp writes, .git/.obsidian — index-irrelevant
          onChange(rel)
        })
      } catch (err) {
        console.warn(
          '[notarium] fs watch unavailable — falling back to polling:',
          (err as Error).message,
        )
        return null
      }
      // An async watcher error (the inotify queue overflowed, the root was
      // removed) must not throw into the event loop — log and let the periodic
      // backstop carry correctness from here (the watcher is dead, polling lives).
      watcher.on('error', (err) =>
        console.warn(
          '[notarium] fs watch error — polling backstop continues:',
          (err as Error).message,
        ),
      )
      return () => watcher.close()
    },
  }
}
