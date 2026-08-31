import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RevisionInput } from '@notarium/core'

import type {
  AgentCallAdmission,
  AgentCallTracePersistence,
  AgentSessionAuditPersistence,
  AgentSessionsPersistence,
  RetrievalLogPersistence,
} from '../../packages/server/src/services/metaDb/types'

type AgentCallsContractFacets = {
  calls: AgentCallTracePersistence
  sessions: AgentSessionsPersistence
  audit: AgentSessionAuditPersistence
  retrievals: RetrievalLogPersistence
  revisions: {
    append(input: RevisionInput, content: string | null): Promise<unknown>
    listByNote(
      space: string,
      noteId: string,
      page: { offset: number; limit: number },
    ): Promise<{ items: unknown[] }>
  }
}

export type AgentCallsContractFactory = () => Promise<
  AgentCallsContractFacets & {
    restart(): Promise<AgentCallsContractFacets>
    teardown?: () => Promise<void>
  }
>

const session = (id: string, at: string) => ({
  id,
  owner: 'alice',
  name: 'Trace contract',
  named: true,
  parentId: null,
  createdAt: at,
  lastSeenAt: at,
  calls: 1,
  role: null,
  roleLocator: null,
  roleContextProjectId: null,
  projectId: null,
})

const admission = (id: string, at: string): AgentCallAdmission => ({
  id,
  owner: 'alice',
  principal: 'pat:alice:cli',
  agent: 'CLI',
  transport: 'mcp',
  requestId: 'request-1',
  tool: 'start_session',
  effect: 'mutation',
  domain: 'session',
  startedAt: at,
  inputBytes: 2,
  inputShape: [{ path: '$', type: 'object' }],
  targetSummary: {},
  fingerprint: 'fingerprint-before',
  projectionVersion: 1,
  redacted: false,
  truncated: false,
})

export const describeAgentCallsContract = (
  name: string,
  factory: AgentCallsContractFactory,
): void => {
  describe(`AgentCallTracePersistence contract — ${name}`, () => {
    let world: Awaited<ReturnType<AgentCallsContractFactory>>

    beforeEach(async () => {
      world = await factory()
    })
    afterEach(async () => {
      await world.teardown?.()
    })

    it('admits, projects, binds, details and finalizes one owner-scoped call', async () => {
      const at = '2026-01-01T00:00:00.000Z'
      const id = 'call_aaaaaaaaaaaa'
      const sessionId = 'ses_aaaaaaaaaaaa'
      await world.sessions.insert(session(sessionId, at))
      await world.calls.admit(admission(id, at))
      await expect(
        world.calls.projectInput('alice', id, { project: 'main' }, false, false),
      ).resolves.toBe(true)
      await expect(
        world.calls.bind('alice', id, {
          id: sessionId,
          name: 'Trace contract',
          attach: 'declared',
        }),
      ).resolves.toBe(true)
      await expect(
        world.calls.appendDetail({
          owner: 'alice',
          id,
          payload: { project: 'main' },
          createdAt: at,
          expiresAt: '2026-01-31T00:00:00.000Z',
        }),
      ).resolves.toBe(true)
      await expect(
        world.calls.finalize('alice', id, {
          finishedAt: '2026-01-01T00:00:00.010Z',
          durationMs: 10,
          outcome: 'success',
          reasonCode: null,
          outputBytes: 12,
          issueSummary: null,
          resultSummary: { 'session.state': 'new', sessionId },
          fingerprint: 'fingerprint-after',
          redacted: false,
          truncated: false,
          detailCaptureFailed: false,
        }),
      ).resolves.toBe(true)
      await expect(world.calls.get('bob', id)).resolves.toBeNull()
      await expect(world.calls.get('alice', id)).resolves.toMatchObject({
        id,
        sessionId,
        outcome: 'success',
        durationMs: 10,
        fingerprint: 'fingerprint-after',
      })
      await expect(world.calls.getDetail('alice', id, at)).resolves.toEqual({ project: 'main' })
    })

    it('uses CAS for the one instance telemetry configuration', async () => {
      const first = await world.calls.config()
      expect(first).toMatchObject({
        detailedEnabled: false,
        compactRetentionDays: 90,
        detailedRetentionDays: 30,
      })
      const changed = await world.calls.patchConfig({
        expectedVersionToken: first.versionToken,
        detailedEnabled: true,
        compactRetentionDays: 30,
        detailedRetentionDays: 7,
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
      expect(changed).toMatchObject({ detailedEnabled: true, compactRetentionDays: 30 })
      await expect(
        world.calls.patchConfig({
          expectedVersionToken: first.versionToken,
          detailedEnabled: false,
          updatedAt: '2026-01-01T00:00:01.000Z',
        }),
      ).resolves.toBeNull()
    })

    it('enforces Detail expiry and logical-delete visibility before physical cleanup', async () => {
      const at = '2026-01-01T00:00:00.000Z'
      const sessionId = 'ses_visibility'
      const first = 'call_visibility1'
      const second = 'call_visibility2'
      await world.sessions.insert(session(sessionId, at))

      for (const id of [first, second]) {
        await world.calls.admit(admission(id, at))
        await world.calls.bind('alice', id, {
          id: sessionId,
          name: 'Trace contract',
          attach: 'declared',
        })
        await world.calls.finalize('alice', id, {
          finishedAt: at,
          durationMs: 0,
          outcome: 'success',
          reasonCode: null,
          outputBytes: 1,
          issueSummary: null,
          resultSummary: { 'session.state': 'new' },
          fingerprint: id,
          redacted: false,
          truncated: false,
          detailCaptureFailed: false,
        })
      }
      await world.calls.appendDetail({
        owner: 'alice',
        id: second,
        payload: { project: 'private-selector' },
        createdAt: at,
        expiresAt: '2026-01-02T00:00:00.000Z',
      })
      await expect(world.calls.getDetail('alice', second, at)).resolves.toEqual({
        project: 'private-selector',
      })
      await expect(world.calls.exportDetails('alice', [second], at)).resolves.toMatchObject({
        [second]: { detailed: { project: 'private-selector' } },
      })
      await expect(
        world.calls.getDetail('alice', second, '2026-01-03T00:00:00.000Z'),
      ).resolves.toBeNull()
      await expect(
        world.calls.deleteSession({
          owner: 'alice',
          sessionId,
          activeSince: '2026-02-01T00:00:00.000Z',
          confirmActive: true,
          acceptedAt: '2026-02-01T00:00:00.000Z',
          batchSize: 1,
        }),
      ).resolves.toBe('deleting')
      await expect(world.calls.get('alice', first)).resolves.toBeNull()
      await expect(world.calls.get('alice', second)).resolves.toBeNull()
      await expect(world.calls.getDetail('alice', second, at)).resolves.toBeNull()
      await expect(world.calls.exportDetails('alice', [second], at)).resolves.toEqual({})
    })

    it('recovers a stale admission as one interrupted terminal call', async () => {
      const id = 'call_interrupted'
      await world.calls.admit(admission(id, '2026-01-01T00:00:00.000Z'))

      await expect(
        world.calls.recoverInterrupted('2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z'),
      ).resolves.toBe(1)
      await expect(world.calls.get('alice', id)).resolves.toMatchObject({
        outcome: 'internal_error',
        reasonCode: 'interrupted',
        finishedAt: '2026-01-01T00:02:00.000Z',
      })
    })

    it('keeps a resumed legacy episode partial and preserves its lifecycle count', async () => {
      const at = '2026-01-01T00:00:00.000Z'
      const sessionId = 'ses_legacy_resume'
      const id = 'call_legacyresume'
      await world.sessions.insert({ ...session(sessionId, at), calls: 7 })
      await world.calls.admit(admission(id, at))
      await world.calls.bind('alice', id, {
        id: sessionId,
        name: 'Trace contract',
        attach: 'declared',
      })
      await world.calls.finalize('alice', id, {
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1_000,
        outcome: 'success',
        reasonCode: null,
        outputBytes: 1,
        issueSummary: null,
        resultSummary: { 'session.state': 'resumed' },
        fingerprint: 'legacy-resume',
        redacted: false,
        truncated: false,
        detailCaptureFailed: false,
      })

      await expect(
        world.audit.find('alice', sessionId, '2025-12-31T00:00:00.000Z'),
      ).resolves.toMatchObject({ complete: false, calls: 7 })
      await expect(
        world.calls.expireSession({
          owner: 'alice',
          sessionId,
          expiredBefore: '2026-02-01T00:00:00.000Z',
          acceptedAt: '2026-02-01T00:00:00.000Z',
          batchSize: 100,
        }),
      ).resolves.toBe('fresh')
    })

    it('keeps revisions while retention cleanup is upgraded to human deletion', async () => {
      const at = '2026-01-01T00:00:00.000Z'
      const sessionId = 'ses_bbbbbbbbbbbb'
      const callId = 'call_bbbbbbbbbbbb'
      await world.sessions.insert(session(sessionId, at))
      await world.calls.admit(admission(callId, at))
      await world.calls.bind('alice', callId, {
        id: sessionId,
        name: 'Trace contract',
        attach: 'declared',
      })
      await world.calls.finalize('alice', callId, {
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1_000,
        outcome: 'success',
        reasonCode: null,
        outputBytes: 1,
        issueSummary: null,
        resultSummary: { 'session.state': 'new' },
        fingerprint: 'fingerprint-final',
        redacted: false,
        truncated: false,
        detailCaptureFailed: false,
      })
      await world.retrievals.append({
        owner: 'alice',
        principal: 'pat:alice:cli',
        agent: 'CLI',
        sessionId,
        sessionName: 'Trace contract',
        sessionAttach: 'declared',
        agentCallId: callId,
        tool: 'search',
        query: 'linked',
        project: null,
        classFilter: null,
        resultCount: 0,
        topScore: null,
        hits: [],
        createdAt: at,
      })
      await world.retrievals.append({
        owner: 'alice',
        principal: 'pat:alice:legacy',
        agent: 'Legacy',
        sessionId,
        sessionName: 'Trace contract',
        sessionAttach: 'declared',
        tool: 'search',
        query: 'legacy',
        project: null,
        classFilter: null,
        resultCount: 0,
        topScore: null,
        hits: [],
        createdAt: at,
      })
      await world.revisions.append(
        {
          noteId: 'note-trace-contract',
          space: 'space-a',
          baseRevisionId: null,
          theirRevisionId: null,
          sourceRevisionId: null,
          kind: 'write',
          entryRole: 'origin',
          principal: 'pat:alice:cli',
          agent: {
            owner: 'alice',
            agent: 'CLI',
            agentCallId: callId,
            session: { id: sessionId, name: 'Trace contract', attach: 'declared' },
          },
          contentHash: 'trace-contract-hash',
          stateFormat: null,
          title: 'Trace contract note',
          class: 'user-doc',
          slug: null,
          tags: [],
          createdAt: at,
          charsAdded: 1,
          charsRemoved: 0,
        },
        'body',
      )
      expect(
        (await world.calls.exportDetails('alice', [callId], at))[callId]?.revisions,
      ).toHaveLength(1)

      await expect(
        world.calls.expireSession({
          owner: 'alice',
          sessionId,
          expiredBefore: '2026-02-01T00:00:00.000Z',
          acceptedAt: '2026-02-01T00:00:00.000Z',
          batchSize: 100,
        }),
      ).resolves.toBe('complete')
      expect(
        (await world.retrievals.history({ owner: 'alice', offset: 0, limit: 10 })).items.map(
          (item) => item.query,
        ),
      ).toEqual(['legacy'])
      expect(
        (
          await world.revisions.listByNote('space-a', 'note-trace-contract', {
            offset: 0,
            limit: 10,
          })
        ).items,
      ).toHaveLength(1)

      await expect(
        world.calls.deleteSession({
          owner: 'alice',
          sessionId,
          activeSince: '2026-02-01T00:00:00.000Z',
          confirmActive: true,
          acceptedAt: '2026-02-02T00:00:00.000Z',
          batchSize: 100,
        }),
      ).resolves.toBe('complete')
      expect(
        (await world.retrievals.history({ owner: 'alice', offset: 0, limit: 10 })).items,
      ).toEqual([])
      expect(
        (
          await world.revisions.listByNote('space-a', 'note-trace-contract', {
            offset: 0,
            limit: 10,
          })
        ).items,
      ).toHaveLength(1)
      await expect(world.calls.exportDetails('alice', [callId], at)).resolves.toEqual({})
      await expect(
        world.calls.expireSession({
          owner: 'alice',
          sessionId,
          expiredBefore: '2026-03-01T00:00:00.000Z',
          acceptedAt: '2026-03-01T00:00:00.000Z',
          batchSize: 100,
        }),
      ).resolves.toBe('dominated')
    })

    it('upgrades pending retention and rejects every late diagnostic writer', async () => {
      const at = '2026-01-01T00:00:00.000Z'
      const sessionId = 'ses_pending_upgrade'
      const callId = 'call_pendingupgrd'
      const lateId = 'call_latewriter1'
      const lateFinalizeId = 'call_latefinalize'
      await world.sessions.insert(session(sessionId, at))
      await world.calls.admit(admission(callId, at))
      await world.calls.bind('alice', callId, {
        id: sessionId,
        name: 'Trace contract',
        attach: 'declared',
      })
      await world.calls.finalize('alice', callId, {
        finishedAt: at,
        durationMs: 0,
        outcome: 'success',
        reasonCode: null,
        outputBytes: 1,
        issueSummary: null,
        resultSummary: { 'session.state': 'new' },
        fingerprint: 'pending-upgrade',
        redacted: false,
        truncated: false,
        detailCaptureFailed: false,
      })
      await world.retrievals.append({
        owner: 'alice',
        principal: 'pat:alice:legacy',
        agent: 'Legacy',
        sessionId,
        sessionName: 'Trace contract',
        sessionAttach: 'declared',
        tool: 'search',
        query: 'legacy-pending',
        project: null,
        classFilter: null,
        resultCount: 0,
        topScore: null,
        hits: [],
        createdAt: at,
      })
      await world.calls.admit(admission(lateFinalizeId, '2026-01-01T00:00:02.000Z'))
      await expect(
        world.calls.bind('alice', lateFinalizeId, {
          id: sessionId,
          name: 'Trace contract',
          attach: 'declared',
        }),
      ).resolves.toBe(true)

      await expect(
        world.calls.expireSession({
          owner: 'alice',
          sessionId,
          expiredBefore: '2026-02-01T00:00:00.000Z',
          acceptedAt: '2026-02-01T00:00:00.000Z',
          batchSize: 0,
        }),
      ).resolves.toBe('deleting')
      await expect(
        world.calls.deleteSession({
          owner: 'alice',
          sessionId,
          activeSince: '2026-02-01T00:00:00.000Z',
          confirmActive: true,
          acceptedAt: '2026-02-02T00:00:00.000Z',
          batchSize: 0,
        }),
      ).resolves.toBe('deleting')
      await world.calls.admit(admission(lateId, '2026-02-02T00:00:01.000Z'))
      await expect(
        world.calls.bind('alice', lateId, {
          id: sessionId,
          name: 'Trace contract',
          attach: 'declared',
        }),
      ).resolves.toBe(false)
      await expect(
        world.calls.appendDetail({
          owner: 'alice',
          id: callId,
          payload: { late: true },
          createdAt: '2026-02-02T00:00:01.000Z',
          expiresAt: '2026-03-01T00:00:00.000Z',
        }),
      ).resolves.toBe(false)
      await expect(
        world.calls.finalize('alice', lateFinalizeId, {
          finishedAt: '2026-02-02T00:00:01.000Z',
          durationMs: 1,
          outcome: 'success',
          reasonCode: null,
          outputBytes: 1,
          issueSummary: null,
          resultSummary: { 'session.state': 'new' },
          fingerprint: 'late-finalize',
          redacted: false,
          truncated: false,
          detailCaptureFailed: false,
        }),
      ).resolves.toBe(false)
      await expect(
        world.sessions.setRole('alice', sessionId, {
          name: 'reviewer',
          locator: {
            source: 'owned',
            kind: 'role',
            packageId: 'AbCdefGhij_1',
            location: { scope: 'personal', spaceId: 'space-personal' },
          },
          contextProjectId: null,
        }),
      ).resolves.toBeNull()
      await expect(
        world.retrievals.append({
          owner: 'alice',
          principal: 'pat:alice:late',
          agent: 'Late',
          sessionId,
          sessionName: 'Trace contract',
          sessionAttach: 'declared',
          agentCallId: callId,
          tool: 'search',
          query: 'late',
          project: null,
          classFilter: null,
          resultCount: 0,
          topScore: null,
          hits: [],
          createdAt: '2026-02-02T00:00:01.000Z',
        }),
      ).resolves.toBeNull()
      await expect(
        world.calls.expireSession({
          owner: 'alice',
          sessionId,
          expiredBefore: '2026-03-01T00:00:00.000Z',
          acceptedAt: '2026-03-01T00:00:00.000Z',
          batchSize: 100,
        }),
      ).resolves.toBe('dominated')
      await expect(
        world.calls.deleteSession({
          owner: 'alice',
          sessionId,
          activeSince: '2026-03-01T00:00:00.000Z',
          confirmActive: true,
          acceptedAt: '2026-03-01T00:00:00.000Z',
          batchSize: 100,
        }),
      ).resolves.toBe('complete')
      await expect(
        world.retrievals.history({ owner: 'alice', offset: 0, limit: 10 }),
      ).resolves.toMatchObject({ items: [] })
    })

    it('serializes fresh touch and retention in both winner orders', async () => {
      const touchWinsId = 'ses_touch_wins'
      const retentionWinsId = 'ses_retention_wins'

      for (const [sessionId, callId] of [
        [touchWinsId, 'call_touch_wins'],
        [retentionWinsId, 'call_retention_win'],
      ] as const) {
        await world.sessions.insert(session(sessionId, '2026-01-01T00:00:00.000Z'))
        await world.calls.admit(admission(callId, '2026-01-01T00:00:00.000Z'))
        await world.calls.bind('alice', callId, {
          id: sessionId,
          name: 'Trace contract',
          attach: 'declared',
        })
        await world.calls.finalize('alice', callId, {
          finishedAt: '2026-01-01T00:00:01.000Z',
          durationMs: 1_000,
          outcome: 'success',
          reasonCode: null,
          outputBytes: 1,
          issueSummary: null,
          resultSummary: { 'session.state': 'new' },
          fingerprint: `complete-${sessionId}`,
          redacted: false,
          truncated: false,
          detailCaptureFailed: false,
        })
      }

      await expect(
        world.sessions.touch(
          'alice',
          touchWinsId,
          '2026-02-02T00:00:00.000Z',
          '2025-01-01T00:00:00.000Z',
        ),
      ).resolves.toMatchObject({ id: touchWinsId })
      await expect(
        world.calls.expireSession({
          owner: 'alice',
          sessionId: touchWinsId,
          expiredBefore: '2026-02-01T00:00:00.000Z',
          acceptedAt: '2026-02-02T00:00:00.000Z',
          batchSize: 100,
        }),
      ).resolves.toBe('fresh')
      await expect(
        world.sessions.getRetained('alice', touchWinsId, '2025-01-01T00:00:00.000Z'),
      ).resolves.toMatchObject({ id: touchWinsId })

      await expect(
        world.calls.expireSession({
          owner: 'alice',
          sessionId: retentionWinsId,
          expiredBefore: '2026-02-01T00:00:00.000Z',
          acceptedAt: '2026-02-02T00:00:00.000Z',
          batchSize: 0,
        }),
      ).resolves.toBe('deleting')
      await expect(
        world.sessions.touch(
          'alice',
          retentionWinsId,
          '2026-02-02T00:00:01.000Z',
          '2025-01-01T00:00:00.000Z',
        ),
      ).resolves.toBeNull()
      await expect(
        world.calls.expireSession({
          owner: 'alice',
          sessionId: retentionWinsId,
          expiredBefore: '2026-03-01T00:00:00.000Z',
          acceptedAt: '2026-03-01T00:00:00.000Z',
          batchSize: 0,
        }),
      ).resolves.toBe('deleting')
    })

    it('hides cleanup-marked calls from agent and recurring-problem aggregates', async () => {
      const at = '2026-01-01T00:00:00.000Z'
      const visibleSessionId = 'ses_problem_visible'
      const hiddenSessionId = 'ses_problem_hidden'

      for (const [sessionId, callId] of [
        [visibleSessionId, 'call_problem_visible'],
        [hiddenSessionId, 'call_problem_hidden'],
      ] as const) {
        const agent = sessionId === hiddenSessionId ? 'Hidden CLI' : 'CLI'
        await world.sessions.insert(session(sessionId, at))
        await world.calls.admit({ ...admission(callId, at), agent })
        await world.calls.bind('alice', callId, {
          id: sessionId,
          name: 'Trace contract',
          attach: 'declared',
        })
        await world.retrievals.append({
          owner: 'alice',
          principal: 'pat:alice:cli',
          agent,
          sessionId,
          sessionName: 'Trace contract',
          sessionAttach: 'declared',
          agentCallId: callId,
          tool: 'search',
          query: `shared-${sessionId}`,
          project: null,
          classFilter: null,
          resultCount: 0,
          topScore: null,
          hits: [],
          createdAt: at,
        })
        await world.calls.finalize('alice', callId, {
          finishedAt: at,
          durationMs: 0,
          outcome: 'invalid_arguments',
          reasonCode: 'input_validation',
          outputBytes: 1,
          issueSummary: [{ path: ['limit'], code: 'invalid_type' }],
          resultSummary: null,
          fingerprint: 'shared-problem',
          redacted: false,
          truncated: false,
          detailCaptureFailed: false,
        })
      }

      await expect(world.audit.agentFacet('alice')).resolves.toEqual([
        { agent: 'CLI', count: 1 },
        { agent: 'Hidden CLI', count: 1 },
      ])
      await expect(world.calls.recurringProblems('alice', at, 10)).resolves.toMatchObject([
        { fingerprint: 'shared-problem', count: 2, agents: 2 },
      ])
      await expect(world.retrievals.aggregates('alice')).resolves.toMatchObject({
        totalQueries: 2,
        missCount: 2,
      })
      await expect(
        world.calls.deleteSession({
          owner: 'alice',
          sessionId: hiddenSessionId,
          activeSince: '2026-02-01T00:00:00.000Z',
          confirmActive: true,
          acceptedAt: '2026-02-01T00:00:00.000Z',
          batchSize: 0,
        }),
      ).resolves.toBe('deleting')
      await expect(world.audit.agentFacet('alice')).resolves.toEqual([{ agent: 'CLI', count: 1 }])
      await expect(world.calls.recurringProblems('alice', at, 10)).resolves.toMatchObject([
        { fingerprint: 'shared-problem', count: 1, agents: 1 },
      ])
      await expect(world.retrievals.aggregates('alice')).resolves.toMatchObject({
        totalQueries: 1,
        missCount: 1,
      })
    })

    it('resumes bounded cleanup after reopening the persistence driver', async () => {
      const at = '2026-01-01T00:00:00.000Z'
      const sessionId = 'ses_restart_cleanup'
      const callIds = ['call_restart_0001', 'call_restart_0002', 'call_restart_0003']
      await world.sessions.insert(session(sessionId, at))

      for (const id of callIds) {
        await world.calls.admit(admission(id, at))
        await world.calls.bind('alice', id, {
          id: sessionId,
          name: 'Trace contract',
          attach: 'declared',
        })
        await world.calls.finalize('alice', id, {
          finishedAt: at,
          durationMs: 0,
          outcome: 'success',
          reasonCode: null,
          outputBytes: 1,
          issueSummary: null,
          resultSummary: { 'session.state': 'new' },
          fingerprint: `restart-${id}`,
          redacted: false,
          truncated: false,
          detailCaptureFailed: false,
        })
      }
      await expect(
        world.calls.deleteSession({
          owner: 'alice',
          sessionId,
          activeSince: '2026-02-01T00:00:00.000Z',
          confirmActive: true,
          acceptedAt: '2026-02-01T00:00:00.000Z',
          batchSize: 1,
        }),
      ).resolves.toBe('deleting')

      Object.assign(world, await world.restart())
      await expect(world.audit.find('alice', sessionId, at)).resolves.toBeNull()
      await expect(world.calls.resumeCleanup(1)).resolves.toMatchObject({
        completedOwners: [],
        pending: true,
      })
      await expect(world.calls.resumeCleanup(1)).resolves.toMatchObject({
        completedOwners: ['alice'],
        pending: false,
      })
      await expect(world.calls.get('alice', callIds[2]!)).resolves.toBeNull()
      await world.calls.admit(admission('call_restart_late', '2026-02-01T00:00:01.000Z'))
      await expect(
        world.calls.bind('alice', 'call_restart_late', {
          id: sessionId,
          name: 'Trace contract',
          attach: 'declared',
        }),
      ).resolves.toBe(false)
    })
  })
}
