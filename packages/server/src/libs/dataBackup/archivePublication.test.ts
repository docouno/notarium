import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { publishArchive } from './archivePublication'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const paths = async (): Promise<{ partial: string; final: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-publication-'))
  roots.push(root)
  const partial = join(root, 'backup.partial')
  const final = join(root, 'backup.zip')
  await writeFile(partial, 'complete archive')
  return { partial, final }
}

describe('archive publication', () => {
  it('commits at link and retains the recovery partial when publication fsync fails', async () => {
    const { partial, final } = await paths()
    let syncs = 0
    const warnings: string[] = []

    await expect(
      publishArchive(partial, final, {
        syncDirectory: async () => {
          syncs++
          if (syncs === 2) {
            throw new Error('injected fsync failure')
          }
        },
        warn: (message) => warnings.push(message),
      }),
    ).resolves.toBe(Buffer.byteLength('complete archive'))
    await expect(readFile(final, 'utf8')).resolves.toBe('complete archive')
    await expect(readFile(partial, 'utf8')).resolves.toBe('complete archive')
    expect(warnings).toEqual([expect.stringContaining('retaining recovery partial')])
  })

  it('keeps the durable final successful when cleanup fsync fails after partial unlink', async () => {
    const { partial, final } = await paths()
    let syncs = 0
    const warnings: string[] = []

    await expect(
      publishArchive(partial, final, {
        syncDirectory: async () => {
          syncs++
          if (syncs === 3) {
            throw new Error('injected cleanup fsync failure')
          }
        },
        warn: (message) => warnings.push(message),
      }),
    ).resolves.toBe(Buffer.byteLength('complete archive'))
    expect(syncs).toBe(3)
    await expect(readFile(final, 'utf8')).resolves.toBe('complete archive')
    await expect(stat(partial)).rejects.toThrow(/ENOENT/)
    expect(warnings).toEqual([expect.stringContaining('cleanup could not be synced')])
  })

  it('preserves a pre-existing final and rejects before the commit point', async () => {
    const { partial, final } = await paths()
    await writeFile(final, 'operator archive')

    await expect(publishArchive(partial, final)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(readFile(final, 'utf8')).resolves.toBe('operator archive')
    await expect(readFile(partial, 'utf8')).resolves.toBe('complete archive')
  })
})
