import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CachedStore,
  claudeConversationSourceLocator,
  frontmatterScalarEntry,
  IMPORT_SOURCE_FRONTMATTER_KEY,
  parseImport,
} from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'
import { InMemoryStore } from '@notarium/engine-memory'

import { runImport } from './importService'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const source = (body: string, title = 'Shared contract', uuid = 'shared-contract-source') =>
  JSON.stringify([
    {
      uuid,
      name: title,
      created_at: '2024-01-01T00:00:00Z',
      chat_messages: [{ sender: 'human', text: body }],
    },
  ])

type ContractStore = CachedStore
type ContractFactory = {
  name: string
  create: (root: string) => Promise<ContractStore>
  createWithExternalOwners: (root: string, locator: string) => Promise<ContractStore>
  restart: (store: ContractStore, root: string) => Promise<ContractStore>
}

const stop = async (store: ContractStore) => {
  store.stop()
  await store.settle()
}

type MemoryNotes = NonNullable<ConstructorParameters<typeof InMemoryStore>[0]>['notes']

const memoryStore = (notes: MemoryNotes = []) =>
  new CachedStore({
    inner: new InMemoryStore({ space: 'test', notes }),
    space: 'test',
    pollIntervalMs: 0,
  })

const realStore = (root: string) => {
  const notesDir = join(root, 'notes')
  return new CachedStore({
    inner: createNotariumStore({
      notesDir,
      indexDb: join(root, 'index.db'),
      spaceId: 'test',
    }),
    space: 'test',
    pollIntervalMs: 0,
  })
}

const factories: ContractFactory[] = [
  {
    name: 'InMemoryStore/CachedStore',
    create: async () => memoryStore(),
    createWithExternalOwners: async (_root, locator) =>
      memoryStore(
        ['a', 'b'].map((id) => ({
          id: `external-${id}`,
          title: `External ${id}`,
          content: `external ${id}`,
          filePath: `external-${id}.md`,
          sourceLocator: locator,
        })),
      ),
    restart: async (store) => {
      const notes = await Promise.all(
        (await store.list()).map(async (meta) => {
          const detail = await store.read(meta.id!)
          return {
            id: meta.id!,
            title: meta.title,
            content: detail.content,
            filePath: meta.filePath,
            class: meta.class,
            sourceLocator: detail.sourceLocator,
            modifiedAt: meta.modifiedAt,
            createdAt: meta.createdAt,
          }
        }),
      )
      await stop(store)
      const restarted = memoryStore(notes)
      await restarted.start()
      return restarted
    },
  },
  {
    name: 'NotariumStore/CachedStore',
    create: async (root: string) => {
      const notesDir = join(root, 'notes')
      await mkdir(notesDir)
      return realStore(root)
    },
    createWithExternalOwners: async (root, locator) => {
      const notesDir = join(root, 'notes')
      await mkdir(notesDir)
      await Promise.all(
        ['a', 'b'].map((id) =>
          writeFile(
            join(notesDir, `external-${id}.md`),
            `---\ntitle: External ${id}\nnotarium-id: external-${id}\n${IMPORT_SOURCE_FRONTMATTER_KEY}: ${locator}\n---\n\n# External ${id}\n\nexternal ${id}\n`,
          ),
        ),
      )
      return realStore(root)
    },
    restart: async (store, root) => {
      await stop(store)
      const restarted = realStore(root)
      await restarted.start()
      return restarted
    },
  },
]

describe.each(factories)(
  'source-aware foreign import: $name',
  ({ create, createWithExternalOwners, restart }) => {
    it('serializes concurrent fresh creates by locator even when titles pick different paths', async () => {
      const root = await mkdtemp(join(tmpdir(), 'notarium-source-race-'))
      roots.push(root)
      const store = await create(root)
      await store.start()
      const uploadA = join(root, 'a.json')
      const uploadB = join(root, 'b.json')
      const tempA = await mkdtemp(join(root, 'members-a-'))
      const tempB = await mkdtemp(join(root, 'members-b-'))
      await writeFile(uploadA, source('A', 'Old title', 'same-racing-source'))
      await writeFile(uploadB, source('B', 'Renamed title', 'same-racing-source'))
      let snapshots = 0
      let release!: () => void
      const bothSnapshotted = new Promise<void>((resolve) => {
        release = resolve
      })
      const racingStore = {
        write: store.write.bind(store),
        read: store.read.bind(store),
        checkpoint: store.checkpoint.bind(store),
        list: async (...args: Parameters<typeof store.list>) => {
          const snapshot = await store.list(...args)

          if (++snapshots === 2) {
            release()
          }
          await bothSnapshotted
          return snapshot
        },
        beginBulk: store.beginBulk.bind(store),
        endBulk: store.endBulk.bind(store),
      }
      const run = (uploadPath: string, tempDir: string) =>
        runImport({
          store: racingStore,
          uploadPath,
          tempDir,
          filename: 'conversations.json',
          format: 'claude-conversations',
          principal: 'user:test',
        })

      try {
        const results = await Promise.all([run(uploadA, tempA), run(uploadB, tempB)])

        expect(results.map((result) => result.imported).sort()).toEqual([0, 1])
        expect(results.map((result) => result.failed).sort()).toEqual([0, 1])
        const notes = await store.list()
        expect(notes).toHaveLength(1)
        expect(notes[0].sourceLocator).toMatch(/^v1:claude:conversation:/u)
      } finally {
        await stop(store)
      }
    })

    it('re-checks a source-less predecessor written after the frozen inventory', async () => {
      const root = await mkdtemp(join(tmpdir(), 'notarium-source-predecessor-'))
      roots.push(root)
      const store = await create(root)
      await store.start()
      const uploadPath = join(root, 'conversations.json')
      const tempDir = await mkdtemp(join(root, 'members-'))
      const raw = source('fresh body', 'Legacy race', 'legacy-racing-source')
      await writeFile(uploadPath, raw)
      const note = parseImport(raw, 'claude-conversations').notes[0]
      let inventorySeen!: () => void
      const seen = new Promise<void>((resolve) => {
        inventorySeen = resolve
      })
      let continueImport!: () => void
      const predecessorWritten = new Promise<void>((resolve) => {
        continueImport = resolve
      })
      const importingStore = {
        write: store.write.bind(store),
        read: store.read.bind(store),
        checkpoint: store.checkpoint.bind(store),
        list: async (...args: Parameters<typeof store.list>) => {
          const snapshot = await store.list(...args)
          inventorySeen()
          await predecessorWritten
          return snapshot
        },
        beginBulk: store.beginBulk.bind(store),
        endBulk: store.endBulk.bind(store),
      }

      try {
        const importing = runImport({
          store: importingStore,
          uploadPath,
          tempDir,
          filename: 'conversations.json',
          format: 'claude-conversations',
          principal: 'user:test',
        })
        await seen
        await store.write({
          title: note.title,
          content: 'legacy occupant',
          directory: note.legacyDirectory,
          fileName: note.legacyFileName,
          ifExists: 'fail',
        })
        continueImport()
        await expect(importing).resolves.toMatchObject({ imported: 0, failed: 1 })
        const notes = await store.list()
        expect(notes).toHaveLength(1)
        expect(notes[0].sourceLocator).toBeUndefined()
        expect((await store.read(notes[0].id!)).content).toContain('legacy occupant')
      } finally {
        continueImport()
        await stop(store)
      }
    })

    it('indexes direct claims, strips authored spoofing and refuses ambiguous owners', async () => {
      const root = await mkdtemp(join(tmpdir(), 'notarium-source-ingress-'))
      roots.push(root)
      const locator = claudeConversationSourceLocator('ambiguous-external-source')!
      const store = await createWithExternalOwners(root, locator)
      await store.start()
      const uploadPath = join(root, 'conversations.json')
      const tempDir = await mkdtemp(join(root, 'members-'))
      await writeFile(
        uploadPath,
        source('fresh body', 'Ambiguous external', 'ambiguous-external-source'),
      )

      try {
        expect((await store.list()).filter((note) => note.sourceLocator === locator)).toHaveLength(
          2,
        )
        const spoof = await store.write({
          title: 'Authored spoof',
          content: 'authored',
          frontmatter: [frontmatterScalarEntry(IMPORT_SOURCE_FRONTMATTER_KEY, locator)],
          ifExists: 'fail',
        })
        expect((await store.read(spoof.id!)).sourceLocator).toBeUndefined()
        expect((await store.read(spoof.id!)).frontmatter).not.toHaveProperty(
          IMPORT_SOURCE_FRONTMATTER_KEY,
        )
        await expect(
          runImport({
            store,
            uploadPath,
            tempDir,
            filename: 'conversations.json',
            format: 'claude-conversations',
            principal: 'user:test',
          }),
        ).resolves.toMatchObject({ imported: 0, failed: 1 })
        expect((await store.list()).filter((note) => note.sourceLocator === locator)).toHaveLength(
          2,
        )
      } finally {
        await stop(store)
      }
    })

    it('converges across history, re-import, user move, skip and trash restore', async () => {
      const root = await mkdtemp(join(tmpdir(), 'notarium-source-contract-'))
      roots.push(root)
      const uploadPath = join(root, 'conversations.json')
      const tempDir = await mkdtemp(join(root, 'members-'))
      let store = await create(root)
      await store.start()

      const run = async (body: string, skipExisting = false) => {
        await writeFile(uploadPath, source(body))
        return runImport({
          store,
          uploadPath,
          tempDir,
          filename: 'conversations.json',
          format: 'claude-conversations',
          principal: 'user:test',
          skipExisting,
        })
      }

      try {
        expect(await run('v1')).toMatchObject({ imported: 1, failed: 0 })
        const first = (await store.list())[0]
        expect(first.sourceLocator).toMatch(/^v1:claude:conversation:/u)

        store = await restart(store, root)
        expect(await run('v2')).toMatchObject({ imported: 1, failed: 0 })
        expect(await store.list()).toEqual([expect.objectContaining({ id: first.id })])
        expect((await store.read(first.id!)).content).toContain('v2')
        const history = await store.revisions!(first.id!, { offset: 0, limit: 20 })
        const origin = history.items.at(-1)!
        const live = await store.read(first.id!)
        await store.restore!({
          id: first.id!,
          revisionId: origin.id,
          versionToken: live.versionToken!,
        })
        expect((await store.read(first.id!)).sourceLocator).toBe(first.sourceLocator)
        expect(await run('v2-restored')).toMatchObject({ imported: 1, failed: 0 })

        await store.move({ id: first.id!, destinationPath: 'moved/by-user.md' })
        expect(await run('v3')).toMatchObject({ imported: 1, failed: 0 })
        expect(await store.list()).toEqual([
          expect.objectContaining({ id: first.id, filePath: 'moved/by-user.md' }),
        ])
        expect((await store.read(first.id!)).content).toContain('v3')

        expect(await run('ignored', true)).toMatchObject({ imported: 0, skipped: 1, failed: 0 })
        expect((await store.read(first.id!)).content).toContain('v3')

        await store.remove(first.id!)
        await store.restoreFromTrash(first.id!)
        expect(await run('v4')).toMatchObject({ imported: 1, failed: 0 })
        expect(await store.list()).toEqual([
          expect.objectContaining({ id: first.id, filePath: 'moved/by-user.md' }),
        ])
        expect((await store.read(first.id!)).sourceLocator).toBe(first.sourceLocator)
      } finally {
        await stop(store)
      }
    })
  },
)
