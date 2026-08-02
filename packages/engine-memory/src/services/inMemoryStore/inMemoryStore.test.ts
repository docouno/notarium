import { describe, expect, it } from 'vitest'

import { InMemoryStore } from './inMemoryStore'

// The fake's graph() resolver must mirror core buildLinkIndex/resolveLink (#18
// one-spec-many-engines): path-form [[dir/note]] resolves, and a MISS yields a
// ghost whose prefill slugs BACK to the same target (#25) — the invariant that
// lets "create from a ghost" resolve the very link that produced it. The #100 phase 0
// review caught the fake diverging on both halves; these pin the parity.
describe('InMemoryStore.graph() — path-form parity with core (#100 phase 0)', () => {
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

  it('WITHOUT fileName a title-derived rename still applies (unchanged default)', async () => {
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
    expect((await store.list()).find((n) => n.id === id)!.filePath).toBe('q3-planning.md')
  })
})
