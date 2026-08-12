import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { applySeedExternalRewrites, identityClaimRewrite } from '../../scripts/seedExternalRewrites'

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

  it('writes the OWNER’s id into the CLAIMANT’s file, never the other way round', async () => {
    const ids = new Map([
      ['copy', 'claimant0001'],
      ['original', 'owner0000001'],
    ])
    const rewrite = identityClaimRewrite({ note: 'copy', claimFrom: 'original' }, (handle) =>
      ids.get(handle),
    )

    // The seeded collision IS this direction: the copy's file starts naming the
    // original's id. Flip the pair and the applier searches for an id the file never
    // held — nothing is planted, and the stand reproduces no collision at all.
    expect(rewrite).toEqual({
      note: 'copy',
      replacements: [{ from: 'claimant0001', to: 'owner0000001' }],
    })
    expect(() =>
      identityClaimRewrite({ note: 'copy', claimFrom: 'ghost' }, (h) => ids.get(h)),
    ).toThrow('unknown note')
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
