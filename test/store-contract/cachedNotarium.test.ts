// The production dual-run composition (#69): CachedStore over the Notarium
// engine — the exact stack a notarium-engine space serves from. The decorator
// equips the bare engine with identity/CAS/journal, so the full spec including
// the optimistic-write scenarios runs here.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CachedStore, InMemoryRevisionPersistence } from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'

import { describeKnowledgeStoreContract } from './storeContract'

describeKnowledgeStoreContract('CachedStore(NotariumStore)', async () => {
  const notesDir = mkdtempSync(join(tmpdir(), 'notarium-engine-cached-'))
  // Two typed mounts (#78): the production stack a notarium space serves from,
  // with the hidden agent-memory mount the class/visibility spec exercises.
  const inner = createNotariumStore({
    mounts: [
      { class: 'user-doc', dir: notesDir, prefix: '' },
      {
        class: 'agent-memory',
        dir: join(notesDir, '.notarium/memory'),
        prefix: '.notarium/memory',
      },
      {
        class: 'profile',
        dir: join(notesDir, '.notarium/profile'),
        prefix: '.notarium/profile',
      },
      {
        class: 'skill',
        dir: join(notesDir, '.notarium/skills'),
        prefix: '.notarium/skills',
      },
    ],
  })
  const store = new CachedStore({ inner, pollIntervalMs: 0 })
  await store.start()
  return {
    store,
    directory: 'contract-spec',
    teardown: async () => {
      store.stop()
      await store.settle() // let the engine's index handle close before we rm
      rmSync(notesDir, { recursive: true, force: true })
    },
  }
})

describe('CachedStore(NotariumStore) trash restore/purge ordering', () => {
  it('reattaches a single-file package when its required delete tombstone cannot append', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-engine-required-delete-'))
    const packageId = 'RequiredTrash_1'
    const persistence = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner: createNotariumStore({
        mounts: [
          { class: 'user-doc', dir: notesDir, prefix: '' },
          {
            class: 'skill',
            dir: join(notesDir, '.notarium/skills'),
            prefix: '.notarium/skills',
          },
        ],
      }),
      revisionPersistence: persistence,
      space: 'main',
      pollIntervalMs: 0,
    })

    try {
      await store.start()
      const created = await store.write({
        id: packageId,
        title: 'Required Trash',
        content: '# Required Trash\n\nKeep me.\n',
        restorePath: `.notarium/skills/${packageId}/SKILL.md`,
        targetClass: 'skill',
        frontmatter: [
          { key: 'name', lines: ['name: required-trash'] },
          { key: 'description', lines: ['description: Required Trash.'] },
        ],
      })
      await store.settle()
      const live = await store.read(created.id!)
      const packagePath = live.filePath!.slice(0, live.filePath!.lastIndexOf('/'))
      const packageDir = join(notesDir, packagePath)
      const append = persistence.append.bind(persistence)

      persistence.append = async (revision, content) => {
        if (revision.kind === 'delete') {
          throw new Error('injected required tombstone outage')
        }

        return append(revision, content)
      }

      await expect(
        store.removeDir?.(packagePath, {
          internalAddress: true,
          principal: 'pat:alice:write',
          requiredRevision: true,
          beforeDetach: (victimNoteIds) => {
            expect(victimNoteIds).toEqual([created.id])
          },
        }),
      ).rejects.toThrow('injected required tombstone outage')
      expect(existsSync(join(packageDir, 'SKILL.md'))).toBe(true)
      await expect(store.read(created.id!)).resolves.toMatchObject({
        id: created.id,
        filePath: live.filePath,
      })
      expect((await persistence.latestFor('main', created.id!))?.kind).not.toBe('delete')
    } finally {
      store.stop()
      await store.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('conditionally removes a physical restore when permanent purge wins', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-engine-restore-purge-'))
    const restoreInner = createNotariumStore({ notesDir })
    const purgeInner = createNotariumStore({ notesDir })
    const persistence = new InMemoryRevisionPersistence()
    const createStore = (inner: ReturnType<typeof createNotariumStore>) =>
      new CachedStore({
        inner,
        revisionPersistence: persistence,
        space: 'main',
        pollIntervalMs: 0,
      })
    const restoreStore = createStore(restoreInner)
    const purgeStore = createStore(purgeInner)
    let release!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    try {
      await restoreStore.start()
      await purgeStore.start()
      const created = await restoreStore.write({
        title: 'Race target',
        content: 'must not survive purge',
      })
      await restoreStore.settle()
      await restoreStore.remove(created.id!)
      await restoreStore.settle()
      const append = persistence.append.bind(persistence)

      persistence.append = async (revision, content) => {
        if (revision.kind === 'restore') {
          markEntered()
          await gate
        }

        return append(revision, content)
      }

      const restoring = restoreStore.restoreFromTrash!(created.id!)
      await entered
      await expect(purgeStore.purgeTrash!({ ids: [created.id!] })).resolves.toEqual({ purged: 1 })
      release()
      await expect(restoring).rejects.toThrow(/revision target was permanently purged/)
      expect(existsSync(join(notesDir, 'race-target.md'))).toBe(false)
      expect((await restoreStore.list()).some((note) => note.title === 'Race target')).toBe(false)
    } finally {
      release?.()
      restoreStore.stop()
      purgeStore.stop()
      await Promise.all([restoreStore.settle(), purgeStore.settle()])
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('keeps a committed physical restore when later identity publication fails', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-engine-restore-publish-'))
    const inner = createNotariumStore({ notesDir })
    const persistence = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner,
      revisionPersistence: persistence,
      space: 'main',
      pollIntervalMs: 0,
    })

    try {
      await store.start()
      const created = await store.write({
        title: 'Committed restore',
        content: 'must survive publication failure',
      })
      await store.settle()
      await store.remove(created.id!)
      await store.settle()
      const internals = store as unknown as {
        flushIdentityPublication(): Promise<void>
      }
      const flushIdentityPublication = internals.flushIdentityPublication.bind(store)
      let failAfterFlush = true

      internals.flushIdentityPublication = async () => {
        await flushIdentityPublication()
        if (failAfterFlush) {
          failAfterFlush = false
          throw new Error('injected post-append publication failure')
        }
      }

      await expect(store.restoreFromTrash!(created.id!)).rejects.toThrow(
        'injected post-append publication failure',
      )

      expect(existsSync(join(notesDir, 'committed-restore.md'))).toBe(true)
      expect((await store.list()).some((note) => note.id === created.id)).toBe(true)
      expect((await persistence.latestFor('main', created.id!))?.kind).toBe('restore')
      expect((await store.listTrashed!({ offset: 0, limit: 10 })).total).toBe(0)
    } finally {
      store.stop()
      await store.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })
})
