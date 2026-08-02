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
