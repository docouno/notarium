import type * as nodeChildProcess from 'node:child_process'
import type { ChildProcess, ExecFileException } from 'node:child_process'
import type * as nodeFs from 'node:fs'
import { promises as fs, constants as fsConstants, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ATOMIC_NO_REPLACE_PLATFORM_GATE,
  ATOMIC_NO_REPLACE_RUNTIME_GATE,
} from './atomicNoReplaceGate.fixture'

// The mock must carry its OWN `promisify.custom`, delegating to the real
// execFile: an automock
// hands `promisify` a stub resolving `undefined`, which makes the primitive
// answer `true` unconditionally, and a bare spy loses the symbol entirely — the
// generic wrapper `promisify` then builds rejects without the `stdout` the errno
// classification reads.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeChildProcess>()
  const execFile = vi.fn(actual.execFile)

  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: string[]) =>
      new Promise((resolve, reject) => {
        execFile(file, args, {}, (err, stdout, stderr) => {
          if (err) {
            reject(Object.assign(err, { stdout, stderr }))
          } else {
            resolve({ stdout, stderr })
          }
        })
      }),
  })

  return { ...actual, execFile }
})

// The host probe is two synchronous calls, so the negative branches of the
// provider — a missing interpreter, a directory wearing its name, a stat that
// cannot be answered — are provable without borrowing another machine.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>()

  return { ...actual, accessSync: vi.fn(actual.accessSync), statSync: vi.fn(actual.statSync) }
})

const { execFile } = await import('node:child_process')
const { accessSync, statSync } = await import('node:fs')
const {
  RENAMEAT2_SYSCALL,
  renameNoReplace,
  renameNoReplaceForRuntime,
  renameNoReplaceIfAvailable,
} = await import('./renameNoReplace')
// The adapter is imported here, not asserted from its own suite: `localFs.test.ts`
// runs against the real filesystem and cannot make the probe answer "no", so a
// construction that derived the facts locally would read as correct there.
const { createLocalFsFiles } = await import('./localFs')

const execFileMock = vi.mocked(execFile)
const accessSyncMock = vi.mocked(accessSync)
const statSyncMock = vi.mocked(statSync)
const roots: string[] = []
const NATIVE_PLATFORM_GATE = ATOMIC_NO_REPLACE_PLATFORM_GATE
const NATIVE_RUNTIME_GATE = ATOMIC_NO_REPLACE_RUNTIME_GATE
// Asked of the resolver rather than restated: a second list of mapped ABIs here
// would be exactly the drift the resolver exists to prevent.
const nativePlatformMapped =
  renameNoReplaceForRuntime({
    platform: process.platform,
    arch: process.arch,
    perlExecutable: true,
  }) !== undefined
const nativeCapabilityGate = await (async (): Promise<string | null> => {
  if (!nativePlatformMapped) {
    return NATIVE_PLATFORM_GATE
  }
  let root: string | undefined
  let marker: string | null = null

  try {
    root = await fs.mkdtemp(join(tmpdir(), 'nt-no-replace-gate-'))
    await fs.mkdir(join(root, 'source'))
    if (!(await renameNoReplace(join(root, 'source'), join(root, 'target')))) {
      marker = NATIVE_RUNTIME_GATE
    }
  } catch {
    marker = NATIVE_RUNTIME_GATE
  }
  if (root) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {
      marker = NATIVE_RUNTIME_GATE
    })
  }

  return marker
})()
const itNative = nativeCapabilityGate === null ? it : it.skip
const nativeName = (name: string): string =>
  nativeCapabilityGate === null ? name : `${name} ${nativeCapabilityGate}`

const mkroot = async (): Promise<string> => {
  const root = await fs.mkdtemp(join(tmpdir(), 'nt-no-replace-'))

  roots.push(root)
  return root
}

/** One spawn failure of the shape Node reports: a STRING `code` and a negative
 *  `errno`, with both output channels empty. */
const failSpawn = (code: string, errno: number): void => {
  execFileMock.mockImplementationOnce(((
    file: string,
    _args: string[],
    _options: object,
    callback: (err: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => {
    callback(
      Object.assign(new Error(`spawn ${file} ${code}`), { code, errno, syscall: `spawn ${file}` }),
      '',
      '',
    )
    return {} as ChildProcess
  }) as never)
}

/** A started interpreter that exits non-zero reports a NUMERIC `code`; raw
 * errno is the only stdout payload. This is deliberately distinct from the
 * spawn-shaped failures above. */
const failExit = (stdout: string): void => {
  execFileMock.mockImplementationOnce(((
    file: string,
    args: string[],
    _options: object,
    callback: (err: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => {
    callback(
      Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), { code: 1 }),
      stdout,
      '',
    )
    return {} as ChildProcess
  }) as never)
}

/** Error-mapping cases inject execFile failures, so they do not need a native
 * syscall. Pin the capability pre-check to one mapped ABI and restore the host
 * exactly afterwards; this keeps them meaningful on non-Linux contributors. */
const withRuntime = async <T>(
  facts: { platform: string; arch: string },
  run: () => Promise<T>,
): Promise<T> => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!

  Object.defineProperty(process, 'platform', { configurable: true, value: facts.platform })
  Object.defineProperty(process, 'arch', { configurable: true, value: facts.arch })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', platform)
    Object.defineProperty(process, 'arch', arch)
  }
}

const withMappedRuntime = async <T>(run: () => Promise<T>): Promise<T> =>
  withRuntime({ platform: 'linux', arch: 'x64' }, run)

/** A stat answer of a shape the probe can classify, without a real inode. */
const statAs = (kind: 'file' | 'directory'): Stats =>
  ({ isFile: () => kind === 'file' }) as unknown as Stats

/** Construction reads the capability and resolves the pathname, nothing more, so
 *  the shape cases below need no directory on disk. */
const SHAPE_PROBE_ROOT = join(tmpdir(), 'nt-no-replace-shape-probe')

const actualFs = await vi.importActual<typeof nodeFs>('node:fs')

afterEach(async () => {
  // An unconsumed one-shot would otherwise leak into the next case — and these
  // two are on the path of every adapter construction.
  accessSyncMock.mockReset().mockImplementation(actualFs.accessSync)
  statSyncMock.mockReset().mockImplementation(actualFs.statSync)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('renameNoReplaceForRuntime', () => {
  // The table by value, because only the host's own row can be proven by running
  // it: a wrong number in the other one is advertised as a working capability and
  // reaches the kernel as an unrelated call, and an added row extends the promise
  // to an architecture nobody ran. Both are silent to every test that asks the
  // resolver a question instead of reading what it answers from.
  it('offers the capability on exactly these architectures, by ABI number', () => {
    expect(RENAMEAT2_SYSCALL).toEqual({ arm64: 276, x64: 316 })
  })

  it.each([
    ['linux', 'x64', true, true],
    ['linux', 'arm64', true, true],
    ['darwin', 'x64', true, false],
    ['win32', 'x64', true, false],
    ['linux', 'unsupported-audit-arch', true, false],
    // A name off Object.prototype: the table must answer for its OWN keys, or an
    // arch it never mapped reads as supported and the syscall is picked anyway.
    ['linux', 'constructor', true, false],
    ['linux', 'x64', false, false],
  ] as const)(
    'answers %s/%s with an executable interpreter=%s',
    (platform, arch, perlExecutable, available) => {
      expect(renameNoReplaceForRuntime({ platform, arch, perlExecutable })).toBe(
        available ? renameNoReplace : undefined,
      )
    },
  )
})

describe('renameNoReplaceIfAvailable', () => {
  it('hands over the primitive itself when the interpreter is a regular executable', async () => {
    await withMappedRuntime(async () => {
      statSyncMock.mockImplementationOnce(() => statAs('file'))
      accessSyncMock.mockImplementationOnce(() => {})

      expect(renameNoReplaceIfAvailable()).toBe(renameNoReplace)
      // Both halves are pinned to the pathname AND the mode: a probe that drifts
      // onto a PATH lookup, another file or a bare existence check would answer
      // for something other than "this deployment can execute this interpreter".
      expect(statSyncMock.mock.calls[0]?.[0]).toBe('/usr/bin/perl')
      expect(accessSyncMock.mock.calls[0]).toEqual(['/usr/bin/perl', fsConstants.X_OK])
    })
  })

  it.each([
    [
      'a directory wears the interpreter pathname',
      () => statSyncMock.mockImplementationOnce(() => statAs('directory')),
    ],
    [
      'the interpreter is absent',
      () =>
        statSyncMock.mockImplementationOnce(() => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }),
    ],
    [
      'the interpreter cannot be executed',
      () => {
        statSyncMock.mockImplementationOnce(() => statAs('file'))
        accessSyncMock.mockImplementationOnce(() => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        })
      },
    ],
  ])('withholds the capability, without failing, when %s', async (_case, inject) => {
    await withMappedRuntime(async () => {
      inject()

      expect(renameNoReplaceIfAvailable()).toBeUndefined()
    })
  })
})

// The pure table is proved above with facts handed in by hand. What these pin is
// the WIRING: that each fact is read from the process rather than assumed. Both
// platform reads — the provider's and the primitive's own last-line guard — were
// invisible to the suite, and could be deleted together with every test still
// green, which is how a non-Linux host would have gone back to publishing a
// capability it cannot perform.
describe('the runtime facts reach the decision', () => {
  it.each([
    ['linux', 'x64', true],
    ['linux', 'arm64', true],
    ['darwin', 'x64', false],
    ['win32', 'x64', false],
    ['linux', 'unsupported-audit-arch', false],
  ] as const)('the provider answers %s/%s with granted=%s', async (platform, arch, granted) => {
    await withRuntime({ platform, arch }, async () => {
      statSyncMock.mockImplementationOnce(() => statAs('file'))
      accessSyncMock.mockImplementationOnce(() => {})

      expect(renameNoReplaceIfAvailable()).toBe(granted ? renameNoReplace : undefined)
    })
  })

  it.each([
    ['darwin', 'x64'],
    ['win32', 'x64'],
    ['linux', 'unsupported-audit-arch'],
  ] as const)(
    'the primitive refuses on %s/%s without spawning anything',
    async (platform, arch) => {
      const root = await mkroot()

      await fs.mkdir(join(root, 'source'))
      await withRuntime({ platform, arch }, async () => {
        execFileMock.mockClear()

        await expect(
          renameNoReplace(join(root, 'source'), join(root, 'target')),
        ).rejects.toMatchObject({ code: 'ENOTSUP' })
        // Defence in depth means the interpreter is never reached: syscall 316 on a
        // BSD kernel is a different call entirely, and it would receive two pointers.
        expect(execFileMock).not.toHaveBeenCalled()
      })
    },
  )

  // The construction seam, where the runtime answer becomes the adapter's shape.
  // Without these the seam is free to derive the facts itself, and the capability
  // is published on a host that cannot perform it — the defect this task removes,
  // reintroduced one call site further along.
  it.each([
    ['linux', 'x64', true],
    ['darwin', 'x64', false],
    ['linux', 'unsupported-audit-arch', false],
  ] as const)(
    'the adapter built on %s/%s declares renameDirIfAbsent=%s',
    async (platform, arch, declared) => {
      await withRuntime({ platform, arch }, async () => {
        statSyncMock.mockImplementationOnce(() => statAs('file'))
        accessSyncMock.mockImplementationOnce(() => {})

        expect(Object.hasOwn(createLocalFsFiles(SHAPE_PROBE_ROOT), 'renameDirIfAbsent')).toBe(
          declared,
        )
      })
    },
  )

  it('the adapter withholds the capability when the interpreter is not executable', async () => {
    await withMappedRuntime(async () => {
      statSyncMock.mockImplementationOnce(() => statAs('directory'))

      expect(Object.hasOwn(createLocalFsFiles(SHAPE_PROBE_ROOT), 'renameDirIfAbsent')).toBe(false)
    })
  })
})

describe('renameNoReplace', () => {
  itNative(nativeName('publishes a directory onto a free pathname'), async () => {
    const root = await mkroot()

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'member'), 'bytes')
    await expect(renameNoReplace(join(root, 'source'), join(root, 'target'))).resolves.toBe(true)
    await expect(fs.readFile(join(root, 'target', 'member'), 'utf8')).resolves.toBe('bytes')
  })

  itNative(
    nativeName('reports an occupied target as a conflict while the interpreter warns on stderr'),
    async () => {
      const root = await mkroot()

      await fs.mkdir(join(root, 'source'))
      await fs.mkdir(join(root, 'target'))
      // A locale the image does not carry makes perl print four warning lines
      // before it can run the snippet. Read off stderr, they parse to NaN and turn
      // this defined conflict into EIO.
      vi.stubEnv('LC_ALL', 'zz_ZZ.UTF-8')
      vi.stubEnv('LANG', 'zz_ZZ.UTF-8')

      await expect(renameNoReplace(join(root, 'source'), join(root, 'target'))).resolves.toBe(false)
      await expect(fs.lstat(join(root, 'source'))).resolves.toMatchObject({})
    },
  )

  it('reports an interpreter that cannot be executed as a missing capability', async () => {
    const root = await mkroot()

    await fs.mkdir(join(root, 'source'))
    await withMappedRuntime(async () => {
      failSpawn('ENOENT', -2)
      await expect(
        renameNoReplace(join(root, 'source'), join(root, 'target')),
      ).rejects.toMatchObject({
        code: 'ENOTSUP',
        errno: 2,
      })

      failSpawn('EACCES', -13)
      await expect(
        renameNoReplace(join(root, 'source'), join(root, 'target')),
      ).rejects.toMatchObject({
        code: 'ENOTSUP',
        errno: 13,
      })
    })
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps transient resource pressure an I/O failure carrying its real errno', async () => {
    const root = await mkroot()

    await fs.mkdir(join(root, 'source'))
    await withMappedRuntime(async () => {
      failSpawn('EMFILE', -24)
      await expect(
        renameNoReplace(join(root, 'source'), join(root, 'target')),
      ).rejects.toMatchObject({
        code: 'EIO',
        errno: 24,
      })
    })
  })

  it('maps an occupied target from a non-zero process exit to a conflict', async () => {
    const root = await mkroot()

    await fs.mkdir(join(root, 'source'))
    await withMappedRuntime(async () => {
      failExit('17')
      await expect(renameNoReplace(join(root, 'source'), join(root, 'target'))).resolves.toBe(false)
      // The interpreter that actually runs, not just the one the probe certified.
      // A bare `perl` here would resolve through PATH — a user-writable directory
      // ahead of /usr/bin, a shim, an empty PATH under a unit — and the syscall
      // would be issued by a binary nothing vouched for.
      expect(execFileMock.mock.lastCall?.[0]).toBe('/usr/bin/perl')
      expect(execFileMock.mock.lastCall?.[1]?.[2]).toBe('316')
    })
  })

  it.each([
    [2, 'ENOENT'],
    [18, 'EXDEV'],
    [22, 'ENOTSUP'],
    [38, 'ENOTSUP'],
    [95, 'ENOTSUP'],
    [96, 'EIO'],
  ] as const)('maps process-exit errno %i to %s', async (errno, code) => {
    const root = await mkroot()

    await fs.mkdir(join(root, 'source'))
    await withMappedRuntime(async () => {
      failExit(String(errno))
      await expect(
        renameNoReplace(join(root, 'source'), join(root, 'target')),
      ).rejects.toMatchObject({ code, errno })
    })
  })

  it.each(['', 'not-an-errno'])(
    'keeps an unparseable exit channel as errno-less EIO',
    async (channel) => {
      const root = await mkroot()

      await fs.mkdir(join(root, 'source'))
      await withMappedRuntime(async () => {
        failExit(channel)
        await expect(
          renameNoReplace(join(root, 'source'), join(root, 'target')),
        ).rejects.toMatchObject({ code: 'EIO', errno: undefined })
      })
    },
  )

  it('fails closed on a runtime with no direct renameat2 syscall mapping', async () => {
    const root = await mkroot()
    const actualArch = process.arch

    await fs.mkdir(join(root, 'source'))
    Object.defineProperty(process, 'arch', { configurable: true, value: 'unsupported-audit-arch' })
    try {
      await expect(
        renameNoReplace(join(root, 'source'), join(root, 'target')),
      ).rejects.toMatchObject({ code: 'ENOTSUP' })
    } finally {
      Object.defineProperty(process, 'arch', { configurable: true, value: actualArch })
    }
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
