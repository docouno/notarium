import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { applySeedExternalRewrites } from '../../scripts/seedExternalRewrites'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('applySeedExternalRewrites', () => {
  it('changes bytes while preserving size and mtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notarium-seed-rewrite-'))
    roots.push(dir)
    const filePath = join(dir, 'probe.md')
    await writeFile(filePath, 'stale-token links [[Target A]]', 'utf8')
    const before = await stat(filePath)

    await applySeedExternalRewrites([
      {
        filePath,
        note: 'probe',
        replacements: [
          { from: 'stale-token', to: 'fresh-token' },
          { from: '[[Target A]]', to: '[[Target B]]' },
        ],
      },
    ])

    const after = await stat(filePath)
    expect(await readFile(filePath, 'utf8')).toBe('fresh-token links [[Target B]]')
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)
    expect(after.ctimeMs).not.toBe(before.ctimeMs)
  })

  it('rejects replacements that do not preserve UTF-8 byte length', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notarium-seed-rewrite-'))
    roots.push(dir)
    const filePath = join(dir, 'probe.md')
    await writeFile(filePath, 'short', 'utf8')

    await expect(
      applySeedExternalRewrites([
        { filePath, note: 'probe', replacements: [{ from: 'short', to: 'longer' }] },
      ]),
    ).rejects.toThrow('changes replacement byte length')
  })
})
