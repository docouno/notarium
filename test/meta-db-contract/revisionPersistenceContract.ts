// One executable contract for all revision-persistence implementations. This is
// the P9 guard around the meta/journal divergence: the in-memory twin, SQLite,
// and Postgres must agree on the port, not merely look equivalent in review.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type RevisionInput, RevisionJournal, type RevisionPersistence } from '@notarium/core'

export type RevisionPersistenceContractFactory = () => Promise<{
  persistence: RevisionPersistence
  /** Serve these rows as gaps from now on. Quarantine is DECIDED inside the meta-DB's
   *  settlement transaction, which this port cannot reach and the in-memory twin cannot
   *  compute at all — so the state is installed the way a settled collision would leave
   *  it, and each implementation owes its consumers the same effective-field semantics
   *  (#327). Required, not optional: the axis reached only the SQL drivers' own contract
   *  once, and the twin — which serves every host without a meta-DB — went unpinned.
   *  canon: docs/note-history.md#model */
  quarantine: (revisionIds: readonly string[]) => Promise<void>
  teardown?: () => Promise<void>
}>

const revision = (over: Partial<RevisionInput> = {}): RevisionInput => ({
  noteId: 'note-a',
  space: 'space-a',
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  kind: 'write',
  entryRole: 'origin',
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
    let quarantine: (revisionIds: readonly string[]) => Promise<void>
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ persistence, quarantine, teardown } = await factory())
      await persistence.init()
    })

    afterEach(async () => {
      await teardown?.()
    })

    it('stores the entry role verbatim and never interprets it', async () => {
      // The role is a property of the ROW, written once by the writer. Each of the
      // three implementations stores and returns it; none of them re-derives it, and
      // the shapes that used to imply one (`external` with no parent, a write with a
      // parent) are deliberately mismatched here so a re-derivation shows up.
      const stored = await Promise.all([
        persistence.append(
          revision({ noteId: 'role-origin', entryRole: 'origin', contentHash: 'r1' }),
          'r1',
        ),
        persistence.append(
          revision({
            noteId: 'role-baseline',
            kind: 'external',
            entryRole: 'baseline',
            baseRevisionId: '1',
            contentHash: 'r2',
          }),
          'r2',
        ),
        persistence.append(
          revision({ noteId: 'role-change', entryRole: 'change', contentHash: 'r3' }),
          'r3',
        ),
      ])

      for (const row of stored) {
        const read = await persistence.get('space-a', row.id)

        expect([row.noteId, row.entryRole]).toEqual([row.noteId, read?.entryRole])
      }
      expect(stored.map((row) => row.entryRole)).toEqual(['origin', 'baseline', 'change'])
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
      expect(await persistence.get('space-a', 'not-a-revision-id')).toBeNull()
      expect(await persistence.get('space-a', second.id)).toEqual(second)
      expect(await persistence.latestFor('space-a', 'note-a')).toEqual(second)
      expect(await persistence.latestFor('space-a', 'missing')).toBeNull()
      const latest = await persistence.latestForMany('space-a', [
        'note-a',
        'note-shared',
        'missing',
        'note-a',
      ])
      expect(latest.get('note-a')).toEqual(second)
      expect(latest.get('note-shared')?.title).toBe('Shared blob')
      expect(latest.has('missing')).toBe(false)
      expect(await persistence.latestForMany('space-a', [])).toEqual(new Map())
      expect(await persistence.content('hash-a')).toBe('body-a')
      expect(await persistence.content('hash-b')).toBe('body-b')
      expect(await persistence.content('missing')).toBeNull()

      const page = await persistence.listByNote('space-a', 'note-a', { offset: 0, limit: 1 })
      expect(page).toEqual({ items: [second], total: 2 })
      expect(await persistence.listByNote('space-a', 'note-a', { offset: 1, limit: 2 })).toEqual({
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

      const latest = await persistence.latestForMany('space-a', ids)

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

    it('never suppresses a synthetic baseline in the DELTA', async () => {
      // The `external`-with-no-parent suppression is an ACTIVITY rule: it stops a
      // pre-existing note's first sighting from double-counting its first edit. The
      // delta is a sync cursor, not a count — dropping the row there hides the note
      // from every agent until it happens to be edited again, and the mistake is
      // easy to make because the Activity twin of this predicate sits next to it.
      const baseline = await persistence.append(
        revision({
          noteId: 'seen-first',
          kind: 'external',
          entryRole: 'baseline',
          baseRevisionId: null,
          contentHash: null,
          createdAt: '2026-06-12T10:00:00.000Z',
        }),
        null,
      )
      const delta = await persistence.listBySpaceSince('space-a', null, 10)

      expect(delta.items.map((r) => r.id)).toContain(baseline.id)
      expect(delta.maxRevId).toBe(baseline.id)
      // …while Activity, over the very same row, counts nothing.
      expect(
        await persistence.activityByDay('space-a', {
          from: '2026-06-12T00:00:00.000Z',
          to: '2026-06-13T00:00:00.000Z',
          tzOffsetMinutes: 0,
        }),
      ).toEqual([])
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

      await persistence.purgeNotes('space-a', [])
      await persistence.purgeNotes('space-a', ['note-a', 'note-c'])

      expect(await persistence.listByNote('space-a', 'note-a', { offset: 0, limit: 10 })).toEqual({
        items: [],
        total: 0,
      })
      expect(await persistence.content('hash-a')).toBe('shared')
      expect(await persistence.content('hash-c')).toBeNull()

      await persistence.purgeNotes('space-a', ['note-b'])
      expect(await persistence.content('hash-a')).toBeNull()
    })

    it('spares a blob a NEIGHBOURING space still references', async () => {
      // The DELETE is space-scoped and the blob GC deliberately is NOT: the CAS is
      // shared by hash, so two spaces that stored identical bytes hold one row
      // between them. Narrowing the referrer probe to the purged space erases the
      // other space's body irreversibly, and every same-space case above still
      // passes while it does (#327).
      await persistence.append(
        revision({ noteId: 'mine', contentHash: 'hash-shared' }),
        'bytes both spaces wrote',
      )
      await persistence.append(
        revision({
          noteId: 'theirs',
          space: 'space-b',
          contentHash: 'hash-shared',
          createdAt: '2026-06-12T10:01:00.000Z',
        }),
        'bytes both spaces wrote',
      )

      await persistence.purgeNotes('space-a', ['mine'])

      expect(await persistence.content('hash-shared')).toBe('bytes both spaces wrote')
      expect(
        await persistence.listByNote('space-b', 'theirs', { offset: 0, limit: 10 }),
      ).toMatchObject({ total: 1 })

      // …and when the last referrer ANYWHERE goes, the blob goes with it.
      await persistence.purgeNotes('space-b', ['theirs'])

      expect(await persistence.content('hash-shared')).toBeNull()
    })

    it('keeps irreversible note purges terminal against late journal appends', async () => {
      const input = revision({
        noteId: 'terminal-note',
        contentHash: 'terminal-hash',
        title: 'Terminal',
      })
      await persistence.append(input, 'terminal body')
      await persistence.purgeNotes('space-a', ['terminal-note'])

      await expect(persistence.append(input, 'late body')).rejects.toThrow(
        /revision target was permanently purged: note/,
      )
      expect(await persistence.latestFor('space-a', 'terminal-note')).toBeNull()
      expect(await persistence.content('terminal-hash')).toBeNull()
    })

    it('aggregates activity with timezone, class, baseline, range, and author semantics', async () => {
      const baseline = await persistence.append(
        revision({
          noteId: 'baseline',
          kind: 'external',
          entryRole: 'baseline',
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
          entryRole: 'change',
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
      ).toEqual([{ date: '2026-06-13', created: 1, edited: 1, deleted: 1, unavailable: 0 }])
      expect(
        await persistence.activityByDay('space-a', {
          ...range,
          tzOffsetMinutes: 120,
          author,
        }),
      ).toEqual([{ date: '2026-06-13', created: 1, edited: 1, deleted: 0, unavailable: 0 }])

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

    // The whole note-addressed surface takes a `space` (#327). Legacy data holds
    // ONE note id in TWO spaces by construction — that is the collision the arbiter
    // exists for — so every one of these methods has to answer for its own space
    // and no other. Without a fixture that actually collides, ignoring the argument
    // entirely is indistinguishable from honouring it.
    it('answers note-addressed reads for its OWN space when one id lives in two', async () => {
      const shared = 'collided'
      const mine = await persistence.append(
        revision({ noteId: shared, space: 'space-a', title: 'Mine', contentHash: 'hash-mine' }),
        'mine',
      )
      const theirs = await persistence.append(
        revision({
          noteId: shared,
          space: 'space-b',
          title: 'Theirs',
          contentHash: 'hash-theirs',
          createdAt: '2026-06-12T10:05:00.000Z',
        }),
        'theirs',
      )

      const window = await persistence.listByNote('space-a', shared, { offset: 0, limit: 50 })

      expect(window.total).toBe(1)
      expect(window.items.map((r) => r.id)).toEqual([mine.id])
      expect(await persistence.get('space-a', theirs.id)).toBeNull()
      expect(await persistence.get('space-b', theirs.id)).toMatchObject({ title: 'Theirs' })
      expect(await persistence.latestFor('space-a', shared)).toMatchObject({ title: 'Mine' })
      expect(await persistence.latestFor('space-b', shared)).toMatchObject({ title: 'Theirs' })
      expect([...(await persistence.latestForMany('space-a', [shared])).values()]).toEqual([
        expect.objectContaining({ title: 'Mine' }),
      ])
      expect(await persistence.hasAnyFor('space-a', shared)).toBe(true)

      // …and a purge stays inside its own space: the other space's history and its
      // permanent fence are untouched, so it can still journal its own note.
      await persistence.purgeNotes('space-a', [shared])

      expect(await persistence.hasAnyFor('space-a', shared)).toBe(false)
      expect(await persistence.hasAnyFor('space-b', shared)).toBe(true)
      expect(await persistence.latestFor('space-b', shared)).toMatchObject({ title: 'Theirs' })
      await expect(
        persistence.append(
          revision({
            noteId: shared,
            space: 'space-b',
            title: 'Theirs again',
            contentHash: 'hash-theirs-2',
            createdAt: '2026-06-12T10:06:00.000Z',
          }),
          'theirs again',
        ),
      ).resolves.toMatchObject({ title: 'Theirs again' })
    })

    // A gap is history that cannot be believed: it stays in the stream (cursors,
    // totals and pages must not shift) and is barred from every surface that would
    // make it operational state or attribute it. Each method below reads its own
    // predicate, and each could read a raw column and still look right in review.
    // canon: docs/note-history.md#model
    describe('a quarantined row (#327)', () => {
      /** A note whose newest row is a DELETE and whose whole history is contaminated:
       *  the shape that tells an integrity filter apart from a kind filter, since the
       *  same rows would otherwise be a tombstone, a timestamp and an alias. */
      const seedGap = async () => {
        const clean = await persistence.append(
          revision({ noteId: 'kept', title: 'Kept', contentHash: 'hash-kept' }),
          'kept',
        )
        const crossed = await persistence.append(
          revision({
            noteId: 'gapped',
            title: 'Their title',
            contentHash: 'hash-gapped',
            createdAt: '2026-06-12T10:01:00.000Z',
          }),
          'gapped',
        )
        const tombstone = await persistence.append(
          revision({
            noteId: 'gapped',
            kind: 'delete',
            baseRevisionId: crossed.id,
            title: 'Their title',
            contentHash: 'hash-gapped-final',
            createdAt: '2026-06-12T10:02:00.000Z',
          }),
          'gapped final',
        )
        await quarantine([crossed.id, tombstone.id])

        return { clean, crossed, tombstone }
      }

      it('serves the row withheld, and keeps counting it as history', async () => {
        const { crossed, tombstone } = await seedGap()
        const window = await persistence.listByNote('space-a', 'gapped', { offset: 0, limit: 50 })

        expect(window.total).toBe(2)
        expect(window.items.map((r) => r.id)).toEqual([tombstone.id, crossed.id])
        expect(window.items[1]).toMatchObject({
          id: crossed.id,
          noteId: 'gapped',
          space: 'space-a',
          kind: 'write',
          unavailableReason: 'identity-conflict',
          principal: null,
          contentHash: null,
          class: null,
          title: 'Unavailable revision',
          baseRevisionId: null,
          charsAdded: null,
          charsRemoved: null,
          tags: [],
        })
        // Still history: the write path must not invent a fresh baseline over a
        // past it cannot read.
        expect(await persistence.hasAnyFor('space-a', 'gapped')).toBe(true)
        expect(await persistence.get('space-a', crossed.id)).toMatchObject({
          unavailableReason: 'identity-conflict',
        })
      })

      it('is never operational state, on either latest surface', async () => {
        const { clean } = await seedGap()

        expect(await persistence.latestFor('space-a', 'gapped')).toBeNull()
        // The bulk twin is the one the read-model actually calls at boot; it used to
        // be pinned nowhere, so a missing integrity filter here surfaced another
        // space's bytes as the note's current state.
        const heads = await persistence.latestForMany('space-a', ['gapped', 'kept'])

        expect([...heads.keys()]).toEqual(['kept'])
        expect(heads.get('kept')).toMatchObject({ id: clean.id, title: 'Kept' })
      })

      it('becomes neither a tombstone, nor a timestamp, nor an alias', async () => {
        await seedGap()

        expect(await persistence.listTrashed('space-a', { offset: 0, limit: 50 })).toMatchObject({
          items: [],
          total: 0,
          restorableTotal: 0,
        })
        expect((await persistence.latestTimestamps('space-a')).has('gapped')).toBe(false)
        expect((await persistence.latestTimestamps('space-a')).has('kept')).toBe(true)
        expect((await persistence.historicalNames('space-a')).has('gapped')).toBe(false)
        expect((await persistence.historicalNames('space-a')).get('kept')).toEqual(['Kept'])
      })

      it('travels the delta and can BE its high-water mark', async () => {
        const { crossed, tombstone } = await seedGap()
        // The class filter must read the EFFECTIVE class: the raw one is `user-doc`
        // on every row here, and consulting it would drop the gap the cursor has to
        // step over.
        const delta = await persistence.listBySpaceSince('space-a', crossed.id, 50, ['user-doc'])

        expect(delta.items.map((r) => r.id)).toEqual([tombstone.id])
        expect(delta.total).toBe(1)
        expect(delta.maxRevId).toBe(tombstone.id)
      })

      it('gets its own activity bucket and belongs to no author', async () => {
        await seedGap()
        const range = { from: '2026-06-12T00:00:00.000Z', to: '2026-06-13T00:00:00.000Z' }
        const days = await persistence.activityByDay('space-a', {
          ...range,
          tzOffsetMinutes: 0,
          excludeClasses: [],
        })

        expect(days).toEqual([
          expect.objectContaining({ unavailable: 2, created: 1, edited: 0, deleted: 0 }),
        ])
        // A gap belongs to nobody: a scope cannot claim it through the principal it
        // is withholding.
        const mine = await persistence.activityByDay('space-a', {
          ...range,
          tzOffsetMinutes: 0,
          excludeClasses: [],
          author: { exact: ['ui'], prefixes: [] },
        })

        expect(mine.reduce((sum, d) => sum + d.unavailable, 0)).toBe(0)
      })

      it('keeps a contaminated BASELINE in the unavailable bucket', async () => {
        // Quarantine does not touch the role, so a gap can perfectly well be a
        // baseline — and the suppression is written `QUARANTINED OR entry_role <>
        // 'baseline'` precisely so that row still emits. Shorten it to its second
        // half and this row disappears from Activity entirely. No other case here
        // catches that: every other quarantined row in this file is a `write`.
        const baseline = await persistence.append(
          revision({
            noteId: 'gapped-baseline',
            kind: 'external',
            entryRole: 'baseline',
            principal: null,
            title: 'Seen once',
            contentHash: 'hash-seen',
            createdAt: '2026-06-12T10:03:00.000Z',
          }),
          'seen',
        )

        await quarantine([baseline.id])
        const days = await persistence.activityByDay('space-a', {
          from: '2026-06-12T00:00:00.000Z',
          to: '2026-06-13T00:00:00.000Z',
          tzOffsetMinutes: 0,
          excludeClasses: [],
        })

        expect(days).toEqual([expect.objectContaining({ unavailable: 1 })])
        const events = await persistence.activityEvents('space-a', {
          from: '2026-06-12T00:00:00.000Z',
          to: '2026-06-13T00:00:00.000Z',
          offset: 0,
          limit: 10,
          excludeClasses: [],
        })

        expect(events.items.map((r) => r.id)).toEqual([baseline.id])
      })

      it('goes away with the note it belongs to', async () => {
        await seedGap()
        await persistence.purgeNotes('space-a', ['gapped'])

        expect(await persistence.hasAnyFor('space-a', 'gapped')).toBe(false)
        expect(await persistence.hasAnyFor('space-a', 'kept')).toBe(true)
      })
    })
  })
}
