import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RevisionInput } from '@notarium/core'

import type {
  AgentSessionAuditPersistence,
  AgentSessionsPersistence,
  RetrievalLogInput,
  RetrievalLogPersistence,
} from '../../packages/server/src/services/metaDb/types'

export type SessionAuditContractFactory = () => Promise<{
  audit: AgentSessionAuditPersistence
  retrievals: RetrievalLogPersistence
  revisions: {
    append(input: RevisionInput, content: string | null): Promise<unknown>
  }
  sessions: AgentSessionsPersistence
  teardown?: () => Promise<void>
}>

const retrieval = (
  over: Partial<RetrievalLogInput> & Pick<RetrievalLogInput, 'createdAt'>,
): RetrievalLogInput => ({
  owner: 'alice',
  principal: 'pat:alice:cli',
  agent: 'CLI',
  sessionId: null,
  sessionName: null,
  sessionAttach: null,
  tool: 'search',
  query: 'query',
  project: null,
  classFilter: null,
  resultCount: 1,
  topScore: 0.9,
  hits: [],
  ...over,
})

const revision = (over: Partial<RevisionInput> = {}): RevisionInput => ({
  noteId: 'note-a',
  space: 'space-a',
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  kind: 'write',
  entryRole: 'origin',
  principal: 'pat:alice:cli',
  contentHash: 'audit-write-hash',
  stateFormat: null,
  title: 'Changed note',
  class: 'user-doc',
  slug: null,
  tags: [],
  createdAt: '2026-07-03T00:00:00.000Z',
  charsAdded: 1,
  charsRemoved: 0,
  ...over,
})

const eventKey = (
  event: Awaited<ReturnType<AgentSessionAuditPersistence['events']>>['items'][number],
) => (event.type === 'retrieval' ? `retrieval:${event.record.id}` : `write:${event.id}`)

const eventCursor = (
  event: Awaited<ReturnType<AgentSessionAuditPersistence['events']>>['items'][number],
) =>
  event.type === 'retrieval'
    ? { at: event.record.createdAt, source: 'retrieval' as const, id: event.record.id }
    : { at: event.at, source: 'write' as const, id: event.id }

export const describeSessionAuditContract = (
  name: string,
  factory: SessionAuditContractFactory,
): void => {
  describe(`AgentSessionAuditPersistence contract — ${name}`, { timeout: 15_000 }, () => {
    let facets: Awaited<ReturnType<SessionAuditContractFactory>>

    beforeEach(async () => {
      facets = await factory()
    })

    afterEach(async () => {
      await facets.teardown?.()
    })

    it('folds retained and archived sessions while isolating outside activity by owner', async () => {
      await facets.sessions.insert({
        id: 'ses_live',
        owner: 'alice',
        name: 'Live review',
        named: true,
        parentId: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        lastSeenAt: '2026-07-03T00:00:00.000Z',
        calls: 7,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
      })
      await facets.retrievals.append(
        retrieval({
          sessionId: 'ses_live',
          sessionName: 'Live review',
          sessionAttach: 'declared',
          createdAt: '2026-07-02T00:00:00.000Z',
        }),
      )
      await facets.revisions.append(
        revision({
          agent: {
            owner: 'alice',
            agent: 'CLI',
            session: { id: 'ses_live', name: 'Live review', attach: 'inferred' },
          },
        }),
        'session write',
      )
      await facets.retrievals.append(
        retrieval({
          sessionId: 'ses_archived',
          sessionName: 'Archived review',
          sessionAttach: 'declared',
          createdAt: '2026-06-01T00:00:00.000Z',
        }),
      )
      await facets.revisions.append(
        revision({
          noteId: 'archived-write',
          createdAt: '2026-06-01T01:00:00.000Z',
          agent: {
            owner: 'alice',
            agent: 'CLI',
            session: { id: 'ses_archived', name: 'Archived review', attach: 'declared' },
          },
        }),
        'archived write',
      )
      await facets.retrievals.append(
        retrieval({ query: 'outside', createdAt: '2026-07-04T00:00:00.000Z' }),
      )
      await facets.revisions.append(
        revision({
          noteId: 'outside-note',
          contentHash: 'outside-write-hash',
          createdAt: '2026-07-04T01:00:00.000Z',
          agent: { owner: 'alice', agent: 'CLI' },
        }),
        'outside write',
      )
      await facets.retrievals.append(
        retrieval({ owner: 'bob', query: 'private', createdAt: '2026-07-05T00:00:00.000Z' }),
      )

      const overview = await facets.audit.overview({
        owner: 'alice',
        activeSince: '2026-07-02T12:00:00.000Z',
        limit: 10,
      })
      expect(overview).toMatchObject({ total: 2, active: 1, outside: { reads: 1, writes: 1 } })
      expect(overview.items).toEqual([
        expect.objectContaining({
          id: 'ses_live',
          calls: 7,
          reads: 1,
          writes: 1,
          retained: true,
          active: true,
        }),
        expect.objectContaining({
          id: 'ses_archived',
          name: 'Archived review',
          calls: null,
          reads: 1,
          writes: 1,
          retained: false,
        }),
      ])
      expect(
        await facets.audit.find('alice', 'ses_archived', '2026-07-02T12:00:00.000Z'),
      ).toMatchObject({ retained: false, name: 'Archived review' })
      expect(await facets.audit.find('bob', 'ses_live', '2026-07-02T12:00:00.000Z')).toBeNull()
      expect(
        await facets.audit.events({
          owner: 'bob',
          scope: { kind: 'session', id: 'ses_live' },
          limit: 10,
        }),
      ).toMatchObject({ total: 0, items: [] })

      const firstPage = await facets.audit.overview({
        owner: 'alice',
        activeSince: '2026-07-02T12:00:00.000Z',
        limit: 1,
      })
      expect(firstPage).toMatchObject({ total: 2, hasMore: true })
      const last = firstPage.items[0]
      const secondPage = await facets.audit.overview({
        owner: 'alice',
        activeSince: '2026-07-02T12:00:00.000Z',
        limit: 1,
        before: { at: last.lastSeenAt, id: last.id },
      })
      expect(secondPage).toMatchObject({ total: 2, hasMore: false })
      expect(secondPage.items[0].id).toBe('ses_archived')

      const emptyTerminalPage = await facets.audit.overview({
        owner: 'alice',
        activeSince: '2026-07-02T12:00:00.000Z',
        limit: 1,
        before: {
          at: secondPage.items[0].lastSeenAt,
          id: secondPage.items[0].id,
        },
      })
      expect(emptyTerminalPage).toMatchObject({
        items: [],
        total: 2,
        active: 1,
        hasMore: false,
      })
    })

    it('filters overview before stats, cursor pagination and the Outside projection', async () => {
      await facets.sessions.insert({
        id: 'ses_reads',
        owner: 'alice',
        name: 'Reads only',
        named: true,
        parentId: null,
        createdAt: '2026-07-03T00:00:00.000Z',
        lastSeenAt: '2026-07-03T00:00:00.000Z',
        calls: 2,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
      })
      await facets.sessions.insert({
        id: 'ses_writes',
        owner: 'alice',
        name: 'Writes only',
        named: true,
        parentId: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        lastSeenAt: '2026-07-01T00:00:00.000Z',
        calls: 2,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
      })
      await facets.retrievals.append(
        retrieval({
          sessionId: 'ses_reads',
          sessionName: 'Reads only',
          sessionAttach: 'declared',
          createdAt: '2026-07-03T01:00:00.000Z',
        }),
      )
      await facets.revisions.append(
        revision({
          noteId: 'writes-only-note',
          contentHash: 'writes-only-hash',
          createdAt: '2026-07-01T01:00:00.000Z',
          agent: {
            owner: 'alice',
            agent: 'CLI',
            session: { id: 'ses_writes', name: 'Writes only', attach: 'declared' },
          },
        }),
        'writes only',
      )
      await facets.retrievals.append(
        retrieval({ query: 'outside read', createdAt: '2026-07-02T00:00:00.000Z' }),
      )

      const reads = await facets.audit.overview({
        owner: 'alice',
        activeSince: '2026-07-02T12:00:00.000Z',
        type: 'retrieval',
        limit: 1,
      })
      expect(reads).toMatchObject({
        total: 1,
        active: 1,
        hasMore: false,
        outside: { reads: 1, writes: 0 },
      })
      expect(reads.items.map((item) => item.id)).toEqual(['ses_reads'])

      const writes = await facets.audit.overview({
        owner: 'alice',
        activeSince: '2026-07-02T12:00:00.000Z',
        type: 'write',
        limit: 1,
      })
      expect(writes).toMatchObject({ total: 1, active: 0, hasMore: false, outside: null })
      expect(writes.items.map((item) => item.id)).toEqual(['ses_writes'])

      const terminal = await facets.audit.overview({
        owner: 'alice',
        activeSince: '2026-07-02T12:00:00.000Z',
        type: 'write',
        limit: 1,
        before: { at: writes.items[0].lastSeenAt, id: writes.items[0].id },
      })
      expect(terminal).toMatchObject({
        items: [],
        total: 1,
        active: 0,
        hasMore: false,
        outside: null,
      })
    })

    it('merges read and write sources with a stable cursor and type filter', async () => {
      await facets.retrievals.append(
        retrieval({
          sessionId: 'ses_timeline',
          sessionName: 'Timeline',
          sessionAttach: 'declared',
          query: 'same-time read',
          createdAt: '2026-07-03T00:00:00.000Z',
        }),
      )
      await facets.revisions.append(
        revision({
          agent: {
            owner: 'alice',
            agent: 'CLI',
            session: { id: 'ses_timeline', name: 'Timeline', attach: 'inferred' },
          },
        }),
        'newer write',
      )

      const first = await facets.audit.events({
        owner: 'alice',
        scope: { kind: 'session', id: 'ses_timeline' },
        limit: 1,
      })
      expect(first).toMatchObject({ total: 2, hasMore: true })
      const read = first.items[0]
      expect(read).toMatchObject({
        type: 'retrieval',
        record: { query: 'same-time read', sessionAttach: 'declared' },
      })

      if (read.type !== 'retrieval') {
        throw new Error('expected retrieval event')
      }
      const second = await facets.audit.events({
        owner: 'alice',
        scope: { kind: 'session', id: 'ses_timeline' },
        limit: 1,
        before: { at: read.record.createdAt, source: 'retrieval', id: read.record.id },
      })
      expect(second).toMatchObject({ total: 2, hasMore: false })
      expect(second.items[0]).toMatchObject({ type: 'write', sessionAttach: 'inferred' })
      expect(
        await facets.audit.events({
          owner: 'alice',
          scope: { kind: 'session', id: 'ses_timeline' },
          type: 'write',
          limit: 10,
        }),
      ).toMatchObject({ total: 1, items: [expect.objectContaining({ type: 'write' })] })
    })

    it('pages the owner-global union without duplicates while preserving scope and filters', async () => {
      const session = (id: string, sessionName: string) => ({
        id,
        name: sessionName,
        attach: 'declared' as const,
      })
      await facets.retrievals.append(
        retrieval({
          sessionId: 'ses_a',
          sessionName: 'Session A',
          query: 'session-a-read',
          createdAt: '2026-07-01T01:00:00.000Z',
        }),
      )
      await facets.revisions.append(
        revision({
          noteId: 'session-a-write',
          contentHash: 'session-a-write',
          createdAt: '2026-07-01T02:00:00.000Z',
          agent: { owner: 'alice', agent: 'CLI', session: session('ses_a', 'Session A') },
        }),
        'session a',
      )
      await facets.retrievals.append(
        retrieval({ query: 'outside-read', createdAt: '2026-07-01T03:00:00.000Z' }),
      )
      await facets.revisions.append(
        revision({
          noteId: 'outside-write',
          contentHash: 'outside-write',
          createdAt: '2026-07-01T04:00:00.000Z',
          agent: { owner: 'alice', agent: 'CLI' },
        }),
        'outside',
      )
      await facets.retrievals.append(
        retrieval({
          sessionId: 'ses_b',
          sessionName: 'Session B',
          query: 'session-b-read',
          createdAt: '2026-07-01T05:00:00.000Z',
        }),
      )
      await facets.revisions.append(
        revision({
          noteId: 'session-b-write',
          contentHash: 'session-b-write',
          createdAt: '2026-07-01T06:00:00.000Z',
          agent: { owner: 'alice', agent: 'CLI', session: session('ses_b', 'Session B') },
        }),
        'session b',
      )
      await facets.retrievals.append(
        retrieval({
          owner: 'bob',
          query: 'private',
          createdAt: '2026-07-01T07:00:00.000Z',
        }),
      )

      const snapshot = await facets.audit.events({
        owner: 'alice',
        scope: { kind: 'all' },
        limit: 100,
      })
      expect(snapshot).toMatchObject({ total: null, hasMore: false })
      expect(snapshot.items).toHaveLength(6)
      const first = await facets.audit.events({
        owner: 'alice',
        scope: { kind: 'all' },
        limit: 2,
      })
      expect(first).toMatchObject({ total: null, hasMore: true })

      await facets.retrievals.append(
        retrieval({ query: 'inserted later', createdAt: '2026-07-01T08:00:00.000Z' }),
      )
      const walked = [...first.items]
      let page = first

      while (page.hasMore) {
        page = await facets.audit.events({
          owner: 'alice',
          scope: { kind: 'all' },
          limit: 2,
          before: eventCursor(page.items.at(-1)!),
        })
        expect(page.total).toBeNull()
        walked.push(...page.items)
      }
      expect(walked.map(eventKey)).toEqual(snapshot.items.map(eventKey))
      expect(new Set(walked.map(eventKey)).size).toBe(snapshot.items.length)

      const afterInsert = await facets.audit.events({
        owner: 'alice',
        scope: { kind: 'all' },
        limit: 100,
      })
      const scoped = await Promise.all([
        facets.audit.events({
          owner: 'alice',
          scope: { kind: 'session', id: 'ses_a' },
          limit: 100,
        }),
        facets.audit.events({
          owner: 'alice',
          scope: { kind: 'session', id: 'ses_b' },
          limit: 100,
        }),
        facets.audit.events({ owner: 'alice', scope: { kind: 'outside' }, limit: 100 }),
      ])
      const scopedKeys = scoped.flatMap((result) => result.items.map(eventKey))
      expect(new Set(scopedKeys)).toEqual(new Set(afterInsert.items.map(eventKey)))
      expect(scoped[2].total).toBeNull()
      const bob = await facets.audit.events({ owner: 'bob', scope: { kind: 'all' }, limit: 100 })
      expect(bob).toMatchObject({
        total: null,
        items: [
          expect.objectContaining({
            type: 'retrieval',
            record: expect.objectContaining({ owner: 'bob', query: 'private' }),
          }),
        ],
      })
      expect(
        await facets.audit.events({
          owner: 'alice',
          scope: { kind: 'all' },
          agent: 'CLI',
          limit: 100,
        }),
      ).toMatchObject({ items: expect.arrayContaining(snapshot.items) })
      expect(
        await facets.audit.events({
          owner: 'alice',
          scope: { kind: 'all' },
          tool: 'search',
          query: 'outside-read',
          limit: 100,
        }),
      ).toMatchObject({
        total: null,
        items: [expect.objectContaining({ type: 'retrieval' })],
      })
      expect(await facets.audit.agentFacet('alice')).toEqual([{ agent: 'CLI', count: 7 }])
      expect(snapshot.items).toContainEqual(
        expect.objectContaining({
          type: 'write',
          sessionId: 'ses_b',
          sessionName: 'Session B',
        }),
      )
    })

    it('keeps the exact session total across windows larger than the page', async () => {
      for (let index = 0; index < 6; index += 1) {
        await facets.retrievals.append(
          retrieval({
            sessionId: 'ses_long',
            sessionName: 'Long session',
            query: `query-${index}`,
            createdAt: `2026-07-02T00:00:0${index}.000Z`,
          }),
        )
      }
      const first = await facets.audit.events({
        owner: 'alice',
        scope: { kind: 'session', id: 'ses_long' },
        limit: 2,
      })
      expect(first).toMatchObject({ total: 6, hasMore: true })
      const second = await facets.audit.events({
        owner: 'alice',
        scope: { kind: 'session', id: 'ses_long' },
        limit: 2,
        before: eventCursor(first.items.at(-1)!),
      })
      expect(second).toMatchObject({ total: 6, hasMore: true })
    })

    it('matches retrieval query fragments literally and case-insensitively', async () => {
      await facets.retrievals.append(
        retrieval({ query: 'Unbound context', createdAt: '2026-07-01T01:00:00.000Z' }),
      )
      await facets.retrievals.append(
        retrieval({ query: 'literal 100%_done', createdAt: '2026-07-01T02:00:00.000Z' }),
      )
      await facets.retrievals.append(
        retrieval({ query: 'literal 100XXdone', createdAt: '2026-07-01T03:00:00.000Z' }),
      )

      const fragment = await facets.audit.events({
        owner: 'alice',
        scope: { kind: 'all' },
        query: 'CONTEXT',
        limit: 10,
      })
      expect(fragment.items).toEqual([
        expect.objectContaining({
          type: 'retrieval',
          record: expect.objectContaining({ query: 'Unbound context' }),
        }),
      ])

      const literalWildcards = await facets.audit.events({
        owner: 'alice',
        scope: { kind: 'all' },
        query: '%_',
        limit: 10,
      })
      expect(literalWildcards.items).toEqual([
        expect.objectContaining({
          type: 'retrieval',
          record: expect.objectContaining({ query: 'literal 100%_done' }),
        }),
      ])
    })
  })
}
