import type { Revision } from '@notarium/core'
import {
  type AgentSessionAuditEvent,
  type AgentSessionAuditPersistence,
  type AgentSessionAuditSummary,
  auditWriteGapOf,
} from '@notarium/server'

import type { InMemoryAgentSessions } from './agentSessions'
import type { InMemoryRetrievalLog } from './retrievalLog'

type AuditWrite = Extract<AgentSessionAuditEvent, { type: 'write' }> & {
  owner: string
  sessionId: string | null
  sessionName: string | null
  /** The journal row this tap mirrors, so a later quarantine of that row reaches
   *  the audit too — the SQL drivers read one row and see `integrity` directly. */
  revisionId: string
}

type AuditGroup = {
  id: string
  name: string
  firstAt: string
  lastAt: string
  reads: number
  writes: number
}

const byNewest = (left: { at: string; source: number; id: string }, right: typeof left): number =>
  right.at.localeCompare(left.at) ||
  right.source - left.source ||
  Number(right.id) - Number(left.id)

/** Executable in-memory twin used by the full fake-server vertical. SQL parity is
 * pinned separately by the shared SQLite/PostgreSQL persistence contract. */
export class InMemorySessionAudit implements AgentSessionAuditPersistence {
  private writes: AuditWrite[] = []
  private quarantined = new Set<string>()
  private nextWriteId = 0

  constructor(
    private readonly sessions: InMemoryAgentSessions,
    private readonly retrievals: InMemoryRetrievalLog,
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

  private auditGroups(owner: string): Map<string, AuditGroup> {
    const groups = new Map<string, AuditGroup>()

    const add = (id: string, name: string | null, at: string, type: 'read' | 'write') => {
      const current = groups.get(id)

      if (!current) {
        groups.set(id, {
          id,
          name: name ?? 'Archived session',
          firstAt: at,
          lastAt: at,
          reads: type === 'read' ? 1 : 0,
          writes: type === 'write' ? 1 : 0,
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
    }

    for (const retrieval of this.retrievals.snapshot()) {
      if (retrieval.owner === owner && retrieval.sessionId) {
        add(retrieval.sessionId, retrieval.sessionName, retrieval.createdAt, 'read')
      }
    }
    for (const write of this.writes) {
      if (write.owner === owner && write.sessionId) {
        add(write.sessionId, write.sessionName, write.at, 'write')
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
        calls: session.calls,
        reads: group?.reads ?? 0,
        writes: group?.writes ?? 0,
        retained: true,
        active: session.lastSeenAt >= activeSince,
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
        calls: null,
        reads: group.reads,
        writes: group.writes,
        retained: false,
        active: false,
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
      .filter((row) => row.owner === owner && row.sessionId == null)
    const writes = this.writes.filter((row) => row.owner === owner && row.sessionId == null)
    const lastSeenAt = [...reads.map((row) => row.createdAt), ...writes.map((row) => row.at)]
      .sort()
      .at(-1)
    return lastSeenAt ? { reads: reads.length, writes: writes.length, lastSeenAt } : null
  }

  async overview({
    owner,
    activeSince,
    limit,
    before,
  }: Parameters<AgentSessionAuditPersistence['overview']>[0]) {
    const all = this.summaries(owner, activeSince)
    const matched = before
      ? all.filter(
          (item) =>
            item.lastSeenAt < before.at || (item.lastSeenAt === before.at && item.id < before.id),
        )
      : all
    const page = matched.slice(0, limit + 1)
    return {
      items: page.slice(0, limit),
      total: all.length,
      active: all.filter((item) => item.active).length,
      outside: this.outside(owner),
      hasMore: page.length > limit,
    }
  }

  async find(owner: string, sessionId: string, activeSince: string) {
    return this.summaries(owner, activeSince).find((item) => item.id === sessionId) ?? null
  }

  async events({
    owner,
    sessionId,
    type,
    limit,
    before,
  }: Parameters<AgentSessionAuditPersistence['events']>[0]) {
    const retrievals = this.retrievals
      .snapshot()
      .filter(
        (row) =>
          row.owner === owner &&
          row.sessionId === sessionId &&
          (type == null || type === 'retrieval'),
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
          row.owner === owner && row.sessionId === sessionId && (type == null || type === 'write'),
      )
      .map((row) => {
        const event = {
          type: row.type,
          id: row.id,
          at: row.at,
          principal: row.principal,
          agent: row.agent,
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
    const all = [...retrievals, ...writes].sort(byNewest)
    const rank = before?.source === 'retrieval' ? 1 : 0
    const matched = before
      ? all.filter(
          (row) =>
            row.at < before.at ||
            (row.at === before.at &&
              (row.source < rank || (row.source === rank && Number(row.id) < Number(before.id)))),
        )
      : all
    const page = matched.slice(0, limit + 1)
    return {
      items: page.slice(0, limit).map((row) => row.event),
      total: all.length,
      hasMore: page.length > limit,
    }
  }
}
