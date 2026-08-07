import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLocalFsFiles } from './localFs'

const roots: string[] = []

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
  kind: 'rename' | 'replace',
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
      await files.renameIfAbsent('source.md', ${samePath ? "'source.md'" : "'target.md'"})
    } else {
      await files.replaceIfAbsent(
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
    await createLocalFsFiles(root).scan()
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
      await files.replaceIfAbsent('source.md', 'target.md', 'original', 'final')
    } else {
      await files.renameIfAbsent('source.md', 'target.md')
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

    await Promise.all([files.write('a.md', bodyA), files.write('b.md', bodyB)])

    const claims = open.mock.calls.map(([path, flags]) => [String(path), flags] as const)
    expect(claims).toHaveLength(2)
    expect(new Set(claims.map(([path]) => path))).toHaveLength(2)
    expect(claims.every(([, flags]) => flags === 'wx')).toBe(true)
    await expect(files.read('a.md')).resolves.toBe(bodyA)
    await expect(files.read('b.md')).resolves.toBe(bodyB)
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

    await files.write('note.md', 'safe')

    expect(open).toHaveBeenCalledTimes(2)
    expect(attempted[0]).not.toBe(attempted[1])
    expect(open.mock.calls.every(([, flags]) => flags === 'wx')).toBe(true)
    expect(unlink).not.toHaveBeenCalled()
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('foreign')
    await expect(files.read('note.md')).resolves.toBe('safe')
  })

  it('stops after bounded exclusive-claim collisions without deleting foreign files', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const collision = errno('EEXIST')
    const open = vi.spyOn(fs, 'open').mockRejectedValue(collision)
    const unlink = vi.spyOn(fs, 'unlink')

    await expect(files.write('note.md', 'body')).rejects.toBe(collision)
    expect(open).toHaveBeenCalledTimes(8)
    expect(unlink).not.toHaveBeenCalled()
  })

  it('does not unlink when claiming the temp fails before ownership', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const denied = errno('EACCES')
    vi.spyOn(fs, 'open').mockRejectedValueOnce(denied)
    const unlink = vi.spyOn(fs, 'unlink')

    await expect(files.write('note.md', 'body')).rejects.toBe(denied)
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

    await expect(files.write('note.md', 'body')).rejects.toBe(failure)
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

    await expect(files.write('note.md', 'body')).rejects.toBe(writeFailure)
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

    await expect(files.write('note.md', 'body')).rejects.toBe(failure)
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('cleans its temp after a failed rename and preserves the rename error', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const failure = errno('EIO')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(failure)

    await expect(files.write('note.md', 'body')).rejects.toBe(failure)
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('preserves a rename failure when cleanup of its claimed temp also fails', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const renameFailure = errno('EIO')
    const open = vi.spyOn(fs, 'open')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(renameFailure)
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(errno('EACCES'))

    await expect(files.write('note.md', 'body')).rejects.toBe(renameFailure)
    const claimed = String(open.mock.calls[0]?.[0])
    expect(unlink).toHaveBeenCalledWith(claimed)
    await expect(fs.readFile(claimed, 'utf8')).resolves.toBe('body')
  })
})

describe('localFs remove errors (#262)', () => {
  it('is idempotent only for ENOENT and propagates other unlink failures', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await expect(files.remove('missing.md')).resolves.toBeUndefined()

    const denied = errno('EACCES')
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(denied)
    await expect(files.remove('forbidden.md')).rejects.toBe(denied)
  })
})

describe('localFs pathname occupancy', () => {
  it('returns null for a FIFO without waiting for a writer', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    execFileSync('mkfifo', [join(root, 'pipe.md')])
    await expect(files.read('pipe.md')).resolves.toBeNull()
  })

  it('counts a dangling symlink as occupied', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await fs.symlink('missing.md', join(root, 'claimed.md'))
    await expect(files.exists('claimed.md')).resolves.toBe(true)
  })

  it('publishes complete bytes only once without replacing an occupied pathname', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await expect(
      Promise.all([
        files.writeIfAbsent!('claimed.md', 'first'),
        files.writeIfAbsent!('claimed.md', 'second'),
      ]),
    ).resolves.toEqual(expect.arrayContaining([true, false]))
    await expect(files.read('claimed.md')).resolves.toMatch(/^(first|second)$/)
    expect(await fs.readdir(root)).toEqual(['claimed.md'])

    await fs.unlink(join(root, 'claimed.md'))
    await fs.symlink('missing.md', join(root, 'claimed.md'))
    await expect(files.writeIfAbsent!('claimed.md', 'intruder')).resolves.toBe(false)
    expect((await fs.lstat(join(root, 'claimed.md'))).isSymbolicLink()).toBe(true)
  })

  it('moves onto an absent pathname without replacing a racing create', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await files.write('source.md', 'source')

    const [moved, created] = await Promise.all([
      files.renameIfAbsent!('source.md', 'target.md'),
      files.writeIfAbsent!('target.md', 'rival'),
    ])

    expect([moved, created].filter(Boolean)).toHaveLength(1)
    if (moved) {
      await expect(files.read('target.md')).resolves.toBe('source')
      await expect(files.read('source.md')).resolves.toBeNull()
    } else {
      await expect(files.read('target.md')).resolves.toBe('rival')
      await expect(files.read('source.md')).resolves.toBe('source')
    }
  })

  it('leaves source and destination intact when a no-replace move is occupied', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await files.write('source.md', 'source')
    await files.write('target.md', 'target')

    await expect(files.renameIfAbsent!('source.md', 'target.md')).resolves.toBe(false)
    await expect(files.read('source.md')).resolves.toBe('source')
    await expect(files.read('target.md')).resolves.toBe('target')
  })

  it('rolls back its claimed destination when removing the source fails', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const source = join(root, 'source.md')
    const realRename = fs.rename.bind(fs)
    let injected = false

    await files.write('source.md', 'source')
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(from) === source && String(to).endsWith('/detached-source')) {
        injected = true
        throw errno('EACCES')
      }

      return realRename(from, to)
    })

    await expect(files.renameIfAbsent!('source.md', 'target.md')).rejects.toMatchObject({
      code: 'EACCES',
    })
    await expect(files.read('source.md')).resolves.toBe('source')
    await expect(files.read('target.md')).resolves.toBeNull()
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

    await expect(files.renameIfAbsent!('source.md', 'target.md')).rejects.toMatchObject({
      code: 'ESTALE',
    })
    await expect(files.read('source.md')).resolves.toBe('external-new')
    await expect(files.read('target.md')).resolves.toBeNull()
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
      files.replaceIfAbsent!('source.md', 'target.md', 'source', 'app-final'),
    ).rejects.toMatchObject({ code: 'ESTALE' })
    await expect(files.read('source.md')).resolves.toBe('external-new')
    await expect(files.read('target.md')).resolves.toBe('external-target')
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
      files.replaceIfAbsent!('source.md', 'target.md', 'source', 'app-final'),
    ).rejects.toMatchObject({ code: 'ESTALE' })
    await expect(files.read('source.md')).resolves.toBe('source')
    await expect(files.read('target.md')).resolves.toBe('external-new')
    expect((await fs.readdir(root)).sort()).toEqual(['source.md', 'target.md'])
  })

  it('publishes final bytes when source and destination are the same medium entry', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    await fs.writeFile(join(root, 'source.md'), 'source')

    await expect(
      files.replaceIfAbsent!('source.md', 'source.md', 'source', 'app-final'),
    ).resolves.toBe(true)
    await expect(files.read('source.md')).resolves.toBe('app-final')
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

    await expect(files.renameIfAbsent!('source.md', 'target.md')).resolves.toBe(true)
    const after = await fs.stat(join(root, 'target.md'), { bigint: true })

    expect(after.ino).toBe(before.ino)
    expect(after.mode & 0o777n).toBe(0o600n)
    expect(after.mtimeNs).toBe(before.mtimeNs)
  })

  it('finishes a pure rename after the process stops between publication and detach', async () => {
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
    await expect(recovered.scan()).resolves.toEqual([
      expect.objectContaining({ path: 'target.md' }),
    ])
    await expect(recovered.read('source.md')).resolves.toBeNull()
    await expect(recovered.read('target.md')).resolves.toBe('source')
    expect((await fs.stat(target, { bigint: true })).ino).toBe(before.ino)
    expect(await fs.readdir(root)).toEqual(['target.md'])
  })

  it('restarts recovery itself after a second process stops during source detach', async () => {
    const root = await mkroot()

    await fs.writeFile(join(root, 'source.md'), 'source')
    crashMove(root, 'rename', 'after-publication')
    crashRecoveryAfterDetach(root)

    const recovered = createLocalFsFiles(root)
    await expect(recovered.read('source.md')).resolves.toBeNull()
    await expect(recovered.read('target.md')).resolves.toBe('source')
    expect(await fs.readdir(root)).toEqual(['target.md'])
  })

  it('finishes a replace after the process stops with final target and live source', async () => {
    const root = await mkroot()

    await fs.writeFile(join(root, 'source.md'), 'source')
    crashMove(root, 'replace', 'after-publication')

    const recovered = createLocalFsFiles(root)
    await expect(recovered.read('target.md')).resolves.toBe('app-final')
    await expect(recovered.read('source.md')).resolves.toBeNull()
    expect(await fs.readdir(root)).toEqual(['target.md'])
  })

  it('rolls back a prepared operation stopped before target publication', async () => {
    const root = await mkroot()

    await fs.writeFile(join(root, 'source.md'), 'source')
    crashMove(root, 'replace', 'before-publication')

    const recovered = createLocalFsFiles(root)
    await expect(recovered.read('source.md')).resolves.toBe('source')
    await expect(recovered.read('target.md')).resolves.toBeNull()
    expect(await fs.readdir(root)).toEqual(['source.md'])
  })

  it('rolls forward a same-path replace stopped in the hidden-only window', async () => {
    const root = await mkroot()

    await fs.writeFile(join(root, 'source.md'), 'source')
    crashMove(root, 'replace', 'after-detach', true)
    await expect(fs.lstat(join(root, 'source.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    const recovered = createLocalFsFiles(root)
    await expect(recovered.read('source.md')).resolves.toBe('app-final')
    expect(await fs.readdir(root)).toEqual(['source.md'])
  })

  it('preserves a foreign target that replaces an interrupted publication', async () => {
    const root = await mkroot()
    const target = join(root, 'target.md')

    await fs.writeFile(join(root, 'source.md'), 'source')
    crashMove(root, 'replace', 'after-publication')
    await fs.writeFile(join(root, 'external.md'), 'external-target')
    await fs.rename(join(root, 'external.md'), target)

    const recovered = createLocalFsFiles(root)
    await recovered.scan()
    await expect(recovered.read('source.md')).resolves.toBe('source')
    await expect(recovered.read('target.md')).resolves.toBe('external-target')
    expect((await fs.readdir(root)).sort()).toEqual(['source.md', 'target.md'])
  })

  it('surfaces original bytes when a foreign source replaces an interrupted move', async () => {
    const root = await mkroot()
    const source = join(root, 'source.md')

    await fs.writeFile(source, 'source')
    crashMove(root, 'replace', 'after-publication')
    await fs.writeFile(join(root, 'external.md'), 'external-source')
    await fs.rename(join(root, 'external.md'), source)

    const recovered = createLocalFsFiles(root)
    await recovered.scan()
    const entries = (await fs.readdir(root)).sort()
    const recovery = entries.find((entry) => entry.startsWith('source.recovered-'))

    await expect(recovered.read('source.md')).resolves.toBe('external-source')
    await expect(recovered.read('target.md')).resolves.toBeNull()
    expect(recovery).toBeDefined()
    await expect(fs.readFile(join(root, recovery!), 'utf8')).resolves.toBe('source')
    expect(entries).not.toContain('.notarium-fs-ops')
  })

  it('preserves a foreign source captured into the journal when recovery restarts', async () => {
    const root = await mkroot()

    crashAfterCapturingForeign(root, 'detached-source')

    await expect(createLocalFsFiles(root).scan()).resolves.toEqual(expect.any(Array))
    // A second adapter must observe a fully converged namespace, not depend on
    // process-local recovery state left by the first pass.
    await expect(createLocalFsFiles(root).scan()).resolves.toEqual(expect.any(Array))
    await expect(fs.readFile(join(root, 'source.md'), 'utf8')).resolves.toBe('FOREIGN-SOURCE')
    await expect(fs.lstat(join(root, 'target.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    const entries = (await fs.readdir(root)).sort()
    const recovery = entries.find((entry) => entry.startsWith('source.recovered-'))

    expect(recovery).toBeDefined()
    await expect(fs.readFile(join(root, recovery!), 'utf8')).resolves.toBe('original')
    expect(entries).not.toContain('.notarium-fs-ops')
  })

  it('restores a foreign target captured into the journal and converges across restarts', async () => {
    const root = await mkroot()

    crashAfterCapturingForeign(root, 'detached-target')

    await expect(createLocalFsFiles(root).scan()).resolves.toEqual(expect.any(Array))
    await expect(createLocalFsFiles(root).scan()).resolves.toEqual(expect.any(Array))
    await expect(fs.readFile(join(root, 'source.md'), 'utf8')).resolves.toBe('original')
    await expect(fs.readFile(join(root, 'target.md'), 'utf8')).resolves.toBe('FOREIGN-TARGET')
    expect(await fs.readdir(root)).toEqual(['source.md', 'target.md'])
  })

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

    const move = first.replaceIfAbsent!('source.md', 'target.md', 'original', 'final').then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await published
    const peer = second.write('peer.md', 'peer')
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

    await expect(createLocalFsFiles(root).scan()).rejects.toThrow(
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
      files.replaceIfAbsent!('source.md', 'target.md', 'source', 'app-final'),
    ).resolves.toBe(true)
    await expect(files.read('source.md')).resolves.toBeNull()
    await expect(files.read('target.md')).resolves.toBe('app-final')
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
      files.replaceIfAbsent!('source.md', 'source.md', 'source', 'app-final'),
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
      files.replaceIfAbsent!('source.md', 'target.md', 'source', 'app-final'),
    ).rejects.toMatchObject({ code: 'EACCES' })
    await expect(files.read('source.md')).resolves.toBe('source')
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

    await expect(files.removeIfUnchanged!('source.md', 'source')).resolves.toBe(false)
    await expect(files.read('source.md')).resolves.toBe('external-new')
    expect(await fs.readdir(root)).toEqual(['source.md'])
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

    await expect(files.removeIfUnchanged!(leaf, 'original')).resolves.toBe(false)
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

    await expect(files.removeIfUnchanged!('source.md', 'source')).resolves.toBe(false)
    await expect(files.read('moved.md')).resolves.toBe('source')
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

    await expect(files.removeIfUnchanged!('source.md', 'source')).resolves.toBe(false)
    expect(await fs.readdir(root)).toEqual([])
  })

  it('moves a directory only when the destination pathname is absent', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'note.md'), 'source')
    await expect(files.renameDirIfAbsent!('source', 'target')).resolves.toBe(true)
    await expect(fs.readFile(join(root, 'target', 'note.md'), 'utf8')).resolves.toBe('source')
    await expect(fs.lstat(join(root, 'source'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts a directory destination that is the exact same pathname entry', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'note.md'), 'source')
    await expect(files.renameDirIfAbsent!('source', 'source')).resolves.toBe(true)
    await expect(fs.readFile(join(root, 'source', 'note.md'), 'utf8')).resolves.toBe('source')
  })

  it('does not replace an occupied directory destination', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await fs.mkdir(join(root, 'source'))
    await fs.mkdir(join(root, 'target'))
    await fs.writeFile(join(root, 'source', 'source.md'), 'source')
    await fs.writeFile(join(root, 'target', 'target.md'), 'target')
    await expect(files.renameDirIfAbsent!('source', 'target')).resolves.toBe(false)
    await expect(fs.readFile(join(root, 'source', 'source.md'), 'utf8')).resolves.toBe('source')
    await expect(fs.readFile(join(root, 'target', 'target.md'), 'utf8')).resolves.toBe('target')
  })

  it('fails closed instead of copying a directory across filesystems', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const root = await mkroot()
    let externalRoot: string

    try {
      externalRoot = await fs.mkdtemp('/dev/shm/notarium-dir-noreplace-')
    } catch {
      return
    }
    roots.push(externalRoot)
    if ((await fs.stat(root)).dev === (await fs.stat(externalRoot)).dev) {
      return
    }
    const files = createLocalFsFiles(root)
    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'source.md'), 'source')
    await fs.symlink(externalRoot, join(root, 'other-fs'))

    await expect(files.renameDirIfAbsent!('source', 'other-fs/target')).rejects.toMatchObject({
      code: 'ENOTSUP',
    })
    await expect(fs.readFile(join(root, 'source', 'source.md'), 'utf8')).resolves.toBe('source')
    await expect(fs.lstat(join(externalRoot, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when the runtime has no direct renameat2 syscall mapping', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)
    const actualArch = process.arch
    await fs.mkdir(join(root, 'source'))
    await fs.writeFile(join(root, 'source', 'source.md'), 'source')

    Object.defineProperty(process, 'arch', { configurable: true, value: 'unsupported-audit-arch' })
    try {
      await expect(files.renameDirIfAbsent!('source', 'target')).rejects.toMatchObject({
        code: 'ENOTSUP',
      })
    } finally {
      Object.defineProperty(process, 'arch', { configurable: true, value: actualArch })
    }

    await expect(fs.readFile(join(root, 'source', 'source.md'), 'utf8')).resolves.toBe('source')
    await expect(fs.lstat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets exactly one racing directory move claim an absent destination', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    for (const source of ['left', 'right']) {
      await fs.mkdir(join(root, source))
      await fs.writeFile(join(root, source, 'winner.md'), source)
    }
    const results = await Promise.all([
      files.renameDirIfAbsent!('left', 'target'),
      files.renameDirIfAbsent!('right', 'target'),
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

    await expect(files.makeDir('Café')).resolves.toBe(true)
    await expect(files.makeDir('Café')).resolves.toBe(false)
    await expect(files.makeDir('Cafe\u0301')).resolves.toBe(true)
    await expect(files.listDirs()).resolves.toEqual(expect.arrayContaining(['Café', 'Cafe\u0301']))
  })

  it('distinguishes one pathname entry from a hardlink and a symlink to it', async () => {
    const root = await mkroot()
    const files = createLocalFsFiles(root)

    await files.write('source.md', 'body')
    await fs.link(join(root, 'source.md'), join(root, 'same-entry.md'))
    await fs.symlink('source.md', join(root, 'symlink.md'))

    await expect(files.sameEntry!('source.md', 'source.md')).resolves.toBe(true)
    await expect(files.sameEntry!('source.md', 'same-entry.md')).resolves.toBe(false)
    await expect(files.sameEntry!('source.md', 'symlink.md')).resolves.toBe(false)
  })
})
