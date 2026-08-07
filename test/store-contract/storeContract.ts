// One spec, many engines (P9): the executable contract of the KnowledgeStore
// port. Every implementation — InMemoryStore, NotariumStore, a future engine —
// must pass these IDENTICAL checks, so an engine gap is a known list of red
// tests, not a surprise.
//
// The spec is self-seeding: it writes its own notes into `directory` and
// removes them, so it needs no fixture and can run against a real backend.
// It asserts port semantics (shapes, invariants, normalisation), never
// engine-specific byte-level output — that's what would make a second engine
// unimplementable.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SyncStatusSchema } from '@notarium/contract'
import {
  encodeWikilinkIdentity,
  type ExportEntry,
  IF_EXISTS,
  type KnowledgeStore,
  type NoteMeta,
  STORE_ERROR_REASON,
} from '@notarium/core'

export type StoreFactory = () => Promise<{
  store: KnowledgeStore
  /** Directory the spec creates its notes in (kept isolated for live runs). */
  directory: string
  teardown?: () => Promise<void>
}>

export type ContractSpecOptions = {
  /** Per-test/hook timeout. A live engine over a real base needs far more than
   *  vitest's 5s default (a full list() sweep is seconds by itself). */
  timeout?: number
}

const baseName = (p: string) => p.split('/').pop() || p

/** Exported so a leg that must gate itself OUTSIDE this helper (see
 *  cachedNotariumVector.test.ts) names its skipped suite the same way this one does. */
export const CONTRACT_SUITE_PREFIX = 'KnowledgeStore contract — '

export const describeKnowledgeStoreContract = (
  name: string,
  factory: StoreFactory,
  { timeout = 5_000 }: ContractSpecOptions = {},
): void => {
  describe(`${CONTRACT_SUITE_PREFIX}${name}`, { timeout }, () => {
    let store: KnowledgeStore
    let dir: string
    let teardown: (() => Promise<void>) | undefined

    const TITLE_A = 'Contract Alpha'
    const TITLE_B = 'Contract Beta'
    const MARKER = 'spec marker prose for the contract suite'

    const byTitle = (notes: NoteMeta[], title: string) => notes.find((n) => n.title === title)
    /** The reference callers pass around: the note-id for identity-capable
     *  stores (what the wire requires), the storage path for bare
     *  engines (paths, not permalinks, are the engine-side key). */
    const idOf = (n: NoteMeta) => n.id ?? n.filePath

    beforeAll(async () => {
      ;({ store, directory: dir, teardown } = await factory())
    }, timeout)

    afterAll(async () => {
      // Best-effort: drop anything the spec left behind in its directory.
      try {
        for (const n of await store.list()) {
          if (n.filePath.startsWith(`${dir}/`)) {
            await store.remove(idOf(n))
          }
        }
      } catch {
        /* a failed run shouldn't fail again in cleanup */
      }
      await teardown?.()
    }, timeout)

    it('declares capabilities as booleans', () => {
      const c = store.capabilities

      for (const key of [
        'fts',
        'vector',
        'hybrid',
        'graphExpand',
        'identity',
        'cas',
        'revisions',
        'visibility',
      ] as const) {
        expect(typeof c[key]).toBe('boolean')
      }
    })

    it('rejects strings that cannot round-trip through UTF-8 and frontmatter', async () => {
      const lone = String.fromCharCode(0xd800)

      await expect(
        store.write({ title: `bad${lone}`, directory: dir, content: 'body' }),
      ).rejects.toMatchObject({ isToolError: true })
      await expect(
        store.write({ id: 'a\nb', title: 'Bad id', directory: dir, content: 'body' }),
      ).rejects.toMatchObject({ isToolError: true })
      expect((await store.list()).some((note) => note.title.startsWith('bad'))).toBe(false)
    })

    it('rejects non-canonical or hidden write destinations at the store boundary', async () => {
      for (const directory of [
        `${dir}/.lost`,
        `${dir}//duplicate`,
        `${dir}\\backslash`,
        `/absolute/${dir}`,
      ]) {
        await expect(
          store.write({ title: 'Unsafe Destination', directory, content: 'must not land' }),
        ).rejects.toMatchObject({ isToolError: true })
      }
      expect((await store.list()).some((note) => note.title === 'Unsafe Destination')).toBe(false)
    })

    it('write → list: both notes appear with full metadata', async () => {
      const a = await store.write({
        title: TITLE_A,
        directory: dir,
        content: `${MARKER}. Links to [[${TITLE_B}]].`,
      })
      expect(a.filePath).toBeTruthy()
      await store.write({ title: TITLE_B, directory: dir, content: 'The linked side.' })

      const notes = await store.list()

      for (const title of [TITLE_A, TITLE_B]) {
        const n = byTitle(notes, title)
        expect(n, `${title} should be listed`).toBeTruthy()
        expect(n!.filePath.startsWith(`${dir}/`)).toBe(true)
        // An identity-capable store stamps every listed note with its id.
        if (store.capabilities.identity) {
          expect(n!.id).toEqual(expect.any(String))
        }
        // Both date signals are present (ISO instants); either may be
        // honestly unknown.
        for (const value of [n!.modifiedAt, n!.createdAt]) {
          expect(value === null || !Number.isNaN(Date.parse(value))).toBe(true)
        }
      }
    })

    it('write → list: tags ride the listed NoteMeta — the snapshot tag axis', async () => {
      const TITLE = 'Tagged Note'
      await store.write({
        title: TITLE,
        directory: dir,
        content: 'has tags',
        tags: ['ML', 'ml/nlp'],
      })
      const n = byTitle(await store.list(), TITLE)
      expect(n, 'the tagged note is listed').toBeTruthy()
      // The engine surfaces the authored tags on the inventory row (original casing —
      // folding is read-time, never a rewrite). An untagged note carries none.
      expect(n!.tags).toEqual(['ML', 'ml/nlp'])
      await store.write({ title: 'Untagged', directory: dir, content: 'no tags' })
      const u = byTitle(await store.list(), 'Untagged')
      expect(u!.tags ?? []).toEqual([])
    })

    it('honors createdAt + fileName write channels — dates-as-data, deterministic path, idempotent identity', async () => {
      const FN = 'imported-fixed-name'
      const CREATED = '2019-03-04T08:00:00.000Z'
      const path = `${dir}/${FN}.md`
      const first = await store.write({
        title: 'Imported Note',
        directory: dir,
        content: 'imported body',
        fileName: FN,
        createdAt: CREATED,
      })
      // fileName overrides slug(title) → the note lands at the predicted path.
      expect(first.filePath).toBe(path)
      const n = (await store.list()).find((m) => m.filePath === path)
      expect(n, 'note lands at the fileName path').toBeTruthy()
      // Dated by when it happened (the createdAt channel), not "now".
      expect(n!.createdAt).toBe(CREATED)
      const firstId = n!.id

      // Re-import the SAME note (same fileName): `overwrite` — the one policy that
      // lets a create replace an occupied path — lands on the same file with no
      // duplicate, and an identity-capable surface keeps the id (idempotent).
      await store.write({
        title: 'Imported Note',
        directory: dir,
        content: 'imported body v2',
        fileName: FN,
        createdAt: CREATED,
        ifExists: IF_EXISTS.overwrite,
      })
      const atPath = (await store.list()).filter((m) => m.filePath === path)
      expect(atPath).toHaveLength(1)
      expect(atPath[0].createdAt).toBe(CREATED) // immutable across re-import
      if (store.capabilities.identity) {
        expect(atPath[0].id).toBe(firstId)
      }

      await store.remove(idOf(atPath[0]))
    })

    it('bounds a public explicit fileName to one filesystem component', async () => {
      const written = await store.write({
        title: 'Contract Long Filename',
        directory: dir,
        content: 'long filename body',
        fileName: '第'.repeat(100),
      })
      const basename = baseName(written.filePath!)

      expect(new TextEncoder().encode(basename).length).toBeLessThanOrEqual(255)
      expect((await store.read(written.id ?? written.filePath!)).content).toBe('long filename body')
      await store.remove(written.id ?? written.filePath!)
    })

    it('keeps Windows device names portable publicly but preserves frozen importer paths', async () => {
      const publicWrite = await store.write({
        title: 'Public Device Name',
        directory: dir,
        content: 'public',
        fileName: 'CON',
      })

      expect(baseName(publicWrite.filePath!)).toMatch(/^~con-[a-f0-9]+\.md$/)

      const legacyDirectory = `${dir}/con`
      const legacyInput = {
        title: 'Legacy Import Device Name',
        directory: legacyDirectory,
        fileName: 'NUL',
        legacyImportRoot: dir,
        ifExists: IF_EXISTS.overwrite,
      } as const
      const first = await store.write({ ...legacyInput, content: 'v1' })
      const second = await store.write({ ...legacyInput, content: 'v2' })

      expect(first.filePath).toBe(`${legacyDirectory}/nul.md`)
      expect(second.filePath).toBe(first.filePath)
      expect((await store.list()).filter((note) => note.filePath === first.filePath)).toHaveLength(
        1,
      )
      expect((await store.read(second.id ?? second.filePath!)).content).toBe('v2')

      await store.remove(publicWrite.id ?? publicWrite.filePath!)
      await store.remove(second.id ?? second.filePath!)
    })

    it('refuses a create onto an occupied path unless it asked to overwrite — the default is never clobber', async () => {
      const first = await store.write({
        title: 'Contract Occupied',
        directory: dir,
        content: 'the body that must survive',
      })
      const path = first.filePath!

      // No policy = refuse. The victim's bytes are untouched, so a second writer
      // cannot silently inherit its file (and its identity).
      await expect(
        store.write({ title: 'Contract Occupied', directory: dir, content: 'intruder' }),
      ).rejects.toMatchObject({ reason: STORE_ERROR_REASON.noteAlreadyExists, isToolError: true })
      // Spelling out `fail` is the same thing, not a stricter one.
      await expect(
        store.write({
          title: 'Contract Occupied',
          directory: dir,
          content: 'intruder',
          ifExists: IF_EXISTS.fail,
        }),
      ).rejects.toMatchObject({ reason: STORE_ERROR_REASON.noteAlreadyExists })
      expect(
        (await store.read(idOf(byTitle(await store.list(), 'Contract Occupied')!))).content,
      ).toBe('the body that must survive')
      expect((await store.list()).filter((m) => m.filePath === path)).toHaveLength(1)

      await store.remove(idOf(byTitle(await store.list(), 'Contract Occupied')!))
    })

    // ── A title in a script we cannot romanise must still name a FILE (#296). It
    //    used to slug to '' and land on `<dir>/.md` — a dot-file the scan hides, so
    //    the note vanished on the next boot while its bytes sat on disk, and every
    //    such title aimed at that ONE path, so the second create was refused as a
    //    duplicate of a visibly different note.
    it.each([
      { script: 'Chinese', title: '第三季度规划', other: '会议纪要草稿' },
      { script: 'Japanese', title: '会議の議事録', other: '設計メモ' },
      { script: 'Hebrew', title: 'תוכניות לרבעון', other: 'סיכום פגישה' },
      { script: 'Thai', title: 'แผนไตรมาส', other: 'บันทึกการประชุม' },
    ])(
      'names a file for a $script title, and two of them do not collide',
      async ({ title, other }) => {
        const a = await store.write({ title, directory: dir, content: 'first body' })
        // The whole defect in one assertion: a basename, and not a dot-file.
        const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
        expect(nameOf(a.filePath!)).not.toBe('.md')
        expect(nameOf(a.filePath!).startsWith('.')).toBe(false)

        // A DIFFERENT title in the same folder is a different note, not a collision.
        const b = await store.write({ title: other, directory: dir, content: 'second body' })
        expect(b.filePath).not.toBe(a.filePath)

        const listed = await store.list()
        expect(byTitle(listed, title)).toBeTruthy()
        expect(byTitle(listed, other)).toBeTruthy()
        expect((await store.read(idOf(byTitle(listed, title)!))).content).toBe('first body')
        expect((await store.read(idOf(byTitle(listed, other)!))).content).toBe('second body')

        await store.remove(idOf(byTitle(listed, title)!))
        await store.remove(idOf(byTitle(listed, other)!))
      },
    )

    it('names a file for a title with no letters at all (emoji), and keeps two apart', async () => {
      // Nothing in the title can name a file, so the id rung does — the fallback the
      // slug module has always promised and no caller implemented.
      const a = await store.write({ title: '🎉🎉', directory: dir, content: 'party' })
      const b = await store.write({ title: '✨✨', directory: dir, content: 'sparkle' })
      const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
      expect(nameOf(a.filePath!)).not.toBe('.md')
      expect(nameOf(a.filePath!).startsWith('.')).toBe(false)
      expect(b.filePath).not.toBe(a.filePath)

      const listed = await store.list()
      expect((await store.read(idOf(byTitle(listed, '🎉🎉')!))).content).toBe('party')
      expect((await store.read(idOf(byTitle(listed, '✨✨')!))).content).toBe('sparkle')

      await store.remove(idOf(byTitle(listed, '🎉🎉')!))
      await store.remove(idOf(byTitle(listed, '✨✨')!))
    })

    it('an unsluggable fileName falls back to the TITLE, not straight to the id', async () => {
      // The name rungs are ordered `fileName -> title -> id`, and an engine that folds
      // the first two together skips the middle one: a pinned fileName with nothing
      // sluggable in it would land on the id here while another engine still names the
      // file after a perfectly good title — two engines, two destinations, one write.
      const written = await store.write({
        title: 'Contract Fallback Title',
        directory: dir,
        content: 'body',
        fileName: '🎉',
      })
      expect(written.filePath).toBe(`${dir}/contract-fallback-title.md`)

      await store.remove(idOf(byTitle(await store.list(), 'Contract Fallback Title')!))
    })

    it('resolves a link to a note whose title has no letters at all', async () => {
      // Its file is named after the id, so nothing about the PATH says '🎉🎉' — the
      // title itself has to be a resolve key, or the note is unreachable by its own
      // name while a ghost stands in for it.
      await store.write({ title: '🎉🎉', directory: dir, content: 'party' })
      await store.write({
        title: 'Contract Emoji Linker',
        directory: dir,
        content: 'see [[🎉🎉]]',
      })
      const listed = await store.list()
      // The graph keys nodes the way the READ MODEL does — note-id where the engine has
      // one, storage path on a bare engine. A create's returned id is not that key: a
      // bare engine mints one for the file NAME (the id rung) without becoming
      // identity-capable, so ask the listing rather than the write result.
      const targetNode = idOf(byTitle(listed, '🎉🎉')!)
      const linkerId = idOf(byTitle(listed, 'Contract Emoji Linker')!)
      const graph = await store.graph()

      expect(graph.links.some((l) => l.source === linkerId && l.target === targetNode)).toBe(true)

      await store.remove(idOf(byTitle(listed, '🎉🎉')!))
      await store.remove(linkerId)
    })

    it('retires a letterless title into the alias history on rename', async () => {
      // The name is keyed raw (its slug is empty), and the alias axis has to use the
      // SAME key — keying on the bare slug drops such a name from the history, so every
      // inbound [[🎉🎉]] would break silently the moment the note is renamed.
      await store.write({ title: '🎉🎉', directory: dir, content: 'party' })
      const listed = await store.list()
      const noteRef = idOf(byTitle(listed, '🎉🎉')!)
      await store.write({
        originalId: noteRef,
        title: 'Renamed Party',
        content: 'party',
        versionToken: store.capabilities.cas ? (await store.read(noteRef)).versionToken : undefined,
      })
      const after = await store.list()
      const renamed = byTitle(after, 'Renamed Party')

      expect(renamed).toBeTruthy()
      expect((renamed!.aliases ?? []).some((a) => a.trim() === '🎉🎉')).toBe(true)

      await store.remove(idOf(renamed!))
    })

    it('resolves a letterless name on EVERY surface, not only in the graph', async () => {
      // The graph, the engine's own reference resolver and the client each keep a copy
      // of this rule, and a name the branch made addressable has to reach the note on
      // all of them: a link the graph draws as healthy, whose click 404s, sends the UI
      // to offer CREATING the note it just linked to.
      await store.write({ title: '🎉🎉', directory: dir, content: 'party' })
      const created = byTitle(await store.list(), '🎉🎉')!

      expect((await store.read('🎉🎉')).content).toBe('party')

      // …and it keeps resolving once the name is retired into the alias history.
      await store.write({
        originalId: idOf(created),
        title: 'Renamed Party',
        content: 'party',
        versionToken: store.capabilities.cas
          ? (await store.read(idOf(created))).versionToken
          : undefined,
      })
      expect((await store.read('🎉🎉')).content).toBe('party')

      await store.remove(idOf(byTitle(await store.list(), 'Renamed Party')!))
    })

    it('keeps two unresolvable multi-segment labels as two distinct ghosts', async () => {
      // Both slug to the bare separator '/', which is truthy — the guard has to test
      // whether any SEGMENT survived, or every such ghost merges into one node. Each
      // engine keeps its own copy of this resolution, so the contract pins both.
      await store.write({
        title: 'Contract Ghost Pair',
        directory: dir,
        content: 'see [[🎉/🚀]] and [[✨/💫]]',
      })
      const linkerId = idOf(byTitle(await store.list(), 'Contract Ghost Pair')!)
      const graph = await store.graph()
      const targets = graph.links.filter((l) => l.source === linkerId).map((l) => l.target)

      expect(new Set(targets).size).toBe(2)
      expect(targets).not.toContain('ghost:/')

      await store.remove(linkerId)
    })

    // #296 — a label whose LAST segment names nothing is NOT a lookup key. `namePathKey`
    // is empty for it by design, and both engines must decline to ask the index at all:
    // a title like `!/` registers the raw key `!/` through `nameKey`'s fallback rung, so
    // an engine that keys the lookup on the label's total form finds it while the other
    // serves a ghost. That divergence is invisible in a suite where only one engine runs
    // — the fake showed a healthy link for a link the shipped engine shows as broken,
    // and offered to CREATE a note that already exists.
    it('does not resolve a label whose last segment names nothing, on either engine', async () => {
      await store.write({ title: '!/', directory: dir, content: 'a real note with an odd name' })
      await store.write({
        title: 'Contract Slash Linker',
        directory: dir,
        content: 'see [[!/]] and [[journal/]]',
      })
      const linkerId = idOf(byTitle(await store.list(), 'Contract Slash Linker')!)
      const graph = await store.graph()
      const targets = graph.links.filter((l) => l.source === linkerId).map((l) => l.target)

      // Both are ghosts, and two DISTINCT ones — never a hit on the `!/` note.
      expect(targets.every((t) => String(t).startsWith('ghost:'))).toBe(true)
      expect(new Set(targets).size).toBe(2)

      await store.remove(linkerId)
      await store.remove(idOf(byTitle(await store.list(), '!/')!))
    })

    // #296 — the ghost's prefill must key BACK to the ghost's own last segment, or a note
    // created from it re-ghosts and the reader offers to create it again, forever. The
    // de-kebab that makes `dir/missing-note` read as "Missing Note" mangles a segment kept
    // raw: `🎉-🚀` would become `🎉 🚀`, which keys somewhere else entirely.
    it('prefills a path-form ghost with a title that keys back to it', async () => {
      await store.write({
        title: 'Contract Prefill Linker',
        directory: dir,
        content: 'see [[somewhere/🎉-🚀]]',
      })
      const linkerId = idOf(byTitle(await store.list(), 'Contract Prefill Linker')!)
      const graph = await store.graph()
      const ghost = graph.nodes.find((n) => n.ghost && String(n.id).includes('🎉'))

      expect(ghost && 'prefillTitle' in ghost ? ghost.prefillTitle : undefined).toBe('🎉-🚀')

      await store.remove(linkerId)
    })

    it('resolves a wikilink written in an unromanisable script to its note', async () => {
      // Both labels used to slug to the empty key, so the whole non-Latin corpus
      // shared one index entry and the graph showed one ghost for all of them.
      const title = '第三季度规划'
      const target = await store.write({ title, directory: dir, content: 'target body' })
      await store.write({
        title: 'Linker CJK',
        directory: dir,
        content: `points to [[${title}]].`,
      })
      const listed = await store.list()
      const targetNode = target.id ?? idOf(byTitle(listed, title)!)
      const linkerNode = idOf(byTitle(listed, 'Linker CJK')!)
      const graph = await store.graph()

      expect(graph.links.some((l) => l.source === linkerNode && l.target === targetNode)).toBe(true)
      expect(graph.nodes.some((n) => n.id === 'ghost:')).toBe(false)

      await store.remove(idOf(byTitle(listed, title)!))
      await store.remove(linkerNode)
    })

    it('honours an explicit fileName on edit (opt-in basename), keeps a note put on a same-basename touch, folder pages keep index.md', async () => {
      const tokenFor = async (ref: string): Promise<string | undefined> =>
        store.capabilities.cas ? (await store.read(ref)).versionToken : undefined

      // (1) An ordinary edit passing an explicit fileName now MOVES to that basename (opt-in,
      // the metadata pult hands the CURRENT basename to keep a note put, so the engine
      // must honour fileName on edit rather than always re-deriving it from slug(title).
      const ordinary = await store.write({
        title: 'Filename Ordinary Source',
        directory: dir,
        content: 'body',
      })
      const ordinaryId = ordinary.id ?? ordinary.filePath!
      const renamed = await store.write({
        title: 'Filename Ordinary Target',
        directory: dir,
        content: 'body v2',
        originalId: ordinaryId,
        versionToken: await tokenFor(ordinaryId),
        fileName: 'explicit-basename',
      })
      expect(renamed.filePath).toBe(`${dir}/explicit-basename.md`)
      await store.remove(renamed.id ?? renamed.filePath!)

      // (2) An edit WITHOUT fileName still derives the basename from slug(title) — the default
      // rename channel is unchanged.
      const slugSrc = await store.write({
        title: 'Filename Slug Source',
        directory: dir,
        content: 'b',
      })
      const slugId = slugSrc.id ?? slugSrc.filePath!
      const slugged = await store.write({
        title: 'Filename Slug Target',
        directory: dir,
        content: 'b2',
        originalId: slugId,
        versionToken: await tokenFor(slugId),
      })
      expect(slugged.filePath).toBe(`${dir}/filename-slug-target.md`)
      await store.remove(slugged.id ?? slugged.filePath!)

      // (3) Load-bearing: a note whose basename DIVERGES from slug(title) (a seeded /
      // imported file). A metadata/content touch with the same title+folder has NO
      // move intent, even when it omits fileName; it keeps the path and id. Runs
      // against BOTH engines via this shared spec.
      const seededPath = `${dir}/legacy-basename.md`
      const seeded = await store.write({
        title: 'Pinned Note Title',
        directory: dir,
        fileName: 'legacy-basename',
        content: 'x',
      })
      expect(seeded.filePath).toBe(seededPath)
      const seededId = seeded.id ?? seeded.filePath!
      const pinned = await store.write({
        title: 'Pinned Note Title',
        directory: dir,
        content: 'x',
        originalId: seededId,
        versionToken: await tokenFor(seededId),
        fileName: 'legacy-basename',
        tags: ['always-load'],
      })
      expect(pinned.filePath).toBe(seededPath) // pin did not move the file
      if (store.capabilities.identity) {
        expect(pinned.id ?? pinned.filePath).toBe(seededId)
      }
      const unpinned = await store.write({
        title: 'Pinned Note Title',
        directory: dir,
        content: 'x',
        originalId: seededId,
        versionToken: await tokenFor(seededId),
        tags: [],
      })
      expect(unpinned.filePath).toBe(seededPath) // omitted fileName still stays put
      await store.remove(unpinned.id ?? unpinned.filePath!)

      // (4) Folder-page carve-out unchanged: an index.md page ignores a divergent fileName on
      // edit (the folder-page basename is structural, not user-chosen).
      const pageDir = `${dir}/folder-page-preserve`
      const page = await store.write({
        title: 'Folder Page Original',
        directory: pageDir,
        fileName: 'index',
        content: 'page body',
      })
      expect(page.filePath).toBe(`${pageDir}/index.md`)
      const pageId = page.id ?? page.filePath!
      const pageRenamed = await store.write({
        title: 'Folder Page Renamed',
        directory: pageDir,
        content: 'page body v2',
        originalId: pageId,
        versionToken: await tokenFor(pageId),
        fileName: 'wrong-fixed-name',
      })
      expect(pageRenamed.filePath).toBe(`${pageDir}/index.md`)
      await store.remove(pageRenamed.id ?? pageRenamed.filePath!)
    })

    it('authored createdAt edit overwrites the date; read serves it; a plain edit preserves it', async () => {
      const tokenFor = async (ref: string): Promise<string | undefined> =>
        store.capabilities.cas ? (await store.read(ref)).versionToken : undefined
      const ORIG = '2020-01-01T00:00:00.000Z'
      const NEW = '2018-06-15T00:00:00.000Z'
      const w = await store.write({
        title: 'Date Edit',
        directory: dir,
        content: 'body',
        createdAt: ORIG,
      })
      const id = w.id ?? idOf(byTitle(await store.list(), 'Date Edit')!)
      expect(byTitle(await store.list(), 'Date Edit')!.createdAt).toBe(ORIG)
      // read() serves the date so the editor can prefill its field.
      expect((await store.read(id)).createdAt).toBe(ORIG)

      // A plain body edit (no createdAt) keeps the date — three-state carry-forward.
      await store.write({
        title: 'Date Edit',
        directory: dir,
        content: 'body v2',
        originalId: id,
        versionToken: await tokenFor(id),
      })
      expect(byTitle(await store.list(), 'Date Edit')!.createdAt).toBe(ORIG)

      // An authored edit OVERWRITES it (the authored-date channel) — visible in the index AND
      // on the read view, so the Feed (Created) re-files the note.
      await store.write({
        title: 'Date Edit',
        directory: dir,
        content: 'body v2',
        originalId: id,
        versionToken: await tokenFor(id),
        createdAt: NEW,
      })
      expect(byTitle(await store.list(), 'Date Edit')!.createdAt).toBe(NEW)
      expect((await store.read(id)).createdAt).toBe(NEW)

      await store.remove(id)
    })

    it('a note dated by birthtime keeps its date across a plain edit — no createdAt flap', async () => {
      const tokenFor = async (ref: string): Promise<string | undefined> =>
        store.capabilities.cas ? (await store.read(ref)).versionToken : undefined
      // Created WITHOUT an authored date — the engine dates it (birthtime / now).
      const w = await store.write({ title: 'Birthtime Note', directory: dir, content: 'b' })
      const id = w.id ?? idOf(byTitle(await store.list(), 'Birthtime Note')!)
      // Capture each surface's date SEPARATELY: a birthtime-dated note's list date
      // (the read-model's snapshot clock) and its read date (the engine's file
      // birthtime) legitimately differ by a few ms — two clocks for the same "now",
      // a pre-existing property. The invariant under test is NO FLAP: a plain
      // body edit must not MOVE either surface's date (COALESCE(claim, existing) on
      // the index UPDATE + the three-state carry-forward — a regression re-stamps it).
      const listCreated0 = byTitle(await store.list(), 'Birthtime Note')!.createdAt
      const readCreated0 = (await store.read(id)).createdAt
      await store.write({
        title: 'Birthtime Note',
        directory: dir,
        content: 'b v2',
        originalId: id,
        versionToken: await tokenFor(id),
      })
      expect(byTitle(await store.list(), 'Birthtime Note')!.createdAt).toBe(listCreated0)
      expect((await store.read(id)).createdAt).toBe(readCreated0)
      await store.remove(id)
    })

    it('read by note-id resolves and echoes the id (identity stores)', async () => {
      if (!store.capabilities.identity) {
        return
      }
      const a = byTitle(await store.list(), TITLE_A)!
      const detail = await store.read(a.id!)
      expect(detail.content).toContain(MARKER)
      expect(detail.id).toBe(a.id)
    })

    it('read: normalised body (no duplicate title H1) + frontmatter object', async () => {
      const a = byTitle(await store.list(), TITLE_A)!
      const detail = await store.read(idOf(a))
      expect(detail.content).toContain(MARKER)
      // The title reaches the UI as a separate field; a stored "# <title>"
      // heading must not leak into the body.
      expect(detail.content.trimStart().startsWith(`# ${TITLE_A}`)).toBe(false)
      expect(detail.frontmatter).toBeTypeOf('object')
    })

    it('summary + tags carry forward on a body overwrite; summary "" clears', async () => {
      const TITLE_SUM = 'Contract Summary'
      const created = await store.write({
        title: TITLE_SUM,
        directory: dir,
        content: 'first observation.',
        summary: 'a short digest',
        tags: ['mem', 'keep'],
      })
      const id = created.id ?? idOf(byTitle(await store.list(), TITLE_SUM)!)

      try {
        const read1 = await store.read(id)

        // Engines that don't model frontmatter ignore summary — honest skip.
        if (read1.frontmatter?.summary !== 'a short digest') {
          return
        }
        // A body overwrite that OMITS summary AND tags preserves BOTH — the
        // carry-forward semantic the semantic ops rely on. An omitted field
        // must not silently clear; the two engines must agree on this.
        await store.write({
          title: TITLE_SUM,
          directory: dir,
          content: 'first observation.\n\nsecond observation.',
          originalId: id,
          versionToken: read1.versionToken,
        })
        const read2 = await store.read(id)
        expect(read2.frontmatter?.summary).toBe('a short digest')
        expect(read2.frontmatter?.tags).toEqual(['mem', 'keep'])
        expect(read2.content).toContain('second observation')
        // A PROVIDED summary updates it.
        await store.write({
          title: TITLE_SUM,
          directory: dir,
          content: read2.content,
          originalId: id,
          versionToken: read2.versionToken,
          summary: 'an updated digest',
        })
        const read3 = await store.read(id)
        expect(read3.frontmatter?.summary).toBe('an updated digest')
        // An empty-string summary CLEARS it (explicit), reading back as absent on
        // both engines.
        await store.write({
          title: TITLE_SUM,
          directory: dir,
          content: read3.content,
          originalId: id,
          versionToken: read3.versionToken,
          summary: '',
        })
        expect((await store.read(id)).frontmatter?.summary).toBeUndefined()
      } finally {
        // Leave the spec's directory as we found it (the remove test asserts empty).
        const n = byTitle(await store.list(), TITLE_SUM)

        if (n) {
          await store.remove(idOf(n))
        }
      }
    })

    it('search finds a written note', async () => {
      const results = await store.search(TITLE_A)
      const a = byTitle(await store.list(), TITLE_A)!
      expect(results.some((r) => r.filePath === a.filePath || (a.id && r.id === a.id))).toBe(true)
      for (const r of results) {
        expect(typeof r.snippet).toBe('string')
      }
    })

    it('preview derives from the note body', async () => {
      const a = byTitle(await store.list(), TITLE_A)!
      const s = await store.preview(idOf(a))
      expect(s.snippet).toContain(MARKER)
      expect(Array.isArray(s.tags)).toBe(true)
      expect(typeof s.words).toBe('number')
      expect(s.image === null || typeof s.image === 'string').toBe(true)
    })

    it('previews resolves a batch and respects an aborted signal', async () => {
      const notes = await store.list()
      const a = byTitle(notes, TITLE_A)!
      const b = byTitle(notes, TITLE_B)!
      const batch = await store.previews([idOf(a), idOf(b)])
      expect(batch[idOf(a)]?.snippet).toContain(MARKER)
      expect(batch[idOf(b)]).toBeTruthy()
      // A pre-aborted signal yields nothing — the engine must not be consulted.
      const aborted = new AbortController()
      aborted.abort()
      expect(await store.previews([idOf(a)], { signal: aborted.signal })).toEqual({})
    })

    it('previewPeek is cache-only: a warm value or an honest null, never a hang', async () => {
      const a = byTitle(await store.list(), TITLE_A)!
      const peek = store.previewPeek(idOf(a))
      // Engines that derive from memory answer; remote engines honestly don't.
      expect(peek === null || typeof peek.snippet === 'string').toBe(true)
      // After an explicit preview() the peek of a caching store must warm up —
      // but a stateless engine may still return null; both are legal. Just
      // assert the call is safe and synchronous.
      await store.preview(idOf(a))
      const after = store.previewPeek(idOf(a))
      expect(after === null || after.snippet.includes(MARKER)).toBe(true)
    })

    it('changes(null) establishes a cursor and reports the full inventory', async () => {
      const delta = await store.changes(null)
      expect(delta.cursor).toEqual(expect.any(String))
      expect(Array.isArray(delta.upserts)).toBe(true)
      // The inventory is the FULL population (all classes) — it's the sync
      // surface the read-model reconciles from, not a user surface. Parity is
      // against list({scope:'all'}), since default list() now hides agent-memory
      //: inventory == list(all), and list(user) ⊆ inventory.
      const inventoryIds = new Set(delta.inventory.map((n) => n.filePath))
      const listAllIds = new Set((await store.list({ scope: 'all' })).map((n) => n.filePath))
      expect(inventoryIds).toEqual(listAllIds)
    })

    it('syncStatus matches the wire schema', async () => {
      expect(SyncStatusSchema.safeParse(await store.syncStatus()).success).toBe(true)
    })

    it('graph resolves the [[wikilink]] into an edge between the two notes', async () => {
      const notes = await store.list()
      const a = byTitle(notes, TITLE_A)!
      const b = byTitle(notes, TITLE_B)!
      const g = await store.graph()
      expect(g.nodes.some((n) => n.id === idOf(a))).toBe(true)
      expect(g.nodes.some((n) => n.id === idOf(b))).toBe(true)
      expect(g.links.some((l) => l.source === idOf(a) && l.target === idOf(b))).toBe(true)
    })

    it('resolves an ambiguous current title to the same note in graph and direct read', async () => {
      const title = 'Contract Shared Title'
      const first = await store.write({
        title,
        directory: `${dir}/a`,
        content: 'first namesake',
      })
      const second = await store.write({
        title,
        directory: `${dir}/b`,
        content: 'second namesake',
      })
      const linker = await store.write({
        title: 'Contract Namesake Linker',
        directory: dir,
        content: `see [[${title}]]`,
      })

      const direct = await store.read(title)
      const directId = direct.id ?? direct.filePath!
      const linkerId = linker.id ?? linker.filePath!
      const edge = (await store.graph()).links.find((l) => l.source === linkerId)

      expect(edge?.target).toBe(directId)

      await store.remove(linkerId)
      await store.remove(first.id ?? first.filePath!)
      await store.remove(second.id ?? second.filePath!)
    })

    it('an authored stable-id link keeps the selected namesake through rename', async () => {
      if (!store.capabilities.identity) {
        return
      }
      const title = 'Contract Identity Namesake'
      const first = await store.write({ title, directory: `${dir}/id-a`, content: 'first' })
      const selected = await store.write({ title, directory: `${dir}/id-b`, content: 'selected' })
      const linker = await store.write({
        title: 'Contract Identity Linker',
        directory: dir,
        content: `see [[${encodeWikilinkIdentity(selected.id!)}|${title}]]`,
      })
      const edgeToSelected = async () =>
        (await store.graph()).links.some((l) => l.source === linker.id && l.target === selected.id)

      expect(await edgeToSelected()).toBe(true)
      await store.write({
        originalId: selected.id,
        title: 'Contract Renamed Identity',
        content: 'selected',
        versionToken: store.capabilities.cas
          ? (await store.read(selected.id!)).versionToken
          : undefined,
      })
      expect(await edgeToSelected()).toBe(true)

      await store.remove(linker.id!)
      await store.remove(first.id!)
      await store.remove(selected.id!)
    })

    it('keeps a literal `.md` inside a noncanonical identity envelope opaque', async () => {
      if (!store.capabilities.identity) {
        return
      }
      const plain = await store.write({
        id: 'contract-opaque-id',
        title: 'Contract Plain Identity',
        directory: dir,
        content: 'plain',
      })
      const dotted = await store.write({
        id: 'contract-opaque-id.md',
        title: 'Contract Dotted Identity',
        directory: dir,
        content: 'dotted',
      })
      const address = 'notarium-id:contract-opaque-id.md'
      const linker = await store.write({
        title: 'Contract Opaque Identity Linker',
        directory: dir,
        content: `[[${address}|dotted]]`,
      })

      expect((await store.read(address)).id).toBe(dotted.id)
      expect((await store.graph()).links).toContainEqual(
        expect.objectContaining({ source: linker.id, target: dotted.id }),
      )

      await store.remove(linker.id!)
      await store.remove(plain.id!)
      await store.remove(dotted.id!)
    })

    it('write with originalId renames in place instead of duplicating, keeping the id', async () => {
      const before = await store.list()
      const a = byTitle(before, TITLE_A)!
      const renamed = `${TITLE_A} Two`
      const r = await store.write({
        title: renamed,
        directory: dir,
        content: `${MARKER}. Links to [[${TITLE_B}]].`,
        originalId: idOf(a),
        // CAS-capable stores demand the token the read answered; a bare
        // engine ignores the extra field.
        versionToken: store.capabilities.cas ? (await store.read(idOf(a))).versionToken : undefined,
      })
      const after = await store.list()
      expect(byTitle(after, renamed)).toBeTruthy()
      expect(byTitle(after, TITLE_A)).toBeFalsy()
      // Same population: renamed, not duplicated.
      const inDir = (ns: NoteMeta[]) => ns.filter((n) => n.filePath.startsWith(`${dir}/`)).length
      expect(inDir(after)).toBe(inDir(before))
      // P7: the identity survives the rename — same id, new path.
      if (store.capabilities.identity) {
        expect(r.id).toBe(a.id)
        expect(byTitle(after, renamed)!.id).toBe(a.id)
      }
    })

    // ── Alias-history on rename: renaming a note records its old title as
    //    an alias, so inbound [[Old Title]] keep resolving — in the GRAPH (real
    //    edge, not a ghost) AND by the wiki-link resolver channel (read by old
    //    name). Cyrillic + camelCase are the painful cases: the resolver slug
    //    must transliterate ('Королёв') and camelCase-split ('BookStack') the
    //    SAME way on every engine (the in-memory fake now shares core slugify).
    describe.each([
      { kind: 'cyrillic', oldTitle: 'Королёв', newTitle: 'Гагарин' },
      { kind: 'camelCase', oldTitle: 'BookStack', newTitle: 'Reading List' },
    ])('rename keeps inbound links resolving — $kind', ({ oldTitle, newTitle }) => {
      const linkerTitle = `Linker ${oldTitle}`
      const tokenFor = async (ref: string): Promise<string | undefined> =>
        store.capabilities.cas ? (await store.read(ref)).versionToken : undefined

      it('records the old title as an alias and resolves it id-first', async () => {
        // Seed: a target note + a note linking it by its CURRENT title.
        const target = await store.write({
          title: oldTitle,
          directory: dir,
          content: 'target body',
        })
        const targetId = target.id ?? idOf(byTitle(await store.list(), oldTitle)!)
        await store.write({
          title: linkerTitle,
          directory: dir,
          content: `points to [[${oldTitle}]].`,
        })
        const linkerId = (await store.list()).find(
          (n) => n.title === linkerTitle && n.filePath.startsWith(`${dir}/`),
        )!
        const linkRef = idOf(linkerId)

        // Before the rename the edge is real (sanity on the seed).
        const before = await store.graph()
        const targetNodeBefore = idOf(byTitle(await store.list(), oldTitle)!)
        expect(
          before.links.some((l) => l.source === linkRef && l.target === targetNodeBefore),
        ).toBe(true)

        // Rename the target. Its body is unchanged; only the title moves.
        await store.write({
          title: newTitle,
          directory: dir,
          content: 'target body',
          originalId: targetId,
          versionToken: await tokenFor(targetId),
        })

        const after = await store.list()
        const renamed = byTitle(after, newTitle)
        expect(renamed).toBeTruthy()
        expect(byTitle(after, oldTitle)).toBeFalsy() // truly renamed, not duplicated
        // Identity survives; the old title is now in the alias-history.
        if (store.capabilities.identity) {
          expect(idOf(renamed!)).toBe(targetId)
        }
        expect(renamed!.aliases ?? []).toContain(oldTitle)

        // (1) GRAPH: the linker's [[Old Title]] still resolves to a REAL edge
        //     (its body was never touched), not a ghost.
        const g = await store.graph()
        const targetNode = idOf(renamed!)
        expect(g.links.some((l) => l.source === linkRef && l.target === targetNode)).toBe(true)
        expect(g.nodes.find((n) => n.id === targetNode)?.ghost).toBeFalsy()

        // (2) WIKI-LINK RESOLVER CHANNEL: reading by the OLD name resolves to the
        //     same note (the alias channel), id intact.
        const byOldName = await store.read(oldTitle)

        if (store.capabilities.identity) {
          expect(byOldName.id).toBe(targetId)
        }
        expect(byOldName.title).toBe(newTitle)

        // (3) COLLISION RULE (current > alias): a NEW live note re-claiming the
        //     freed old name must WIN over the renamed note's alias on the resolver
        //     channel — a live note is never shadowed by another note's stale alias.
        //     (The graph EDGE moving off the aliased note onto the newcomer is the
        //     read-model's incremental-edge concern, healed on the linker's next
        //     re-derive, not a port-level invariant — buildLinkIndex's two-pass
        //     collision rule is unit-tested in graph.test.ts.)
        const fresh = await store.write({
          title: oldTitle,
          directory: dir,
          content: 'newcomer body',
        })
        const freshId = fresh.id ?? idOf(byTitle(await store.list(), oldTitle)!)
        const reread = await store.read(oldTitle)

        if (store.capabilities.identity) {
          expect(reread.id).toBe(freshId)
        }
        expect(reread.content).toContain('newcomer body')

        // Cleanup this case's notes.
        await store.remove(targetId)
        await store.remove(linkRef)
        await store.remove(freshId)
      })
    })

    // ── Editable slug: a custom `slug:` is a display/URL name decoupled
    //    from the title AND the storage filename. It round-trips on read, is a
    //    current resolve name ([[slug]] reaches the note), stays IMPLICIT when it
    //    equals slug(title) (lazy), and — like a title rename — retires its old
    //    form into the alias-history when changed, so [[old-slug]] keeps resolving.
    describe('editable slug', () => {
      const tokenFor = async (ref: string): Promise<string | undefined> =>
        store.capabilities.cas ? (await store.read(ref)).versionToken : undefined

      it('round-trips a custom slug, resolves [[slug]], and keeps it across a body edit', async () => {
        const created = await store.write({
          title: 'Quarterly Report',
          directory: dir,
          content: 'body',
          slug: 'q3',
        })
        const id = created.id ?? idOf(byTitle(await store.list(), 'Quarterly Report')!)
        // Served on read AND surfaced in the inventory (so the wire/index see it).
        expect((await store.read(id)).slug).toBe('q3')
        expect(byTitle(await store.list(), 'Quarterly Report')!.slug).toBe('q3')
        // The slug is a current resolve name — reading by it finds the note.
        const bySlug = await store.read('q3')

        if (store.capabilities.identity) {
          expect(bySlug.id).toBe(id)
        }
        // A body edit that doesn't address slug leaves it intact (carry-forward).
        await store.write({
          title: 'Quarterly Report',
          directory: dir,
          content: 'edited',
          originalId: id,
          versionToken: await tokenFor(id),
        })
        expect((await store.read(id)).slug).toBe('q3')
        await store.remove(id)
      })

      it('a slug equal to slug(title) stays implicit — lazy, not stored', async () => {
        const created = await store.write({
          title: 'Plain Note',
          directory: dir,
          content: 'b',
          slug: 'Plain Note',
        })
        const id = created.id ?? idOf(byTitle(await store.list(), 'Plain Note')!)
        // slug(title) is the default — no `slug:` is written, so read reports none.
        expect((await store.read(id)).slug).toBeUndefined()
        await store.remove(id)
      })

      it('changing the slug records the old one as an alias so [[old-slug]] still resolves', async () => {
        const created = await store.write({
          title: 'Doc',
          directory: dir,
          content: 'b',
          slug: 'old-slug',
        })
        const id = created.id ?? idOf(byTitle(await store.list(), 'Doc')!)
        await store.write({
          title: 'Doc',
          directory: dir,
          content: 'b',
          slug: 'new-slug',
          originalId: id,
          versionToken: await tokenFor(id),
        })
        const after = byTitle(await store.list(), 'Doc')!
        expect(after.slug).toBe('new-slug')
        expect(after.aliases ?? []).toContain('old-slug') // the old slug joined the history
        // The OLD slug still resolves (alias channel), the NEW one is current.
        const byOld = await store.read('old-slug')

        if (store.capabilities.identity) {
          expect(byOld.id).toBe(id)
        }
        expect((await store.read('new-slug')).slug).toBe('new-slug')
        await store.remove(id)
      })

      it('a custom slug never out-resolves another live note’s title (current > slug)', async () => {
        // B is created FIRST with a custom slug equal to A's eventual title-slug —
        // so neither soft-uniquing (B had no rival yet) nor A's create (no custom
        // slug) suffixes it, and the two collide on the key 'alpha-note'.
        const b = await store.write({
          title: 'Bravo',
          directory: dir,
          content: 'b-body',
          slug: 'alpha-note',
        })
        const bId = b.id ?? idOf(byTitle(await store.list(), 'Bravo')!)
        const a = await store.write({ title: 'Alpha Note', directory: dir, content: 'a-body' })
        const aId = a.id ?? idOf(byTitle(await store.list(), 'Alpha Note')!)
        // Reading the shared key resolves to A (its live TITLE), not B's custom slug.
        const hit = await store.read('alpha-note')

        if (store.capabilities.identity) {
          expect(hit.id).toBe(aId)
        }
        expect(hit.content).toContain('a-body')
        await store.remove(aId)
        await store.remove(bId)
      })

      it('a simultaneous title+slug change retires BOTH old names as aliases', async () => {
        const created = await store.write({
          title: 'Old Title',
          directory: dir,
          content: 'b',
          slug: 'old-slug',
        })
        const id = created.id ?? idOf(byTitle(await store.list(), 'Old Title')!)
        await store.write({
          title: 'New Title',
          directory: dir,
          content: 'b',
          slug: 'fresh-slug',
          originalId: id,
          versionToken: await tokenFor(id),
        })
        const after = byTitle(await store.list(), 'New Title')!
        const aliases = after.aliases ?? []
        expect(aliases).toContain('Old Title') // old title retired
        expect(aliases).toContain('old-slug') // old slug retired too
        // A→B→A on the slug axis: returning to 'old-slug' drops it from history.
        await store.write({
          title: 'New Title',
          directory: dir,
          content: 'b',
          slug: 'old-slug',
          originalId: id,
          versionToken: await tokenFor(id),
        })
        const back = byTitle(await store.list(), 'New Title')!
        expect(back.slug).toBe('old-slug')
        expect(back.aliases ?? []).not.toContain('old-slug') // no stale self-alias
        await store.remove(id)
      })
    })

    it("ifExists:'fail' refuses a same-titled create instead of overwriting it", async () => {
      const TITLE_X = 'Contract Exists Guard'
      const created = await store.write({
        title: TITLE_X,
        directory: dir,
        content: 'original body, must survive.',
      })
      const id = created.id ?? idOf(byTitle(await store.list(), TITLE_X)!)

      try {
        // A plain create on the same slug(title) UPSERTS by path on purpose (UI
        // re-save inherits the id, retry-dedup leans on it). ifExists:'fail'
        // opts an intent-create OUT of that — it must refuse, not clobber.
        let threw = false

        try {
          await store.write({
            title: TITLE_X,
            directory: dir,
            content: 'CLOBBER',
            ifExists: 'fail',
          })
        } catch (err) {
          threw = true
          expect((err as { isToolError?: boolean; reason?: string }).isToolError).toBe(true)
          expect((err as { reason?: string }).reason).toBe('note_already_exists')
        }
        // An engine that doesn't model the create-collision guard upserts —
        // honest skip, like the carry-forward spec above.
        if (!threw) {
          return
        }
        // The original note survived untouched: same id, original body.
        const after = byTitle(await store.list(), TITLE_X)!

        if (store.capabilities.identity) {
          expect(idOf(after)).toBe(id)
        }
        const live = await store.read(id)
        expect(live.content).toContain('original body')
        expect(live.content).not.toContain('CLOBBER')
      } finally {
        const n = byTitle(await store.list(), TITLE_X)

        if (n) {
          await store.remove(idOf(n))
        }
      }
    })

    // ── Optimistic writes (P3): the compare-and-swap every CAS-capable
    //    store must enforce identically. Self-seeded on its own note so the
    //    scenarios stay independent of the rename/move journey above.
    describe('optimistic write (CAS)', () => {
      const TITLE_C = 'Contract Gamma'

      it('read answers a versionToken; a save echoing it succeeds and returns a fresh one', async () => {
        if (!store.capabilities.cas) {
          return
        }
        await store.write({ title: TITLE_C, directory: dir, content: 'first body' })
        const c = byTitle(await store.list(), TITLE_C)!
        const detail = await store.read(idOf(c))
        expect(detail.versionToken).toEqual(expect.any(String))
        const saved = await store.write({
          title: TITLE_C,
          directory: dir,
          content: 'second body',
          originalId: idOf(c),
          versionToken: detail.versionToken,
        })
        expect(saved.versionToken).toEqual(expect.any(String))
        // The fresh token matches what the next read hands out — a client can
        // chain save → save without an interim read.
        expect((await store.read(idOf(c))).versionToken).toBe(saved.versionToken)
      })

      it('update without a token is rejected, nothing written (strict — UI and agents alike)', async () => {
        if (!store.capabilities.cas) {
          return
        }
        const c = byTitle(await store.list(), TITLE_C)!
        await expect(
          store.write({ title: TITLE_C, directory: dir, content: 'sneaky', originalId: idOf(c) }),
        ).rejects.toMatchObject({ isToolError: true, reason: 'version_token_required' })
        expect((await store.read(idOf(c))).content).toContain('second body')
      })

      it('stale token → conflict carrying the live note + fresh token; the other write survives', async () => {
        if (!store.capabilities.cas) {
          return
        }
        const c = byTitle(await store.list(), TITLE_C)!
        const mine = await store.read(idOf(c))
        // Someone else (second tab, agent, external edit) writes between my
        // read and my save.
        const theirs = await store.write({
          title: TITLE_C,
          directory: dir,
          content: 'their body',
          originalId: idOf(c),
          versionToken: mine.versionToken,
        })
        let conflict: unknown

        try {
          await store.write({
            title: TITLE_C,
            directory: dir,
            content: 'my body',
            originalId: idOf(c),
            versionToken: mine.versionToken,
          })
        } catch (err) {
          conflict = err
        }
        expect(conflict).toMatchObject({ isConflict: true, reason: 'version_conflict' })
        const current = (conflict as { current?: { content: string; versionToken: string } })
          .current
        // P3 in error form: the loser GETS the winning side, nothing vanishes.
        expect(current?.content).toContain('their body')
        expect(current?.versionToken).toBe(theirs.versionToken)
        expect((await store.read(idOf(c))).content).toContain('their body')
        // Re-sending with the token from the conflict is the explicit
        // "I saw it, overwrite" — and it goes through.
        const overwritten = await store.write({
          title: TITLE_C,
          directory: dir,
          content: 'my body, deliberately',
          originalId: idOf(c),
          versionToken: current!.versionToken,
        })
        expect(overwritten.versionToken).toEqual(expect.any(String))
        expect((await store.read(idOf(c))).content).toContain('my body, deliberately')
      })

      it('update of a note deleted underneath is an honest not-found, never a silent re-create', async () => {
        if (!store.capabilities.cas) {
          return
        }
        const c = byTitle(await store.list(), TITLE_C)!
        const token = (await store.read(idOf(c))).versionToken
        await store.remove(idOf(c))
        await expect(
          store.write({
            title: TITLE_C,
            directory: dir,
            content: 'ghost write',
            originalId: idOf(c),
            versionToken: token,
          }),
        ).rejects.toMatchObject({ isNotFound: true })
        expect(byTitle(await store.list(), TITLE_C)).toBeFalsy()
      })
    })

    it('move relocates a note to a subdirectory, keeping the id', async () => {
      const a = byTitle(await store.list(), `${TITLE_A} Two`)!
      const dest = `${dir}/sub/${baseName(a.filePath)}`
      await store.move({ id: idOf(a), destinationPath: dest })
      const after = await store.list()
      const moved = after.find((n) => n.filePath === dest)
      expect(moved).toBeTruthy()
      expect(after.some((n) => n.filePath === a.filePath)).toBe(false)
      if (store.capabilities.identity) {
        expect(moved!.id).toBe(a.id)
      }
    })

    it('move onto an occupied path fails as a tool error (caller fault, not 500)', async () => {
      const notes = await store.list()
      const a = byTitle(notes, `${TITLE_A} Two`)!
      const b = byTitle(notes, TITLE_B)!
      await expect(store.move({ id: idOf(a), destinationPath: b.filePath })).rejects.toMatchObject({
        isToolError: true,
      })
    })

    it('remove drops notes from the list', async () => {
      const removed: string[] = []

      for (const title of [`${TITLE_A} Two`, TITLE_B]) {
        const n = byTitle(await store.list(), title)!
        removed.push(n.filePath)
        await store.remove(idOf(n))
      }
      // The removed notes are gone from the inventory (other notes the spec seeded
      // under `dir` — tagged/imported — legitimately remain; assert on what we dropped).
      const left = await store.list()

      for (const path of removed) {
        expect(left.some((n) => n.filePath === path)).toBe(false)
      }
    })

    // ── Class & visibility: class is materialized from the mount, and
    //    hidden classes (agent-memory) are excluded from discovery surfaces by
    //    default, opt-in via scope. Self-seeded; class-modelling engines only
    //    (an engine without a class model probes false on `supportsClass` and
    //    skips it). Visibility enforcement is gated on capabilities.visibility
    //    (the read-model layer).
    describe('class & visibility', () => {
      const TITLE_MEM = 'Contract Memory'
      const TITLE_KB = 'Contract Knowledge'
      const MEMMARK = 'memmarkerzynq' // unique token shared by both bodies
      let supportsClass = false
      let mem: NoteMeta | undefined
      let kb: NoteMeta | undefined

      beforeAll(async () => {
        // The agent-memory write targets the hidden mount (the tool zashivaet
        // this scope); the knowledge note links to the memory by title.
        await store.write({
          title: TITLE_MEM,
          directory: dir,
          content: `private memory body about ${MEMMARK}.`,
          targetClass: 'agent-memory',
        })
        await store.write({
          title: TITLE_KB,
          directory: dir,
          content: `knowledge ${MEMMARK}, see [[${TITLE_MEM}]].`,
        })
        const all = await store.list({ scope: 'all' })
        mem = byTitle(all, TITLE_MEM)
        kb = byTitle(all, TITLE_KB)
        supportsClass = mem?.class === 'agent-memory'
      }, timeout)

      afterAll(async () => {
        // Remove via scope:'all' — default list() hides the agent-memory note.
        for (const title of [TITLE_MEM, TITLE_KB]) {
          const n = byTitle(await store.list({ scope: 'all' }), title)

          if (n) {
            await store.remove(idOf(n))
          }
        }
      }, timeout)

      it('materializes class from the target mount (enforced)', async () => {
        if (!supportsClass) {
          return
        } // engine has no class/mount model
        const all = await store.list({ scope: 'all' })
        expect(byTitle(all, TITLE_MEM)!.class).toBe('agent-memory')
        expect(byTitle(all, TITLE_KB)!.class).toBe('user-doc')
        // Direct id read is allowed — the user owns their memory.
        const detail = await store.read(idOf(mem!))
        expect(detail.content).toContain('private memory body')
        expect(detail.class).toBe('agent-memory')
      })

      it('hides agent-memory from default list; scope opts in', async () => {
        if (!supportsClass || !store.capabilities.visibility) {
          return
        }
        const userList = await store.list()
        expect(byTitle(userList, TITLE_MEM)).toBeFalsy()
        expect(byTitle(userList, TITLE_KB)).toBeTruthy()
        expect(byTitle(await store.list({ scope: 'all' }), TITLE_MEM)).toBeTruthy()
        expect(byTitle(await store.list({ scope: 'agentRecall' }), TITLE_MEM)).toBeTruthy()
      })

      it('user search excludes agent-memory; agentRecall scope includes it', async () => {
        if (!supportsClass || !store.capabilities.visibility) {
          return
        }
        const userHits = await store.search(MEMMARK)
        // The engine FTS indexes the memory note (index:true) — the read-model
        // is what drops it from user search.
        expect(userHits.some((r) => r.id === idOf(mem!))).toBe(false)
        expect(userHits.some((r) => r.id === idOf(kb!))).toBe(true)
        const recallHits = await store.search(MEMMARK, { scope: 'agentRecall' })
        expect(recallHits.some((r) => r.id === idOf(mem!))).toBe(true)
      })

      it('agent-memory is absent from the user graph, even as a wikilink target', async () => {
        if (!supportsClass || !store.capabilities.visibility) {
          return
        }
        const g = await store.graph()
        expect(g.nodes.some((n) => n.id === idOf(mem!))).toBe(false)
        // The [[Contract Memory]] link does NOT resolve into the hidden note —
        // it ghosts; no real edge ever targets the memory note.
        expect(g.links.some((l) => l.target === idOf(mem!))).toBe(false)
        // The knowledge note itself is a normal user-graph node.
        expect(g.nodes.some((n) => n.id === idOf(kb!))).toBe(true)
      })
    })

    // ── Directory channel: folders are first-class — empty ones exist,
    //    survive an emptying (never-prune), move, and delete wholesale. Optional
    //    on the port (an engine that can't enumerate empty dirs omits the
    //    methods); skipped wholesale when absent. Self-seeded under `dir`.
    describe('directory channel', () => {
      const has = () => Boolean(store.listDirs && store.makeDir && store.removeDir)

      it('listDirs surfaces a folder that holds notes', async () => {
        if (!has()) {
          return
        }
        await store.write({ title: 'D Alpha', content: 'x', directory: `${dir}/d-alpha` })
        expect(await store.listDirs!()).toContain(`${dir}/d-alpha`)
      })

      it('makeDir creates a durable EMPTY folder (and its ancestors) with no note', async () => {
        if (!has()) {
          return
        }
        await store.makeDir!(`${dir}/d-empty/inner`)
        const dirs = await store.listDirs!()
        expect(dirs).toContain(`${dir}/d-empty`)
        expect(dirs).toContain(`${dir}/d-empty/inner`)
        expect((await store.list()).some((n) => n.filePath.startsWith(`${dir}/d-empty`))).toBe(
          false,
        )
      })

      it('rejects non-round-trippable folder and move paths', async () => {
        if (!has()) {
          return
        }
        const lone = String.fromCharCode(0xd800)

        await expect(store.makeDir!(`${dir}/bad${lone}`)).rejects.toMatchObject({
          isToolError: true,
        })
        await expect(
          store.move({
            id: `${dir}/source`,
            destinationPath: `${dir}/bad\npath`,
            isDirectory: true,
          }),
        ).rejects.toMatchObject({ isToolError: true })

        for (const path of [`${dir}/.hidden`, `${dir}//duplicate`, `${dir}\\backslash`]) {
          await expect(store.makeDir!(path)).rejects.toMatchObject({ isToolError: true })
        }
        await expect(store.removeDir!('.git')).rejects.toMatchObject({ isToolError: true })
        await expect(
          store.move({
            id: `${dir}/source`,
            destinationPath: `${dir}/.hidden`,
            isDirectory: true,
          }),
        ).rejects.toMatchObject({ isToolError: true })
      })

      it('a folder is NOT pruned when its last note leaves (never-prune)', async () => {
        if (!has()) {
          return
        }
        await store.write({ title: 'D Lone', content: 'x', directory: `${dir}/d-lonely` })
        const lone = byTitle(await store.list(), 'D Lone')!
        await store.remove(idOf(lone))
        expect(await store.listDirs!()).toContain(`${dir}/d-lonely`)
      })

      it('moves an EMPTY folder (no indexed notes) — item 3: relocate, not "folder not found"', async () => {
        if (!has()) {
          return
        }
        await store.makeDir!(`${dir}/d-movable`)
        await store.move({
          id: `${dir}/d-movable`,
          destinationPath: `${dir}/d-moved`,
          isDirectory: true,
        })
        const dirs = await store.listDirs!()
        expect(dirs).toContain(`${dir}/d-moved`)
        expect(dirs).not.toContain(`${dir}/d-movable`)
      })

      it('a folder move with NOTES leaves NO stale src — dir channel + list() both relocate (no dup)', async () => {
        if (!has()) {
          return
        }
        // The dup-on-rename root: a stale note path beside a fresh disk dir. After
        // the move the channel must hold ONLY dest, and list() must report the note
        // at dest — never the old src lingering as a second folder.
        await store.write({ title: 'D Mover', content: 'x', directory: `${dir}/d-src` })
        await store.move({ id: `${dir}/d-src`, destinationPath: `${dir}/d-dst`, isDirectory: true })
        const dirs = await store.listDirs!()
        expect(dirs).toContain(`${dir}/d-dst`)
        expect(dirs).not.toContain(`${dir}/d-src`)
        const notes = await store.list()
        expect(notes.some((n) => n.filePath.startsWith(`${dir}/d-dst/`))).toBe(true)
        expect(notes.some((n) => n.filePath.startsWith(`${dir}/d-src/`))).toBe(false)
      })

      it('allows a case-only folder rename and relocates its notes exactly once', async () => {
        if (!has()) {
          return
        }
        const source = `${dir}/D-Case`
        const destination = `${dir}/d-case`

        await store.write({ title: 'D Case Child', content: 'x', directory: source })
        await store.move({ id: source, destinationPath: destination, isDirectory: true })
        const notes = (await store.list()).filter((note) => note.title === 'D Case Child')

        expect(notes).toHaveLength(1)
        expect(notes[0].filePath).toBe(`${destination}/d-case-child.md`)
        expect(await store.listDirs!()).toContain(destination)
        expect(await store.listDirs!()).not.toContain(source)
        await store.removeDir!(destination)
      })

      it('removeDir deletes the whole subtree (its notes AND its dirs)', async () => {
        if (!has()) {
          return
        }
        await store.write({ title: 'D Doomed', content: 'x', directory: `${dir}/d-trash/inner` })
        await store.removeDir!(`${dir}/d-trash`)
        expect(await store.listDirs!()).not.toContain(`${dir}/d-trash`)
        expect((await store.list()).some((n) => n.filePath.startsWith(`${dir}/d-trash`))).toBe(
          false,
        )
      })
    })

    // ── Base export: stream every note as its on-disk file (raw frontmatter
    //    + body), path = filePath. Optional on the port (an engine that can't
    //    enumerate files omits it); skipped when absent. `scope` reuses the
    //    visibility axis: default `user` drops hidden agent state, `all` includes its mounts.
    describe('base export', () => {
      const canExport = () => typeof store.exportNotes === 'function'

      const collect = async (opts?: { scope?: 'user' | 'all' }) => {
        const out: ExportEntry[] = []

        for await (const e of store.exportNotes!(opts)) {
          out.push(e)
        }

        return out
      }

      it('streams the raw note FILE — path = filePath, full frontmatter+body', async () => {
        if (!canExport()) {
          return
        }
        await store.write({
          title: 'Export One',
          content: 'unique-export-body-token',
          directory: `${dir}/exp`,
        })
        const meta = byTitle(await store.list(), 'Export One')!
        const entry = (await collect()).find((e) => e.path === meta.filePath)
        expect(entry).toBeTruthy()
        // Body present, and the raw file form — a frontmatter block (round-trippable,
        // carrying the notarium-id), NOT the parsed read() view.
        expect(typeof entry!.content).toBe('string')
        const content = entry!.content as string
        expect(content).toContain('unique-export-body-token')
        expect(content.replace(/^\uFEFF/, '')).toMatch(/^---/)
        await store.remove(idOf(meta))
      })

      it('scope=user excludes agent-memory; scope=all includes it', async () => {
        if (!canExport()) {
          return
        }
        await store.write({
          title: 'Export Mem',
          directory: dir,
          content: 'private-export-memory-token',
          targetClass: 'agent-memory',
        })
        const memMeta = byTitle(await store.list({ scope: 'all' }), 'Export Mem')

        if (memMeta?.class !== 'agent-memory') {
          return
        } // no class/mount model
        const userPaths = (await collect()).map((e) => e.path)
        const allPaths = (await collect({ scope: 'all' })).map((e) => e.path)
        expect(userPaths).not.toContain(memMeta.filePath)
        expect(allPaths).toContain(memMeta.filePath)
        await store.remove(idOf(memMeta))
      })
    })
  })
}
