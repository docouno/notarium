import type * as nodeChildProcess from 'node:child_process'
import type { ChildProcess, ExecFileException } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

const { execFile } = await import('node:child_process')
const { renameNoReplace } = await import('./renameNoReplace')

const execFileMock = vi.mocked(execFile)
const roots: string[] = []
const NATIVE_PLATFORM_GATE = '[gate: atomic no-replace (no renameat2 on this platform)]'
const NATIVE_RUNTIME_GATE = '[gate: atomic no-replace (primitive unavailable on this runtime)]'
const nativePlatformMapped =
  process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')
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
const withMappedRuntime = async <T>(run: () => Promise<T>): Promise<T> => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!

  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', platform)
    Object.defineProperty(process, 'arch', arch)
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
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
