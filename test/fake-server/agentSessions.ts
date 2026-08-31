import { parseAbilityLocator, serializeAbilityLocator } from '@notarium/core'
import type {
  AgentSessionNamedStart,
  AgentSessionRecord,
  AgentSessionRoleSelection,
  AgentSessionsPersistence,
} from '@notarium/server'

const clone = (record: AgentSessionRecord): AgentSessionRecord => ({ ...record })

type AgentSessionLifecycleView = {
  replaceSessions(sessions: readonly string[]): void
  upsertSession(session: string): void
  deleteSessions(sessions: ReadonlySet<string>): void
}

/** In-memory executable twin of the durable agent-sessions facet. */
export class InMemoryAgentSessions implements AgentSessionsPersistence {
  private readonly records = new Map<string, AgentSessionRecord>()
  private lifecycleView?: AgentSessionLifecycleView

  attachLifecycle(view: AgentSessionLifecycleView): void {
    this.lifecycleView = view
    view.replaceSessions([...this.records.keys()])
  }

  clear(): void {
    this.records.clear()
    this.lifecycleView?.replaceSessions([])
  }

  /** Test read-model seam: immutable lifecycle snapshot for the session-audit twin. */
  snapshot(): AgentSessionRecord[] {
    return [...this.records.values()].map(clone)
  }

  delete(owner: string, id: string): void {
    const record = this.records.get(id)

    if (!record || record.owner !== owner) {
      return
    }
    this.records.delete(id)
    this.lifecycleView?.deleteSessions(new Set([id]))
    for (const child of this.records.values()) {
      if (child.parentId === id) {
        child.parentId = null
      }
    }
  }

  seed(records: readonly AgentSessionRecord[]): void {
    this.clear()
    const pending = new Map(records.map((record) => [record.id, record]))

    if (pending.size !== records.length) {
      throw new Error('duplicate agent session id in seed')
    }

    while (pending.size > 0) {
      let inserted = false

      for (const [id, record] of pending) {
        if (!record.parentId || this.records.has(record.parentId)) {
          this.insertChecked(record)
          pending.delete(id)
          inserted = true
        }
      }

      if (!inserted) {
        const record = pending.values().next().value as AgentSessionRecord
        throw new Error(`no such parent agent session: ${record.parentId}`)
      }
    }
  }

  async insert(session: AgentSessionRecord): Promise<void> {
    this.insertChecked(session)
  }

  async getRetained(
    owner: string,
    id: string,
    retainedSince: string,
  ): Promise<AgentSessionRecord | null> {
    const record = this.records.get(id)
    return record && record.owner === owner && record.lastSeenAt >= retainedSince
      ? clone(record)
      : null
  }

  async listNamed(
    owner: string,
    name: string,
    retainedSince: string,
    limit: number,
  ): Promise<AgentSessionRecord[]> {
    return this.list(owner, retainedSince, limit, name)
  }

  private insertChecked(session: AgentSessionRecord): void {
    if (this.records.has(session.id)) {
      throw new Error(`duplicate agent session id: ${session.id}`)
    }
    if (
      session.parentId &&
      ![...this.records.values()].some(
        (candidate) => candidate.id === session.parentId && candidate.owner === session.owner,
      )
    ) {
      throw new Error(`no such parent agent session: ${session.parentId}`)
    }
    this.records.set(session.id, clone(session))
    this.lifecycleView?.upsertSession(session.id)
  }

  async touch(
    owner: string,
    id: string,
    lastSeenAt: string,
    retainedSince: string,
    projectId?: string,
  ): Promise<AgentSessionRecord | null> {
    const record = this.records.get(id)

    if (!record || record.owner !== owner || record.lastSeenAt < retainedSince) {
      return null
    }
    record.lastSeenAt = record.lastSeenAt > lastSeenAt ? record.lastSeenAt : lastSeenAt
    record.calls += 1
    if (projectId !== undefined) {
      record.projectId = projectId
    }

    return clone(record)
  }

  async startNamed(
    candidate: AgentSessionRecord,
    activeSince: string,
    retainedSince: string,
    limit: number,
    projectId?: string,
  ): Promise<AgentSessionNamedStart> {
    const matches = this.list(candidate.owner, retainedSince, limit + 1, candidate.name)

    if (matches.length > 1) {
      return { kind: 'ambiguous', matches: matches.slice(0, limit) }
    }

    const match = matches[0]

    if (!match) {
      const created = { ...candidate, projectId: projectId ?? candidate.projectId }
      this.insertChecked(created)
      return { kind: 'new', record: clone(created) }
    }

    if (match.lastSeenAt >= activeSince) {
      const fork = {
        ...candidate,
        parentId: match.id,
        role: match.role,
        roleLocator: match.roleLocator,
        roleContextProjectId: match.roleContextProjectId,
        projectId: projectId ?? match.projectId,
      }
      this.insertChecked(fork)
      return { kind: 'forked', record: clone(fork) }
    }

    const stored = this.records.get(match.id)!
    stored.lastSeenAt =
      stored.lastSeenAt > candidate.lastSeenAt ? stored.lastSeenAt : candidate.lastSeenAt
    stored.calls += 1
    if (projectId !== undefined) {
      stored.projectId = projectId
    }

    return { kind: 'resumed', record: clone(stored) }
  }

  async listRecent(owner: string, since: string, limit: number): Promise<AgentSessionRecord[]> {
    return this.list(owner, since, limit)
  }

  async setRole(owner: string, id: string, role: AgentSessionRoleSelection) {
    const record = this.records.get(id)

    if (!record || record.owner !== owner) {
      return null
    }
    const changed =
      record.role !== role.name ||
      JSON.stringify(record.roleLocator) !== JSON.stringify(role.locator) ||
      record.roleContextProjectId !== role.contextProjectId
    record.role = role.name
    record.roleLocator = role.locator
    record.roleContextProjectId = role.contextProjectId
    return { record: clone(record), changed }
  }

  /** Follow a role package that changed placement. Exact resume is fail-closed, so an
   *  episode left on the old locator silently drops back to base mode instead of
   *  following its role — mirrors the drivers' UPDATE over `role_locator`. */
  moveRoleLocator(fromLocator: string, toLocator: string): void {
    const moved = parseAbilityLocator(toLocator)

    if (!moved || moved.source !== 'owned') {
      throw new Error(`not an owned ability locator: ${toLocator}`)
    }
    for (const record of this.records.values()) {
      if (record.roleLocator && serializeAbilityLocator(record.roleLocator) === fromLocator) {
        record.roleLocator = moved
      }
    }
  }

  async prune(before: string): Promise<string[]> {
    const removed = new Set<string>()
    const owners = new Set<string>()

    for (const [id, record] of this.records) {
      if (record.lastSeenAt < before) {
        this.records.delete(id)
        removed.add(id)
        owners.add(record.owner)
      }
    }
    // Mirrors ON DELETE SET NULL on the durable self-reference.
    for (const record of this.records.values()) {
      if (record.parentId && removed.has(record.parentId)) {
        record.parentId = null
      }
    }
    this.lifecycleView?.deleteSessions(removed)
    return [...owners].sort()
  }

  private list(owner: string, since: string, limit: number, name?: string): AgentSessionRecord[] {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.owner === owner &&
          record.lastSeenAt >= since &&
          (name == null || record.name === name),
      )
      .sort(
        (left, right) =>
          right.lastSeenAt.localeCompare(left.lastSeenAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone)
  }
}
