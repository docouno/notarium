import { describe, expect, it } from 'vitest'

import type { AgentCallRecord, RetrievalLogInput } from '@notarium/server'
import { InMemoryAgentCalls } from './agentCalls'
import { InMemoryAgentSessions } from './agentSessions'
import { InMemoryRetrievalLog } from './retrievalLog'
import { InMemorySessionAudit } from './sessionAudit'

// The "which agent" facet counts what an agent DID, and the drivers hide the work of a
// session the human deleted — while keeping the work of one that merely aged out of
// retention (that marker retires the lifecycle row, not the record). The twin drifted
// from that rule once and nothing caught it: the number the product reads ran ahead of
// the drivers by exactly the rows of a session whose cleanup was still pending. This
// pins the three-way rule at the level it broke.
// canon: packages/server/src/services/metaDb/drivers/sqlite/sessionAudit.ts (agentFacet)
describe('the in-memory audit facet applies the drivers’ marker rules', () => {
  const OWNER = 'owner-1'

  const retrieval = (sessionId: string, agent: string): RetrievalLogInput => ({
    owner: OWNER,
    principal: `pat:${OWNER}:key`,
    agent,
    sessionId,
    sessionName: sessionId,
    sessionAttach: 'declared',
    tool: 'search',
    query: 'q',
    project: null,
    classFilter: null,
    resultCount: 1,
    topScore: 1,
    hits: [],
    createdAt: '2026-08-30T12:00:00.000Z',
  })

  const call = (id: string, sessionId: string, agent: string): AgentCallRecord => ({
    id,
    owner: OWNER,
    principal: `pat:${OWNER}:key`,
    agent,
    transport: 'mcp',
    requestId: null,
    sessionId,
    sessionName: sessionId,
    sessionAttach: 'declared',
    tool: 'get_note',
    effect: 'read',
    domain: 'notes',
    startedAt: '2026-08-30T12:00:00.000Z',
    finishedAt: '2026-08-30T12:00:01.000Z',
    durationMs: 1000,
    outcome: 'success',
    reasonCode: null,
    inputBytes: 0,
    outputBytes: 0,
    inputShape: null,
    issueSummary: null,
    targetSummary: null,
    resultSummary: null,
    fingerprint: `${id}-fp`,
    projectionVersion: 1,
    redacted: false,
    truncated: false,
    detailCaptureFailed: false,
  })

  const facetOf = async (marked: Record<string, 'human-delete' | 'retention'>) => {
    const sessions = new InMemoryAgentSessions()
    const retrievals = new InMemoryRetrievalLog()
    const calls = new InMemoryAgentCalls(sessions, retrievals)
    const audit = new InMemorySessionAudit(sessions, retrievals, calls)

    // The markers are what the drivers key on; setting them directly keeps this test on
    // the rule instead of on whichever maintenance path happens to write them today.
    calls.isHumanDeleted = (owner, sessionId) =>
      owner === OWNER && marked[sessionId] === 'human-delete'
    calls.isHidden = (owner, sessionId) => owner === OWNER && marked[sessionId] != null

    await retrievals.append(retrieval('clean', 'Reader'))
    await retrievals.append(retrieval('deleted', 'Reader'))
    await retrievals.append(retrieval('aged', 'Reader'))
    calls.seed([
      call('c1', 'clean', 'CLI'),
      call('c2', 'deleted', 'CLI'),
      call('c3', 'aged', 'CLI'),
    ])

    return Object.fromEntries(
      (await audit.agentFacet(OWNER)).map(({ agent, count }) => [agent, count]),
    )
  }

  it('drops a human-deleted session from both lenses and keeps a retention-expired one', async () => {
    expect(await facetOf({})).toEqual({ CLI: 3, Reader: 3 })
    // human-delete hides the work itself: the read AND the call go.
    expect(await facetOf({ deleted: 'human-delete' })).toEqual({ CLI: 2, Reader: 2 })
    // retention is a lifecycle marker: the CALL stops counting (any marker hides a call,
    // as in the drivers), the retrieval keeps counting.
    expect(await facetOf({ aged: 'retention' })).toEqual({ CLI: 2, Reader: 3 })
    expect(await facetOf({ deleted: 'human-delete', aged: 'retention' })).toEqual({
      CLI: 1,
      Reader: 2,
    })
  })
})
