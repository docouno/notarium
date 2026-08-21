// Grooming health (#100 phase 5) over the REAL engine — the SQL-backed graph derivation
// with a provenance pass, exercised end to end (including Cyrillic, the slug axis the
// e2e fake historically diverged on). Asserts that after a note rename an inbound
// [[Old Title]] is COUNTED as resolved through a former name, and that an unresolved
// link surfaces as a broken (ghost) link — the two facets the dashboard card shows.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLocalFsFiles } from '../../libs/files'
import { createNodeSqliteDriver } from '../../libs/sql'
import { NotariumStore } from './notariumStore'
import { type EngineMount, engineMountOf } from './types'

const userMount = (dir: string): EngineMount =>
  engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(dir))

describe('NotariumStore graphHealth (#100 phase 5)', () => {
  let notesDir: string
  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), 'notarium-health-'))
  })
  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true })
  })

  it('counts a rename-aliased inbound link and surfaces a ghost — Cyrillic', async () => {
    const sql = createNodeSqliteDriver(':memory:')
    const store = new NotariumStore({ mounts: [userMount(notesDir)], sql })

    try {
      // A target note + a hub linking to it by name AND to a non-existent note. The
      // bare engine has no identity registry — node ids ARE storage paths, so address
      // the rename by filePath (the path channel resolveRow accepts).
      const target = await store.write({ title: 'Спутник', content: 'спутник Земли' })
      const targetPath = target.filePath!
      await store.write({ title: 'Хаб', content: 'смотри [[Спутник]] и [[Нигде]]' })

      // Pristine: nothing renamed yet → no stale resolutions; the dangling link is a ghost.
      const before = await store.graphHealth()
      expect(before.staleNamed).toBe(0)
      expect(before.via).toEqual({ slug: 0, noteAlias: 0, folderAlias: 0 })
      const missing = before.ghosts.find((g) => g.title === 'Нигде' || g.target === 'nigde')
      expect(missing).toBeTruthy()
      expect(missing!.refCount).toBe(1)

      // Rename Спутник → Орбита: the old title joins the alias history (#100 phase 0), so the
      // hub's [[Спутник]] now resolves through a former name.
      const read = await store.read(targetPath)
      await store.write({
        title: 'Орбита',
        content: read.content,
        originalId: targetPath,
        versionToken: read.versionToken,
      })

      const after = await store.graphHealth()
      expect(after.via.noteAlias).toBeGreaterThanOrEqual(1)
      expect(after.staleNamed).toBeGreaterThanOrEqual(1)
      const edge = after.edges.find((e) => e.via === 'note-alias')
      expect(edge).toBeTruthy()
      expect(edge!.target.title).toBe('Орбита') // resolves to the renamed note, by its current title
    } finally {
      await store.stop()
    }
  })
})
