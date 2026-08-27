import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  promises as fs,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ATOMIC_NO_REPLACE_PLATFORM_GATE,
  ATOMIC_NO_REPLACE_RUNTIME_GATE,
} from './atomicNoReplaceGate.fixture'
import { createLocalFsFiles } from './localFs'
import { renameNoReplaceForRuntime, renameNoReplaceIfAvailable } from './renameNoReplace'

const roots: string[] = []

const itProcess = (name: string, test: () => Promise<void>): void => {
  it(name, test, 15_000)
}

const DIR_MOVE_PLATFORM_GATE = ATOMIC_NO_REPLACE_PLATFORM_GATE
const DIR_MOVE_RUNTIME_GATE = ATOMIC_NO_REPLACE_RUNTIME_GATE
const CROSS_DEVICE_GATE = '[gate: cross-device directory move (no second local filesystem here)]'

/** A declared capability is not yet a proven one: a filesystem or kernel that
 *  refuses the syscall answers only to a real publication. Probed once — neither
 *  a platform, an interpreter nor a mount changes mid-run — and the reason is
 *  split so the summary can say whether the machine could ever do this at all. */
const dirMoveGate = await (async (): Promise<string | null> => {
  if (!renameNoReplaceIfAvailable()) {
    return renameNoReplaceForRuntime({
      platform: process.platform,
      arch: process.arch,
      perlExecutable: true,
    })
      ? DIR_MOVE_RUNTIME_GATE
      : DIR_MOVE_PLATFORM_GATE
  }
  let root: string | undefined
  let marker: string | null = null

  try {
    root = await fs.mkdtemp(join(tmpdir(), 'notarium-localfs-dir-gate-'))
    await fs.mkdir(join(root, 'source'))
    if (
      !(await createLocalFsFiles(root).capabilities.directoryNoReplaceMove!.renameDirIfAbsent(
        'source',
        'target',
      ))
    ) {
      marker = DIR_MOVE_RUNTIME_GATE
    }
  } catch {
    marker = DIR_MOVE_RUNTIME_GATE
  }
  if (root) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {
      marker = DIR_MOVE_RUNTIME_GATE
    })
  }

  return marker
})()

/** A SECOND filesystem the temp root can reach. Its absence is a property of the
 *  machine, not of the code, and is reported as such rather than as a pass. */
const crossDeviceGate = await (async (): Promise<string | null> => {
  if (process.platform !== 'linux') {
    return CROSS_DEVICE_GATE
  }
  let external: string | undefined

  try {
    external = await fs.mkdtemp('/dev/shm/notarium-localfs-xdev-gate-')
    const [here, there] = await Promise.all([fs.stat(tmpdir()), fs.stat(external)])

    return here.dev === there.dev ? CROSS_DEVICE_GATE : null
  } catch {
    return CROSS_DEVICE_GATE
  } finally {
    if (external) {
      await fs.rm(external, { recursive: true, force: true }).catch(() => {})
    }
  }
})()

const itDirMove = (name: string, test: () => Promise<void>): void => {
  const run = dirMoveGate === null ? it : it.skip

  run(dirMoveGate === null ? name : `${name} ${dirMoveGate}`, test)
}

const itCrossDevice = (name: string, test: () => Promise<void>): void => {
  const closed = dirMoveGate ?? crossDeviceGate
  const run = closed === null ? it : it.skip

  run(closed === null ? name : `${name} ${closed}`, test)
}

const mkroot = async (): Promise<string> => {
  const root = await fs.mkdtemp(join(tmpdir(), 'notarium-localfs-'))
  roots.push(root)
  return root
}

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code }) as NodeJS.ErrnoException

type CrashPhase = 'before-publication' | 'after-publication' | 'after-detach'

/** Run the real adapter in a child and stop the process at one namespace edge.
 *  No production fault hook: the child patches the shared node:fs promises object,
 *  so the bytes left behind are exactly what an abrupt process stop would leave. */
const crashMove = (
  root: string,
  kind: 'rename' | 'replace' | 'replace-entry',
  phase: CrashPhase,
  samePath = false,
): void => {
  const moduleUrl = new URL('./localFs.ts', import.meta.url).href
  const script = `
    import { promises as fs } from 'node:fs'
    import { join } from 'node:path'
    import { createLocalFsFiles } from ${JSON.stringify(moduleUrl)}

    const root = ${JSON.stringify(root)}
    const source = join(root, 'source.md')
    const target = ${samePath ? 'source' : "join(root, 'target.md')"}
    const phase = ${JSON.stringify(phase)}
    const realLink = fs.link.bind(fs)
    const realRename = fs.rename.bind(fs)

    fs.link = async (from, to) => {
      const publishes = String(to) === target && String(from).endsWith('/final')
      if (publishes && phase === 'before-publication') process.exit(86)
      const result = await realLink(from, to)
      if (publishes && phase === 'after-publication') process.exit(86)
      return result
    }
    fs.rename = async (from, to) => {
      const detaches = String(from) === source && String(to).endsWith('/detached-source')
      const result = await realRename(from, to)
      if (detaches && phase === 'after-detach') process.exit(86)
      return result
    }

    const files = createLocalFsFiles(root)
    if (${JSON.stringify(kind)} === 'rename') {
      await files.capabilities.fileNoReplaceMove.renameIfAbsent('source.md', ${samePath ? "'source.md'" : "'target.md'"})
    } else if (${JSON.stringify(kind)} === 'replace-entry') {
      const observed = await files.capabilities.resourceObservation.observe('source.md')
      if (observed.kind !== 'occupied') throw new Error('expected an occupied entry')
      await files.capabilities.resourcePublication.publish({
        kind: 'put',
        path: 'source.md',
        content: new TextEncoder().encode('app-final'),
        expected: observed.claim,
      })
    } else {
      await files.capabilities.conditionalFileMutation.replaceIfAbsent(
        'source.md',
        ${samePath ? "'source.md'" : "'target.md'"},
        'source',
        'app-final',
      )
    }
  `
  let status: number | undefined

  try {
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      stdio: 'pipe',
    })
  } catch (err) {
    status = (err as { status?: number }).status
  }
  expect(status).toBe(86)
}

const crashRecoveryAfterDetach = (root: string): void => {
  const moduleUrl = new URL('./localFs.ts', import.meta.url).href
  const script = `
    import { promises as fs } from 'node:fs'
    import { join } from 'node:path'
    import { createLocalFsFiles } from ${JSON.stringify(moduleUrl)}

    const root = ${JSON.stringify(root)}
    const source = join(root, 'source.md')
    const realRename = fs.rename.bind(fs)
    fs.rename = async (from, to) => {
      const result = await realRename(from, to)
      if (String(from) === source && String(to).endsWith('/detached-source')) process.exit(87)
      return result
    }
    await createLocalFsFiles(root).base.scan()
  `
  let status: number | undefined

  try {
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      stdio: 'pipe',
    })
  } catch (err) {
    status = (err as { status?: number }).status
  }
  expect(status).toBe(87)
}

const crashAfterCapturingForeign = (
  root: string,
  edge: 'detached-source' | 'detached-target',
): void => {
  const moduleUrl = new URL('./localFs.ts', import.meta.url).href
  const script = `
    import { promises as fs } from 'node:fs'
    import { join } from 'node:path'
    import { createLocalFsFiles } from ${JSON.stringify(moduleUrl)}

    const root = ${JSON.stringify(root)}
    const edge = ${JSON.stringify(edge)}
    const source = join(root, 'source.md')
    const target = join(root, 'target.md')
    const intruder = join(root, 'intruder.md')
    await fs.writeFile(source, 'original')
    await fs.writeFile(
      intruder,
      edge === 'detached-source' ? 'FOREIGN-SOURCE' : 'FOREIGN-TARGET',
    )
    const realRename = fs.rename.bind(fs)
    let injected = false

    fs.rename = async (from, to) => {
      const capturesSource =
        edge === 'detached-source' &&
        String(from) === source &&
        String(to).endsWith('/detached-source')
      const capturesTarget =
        edge === 'detached-target' &&
        String(from) === target &&
        String(to).endsWith('/detached-target')

      if (!injected && (capturesSource || capturesTarget)) {
        injected = true
        const publicPath = capturesSource ? source : target
        await realRename(intruder, publicPath)
        await realRename(from, to)
        process.exit(88)
      }

      return realRename(from, to)
    }

    const files = createLocalFsFiles(root)
    if (edge === 'detached-source') {
      await files.capabilities.conditionalFileMutation.replaceIfAbsent('source.md', 'target.md', 'original', 'final')
    } else {
      await files.capabilities.fileNoReplaceMove.renameIfAbsent('source.md', 'target.md')
    }
  `
  let status: number | undefined

  try {
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      stdio: 'pipe',
    })
  } catch (err) {
    status = (err as { status?: number }).status
  }
  expect(status).toBe(88)
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('localFs atomic writes (#262)', () => {
  it('keeps parallel writes independent at the same timestamp and leaves no temp files', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const bodyA = `A:${'a'.repeat(32_768)}`
    const bodyB = `B:${'b'.repeat(32_768)}`
    const open = vi.spyOn(fs, 'open')
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)

    await Promise.all([files.base.write('a.md', bodyA), files.base.write('b.md', bodyB)])

    const claims = open.mock.calls.map(([path, flags]) => [String(path), flags] as const)
    expect(claims).toHaveLength(2)
    expect(new Set(claims.map(([path]) => path))).toHaveLength(2)
    expect(claims.every(([, flags]) => flags === 'wx')).toBe(true)
    await expect(files.base.read('a.md')).resolves.toBe(bodyA)
    await expect(files.base.read('b.md')).resolves.toBe(bodyB)
    expect((await fs.readdir(root)).sort()).toEqual(['a.md', 'b.md'])
  })

  it('claims the temp exclusively and retries a name collision without touching its file', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const realOpen = fs.open.bind(fs)
    const attempted: string[] = []
    let sentinel = ''
    const unlink = vi.spyOn(fs, 'unlink')
    const open = vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      attempted.push(String(path))

      if (attempted.length === 1) {
        sentinel = String(path)
        const foreign = await realOpen(path, 'wx')
        await foreign.writeFile('foreign', 'utf8')
        await foreign.close()
      }

      return realOpen(path, flags, mode)
    })

    await files.base.write('note.md', 'safe')

    expect(open).toHaveBeenCalledTimes(2)
    expect(attempted[0]).not.toBe(attempted[1])
    expect(open.mock.calls.every(([, flags]) => flags === 'wx')).toBe(true)
    expect(unlink).not.toHaveBeenCalled()
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('foreign')
    await expect(files.base.read('note.md')).resolves.toBe('safe')
  })

  it('stops after bounded exclusive-claim collisions without deleting foreign files', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const collision = errno('EEXIST')
    const open = vi.spyOn(fs, 'open').mockRejectedValue(collision)
    const unlink = vi.spyOn(fs, 'unlink')

    await expect(files.base.write('note.md', 'body')).rejects.toBe(collision)
    expect(open).toHaveBeenCalledTimes(8)
    expect(unlink).not.toHaveBeenCalled()
  })

  it('does not unlink when claiming the temp fails before ownership', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const denied = errno('EACCES')
    vi.spyOn(fs, 'open').mockRejectedValueOnce(denied)
    const unlink = vi.spyOn(fs, 'unlink')

    await expect(files.base.write('note.md', 'body')).rejects.toBe(denied)
    expect(unlink).not.toHaveBeenCalled()
  })

  it('cleans its claimed temp after a write failure', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const realOpen = fs.open.bind(fs)
    const failure = errno('EIO')
    let closeCalls = 0
    vi.spyOn(fs, 'open').mockImplementationOnce(async (path, flags, mode) => {
      const handle = await realOpen(path, flags, mode)
      const realClose = handle.close.bind(handle)
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure)
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        closeCalls++
        await realClose()
      })
      return handle
    })

    await expect(files.base.write('note.md', 'body')).rejects.toBe(failure)
    expect(closeCalls).toBe(1)
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('preserves a write failure when cleanup of its claimed temp also fails', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const realOpen = fs.open.bind(fs)
    const writeFailure = errno('EIO')
    let claimed = ''
    vi.spyOn(fs, 'open').mockImplementationOnce(async (path, flags, mode) => {
      claimed = String(path)
      const handle = await realOpen(path, flags, mode)
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(writeFailure)
      return handle
    })
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(errno('EACCES'))

    await expect(files.base.write('note.md', 'body')).rejects.toBe(writeFailure)
    expect(unlink).toHaveBeenCalledWith(claimed)
    await expect(fs.readFile(claimed, 'utf8')).resolves.toBe('')
  })

  it('cleans its temp and reports a close failure after successful writing', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const realOpen = fs.open.bind(fs)
    const failure = errno('EIO')
    vi.spyOn(fs, 'open').mockImplementationOnce(async (path, flags, mode) => {
      const handle = await realOpen(path, flags, mode)
      const realClose = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await realClose()
        throw failure
      })
      return handle
    })

    await expect(files.base.write('note.md', 'body')).rejects.toBe(failure)
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('cleans its temp after a failed rename and preserves the rename error', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const failure = errno('EIO')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(failure)

    await expect(files.base.write('note.md', 'body')).rejects.toBe(failure)
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('preserves a rename failure when cleanup of its claimed temp also fails', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const renameFailure = errno('EIO')
    const open = vi.spyOn(fs, 'open')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(renameFailure)
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(errno('EACCES'))

    await expect(files.base.write('note.md', 'body')).rejects.toBe(renameFailure)
    const claimed = String(open.mock.calls[0]?.[0])
    expect(unlink).toHaveBeenCalledWith(claimed)
    await expect(fs.readFile(claimed, 'utf8')).resolves.toBe('body')
  })
})

describe('localFs remove errors (#262)', () => {
  it('is idempotent only for ENOENT and propagates other unlink failures', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await expect(files.base.remove('missing.md')).resolves.toBeUndefined()

    const denied = errno('EACCES')
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(denied)
    await expect(files.base.remove('forbidden.md')).rejects.toBe(denied)
  })
})

describe('localFs raw export', () => {
  const exportedPaths = async (files: ReturnType<typeof createLocalFsFiles>) => {
    const paths: string[] = []

    for await (const entry of files.capabilities.resourceExport!.exportFiles()) {
      paths.push(entry.path)
    }

    return paths
  }

  it('excludes atomic install staging trees at project depth but preserves other dot resources', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const project = join(root, '_projects', 'cHJvamVjdA')
    const staging = '.AbCdefGhij_1.install-550e8400-e29b-41d4-a716-446655440000'
    const temp = join(project, staging)
    await fs.mkdir(join(project, 'ready'), { recursive: true })
    await fs.mkdir(temp, { recursive: true })
    await fs.mkdir(join(project, 'ready', '.authored'), { recursive: true })
    await fs.mkdir(join(project, 'ready', 'assets', staging), { recursive: true })
    await fs.writeFile(join(project, 'ready', 'SKILL.md'), 'published')
    await fs.writeFile(join(project, 'ready', '.authored', 'resource.bin'), Buffer.from([0, 255]))
    await fs.writeFile(join(project, 'ready', staging), 'authored file')
    await fs.writeFile(join(temp, 'SKILL.md'), 'partial')
    await fs.mkdir(join(root, '.notarium-fs-ops', 'strict-private'), { recursive: true })
    await fs.writeFile(join(root, '.notarium-fs-ops', 'strict-private', 'candidate'), 'private')
    await fs.writeFile(
      join(project, 'ready', 'assets', staging, 'resource.bin'),
      'authored directory',
    )
    const exported = []

    for await (const entry of files.capabilities.resourceExport!.exportFiles()) {
      exported.push(entry.path)
    }

    expect(exported.sort()).toEqual([
      `_projects/cHJvamVjdA/ready/${staging}`,
      '_projects/cHJvamVjdA/ready/.authored/resource.bin',
      '_projects/cHJvamVjdA/ready/SKILL.md',
      `_projects/cHJvamVjdA/ready/assets/${staging}/resource.bin`,
    ])
  })

  it('skips a directory or file that vanishes during the export walk', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await fs.writeFile(join(root, 'note.md'), 'body')

    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(errno('ENOENT'))
    await expect(exportedPaths(files)).resolves.toEqual([])
    vi.restoreAllMocks()

    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(errno('ENOENT'))
    await expect(exportedPaths(files)).resolves.toEqual([])
  })

  it('propagates a directory read failure that is not a concurrent removal', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const denied = errno('EACCES')
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(denied)

    await expect(exportedPaths(files)).rejects.toBe(denied)
  })

  it('propagates a file read failure that is not a concurrent removal', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const denied = errno('EACCES')
    await fs.writeFile(join(root, 'note.md'), 'body')
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(denied)

    await expect(exportedPaths(files)).rejects.toBe(denied)
  })
})

describe('localFs lexical containment', () => {
  it('rejects a read that escapes the storage root', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await expect(files.base.read('../outside.md')).rejects.toThrow(/path escapes the storage root/)
  })
})

describe('localFs pathname occupancy', () => {
  it('returns null for a FIFO without waiting for a writer', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    execFileSync('mkfifo', [join(root, 'pipe.md')])
    await expect(files.base.read('pipe.md')).resolves.toBeNull()
  })

  it('counts a dangling symlink as occupied', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await fs.symlink('missing.md', join(root, 'claimed.md'))
    await expect(files.base.exists('claimed.md')).resolves.toBe(true)
  })

  it('publishes complete bytes only once without replacing an occupied pathname', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await expect(
      Promise.all([
        files.capabilities.conditionalFileMutation!.writeIfAbsent('claimed.md', 'first'),
        files.capabilities.conditionalFileMutation!.writeIfAbsent('claimed.md', 'second'),
      ]),
    ).resolves.toEqual(expect.arrayContaining([true, false]))
    await expect(files.base.read('claimed.md')).resolves.toMatch(/^(first|second)$/)
    expect(await fs.readdir(root)).toEqual(['claimed.md'])

    await fs.unlink(join(root, 'claimed.md'))
    await fs.symlink('missing.md', join(root, 'claimed.md'))
    await expect(
      files.capabilities.conditionalFileMutation!.writeIfAbsent('claimed.md', 'intruder'),
    ).resolves.toBe(false)
    expect((await fs.lstat(join(root, 'claimed.md'))).isSymbolicLink()).toBe(true)
  })

  it('moves onto an absent pathname without replacing a racing create', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await files.base.write('source.md', 'source')

    const [moved, created] = await Promise.all([
      files.capabilities.fileNoReplaceMove!.renameIfAbsent('source.md', 'target.md'),
      files.capabilities.conditionalFileMutation!.writeIfAbsent('target.md', 'rival'),
    ])

    expect([moved, created].filter(Boolean)).toHaveLength(1)
    if (moved) {
      await expect(files.base.read('target.md')).resolves.toBe('source')
      await expect(files.base.read('source.md')).resolves.toBeNull()
    } else {
      await expect(files.base.read('target.md')).resolves.toBe('rival')
      await expect(files.base.read('source.md')).resolves.toBe('source')
    }
  })

  it('leaves source and destination intact when a no-replace move is occupied', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await files.base.write('source.md', 'source')
    await files.base.write('target.md', 'target')

    await expect(
      files.capabilities.fileNoReplaceMove!.renameIfAbsent('source.md', 'target.md'),
    ).resolves.toBe(false)
    await expect(files.base.read('source.md')).resolves.toBe('source')
    await expect(files.base.read('target.md')).resolves.toBe('target')
  })

  it('rolls back its claimed destination when removing the source fails', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const realRename = fs.rename.bind(fs)
    let injected = false

    await files.base.write('source.md', 'source')
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(from) === source && String(to).endsWith('/detached-source')) {
        injected = true
        throw errno('EACCES')
      }

      return realRename(from, to)
    })

    await expect(
      files.capabilities.fileNoReplaceMove!.renameIfAbsent('source.md', 'target.md'),
    ).rejects.toMatchObject({
      code: 'EACCES',
    })
    await expect(files.base.read('source.md')).resolves.toBe('source')
    await expect(files.base.read('target.md')).resolves.toBeNull()
  })

  it('never unlinks a replacement that wins the source pathname during move', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const external = join(root, 'external.md')
    const realRename = fs.rename.bind(fs)
    let injected = false

    await fs.writeFile(source, 'source')
    await fs.writeFile(external, 'external-new')
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(from) === source && String(to).endsWith('/detached-source')) {
        injected = true
        await realRename(external, source)
      }

      return realRename(from, to)
    })

    await expect(
      files.capabilities.fileNoReplaceMove!.renameIfAbsent('source.md', 'target.md'),
    ).rejects.toMatchObject({
      code: 'ESTALE',
    })
    await expect(files.base.read('source.md')).resolves.toBe('external-new')
    await expect(files.base.read('target.md')).resolves.toBeNull()
    const entries = await fs.readdir(root)
    const recovery = entries.find((entry) => entry.startsWith('source.recovered-'))

    expect(entries.sort()).toEqual(['source.md', expect.stringMatching(/^source\.recovered-/)])
    await expect(fs.readFile(join(root, recovery!), 'utf8')).resolves.toBe('source')
  })

  it('preserves in-place edits to both source and destination during rollback', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const target = join(root, 'target.md')
    const realRename = fs.rename.bind(fs)
    let injected = false

    await fs.writeFile(source, 'source')
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(from) === source && String(to).endsWith('/detached-source')) {
        injected = true
        await fs.writeFile(target, 'external-target')
        await fs.writeFile(source, 'external-new')
      }

      return realRename(from, to)
    })

    await expect(
      files.capabilities.conditionalFileMutation!.replaceIfAbsent(
        'source.md',
        'target.md',
        'source',
        'app-final',
      ),
    ).rejects.toMatchObject({ code: 'ESTALE' })
    await expect(files.base.read('source.md')).resolves.toBe('external-new')
    await expect(files.base.read('target.md')).resolves.toBe('external-target')
    expect((await fs.readdir(root)).sort()).toEqual(['source.md', 'target.md'])
  })

  it('keeps the source when a destination is replaced after publication', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const target = join(root, 'target.md')
    const external = join(root, 'external.md')
    const realRename = fs.rename.bind(fs)
    let injected = false

    await fs.writeFile(source, 'source')
    await fs.writeFile(external, 'external-new')
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(from) === source && String(to).endsWith('/detached-source')) {
        injected = true
        await realRename(external, target)
      }

      return realRename(from, to)
    })

    await expect(
      files.capabilities.conditionalFileMutation!.replaceIfAbsent(
        'source.md',
        'target.md',
        'source',
        'app-final',
      ),
    ).rejects.toMatchObject({ code: 'ESTALE' })
    await expect(files.base.read('source.md')).resolves.toBe('source')
    await expect(files.base.read('target.md')).resolves.toBe('external-new')
    expect((await fs.readdir(root)).sort()).toEqual(['source.md', 'target.md'])
  })

  it('publishes final bytes when source and destination are the same medium entry', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await fs.writeFile(join(root, 'source.md'), 'source')

    await expect(
      files.capabilities.conditionalFileMutation!.replaceIfAbsent(
        'source.md',
        'source.md',
        'source',
        'app-final',
      ),
    ).resolves.toBe(true)
    await expect(files.base.read('source.md')).resolves.toBe('app-final')
    expect(await fs.readdir(root)).toEqual(['source.md'])
  })

  it('preserves inode metadata for a pure no-replace rename', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const old = new Date('2020-01-02T03:04:05.000Z')

    await fs.writeFile(source, 'source', { mode: 0o600 })
    await fs.utimes(source, old, old)
    const before = await fs.stat(source, { bigint: true })

    await expect(
      files.capabilities.fileNoReplaceMove!.renameIfAbsent('source.md', 'target.md'),
    ).resolves.toBe(true)
    const after = await fs.stat(join(root, 'target.md'), { bigint: true })

    expect(after.ino).toBe(before.ino)
    expect(after.mode & 0o777n).toBe(0o600n)
    expect(after.mtimeNs).toBe(before.mtimeNs)
  })

  itProcess(
    'finishes a pure rename after the process stops between publication and detach',
    async () => {
      const root = await mkroot()
      const source = join(root, 'source.md')
      const target = join(root, 'target.md')

      await fs.writeFile(source, 'source', { mode: 0o600 })
      const before = await fs.stat(source, { bigint: true })
      crashMove(root, 'rename', 'after-publication')

      // The interrupted public state is deliberately redundant but lossless.
      await expect(fs.readFile(source, 'utf8')).resolves.toBe('source')
      await expect(fs.readFile(target, 'utf8')).resolves.toBe('source')

      const recovered = createLocalFsFiles(root)
      await expect(recovered.base.scan()).resolves.toEqual([
        expect.objectContaining({ path: 'target.md' }),
      ])
      await expect(recovered.base.read('source.md')).resolves.toBeNull()
      await expect(recovered.base.read('target.md')).resolves.toBe('source')
      expect((await fs.stat(target, { bigint: true })).ino).toBe(before.ino)
      expect(await fs.readdir(root)).toEqual(['target.md'])
    },
  )

  itProcess(
    'restarts recovery itself after a second process stops during source detach',
    async () => {
      const root = await mkroot()

      await fs.writeFile(join(root, 'source.md'), 'source')
      crashMove(root, 'rename', 'after-publication')
      crashRecoveryAfterDetach(root)

      const recovered = createLocalFsFiles(root)
      await expect(recovered.base.read('source.md')).resolves.toBeNull()
      await expect(recovered.base.read('target.md')).resolves.toBe('source')
      expect(await fs.readdir(root)).toEqual(['target.md'])
    },
  )

  itProcess(
    'finishes a replace after the process stops with final target and live source',
    async () => {
      const root = await mkroot()

      await fs.writeFile(join(root, 'source.md'), 'source')
      crashMove(root, 'replace', 'after-publication')

      const recovered = createLocalFsFiles(root)
      await expect(recovered.base.read('target.md')).resolves.toBe('app-final')
      await expect(recovered.base.read('source.md')).resolves.toBeNull()
      expect(await fs.readdir(root)).toEqual(['target.md'])
    },
  )

  itProcess('rolls back a prepared operation stopped before target publication', async () => {
    const root = await mkroot()

    await fs.writeFile(join(root, 'source.md'), 'source')
    crashMove(root, 'replace', 'before-publication')

    const recovered = createLocalFsFiles(root)
    await expect(recovered.base.read('source.md')).resolves.toBe('source')
    await expect(recovered.base.read('target.md')).resolves.toBeNull()
    expect(await fs.readdir(root)).toEqual(['source.md'])
  })

  itProcess('rolls forward a same-path replace stopped in the hidden-only window', async () => {
    const root = await mkroot()

    await fs.writeFile(join(root, 'source.md'), 'source')
    crashMove(root, 'replace', 'after-detach', true)
    await expect(fs.lstat(join(root, 'source.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    const recovered = createLocalFsFiles(root)
    await expect(recovered.base.read('source.md')).resolves.toBe('app-final')
    expect(await fs.readdir(root)).toEqual(['source.md'])
  })

  it('rolls forward an occupied-entry replace stopped in the hidden-only window', async () => {
    if (process.platform === 'win32') {
      return
    }
    const root = await mkroot()
    const source = join(root, 'source.md')
    execFileSync('mkfifo', [source])
    crashMove(root, 'replace-entry', 'after-detach', true)
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' })

    const recovered = createLocalFsFiles(root)
    await expect(recovered.base.read('source.md')).resolves.toBe('app-final')
    expect((await fs.lstat(source)).isFile()).toBe(true)
    expect(await fs.readdir(root)).toEqual(['source.md'])
  })

  itProcess('preserves a foreign target that replaces an interrupted publication', async () => {
    const root = await mkroot()
    const target = join(root, 'target.md')

    await fs.writeFile(join(root, 'source.md'), 'source')
    crashMove(root, 'replace', 'after-publication')
    await fs.writeFile(join(root, 'external.md'), 'external-target')
    await fs.rename(join(root, 'external.md'), target)

    const recovered = createLocalFsFiles(root)
    await recovered.base.scan()
    await expect(recovered.base.read('source.md')).resolves.toBe('source')
    await expect(recovered.base.read('target.md')).resolves.toBe('external-target')
    expect((await fs.readdir(root)).sort()).toEqual(['source.md', 'target.md'])
  })

  itProcess(
    'surfaces original bytes when a foreign source replaces an interrupted move',
    async () => {
      const root = await mkroot()
      const source = join(root, 'source.md')

      await fs.writeFile(source, 'source')
      crashMove(root, 'replace', 'after-publication')
      await fs.writeFile(join(root, 'external.md'), 'external-source')
      await fs.rename(join(root, 'external.md'), source)

      const recovered = createLocalFsFiles(root)
      await recovered.base.scan()
      const entries = (await fs.readdir(root)).sort()
      const recovery = entries.find((entry) => entry.startsWith('source.recovered-'))

      await expect(recovered.base.read('source.md')).resolves.toBe('external-source')
      await expect(recovered.base.read('target.md')).resolves.toBeNull()
      expect(recovery).toBeDefined()
      await expect(fs.readFile(join(root, recovery!), 'utf8')).resolves.toBe('source')
      expect(entries).not.toContain('.notarium-fs-ops')
    },
  )

  itProcess(
    'preserves a foreign source captured into the journal when recovery restarts',
    async () => {
      const root = await mkroot()

      crashAfterCapturingForeign(root, 'detached-source')

      await expect(createLocalFsFiles(root).base.scan()).resolves.toEqual(expect.any(Array))
      // A second adapter must observe a fully converged namespace, not depend on
      // process-local recovery state left by the first pass.
      await expect(createLocalFsFiles(root).base.scan()).resolves.toEqual(expect.any(Array))
      await expect(fs.readFile(join(root, 'source.md'), 'utf8')).resolves.toBe('FOREIGN-SOURCE')
      await expect(fs.lstat(join(root, 'target.md'))).rejects.toMatchObject({ code: 'ENOENT' })

      const entries = (await fs.readdir(root)).sort()
      const recovery = entries.find((entry) => entry.startsWith('source.recovered-'))

      expect(recovery).toBeDefined()
      await expect(fs.readFile(join(root, recovery!), 'utf8')).resolves.toBe('original')
      expect(entries).not.toContain('.notarium-fs-ops')
    },
  )

  itProcess(
    'restores a foreign target captured into the journal and converges across restarts',
    async () => {
      const root = await mkroot()

      crashAfterCapturingForeign(root, 'detached-target')

      await expect(createLocalFsFiles(root).base.scan()).resolves.toEqual(expect.any(Array))
      await expect(createLocalFsFiles(root).base.scan()).resolves.toEqual(expect.any(Array))
      await expect(fs.readFile(join(root, 'source.md'), 'utf8')).resolves.toBe('original')
      await expect(fs.readFile(join(root, 'target.md'), 'utf8')).resolves.toBe('FOREIGN-TARGET')
      expect(await fs.readdir(root)).toEqual(['source.md', 'target.md'])
    },
  )

  itProcess(
    'restores a captured regular file through the portable link when renameat2 is unavailable',
    async () => {
      const root = await mkroot()
      const actualArch = process.arch

      crashAfterCapturingForeign(root, 'detached-target')
      const link = vi.spyOn(fs, 'link')

      Object.defineProperty(process, 'arch', {
        configurable: true,
        value: 'unsupported-audit-arch',
      })
      try {
        await expect(createLocalFsFiles(root).base.scan()).resolves.toEqual(expect.any(Array))
      } finally {
        Object.defineProperty(process, 'arch', { configurable: true, value: actualArch })
      }

      expect(
        link.mock.calls.some(
          ([from, to]) =>
            String(from).endsWith('/detached-target') && String(to) === join(root, 'target.md'),
        ),
      ).toBe(true)
      await expect(fs.readFile(join(root, 'source.md'), 'utf8')).resolves.toBe('original')
      await expect(fs.readFile(join(root, 'target.md'), 'utf8')).resolves.toBe('FOREIGN-TARGET')
      expect(await fs.readdir(root)).toEqual(['source.md', 'target.md'])
    },
  )

  it('does not recover another LocalFS instance while its root operation is live', async () => {
    const root = await mkroot()
    const first = createLocalFsFiles(root)
    const second = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const target = join(root, 'target.md')
    const realLink = fs.link.bind(fs)
    let publicationReached!: () => void
    let resumePublication!: () => void
    const published = new Promise<void>((resolve) => {
      publicationReached = resolve
    })
    const publicationGate = new Promise<void>((resolve) => {
      resumePublication = resolve
    })
    let held = false

    await fs.writeFile(source, 'original')
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      const result = await realLink(from, to)

      if (!held && String(from).endsWith('/final') && String(to) === target) {
        held = true
        publicationReached()
        await publicationGate
      }

      return result
    })

    const move = first.capabilities
      .conditionalFileMutation!.replaceIfAbsent('source.md', 'target.md', 'original', 'final')
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
    await published
    const peer = second.base.write('peer.md', 'peer')
    const peerSettledBeforeRelease = await Promise.race([
      peer.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ])

    resumePublication()
    const outcome = await move
    await expect(peer).resolves.toBeUndefined()

    expect(peerSettledBeforeRelease).toBe(false)
    expect(outcome).toEqual({ value: true })
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('final')
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(join(root, 'peer.md'), 'utf8')).resolves.toBe('peer')
    expect(await fs.readdir(root)).toEqual(['peer.md', 'target.md'])
  })

  it('fails closed on a forged recovery path without touching public entries', async () => {
    const root = await mkroot()
    const operation = join(root, '.notarium-fs-ops', 'op-00000000-0000-4000-8000-000000000000')
    await fs.mkdir(operation, { recursive: true })
    await fs.writeFile(join(root, 'victim.md'), 'foreign')
    await fs.writeFile(
      join(operation, 'intent.json'),
      JSON.stringify({
        version: 1,
        kind: 'rename',
        source: 'safe/../victim.md',
        target: 'target.md',
        expectedSourceHash: '0'.repeat(64),
        finalHash: '0'.repeat(64),
        sameEntry: false,
        legacySourceLinkedTarget: false,
      }),
    )
    await fs.writeFile(join(operation, 'active'), '')

    await expect(createLocalFsFiles(root).base.scan()).rejects.toThrow(
      /invalid LocalFS move recovery path/,
    )
    await expect(fs.readFile(join(root, 'victim.md'), 'utf8')).resolves.toBe('foreign')
    await expect(fs.lstat(join(root, 'target.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a committed move when only empty quarantine cleanup fails', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await fs.writeFile(join(root, 'source.md'), 'source')
    vi.spyOn(fs, 'rmdir').mockRejectedValueOnce(errno('EIO'))

    await expect(
      files.capabilities.conditionalFileMutation!.replaceIfAbsent(
        'source.md',
        'target.md',
        'source',
        'app-final',
      ),
    ).resolves.toBe(true)
    await expect(files.base.read('source.md')).resolves.toBeNull()
    await expect(files.base.read('target.md')).resolves.toBe('app-final')
    expect(await fs.readdir(root)).toContain('.notarium-fs-ops')
  })

  it('retains its private source claim when publication and recovery both fail', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const realLink = fs.link.bind(fs)

    await fs.writeFile(source, 'source')
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      const target = String(to)

      if (target === source || target.includes('.recovered-')) {
        throw errno('EACCES')
      }

      return realLink(from, to)
    })

    await expect(
      files.capabilities.conditionalFileMutation!.replaceIfAbsent(
        'source.md',
        'source.md',
        'source',
        'app-final',
      ),
    ).rejects.toThrow(/recovery remains/i)
    const [operation] = await fs.readdir(join(root, '.notarium-fs-ops'))

    expect(operation).toMatch(/^op-/)
    await expect(
      fs.readFile(join(root, '.notarium-fs-ops', operation!, 'source'), 'utf8'),
    ).resolves.toBe('source')
  })

  it('does not leak a source claim when final-byte staging cannot start', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await fs.writeFile(join(root, 'source.md'), 'source')
    vi.spyOn(fs, 'open').mockRejectedValueOnce(errno('EACCES'))

    await expect(
      files.capabilities.conditionalFileMutation!.replaceIfAbsent(
        'source.md',
        'target.md',
        'source',
        'app-final',
      ),
    ).rejects.toMatchObject({ code: 'EACCES' })
    await expect(files.base.read('source.md')).resolves.toBe('source')
    expect(await fs.readdir(root)).toEqual(['source.md'])
  })

  it('does not delete a replacement that wins during conditional remove', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const external = join(root, 'external.md')
    const realRename = fs.rename.bind(fs)
    let injected = false

    await fs.writeFile(source, 'source')
    await fs.writeFile(external, 'external-new')
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(from) === source && String(to).includes('.notarium-move-')) {
        injected = true
        await realRename(external, source)
      }

      return realRename(from, to)
    })

    await expect(
      files.capabilities.conditionalFileMutation!.removeIfUnchanged('source.md', 'source'),
    ).resolves.toBe(false)
    await expect(files.base.read('source.md')).resolves.toBe('external-new')
    expect(await fs.readdir(root)).toEqual(['source.md'])
  })

  it('binds publication-claim verification to conditional remove', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const external = join(root, 'external.md')
    const realRename = fs.rename.bind(fs)
    let injected = false

    await fs.writeFile(source, 'same bytes')
    const observation = await files.capabilities.resourceObservation!.observe('source.md')

    if (observation.kind !== 'present') {
      throw new Error('expected present source observation')
    }
    await fs.writeFile(external, 'same bytes')
    const externalInode = (await fs.stat(external, { bigint: true })).ino
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(from) === source && String(to).includes('.notarium-move-')) {
        injected = true
        await realRename(external, source)
      }

      return realRename(from, to)
    })

    await expect(
      files.capabilities.claimedRemoval!.removeIfClaimed(
        'source.md',
        'same bytes',
        observation.claim,
      ),
    ).resolves.toBe(false)
    expect(injected).toBe(true)
    expect((await fs.stat(source, { bigint: true })).ino).toBe(externalInode)
    await expect(files.base.read('source.md')).resolves.toBe('same bytes')
  })

  it('bounds a visible recovery name for a maximum-length legal source basename', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const leaf = `${'a'.repeat(252)}.md`
    const source = join(root, leaf)
    const realRename = fs.rename.bind(fs)
    let injected = false

    await fs.writeFile(source, 'original')
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(from) === source && String(to).includes('.notarium-move-')) {
        injected = true
        await fs.writeFile(source, 'displaced')
        await realRename(from, to)
        await fs.writeFile(source, 'foreign winner')
        return
      }

      return realRename(from, to)
    })

    await expect(
      files.capabilities.conditionalFileMutation!.removeIfUnchanged(leaf, 'original'),
    ).resolves.toBe(false)
    const entries = await fs.readdir(root)
    const recovered = entries.find((entry) => entry.includes('.recovered-'))

    expect(recovered).toBeDefined()
    expect(Buffer.byteLength(recovered!)).toBeLessThanOrEqual(255)
    await expect(fs.readFile(join(root, recovered!), 'utf8')).resolves.toBe('displaced')
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('foreign winner')
  })

  it('reports a source moved away after claim as a conditional-remove conflict', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const moved = join(root, 'moved.md')
    const realRename = fs.rename.bind(fs)
    let injected = false

    await fs.writeFile(source, 'source')
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(from) === source && String(to).includes('.notarium-move-')) {
        injected = true
        await realRename(source, moved)
      }

      return realRename(from, to)
    })

    await expect(
      files.capabilities.conditionalFileMutation!.removeIfUnchanged('source.md', 'source'),
    ).resolves.toBe(false)
    await expect(files.base.read('moved.md')).resolves.toBe('source')
    expect(await fs.readdir(root)).toEqual(['moved.md'])
  })

  it('fails closed when the source is externally unlinked after claim', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const realRename = fs.rename.bind(fs)
    let injected = false

    await fs.writeFile(source, 'source')
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(from) === source && String(to).includes('.notarium-move-')) {
        injected = true
        await fs.unlink(source)
      }

      return realRename(from, to)
    })

    await expect(
      files.capabilities.conditionalFileMutation!.removeIfUnchanged('source.md', 'source'),
    ).resolves.toBe(false)
    expect(await fs.readdir(root)).toEqual([])
  })

  itDirMove('moves a directory only when the destination pathname is absent', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'note.md'), 'source')
    await expect(
      files.capabilities.directoryNoReplaceMove!.renameDirIfAbsent('source', 'target'),
    ).resolves.toBe(true)
    await expect(fs.readFile(join(root, 'target', 'note.md'), 'utf8')).resolves.toBe('source')
    await expect(fs.lstat(join(root, 'source'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('binds the directory that held the pathname when the observation opened', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    await fs.mkdir(join(root, 'foreign'))
    await fs.link(join(root, 'source', 'SKILL.md'), join(root, 'foreign', 'SKILL.md'))
    const realLstat = fs.lstat.bind(fs)
    let samples = 0

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      // Swapped INSIDE the observation window, before the sample that closes it.
      // Both directories present the same inode, so the resource half of the
      // claim is satisfied either way and only the order of the directory sample
      // decides which directory the claim ends up naming.
      if (String(path) === join(root, 'source', 'SKILL.md') && ++samples === 2) {
        renameSync(join(root, 'source'), join(root, 'stash'))
        renameSync(join(root, 'foreign'), join(root, 'source'))
      }

      return Reflect.apply(realLstat, fs, [path, options] as never) as never
    })
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    vi.restoreAllMocks()
    // Naming the directory the read STARTED in is what fails closed here: naming
    // the one it ended in would certify the stranger as the package just read.
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toEqual({ status: 'conflict' })
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('refuses a proof that names no directory to move', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const move = files.capabilities.conditionalDirectoryMove!

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    const ours = await fs.lstat(join(root, 'source'), { bigint: true })
    // The same resource, observed WITHOUT asking which directory held it. Every
    // question this claim can answer, a stranger's hardlink of that resource
    // answers identically — so there is no directory for `moved` to be true
    // about, and no answer this facet could give would be one.
    const unbound = await files.capabilities.resourceObservation!.observe('source/SKILL.md')

    expect(unbound.kind).toBe('present')
    if (unbound.kind !== 'present') {
      return
    }
    const request = {
      sourcePath: 'source',
      targetPath: 'target',
      sourceProofPath: 'source/SKILL.md',
    }

    await expect(
      move.moveIfClaimed({ ...request, expectedSourceProof: unbound.claim }),
    ).rejects.toThrow('directory move proof must name the directory it was observed in')
    // A malformed request, not a race: refused before the medium is touched.
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
    const bound = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(bound.kind).toBe('present')
    if (bound.kind !== 'present') {
      return
    }
    // The very same transition, asked with the bound form of the very same
    // observation, goes through — so the refusal above is about the proof and
    // nothing else.
    await expect(
      move.moveIfClaimed({ ...request, expectedSourceProof: bound.claim }),
    ).resolves.toMatchObject({ status: 'moved' })
    expect((await fs.lstat(join(root, 'target'), { bigint: true })).ino).toBe(ours.ino)
  })

  it('conditions ordinary claim-checked facets on a directory-bound claim', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'pkg'))
    await fs.writeFile(join(root, 'pkg', 'SKILL.md'), 'manifest')
    const bound = await files.capabilities.resourceObservation!.observe('pkg/SKILL.md', {
      bindDirectory: true,
    })
    const plain = await files.capabilities.resourceObservation!.observe('pkg/SKILL.md')

    expect(bound.kind).toBe('present')
    expect(plain.kind).toBe('present')
    if (bound.kind !== 'present' || plain.kind !== 'present') {
      return
    }
    // The two claims describe one incarnation and differ only in what the bound
    // one additionally NAMES. A facet that conditions on a pathname must accept
    // either — the directory half is not part of the question it asks.
    expect(bound.claim.value).not.toBe(plain.claim.value)
    await expect(
      files.capabilities.claimedRemoval!.removeIfClaimed('pkg/SKILL.md', 'manifest', bound.claim),
    ).resolves.toBe(true)
    await expect(fs.lstat(join(root, 'pkg', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('decides a replaced proof before it commits anything', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const manifest = 'byte-identical manifest'

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), manifest)
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const ours = await fs.lstat(join(root, 'source'), { bigint: true })
    const realLstat = fs.lstat.bind(fs)
    let samples = 0

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      // The descriptor still holds the claimed incarnation, so every question put
      // to it answers "carried" — only the PATHNAME stopped naming it.
      if (String(path) === join(root, 'source', 'SKILL.md') && ++samples === 2) {
        renameSync(join(root, 'source', 'SKILL.md'), join(root, 'source', 'displaced.md'))
        writeFileSync(join(root, 'source', 'SKILL.md'), manifest)
      }
      // Reached only if the publication went ahead anyway: the source pathname is
      // taken back, so a decision deferred until after the commit could no longer
      // be undone and would have to be reported as a standing transition.
      if (String(path) === join(root, 'target')) {
        mkdirSync(join(root, 'source'), { recursive: true })
      }

      return Reflect.apply(realLstat, fs, [path, options] as never) as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toEqual({ status: 'conflict' })
    expect((await fs.lstat(join(root, 'source'), { bigint: true })).ino).toBe(ours.ino)
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('moves only the directory carrying the claimed source resource', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const manifest = 'byte-identical manifest'

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), manifest)
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const original = await fs.lstat(join(root, 'source', 'SKILL.md'), { bigint: true })
    const realLstat = fs.lstat.bind(fs)
    let sourceProofStats = 0

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      const result = await Reflect.apply(realLstat, fs, [path, options] as never)

      if (String(path) === join(root, 'source', 'SKILL.md') && ++sourceProofStats === 2) {
        await fs.rename(
          join(root, 'source', 'SKILL.md'),
          join(root, 'source', 'displaced-SKILL.md'),
        )
        await fs.writeFile(join(root, 'source', 'SKILL.md'), manifest)
      }

      return result as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toEqual({ status: 'conflict' })
    const replacement = await fs.lstat(join(root, 'source', 'SKILL.md'), { bigint: true })

    expect(replacement.ino).not.toBe(original.ino)
    await expect(fs.readFile(join(root, 'source', 'SKILL.md'), 'utf8')).resolves.toBe(manifest)
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('refuses a move whose claimed proof is missing or superseded', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const move = files.capabilities.conditionalDirectoryMove!

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const request = {
      sourcePath: 'source',
      targetPath: 'target',
      sourceProofPath: 'source/SKILL.md',
      expectedSourceProof: observed.claim,
    }

    // Rewritten under the same name: a resource whose incarnation the caller
    // never saw is not a resource it can be moving.
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'rewritten')
    await expect(move.moveIfClaimed(request)).resolves.toEqual({ status: 'conflict' })
    // Gone entirely: absence is an answer about the world, not a fault to raise.
    await fs.rm(join(root, 'source', 'SKILL.md'))
    await expect(move.moveIfClaimed(request)).resolves.toEqual({ status: 'conflict' })
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('answers conflict for every way the proof can be swapped mid-claim', async () => {
    const swaps: { name: string; before: boolean; swap: (path: string) => void }[] = [
      // Unlinked between the path sample and the open: the open fails ENOENT.
      { name: 'unlinked before the open', before: false, swap: (path) => unlinkSync(path) },
      // Unlinked between the read and the closing path sample: that lstat fails.
      {
        name: 'unlinked before the closing sample',
        before: true,
        swap: (path) => unlinkSync(path),
      },
      // Replaced by a symlink: O_NOFOLLOW turns the open into ELOOP rather than
      // reading whatever the link points at.
      {
        name: 'replaced by a symlink',
        before: false,
        swap: (path) => {
          unlinkSync(path)
          symlinkSync(path, path)
        },
      },
      // Replaced by a directory: the open SUCCEEDS, and only comparing the opened
      // incarnation against the sampled one stops the read of a directory fd.
      {
        name: 'replaced by a directory',
        before: false,
        swap: (path) => {
          unlinkSync(path)
          mkdirSync(path)
        },
      },
    ]

    for (const { name, before, swap } of swaps) {
      const root = await mkroot()
      const files = createLocalFsFiles(root)

      await fs.mkdir(join(root, 'source'))
      await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
      const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
        bindDirectory: true,
      })

      expect(observed.kind, name).toBe('present')
      if (observed.kind !== 'present') {
        return
      }
      const proofPath = join(root, 'source', 'SKILL.md')
      const realLstat = fs.lstat.bind(fs)
      let samples = 0

      vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
        // `before` picks which side of the sample the writer gets in: the first
        // sample opens the claim, the second closes it.
        const swapping = String(path) === proofPath && ++samples === (before ? 2 : 1)

        if (swapping && before) {
          swap(proofPath)
        }
        const result = await Reflect.apply(realLstat, fs, [path, options] as never).catch(
          (error: unknown) => {
            throw error
          },
        )

        if (swapping && !before) {
          swap(proofPath)
        }

        return result as never
      })
      await expect(
        files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
          sourcePath: 'source',
          targetPath: 'target',
          sourceProofPath: 'source/SKILL.md',
          expectedSourceProof: observed.claim,
        }),
        name,
      ).resolves.toEqual({ status: 'conflict' })
      await expect(fs.lstat(join(root, 'target')), name).rejects.toMatchObject({ code: 'ENOENT' })
      vi.restoreAllMocks()
    }
  })

  itDirMove('refuses a target entry whose matching inode is no longer a directory', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const ours = await fs.lstat(join(root, 'source'), { bigint: true })
    const realLstat = fs.lstat.bind(fs)
    let samples = 0

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      const result = await Reflect.apply(realLstat, fs, [path, options] as never)

      // Inode numbers are RECYCLED: a directory destroyed under us frees its
      // number for the next allocation on that filesystem, and no test can ask a
      // kernel to hand it back on cue. So the pair is left true and the kind is
      // overridden — the one field a reallocated number cannot keep.
      if (String(path) === join(root, 'target') && ++samples === 1) {
        return Object.create(result as object, {
          isDirectory: { value: () => false },
        }) as never
      }

      return result as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toEqual({ status: 'conflict' })
    expect((await fs.lstat(join(root, 'source'), { bigint: true })).ino).toBe(ours.ino)
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('never opens a proof pathname that is not a regular file', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'real.md'), 'manifest')
    // Observed inside the source directory, so the request DOES name the
    // directory to move and the only question left is the proof pathname itself.
    const observed = await files.capabilities.resourceObservation!.observe('source/real.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    await fs.mkdir(join(root, 'source', 'SKILL.md'))
    await fs.symlink(join(root, 'source', 'real.md'), join(root, 'source', 'LINK.md'))
    const open = vi.spyOn(fs, 'open')

    for (const proof of ['source/SKILL.md', 'source/LINK.md']) {
      await expect(
        files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
          sourcePath: 'source',
          targetPath: 'target',
          sourceProofPath: proof,
          expectedSourceProof: observed.claim,
        }),
        proof,
      ).resolves.toEqual({ status: 'conflict' })
    }
    // The pathname sample already answered. Handing an unopenable — or worse, an
    // openable — non-regular pathname to the kernel adds a decision the claim
    // cannot use and a descriptor nobody asked for.
    expect(open).not.toHaveBeenCalled()
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('answers conflict when the proof changes under the read that claims it', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const proofPath = join(root, 'source', 'SKILL.md')
    const realOpen = fs.open.bind(fs)
    let grown = false

    vi.spyOn(fs, 'open').mockImplementation(async (path, ...rest) => {
      const handle = await Reflect.apply(realOpen, fs, [path, ...rest] as never)

      if (String(path) !== proofPath) {
        return handle as never
      }

      // A writer that lands strictly between the read and the sample that closes
      // it: the bytes in hand are already stale, and the descriptor is the only
      // thing that can say so. Comparing size against those bytes would raise a
      // fault instead — a benign concurrent write is a conflict, not a crash.
      return {
        stat: async (options: unknown) => Reflect.apply(handle.stat, handle, [options] as never),
        readFile: async () => {
          const bytes = await handle.readFile()

          if (!grown) {
            grown = true
            appendFileSync(proofPath, ' plus')
          }

          return bytes
        },
        close: async () => handle.close(),
      } as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toEqual({ status: 'conflict' })
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('leaves an occupied destination alone and says so', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    await fs.mkdir(join(root, 'target'))
    await fs.writeFile(join(root, 'target', 'SKILL.md'), 'incumbent')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toEqual({ status: 'occupied' })
    await expect(fs.readFile(join(root, 'target', 'SKILL.md'), 'utf8')).resolves.toBe('incumbent')
    await expect(fs.readFile(join(root, 'source', 'SKILL.md'), 'utf8')).resolves.toBe('manifest')
  })

  itDirMove('rolls back a committed move whose proof was rewritten in place', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const ours = await fs.lstat(join(root, 'source'), { bigint: true })
    const realLstat = fs.lstat.bind(fs)
    let rewritten = false

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      // Same inode, same pathname, new content: the directory did arrive, and the
      // resource the caller claimed is not the one standing in it. The descriptor
      // held open since the claim is the only witness that can tell the difference.
      if (!rewritten && String(path) === join(root, 'target')) {
        rewritten = true
        appendFileSync(join(root, 'target', 'SKILL.md'), ' plus')
      }

      return Reflect.apply(realLstat, fs, [path, options] as never) as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toEqual({ status: 'conflict' })
    expect((await fs.lstat(join(root, 'source'), { bigint: true })).ino).toBe(ours.ino)
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('throws without a transition when the source leaves before publication', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const realLstat = fs.lstat.bind(fs)
    let samples = 0

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      const result = await Reflect.apply(realLstat, fs, [path, options] as never)

      // The claim is complete and the publication has not started: whatever
      // happens next is a PRE-commit failure, and the caller must be able to read
      // an exception as "nothing moved" without inspecting the tree.
      if (String(path) === join(root, 'source', 'SKILL.md') && ++samples === 2) {
        renameSync(join(root, 'source'), join(root, 'elsewhere'))
      }

      return result as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(join(root, 'elsewhere', 'SKILL.md'), 'utf8')).resolves.toBe('manifest')
  })

  itDirMove('reports a committed move whose target left before it could roll back', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    await fs.mkdir(join(root, 'foreign'))
    await fs.writeFile(join(root, 'foreign', 'SKILL.md'), 'foreign manifest')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const realLstat = fs.lstat.bind(fs)
    let samples = 0

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      if (String(path) === join(root, 'target')) {
        samples++
        // First: a stranger takes the published pathname, so the move must undo
        // itself. Then: the stranger leaves too, so there is nothing left to
        // sample — and the answer still has to name what went wrong, because the
        // caller's directory is committed at a pathname it no longer holds.
        if (samples === 1) {
          renameSync(join(root, 'target'), join(root, 'displaced'))
          renameSync(join(root, 'foreign'), join(root, 'target'))
        }
        if (samples === 2) {
          rmSync(join(root, 'target'), { recursive: true })
        }
      }

      return Reflect.apply(realLstat, fs, [path, options] as never) as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toEqual({
      status: 'committed-error',
      reason: 'directory moved but its claimed source resource did not reach the target',
    })
  })

  itDirMove('returns a target-scoped proof that can condition a reverse move', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const moved = await files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
      sourcePath: 'source',
      targetPath: 'target',
      sourceProofPath: 'source/SKILL.md',
      expectedSourceProof: observed.claim,
    })

    expect(moved.status).toBe('moved')
    if (moved.status !== 'moved') {
      return
    }
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'target',
        targetPath: 'source',
        sourceProofPath: 'target/SKILL.md',
        expectedSourceProof: moved.targetProof,
      }),
    ).resolves.toMatchObject({ status: 'moved' })
    await expect(fs.readFile(join(root, 'source', 'SKILL.md'), 'utf8')).resolves.toBe('manifest')
  })

  itDirMove('reports when a proof failure cannot roll the committed directory back', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const realLstat = fs.lstat.bind(fs)
    let replaced = false

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      if (!replaced && String(path) === join(root, 'target', 'SKILL.md')) {
        replaced = true
        await fs.rename(
          join(root, 'target', 'SKILL.md'),
          join(root, 'target', 'displaced-SKILL.md'),
        )
        await fs.writeFile(join(root, 'target', 'SKILL.md'), 'manifest')
        await fs.mkdir(join(root, 'source'))
      }

      return Reflect.apply(realLstat, fs, [path, options] as never) as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toMatchObject({ status: 'committed-error' })
    await expect(fs.readFile(join(root, 'target', 'SKILL.md'), 'utf8')).resolves.toBe('manifest')
    await expect(fs.lstat(join(root, 'source'))).resolves.toMatchObject({})
  })

  itDirMove('restores the source when the committed move cannot be inspected', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const ours = await fs.lstat(join(root, 'source'), { bigint: true })
    const realLstat = fs.lstat.bind(fs)
    let removed = false

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      // The publication is already committed; an external writer then unlinks the
      // very resource the adapter is about to sample, so the post-commit question
      // does not fail an assertion — it THROWS.
      if (!removed && String(path) === join(root, 'target', 'SKILL.md')) {
        removed = true
        unlinkSync(join(root, 'target', 'SKILL.md'))
      }

      return Reflect.apply(realLstat, fs, [path, options] as never) as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    // A throw is only allowed to leave the source placement owning the directory:
    // that is the containment the caller is told it can rely on.
    expect((await fs.lstat(join(root, 'source'), { bigint: true })).ino).toBe(ours.ino)
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('reports a committed move whose inspection threw and could not roll back', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const ours = await fs.lstat(join(root, 'source'), { bigint: true })
    const realLstat = fs.lstat.bind(fs)
    let removed = false

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      // Same throwing post-commit sample, plus the source pathname taken back by
      // the same writer — so the transition cannot be undone and the caller has
      // to be TOLD it stands rather than handed an exception that implies it does not.
      if (!removed && String(path) === join(root, 'target', 'SKILL.md')) {
        removed = true
        unlinkSync(join(root, 'target', 'SKILL.md'))
        mkdirSync(join(root, 'source'))
      }

      return Reflect.apply(realLstat, fs, [path, options] as never) as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toMatchObject({
      status: 'committed-error',
      reason: expect.stringContaining('directory move committed before proof failed'),
    })
    expect((await fs.lstat(join(root, 'target'), { bigint: true })).ino).toBe(ours.ino)
  })

  itDirMove('refuses a target proof carried by a directory it never moved', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const manifest = 'byte-identical manifest'

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), manifest)
    // The foreign package's manifest is a HARD LINK to ours, so every question
    // the proof can ask about it — dev, ino, size, ctime, mtime, bytes — answers
    // "carried". Only the identity of the directory that arrived at the target
    // pathname separates our publication from someone else's.
    await fs.mkdir(join(root, 'foreign'))
    await fs.link(join(root, 'source', 'SKILL.md'), join(root, 'foreign', 'SKILL.md'))
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const ours = await fs.lstat(join(root, 'source'), { bigint: true })
    const realLstat = fs.lstat.bind(fs)
    let swapped = false

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      // Synchronous on purpose: the whole swap has to land between the committed
      // publication and the very first sample of the target, or the two halves of
      // the pair would not be observed against the same tree.
      if (!swapped && String(path) === join(root, 'target')) {
        swapped = true
        renameSync(join(root, 'target'), join(root, 'displaced'))
        renameSync(join(root, 'foreign'), join(root, 'target'))
      }

      return Reflect.apply(realLstat, fs, [path, options] as never) as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toEqual({
      status: 'committed-error',
      reason: 'directory moved but its claimed source resource did not reach the target',
    })
    // Never `moved`: a target proof handed back here would bind the caller's
    // placement and reach to a package this adapter did not move.
    expect((await fs.lstat(join(root, 'target'), { bigint: true })).ino).not.toBe(ours.ino)
    expect((await fs.lstat(join(root, 'displaced'), { bigint: true })).ino).toBe(ours.ino)
  })

  itDirMove('never rolls a foreign directory back onto the source placement', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    await fs.mkdir(join(root, 'foreign'))
    await fs.writeFile(join(root, 'foreign', 'SKILL.md'), 'foreign manifest')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const ours = await fs.lstat(join(root, 'source'), { bigint: true })
    const realLstat = fs.lstat.bind(fs)
    let swapped = false

    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      // Published, then dispossessed: an external writer parks our directory
      // elsewhere and leaves a stranger holding the target pathname.
      if (!swapped && String(path) === join(root, 'target')) {
        swapped = true
        renameSync(join(root, 'target'), join(root, 'displaced'))
        renameSync(join(root, 'foreign'), join(root, 'target'))
      }

      return Reflect.apply(realLstat, fs, [path, options] as never) as never
    })
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).resolves.toEqual({
      status: 'committed-error',
      reason: 'directory moved but its claimed source resource did not reach the target',
    })
    // A rollback here would be a lie twice over: it would report `conflict` —
    // "nothing was moved" — while installing a stranger's package under the
    // source placement the caller still believes it owns.
    await expect(fs.lstat(join(root, 'source'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(join(root, 'target', 'SKILL.md'), 'utf8')).resolves.toBe(
      'foreign manifest',
    )
    expect((await fs.lstat(join(root, 'displaced'), { bigint: true })).ino).toBe(ours.ino)
  })

  itDirMove('refuses to move back a directory it never moved out', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const move = files.capabilities.conditionalDirectoryMove!

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    // A stranger hardlinks our manifest BEFORE anyone samples it, so the ctime
    // bump `link` causes is already inside the claim we are handed, and the twin
    // answers every question a file proof can ask: dev, ino, ctime, size, bytes.
    await fs.mkdir(join(root, 'foreign'))
    await fs.link(join(root, 'source', 'SKILL.md'), join(root, 'foreign', 'SKILL.md'))
    await fs.writeFile(join(root, 'foreign', 'payload.md'), 'stranger')
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const forward = await move.moveIfClaimed({
      sourcePath: 'source',
      targetPath: 'target',
      sourceProofPath: 'source/SKILL.md',
      expectedSourceProof: observed.claim,
    })

    expect(forward.status).toBe('moved')
    if (forward.status !== 'moved') {
      return
    }
    const ours = await fs.lstat(join(root, 'target'), { bigint: true })

    // Between the two halves of the caller's own transaction the stranger takes
    // the target pathname — no mock needed, the window is simply the gap between
    // two adapter calls.
    await fs.rename(join(root, 'target'), join(root, 'displaced'))
    await fs.rename(join(root, 'foreign'), join(root, 'target'))
    await expect(
      move.moveIfClaimed({
        sourcePath: 'target',
        targetPath: 'source',
        sourceProofPath: 'target/SKILL.md',
        expectedSourceProof: forward.targetProof,
      }),
    ).resolves.toEqual({ status: 'conflict' })
    // `moved` here would install the stranger's directory, payload and all, under
    // the source placement the caller believes it is restoring its own package to.
    await expect(fs.lstat(join(root, 'source'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.lstat(join(root, 'displaced'), { bigint: true })).ino).toBe(ours.ino)
  })

  itDirMove('refuses a move proof that does not live inside the source directory', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const move = files.capabilities.conditionalDirectoryMove!
    const outside = 'directory move proof must be below its source directory'

    await fs.mkdir(join(root, 'lib', 'source'), { recursive: true })
    await fs.writeFile(join(root, 'lib', 'source', 'SKILL.md'), 'manifest')
    await fs.mkdir(join(root, 'other'))
    await fs.writeFile(join(root, 'other', 'SKILL.md'), 'manifest')
    const observed = await files.capabilities.resourceObservation!.observe('other/SKILL.md')

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const request = { sourcePath: 'lib/source', targetPath: 'lib/target' }

    // Sideways: a resource the move does not carry is untouched BY the move, so
    // it would answer "still exactly as claimed" from outside the directory and
    // certify a transition nothing was ever proven about.
    await expect(
      move.moveIfClaimed({
        ...request,
        sourceProofPath: 'other/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).rejects.toThrow(outside)
    // The directory is not a resource it can carry through itself,
    await expect(
      move.moveIfClaimed({
        ...request,
        sourceProofPath: 'lib/source',
        expectedSourceProof: observed.claim,
      }),
    ).rejects.toThrow(outside)
    // and its parent stays behind entirely.
    await expect(
      move.moveIfClaimed({
        ...request,
        sourceProofPath: 'lib',
        expectedSourceProof: observed.claim,
      }),
    ).rejects.toThrow(outside)
    await expect(fs.lstat(join(root, 'lib', 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itDirMove('refuses a source pathname that is not itself a directory', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const move = files.capabilities.conditionalDirectoryMove!

    await fs.mkdir(join(root, 'real'))
    await fs.writeFile(join(root, 'real', 'SKILL.md'), 'manifest')
    await fs.writeFile(join(root, 'plain'), 'not a package')
    // A symlink POINTING at a package is not the package: renaming it publishes a
    // link at the target while the directory the caller claimed never moves, and
    // every proof question below it still answers through the link.
    await fs.symlink(join(root, 'real'), join(root, 'source'))
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    await expect(
      move.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(
      move.moveIfClaimed({
        sourcePath: 'plain',
        targetPath: 'target',
        sourceProofPath: 'plain/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).rejects.toThrow('directory move source is not a directory entry')
    // The unconditional facet answers the same question the same way: a link is
    // not the directory it names, whichever entry point asks.
    await expect(
      files.capabilities.directoryNoReplaceMove!.renameDirIfAbsent('source', 'target'),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.lstat(join(root, 'source'), { bigint: true })).isSymbolicLink()).toBe(true)
  })

  itDirMove('accepts a directory destination that is the exact same pathname entry', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'note.md'), 'source')
    await expect(
      files.capabilities.directoryNoReplaceMove!.renameDirIfAbsent('source', 'source'),
    ).resolves.toBe(true)
    await expect(fs.readFile(join(root, 'source', 'note.md'), 'utf8')).resolves.toBe('source')
  })

  itDirMove('does not replace an occupied directory destination', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.mkdir(join(root, 'target'))
    await fs.writeFile(join(root, 'source', 'source.md'), 'source')
    await fs.writeFile(join(root, 'target', 'target.md'), 'target')
    await expect(
      files.capabilities.directoryNoReplaceMove!.renameDirIfAbsent('source', 'target'),
    ).resolves.toBe(false)
    await expect(fs.readFile(join(root, 'source', 'source.md'), 'utf8')).resolves.toBe('source')
    await expect(fs.readFile(join(root, 'target', 'target.md'), 'utf8')).resolves.toBe('target')
  })

  itCrossDevice('fails closed instead of copying a directory across filesystems', async () => {
    const root = await mkroot()
    const externalRoot = await fs.mkdtemp('/dev/shm/notarium-dir-noreplace-')

    roots.push(externalRoot)
    const files = createLocalFsFiles(root)
    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'source.md'), 'source')
    await fs.symlink(externalRoot, join(root, 'other-fs'))

    await expect(
      files.capabilities.directoryNoReplaceMove!.renameDirIfAbsent('source', 'other-fs/target'),
    ).rejects.toMatchObject({
      code: 'ENOTSUP',
    })
    await expect(fs.readFile(join(root, 'source', 'source.md'), 'utf8')).resolves.toBe('source')
    await expect(fs.lstat(join(externalRoot, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itCrossDevice('refuses a conditional move whose destination is a foreign mount', async () => {
    const root = await mkroot()
    const externalRoot = await fs.mkdtemp('/dev/shm/notarium-dir-conditional-')

    roots.push(externalRoot)
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'SKILL.md'), 'manifest')
    await fs.symlink(externalRoot, join(root, 'other-fs'))
    const observed = await files.capabilities.resourceObservation!.observe('source/SKILL.md', {
      bindDirectory: true,
    })

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    // Refused on the medium, before the claim is even sampled: the syscall this
    // facet is built on cannot cross a mount, and the fallback a caller would be
    // tempted to write — copy, then delete — is not the same operation at all.
    await expect(
      files.capabilities.conditionalDirectoryMove!.moveIfClaimed({
        sourcePath: 'source',
        targetPath: 'other-fs/target',
        sourceProofPath: 'source/SKILL.md',
        expectedSourceProof: observed.claim,
      }),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
    await expect(fs.readFile(join(root, 'source', 'SKILL.md'), 'utf8')).resolves.toBe('manifest')
    await expect(fs.lstat(join(externalRoot, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('omits the directory no-replace capability on a runtime that cannot perform it', async () => {
    const root = await mkroot()
    const actualArch = process.arch
    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'source.md'), 'source')

    // Before construction: the shape is decided there, so an adapter built on an
    // unmapped ABI must never advertise the facets at all — a caller that asks
    // `if (!files.capabilities.directoryNoReplaceMove)` has to see the truth
    // without calling anything.
    Object.defineProperty(process, 'arch', { configurable: true, value: 'unsupported-audit-arch' })
    let files

    try {
      files = createLocalFsFiles(root)
    } finally {
      Object.defineProperty(process, 'arch', { configurable: true, value: actualArch })
    }

    // All FOUR, together. Generic/conditional directory move, package install and strict publication
    // rest on the same runtime primitive, so a build that keeps any one of them
    // here would be advertising an operation this host cannot perform.
    expect(Object.hasOwn(files.capabilities, 'directoryNoReplaceMove')).toBe(false)
    expect(Object.hasOwn(files.capabilities, 'conditionalDirectoryMove')).toBe(false)
    expect(Object.hasOwn(files.capabilities, 'packagePublication')).toBe(false)
    expect(Object.hasOwn(files.capabilities, 'strictPublication')).toBe(false)
    // What stays is what a caller can still do: the base port and every facet
    // that does not need the primitive.
    expect(Object.hasOwn(files.capabilities, 'conditionalFileMutation')).toBe(true)
    expect(Object.hasOwn(files.capabilities, 'fileNoReplaceMove')).toBe(true)
    // And construction touched nothing: no root, no staging tree, no journal for a
    // later run to find.
    await expect(fs.readFile(join(root, 'source', 'source.md'), 'utf8')).resolves.toBe('source')
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(root)).sort()).toEqual(['source'])
  })

  it('declares the capability exactly when this runtime provides it', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    // Ungated on purpose, and it is the positive half the native gate cannot
    // carry: that gate probes by CALLING the method, so an adapter that stopped
    // declaring it closes the gate and reads as "this machine cannot do it".
    // The shape must answer to the provider, not to the machine's mood.
    const provided = renameNoReplaceIfAvailable() !== undefined

    expect(Object.hasOwn(files.capabilities, 'directoryNoReplaceMove')).toBe(provided)
    expect(Object.hasOwn(files.capabilities, 'conditionalDirectoryMove')).toBe(provided)
    expect(Object.hasOwn(files.capabilities, 'packagePublication')).toBe(provided)
    expect(Object.hasOwn(files.capabilities, 'strictPublication')).toBe(provided)
  })

  it('closes the native gate only on a runtime that truly cannot publish', async () => {
    // A gate welded shut is invisible: everything behind it skips and the run
    // stays green, so a whole contract can stop being exercised without one red
    // line anywhere. This is the independent witness — it publishes for itself
    // and demands the gate agree with what actually happened on this machine.
    const publish = renameNoReplaceIfAvailable()
    let published = false

    if (publish) {
      const root = await mkroot()

      await fs.mkdir(join(root, 'source'))
      published = await publish(join(root, 'source'), join(root, 'target')).catch(() => false)
    }

    expect(dirMoveGate === null).toBe(published)
  })

  itDirMove('lets exactly one racing directory move claim an absent destination', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    for (const source of ['left', 'right']) {
      await fs.mkdir(join(root, source))
      await fs.writeFile(join(root, source, 'winner.md'), source)
    }
    const results = await Promise.all([
      files.capabilities.directoryNoReplaceMove!.renameDirIfAbsent('left', 'target'),
      files.capabilities.directoryNoReplaceMove!.renameDirIfAbsent('right', 'target'),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = await fs.readFile(join(root, 'target', 'winner.md'), 'utf8')
    const loser = winner === 'left' ? 'right' : 'left'
    expect(results[winner === 'left' ? 0 : 1]).toBe(true)
    await expect(fs.readFile(join(root, loser, 'winner.md'), 'utf8')).resolves.toBe(loser)
  })

  it('claims a directory leaf once while preserving raw-distinct names on this medium', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await expect(files.base.makeDir('Café')).resolves.toBe(true)
    await expect(files.base.makeDir('Café')).resolves.toBe(false)
    await expect(files.base.makeDir('Cafe\u0301')).resolves.toBe(true)
    await expect(files.base.listDirs()).resolves.toEqual(
      expect.arrayContaining(['Café', 'Cafe\u0301']),
    )
  })

  it('distinguishes one pathname entry from a hardlink and a symlink to it', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await files.base.write('source.md', 'body')
    await fs.link(join(root, 'source.md'), join(root, 'same-entry.md'))
    await fs.symlink('source.md', join(root, 'symlink.md'))

    await expect(
      files.capabilities.entryIdentity!.sameEntry('source.md', 'source.md'),
    ).resolves.toBe(true)
    await expect(
      files.capabilities.entryIdentity!.sameEntry('source.md', 'same-entry.md'),
    ).resolves.toBe(false)
    await expect(
      files.capabilities.entryIdentity!.sameEntry('source.md', 'symlink.md'),
    ).resolves.toBe(false)
  })

  it('observes exact bytes, claim and mtime from one regular-file sample', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = Uint8Array.of(0xff, 0x00, 0x0d, 0x0a)

    await fs.writeFile(join(root, 'opaque.bin'), source)
    const first = await files.capabilities.resourceObservation!.observe('opaque.bin')

    expect(first).toMatchObject({
      kind: 'present',
      claim: { kind: 'present' },
      mtimeMs: expect.any(Number),
    })
    expect(first.kind === 'present' ? first.bytes : null).toEqual(source)

    await fs.writeFile(join(root, 'opaque.bin'), Uint8Array.of(0xfe))
    const second = await files.capabilities.resourceObservation!.observe('opaque.bin')

    expect(second.kind).toBe('present')
    expect(second.kind === 'present' && first.kind === 'present' && second.claim).not.toEqual(
      first.kind === 'present' ? first.claim : null,
    )
  })

  it('keeps absent and occupied non-regular observations distinct', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await expect(
      files.capabilities.resourceObservation!.observe('missing.md'),
    ).resolves.toMatchObject({
      kind: 'absent',
      claim: { kind: 'absent' },
      mtimeMs: null,
    })
    await fs.symlink('missing.md', join(root, 'occupied.md'))
    await expect(
      files.capabilities.resourceObservation!.observe('occupied.md'),
    ).resolves.toMatchObject({
      kind: 'occupied',
      claim: { kind: 'present' },
      entryType: 'symlink',
      mtimeMs: expect.any(Number),
    })
  })

  it('publishes byte-safe creates and updates with operation-owned proof transitions', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const absent = await files.capabilities.resourceObservation!.observe('opaque.bin')

    expect(absent.kind).toBe('absent')
    if (absent.kind !== 'absent') {
      return
    }
    const created = await files.capabilities.resourcePublication!.publish({
      kind: 'put',
      path: 'opaque.bin',
      content: Uint8Array.of(0xff, 0x00),
      expected: absent.claim,
    })

    expect(created).toMatchObject({
      status: 'published',
      candidateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      transitions: [
        expect.objectContaining({
          path: 'opaque.bin',
          before: absent.claim,
          mtimeMs: expect.any(Number),
        }),
      ],
    })
    const first = await files.capabilities.resourceObservation!.observe('opaque.bin')
    expect(first.kind).toBe('present')
    if (first.kind !== 'present') {
      return
    }
    expect(created.status === 'published' ? created.transitions[0].after : null).toEqual(
      first.claim,
    )

    const updated = await files.capabilities.resourcePublication!.publish({
      kind: 'put',
      path: 'opaque.bin',
      content: Uint8Array.of(0xfe, 0x0d, 0x0a),
      expected: first.claim,
    })

    expect(updated.status).toBe('published')
    await expect(fs.readFile(join(root, 'opaque.bin'))).resolves.toEqual(
      Buffer.from([0xfe, 0x0d, 0x0a]),
    )
  })

  it('rejects stale publication claims without changing bytes', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await fs.writeFile(join(root, 'note.md'), 'first')
    const first = await files.capabilities.resourceObservation!.observe('note.md')

    expect(first.kind).toBe('present')
    if (first.kind !== 'present') {
      return
    }
    await fs.writeFile(join(root, 'note.md'), 'external')
    await expect(
      files.capabilities.resourcePublication!.publish({
        kind: 'put',
        path: 'note.md',
        content: new TextEncoder().encode('ours'),
        expected: first.claim,
      }),
    ).resolves.toEqual({ status: 'conflict' })
    await expect(fs.readFile(join(root, 'note.md'), 'utf8')).resolves.toBe('external')
  })

  it('publishes a move against the complete source/target claim set', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await fs.writeFile(join(root, 'source.md'), Uint8Array.of(0xff))
    const source = await files.capabilities.resourceObservation!.observe('source.md')
    const target = await files.capabilities.resourceObservation!.observe('target.md')

    expect(source.kind).toBe('present')
    expect(target.kind).toBe('absent')
    if (source.kind !== 'present' || target.kind !== 'absent') {
      return
    }
    const result = await files.capabilities.resourcePublication!.publish({
      kind: 'move-put',
      sourcePath: 'source.md',
      targetPath: 'target.md',
      content: Uint8Array.of(0xfe),
      expectedSource: source.claim,
      expectedTarget: target.claim,
    })

    expect(result).toMatchObject({
      status: 'published',
      transitions: [
        {
          path: 'source.md',
          before: source.claim,
          after: expect.objectContaining({ kind: 'absent' }),
          mtimeMs: null,
        },
        {
          path: 'target.md',
          before: target.claim,
          after: expect.objectContaining({ kind: 'present' }),
          mtimeMs: expect.any(Number),
        },
      ],
    })
    await expect(fs.lstat(join(root, 'source.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(join(root, 'target.md'))).resolves.toEqual(Buffer.from([0xfe]))
  })

  it('atomically publishes one aggregate package proof', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const absent = await files.capabilities.resourceObservation!.observe('demo')

    expect(absent.kind).toBe('absent')
    if (absent.kind !== 'absent') {
      return
    }
    const result = await files.capabilities.packagePublication!.publishPackageIfAbsent({
      rootPath: 'demo',
      files: [
        { path: 'SKILL.md', content: new TextEncoder().encode('manifest') },
        { path: 'assets/icon.bin', content: Uint8Array.of(0xff, 0x00) },
      ],
      expectedRoot: absent.claim,
    })

    expect(result).toMatchObject({
      status: 'published',
      candidateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      transitions: expect.arrayContaining([
        expect.objectContaining({ path: 'demo', before: absent.claim }),
        expect.objectContaining({
          path: 'demo/SKILL.md',
          before: expect.objectContaining({ kind: 'absent' }),
        }),
        expect.objectContaining({
          path: 'demo/assets/icon.bin',
          before: expect.objectContaining({ kind: 'absent' }),
        }),
      ]),
    })
    await expect(fs.readFile(join(root, 'demo', 'assets', 'icon.bin'))).resolves.toEqual(
      Buffer.from([0xff, 0x00]),
    )
    await expect(
      files.capabilities.packagePublication!.publishPackageIfAbsent({
        rootPath: 'demo',
        files: [{ path: 'SKILL.md', content: new TextEncoder().encode('rival') }],
        expectedRoot: absent.claim,
      }),
    ).resolves.toEqual({ status: 'conflict' })
  })
})

describe('localFs restart-durable strict publication', () => {
  const stagedAbsent = async (root: string, operationId = 'restore-op') => {
    const files = createLocalFsFiles(root)
    const observed = await files.capabilities.resourceObservation!.observe('note.md')

    expect(observed.kind).toBe('absent')
    if (observed.kind !== 'absent') {
      throw new Error('expected an absent target')
    }
    const result = await files.capabilities.strictPublication!.stage({
      operationId,
      binding: 'binding-a',
      path: 'note.md',
      content: new TextEncoder().encode('candidate'),
      expected: observed.claim,
    })

    expect(result).toMatchObject({ status: 'accepted', state: { status: 'staged' } })
    return files
  }

  it('keeps an immutable idempotent stage and revalidates its durable receipt across reopen', async () => {
    const root = await mkroot()
    const files = await stagedAbsent(root)

    await expect(
      createLocalFsFiles(root).capabilities.strictPublication!.inspect('restore-op', 'binding-a'),
    ).resolves.toMatchObject({ status: 'staged', stage: { candidateHash: expect.any(String) } })
    await expect(
      files.capabilities.strictPublication!.stage({
        operationId: 'restore-op',
        binding: 'binding-a',
        path: 'note.md',
        content: new TextEncoder().encode('different'),
        expected: { kind: 'absent', value: 'different' },
      }),
    ).resolves.toEqual({ status: 'idempotency-conflict' })

    const published = await files.capabilities.strictPublication!.publish('restore-op', 'binding-a')

    expect(published).toMatchObject({
      status: 'published',
      receipt: {
        restartDurable: true,
        transitions: [
          {
            path: 'note.md',
            before: expect.objectContaining({ kind: 'absent' }),
            after: expect.objectContaining({ kind: 'present' }),
          },
        ],
      },
    })
    if (published.status !== 'published') {
      throw new Error('expected strict publication')
    }
    await fs.writeFile(join(root, 'note.md'), 'external in-place edit')
    await expect(
      createLocalFsFiles(root).capabilities.strictPublication!.inspect('restore-op', 'binding-a'),
    ).resolves.toMatchObject({
      status: 'failed-recoverable',
      reason: 'published candidate no longer owns the public pathname',
    })
    await expect(
      files.capabilities.strictPublication!.discard('restore-op', 'binding-a'),
    ).resolves.toBe(true)
    await expect(fs.readFile(join(root, 'note.md'), 'utf8')).resolves.toBe('external in-place edit')
  })

  it('rejects a durable receipt after an atomic foreign replacement', async () => {
    const root = await mkroot()
    const files = await stagedAbsent(root, 'replaced-receipt')

    await expect(
      files.capabilities.strictPublication!.publish('replaced-receipt', 'binding-a'),
    ).resolves.toMatchObject({ status: 'published' })
    const foreign = join(root, 'foreign.md')
    await fs.writeFile(foreign, 'candidate')
    await fs.rename(foreign, join(root, 'note.md'))

    await expect(
      createLocalFsFiles(root).capabilities.strictPublication!.inspect(
        'replaced-receipt',
        'binding-a',
      ),
    ).resolves.toMatchObject({
      status: 'failed-recoverable',
      reason: 'published candidate no longer owns the public pathname',
    })
  })

  it('recovers a lost acknowledgement from private publication evidence', async () => {
    const root = await mkroot()
    const files = await stagedAbsent(root, 'lost-ack')
    const realLink = fs.link.bind(fs)

    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (String(target).endsWith('/receipt.json')) {
        throw errno('EIO')
      }

      return realLink(source, target)
    })
    await expect(
      files.capabilities.strictPublication!.publish('lost-ack', 'binding-a'),
    ).rejects.toMatchObject({
      code: 'EIO',
    })
    vi.restoreAllMocks()

    const resumed = await createLocalFsFiles(root).capabilities.strictPublication!.publish(
      'lost-ack',
      'binding-a',
    )

    expect(resumed).toMatchObject({ status: 'published', receipt: { restartDurable: true } })
    await expect(fs.readFile(join(root, 'note.md'), 'utf8')).resolves.toBe('candidate')
  })

  it('replaces a claimed file while preserving its open incarnation as recovery evidence', async () => {
    const root = await mkroot()
    await fs.writeFile(join(root, 'note.md'), 'original')
    const files = createLocalFsFiles(root)
    const observed = await files.capabilities.resourceObservation!.observe('note.md')

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    const openOriginal = await fs.open(join(root, 'note.md'), 'r')

    try {
      await files.capabilities.strictPublication!.stage({
        operationId: 'replace-op',
        binding: 'binding-a',
        path: 'note.md',
        content: new TextEncoder().encode('restored'),
        expected: observed.claim,
      })
      const published = await files.capabilities.strictPublication!.publish(
        'replace-op',
        'binding-a',
      )

      expect(published.status).toBe('published')
      await expect(fs.readFile(join(root, 'note.md'), 'utf8')).resolves.toBe('restored')
      await expect(openOriginal.readFile({ encoding: 'utf8' })).resolves.toBe('original')
      const [stageDir] = await fs.readdir(join(root, '.notarium-fs-ops'))
      await expect(
        fs.readFile(join(root, '.notarium-fs-ops', stageDir!, 'original-snapshot'), 'utf8'),
      ).resolves.toBe('original')
    } finally {
      await openOriginal.close()
    }
  })

  it('never overwrites an external creator after detaching the claimed source', async () => {
    const root = await mkroot()
    await fs.writeFile(join(root, 'note.md'), 'original')
    const files = createLocalFsFiles(root)
    const observed = await files.capabilities.resourceObservation!.observe('note.md')

    expect(observed.kind).toBe('present')
    if (observed.kind !== 'present') {
      return
    }
    await files.capabilities.strictPublication!.stage({
      operationId: 'racing-creator',
      binding: 'binding-a',
      path: 'note.md',
      content: new TextEncoder().encode('restored'),
      expected: observed.claim,
    })
    const realLink = fs.link.bind(fs)

    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (String(source).endsWith('/publication') && String(target) === join(root, 'note.md')) {
        await fs.writeFile(target, 'external', { flag: 'wx' })
      }

      return realLink(source, target)
    })
    const result = await files.capabilities.strictPublication!.publish(
      'racing-creator',
      'binding-a',
    )

    expect(result).toMatchObject({
      status: 'failed-recoverable',
      recoveryPaths: expect.arrayContaining([
        expect.stringContaining('original-snapshot'),
        expect.stringContaining('detached-original'),
      ]),
    })
    await expect(fs.readFile(join(root, 'note.md'), 'utf8')).resolves.toBe('external')
    await expect(
      files.capabilities.strictPublication!.discard('racing-creator', 'binding-a'),
    ).resolves.toBe(false)
  })

  it('quarantines a corrupt stage instead of guessing its recovery state', async () => {
    const root = await mkroot()
    const files = await stagedAbsent(root, 'corrupt-op')
    const [stageDir] = await fs.readdir(join(root, '.notarium-fs-ops'))
    await fs.writeFile(join(root, '.notarium-fs-ops', stageDir!, 'header.json'), '{}')

    await expect(
      files.capabilities.strictPublication!.inspect('corrupt-op', 'binding-a'),
    ).rejects.toMatchObject({ code: 'STRICT_STAGE_CORRUPT' })
    expect(await fs.readdir(join(root, '.notarium-fs-ops'))).toEqual([
      expect.stringMatching(/^quarantine-/),
    ])
  })
})
