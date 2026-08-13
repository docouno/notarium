// The engine's one atomic no-replace namespace transition, kept apart from the
// LocalFS adapter because callers that own no mount need it too (the role
// library publishes a package directory this way).
// canon: docs/note-model.md#create-collisions

import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Absolute by contract, never a PATH lookup: the deployment matrix and the
 * official image both pin this exact pathname.
 * canon: docs/release.md#platform */
const PERL = '/usr/bin/perl'

/** Linux syscall numbers are ABI, not kernel-version dependent. Keep the
 * supported set deliberately small: an unknown runtime must fail closed rather
 * than emulate RENAME_NOREPLACE with a check-then-rename sequence.
 *
 * Exported by module path, never on the barrel: this IS the declaration of which
 * architectures the capability is offered on, and only the host's own row can be
 * proven by running it. A wrong number in any other row would be advertised as a
 * working capability and reach the kernel as a different call entirely. */
export const RENAMEAT2_SYSCALL: Partial<Record<NodeJS.Architecture, number>> = {
  arm64: 276,
  x64: 316,
}

// errno rides stdout, alone on its own channel. The interpreter writes its own
// warnings to stderr — a locale it cannot set, an LD_PRELOAD it cannot honour —
// and reading the result off that shared buffer turns an occupied target into an
// unparseable number, i.e. an I/O failure where the contract promises `false`.
const PERL_RENAME_NOREPLACE = String.raw`
  use strict;
  use warnings;
  my ($nr, $from, $to) = @ARGV;
  my $result = syscall(0 + $nr, -100, $from, -100, $to, 1);
  exit 0 if $result == 0;
  print STDOUT 0 + $!;
  exit 1;
`

const EEXIST = 17
const UNSUPPORTED_ERRNO = new Set([22, 38, 95])

/** Spawn codes that mean "this interpreter cannot be executed" — the capability
 * is absent exactly as it is on an unmapped architecture. EMFILE/EAGAIN/ENOMEM/
 * EPERM are deliberately excluded: transient resource pressure reported as
 * ENOTSUP would tell a caller the platform will never support the operation. */
const UNSUPPORTED_SPAWN = new Set(['ENOENT', 'EACCES', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG'])

const unavailable = (cause?: unknown, errno?: number): Error =>
  Object.assign(new Error('atomic no-replace rename is unavailable'), {
    cause,
    code: 'ENOTSUP',
    errno,
  })

/** The channel carries a bare positive errno or nothing at all: an empty buffer
 * (the process died on a signal) is unknown, never zero. */
const errnoOf = (channel: string | undefined): number | undefined => {
  const value = Number(channel?.trim())

  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** Rename `source` onto `target` and never replace an occupant, in one atomic
 * filesystem operation — `renameat2(RENAME_NOREPLACE)` called directly. GNU mv
 * is intentionally not a capability boundary: its portability layer may fall
 * back to a raceable lstat+rename when the syscall or filesystem is unsupported.
 *
 * `true` — published. `false` — the target pathname was already taken, in ANY
 * shape (empty or populated directory, regular file, live or dangling symlink);
 * the occupant keeps its inode and bytes, and `source` survives. `ENOTEMPTY` is
 * unreachable here, since no-replace settles existence before emptiness.
 *
 * Everything else throws, with `code`: `ENOTSUP` — the capability is absent
 * (non-Linux, unmapped architecture, unsupported filesystem or kernel, or an
 * interpreter that cannot be executed); `ENOENT` — `source` or the target's
 * parent is missing; `EXDEV` — the two sides are on different filesystems;
 * `EIO` — anything else. `errno` carries the raw number when one is known, and
 * is absent when it is not (a signal kill, an unparseable channel). An unmapped
 * platform is refused before anything is attempted and so carries no `cause`,
 * which is what separates it from an unavailability the runtime produced. */
export const renameNoReplace = async (source: string, target: string): Promise<boolean> => {
  const syscall = process.platform === 'linux' ? RENAMEAT2_SYSCALL[process.arch] : undefined

  if (syscall === undefined) {
    throw unavailable()
  }

  try {
    await execFileAsync(PERL, ['-e', PERL_RENAME_NOREPLACE, String(syscall), source, target])
    return true
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { stdout?: string }

    // A spawn that never started has no channel to report on, and its shape says
    // so: `code` is a string there, a number on a non-zero exit.
    if (typeof failure.code === 'string') {
      const errno = typeof failure.errno === 'number' ? Math.abs(failure.errno) : undefined

      if (UNSUPPORTED_SPAWN.has(failure.code)) {
        throw unavailable(err, errno)
      }
      throw Object.assign(new Error('atomic no-replace rename failed'), {
        cause: err,
        code: 'EIO',
        errno,
      })
    }
    const errno = errnoOf(failure.stdout)

    if (errno === EEXIST) {
      return false
    }
    if (errno !== undefined && UNSUPPORTED_ERRNO.has(errno)) {
      throw unavailable(err, errno)
    }

    throw Object.assign(new Error('atomic no-replace rename failed'), {
      cause: err,
      code: errno === 2 ? 'ENOENT' : errno === 18 ? 'EXDEV' : 'EIO',
      errno,
    })
  }
}

/** What the primitive needs from the host it was composed on. */
export type RenameNoReplaceRuntime = {
  platform: string
  arch: string
  /** `/usr/bin/perl` is a regular file this process may execute. */
  perlExecutable: boolean
}

/** The runtime matrix as a pure table, so the negative branches are provable
 * without borrowing someone else's OS. The mapped-ABI set is read off
 * RENAMEAT2_SYSCALL rather than restated — one list, or the two drift. */
export const renameNoReplaceForRuntime = (
  facts: RenameNoReplaceRuntime,
): typeof renameNoReplace | undefined =>
  facts.platform === 'linux' && Object.hasOwn(RENAMEAT2_SYSCALL, facts.arch) && facts.perlExecutable
    ? renameNoReplace
    : undefined

/** Fail closed on anything a stat/access can report. A symlink IS followed —
 * a packaged interpreter reached through one is still an interpreter — but a
 * directory or device node wearing the name is not, and `X_OK` alone would
 * accept both (a directory is searchable, hence executable to access()). */
const perlExecutable = (): boolean => {
  try {
    if (!statSync(PERL).isFile()) {
      return false
    }
    accessSync(PERL, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The capability itself, or `undefined` where this deployment cannot perform
 * it — the one honest answer a composition root asks for BEFORE it builds
 * something that advertises the operation (the `localEmbedderAvailable()`
 * pattern). Deliberately uncached: a caller fixes the answer at construction,
 * which is what makes the shape of an adapter stable for its whole life.
 * What presence does and does not promise about individual pathnames is the
 * canon reference this file opens with. */
export const renameNoReplaceIfAvailable = (): typeof renameNoReplace | undefined =>
  renameNoReplaceForRuntime({
    platform: process.platform,
    arch: process.arch,
    perlExecutable: perlExecutable(),
  })
