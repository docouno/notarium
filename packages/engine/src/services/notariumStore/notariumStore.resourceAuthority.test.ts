import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DOCUMENT_ROLE, sha256Hex, STORAGE_OWNER_KEY } from '@notarium/core'
import { createNotariumStore } from './createNotariumStore'

const roots: string[] = []

const mkroot = async (): Promise<string> => {
  const root = await fs.mkdtemp(join(tmpdir(), 'notarium-receipt-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('NotariumStore resource authority', () => {
  it('binds single-note move/remove to the exact read incarnation and owner', async () => {
    const root = await mkroot()
    const store = createNotariumStore({ notesDir: root, spaceId: 'space-a' })

    try {
      const created = await store.write({ title: 'Owned', content: 'body', id: 'stable-id' })
      const exact = await store.read(created.filePath!)

      expect(exact.physicalIncarnation).toMatchObject({
        claim: { kind: 'resource-observation-v1' },
        owner: { kind: 'claimed', id: 'stable-id' },
      })
      const moved = await store.move({
        id: created.filePath!,
        destinationPath: 'archive/owned.md',
        expectedSource: exact.physicalIncarnation,
      })
      expect(moved).toMatchObject({
        id: 'stable-id',
        filePath: 'archive/owned.md',
      })

      const stale = await store.read('archive/owned.md')
      const path = join(root, 'archive', 'owned.md')
      const bytes = await fs.readFile(path)
      await fs.unlink(path)
      await fs.writeFile(path, bytes)

      await expect(
        store.move({
          id: 'archive/owned.md',
          destinationPath: 'moved-again.md',
          expectedSource: stale.physicalIncarnation,
        }),
      ).rejects.toThrow('source changed during move')
      await expect(fs.readFile(path, 'utf8')).resolves.toContain('body')
      await expect(fs.stat(join(root, 'moved-again.md'))).rejects.toMatchObject({ code: 'ENOENT' })

      await expect(
        store.remove('archive/owned.md', { expectedSource: stale.physicalIncarnation }),
      ).rejects.toThrow('note physical incarnation changed during delete')
      await expect(fs.readFile(path, 'utf8')).resolves.toContain('body')
    } finally {
      await store.stop()
    }
  })

  it('returns a receipt and binds an injected identity only after publication', async () => {
    const root = await mkroot()
    const store = createNotariumStore({ notesDir: root, spaceId: 'space-a' })

    try {
      const result = await store.write({
        title: 'Owned',
        content: 'body',
        id: 'stable-id',
      })
      const detail = await store.read(result.filePath!)
      const receipt = (result.result as { mutationReceipt?: { id: string; spaceId: string } })
        .mutationReceipt

      expect(receipt).toMatchObject({ spaceId: 'space-a' })
      expect(detail.documentState?.provenance.claims).toEqual([
        expect.objectContaining({
          key: STORAGE_OWNER_KEY.id,
          ownership: 'entry',
          evidence: { kind: 'mutation-receipt', id: receipt?.id },
        }),
      ])
      expect(detail.versionToken).toBe(result.versionToken)
    } finally {
      await store.stop()
    }
  })

  it('compensates only the exact physical incarnation returned by write', async () => {
    const root = await mkroot()
    const store = createNotariumStore({ notesDir: root, spaceId: 'space-a' })

    try {
      const first = await store.write({ title: 'Owned', content: 'same', id: 'stable-id' })
      const path = join(root, first.filePath!)
      const foreignBytes = await fs.readFile(path)

      await fs.unlink(path)
      await fs.writeFile(path, foreignBytes)
      await expect(
        store.remove(first.filePath!, {
          versionToken: first.versionToken,
          physicalWriteClaim: first.physicalWriteClaim,
        }),
      ).rejects.toThrow('note physical incarnation changed during delete')
      await expect(fs.readFile(path, 'utf8')).resolves.toContain('same')

      const second = await store.write({
        originalId: first.filePath,
        title: 'Owned',
        content: 'same',
        versionToken: first.versionToken,
      })
      const external = join(root, '.same-byte-foreign')
      const secondBytes = await fs.readFile(path)
      const realRename = fs.rename.bind(fs)
      let injected = false

      await fs.writeFile(external, secondBytes)
      const externalInode = (await fs.stat(external, { bigint: true })).ino
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (!injected && String(from) === path && String(to).includes('.notarium-move-')) {
          injected = true
          await realRename(external, path)
        }

        return realRename(from, to)
      })
      await expect(
        store.remove(second.filePath!, {
          versionToken: second.versionToken,
          physicalWriteClaim: second.physicalWriteClaim,
        }),
      ).rejects.toThrow('note physical incarnation changed during delete')
      expect(injected).toBe(true)
      expect((await fs.stat(path, { bigint: true })).ino).toBe(externalInode)
      vi.restoreAllMocks()

      const third = await store.write({
        originalId: second.filePath,
        title: 'Owned',
        content: 'same',
        versionToken: second.versionToken,
      })
      await store.remove(third.filePath!, {
        versionToken: third.versionToken,
        physicalWriteClaim: third.physicalWriteClaim,
      })
      await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await store.stop()
    }
  })

  it('persists proof by exact source hash and drops to authored after an external edit', async () => {
    const root = await mkroot()
    const indexDb = join(root, '.index.db')
    let store = createNotariumStore({ notesDir: root, indexDb, spaceId: 'space-a' })
    const result = await store.write({ title: 'Owned', content: 'body', id: 'stable-id' })
    await store.stop()

    store = createNotariumStore({ notesDir: root, indexDb, spaceId: 'space-a' })
    try {
      const restarted = await store.read(result.filePath!)
      expect(restarted.documentState?.provenance.claims).toHaveLength(1)

      const path = join(root, result.filePath!)
      const raw = await fs.readFile(path, 'utf8')
      await fs.writeFile(path, raw.replace('stable-id', 'external-id'))
      const external = await store.read(result.filePath!)

      expect(external.documentState?.provenance.claims).toEqual([])
      expect(external.documentState?.projection?.frontmatter).not.toHaveProperty('notarium-id')
    } finally {
      await store.stop()
    }
  })

  it('fails closed when persisted owner evidence has an unknown kind', async () => {
    const root = await mkroot()
    const indexDb = join(root, '.index.db')
    let store = createNotariumStore({ notesDir: root, indexDb, spaceId: 'space-a' })
    const result = await store.write({ title: 'Owned', content: 'body', id: 'stable-id' })
    const before = await store.read(result.filePath!)
    await store.stop()

    const path = join(root, result.filePath!)
    const changed = (await fs.readFile(path, 'utf8')).replace('stable-id', 'author-id')
    await fs.writeFile(path, changed)
    const db = new DatabaseSync(indexDb)
    const row = db.prepare('SELECT proof_json FROM document_proofs LIMIT 1').get() as {
      proof_json: string
    }
    const proof = JSON.parse(row.proof_json) as {
      claims: Array<{ evidence: { kind: string } }>
    }
    proof.claims[0].evidence.kind = 'fabricated-proof'
    db.prepare('UPDATE document_proofs SET source_hash = ?, proof_json = ?').run(
      await sha256Hex(changed),
      JSON.stringify(proof),
    )
    db.close()

    store = createNotariumStore({ notesDir: root, indexDb, spaceId: 'space-a' })
    try {
      const after = await store.read(result.filePath!)

      expect(after.versionToken).not.toBe(before.versionToken)
      expect(after.documentState?.provenance.claims).toEqual([])
    } finally {
      await store.stop()
    }
  })

  it('carries a proven owner through a later body-only mutation', async () => {
    const root = await mkroot()
    const store = createNotariumStore({ notesDir: root })

    try {
      const created = await store.write({ title: 'Owned', content: 'before', id: 'stable-id' })
      const updated = await store.write({
        originalId: created.filePath,
        title: 'Owned',
        content: 'after',
      })
      const detail = await store.read(updated.filePath!)

      expect(detail.documentState?.provenance.claims).toEqual([
        expect.objectContaining({
          key: STORAGE_OWNER_KEY.id,
          evidence: expect.objectContaining({ kind: 'mutation-receipt' }),
        }),
      ])
    } finally {
      await store.stop()
    }
  })

  it('classifies an auxiliary only against a stable valid package root', async () => {
    const root = await mkroot()
    const skillRoot = join(root, '.notarium', 'skills')
    await fs.mkdir(join(skillRoot, 'demo'), { recursive: true })
    await fs.writeFile(
      join(skillRoot, 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo role\n---\n\nInstructions',
    )
    await fs.writeFile(join(skillRoot, 'demo', 'reference.md'), '# Reference\n')
    await fs.mkdir(join(skillRoot, 'demo', 'references'), { recursive: true })
    await fs.writeFile(join(skillRoot, 'demo', 'references', 'SKILL.md'), '# Nested reference\n')
    const store = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir: root, prefix: '' },
        { class: 'skill', dir: skillRoot, prefix: '.notarium/skills' },
      ],
    })

    try {
      await store.list()
      const valid = await store.read('.notarium/skills/demo/reference.md')
      expect(valid.documentState?.role).toBe(DOCUMENT_ROLE.skillAuxiliary)
      const nestedSkillName = await store.read('.notarium/skills/demo/references/SKILL.md')
      expect(nestedSkillName.documentState?.role).toBe(DOCUMENT_ROLE.skillAuxiliary)

      await fs.writeFile(join(skillRoot, 'demo', 'SKILL.md'), '# no manifest')
      const invalid = await store.read('.notarium/skills/demo/reference.md')
      expect(invalid.documentState?.role).toBe(DOCUMENT_ROLE.generic)
    } finally {
      await store.stop()
    }
  })

  it('returns the same token that an orphan skill auxiliary reads back', async () => {
    const root = await mkroot()
    const skillRoot = join(root, '.notarium', 'skills')
    await fs.mkdir(skillRoot, { recursive: true })
    const store = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir: root, prefix: '' },
        { class: 'skill', dir: skillRoot, prefix: '.notarium/skills' },
      ],
    })

    try {
      const written = await store.write({
        title: 'Helper',
        content: 'orphan helper',
        directory: 'demo',
        targetClass: 'skill',
      })
      const read = await store.read(written.filePath!)

      expect(read.documentState?.role).toBe(DOCUMENT_ROLE.generic)
      expect(written.versionToken).toBe(read.versionToken)
    } finally {
      await store.stop()
    }
  })
})
