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
      // Every tombstone is RESTORABLE, matching the real stand (#256): the fake
      // projection stamps each seeded revision with the body it carried, so a
      // delete row keeps the note's last known content — exactly what the real
      // applier's `store.remove` captures. This assertion used to pin the opposite
      // (0 restorable) as a documented fake-projection gap; seeding the blobs is
      // what closed it, and pinning the parity is what keeps it closed.
      expect(trash.restorableTotal).toBe(9)
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
})
