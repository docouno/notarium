import type { Revision } from '@notarium/core'
import {
  type AgentSessionAuditEvent,
  type AgentSessionAuditPersistence,
  type AgentSessionAuditSummary,
  auditWriteGapOf,
} from '@notarium/server'

import type { InMemoryAgentCalls } from './agentCalls'
import type { InMemoryAgentSessions } from './agentSessions'
import type { InMemoryRetrievalLog } from './retrievalLog'

type AuditWrite = Extract<AgentSessionAuditEvent, { type: 'write' }> & {
  owner: string
  sessionId: string | null
  sessionName: string | null
  /** The journal row this tap mirrors, so a later quarantine of that row reaches
   *  the audit too — the SQL drivers read one row and see `integrity` directly. */
  revisionId: string
  agentCallId: string | null
}

type AuditGroup = {
  id: string
  name: string
  firstAt: string
  lastAt: string
  reads: number
  writes: number
  calls: number
  complete: boolean
}

const compareIdDesc = (left: string, right: string): number => {
  const leftId = BigInt(left)
  const rightId = BigInt(right)
  return leftId === rightId ? 0 : rightId > leftId ? 1 : -1
}

const byNewest = (left: { at: string; source: number; id: string }, right: typeof left): number =>
  right.at.localeCompare(left.at) ||
  right.source - left.source ||
  (left.source === 2 ? right.id.localeCompare(left.id) : compareIdDesc(left.id, right.id))

/** Executable in-memory twin used by the full fake-server vertical. The shared
 * SQLite/PostgreSQL persistence contract pins the DRIVERS, not this class — it is not
 * run against the twin. Only `agentFacet`'s marker rules are pinned here, by
 * `sessionAuditParity.test.ts`; it drifted once because nothing did. The same two
 * predicates also gate `overview` and `events`, and those are still unpinned. */
export class InMemorySessionAudit implements AgentSessionAuditPersistence {
  private writes: AuditWrite[] = []
  private quarantined = new Set<string>()
  private nextWriteId = 0

  constructor(
    private readonly sessions: InMemoryAgentSessions,
    private readonly retrievals: InMemoryRetrievalLog,
    private readonly calls: InMemoryAgentCalls,
  ) {}

  captureRevision(revision: Revision): void {
    const attribution = revision.agent

    if (!attribution) {
      return
    }
    this.writes.push({
      type: 'write',
      id: String(++this.nextWriteId),
      revisionId: revision.id,
      agentCallId: attribution.agentCallId ?? null,
      at: revision.createdAt,
      owner: attribution.owner,
      agent: attribution.agent,
      principal: revision.principal,
      sessionId: attribution.session?.id ?? null,
      sessionName: attribution.session?.name ?? null,
      sessionAttach: attribution.session?.attach ?? null,
      noteId: revision.noteId,
      space: revision.space,
      title: revision.title,
      class: revision.class,
      revisionKind: revision.kind,
    })
  }

  /** The journal quarantined these rows — the audit mirrors the same rows, so the
   *  write events built from them become gaps too. */
  quarantineRevisions(revisionIds: readonly string[]): void {
    for (const id of revisionIds) {
      this.quarantined.add(id)
    }
  }

  clearWritesForSpace(space: string): void {
    for (const write of this.writes) {
      if (write.space === space) {
        this.quarantined.delete(write.revisionId)
      }
    }
    this.writes = this.writes.filter((write) => write.space !== space)
  }

  linkedRevisions(owner: string, agentCallId: string) {
    return this.writes
      .filter((write) => write.owner === owner && write.agentCallId === agentCallId)
      .map((write) => {
        const event = { ...write }

        Reflect.deleteProperty(event, 'owner')
        Reflect.deleteProperty(event, 'revisionId')
        Reflect.deleteProperty(event, 'agentCallId')
        return this.quarantined.has(write.revisionId) ? auditWriteGapOf(event) : event
      })
  }

  private auditGroups(owner: string): Map<string, AuditGroup> {
    const groups = new Map<string, AuditGroup>()

    const add = (id: string, name: string | null, at: string, type: 'read' | 'write' | 'call') => {
      const current = groups.get(id)

      if (!current) {
        groups.set(id, {
          id,
          name: name ?? 'Archived session',
          firstAt: at,
          lastAt: at,
          reads: type === 'read' ? 1 : 0,
          writes: type === 'write' ? 1 : 0,
          calls: type === 'call' ? 1 : 0,
          complete: false,
        })
        return
      }
      current.firstAt = current.firstAt < at ? current.firstAt : at
      if (at >= current.lastAt) {
        current.lastAt = at
        current.name = name ?? current.name
      }
      current.reads += type === 'read' ? 1 : 0
      current.writes += type === 'write' ? 1 : 0
      current.calls += type === 'call' ? 1 : 0
    }

    // A human deletion hides the reads and writes of the session too, exactly as the
    // SQL drivers' summary CTE does — and it must, because a delete removes the
    // lifecycle row and the call rows but never the note revisions the episode wrote.
    // Without this a session that exists ONLY as an audit group survives its own
    // deletion and the next overview brings it straight back. (`events` already
    // filtered this way; only the group roll-up did not.) Retention expiry is a
    // different reason and deliberately keeps them: it collects the lifecycle row, not
    // the record of what the agent did.
    for (const retrieval of this.retrievals.snapshot()) {
      if (
        retrieval.owner === owner &&
        retrieval.sessionId &&
        retrieval.agentCallId == null &&
        !this.calls.isHumanDeleted(owner, retrieval.sessionId)
      ) {
        add(retrieval.sessionId, retrieval.sessionName, retrieval.createdAt, 'read')
      }
    }
    for (const write of this.writes) {
      if (
        write.owner === owner &&
        write.sessionId &&
        write.agentCallId == null &&
        !this.calls.isHumanDeleted(owner, write.sessionId)
      ) {
        add(write.sessionId, write.sessionName, write.at, 'write')
      }
    }
    for (const call of this.calls.snapshot()) {
      if (
        call.owner === owner &&
        call.sessionId &&
        call.outcome &&
        !this.calls.isHidden(owner, call.sessionId)
      ) {
        add(
          call.sessionId,
          call.sessionName,
          call.startedAt,
          call.effect === 'read' ? 'read' : call.effect === 'mutation' ? 'write' : 'call',
        )
        const group = groups.get(call.sessionId)

        if (group && call.effect !== 'control') {
          group.calls += 1
        }
        const state =
          call.resultSummary &&
          typeof call.resultSummary === 'object' &&
          !Array.isArray(call.resultSummary)
            ? call.resultSummary['session.state']
            : null

        if (
          group &&
          call.tool === 'start_session' &&
          call.outcome === 'success' &&
          (state === 'new' || state === 'forked')
        ) {
          group.complete = true
        }
      }
    }

    return groups
  }

  private summaries(owner: string, activeSince: string): AgentSessionAuditSummary[] {
    const audit = this.auditGroups(owner)
    const retained = this.sessions.snapshot().filter((session) => session.owner === owner)
    const items: AgentSessionAuditSummary[] = retained.map((session) => {
      const group = audit.get(session.id)
      audit.delete(session.id)
      return {
        id: session.id,
        name: session.name,
        named: session.named,
        parentId: session.parentId,
        createdAt: session.createdAt,
        lastSeenAt: group && group.lastAt > session.lastSeenAt ? group.lastAt : session.lastSeenAt,
        calls: group?.complete ? group.calls : session.calls,
        reads: group?.reads ?? 0,
        writes: group?.writes ?? 0,
        retained: true,
        active: session.lastSeenAt >= activeSince,
        complete: group?.complete ?? false,
      }
    })

    for (const group of audit.values()) {
      items.push({
        id: group.id,
        name: group.name,
        named: null,
        parentId: null,
        createdAt: group.firstAt,
        lastSeenAt: group.lastAt,
        calls: group.calls || null,
        reads: group.reads,
        writes: group.writes,
        retained: false,
        active: false,
        complete: group.complete,
      })
    }

    return items.sort(
      (left, right) =>
        right.lastSeenAt.localeCompare(left.lastSeenAt) || right.id.localeCompare(left.id),
    )
  }

  private outside(owner: string) {
    const reads = this.retrievals
      .snapshot()
      .filter((row) => row.owner === owner && row.sessionId == null && row.agentCallId == null)
    const writes = this.writes.filter(
      (row) => row.owner === owner && row.sessionId == null && row.agentCallId == null,
    )
    const calls = this.calls
      .snapshot()
      .filter((row) => row.owner === owner && row.sessionId == null && row.outcome)
    const lastSeenAt = [
      ...reads.map((row) => row.createdAt),
      ...writes.map((row) => row.at),
      ...calls.map((row) => row.startedAt),
    ]
      .sort()
      .at(-1)
    return lastSeenAt
      ? {
          reads: reads.length + calls.filter((row) => row.effect === 'read').length,
          writes: writes.length + calls.filter((row) => row.effect === 'mutation').length,
          lastSeenAt,
        }
      : null
  }

  async overview({
    owner,
    activeSince,
    type,
    limit,
    before,
  }: Parameters<AgentSessionAuditPersistence['overview']>[0]) {
    const all = this.summaries(owner, activeSince).filter((item) =>
      type === 'retrieval' ? item.reads > 0 : type === 'write' ? item.writes > 0 : true,
    )
    const matched = before
      ? all.filter(
          (item) =>
            item.lastSeenAt < before.at || (item.lastSeenAt === before.at && item.id < before.id),
        )
      : all
    const page = matched.slice(0, limit + 1)
    const outside = this.outside(owner)
    const outsideMatches =
      outside != null &&
      (type === 'retrieval' ? outside.reads > 0 : type === 'write' ? outside.writes > 0 : true)
    return {
      items: page.slice(0, limit),
      total: all.length,
      active: all.filter((item) => item.active).length,
      outside: outsideMatches ? outside : null,
      hasMore: page.length > limit,
    }
  }

  async find(owner: string, sessionId: string, activeSince: string) {
    return this.summaries(owner, activeSince).find((item) => item.id === sessionId) ?? null
  }

  async events({
    owner,
    scope,
    type,
    agent,
    tool,
    query,
    outcome,
    withTotal,
    limit,
    before,
  }: Parameters<AgentSessionAuditPersistence['events']>[0]) {
    const inScope = (sessionId: string | null): boolean =>
      scope.kind === 'all' ||
      (scope.kind === 'outside' ? sessionId == null : sessionId === scope.id)
    const retrievals = this.retrievals
      .snapshot()
      .filter(
        (row) =>
          row.owner === owner &&
          row.agentCallId == null &&
          !(row.sessionId && this.calls.isHumanDeleted(owner, row.sessionId)) &&
          inScope(row.sessionId) &&
          (agent == null || row.agent === agent) &&
          (tool == null || row.tool === tool) &&
          (query == null || row.query.toLowerCase().includes(query.toLowerCase())) &&
          (type == null || type === 'retrieval') &&
          outcome == null,
      )
      .map((record) => ({
        event: { type: 'retrieval' as const, record },
        at: record.createdAt,
        source: 1,
        id: record.id,
      }))
    const writes = this.writes
      .filter(
        (row) =>
          row.owner === owner &&
          row.agentCallId == null &&
          !(row.sessionId && this.calls.isHumanDeleted(owner, row.sessionId)) &&
          inScope(row.sessionId) &&
          (agent == null || (!this.quarantined.has(row.revisionId) && row.agent === agent)) &&
          tool == null &&
          query == null &&
          (type == null || type === 'write') &&
          outcome == null,
      )
      .map((row) => {
        const event = {
          type: row.type,
          id: row.id,
          at: row.at,
          principal: row.principal,
          agent: row.agent,
          sessionId: row.sessionId,
          sessionName: row.sessionName,
          sessionAttach: row.sessionAttach,
          noteId: row.noteId,
          space: row.space,
          title: row.title,
          class: row.class,
          revisionKind: row.revisionKind,
        }
        return {
          event: this.quarantined.has(row.revisionId) ? auditWriteGapOf(event) : event,
          at: row.at,
          source: 0,
          id: row.id,
        }
      })
    const calls = this.calls
      .snapshot()
      .filter(
        (row) =>
          row.owner === owner &&
          row.outcome != null &&
          !(row.sessionId && this.calls.isHidden(owner, row.sessionId)) &&
          inScope(row.sessionId) &&
          (agent == null || row.agent === agent) &&
          (tool == null || row.tool === tool) &&
          (query == null ||
            (['search', 'recall', 'get_note'].includes(row.tool) &&
              row.targetSummary &&
              typeof row.targetSummary === 'object' &&
              !Array.isArray(row.targetSummary) &&
              typeof (row.targetSummary.query ?? row.targetSummary.ref) === 'string' &&
              String(row.targetSummary.query ?? row.targetSummary.ref)
                .toLowerCase()
                .includes(query.toLowerCase()))) &&
          (type == null ||
            (type === 'retrieval' ? row.effect === 'read' : row.effect === 'mutation')) &&
          (outcome == null ||
            (outcome === 'errors' ? row.outcome !== 'success' : row.outcome === outcome)),
      )
      .map((record) => ({
        event: { type: 'call' as const, record },
        at: record.startedAt,
        source: 2,
        id: record.id,
      }))
    const all = [...calls, ...retrievals, ...writes].sort(byNewest)
    const rank = before?.source === 'call' ? 2 : before?.source === 'retrieval' ? 1 : 0
    const matched = before
      ? all.filter(
          (row) =>
            row.at < before.at ||
            (row.at === before.at &&
              (row.source < rank ||
                (row.source === rank &&
                  (row.source === 2 ? row.id < before.id : BigInt(row.id) < BigInt(before.id))))),
        )
      : all
    const page = matched.slice(0, limit + 1)
    return {
      items: page.slice(0, limit).map((row) => row.event),
      total: scope.kind === 'session' && withTotal !== false ? all.length : null,
      hasMore: page.length > limit,
    }
  }

  async agentFacet(owner: string) {
    const counts = new Map<string, number>()

    const add = (agent: string | null) => {
      if (agent) {
        counts.set(agent, (counts.get(agent) ?? 0) + 1)
      }
    }

    // The same marker rules the drivers apply here (`agentFacet`'s CTEs): a session the
    // human deleted stops contributing its reads and writes, and a call stops on ANY
    // marker. Retention expiry keeps contributing — it retires the lifecycle row, not
    // the record of what the agent did. Without this the counts run ahead of the
    // drivers by exactly the rows of a session whose cleanup is still pending.
    for (const retrieval of this.retrievals.snapshot()) {
      if (
        retrieval.owner === owner &&
        retrieval.agentCallId == null &&
        !(retrieval.sessionId && this.calls.isHumanDeleted(owner, retrieval.sessionId))
      ) {
        add(retrieval.agent)
      }
    }
    for (const write of this.writes) {
      if (
        write.owner === owner &&
        write.agentCallId == null &&
        !(write.sessionId && this.calls.isHumanDeleted(owner, write.sessionId)) &&
        !this.quarantined.has(write.revisionId)
      ) {
        add(write.agent)
      }
    }
    for (const call of this.calls.snapshot()) {
      if (
        call.owner === owner &&
        call.outcome &&
        !(call.sessionId && this.calls.isHidden(owner, call.sessionId))
      ) {
        add(call.agent)
      }
    }

    return [...counts.entries()]
      .map(([agent, count]) => ({ agent, count }))
      .sort((left, right) => right.count - left.count || left.agent.localeCompare(right.agent))
  }
}
