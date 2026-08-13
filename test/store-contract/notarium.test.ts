// The Notarium engine (#69) against the shared KnowledgeStore spec. Hermetic by
// construction (a temp dir + an in-memory index) — no env gating, rides CI.

import { execFileSync } from 'node:child_process'
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeWikilinkIdentity, IF_EXISTS } from '@notarium/core'
import {
  createLocalFsFiles,
  createNodeSqliteDriver,
  createNotariumStore,
  type FileStore,
  NotariumStore,
} from '@notarium/engine'

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
  return {
    store,
    directory: 'contract',
    teardown: async () => {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    },
  }
})

describe('NotariumStore raw export convergence', () => {
  it('skips a source that vanishes between inventory and read', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-export-vanish-'))
    writeFileSync(join(notesDir, 'note.md'), '---\ntitle: Note\n---\n\nbody')
    const base = createLocalFsFiles(notesDir)
    let vanish = false
    const files: FileStore = {
      ...base,
      read: async (path) => (vanish ? null : base.read(path)),
    }
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc', prefix: '', files }],
      sql: createNodeSqliteDriver(':memory:'),
    })

    try {
      await store.list()
      vanish = true
      const exported = []

      for await (const entry of store.exportNotes!()) {
        exported.push(entry)
      }
      expect(exported).toEqual([])
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })
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

  it('keeps direct read and graph aligned when an empty live folder shadows history', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-fa-empty-shadow-'))
    mkdirSync(join(notesDir, 'other'), { recursive: true })
    mkdirSync(join(notesDir, 'A'), { recursive: true })
    mkdirSync(join(notesDir, 'old/sub'), { recursive: true })
    writeFileSync(join(notesDir, 'other/Note.md'), '---\ntitle: Target\n---\n\ntarget')
    writeFileSync(join(notesDir, 'A/Note.md'), '---\ntitle: Decoy\n---\n\ndecoy')
    writeFileSync(join(notesDir, 'Linker.md'), '---\ntitle: Linker\n---\n\n[[old/sub/Note]]')
    const store = createNotariumStore({ notesDir })

    try {
      store.setFolderAliases!([{ current: 'other', alias: 'old/sub' }])
      expect((await store.read('old/sub/Note')).filePath).toBe('A/Note.md')
      expect((await store.graph()).links).toContainEqual(
        expect.objectContaining({ source: 'Linker.md', target: 'A/Note.md' }),
      )
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('invalidates a cached graph when makeDir introduces a live-folder shadow', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-fa-mkdir-shadow-'))
    mkdirSync(join(notesDir, 'other'), { recursive: true })
    mkdirSync(join(notesDir, 'A'), { recursive: true })
    writeFileSync(join(notesDir, 'other/Note.md'), '---\ntitle: Target\n---\n\ntarget')
    writeFileSync(join(notesDir, 'A/Note.md'), '---\ntitle: Decoy\n---\n\ndecoy')
    writeFileSync(join(notesDir, 'Linker.md'), '---\ntitle: Linker\n---\n\n[[old/sub/Note]]')
    const store = createNotariumStore({ notesDir })

    try {
      store.setFolderAliases!([{ current: 'other', alias: 'old/sub' }])
      expect((await store.graph()).links).toContainEqual(
        expect.objectContaining({ source: 'Linker.md', target: 'other/Note.md' }),
      )

      await store.makeDir!('old/sub')
      expect((await store.graph()).links).toContainEqual(
        expect.objectContaining({ source: 'Linker.md', target: 'A/Note.md' }),
      )
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  // Bare/direct reads retain the same folder-alias fallback as graph derivation.
  // Production HTTP resolution normally selects the winner in CachedStore first.
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

      // Fed the folder path-history (kosmos → orbita), the full-path rewrite wins
      // before the bare last-segment, so this direct-read fallback agrees with graph().
      store.setFolderAliases!([{ current: 'orbita', alias: 'kosmos' }])
      expect((await store.read('kosmos/Note')).filePath).toBe('orbita/note.md')
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  // #296: the same pass, on a folder name with no romanisable letters. The pin above
  // uses `kosmos`→`orbita`, which is exactly the half where the bare slug and the name
  // key agree — so reverting this pass to `slugifyPath` left it green. `📥` is where
  // they part: the producer retires it into the history (`namePathKey('📥')` is
  // non-empty), and a resolver still on the bare slug rewrites to a key no row can
  // carry, so `[[📥/Note]]` falls through to the ambiguous last segment and serves a
  // same-named sibling — the graph/navigation desync #125 closed, reopened for one
  // alphabet.
  it('read() resolves [[oldpath/note]] when the old folder name has no romanisable letters', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-fa-nonlatin-'))
    const store = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })

    try {
      await store.write({ title: 'Note', directory: 'inbox', content: 'the moved one' })
      await store.write({ title: 'Note', directory: 'arkhiv', content: 'an unrelated sibling' })

      store.setFolderAliases!([{ current: 'inbox', alias: '📥' }])
      expect((await store.read('📥/Note')).filePath).toBe('inbox/note.md')
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

describe('NotariumStore — stable-id wikilinks', () => {
  it('maps an exact id claim to the engine path in read and graph', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-id-link-'))
    const store = createNotariumStore({ notesDir })

    try {
      const id = 'AbC123xyz789'
      const target = await store.write({ title: 'Target', content: 'body', id })
      const linker = await store.write({
        title: 'Linker',
        content: `see [[${encodeWikilinkIdentity(id)}|Target]]`,
      })

      expect((await store.read(id)).filePath).toBe(target.filePath)
      expect(
        (await store.graph()).links.some(
          (l) => l.source === linker.filePath && l.target === target.filePath,
        ),
      ).toBe(true)
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('uses an authoritative registry hint for an unclaimed external-style note', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-id-hint-'))
    const store = createNotariumStore({ notesDir })

    try {
      const target = await store.write({ title: 'Target', content: 'body' })
      const linker = await store.write({
        title: 'Linker',
        content: `see [[${encodeWikilinkIdentity('registry-id')}|Target]]`,
      })
      store.setLinkIdentities!([{ id: 'registry-id', path: target.filePath! }])

      expect((await store.read('registry-id')).filePath).toBe(target.filePath)
      expect(
        (await store.graph()).links.some(
          (l) => l.source === linker.filePath && l.target === target.filePath,
        ),
      ).toBe(true)
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })
})

describe('NotariumStore — exact raw path resolver parity', () => {
  it('keeps graph and direct reads aligned for case/NFC-equivalent live paths', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-raw-path-'))
    writeFileSync(join(notesDir, 'Foo.md'), '---\ntitle: Upper\n---\n\nupper')
    writeFileSync(join(notesDir, 'foo.md'), '---\ntitle: Lower\n---\n\nlower')
    writeFileSync(join(notesDir, 'Café.md'), '---\ntitle: Composed\n---\n\ncomposed')
    writeFileSync(join(notesDir, 'Cafe\u0301.md'), '---\ntitle: Decomposed\n---\n\ndecomposed')
    writeFileSync(join(notesDir, 'Base.md'), '---\ntitle: Base\n---\n\nbase')
    writeFileSync(join(notesDir, 'Base#section.md'), '---\ntitle: Literal Hash\n---\n\nliteral')
    writeFileSync(
      join(notesDir, 'source.md'),
      '---\ntitle: Raw Linker\n---\n\n[[foo]]\n[[Cafe\u0301]]\n[[Base#section]]',
    )
    const store = createNotariumStore({ notesDir })

    try {
      const graph = await store.graph()
      const targets = graph.links
        .filter((link) => link.source === 'source.md')
        .map((link) => link.target)

      expect((await store.read('Foo')).filePath).toBe('Foo.md')
      expect((await store.read('foo')).filePath).toBe('foo.md')
      expect((await store.read('Café')).filePath).toBe('Café.md')
      expect((await store.read('Cafe\u0301')).filePath).toBe('Cafe\u0301.md')
      expect((await store.read('Base#section.md')).filePath).toBe('Base#section.md')
      expect((await store.read('Base#section')).filePath).toBe('Base.md')
      expect(targets).toContain('foo.md')
      expect(targets).toContain('Cafe\u0301.md')
      expect(targets).toContain('Base.md')
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('round-trips a listed legacy envelope-shaped path while graph links use the identity', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-envelope-path-'))
    const address = 'notarium-id:foo.md'
    writeFileSync(
      join(notesDir, address),
      '---\nnotarium-id: literal-path\ntitle: Literal Path\n---\n\nliteral',
    )
    writeFileSync(
      join(notesDir, 'target.md'),
      '---\nnotarium-id: foo.md\ntitle: Stable Target\n---\n\ntarget',
    )
    writeFileSync(
      join(notesDir, 'opaque.md'),
      '---\nnotarium-id: notarium-id:opaque\ntitle: Opaque Prefix Id\n---\n\nopaque',
    )
    writeFileSync(join(notesDir, 'source.md'), `---\ntitle: Source\n---\n\n[[${address}]]`)
    const store = createNotariumStore({ notesDir })

    try {
      expect((await store.list()).some((note) => note.filePath === address)).toBe(true)
      expect((await store.read(address)).filePath).toBe(address)
      expect((await store.read('notarium-id:opaque')).filePath).toBe('opaque.md')
      expect((await store.read(encodeWikilinkIdentity('notarium-id:opaque'))).filePath).toBe(
        'opaque.md',
      )
      expect((await store.graph()).links).toContainEqual(
        // A bare NotariumStore exposes graph node ids as storage paths; the
        // frontmatter identity still selects target.md rather than the literal
        // envelope-shaped path decoy.
        expect.objectContaining({ source: 'source.md', target: 'target.md' }),
      )
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })
})

describe('NotariumStore — legacy move destinations', () => {
  it('carries exact non-portable note/folder leaves into a portable existing parent', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-legacy-move-'))
    mkdirSync(join(notesDir, 'archive'))
    mkdirSync(join(notesDir, 'folder:legacy'))
    writeFileSync(
      join(notesDir, 'foo:bar.md'),
      '---\nnotarium-id: legacy-note\ntitle: Legacy Note\n---\n\nnote',
    )
    writeFileSync(
      join(notesDir, 'folder:legacy/note.md'),
      '---\nnotarium-id: nested-note\ntitle: Nested Note\n---\n\nnested',
    )
    const store = createNotariumStore({ notesDir })

    try {
      await store.move({ id: 'legacy-note', destinationPath: 'archive/foo:bar.md' })
      await store.move({
        id: 'folder:legacy',
        destinationPath: 'archive/folder:legacy',
        isDirectory: true,
      })

      expect((await store.read('legacy-note')).filePath).toBe('archive/foo:bar.md')
      expect((await store.read('nested-note')).filePath).toBe('archive/folder:legacy/note.md')
      await expect(
        store.move({ id: 'legacy-note', destinationPath: 'archive/other:bad.md' }),
      ).rejects.toMatchObject({ isToolError: true })
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })
})

describe('NotariumStore — case-insensitive path occupancy', () => {
  const caseInsensitiveFiles = (notesDir: string): FileStore => {
    const base = createLocalFsFiles(notesDir)
    const key = (path: string) => path.normalize('NFC').toLocaleLowerCase()

    const actualPath = async (path: string): Promise<string> => {
      if (await base.exists(path)) {
        return path
      }

      return (
        [...(await base.listDirs()), ...(await base.scan()).map((entry) => entry.path)].find(
          (candidate) => key(candidate) === key(path),
        ) ?? path
      )
    }

    return {
      ...base,
      stat: async (path) => base.stat(await actualPath(path)),
      read: async (path) => base.read(await actualPath(path)),
      exists: async (path) => base.exists(await actualPath(path)),
      dirExists: async (path) => base.dirExists(await actualPath(path)),
      sameEntry: async (left, right) =>
        base.sameEntry!(await actualPath(left), await actualPath(right)),
      rename: async (from, to) => base.rename(await actualPath(from), to),
      renameIfAbsent: async (from, to) => {
        const actualDestination = await actualPath(to)

        if (await base.exists(actualDestination)) {
          return false
        }

        return base.renameIfAbsent!(await actualPath(from), to)
      },
      replaceIfAbsent: async (from, to, expectedSource, content) => {
        const actualDestination = await actualPath(to)

        if (await base.exists(actualDestination)) {
          return false
        }

        return base.replaceIfAbsent!(await actualPath(from), to, expectedSource, content)
      },
      renameDir: async (from, to) => base.renameDir(await actualPath(from), to),
      removeDir: async (path) => base.removeDir(await actualPath(path)),
      makeDir: async (path) => {
        const actual = await actualPath(path)

        return (await base.dirExists(actual)) ? false : base.makeDir(path)
      },
    }
  }

  it('refuses a rename onto a distinct hardlink pathname without changing either name', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-hardlink-rename-'))
    const sourceBytes = '---\ntitle: Foo\n---\n\nold'
    writeFileSync(join(notesDir, 'Foo.md'), sourceBytes)
    const store = createNotariumStore({ notesDir })

    try {
      await store.list()
      linkSync(join(notesDir, 'Foo.md'), join(notesDir, 'foo.md'))

      await expect(
        store.write({ originalId: 'Foo.md', title: 'foo', content: 'new' }),
      ).rejects.toThrow(/already lives at the destination/i)
      expect(readdirSync(notesDir).sort()).toEqual(['Foo.md', 'foo.md'])
      expect(readFileSync(join(notesDir, 'Foo.md'), 'utf8')).toBe(sourceBytes)
      expect(readFileSync(join(notesDir, 'foo.md'), 'utf8')).toBe(sourceBytes)
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('allows a case-only rename when both spellings are the same entry', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-case-rename-'))
    writeFileSync(join(notesDir, 'Foo.md'), '---\ntitle: Foo\n---\n\nold')
    const base = createLocalFsFiles(notesDir)

    const actualPath = async (path: string): Promise<string> => {
      if (await base.exists(path)) {
        return path
      }

      return (
        (await base.scan()).find((entry) => entry.path.toLowerCase() === path.toLowerCase())
          ?.path ?? path
      )
    }

    const files: FileStore = {
      ...base,
      stat: async (path) => base.stat(await actualPath(path)),
      read: async (path) => base.read(await actualPath(path)),
      exists: async (path) => base.exists(await actualPath(path)),
      sameEntry: async (left, right) =>
        base.sameEntry!(await actualPath(left), await actualPath(right)),
      rename: async (from, to) => base.rename(await actualPath(from), to),
    }
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc', prefix: '', files }],
      sql: createNodeSqliteDriver(':memory:'),
    })

    try {
      const result = await store.write({ originalId: 'Foo.md', title: 'foo', content: 'new' })

      expect(result.filePath).toBe('foo.md')
      expect((await store.read('foo')).content).toBe('new')
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('requires the exact raw source spelling before moving or deleting a folder', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-folder-source-case-'))
    mkdirSync(join(notesDir, 'Docs'), { recursive: true })
    writeFileSync(join(notesDir, 'Docs/A.md'), '---\ntitle: A\n---\n\nbody')
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc', prefix: '', files: caseInsensitiveFiles(notesDir) }],
      sql: createNodeSqliteDriver(':memory:'),
    })

    try {
      await store.list()
      await expect(
        store.move({ id: 'docs', destinationPath: 'Archive', isDirectory: true }),
      ).rejects.toThrow(/source spelling/i)
      expect(readdirSync(notesDir)).toEqual(['Docs'])
      expect((await store.list()).map((note) => note.filePath)).toEqual(['Docs/A.md'])

      await store.removeDir!('docs')
      expect(readdirSync(notesDir)).toEqual(['Docs'])
      expect((await store.list()).map((note) => note.filePath)).toEqual(['Docs/A.md'])
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('allows an exact-source case rename but rejects its alternate-case descendant', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-folder-case-rename-'))
    mkdirSync(join(notesDir, 'Docs'), { recursive: true })
    writeFileSync(join(notesDir, 'Docs/A.md'), '---\ntitle: A\n---\n\nbody')
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc', prefix: '', files: caseInsensitiveFiles(notesDir) }],
      sql: createNodeSqliteDriver(':memory:'),
    })

    try {
      await store.list()
      await expect(
        store.move({ id: 'Docs', destinationPath: 'docs/sub', isDirectory: true }),
      ).rejects.toThrow(/into itself/i)
      await store.move({ id: 'Docs', destinationPath: 'docs', isDirectory: true })
      expect(readdirSync(notesDir)).toEqual(['docs'])
      expect((await store.list()).map((note) => note.filePath)).toEqual(['docs/A.md'])
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('uses empty-folder inventory for ghost create intent and rejects alternate parent spelling', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-empty-folder-case-'))
    mkdirSync(join(notesDir, 'Empty'), { recursive: true })
    writeFileSync(join(notesDir, 'Source.md'), '---\ntitle: Source\n---\n\n[[empty/New]]')
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc', prefix: '', files: caseInsensitiveFiles(notesDir) }],
      sql: createNodeSqliteDriver(':memory:'),
    })

    try {
      const ghost = (await store.graph()).nodes.find((node) => node.ghost)
      expect(ghost).toMatchObject({ prefillDirectory: 'Empty', creatable: true })
      await expect(
        store.write({ title: 'New', directory: 'empty', content: 'body' }),
      ).rejects.toThrow(/directory spelling/i)
      expect(readdirSync(join(notesDir, 'Empty'))).toEqual([])
      expect((await store.list()).map((note) => note.filePath)).toEqual(['Source.md'])
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('rejects alternate parent spelling on nested create and both move surfaces', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-folder-parent-case-'))
    mkdirSync(join(notesDir, 'Archive'), { recursive: true })
    mkdirSync(join(notesDir, 'Docs'), { recursive: true })
    writeFileSync(join(notesDir, 'Docs/A.md'), '---\ntitle: A\n---\n\nbody')
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc', prefix: '', files: caseInsensitiveFiles(notesDir) }],
      sql: createNodeSqliteDriver(':memory:'),
    })

    try {
      await store.list()
      await expect(store.makeDir!('archive/Child')).rejects.toThrow(/directory spelling/i)
      await expect(
        store.move({ id: 'Docs/A.md', destinationPath: 'archive/a.md' }),
      ).rejects.toThrow(/directory spelling/i)
      await expect(
        store.move({ id: 'Docs', destinationPath: 'archive/Docs', isDirectory: true }),
      ).rejects.toThrow(/directory spelling/i)

      expect(readdirSync(join(notesDir, 'Archive'))).toEqual([])
      expect(readFileSync(join(notesDir, 'Docs/A.md'), 'utf8')).toContain('body')
      expect((await store.list()).map((note) => note.filePath)).toEqual(['Docs/A.md'])
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('does not replace a destination that appears during a note rename', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-note-rename-race-'))
    const sourceBytes = '---\ntitle: Source\n---\n\nsource body'
    writeFileSync(join(notesDir, 'source.md'), sourceBytes)
    const base = createLocalFsFiles(notesDir)
    const rivalBytes = '---\ntitle: Rival\n---\n\nrival body'
    const files: FileStore = {
      ...base,
      replaceIfAbsent: async (from, to, expectedSource, content) => {
        writeFileSync(join(notesDir, to), rivalBytes)
        return base.replaceIfAbsent!(from, to, expectedSource, content)
      },
    }
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc', prefix: '', files }],
      sql: createNodeSqliteDriver(':memory:'),
    })

    try {
      await store.list()
      await expect(
        store.write({ originalId: 'source.md', title: 'Target', content: 'changed' }),
      ).rejects.toThrow(/already lives at the destination/i)
      expect(readFileSync(join(notesDir, 'source.md'), 'utf8')).toBe(sourceBytes)
      expect(readFileSync(join(notesDir, 'target.md'), 'utf8')).toBe(rivalBytes)
      expect((await store.read('source.md')).content).toBe('source body')
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('does not adopt an external replacement as the baseline of an edit', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-note-edit-prior-race-'))
    const sourceBytes = '---\ntitle: Source\nnotarium-id: ORIGINAL1234\n---\n\nsource body'
    const externalBytes = '---\ntitle: External\nnotarium-id: EXTERNAL9999\n---\n\nexternal body'
    writeFileSync(join(notesDir, 'source.md'), sourceBytes)
    const base = createLocalFsFiles(notesDir)
    let inject = false
    const files: FileStore = {
      ...base,
      read: async (path) => {
        if (inject && path === 'source.md') {
          inject = false
          writeFileSync(join(notesDir, 'external.md'), externalBytes)
          renameSync(join(notesDir, 'external.md'), join(notesDir, path))
        }

        return base.read(path)
      },
    }
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc', prefix: '', files }],
      sql: createNodeSqliteDriver(':memory:'),
    })

    try {
      await store.list()
      inject = true
      await expect(
        store.write({ originalId: 'source.md', title: 'Source', content: 'app body' }),
      ).rejects.toThrow(/changed during write/i)
      expect(readFileSync(join(notesDir, 'source.md'), 'utf8')).toBe(externalBytes)
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('does not overwrite an external replacement racing edit publication', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-note-edit-publish-race-'))
    const sourceBytes = '---\ntitle: Source\nnotarium-id: ORIGINAL1234\n---\n\nsource body'
    const externalBytes = '---\ntitle: External\nnotarium-id: EXTERNAL9999\n---\n\nexternal body'
    writeFileSync(join(notesDir, 'source.md'), sourceBytes)
    const base = createLocalFsFiles(notesDir)
    const files: FileStore = {
      ...base,
      replaceIfAbsent: async (from, to, expectedSource, content) => {
        writeFileSync(join(notesDir, 'external.md'), externalBytes)
        renameSync(join(notesDir, 'external.md'), join(notesDir, from))
        return base.replaceIfAbsent!(from, to, expectedSource, content)
      },
    }
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc', prefix: '', files }],
      sql: createNodeSqliteDriver(':memory:'),
    })

    try {
      await store.list()
      await expect(
        store.write({ originalId: 'source.md', title: 'Source', content: 'app body' }),
      ).rejects.toBeTruthy()
      expect(readFileSync(join(notesDir, 'source.md'), 'utf8')).toBe(externalBytes)
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('does not delete a file that replaces the indexed note during removal', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-note-delete-race-'))
    writeFileSync(join(notesDir, 'source.md'), '---\ntitle: Source\n---\n\nsource body')
    const base = createLocalFsFiles(notesDir)
    const externalBytes = '---\ntitle: External\n---\n\nexternal body'
    const files: FileStore = {
      ...base,
      removeIfUnchanged: async (path, expectedContent) => {
        writeFileSync(join(notesDir, 'external.md'), externalBytes)
        renameSync(join(notesDir, 'external.md'), join(notesDir, path))
        return base.removeIfUnchanged!(path, expectedContent)
      },
    }
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc', prefix: '', files }],
      sql: createNodeSqliteDriver(':memory:'),
    })

    try {
      await store.list()
      await expect(store.remove('source.md')).rejects.toThrow(/changed during delete/i)
      expect(readFileSync(join(notesDir, 'source.md'), 'utf8')).toBe(externalBytes)
      expect((await store.list()).map((note) => note.filePath)).toEqual(['source.md'])
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('does not delete a non-regular replacement of the indexed note', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-note-delete-symlink-'))
    writeFileSync(join(notesDir, 'source.md'), '---\ntitle: Source\n---\n\nsource body')
    const store = createNotariumStore({ notesDir })

    try {
      await store.list()
      rmSync(join(notesDir, 'source.md'))
      symlinkSync('missing.md', join(notesDir, 'source.md'))

      await expect(store.remove('source.md')).rejects.toThrow(/changed during delete/i)
      expect(lstatSync(join(notesDir, 'source.md')).isSymbolicLink()).toBe(true)
      expect((await store.list()).map((note) => note.filePath)).toEqual(['source.md'])
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('does not delete a regular replacement installed before removal starts', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-note-delete-prior-race-'))
    writeFileSync(
      join(notesDir, 'source.md'),
      '---\ntitle: Source\nnotarium-id: ORIGINAL1234\n---\n\nsource body',
    )
    const store = createNotariumStore({ notesDir })
    const externalBytes = '---\ntitle: External\nnotarium-id: REPLACE12345\n---\n\nexternal body'

    try {
      await store.list()
      writeFileSync(join(notesDir, 'external.md'), externalBytes)
      renameSync(join(notesDir, 'external.md'), join(notesDir, 'source.md'))

      await expect(store.remove('source.md')).rejects.toThrow(/changed during delete/i)
      expect(readFileSync(join(notesDir, 'source.md'), 'utf8')).toBe(externalBytes)
      expect((await store.list()).map((note) => note.filePath)).toEqual(['source.md'])
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('fails closed when storage lacks conditional create and delete primitives', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-note-capabilities-'))
    writeFileSync(join(notesDir, 'source.md'), '---\ntitle: Source\n---\n\nsource body')
    const base = createLocalFsFiles(notesDir)
    const files: FileStore = {
      ...base,
      writeIfAbsent: undefined,
      replaceIfAbsent: undefined,
      removeIfUnchanged: undefined,
    }
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc', prefix: '', files }],
      sql: createNodeSqliteDriver(':memory:'),
    })

    try {
      await store.list()
      await expect(store.write({ title: 'Target', content: 'body' })).rejects.toThrow(
        /cannot create/i,
      )
      await expect(
        store.write({ originalId: 'source.md', title: 'Source', content: 'changed' }),
      ).rejects.toThrow(/cannot update/i)
      await expect(store.remove('source.md')).rejects.toThrow(/cannot delete/i)
      expect(readFileSync(join(notesDir, 'source.md'), 'utf8')).toContain('source body')
      expect(readdirSync(notesDir)).toEqual(['source.md'])
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })
})

describe('NotariumStore — literal SQL subtree paths', () => {
  it('moves and removes folders containing LIKE metacharacters without touching siblings', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-literal-subtree-'))

    mkdirSync(join(notesDir, 'a_b'), { recursive: true })
    mkdirSync(join(notesDir, 'axb'), { recursive: true })
    mkdirSync(join(notesDir, 'qXr'), { recursive: true })
    writeFileSync(join(notesDir, 'a_b/One.md'), '---\ntitle: One\n---\n\none')
    writeFileSync(join(notesDir, 'axb/Two.md'), '---\ntitle: Two\n---\n\ntwo')
    writeFileSync(join(notesDir, 'qXr/Other.md'), '---\ntitle: Other\n---\n\nother')
    const store = createNotariumStore({ notesDir })

    try {
      await store.list()
      await store.move({ id: 'a_b', destinationPath: 'q%r', isDirectory: true })
      expect((await store.list()).map((note) => note.filePath).sort()).toEqual([
        'axb/Two.md',
        'q%r/One.md',
        'qXr/Other.md',
      ])
      expect(readFileSync(join(notesDir, 'axb/Two.md'), 'utf8')).toContain('two')
      expect(readFileSync(join(notesDir, 'qXr/Other.md'), 'utf8')).toContain('other')

      await store.removeDir!('q%r')
      expect((await store.list()).map((note) => note.filePath).sort()).toEqual([
        'axb/Two.md',
        'qXr/Other.md',
      ])
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })
})

describe('NotariumStore — overwrite of non-note pathnames', () => {
  it('replaces a FIFO without trying to read or merge it', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-overwrite-fifo-'))

    execFileSync('mkfifo', [join(notesDir, 'target.md')])
    const store = createNotariumStore({ notesDir })

    try {
      const result = await store.write({
        title: 'Target',
        fileName: 'target',
        content: 'new body',
        ifExists: IF_EXISTS.overwrite,
      })

      expect(result.filePath).toBe('target.md')
      expect((await store.read('target.md')).content).toBe('new body')
    } finally {
      await store.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })
})
