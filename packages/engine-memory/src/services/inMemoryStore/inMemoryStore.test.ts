import { describe, expect, it } from 'vitest'

import { deterministicNoteId, InMemoryStore } from './inMemoryStore'

// The fake's graph() resolver must mirror core buildLinkIndex/resolveLink (#18
// one-spec-many-engines): path-form [[dir/note]] resolves, and a MISS yields a
// ghost whose prefill slugs BACK to the same target (#25) — the invariant that
// lets "create from a ghost" resolve the very link that produced it. The #100 phase 0
// review caught the fake diverging on both halves; these pin the parity.
describe('InMemoryStore.graph() — path-form parity with core (#100 phase 0)', () => {
  it('keeps literal storage paths readable while fragment refs match graph resolution', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        { id: 'plain', title: 'Plain', filePath: 'Foo.md', content: 'plain' },
        { id: 'hash', title: 'Literal Hash', filePath: 'Foo#section.md', content: 'literal' },
        { id: 'source', title: 'Source', filePath: 'source.md', content: '[[Foo#section]]' },
      ],
    })

    expect((await store.read('Foo#section.md')).id).toBe('hash')
    expect((await store.read('Foo#section')).id).toBe('plain')
    expect((await store.graph()).links).toContainEqual(
      expect.objectContaining({ source: 'source', target: 'plain' }),
    )
  })

  it('round-trips a listed legacy envelope-shaped path while links stay identity-only', async () => {
    const address = 'notarium-id:foo.md'
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        { id: 'literal-path', title: 'Literal Path', filePath: address, content: 'literal' },
        { id: 'foo.md', title: 'Stable Target', filePath: 'target.md', content: 'target' },
        { id: 'source', title: 'Source', filePath: 'source.md', content: `[[${address}]]` },
      ],
    })

    expect((await store.list()).some((note) => note.filePath === address)).toBe(true)
    expect((await store.read(address)).id).toBe('literal-path')
    expect((await store.graph()).links).toContainEqual(
      expect.objectContaining({ source: 'source', target: 'foo.md' }),
    )
  })

  it('resolves a path-form [[dir/note]] to a REAL edge, not a ghost', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        { title: 'Note', filePath: 'dir/note.md', content: 'target' },
        { title: 'Linker', filePath: 'linker.md', content: 'see [[dir/note]] and [[dir/Note]]' },
      ],
    })
    const g = await store.graph()
    const note = (await store.list()).find((n) => n.filePath === 'dir/note.md')!
    const linker = (await store.list()).find((n) => n.filePath === 'linker.md')!
    // Both the path form and the path+title form resolve to the same real note.
    expect(g.links.filter((l) => l.source === linker.id && l.target === note.id).length).toBe(1)
    expect(g.nodes.some((n) => n.ghost)).toBe(false)
  })

  it('a path-form MISS prefills a title that slugs back to the target (#25)', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [{ title: 'Linker', filePath: 'linker.md', content: 'see [[dir/Missing Note]]' }],
    })
    const ghost = (await store.graph()).nodes.find((n) => n.ghost)!
    expect(ghost.ghost).toBe(true)
    // NOT 'dir/Missing Note' (which would index at `dir-missing-note` and re-ghost)
    // — the last segment, de-kebabbed, so creating it indexes at `missing-note`.
    expect(ghost.prefillTitle).toBe('Missing Note')

    // Create the note from the ghost's prefill → the original link now resolves.
    const created = await store.write({ title: ghost.prefillTitle, content: 'filled' })
    const g2 = await store.graph()
    const linker = (await store.list()).find((n) => n.filePath === 'linker.md')!
    expect(g2.links.some((l) => l.source === linker.id && l.target === created.id)).toBe(true)
    expect(g2.nodes.find((n) => n.id === created.id)?.ghost).toBeFalsy()
  })

  it('uses empty-folder inventory equally in direct and graph resolution', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        { id: 'target', title: 'Target', filePath: 'other/Note.md', content: 'target' },
        { id: 'decoy', title: 'Decoy', filePath: 'A/Note.md', content: 'decoy' },
        {
          id: 'linker',
          title: 'Linker',
          filePath: 'Linker.md',
          content: '[[old/sub/Note]]',
        },
      ],
    })
    await store.makeDir!('old/sub')
    store.setFolderAliases!([{ current: 'other', alias: 'old/sub' }])

    expect((await store.read('old/sub/Note')).id).toBe('decoy')
    expect((await store.graph()).links).toContainEqual(
      expect.objectContaining({ source: 'linker', target: 'decoy' }),
    )
  })
})

describe('InMemoryStore legacy move destinations', () => {
  it('carries exact non-portable note/folder leaves into a portable existing parent', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        { id: 'legacy-note', title: 'Legacy Note', filePath: 'foo:bar.md', content: 'note' },
        {
          id: 'nested-note',
          title: 'Nested Note',
          filePath: 'folder:legacy/note.md',
          content: 'nested',
        },
      ],
    })
    await store.makeDir('archive')

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
  })
})

// A metadata-only touch (pin/mute #165) must NOT rename the file. The engine derives an
// edit's basename from slug(title) by default, so a note whose basename DIVERGES from its
// title (a seeded/imported file) would MOVE on any edit — and the reverse toggle would
// then collide ("a note already lives at the destination"). An explicit `fileName` on the
// edit pins the basename in place; without it the title-derived rename still applies (#209).
describe('InMemoryStore.write() — fileName pins the basename on an edit (#209 fix)', () => {
  it('an edit handing the current basename does NOT rename to slug(title), and the reverse toggle stays put', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'Personal Context Pin 07',
          filePath: 'agent-context/pins/pin-07.md',
          content: 'body',
        },
      ],
    })
    const id = (await store.list()).find((n) => n.title === 'Personal Context Pin 07')!.id!
    const r1 = await store.read(id)
    // Pin: add the tag while handing the current basename → file stays at pin-07.md.
    await store.write({
      title: r1.title ?? '',
      content: r1.content,
      originalId: id,
      versionToken: r1.versionToken,
      tags: ['always-load'],
      fileName: 'pin-07',
    })
    expect((await store.list()).find((n) => n.id === id)!.filePath).toBe(
      'agent-context/pins/pin-07.md',
    )
    // Unpin: remove the tag → still no move (the old collision path).
    const r2 = await store.read(id)
    await store.write({
      title: r2.title ?? '',
      content: r2.content,
      originalId: id,
      versionToken: r2.versionToken,
      tags: [],
      fileName: 'pin-07',
    })
    expect((await store.list()).find((n) => n.id === id)!.filePath).toBe(
      'agent-context/pins/pin-07.md',
    )
  })

  it('WITHOUT fileName an update preserves the existing storage path', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [{ title: 'Q3 Planning', filePath: 'meeting.md', content: 'x' }],
    })
    const id = (await store.list()).find((n) => n.title === 'Q3 Planning')!.id!
    const r = await store.read(id)
    await store.write({
      title: r.title ?? '',
      content: r.content,
      originalId: id,
      versionToken: r.versionToken,
      tags: ['t'],
    })
    expect((await store.list()).find((n) => n.id === id)!.filePath).toBe('meeting.md')
  })
})

// The derived id is ASCII like a real `notarium-id`, but ASCII alone is not enough:
// `asciiSlug` DROPS an unromanisable segment, so five CJK notes in one folder would all
// derive the same id — and seeders stamp journal rows with this pre-suffix form, so each
// note would wear its neighbours' history (#296).
describe('deterministicNoteId', () => {
  it('is injective over paths whose ASCII form collapses', () => {
    const paths = [
      'journal/第三季度规划.md',
      'journal/会議の議事録.md',
      'journal/תוכניות-לרבעון.md',
      'journal/แผนไตรมาส.md',
      'journal/안녕하세요.md',
      '第三季度/交付清单.md',
    ]
    const ids = paths.map(deterministicNoteId)

    expect(new Set(ids).size).toBe(paths.length)
    expect(ids.every((id) => /^[a-z0-9_-]+$/.test(id))).toBe(true) // ASCII, like a real id
  })

  it('is injective for paths where BOTH forms are empty', () => {
    // Two empty forms are trivially equal, so a naive "lossless" test takes the wrong
    // branch and hands every such path the same bare prefix.
    const ids = ['🎉/🚀.md', '✨/💫.md', '❤️.md'].map(deterministicNoteId)

    expect(new Set(ids).size).toBe(3)
    expect(ids.every((id) => /^fake-[a-z0-9_-]+$/.test(id))).toBe(true)
  })

  it('leaves a romanisable path on exactly the id it always had', () => {
    // Seeded worlds and e2e journeys hardcode these — a changed id moves their URLs.
    expect(deterministicNoteId('architecture/home-server.md')).toBe('fake-architecture-home-server')
    expect(deterministicNoteId('demo/Carbon.md')).toBe('fake-demo-carbon')
    expect(deterministicNoteId('Планы.md')).toBe('fake-plany')
  })
})

// The name formula's rungs are `fileName -> title -> id`. Folding the first two into one
// argument skips the middle one, so an unsluggable pinned name would land on the id here
// while production still names the file after a perfectly good title (#296).
describe('InMemoryStore name rungs on EDIT', () => {
  it('an edit pinning an unsluggable fileName keeps the TITLE-derived name', async () => {
    const store = new InMemoryStore({ space: 'main', now: '2026-07-22T12:00:00.000Z', notes: [] })
    const created = await store.write({ title: 'Edit Rung', directory: 'work', content: 'a' })
    const live = await store.read(created.id!)
    const edited = await store.write({
      originalId: created.id,
      title: 'Edit Rung Renamed',
      content: 'b',
      fileName: '🎉',
      versionToken: live.versionToken,
    })

    expect(edited.filePath).toBe('work/edit-rung-renamed.md')
    expect(edited.id).toBe(created.id) // identity rides through (P7)
  })
})
