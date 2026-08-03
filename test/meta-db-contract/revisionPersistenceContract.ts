// One executable contract for all revision-persistence implementations. This is
// the P9 guard around the meta/journal divergence: the in-memory twin, SQLite,
// and Postgres must agree on the port, not merely look equivalent in review.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type RevisionInput, RevisionJournal, type RevisionPersistence } from '@notarium/core'

export type RevisionPersistenceContractFactory = () => Promise<{
  persistence: RevisionPersistence
  teardown?: () => Promise<void>
}>

const revision = (over: Partial<RevisionInput> = {}): RevisionInput => ({
  noteId: 'note-a',
  space: 'space-a',
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  kind: 'write',
  principal: 'ui',
  contentHash: 'hash-a',
  title: 'Alpha',
  class: 'user-doc',
  slug: null,
  tags: ['one'],
  createdAt: '2026-06-12T10:00:00.000Z',
  charsAdded: 5,
  charsRemoved: 0,
  ...over,
})

export const describeRevisionPersistenceContract = (
  name: string,
  factory: RevisionPersistenceContractFactory,
): void => {
  describe(`RevisionPersistence contract — ${name}`, { timeout: 15_000 }, () => {
    let persistence: RevisionPersistence
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ persistence, teardown } = await factory())
      await persistence.init()
    })

    afterEach(async () => {
      await teardown?.()
    })

    it('appends monotonic ids and round-trips timeline windows, latest rows, and blobs', async () => {
      const first = await persistence.append(revision(), 'body-a')
      const second = await persistence.append(
        revision({
          baseRevisionId: first.id,
          contentHash: 'hash-b',
          title: 'Alpha renamed',
          slug: 'alpha-custom',
          tags: ['two'],
          createdAt: '2026-06-12T10:01:00.000Z',
          charsAdded: 8,
          charsRemoved: 2,
        }),
        'body-b',
      )
      // Content-addressing is first-write-wins for a hash.
      await persistence.append(
        revision({
          noteId: 'note-shared',
          contentHash: 'hash-b',
          title: 'Shared blob',
          createdAt: '2026-06-12T10:02:00.000Z',
        }),
        'body-that-must-not-replace-hash-b',
      )

      expect(Number(second.id)).toBeGreaterThan(Number(first.id))
      expect(await persistence.get('not-a-revision-id')).toBeNull()
      expect(await persistence.get(second.id)).toEqual(second)
      expect(await persistence.latestFor('note-a')).toEqual(second)
      expect(await persistence.latestFor('missing')).toBeNull()
      const latest = await persistence.latestForMany(['note-a', 'note-shared', 'missing', 'note-a'])
      expect(latest.get('note-a')).toEqual(second)
      expect(latest.get('note-shared')?.title).toBe('Shared blob')
      expect(latest.has('missing')).toBe(false)
      expect(await persistence.latestForMany([])).toEqual(new Map())
      expect(await persistence.content('hash-a')).toBe('body-a')
      expect(await persistence.content('hash-b')).toBe('body-b')
      expect(await persistence.content('missing')).toBeNull()

      const page = await persistence.listByNote('note-a', { offset: 0, limit: 1 })
      expect(page).toEqual({ items: [second], total: 2 })
      expect(await persistence.listByNote('note-a', { offset: 1, limit: 2 })).toEqual({
        items: [first],
        total: 2,
      })
    })

    it('accepts a latest-row set wider than SQLite host-variable limits', async () => {
      const present = await persistence.append(
        revision({ noteId: 'wide-present', contentHash: 'wide-hash', title: 'Wide present' }),
        'wide body',
      )
      // 32,767 exceeds the MAX_VARIABLE_NUMBER of the SQLite runtime used by
      // production. The port is unbounded, so every driver must treat this as
      // one set rather than one SQL placeholder per requested note.
      const ids = Array.from({ length: 32_767 }, (_, index) => `wide-missing-${index}`)
      ids[16_384] = 'wide-present'
      ids.push('wide-present') // duplicate semantics stay set-like at the same boundary

      const latest = await persistence.latestForMany(ids)

      expect([...latest.keys()]).toEqual(['wide-present'])
      expect(latest.get('wide-present')).toEqual(present)
    })

    it('collapses deltas after class filtering and computes total/max over the filtered world', async () => {
      const a1 = await persistence.append(revision(), 'a1')
      await persistence.append(
        revision({
          noteId: 'hidden',
          contentHash: 'hidden-1',
          title: 'Hidden one',
          class: 'agent-memory',
          createdAt: '2026-06-12T10:01:00.000Z',
        }),
        'hidden-1',
      )
      const a2 = await persistence.append(
        revision({
          baseRevisionId: a1.id,
          contentHash: 'hash-a2',
          createdAt: '2026-06-12T10:02:00.000Z',
        }),
        'a2',
      )
      const b1 = await persistence.append(
        revision({
          noteId: 'note-b',
          contentHash: 'hash-b1',
          title: 'Beta',
          class: null,
          createdAt: '2026-06-12T10:03:00.000Z',
        }),
        'b1',
      )
      const hiddenNewest = await persistence.append(
        revision({
          noteId: 'hidden',
          contentHash: 'hidden-2',
          title: 'Hidden two',
          class: 'agent-memory',
          createdAt: '2026-06-12T10:04:00.000Z',
        }),
        'hidden-2',
      )

      const delta = await persistence.listBySpaceSince('space-a', null, 1, ['agent-memory'])
      expect(delta.items.map((item) => item.id)).toEqual([b1.id])
      expect(delta.total).toBe(2)
      expect(delta.maxRevId).toBe(b1.id)
      expect(delta.maxRevId).not.toBe(hiddenNewest.id)

      const afterFirst = await persistence.listBySpaceSince('space-a', a1.id, 10, ['agent-memory'])
      expect(afterFirst.items.map((item) => item.id)).toEqual([b1.id, a2.id])
      expect(afterFirst.total).toBe(2)
      expect(afterFirst.maxRevId).toBe(b1.id)
      expect(await persistence.listBySpaceSince('other-space', null, 10)).toEqual({
        items: [],
        total: 0,
        maxRevId: null,
      })
    })

    it('round-trips the journal class carry-forward for body-less/delete states', async () => {
      let tick = 0
      const journal = new RevisionJournal({
        persistence,
        space: 'space-a',
        now: () => new Date(`2026-06-12T10:0${tick++}:00.000Z`),
      })

      await journal.record({
        noteId: 'memory-note',
        kind: 'write',
        principal: 'pat:alice:agent',
        content: 'memory body',
        title: 'Memory',
        class: 'agent-memory',
        tags: ['memory'],
      })
      await journal.record({
        noteId: 'memory-note',
        kind: 'delete',
        principal: 'pat:alice:agent',
        content: null,
        title: 'Memory',
      })

      const timeline = await journal.list('memory-note', { offset: 0, limit: 10 })
      expect(timeline.items.map((item) => item.class)).toEqual(['agent-memory', 'agent-memory'])
    })

    it('derives trash from the newest visible row and searches Unicode/literal wildcards', async () => {
      const deleted = await persistence.append(
        revision({
          noteId: 'trash-me',
          kind: 'delete',
          contentHash: 'trash-body',
          title: 'Журнал 100%_готов',
          createdAt: '2026-06-12T10:01:00.000Z',
        }),
        'restorable',
      )
      await persistence.append(
        revision({
          noteId: 'restored',
          kind: 'delete',
          contentHash: 'restored-body',
          title: 'Old tombstone',
          createdAt: '2026-06-12T10:02:00.000Z',
        }),
        'old',
      )
      await persistence.append(
        revision({
          noteId: 'restored',
          contentHash: 'restored-new',
          title: 'Back alive',
          createdAt: '2026-06-12T10:03:00.000Z',
        }),
        'new',
      )
      await persistence.append(
        revision({
          noteId: 'hidden-trash',
          kind: 'delete',
          contentHash: null,
          title: 'Hidden tombstone',
          class: 'agent-memory',
          createdAt: '2026-06-12T10:04:00.000Z',
        }),
        null,
      )

      const all = await persistence.listTrashed('space-a', { offset: 0, limit: 10 }, [
        'agent-memory',
      ])
      expect(all.items.map((item) => item.id)).toEqual([deleted.id])
      expect(all.total).toBe(1)
      expect(all.restorableTotal).toBe(1)

      const unicode = await persistence.listTrashed(
        'space-a',
        { offset: 0, limit: 10, q: 'жУРНАЛ' },
        ['agent-memory'],
      )
      expect(unicode.items.map((item) => item.id)).toEqual([deleted.id])
      const literalWildcard = await persistence.listTrashed(
        'space-a',
        { offset: 0, limit: 10, q: '%_' },
        ['agent-memory'],
      )
      expect(literalWildcard.items.map((item) => item.id)).toEqual([deleted.id])
    })

    it('purges whole note histories and GCs only blobs with no surviving referrer', async () => {
      await persistence.append(revision(), 'shared')
      await persistence.append(
        revision({
          noteId: 'note-b',
          contentHash: 'hash-a',
          title: 'Beta',
          createdAt: '2026-06-12T10:01:00.000Z',
        }),
        'ignored-duplicate',
      )
      await persistence.append(
        revision({
          noteId: 'note-c',
          contentHash: 'hash-c',
          title: 'Gamma',
          createdAt: '2026-06-12T10:02:00.000Z',
        }),
        'only-c',
      )

      await persistence.purgeNotes([])
      await persistence.purgeNotes(['note-a', 'note-c'])

      expect(await persistence.listByNote('note-a', { offset: 0, limit: 10 })).toEqual({
        items: [],
        total: 0,
      })
      expect(await persistence.content('hash-a')).toBe('shared')
      expect(await persistence.content('hash-c')).toBeNull()

      await persistence.purgeNotes(['note-b'])
      expect(await persistence.content('hash-a')).toBeNull()
    })

    it('keeps irreversible note purges terminal against late journal appends', async () => {
      const input = revision({
        noteId: 'terminal-note',
        contentHash: 'terminal-hash',
        title: 'Terminal',
      })
      await persistence.append(input, 'terminal body')
      await persistence.purgeNotes(['terminal-note'])

      await expect(persistence.append(input, 'late body')).rejects.toThrow(
        /revision target was permanently purged: note/,
      )
      expect(await persistence.latestFor('terminal-note')).toBeNull()
      expect(await persistence.content('terminal-hash')).toBeNull()
    })

    it('aggregates activity with timezone, class, baseline, range, and author semantics', async () => {
      const baseline = await persistence.append(
        revision({
          noteId: 'baseline',
          kind: 'external',
          principal: null,
          contentHash: 'baseline',
          createdAt: '2026-06-12T23:30:00.000Z',
        }),
        'baseline',
      )
      const created = await persistence.append(
        revision({
          noteId: 'mine',
          principal: 'user:alice',
          contentHash: 'mine-1',
          createdAt: '2026-06-12T23:35:00.000Z',
        }),
        'mine-1',
      )
      const edited = await persistence.append(
        revision({
          noteId: 'mine',
          baseRevisionId: created.id,
          principal: 'pat:alice:token-1',
          contentHash: 'mine-2',
          createdAt: '2026-06-12T23:40:00.000Z',
        }),
        'mine-2',
      )
      await persistence.append(
        revision({
          noteId: 'hidden',
          principal: 'user:alice',
          class: 'agent-memory',
          contentHash: 'hidden',
          createdAt: '2026-06-12T23:45:00.000Z',
        }),
        'hidden',
      )
      const deleted = await persistence.append(
        revision({
          noteId: 'theirs',
          kind: 'delete',
          principal: 'user:bob',
          contentHash: null,
          createdAt: '2026-06-12T23:50:00.000Z',
        }),
        null,
      )
      const author = { exact: ['user:alice'], prefixes: ['pat:alice:'] }
      const range = {
        from: '2026-06-12T00:00:00.000Z',
        to: '2026-06-14T00:00:00.000Z',
        excludeClasses: ['agent-memory'],
      }

      expect(
        await persistence.activityByDay('space-a', {
          ...range,
          tzOffsetMinutes: 120,
        }),
      ).toEqual([{ date: '2026-06-13', created: 1, edited: 1, deleted: 1 }])
      expect(
        await persistence.activityByDay('space-a', {
          ...range,
          tzOffsetMinutes: 120,
          author,
        }),
      ).toEqual([{ date: '2026-06-13', created: 1, edited: 1, deleted: 0 }])

      const events = await persistence.activityEvents('space-a', {
        ...range,
        offset: 0,
        limit: 1,
        author,
      })
      expect(events.items.map((item) => item.id)).toEqual([edited.id])
      expect(events.total).toBe(2)
      expect(events.items.map((item) => item.id)).not.toContain(baseline.id)
      expect(events.items.map((item) => item.id)).not.toContain(deleted.id)

      expect(
        (await persistence.activityByNote('space-a', range)).sort((a, b) =>
          a.noteId.localeCompare(b.noteId),
        ),
      ).toEqual([
        { noteId: 'mine', count: 2, lastAt: '2026-06-12T23:40:00.000Z' },
        { noteId: 'theirs', count: 1, lastAt: '2026-06-12T23:50:00.000Z' },
      ])
      expect(
        await persistence.activityEvents('space-a', {
          offset: 0,
          limit: 10,
          author: { exact: [], prefixes: [] },
        }),
      ).toEqual({ items: [], total: 0 })
    })

    it('reports latest timestamps and distinct non-empty historical names by space', async () => {
      await persistence.append(revision({ title: 'Alpha old' }), 'a1')
      await persistence.append(
        revision({
          contentHash: 'hash-a2',
          title: 'Alpha new',
          createdAt: '2026-06-12T10:02:00.000Z',
        }),
        'a2',
      )
      await persistence.append(
        revision({
          noteId: 'note-b',
          contentHash: 'hash-b',
          title: '',
          createdAt: '2026-06-12T10:01:00.000Z',
        }),
        'b',
      )
      await persistence.append(
        revision({
          noteId: 'other',
          space: 'space-b',
          contentHash: 'hash-other',
          title: 'Other space',
          createdAt: '2026-06-12T10:03:00.000Z',
        }),
        'other',
      )

      expect([...(await persistence.latestTimestamps('space-a')).entries()].sort()).toEqual([
        ['note-a', '2026-06-12T10:02:00.000Z'],
        ['note-b', '2026-06-12T10:01:00.000Z'],
      ])
      expect(
        [...((await persistence.historicalNames('space-a')).get('note-a') ?? [])].sort(),
      ).toEqual(['Alpha new', 'Alpha old'])
      expect((await persistence.historicalNames('space-a')).has('note-b')).toBe(false)
    })
  })
}
