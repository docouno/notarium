import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import {
  DOCUMENT_ROLE,
  DOCUMENT_STATE_FORMAT,
  documentStateVersionToken,
  FRONTMATTER_BYTE_CAP,
  parseFrontmatterLines,
} from '@notarium/core'

import { deterministicNoteId, InMemoryStore } from './inMemoryStore'

const YAML_NODE_REFERENCE_WRITE_ERROR =
  'frontmatter with YAML anchors or aliases is not supported by writes'

const exportText = (content: string | Uint8Array): string =>
  typeof content === 'string' ? content : new TextDecoder().decode(content)

const frontmatter = (yaml: string) => parseFrontmatterLines(yaml)

describe('InMemoryStore legacy-name evidence', () => {
  it('keeps an inferred alias across an exact move, delete and forced restore', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'legacy-id',
          title: 'Қазақстан жоспары',
          filePath: 'aza-stan-zhospary.md',
          content: 'body',
        },
      ],
    })
    const before = await store.read('legacy-id')

    expect(before.physicalIncarnation).toMatchObject({
      owner: { kind: 'claimed', id: 'legacy-id' },
    })
    expect(before.legacyNameAliases).toEqual(['aza-stan-zhospary'])

    const moved = await store.move({
      id: 'legacy-id',
      destinationPath: 'archive/plan.md',
      expectedSource: before.physicalIncarnation,
    })
    expect(moved.legacyNameAliases).toEqual(['aza-stan-zhospary'])
    const live = await store.read('legacy-id')

    await store.remove('legacy-id', { expectedSource: live.physicalIncarnation })
    const restored = await store.write({
      id: 'legacy-id',
      title: 'Restored Plan',
      content: 'restored',
      restorePath: 'restored.md',
    })
    expect(restored.legacyNameAliases).toEqual(['aza-stan-zhospary'])
    expect((await store.read('legacy-id')).legacyNameAliases).toEqual(['aza-stan-zhospary'])
  })

  it('refuses a destructive effect carrying a stale physical incarnation', async () => {
    const store = new InMemoryStore({
      notes: [{ id: 'note-id', title: 'Note', filePath: 'note.md', content: 'before' }],
    })
    const stale = await store.read('note-id')
    await store.write({
      originalId: 'note-id',
      title: 'Note',
      content: 'after',
      versionToken: stale.versionToken,
    })

    await expect(
      store.move({
        id: 'note-id',
        destinationPath: 'moved.md',
        expectedSource: stale.physicalIncarnation,
      }),
    ).rejects.toThrow('note changed during conditional effect')
    expect((await store.read('note-id')).filePath).toBe('note.md')
  })

  it('refuses a write after a same-semantic physical incarnation replacement', async () => {
    const store = new InMemoryStore({
      notes: [{ id: 'note-id', title: 'Note', filePath: 'note.md', content: 'body' }],
    })
    const stale = await store.read('note-id')
    const replaced = await store.write({
      originalId: 'note-id',
      title: 'Note',
      content: 'body',
      versionToken: stale.versionToken,
    })

    expect(replaced.versionToken).toBe(stale.versionToken)
    await expect(
      store.write({
        originalId: 'note-id',
        title: 'Note',
        content: 'changed',
        versionToken: stale.versionToken,
        expectedSource: stale.physicalIncarnation,
      }),
    ).rejects.toThrow('note changed during conditional effect')
    expect((await store.read('note-id')).content).toBe('body')
  })
})

describe('InMemoryStore document-state parity', () => {
  it('serves the same analyzer-owned state and CAS token shape as the real engine', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [{ id: 'exact', title: 'Exact', filePath: 'exact.md', content: 'body' }],
    })
    const detail = await store.read('exact')

    expect(detail.documentState?.projection).toMatchObject({ title: 'Exact', body: 'body' })
    expect(detail.versionToken).toBe(documentStateVersionToken(detail.documentState!))
    expect(detail.versionToken).toMatch(/^v3:/)
  })

  it('excludes the materialized owner id from the authored CAS identity', async () => {
    const first = new InMemoryStore({
      space: 'main',
      notes: [{ id: 'runtime-a', title: 'Exact', filePath: 'same.md', content: 'body' }],
    })
    const second = new InMemoryStore({
      space: 'main',
      notes: [{ id: 'runtime-b', title: 'Exact', filePath: 'same.md', content: 'body' }],
    })
    const a = await first.read('runtime-a')
    const b = await second.read('runtime-b')

    expect(a.documentState?.provenance.claims).toEqual([
      expect.objectContaining({ key: 'notarium-id', ownership: 'entry' }),
    ])
    expect(b.documentState?.provenance.claims).toEqual([
      expect.objectContaining({ key: 'notarium-id', ownership: 'entry' }),
    ])
    expect(a.versionToken).toBe(b.versionToken)
  })

  it('only classifies a linked skill resource under a valid direct skill root', async () => {
    const valid = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'root',
          title: 'demo',
          class: 'skill',
          filePath: 'skills/demo/SKILL.md',
          content: 'Instructions',
          frontmatter: 'name: demo\ndescription: Demo skill',
        },
        {
          id: 'helper',
          title: 'Helper',
          class: 'skill',
          filePath: 'skills/demo/references/helper.md',
          content: 'Reference',
        },
        {
          id: 'nested-skill-name',
          title: 'Nested SKILL',
          class: 'skill',
          filePath: 'skills/demo/references/SKILL.md',
          content: 'Nested reference',
        },
        {
          id: 'project-root',
          title: 'demo',
          class: 'skill',
          filePath: 'skills/_projects/project-a/demo/SKILL.md',
          content: 'Instructions',
          frontmatter: 'name: demo\ndescription: Project demo skill',
        },
        {
          id: 'project-nested-skill-name',
          title: 'Nested project SKILL',
          class: 'skill',
          filePath: 'skills/_projects/project-a/demo/references/SKILL.md',
          content: 'Nested project reference',
        },
      ],
    })
    const missing = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'helper',
          title: 'Helper',
          class: 'skill',
          filePath: 'skills/demo/references/helper.md',
          content: 'Reference',
        },
      ],
    })
    const invalid = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'root',
          title: 'other',
          class: 'skill',
          filePath: 'skills/demo/SKILL.md',
          content: 'Instructions',
          frontmatter: 'name: other\ndescription: Wrong directory',
        },
        {
          id: 'helper',
          title: 'Helper',
          class: 'skill',
          filePath: 'skills/demo/references/helper.md',
          content: 'Reference',
        },
      ],
    })
    const ancestorOnly = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'ancestor-root',
          title: 'skills',
          class: 'skill',
          filePath: 'skills/SKILL.md',
          content: 'Instructions',
          frontmatter: 'name: skills\ndescription: Ancestor package',
        },
        {
          id: 'nested-helper',
          title: 'Nested helper',
          class: 'skill',
          filePath: 'skills/demo/references/helper.md',
          content: 'Reference',
        },
      ],
    })

    expect((await valid.read('helper')).documentState).toMatchObject({
      format: DOCUMENT_STATE_FORMAT.markdown,
      role: DOCUMENT_ROLE.skillAuxiliary,
    })
    expect((await valid.read('nested-skill-name')).documentState?.role).toBe(
      DOCUMENT_ROLE.skillAuxiliary,
    )
    expect((await valid.read('project-nested-skill-name')).documentState?.role).toBe(
      DOCUMENT_ROLE.skillAuxiliary,
    )
    expect((await missing.read('helper')).documentState?.role).toBe(DOCUMENT_ROLE.generic)
    expect((await invalid.read('helper')).documentState?.role).toBe(DOCUMENT_ROLE.generic)
    expect((await ancestorOnly.read('nested-helper')).documentState?.role).toBe(
      DOCUMENT_ROLE.generic,
    )
  })
})

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

describe('InMemoryStore conditional remove', () => {
  it('does not remove a state newer than the supplied token', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })
    const created = await store.write({ title: 'Conditional', content: 'first' })

    await store.write({
      title: 'Conditional',
      content: 'newer',
      originalId: created.id,
      versionToken: created.versionToken,
    })
    await expect(
      store.remove(created.id!, { identityOnly: true, versionToken: created.versionToken }),
    ).rejects.toThrow(/note changed during delete/)
    expect((await store.read(created.id!, { identityOnly: true })).content).toBe('newer')
  })

  it('does not remove a same-state replacement with an older physical claim', async () => {
    const store = new InMemoryStore({
      space: 'main',
      now: '2026-08-12T00:00:00.000Z',
      notes: [],
    })
    const first = await store.write({ title: 'Same', content: 'body' })
    const replacement = await store.write({
      title: 'Same',
      content: 'body',
      ifExists: 'overwrite',
    })

    expect(replacement.versionToken).toBe(first.versionToken)
    expect(replacement.physicalWriteClaim).not.toEqual(first.physicalWriteClaim)
    await expect(
      store.remove(first.id!, {
        identityOnly: true,
        versionToken: first.versionToken,
        physicalWriteClaim: first.physicalWriteClaim,
      }),
    ).rejects.toThrow(/note changed during delete/)
    expect((await store.read(first.id!, { identityOnly: true })).content).toBe('body')

    await store.remove(replacement.id!, {
      identityOnly: true,
      physicalWriteClaim: replacement.physicalWriteClaim,
    })
    await expect(store.read(replacement.id!, { identityOnly: true })).rejects.toThrow(
      /note not found/,
    )
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

// #280 — an imported note's own frontmatter. The fake has no file to re-read, so
// whatever the real engine would DERIVE from the file's keys it must derive here,
// on BOTH entry points: a live import (write) and a seeded fixture (load). The
// asymmetry is not cosmetic — the export reconstruction drops the carried
// `aliases:`/`slug:` lines on the promise that the typed fields re-emit them, so a
// side that skips the derivation deletes the author's key outright.
describe('InMemoryStore — carried frontmatter is the same note however it arrived (#280)', () => {
  const CARRY =
    'aliases: [Weekly Review]\nslug: my-slug\nsummary: Imported summary\nmuted: true\nauthor: Sergey\nmeta:\n  source: obsidian'

  const seeded = () =>
    new InMemoryStore({
      space: 'main',
      notes: [{ title: 'Retro', filePath: 'retro.md', content: 'body', frontmatter: CARRY }],
    })

  const imported = async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })
    await store.write({
      title: 'Retro',
      content: 'body',
      fileName: 'retro',
      frontmatter: [
        { key: 'aliases', lines: ['aliases: [Weekly Review]'] },
        { key: 'slug', lines: ['slug: my-slug'] },
        { key: 'summary', lines: ['summary: Imported summary'] },
        { key: 'muted', lines: ['muted: true'] },
        { key: 'author', lines: ['author: Sergey'] },
        { key: 'meta', lines: ['meta:', '  source: obsidian'] },
      ],
    })
    return store
  }

  const exported = async (store: InMemoryStore) => {
    const out: Record<string, string> = {}

    for await (const e of store.exportNotes()) {
      out[e.path] = exportText(e.content)
    }

    return out
  }

  it('derives aliases and slug from the carry on BOTH the seed and the import path', async () => {
    for (const store of [seeded(), await imported()]) {
      const meta = (await store.list()).find((n) => n.filePath === 'retro.md')!
      const view = await store.read(meta.id!)
      expect(view.frontmatter.aliases).toEqual(['Weekly Review'])
      // The typed fields — what the resolver and the export reconstruction read.
      expect(await store.read('Weekly Review')).toBeTruthy() // the alias resolves
      expect(await store.read('my-slug')).toBeTruthy() // the custom slug resolves
      expect(view.frontmatter.summary).toBe('Imported summary')
      expect(view.frontmatter.muted).toBe('true')
    }
  })

  it('exports the author’s keys — none is silently dropped on either path', async () => {
    for (const store of [seeded(), await imported()]) {
      const file = (await exported(store))['retro.md']
      expect(file).toContain('aliases:')
      expect(file).toContain('Weekly Review')
      expect(file).toContain('slug: my-slug')
      expect(file).toContain('summary: Imported summary')
      expect(file).toContain('muted: true')
      expect(file).toContain('author: Sergey')
      expect(file).toContain('meta:\n  source: obsidian')
      // …and exactly once — the carry and the typed field must not both emit it.
      expect(file.match(/^aliases:/gm)).toHaveLength(1)
      expect(file.match(/^slug:/gm)).toHaveLength(1)
    }
  })

  it('preserves the authored shape of every readable carried typed key', async () => {
    const carry = [
      'type: "person"',
      'tags: [one, two]',
      'aliases: ["Weekly Review", Retro]',
      'slug: "my-slug"',
      'summary: "Imported summary"',
      'muted: true',
    ].join('\n')
    const store = new InMemoryStore({ space: 'main', notes: [] })

    await store.write({
      title: 'Retro',
      content: 'body',
      fileName: 'retro',
      frontmatter: frontmatter(carry),
    })

    expect((await exported(store))['retro.md']).toContain(`\n${carry}\n---`)
  })

  it('lets every explicit seeded typed clear replace its carried value without resurrection', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'Retro',
          filePath: 'retro.md',
          content: 'body',
          frontmatter:
            'type: person\ntags: [old]\naliases: [Old Name]\nslug: old-slug\nsummary: Carried summary\nmuted: true\nauthor: Sergey',
          noteType: '',
          tags: [],
          aliases: [],
          slug: '',
          summary: '',
          muted: false,
        },
      ],
    })
    const meta = (await store.list())[0]
    const view = await store.read(meta.id!)
    const file = (await exported(store))['retro.md']
    expect(view.slug).toBeUndefined()
    expect(view.aliases).toBeUndefined()
    for (const key of ['type', 'tags', 'aliases', 'slug', 'summary', 'muted']) {
      expect(view.frontmatter[key]).toBeUndefined()
    }
    expect(view.frontmatter.author).toBe('Sergey')
    expect(file).not.toMatch(/^(type|tags|aliases|slug|summary|muted):/m)
    expect(file).toContain('author: Sergey')
  })
})

// Found in review round 4: the export drops a carried `aliases:`/`slug:` only
// because a typed field re-emits it — and `carriedTyped` populates that field ONLY
// for the value shapes the shared reader models. For anything fancier the typed
// field is empty, so dropping the line deletes the author's key: the very defect
// class the carry exists to prevent, one layer down.
describe('InMemoryStore — an unreadable carried key is kept, not swallowed (#280)', () => {
  const exported = async (store: InMemoryStore) => {
    for await (const e of store.exportNotes()) {
      if (e.path === 'r.md') {
        return exportText(e.content)
      }
    }

    return ''
  }

  it('keeps aliases:/slug: whose shape yields no typed value — the real engine does', async () => {
    const carry = 'aliases:\n  en: [Old Name]\nslug: [a, b]\nauthor: S'
    const seeded = new InMemoryStore({
      space: 'main',
      notes: [{ title: 'R', filePath: 'r.md', content: 'b', frontmatter: carry }],
    })
    const file = await exported(seeded)
    expect(file).toContain('author: S')
    expect(file).toContain('aliases:')
    expect(file).toContain('  en: [Old Name]')
    expect(file).toContain('slug: [a, b]')
  })

  it('still emits a READABLE aliases/slug exactly once (no duplicate line)', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'R',
          filePath: 'r.md',
          content: 'b',
          frontmatter: 'aliases: [Weekly Review]\nslug: my-slug',
        },
      ],
    })
    const file = await exported(store)
    expect(file.match(/^aliases:/gm)).toHaveLength(1)
    expect(file.match(/^slug:/gm)).toHaveLength(1)
    expect(file).toContain('Weekly Review')
  })
})

describe('InMemoryStore — carried frontmatter merges like the real file serializer (#280)', () => {
  const exported = async (store: InMemoryStore): Promise<string> => {
    for await (const entry of store.exportNotes()) {
      if (entry.path === 'r.md') {
        return exportText(entry.content)
      }
    }

    return ''
  }
  const readable = frontmatter(
    'aliases: [Old Name]\nslug: old-slug\ntags: [old]\ntype: person\nsummary: Old summary\nmuted: true\nkept: yes',
  )
  const unreadable = frontmatter(
    'aliases:\n  en: [New Name]\nslug: [new, slug]\ntags:\n  group: new\ntype:\n  kind: event\nsummary:\n  locale: New\nmuted: [false]\nauthor: New',
  )

  it.each([
    ['anchor definition', 'anchorKey: &x value'],
    ['alias node', 'copy: *x'],
    ['foreign duplicate', 'author: &x old\ncopy: *x\nauthor: new'],
    ['lifted duplicate', 'tags: &x [old]\ncopy: *x\ntags: [new]'],
    ['date duplicate', 'created: &x old\ncopy: *x\ncreated: 2020-01-01'],
  ])('rejects YAML node references on a fresh write (%s)', async (_label, yaml) => {
    const store = new InMemoryStore({ space: 'main', notes: [] })

    await expect(
      store.write({
        title: 'R',
        fileName: 'r',
        content: 'body',
        frontmatter: frontmatter(yaml),
      }),
    ).rejects.toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))
    expect(await store.list()).toEqual([])
  })

  it.each([
    ['NBSP', '\u00a0'],
    ['em space', '\u2003'],
  ])(
    'detects a %s-prefixed top-level reference after a block scalar and rejects atomically',
    async (_label, prefix) => {
      const store = new InMemoryStore({ space: 'main', notes: [] })
      const incoming = frontmatter(
        [
          'description: |',
          '  safe scalar text',
          `${prefix}base: &shared value`,
          `${prefix}copy: *shared`,
        ].join('\n'),
      )

      await expect(
        store.write({ title: 'R', fileName: 'r', content: 'body', frontmatter: incoming }),
      ).rejects.toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))
      expect(await store.list()).toEqual([])
    },
  )

  it('lets a valid dedented multiline flow reach collision and reference policy', async () => {
    const yaml = 'flow: [\n  &shared one,\n  *shared\n]'
    const incoming = frontmatter(yaml)
    const occupied = new InMemoryStore({ space: 'main', notes: [] })

    expect(parseYaml(yaml)).toEqual({ flow: ['one', 'one'] })
    await occupied.write({ title: 'R', fileName: 'r', content: 'old body' })
    await expect(
      occupied.write({
        title: 'R',
        fileName: 'r',
        content: 'new body',
        frontmatter: incoming,
      }),
    ).rejects.toThrow(/already exists/i)
    expect((await occupied.read((await occupied.list())[0].id!)).content).toBe('old body')

    const fresh = new InMemoryStore({ space: 'main', notes: [] })
    await expect(
      fresh.write({ title: 'R', fileName: 'r', content: 'body', frontmatter: incoming }),
    ).rejects.toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))
    expect(await fresh.list()).toEqual([])
  })

  it('rejects leading inline-frontmatter references on fresh and overwrite writes', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })
    const inline = '---\nanchorKey: &x value\ncopy: *x\n---\nnew body'

    await expect(
      store.write({ title: 'Fresh', fileName: 'fresh', content: inline }),
    ).rejects.toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))
    expect(await store.list()).toEqual([])

    await store.write({ title: 'R', fileName: 'r', content: 'old body' })
    await expect(
      store.write({
        title: 'R',
        fileName: 'r',
        content: inline,
        ifExists: 'overwrite',
      }),
    ).rejects.toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))
    const old = await store.read((await store.list())[0].id!)

    expect(old.content).toBe('old body')
    expect(await store.list()).toHaveLength(1)
  })

  it('keeps a leading fenced YAML-reference example as body during full-state replace', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })
    const body = '---\nanchorKey: &x value\ncopy: *x\n---\nactual body'

    const created = await store.write({
      title: 'Restored',
      fileName: 'restored',
      content: body,
      frontmatter: frontmatter('custom: exact'),
      frontmatterMode: 'replace',
    })

    expect((await store.read(created.id!)).content).toBe(body)
  })

  it('allows plain, quoted and block-scalar ampersands that are not YAML node references', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })
    const safe = frontmatter(
      'plain: A&B and literal *alias\nquoted: "&anchor and *alias"\ncode: |\n  &anchor-looking text\n  *alias-looking text',
    )
    const created = await store.write({
      title: 'R',
      fileName: 'r',
      content: 'old body',
      frontmatter: safe,
    })

    await expect(
      store.write({
        originalId: created.id,
        versionToken: created.versionToken,
        title: 'R',
        content: 'new body',
      }),
    ).resolves.toBeDefined()
    expect(await exported(store)).toContain(
      'code: |\n  &anchor-looking text\n  *alias-looking text',
    )
  })

  it('rejects anchor/alias carry only after an occupied create passes collision policy', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })
    const incoming = frontmatter('anchorKey: &x new\ncopy: *x')

    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'old body',
      frontmatter: frontmatter('copy: old\nanchorKey: old'),
    })
    await expect(
      store.write({ title: 'R', fileName: 'r', content: 'new body', frontmatter: incoming }),
    ).rejects.toThrow(/already exists/i)
    await expect(
      store.write({
        title: 'R',
        fileName: 'r',
        content: 'new body',
        ifExists: 'overwrite',
        frontmatter: incoming,
      }),
    ).rejects.toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))

    const old = await store.read((await store.list())[0].id!)
    expect(old.frontmatter.copy).toBe('old')
    expect(old.frontmatter.anchorKey).toBe('old')
    expect(old.content).toBe('old body')
  })

  it('rejects anchor/alias carry on an originalId edit without mutating the note', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })
    const created = await store.write({
      title: 'R',
      fileName: 'r',
      content: 'old body',
      frontmatter: frontmatter('copy: old\nanchorKey: old'),
    })

    await expect(
      store.write({
        originalId: created.id,
        versionToken: 'stale-token',
        title: 'R',
        content: 'new body',
        frontmatter: frontmatter('anchorKey: &x new\ncopy: *x'),
      }),
    ).rejects.toThrow(/changed since read/i)
    await expect(
      store.write({
        originalId: created.id,
        versionToken: created.versionToken,
        title: 'R',
        content: 'new body',
        frontmatter: frontmatter('anchorKey: &x new\ncopy: *x'),
      }),
    ).rejects.toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))

    const old = await store.read(created.id!)
    expect(old.frontmatter.copy).toBe('old')
    expect(old.frontmatter.anchorKey).toBe('old')
    expect(old.content).toBe('old body')
  })

  it('rejects an ordinary body/typed edit when the stored carry contains anchor dependencies', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'r',
          title: 'R',
          filePath: 'r.md',
          content: 'old body',
          frontmatter: 'tags: &x [a]\ncopy: *x',
        },
      ],
    })
    const oldMeta = (await store.list())[0]
    const oldView = await store.read(oldMeta.id!)

    await expect(
      store.write({
        originalId: oldMeta.id,
        versionToken: oldView.versionToken,
        title: 'R',
        content: 'new body',
        tags: ['new'],
      }),
    ).rejects.toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))

    const old = await store.read(oldMeta.id!)
    expect(old.content).toBe('old body')
    expect(old.frontmatter.tags).toBeUndefined()
    expect(await exported(store)).toContain('tags: &x [a]\ncopy: *x')
  })

  it('exports anchored system and typed keys without dangling their aliases', async () => {
    const carry = [
      'title: &note-title R',
      'title-copy: *note-title',
      'notarium-id: &note-id r',
      'id-copy: *note-id',
      'notarium-created: &birth "2025-04-03T02:01:00.000Z"',
      'birth-copy: *birth',
      'tags: &note-tags [one, two]',
      'tags-copy: *note-tags',
    ].join('\n')
    const store = new InMemoryStore({
      space: 'main',
      notes: [{ id: 'r', title: 'R', filePath: 'r.md', content: 'body', frontmatter: carry }],
    })
    const exportedFile = await exported(store)
    const payload = exportedFile.match(/^---\n([\s\S]*?)\n---/)?.[1]

    expect(payload).toBe(carry)
    expect(parseYaml(payload!)).toMatchObject({
      title: 'R',
      'title-copy': 'R',
      'notarium-id': 'r',
      'id-copy': 'r',
      'notarium-created': '2025-04-03T02:01:00.000Z',
      'birth-copy': '2025-04-03T02:01:00.000Z',
      tags: ['one', 'two'],
      'tags-copy': ['one', 'two'],
    })

    const view = await store.read('r')
    await expect(
      store.write({
        originalId: 'r',
        versionToken: view.versionToken,
        title: 'R',
        content: 'changed',
      }),
    ).rejects.toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))
  })

  it('keeps anchored raw owners when explicit snapshot fields drive the live projections', async () => {
    const carry = [
      'type: &raw-type person',
      'type-copy: *raw-type',
      'tags: &raw-tags [one, two]',
      'tags-copy: *raw-tags',
      'aliases: &raw-aliases [Old Name]',
      'aliases-copy: *raw-aliases',
      'slug: &raw-slug old-slug',
      'slug-copy: *raw-slug',
      'summary: &raw-summary Old summary',
      'summary-copy: *raw-summary',
      'muted: &raw-muted true',
      'muted-copy: *raw-muted',
    ].join('\n')
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'r',
          title: 'R',
          filePath: 'r.md',
          content: 'body',
          frontmatter: carry,
          noteType: 'journal',
          tags: ['typed'],
          aliases: ['Typed Name'],
          slug: 'typed-slug',
          summary: 'Typed summary',
          muted: false,
        },
      ],
    })
    const before = await store.read('r')
    const exportedBefore = await exported(store)
    const payload = exportedBefore.match(/^---\n([\s\S]*?)\n---/)?.[1]

    expect(before.frontmatter).toMatchObject({
      type: 'journal',
      tags: ['typed'],
      aliases: ['Typed Name'],
      slug: 'typed-slug',
      summary: 'Typed summary',
    })
    expect(before.frontmatter.muted).toBeUndefined()
    expect(payload).toContain(carry)
    expect(parseYaml(payload!)).toMatchObject({
      'type-copy': 'person',
      'tags-copy': ['one', 'two'],
      'aliases-copy': ['Old Name'],
      'slug-copy': 'old-slug',
      'summary-copy': 'Old summary',
      'muted-copy': true,
    })

    await expect(
      store.write({
        originalId: 'r',
        versionToken: before.versionToken,
        title: 'R',
        content: 'changed',
      }),
    ).rejects.toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))
    expect(await store.read('r')).toEqual(before)
    expect(await exported(store)).toBe(exportedBefore)
  })

  it('keeps an anchored notarium-created owner when createdAt is projected explicitly', async () => {
    const createdAt = '2025-04-03T02:01:00.000Z'
    const carry = `notarium-created: &birth "${createdAt}"\nbirth-copy: *birth`
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'r',
          title: 'R',
          filePath: 'r.md',
          content: 'body',
          frontmatter: carry,
          createdAt,
        },
      ],
    })
    const exportedFile = await exported(store)
    const payload = exportedFile.match(/^---\n([\s\S]*?)\n---/)?.[1]

    expect(payload).toContain(carry)
    expect(parseYaml(payload!)).toMatchObject({
      created: createdAt,
      'notarium-created': createdAt,
      'birth-copy': createdAt,
    })
    expect((await store.read('r')).createdAt).toBe(createdAt)
  })

  it('preserves a duplicate keyed anchor owner before its last-wins value', async () => {
    const carry = 'author: &original old\ncopy: *original\nauthor: new'
    const store = new InMemoryStore({
      space: 'main',
      notes: [{ id: 'r', title: 'R', filePath: 'r.md', content: 'body', frontmatter: carry }],
    })
    const exportedFile = await exported(store)
    const payload = exportedFile.match(/^---\n([\s\S]*?)\n---/)?.[1]

    expect(payload).toContain(carry)
    expect(parseYaml(payload!, { uniqueKeys: false })).toMatchObject({
      author: 'new',
      copy: 'old',
    })
  })

  it('keeps fail-on-existing precedence, then rejects overwrite of stored anchor dependencies', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'r',
          title: 'R',
          filePath: 'r.md',
          content: 'old body',
          frontmatter: 'tags: &x [a]\ncopy: *x',
        },
      ],
    })
    await expect(
      store.write({ title: 'R', fileName: 'r', content: 'new body', tags: ['new'] }),
    ).rejects.toThrow(/already exists/i)
    await expect(
      store.write({
        title: 'R',
        fileName: 'r',
        content: 'new body',
        tags: ['new'],
        ifExists: 'overwrite',
      }),
    ).rejects.toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))

    const old = await store.read((await store.list())[0].id!)
    expect(old.content).toBe('old body')
    expect(await exported(store)).toContain('tags: &x [a]\ncopy: *x')
  })

  const assertUnreadableReplacement = async (store: InMemoryStore) => {
    const meta = (await store.list()).find((note) => note.filePath === 'r.md')!
    const view = await store.read(meta.id!)
    const file = await exported(store)

    expect(meta.aliases).toBeUndefined()
    expect(meta.slug).toBeUndefined()
    expect(meta.tags).toBeUndefined()
    expect(view.frontmatter.aliases).toBeUndefined()
    expect(view.aliases).toBeUndefined()
    expect(view.slug).toBeUndefined()
    expect(view.frontmatter.slug).toEqual(['new', 'slug'])
    expect(view.frontmatter.tags).toBeUndefined()
    expect(view.frontmatter.type).toBeUndefined()
    expect(view.frontmatter.summary).toBeUndefined()
    expect(view.frontmatter.muted).toEqual(['false'])
    expect(view.frontmatter.kept).toBe('yes') // absent incoming key carries forward
    expect(view.frontmatter.author).toBe('New')
    expect(file).toContain('aliases:\n  en: [New Name]')
    expect(file).toContain('slug: [new, slug]')
    expect(file).toContain('tags:\n  group: new')
    expect(file).toContain('type:\n  kind: event')
    expect(file).toContain('summary:\n  locale: New')
    expect(file).toContain('muted: [false]')
    expect(file).not.toContain('Old Name')
    expect(file).not.toContain('old-slug')
    expect(file).not.toContain('- old')
    expect(file).not.toContain('Old summary')
    return view
  }

  it('keywise-merges two create-overwrites: refresh present keys, retain absent ones', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })

    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'one',
      ifExists: 'overwrite',
      frontmatter: [
        ...frontmatter('author: Old\nkept: yes'),
        { key: null, lines: ['# one comment'] },
      ],
    })
    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'two',
      ifExists: 'overwrite',
      frontmatter: [...frontmatter('author: New'), { key: null, lines: ['# one comment'] }],
    })

    const meta = (await store.list())[0]
    const view = await store.read(meta.id!)
    const file = await exported(store)
    expect(view.frontmatter.author).toBe('New')
    expect(view.frontmatter.kept).toBe('yes')
    expect(file.match(/^# one comment$/gm)).toHaveLength(1)
    expect(file.indexOf('# one comment')).toBeLessThan(file.indexOf('notarium-id:'))
  })

  it('keeps comments in their authored position between custom keys', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'Ordered',
          filePath: 'ordered.md',
          content: 'body',
          frontmatter: 'first: one\n# middle\nsecond: two',
        },
      ],
    })
    const state = (await store.read('fake-ordered')).logicalState!.markdown

    expect(state).toContain('first: one\n# middle\nsecond: two')
  })

  it('keeps duplicate custom fixture keys in the exact logical state', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'Duplicates',
          filePath: 'duplicates.md',
          content: 'body',
          frontmatter: 'plugin: first\n# between\nplugin: second',
        },
      ],
    })
    const note = (await store.list())[0]

    expect((await store.read(note.id!)).logicalState?.markdown).toContain(
      'plugin: first\n# between\nplugin: second',
    )
  })

  it('preserves identical keyless lines authored twice in one source without multiplying them on re-import', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })
    const incoming = [
      { key: null, lines: ['# authored twice'] },
      { key: null, lines: ['# authored twice'] },
    ]

    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'one',
      ifExists: 'overwrite',
      frontmatter: incoming,
    })
    expect((await exported(store)).match(/^# authored twice$/gm)).toHaveLength(2)

    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'two',
      ifExists: 'overwrite',
      frontmatter: incoming,
    })
    expect((await exported(store)).match(/^# authored twice$/gm)).toHaveLength(2)
  })

  it('collapses every occupied duplicate of an incoming key and keeps the last incoming value', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'R',
          filePath: 'r.md',
          content: 'body',
          frontmatter: 'author: Old first\nauthor: Old last\nkept: yes',
        },
      ],
    })

    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'updated',
      ifExists: 'overwrite',
      frontmatter: frontmatter('author: New first\nauthor: New last'),
    })

    const view = await store.read((await store.list())[0].id!)
    const file = await exported(store)
    expect(view.frontmatter.author).toBe('New last')
    expect(view.frontmatter.kept).toBe('yes')
    expect(file.match(/^author:/gm)).toHaveLength(1)
    expect(file).toContain('author: New last')
    expect(file).not.toContain('Old first')
    expect(file).not.toContain('Old last')
  })

  it('a seeded unreadable last duplicate clears projections without rewriting fixture bytes', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'R',
          filePath: 'r.md',
          content: 'body',
          frontmatter:
            'aliases: [Stale Alias]\naliases:\n  locale: [Current]\ntags: [stale]\ntags:\n  group: current',
        },
      ],
    })

    const meta = (await store.list())[0]
    const view = await store.read(meta.id!)
    const file = await exported(store)
    expect(meta.aliases).toBeUndefined()
    expect(meta.tags).toBeUndefined()
    expect(view.frontmatter.aliases).toBeUndefined()
    expect(view.frontmatter.tags).toBeUndefined()
    expect(file.match(/^aliases:/gm)).toHaveLength(2)
    expect(file.match(/^tags:/gm)).toHaveLength(2)
    expect(file).toContain('aliases: [Stale Alias]\naliases:\n  locale: [Current]')
    expect(file).toContain('tags: [stale]\ntags:\n  group: current')
  })

  it('an overwrite clears stale typed projections when replacement keys become unreadable', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })

    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'one',
      ifExists: 'overwrite',
      frontmatter: readable,
      summary: 'Old summary',
      muted: true,
    })
    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'two',
      ifExists: 'overwrite',
      frontmatter: unreadable,
    })

    await assertUnreadableReplacement(store)
  })

  it('an overwrite updates readable summary/muted projections from the replacement carry', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })

    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'one',
      ifExists: 'overwrite',
      frontmatter: readable,
      summary: 'Old summary',
      muted: true,
    })
    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'two',
      ifExists: 'overwrite',
      frontmatter: frontmatter('summary: New summary\nmuted: false'),
    })

    const view = await store.read((await store.list())[0].id!)
    const file = await exported(store)
    expect(view.frontmatter.summary).toBe('New summary')
    expect(view.frontmatter.muted).toBe('false')
    expect(file).toContain('summary: New summary')
    expect(file).toContain('muted: false')
    expect(file).not.toContain('Old summary')
    expect(file).not.toContain('muted: true')
  })

  it('does the same on originalId edit, with explicit typed channels winning last', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })
    const created = await store.write({
      title: 'R',
      fileName: 'r',
      content: 'one',
      frontmatter: readable,
      summary: 'Old summary',
      muted: true,
    })
    const before = await store.read(created.id!)

    await store.write({
      title: 'R',
      content: 'two',
      originalId: created.id,
      versionToken: before.versionToken,
      frontmatter: unreadable,
    })
    const unreadableView = await assertUnreadableReplacement(store)

    await store.write({
      title: 'R',
      content: 'three',
      originalId: created.id,
      versionToken: unreadableView.versionToken,
      frontmatter: unreadable,
      slug: 'typed-slug',
      tags: ['typed'],
      noteType: 'event',
      summary: 'Typed summary',
      muted: true,
    })
    const typed = await store.read(created.id!)
    const typedFile = await exported(store)
    expect(typed.slug).toBe('typed-slug')
    expect(typed.frontmatter.tags).toEqual(['typed'])
    expect(typed.frontmatter.type).toBe('event')
    expect(typed.frontmatter.summary).toBe('Typed summary')
    expect(typed.frontmatter.muted).toBe('true')
    expect(typedFile).not.toContain('slug: [new, slug]')
    expect(typedFile).not.toContain('tags:\n  group: new')
    expect(typedFile).not.toContain('type:\n  kind: event')
    expect(typedFile).not.toContain('summary:\n  locale: New')
    expect(typedFile).not.toContain('muted: [false]')

    await store.write({
      title: 'R',
      content: 'four',
      originalId: created.id,
      versionToken: typed.versionToken,
      slug: '',
      tags: [],
      noteType: 'note',
      summary: '',
      muted: false,
    })
    const clearedFile = await exported(store)
    expect(clearedFile).not.toMatch(/^(slug|tags|type|summary|muted):/m) // no stale raw resurrection
  })

  it('rejects non-durable raw frontmatter at the bare-engine boundary', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })

    await expect(
      store.write({
        title: 'R',
        content: 'body',
        frontmatter: null as never,
      }),
    ).rejects.toThrow('invalid durable string')
    await expect(
      store.write({
        title: 'R',
        content: 'body',
        frontmatter: [{ key: 'author', lines: ['author: A\0B'] }],
      }),
    ).rejects.toThrow('invalid durable string')
  })

  it.each([
    ['a NUL', 'author: A\0B'],
    ['a lone CR', 'author: A\rB'],
    ['an injected bare fence', 'author: A\n---\nhidden: B'],
  ])('rejects snapshot frontmatter containing %s', (_label, raw) => {
    expect(
      () =>
        new InMemoryStore({
          space: 'main',
          notes: [{ title: 'R', filePath: 'r.md', content: 'body', frontmatter: raw }],
        }),
    ).toThrow('invalid durable string')
  })

  it('rejects an oversized snapshot frontmatter block at the shared byte cap', () => {
    expect(
      () =>
        new InMemoryStore({
          space: 'main',
          notes: [
            {
              title: 'R',
              filePath: 'r.md',
              content: 'body',
              frontmatter: `author: ${'a'.repeat(FRONTMATTER_BYTE_CAP)}`,
            },
          ],
        }),
    ).toThrow('invalid durable string')
  })

  it('rejects final typed metadata that pushes a write over the frontmatter cap without mutation', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })

    await expect(
      store.write({ title: 'a'.repeat(FRONTMATTER_BYTE_CAP), content: 'body' }),
    ).rejects.toThrow('frontmatter exceeds the 64 KiB limit')
    expect(await store.list()).toEqual([])
  })

  it('keeps a compact near-cap carried aliases flow-list raw instead of expanding it', async () => {
    const raw = `aliases: [${Array.from({ length: 18_000 }, () => 'a').join(',')}]`
    const store = new InMemoryStore({ space: 'main', notes: [] })

    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'body',
      frontmatter: frontmatter(raw),
    })

    let file = ''

    for await (const entry of store.exportNotes()) {
      file = exportText(entry.content)
    }

    expect(file).toContain(`\n${raw}\n---`)
    expect(file.match(/^aliases:/gm)).toHaveLength(1)
  })

  it('rejects structural keyless YAML instead of exporting a mixed root', async () => {
    const store = new InMemoryStore({ space: 'main', notes: [] })

    await expect(
      store.write({
        title: 'Sequence',
        content: 'body',
        frontmatter: [{ key: null, lines: ['- item'] }],
      }),
    ).rejects.toThrow('invalid durable string')
    expect(await store.list()).toEqual([])
  })
})

describe('InMemoryStore — resolved creation dates survive fake read/export (#280)', () => {
  const exported = async (store: InMemoryStore): Promise<string> => {
    for await (const entry of store.exportNotes()) {
      if (entry.path === 'r.md') {
        return exportText(entry.content)
      }
    }

    return ''
  }

  it('materialises a frontmatter-less snapshot mtime as canonical created metadata', async () => {
    const createdAt = '2025-04-03T02:01:00.000Z'
    const store = new InMemoryStore({
      space: 'main',
      notes: [{ title: 'R', filePath: 'r.md', content: 'body', createdAt }],
    })

    const view = await store.read((await store.list())[0].id!)
    const file = await exported(store)
    expect(view.createdAt).toBe(createdAt)
    expect(view.frontmatter.created).toBe(createdAt)
    expect(file.match(/^created:/gm)).toHaveLength(1)
    expect(file).toContain(`created: ${createdAt}`)
    expect(file).not.toContain('notarium-created:')
  })

  it('keeps an ordinary create clock fallback out of authored frontmatter', async () => {
    const now = '2025-04-03T02:01:00.000Z'
    const store = new InMemoryStore({ space: 'main', now, notes: [] })
    const created = await store.write({ title: 'Plain', content: 'body' })

    const view = await store.read(created.id!)
    let file = ''

    for await (const entry of store.exportNotes()) {
      file = exportText(entry.content)
    }

    expect(view.createdAt).toBe(now)
    expect(view.frontmatter.created).toBeUndefined()
    expect(file).not.toMatch(/^(?:created|notarium-created):/m)
  })

  it('preserves an unknown creation date through an ordinary originalId edit', async () => {
    const store = new InMemoryStore({
      space: 'main',
      now: '2026-08-09T12:00:00.000Z',
      notes: [{ title: 'R', filePath: 'r.md', content: 'body', createdAt: null }],
    })
    const before = await store.read((await store.list())[0].id!)

    await store.write({
      title: 'R',
      content: 'updated',
      originalId: before.id,
      versionToken: before.versionToken,
    })

    const view = await store.read(before.id!)
    const file = await exported(store)
    expect(view.createdAt).toBeNull()
    expect(file).not.toMatch(/^(?:created|notarium-created):/m)
  })

  it('preserves an unknown creation date through a create-overwrite', async () => {
    const store = new InMemoryStore({
      space: 'main',
      now: '2026-08-09T12:00:00.000Z',
      notes: [{ title: 'R', filePath: 'r.md', content: 'body', createdAt: null }],
    })

    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'updated',
      ifExists: 'overwrite',
    })

    const view = await store.read((await store.list())[0].id!)
    const file = await exported(store)
    expect(view.createdAt).toBeNull()
    expect(file).not.toMatch(/^(?:created|notarium-created):/m)
  })

  it('keeps an unreadable authored created value and exposes the resolved date under the reserved key', async () => {
    const createdAt = '2025-04-03T02:01:00.000Z'
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'R',
          filePath: 'r.md',
          content: 'body',
          createdAt,
          frontmatter: 'created: someday\nauthor: S',
        },
      ],
    })

    const view = await store.read((await store.list())[0].id!)
    const file = await exported(store)
    expect(view.createdAt).toBe(createdAt)
    expect(view.frontmatter.created).toBe('someday')
    expect(view.frontmatter['notarium-created']).toBe(createdAt)
    expect(file).toContain('created: someday')
    expect(file).toContain(`notarium-created: ${createdAt}`)
  })

  it('an explicit date edit replaces stale unreadable raw dates instead of resurrecting them', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'R',
          filePath: 'r.md',
          content: 'body',
          createdAt: '2025-04-03T02:01:00.000Z',
          frontmatter: 'created: someday\nauthor: S',
        },
      ],
    })
    const before = await store.read((await store.list())[0].id!)
    const next = '2026-05-04T03:02:01.000Z'

    await store.write({
      title: 'R',
      content: 'updated',
      originalId: before.id,
      versionToken: before.versionToken,
      createdAt: next,
    })

    const view = await store.read(before.id!)
    const file = await exported(store)
    expect(view.createdAt).toBe(next)
    expect(view.frontmatter.created).toBe(next)
    expect(view.frontmatter['notarium-created']).toBeUndefined()
    expect(file).not.toContain('created: someday')
    expect(file).not.toContain('notarium-created:')
    expect(file.match(/^created:/gm)).toHaveLength(1)
  })

  it('a concrete loaded date owns readable raw created through an ordinary later write', async () => {
    const loaded = '2025-04-03T02:01:00.000Z'
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'R',
          filePath: 'r.md',
          content: 'body',
          createdAt: loaded,
          frontmatter: 'created: 1999-01-01\nauthor: S',
        },
      ],
    })
    const before = await store.read((await store.list())[0].id!)
    expect(before.createdAt).toBe(loaded)
    expect(before.frontmatter.created).toBe(loaded)

    await store.write({
      title: 'R',
      content: 'updated',
      originalId: before.id,
      versionToken: before.versionToken,
    })

    const view = await store.read(before.id!)
    const file = await exported(store)
    expect(view.createdAt).toBe(loaded)
    expect(view.frontmatter.created).toBe(loaded)
    expect(file).toContain(`created: ${loaded}`)
    expect(file).not.toContain('1999-01-01')
    expect(file.match(/^created:/gm)).toHaveLength(1)
  })

  it('an imported unreadable created value survives while its explicit fallback date stays canonical', async () => {
    const createdAt = '2025-04-03T02:01:00.000Z'
    const store = new InMemoryStore({ space: 'main', notes: [] })

    await store.write({
      title: 'R',
      fileName: 'r',
      content: 'body',
      createdAt,
      frontmatter: frontmatter('created: someday\nauthor: S'),
    })

    const view = await store.read((await store.list())[0].id!)
    const file = await exported(store)
    expect(view.frontmatter.created).toBe('someday')
    expect(view.frontmatter['notarium-created']).toBe(createdAt)
    expect(file).toContain('created: someday')
    expect(file).toContain(`notarium-created: ${createdAt}`)
  })
})

// Found in review round 5: the export filter must be derived from the keys the
// reconstruction ACTUALLY emits, not from a hand-kept list — otherwise a typed
// field the list forgot (tags/summary/type/muted) writes its line while the
// carried copy writes another, and the exported file contradicts itself.
describe('InMemoryStore — the export never states a key twice (#280)', () => {
  it('a carried key the typed field later occupies is replaced, not duplicated', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'My File',
          filePath: 'f.md',
          content: 'b',
          // Empty `tags:` and an authored `summary:` — shapes the lift reads no
          // value from, so they ride the carry.
          frontmatter: 'tags:\nsummary: hugo summary\nauthor: S',
          tags: ['x'],
          summary: 'agent summary',
          noteType: 'journal',
          muted: true,
        },
      ],
    })
    let file = ''

    for await (const e of store.exportNotes()) {
      file = exportText(e.content)
    }
    for (const key of ['tags', 'summary', 'type', 'muted', 'title']) {
      expect(file.match(new RegExp(`^${key}:`, 'gm'))).toHaveLength(1)
    }
    expect(file).toContain('summary: agent summary') // ours wins, like the real put()
    expect(file).toContain('author: S') // …and an untouched carried key survives
  })
})

// Found in review round 7: the no-duplicate filter was derived from the TYPED
// entries only, while `title:`/`notarium-id:` are written unconditionally — so a
// carried copy of either was emitted a second time, after ours, and a YAML reader
// takes the last one. The real engine's put() replaces by key and cannot do this.
describe('InMemoryStore — the note’s own identity is never the carry’s to state (#280)', () => {
  it('a carried title/notarium-id neither duplicates the line nor wins the read', async () => {
    const store = new InMemoryStore({
      space: 'main',
      notes: [
        {
          title: 'Ours',
          filePath: 'a.md',
          content: 'b',
          frontmatter: 'title: Theirs\nnotarium-id: foreign\nauthor: S',
        },
      ],
    })
    let file = ''

    for await (const e of store.exportNotes()) {
      file = exportText(e.content)
    }
    expect(file.match(/^title:/gm)).toHaveLength(1)
    expect(file.match(/^notarium-id:/gm)).toHaveLength(1)
    expect(file).toContain('title: Ours')
    expect(file).not.toContain('Theirs')
    expect(file).not.toContain('foreign')
    expect(file).toContain('author: S') // an ordinary carried key is untouched

    const meta = (await store.list()).find((n) => n.filePath === 'a.md')!
    const view = await store.read(meta.id!)
    expect(view.frontmatter.title).toBeUndefined()
    expect(view.frontmatter['notarium-id']).toBeUndefined()
    expect(view.frontmatter.author).toBe('S')
  })
})
