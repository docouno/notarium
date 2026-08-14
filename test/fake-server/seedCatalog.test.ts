import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { deterministicNoteId } from '@notarium/engine-memory'

import { buildCaseWorld, caseToFixture, DEFAULT_NOW } from '../cases'
import { createApp } from './app.js'

// The FAKE applier of the seed catalog (#175): a case → caseToFixture → the real
// fake backend (Fastify + CachedStore + journal over the in-memory driver). Proves
// the SAME catalog source that seeds the real stand also drives e2e/visual — the
// second of the "one source, two appliers" halves — and that its backdated
// activity flows through the journal into the dashboard aggregate, not one spike.

const json = (app: FastifyInstance, url: string) =>
  app.inject({ method: 'GET', url }).then((r) => r.json())

describe('seed catalog → fake backend (#175)', () => {
  it('trash-mixed: seeded deleted rows surface in the trash without runtime deletes', async () => {
    const world = buildCaseWorld('trash-mixed', { now: DEFAULT_NOW })
    const app = await createApp(caseToFixture(world))

    try {
      const trash = await json(app, '/api/s/main/trash')
      expect(trash.total).toBe(9) // 5 standalone + 3 folder + 1 project
      // The fake retains every tombstone body but has no durable strict-publish
      // authority. The aggregate follows the public capability predicate instead
      // of advertising a bulk action that can only return 503.
      expect(trash.restorableTotal).toBe(0)
      const notes = await json(app, '/api/s/main/notes')
      const created = world.events.filter((e) => e.op === 'create').length
      const deleted = world.events.filter((e) => e.op === 'delete').length
      const restored = world.events.filter((e) => e.op === 'restore').length
      // live = created − deleted + restored (a restored note returns to the tree)
      expect(notes.notes.length).toBe(created - deleted + restored)
      // The deleted-then-restored note specifically comes back (not just the count).
      expect(notes.notes.some((n: { title: string }) => n.title === 'Recovered draft')).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('restore-states projects exact/blocked/legacy/gap/opaque semantics from one catalog', async () => {
    const world = buildCaseWorld('restore-states', { now: DEFAULT_NOW })
    const fixture = caseToFixture(world)
    fixture.auth = undefined
    const activity = fixture.spaces.find((space) => space.slug === 'main')?.activity ?? []
    const app = await createApp(fixture)

    try {
      const trash = await json(app, '/api/s/main/trash')
      const availability = new Map(
        trash.items.map((item: { title: string; restoreAvailability: string }) => [
          item.title,
          item.restoreAvailability,
        ]),
      )

      expect(availability.get('Exact restorable deletion')).toBe('capability-unavailable')
      expect(availability.get('Blocked owner anchor')).toBe('blocked')
      expect(availability.get('Legacy partial snapshot')).toBe('capability-unavailable')
      expect(availability.get('Honest content gap')).toBe('gap')
      expect(availability.get('Opaque UTF-8 source')).toBe('opaque')
      expect(availability.get('Opaque binary source')).toBe('opaque')

      const exactId = deterministicNoteId('restore/exact-unicode.md')
      const revisions = await json(app, `/api/note/revisions?id=${exactId}`)
      const exact = await json(
        app,
        `/api/note/revision?id=${exactId}&revisionId=${revisions.revisions[0].revisionId}`,
      )
      expect(exact).toMatchObject({
        contentMode: 'markdown',
        stateFormat: 'markdown-v2',
        restoreAvailability: 'capability-unavailable',
      })
      expect(exact.snapshot).toContain('# authored comment\r\n')
      expect(exact.snapshot).toContain('café Ω')

      const opaqueRows = activity.filter((row) => row.stateFormat === 'opaque-v1')
      expect(opaqueRows).toHaveLength(3)
      expect(opaqueRows.some((row) => row.title === 'Invalid direct skill')).toBe(true)
      expect(opaqueRows.every((row) => Boolean(row.stateBlobBase64))).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('trash-mixed: a seeded revision chain is readable PER NOTE, with bodies and honest churn', async () => {
    // Pins the projection's id contract (#256): activity rows are stamped with the
    // id the in-memory store derives from the path, not the catalog's logical
    // handle. Without it the aggregates (heatmap/feed) still work, so nothing else
    // in the suite notices — while every per-note lookup returns empty on a world
    // that demonstrably has revisions, and the history panel reads "No history yet".
    const world = buildCaseWorld('trash-mixed', { now: DEFAULT_NOW })
    const app = await createApp(caseToFixture(world))

    try {
      // A deleted-then-restored note: create → delete → restore, the fullest chain
      // the fake projection can express.
      const path = 'notes/recovered-draft.md'
      const id = deterministicNoteId(path)
      const revs = await json(app, `/api/note/revisions?id=${id}`)
      // Exactly the events the case declares for that note — no more, no fewer.
      const declared = world.events.filter((e) => e.op === 'create' && e.path === path)
      expect(declared.length).toBe(1)
      const chain = world.events.filter((e) => e.noteId === declared[0].noteId)
      expect(revs.total).toBe(chain.length)
      expect(revs.revisions.map((r: { kind: string }) => r.kind)).toEqual([
        'restore',
        'delete',
        'write',
      ])
      // The bodies are seeded, so a revision READS rather than saying "body unknown".
      const newest = await json(
        app,
        `/api/note/revision?id=${id}&revisionId=${revs.revisions[0].revisionId}`,
      )
      expect(newest.content).toContain('Deleted by mistake')
      // The row belongs to the note it describes — the id contract itself.
      expect(revs.revisions[0].noteId).toBe(id)
      // A tombstone reports what it removed — the journal's own rule for a delete,
      // not a diff of the body against itself (which would print ±0).
      const tomb = revs.revisions.find((r: { kind: string }) => r.kind === 'delete')
      expect(tomb.charsAdded).toBe(0)
      expect(tomb.charsRemoved).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  it('history-rich seeds a full metadata-only revision, not a body-only decoration', async () => {
    const world = buildCaseWorld('history-rich', { now: DEFAULT_NOW })
    const fixture = caseToFixture(world)
    // This contract probes the seed projection and history wire, not auth; keep
    // the case's multi-author principals but serve it in the authless test host.
    fixture.auth = undefined
    const app = await createApp(fixture)

    try {
      const id = deterministicNoteId('releases/release-notes.md')
      const revs = await json(app, `/api/note/revisions?id=${id}`)
      expect(revs.revisions).toHaveLength(8)
      expect(
        revs.revisions.every(
          (revision: { stateFormat: string | null }) => revision.stateFormat === 'markdown-v1',
        ),
      ).toBe(true)

      // Day-22 is the fifth chronological state → fourth in an eight-row
      // newest-first window. Its body is unchanged; only authored FM moved.
      const metadata = revs.revisions[3]
      const parent = revs.revisions[4]
      const [metadataDetail, parentDetail] = await Promise.all([
        json(app, `/api/note/revision?id=${id}&revisionId=${metadata.revisionId}`),
        json(app, `/api/note/revision?id=${id}&revisionId=${parent.revisionId}`),
      ])
      expect(metadataDetail.content).toBe(parentDetail.content)
      expect(metadataDetail.snapshot).toContain('review-status: reviewed')
      expect(metadataDetail.snapshot).toContain('tags: [release, reviewed]')
      expect(parentDetail.snapshot).toContain('review-status: draft')
      expect(metadata.charsAdded + metadata.charsRemoved).toBeGreaterThan(0)
      const note = await json(app, `/api/note?id=${id}`)
      expect(note.frontmatter.tags).toEqual(['release', 'reviewed'])
    } finally {
      await app.close()
    }
  })

  it('identity-collision: the settled gap reaches the stand as an unavailable event', async () => {
    // The case seeds what a settlement LEAVES behind, so the surfaces built for it
    // (#327) can be seen on a stand rather than only in a unit test: a contaminated
    // revision served as a gap, and the ordinary edit that follows it. The pair is
    // the point — telling them apart needs the role the writer stored, because both
    // sit on a note whose trusted past is gone.
    const world = buildCaseWorld('identity-collision', { now: DEFAULT_NOW })
    const app = await createApp(caseToFixture(world))

    try {
      const events = await json(app, '/api/s/archive/activity/events?limit=50')
      const kinds = events.events.map((e: { kind: string }) => e.kind)

      expect(kinds).toContain('unavailable')
      expect(kinds).toContain('edited')
      const gap = events.events.find((e: { kind: string }) => e.kind === 'unavailable')

      // Neutral, and attributed to nobody — the gap contract, on a real stand.
      expect(gap).toMatchObject({ title: 'Unavailable revision', author: null })
      expect(gap.charsAdded).toBeNull()
      const days = await json(
        app,
        '/api/s/archive/activity?from=2026-06-01T00:00:00.000Z&to=2026-07-02T00:00:00.000Z&tz=0',
      )

      expect(
        days.days.reduce((n: number, d: { unavailable: number }) => n + d.unavailable, 0),
      ).toBe(1)
    } finally {
      await app.close()
    }
  })

  it('feed-scroll: backdated creates land on many heatmap days (an honest journal)', async () => {
    const world = buildCaseWorld('feed-scroll', { scale: 0.2, now: DEFAULT_NOW })
    const app = await createApp(caseToFixture(world))

    try {
      const res = await json(
        app,
        '/api/s/main/activity?from=2025-06-01T00:00:00.000Z&to=2026-07-02T00:00:00.000Z&tz=0',
      )
      const created = world.events.filter((e) => e.op === 'create').length
      const sumCreated = res.days.reduce((n: number, d: { created: number }) => n + d.created, 0)
      expect(sumCreated).toBe(created) // every seeded create counted
      expect(res.days.length).toBeGreaterThan(10) // spread across many days, not one spike
    } finally {
      await app.close()
    }
  })

  // #302: a pinned physical id must be the SAME note on every surface the fake
  // projects — the snapshot, the activity/history rows and the graph — or an
  // authored `[[notarium-id:…]]` would resolve to a note nobody seeded.
  it('import: a pinned physical id is one note across snapshot, links and history', async () => {
    const world = buildCaseWorld('import', { now: DEFAULT_NOW })
    const app = await createApp(caseToFixture(world))

    try {
      const notes = await json(app, '/api/s/main/notes?limit=200')
      const index = (notes.notes as Array<{ id: string; filePath: string }>).find(
        (n) => n.filePath === 'vault/index.md',
      )!
      const topic = (notes.notes as Array<{ id: string; filePath: string }>).find(
        (n) => n.filePath === 'vault/topics/retrieval.md',
      )!

      // The pin reached the snapshot rather than the path-derived default.
      expect(index.id).toBe('seedVaultIdx1')
      expect(topic.id).toBe('seedVaultTop1')
      expect(index.id).not.toBe(deterministicNoteId(index.filePath))
      // The authored exact link resolves to the note it names — the proof the copy
      // import's remap produces something the graph can actually follow.
      const graph = await json(app, '/api/s/main/graph')
      const edge = (graph.links as Array<{ source: string; target: string }>).find(
        (l) => l.source === index.id && l.target === topic.id,
      )

      expect(edge).toBeTruthy()
      // History addresses the same identity the snapshot published.
      const history = await json(app, `/api/note/revisions?id=${index.id}`)

      expect(history.total).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })
})
