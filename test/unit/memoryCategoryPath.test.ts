import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CachedStore,
  InMemoryRevisionPersistence,
  READ_SCOPE,
  rememberAboutUser,
} from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })))

// The find-or-append convergence for agent-memory rests on two racing writers aiming
// at ONE path, so a category's file name is pinned to the category (#296). This runs on
// the PRODUCTION composition rather than the memory fixture: the fixture is a model, and
// a pin that held for exactly one write looked correct in it until the model was fixed.
describe('memory category on the production stack', () => {
  it('keeps the pinned path across create AND append', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mem-real-'))
    roots.push(root)
    const inner = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir: root, prefix: '' },
        { class: 'agent-memory', dir: join(root, '.notarium/memory'), prefix: '.notarium/memory' },
      ],
      integritySweepBatchSize: 0,
    })
    const store = new CachedStore({
      inner,
      revisionPersistence: new InMemoryRevisionPersistence(),
      pollIntervalMs: 0,
    })
    await store.start()
    try {
      await rememberAboutUser(store, { category: '🎉', observation: 'first' })
      const afterCreate = (await store.list({ scope: READ_SCOPE.agentRecall }))[0].filePath
      await rememberAboutUser(store, { category: '🎉', observation: 'second' })
      const notes = await store.list({ scope: READ_SCOPE.agentRecall })
      expect(notes).toHaveLength(1)
      expect(notes[0].filePath).toBe(afterCreate)
      expect(afterCreate).toMatch(/category-[a-f0-9]{24}\.md$/)
    } finally {
      await store.stop()
    }
  })

  it('writes a very long category instead of failing ENAMETOOLONG', async () => {
    // The name formula never byte-clips an explicit fileName, so pinning one makes THIS
    // the caller that owns the length. A category in a script the name axis keeps costs
    // three bytes a letter; unclipped it exceeded the path component and no memory was
    // recorded at all — a hard failure where the pre-branch code still wrote something.
    const root = mkdtempSync(join(tmpdir(), 'mem-long-'))
    roots.push(root)
    const inner = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir: root, prefix: '' },
        { class: 'agent-memory', dir: join(root, '.notarium/memory'), prefix: '.notarium/memory' },
      ],
      integritySweepBatchSize: 0,
    })
    const store = new CachedStore({
      inner,
      revisionPersistence: new InMemoryRevisionPersistence(),
      pollIntervalMs: 0,
    })
    await store.start()
    try {
      const long = '关'.repeat(120)
      await rememberAboutUser(store, { category: long, observation: 'first' })
      await rememberAboutUser(store, { category: long, observation: 'second' })
      const notes = await store.list({ scope: READ_SCOPE.agentRecall })

      expect(notes).toHaveLength(1)
      expect(
        new TextEncoder().encode(notes[0].filePath.split('/').pop()).length,
      ).toBeLessThanOrEqual(255)
      expect((await store.read(notes[0].id!)).content).toContain('second')
    } finally {
      await store.stop()
    }
  })
})
