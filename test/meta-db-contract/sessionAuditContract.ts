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
  principal: 'pat:alice:cli',
  contentHash: 'audit-write-hash',
  title: 'Changed note',
  class: 'user-doc',
  slug: null,
  tags: [],
  createdAt: '2026-07-03T00:00:00.000Z',
  charsAdded: 1,
  charsRemoved: 0,
  ...over,
})

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
        await facets.audit.events({ owner: 'bob', sessionId: 'ses_live', limit: 10 }),
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
        sessionId: 'ses_timeline',
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
        sessionId: 'ses_timeline',
        limit: 1,
        before: { at: read.record.createdAt, source: 'retrieval', id: read.record.id },
      })
      expect(second).toMatchObject({ total: 2, hasMore: false })
      expect(second.items[0]).toMatchObject({ type: 'write', sessionAttach: 'inferred' })
      expect(
        await facets.audit.events({
          owner: 'alice',
          sessionId: 'ses_timeline',
          type: 'write',
          limit: 10,
        }),
      ).toMatchObject({ total: 1, items: [expect.objectContaining({ type: 'write' })] })
    })
  })
}
