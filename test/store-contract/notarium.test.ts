// The Notarium engine (#69) against the shared KnowledgeStore spec. Hermetic by
// construction (a temp dir + an in-memory index) — no env gating, rides CI.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNotariumStore } from '@notarium/engine'

import { describeKnowledgeStoreContract } from './storeContract'

describeKnowledgeStoreContract('NotariumStore (localfs + sqlite)', async () => {
  const notesDir = mkdtempSync(join(tmpdir(), 'notarium-engine-'))
  // Two typed mounts (#78) so the class/visibility spec can write into the
  // hidden agent-memory mount and assert class materialization from the mount.
  const store = createNotariumStore({
    mounts: [
      { class: 'user-doc', dir: notesDir, prefix: '' },
      {
        class: 'agent-memory',
        dir: join(notesDir, '.notarium/memory'),
        prefix: '.notarium/memory',
      },
    ],
  })
  return {
    store,
    directory: 'contract',
    teardown: async () => {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    },
  }
})

// #100 phase 3: the engine resolves a path-form [[oldpath/note]] to a RENAMED folder's
// note even when the filename is ambiguous — but ONLY once the read-model feeds it
// the folder path-history (the engine never reads the `.notariummeta` markers).
// This is the boot-graph half the read-model can't heal alone (an already-resolved
// edge carries no link label to re-resolve). Caught live on a dev stand.
describe('NotariumStore — folder path-aliases (#100 phase 3)', () => {
  it('setFolderAliases makes graph() resolve an ambiguous [[oldpath/note]] to the renamed folder', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-fa-'))
    const store = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })

    try {
      // Same filename in two folders → the last-segment fallback is AMBIGUOUS.
      await store.write({ title: 'Note', directory: 'orbita', content: 'the moved one' })
      await store.write({ title: 'Note', directory: 'arkhiv', content: 'an unrelated sibling' })
      await store.write({ title: 'Linker', content: 'see [[kosmos/Note]] for details' })

      const targetOf = async (): Promise<string | undefined> => {
        const g = await store.graph()

        const pathOf = (id: string | undefined): string | undefined => {
          const node = id ? g.nodes.find((n) => n.id === id) : undefined
          return node && 'filePath' in node ? node.filePath : undefined
        }
        const edge = g.links.find((l) => pathOf(l.source)?.endsWith('linker.md'))
        return pathOf(edge?.target)
      }

      // Folder 'kosmos' was renamed to 'orbita'; feed the alias so [[kosmos/Note]]
      // resolves to orbita/note.md — NOT the arkhiv sibling.
      store.setFolderAliases!([{ current: 'orbita', alias: 'kosmos' }])
      expect(await targetOf()).toBe('orbita/note.md')
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  // #125: the DIRECT resolve path (read by ref) was folder-alias-BLIND — it bit
  // the server wiki-resolver `GET /api/s/:space/note?ref=` on a client cache-miss
  // (cachedStore.read → inner.read → resolveRow). The graph resolved [[oldpath/note]]
  // correctly while a direct read fell through to a tezka sibling: graph/navigation
  // rassinkhron. resolveRow now mirrors resolveWiki — folder-alias full-path BEFORE
  // the ambiguous bare last-segment.
  it('read() resolves an ambiguous [[oldpath/note]] to the renamed folder, not the tezka sibling', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-fa-read-'))
    const store = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })

    try {
      // Same filename in two folders → the last-segment fallback is AMBIGUOUS.
      await store.write({ title: 'Note', directory: 'orbita', content: 'the moved one' })
      await store.write({ title: 'Note', directory: 'arkhiv', content: 'an unrelated sibling' })

      // Without the alias the engine is folder-alias-blind: a bare-filename tezka wins
      // (arkhiv sorts before orbita) — the unambiguous case the read-model never feeds.
      expect((await store.read('kosmos/Note')).filePath).toBe('arkhiv/note.md')

      // Fed the folder path-history (kosmos → orbita), the full-path rewrite wins BEFORE
      // the bare last-segment, so the direct read agrees with graph() and resolveWiki.
      store.setFolderAliases!([{ current: 'orbita', alias: 'kosmos' }])
      expect((await store.read('kosmos/Note')).filePath).toBe('orbita/note.md')
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  // #125: a LIVE literal path beats a folder-alias rewrite —
  // mirroring buildLinkIndex (Pass 1 current > Pass 3 folder-alias). The folder
  // names are chosen so the alias TARGET sorts before the literal old path
  // ('newproj' < 'oldproj'): a single flat full-path set would let that alphabetics
  // out-resolve the live literal note. Literal and alias-rewrite are SEPARATE passes,
  // so the literal wins regardless of folder-name ordering.
  it('read() prefers a live literal path over a folder-alias rewrite (literal > alias)', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-fa-lit-'))
    const store = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })

    try {
      await store.write({
        title: 'Note',
        directory: 'oldproj',
        content: 'a live note literally at the old path',
      })
      await store.write({ title: 'Note', directory: 'newproj', content: 'the folder-alias target' })
      store.setFolderAliases!([{ current: 'newproj', alias: 'oldproj' }])
      // 'oldproj/Note' literally exists → it wins over the oldproj→newproj rewrite,
      // even though 'newproj' sorts first. A flat fullPaths set would return newproj.
      expect((await store.read('oldproj/Note')).filePath).toBe('oldproj/note.md')
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  // #125: a NESTED folder-alias prefix with a multi-segment tail —
  // exercises the `cur + want.slice(a.length)` prefix-swap on a real tail, not just a
  // one-segment rename. 'kosmos/old' → 'orbita/deep', so 'kosmos/old/sub/Note'
  // rewrites to 'orbita/deep/sub/note'.
  it('read() resolves a path-form link through a nested folder-alias prefix', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-fa-nest-'))
    const store = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })

    try {
      await store.write({
        title: 'Note',
        directory: 'orbita/deep/sub',
        content: 'the nested moved one',
      })
      await store.write({
        title: 'Note',
        directory: 'arkhiv',
        content: 'an unrelated sibling tezka',
      })
      store.setFolderAliases!([{ current: 'orbita/deep', alias: 'kosmos/old' }])
      expect((await store.read('kosmos/old/sub/Note')).filePath).toBe('orbita/deep/sub/note.md')
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })
})
