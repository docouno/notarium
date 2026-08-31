import type {
  AgentCallAdmission,
  AgentCallFinal,
  AgentCallRecord,
  AgentCallTracePersistence,
  AgentSessionAuditWriteEvent,
  AgentTelemetryConfig,
  AgentTraceJson,
} from '@notarium/server'

import type { InMemoryAgentSessions } from './agentSessions'
import type { InMemoryRetrievalLog } from './retrievalLog'

const clone = (record: AgentCallRecord): AgentCallRecord => structuredClone(record)

export class InMemoryAgentCalls implements AgentCallTracePersistence {
  private readonly rows = new Map<string, AgentCallRecord>()
  private readonly details = new Map<string, { payload: AgentTraceJson; expiresAt: string }>()
  private readonly markers = new Map<string, 'retention' | 'human-delete'>()
  private readonly pendingMarkers = new Set<string>()
  private revisionLinks: (owner: string, id: string) => AgentSessionAuditWriteEvent[] = () => []
  private telemetry: AgentTelemetryConfig = {
    detailedEnabled: false,
    compactRetentionDays: 90,
    detailedRetentionDays: 30,
    versionToken: 'v1',
    updatedAt: '1970-01-01T00:00:00.000Z',
  }

  constructor(
    private readonly sessions: InMemoryAgentSessions,
    private readonly retrievals: InMemoryRetrievalLog,
  ) {
    retrievals.attachCleanupFence((owner, sessionId, linked) => {
      const reason = this.markers.get(`${owner}\0${sessionId}`)
      return reason === 'human-delete' || (reason === 'retention' && linked)
    })
  }

  attachRevisionLinks(read: (owner: string, id: string) => AgentSessionAuditWriteEvent[]): void {
    this.revisionLinks = read
  }

  clear(): void {
    this.rows.clear()
    this.details.clear()
    this.markers.clear()
    this.pendingMarkers.clear()
    this.telemetry = {
      detailedEnabled: false,
      compactRetentionDays: 90,
      detailedRetentionDays: 30,
      versionToken: 'v1',
      updatedAt: '1970-01-01T00:00:00.000Z',
    }
  }

  snapshot(): AgentCallRecord[] {
    return [...this.rows.values()].map(clone)
  }

  seed(
    records: readonly AgentCallRecord[],
    details: readonly { id: string; payload: AgentTraceJson }[] = [],
    detailedEnabled = false,
  ): void {
    this.clear()
    for (const record of records) {
      this.rows.set(record.id, clone(record))
    }
    for (const detail of details) {
      this.details.set(detail.id, {
        payload: structuredClone(detail.payload),
        expiresAt: '9999-12-31T23:59:59.999Z',
      })
    }
    this.telemetry = { ...this.telemetry, detailedEnabled }
  }

  isHumanDeleted(owner: string, sessionId: string): boolean {
    return this.markers.get(`${owner}\0${sessionId}`) === 'human-delete'
  }

  isHidden(owner: string, sessionId: string): boolean {
    return this.isBlocked(owner, sessionId)
  }

  private isBlocked(owner: string, sessionId: string): boolean {
    return this.markers.has(`${owner}\0${sessionId}`)
  }

  private cleanupSession(
    owner: string,
    sessionId: string,
    reason: 'retention' | 'human-delete',
    batchSize: number,
  ): { complete: boolean; processed: number } {
    const linkedOnly = reason === 'retention'
    const retrievalsComplete = this.retrievals.deleteSessionBatch(
      owner,
      sessionId,
      linkedOnly,
      batchSize,
    )
    let removed = 0

    for (const [id, row] of this.rows) {
      if (row.owner === owner && row.sessionId === sessionId && removed < batchSize) {
        this.rows.delete(id)
        this.details.delete(id)
        removed += 1
      }
    }

    return {
      complete:
        retrievalsComplete.complete &&
        ![...this.rows.values()].some((row) => row.owner === owner && row.sessionId === sessionId),
      processed: retrievalsComplete.removed + removed,
    }
  }

  async admit(input: AgentCallAdmission): Promise<void> {
    this.rows.set(input.id, {
      ...input,
      sessionId: null,
      sessionName: null,
      sessionAttach: null,
      finishedAt: null,
      durationMs: null,
      outcome: null,
      reasonCode: null,
      outputBytes: null,
      issueSummary: null,
      resultSummary: null,
      detailCaptureFailed: false,
    })
  }

  async projectInput(
    owner: string,
    id: string,
    target: AgentTraceJson,
    redacted: boolean,
    truncated: boolean,
  ) {
    const row = this.rows.get(id)

    if (!row || row.owner !== owner) {
      return false
    }
    row.targetSummary = structuredClone(target)
    row.redacted = redacted
    row.truncated = truncated
    return true
  }

  async bind(
    owner: string,
    id: string,
    session: { id: string; name: string; attach: AgentCallRecord['sessionAttach'] },
  ) {
    const row = this.rows.get(id)

    if (!row || row.owner !== owner || this.isBlocked(owner, session.id)) {
      return false
    }
    row.sessionId = session.id
    row.sessionName = session.name
    row.sessionAttach = session.attach
    return true
  }

  async discard(owner: string, id: string): Promise<void> {
    if (this.rows.get(id)?.owner === owner) {
      this.rows.delete(id)
    }
  }

  async finalize(owner: string, id: string, final: AgentCallFinal) {
    const row = this.rows.get(id)

    if (!row || row.owner !== owner || (row.sessionId && this.isBlocked(owner, row.sessionId))) {
      return false
    }
    Object.assign(row, structuredClone(final))
    return true
  }

  async appendDetail(input: {
    owner: string
    id: string
    payload: AgentTraceJson
    createdAt: string
    expiresAt: string
  }) {
    const row = this.rows.get(input.id)

    if (!row || row.owner !== input.owner) {
      return false
    }
    this.details.set(input.id, {
      payload: structuredClone(input.payload),
      expiresAt: input.expiresAt,
    })
    return true
  }

  async get(owner: string, id: string) {
    const row = this.rows.get(id)
    return row?.owner === owner && (!row.sessionId || !this.isBlocked(owner, row.sessionId))
      ? clone(row)
      : null
  }

  async getDetail(owner: string, id: string, now: string) {
    const row = this.rows.get(id)
    const detail = this.details.get(id)
    return row?.owner === owner &&
      (!row.sessionId || !this.isBlocked(owner, row.sessionId)) &&
      detail &&
      detail.expiresAt >= now
      ? structuredClone(detail.payload)
      : null
  }

  async links(owner: string, id: string) {
    const row = this.rows.get(id)

    if (!row || row.owner !== owner || (row.sessionId && this.isBlocked(owner, row.sessionId))) {
      return { retrievals: [], revisions: [] }
    }

    return {
      retrievals: this.retrievals
        .snapshot()
        .filter((retrieval) => retrieval.owner === owner && retrieval.agentCallId === id),
      revisions: this.revisionLinks(owner, id),
    }
  }

  async exportDetails(owner: string, ids: readonly string[], now: string) {
    const result: Awaited<ReturnType<AgentCallTracePersistence['exportDetails']>> = {}

    for (const id of ids) {
      const row = this.rows.get(id)

      if (!row || row.owner !== owner || (row.sessionId && this.isBlocked(owner, row.sessionId))) {
        continue
      }
      const detail = this.details.get(id)
      const links = await this.links(owner, id)
      result[id] = {
        detailed: detail && detail.expiresAt >= now ? structuredClone(detail.payload) : null,
        retrievals: links.retrievals,
        revisions: links.revisions,
      }
    }

    return result
  }

  async recurringProblems(owner: string, since: string, limit: number) {
    const grouped = new Map<
      string,
      {
        fingerprint: string
        tool: string
        issues: AgentTraceJson | null
        count: number
        firstAt: string
        lastAt: string
        agents: Set<string>
      }
    >()

    for (const row of this.rows.values()) {
      if (
        row.owner !== owner ||
        row.outcome !== 'invalid_arguments' ||
        row.startedAt < since ||
        (row.sessionId && this.isBlocked(owner, row.sessionId))
      ) {
        continue
      }
      const current = grouped.get(row.fingerprint) ?? {
        fingerprint: row.fingerprint,
        tool: row.tool,
        issues: row.issueSummary,
        count: 0,
        firstAt: row.startedAt,
        lastAt: row.startedAt,
        agents: new Set<string>(),
      }
      current.count += 1
      current.firstAt = current.firstAt < row.startedAt ? current.firstAt : row.startedAt
      current.lastAt = current.lastAt > row.startedAt ? current.lastAt : row.startedAt
      current.agents.add(row.agent ?? row.principal)
      grouped.set(row.fingerprint, current)
    }

    return [...grouped.values()]
      .map(({ agents, ...row }) => ({ ...row, agents: agents.size }))
      .sort((left, right) => right.count - left.count || right.lastAt.localeCompare(left.lastAt))
      .slice(0, limit)
  }

  async recoverInterrupted(before: string, finishedAt: string) {
    let count = 0

    for (const row of this.rows.values()) {
      if (
        !row.outcome &&
        row.startedAt < before &&
        (!row.sessionId || !this.isBlocked(row.owner, row.sessionId))
      ) {
        row.outcome = 'internal_error'
        row.reasonCode = 'interrupted'
        row.finishedAt = finishedAt
        row.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(row.startedAt))
        count += 1
      }
    }

    return count
  }

  async config() {
    return { ...this.telemetry }
  }

  async patchConfig(input: Parameters<AgentCallTracePersistence['patchConfig']>[0]) {
    if (input.expectedVersionToken !== this.telemetry.versionToken) {
      return null
    }
    const next = {
      ...this.telemetry,
      ...(input.detailedEnabled !== undefined ? { detailedEnabled: input.detailedEnabled } : {}),
      ...(input.compactRetentionDays !== undefined
        ? { compactRetentionDays: input.compactRetentionDays }
        : {}),
      ...(input.detailedRetentionDays !== undefined
        ? { detailedRetentionDays: input.detailedRetentionDays }
        : {}),
      versionToken: `v${Number(this.telemetry.versionToken.slice(1)) + 1}`,
      updatedAt: input.updatedAt,
    }

    if (next.detailedRetentionDays > next.compactRetentionDays) {
      return null
    }
    this.telemetry = next
    return { ...next }
  }

  async deleteSession(input: Parameters<AgentCallTracePersistence['deleteSession']>[0]) {
    const session = this.sessions
      .snapshot()
      .find((row) => row.owner === input.owner && row.id === input.sessionId)

    if (session && session.lastSeenAt >= input.activeSince && !input.confirmActive) {
      return 'active'
    }
    this.markers.set(`${input.owner}\0${input.sessionId}`, 'human-delete')
    this.pendingMarkers.add(`${input.owner}\0${input.sessionId}`)
    this.sessions.delete(input.owner, input.sessionId)
    const cleanup = this.cleanupSession(
      input.owner,
      input.sessionId,
      'human-delete',
      input.batchSize,
    )

    if (cleanup.complete) {
      this.pendingMarkers.delete(`${input.owner}\0${input.sessionId}`)
    }

    return cleanup.complete ? 'complete' : 'deleting'
  }

  async expireSession(input: Parameters<AgentCallTracePersistence['expireSession']>[0]) {
    const key = `${input.owner}\0${input.sessionId}`
    const marker = this.markers.get(key)

    if (marker === 'human-delete') {
      return 'dominated'
    }
    if (!marker) {
      const calls = this.snapshot().filter(
        (row) => row.owner === input.owner && row.sessionId === input.sessionId && row.outcome,
      )
      const complete = calls.some(
        (row) =>
          row.tool === 'start_session' &&
          row.outcome === 'success' &&
          ['new', 'forked'].includes(
            String(
              row.resultSummary && typeof row.resultSummary === 'object'
                ? (row.resultSummary as Record<string, AgentTraceJson>)['session.state']
                : '',
            ),
          ),
      )
      const last = calls
        .map((row) => row.finishedAt ?? row.startedAt)
        .sort()
        .at(-1)

      if (!complete || !last || last >= input.expiredBefore) {
        return 'fresh'
      }
      this.markers.set(key, 'retention')
      this.pendingMarkers.add(key)
      this.sessions.delete(input.owner, input.sessionId)
    }

    const cleanup = this.cleanupSession(input.owner, input.sessionId, 'retention', input.batchSize)

    if (cleanup.complete) {
      this.pendingMarkers.delete(key)
    }

    return cleanup.complete ? 'complete' : 'deleting'
  }

  async maintain(input: Parameters<AgentCallTracePersistence['maintain']>[0]) {
    const compactBefore = new Date(
      Date.parse(input.now) - this.telemetry.compactRetentionDays * 86_400_000,
    ).toISOString()
    const candidates = new Set(
      this.snapshot()
        .filter((row) => row.sessionId && (row.finishedAt ?? row.startedAt) < compactBefore)
        .map((row) => `${row.owner}\0${row.sessionId}`),
    )
    const owners = new Set<string>()

    for (const candidate of candidates) {
      const [owner, sessionId] = candidate.split('\0') as [string, string]
      const result = await this.expireSession({
        owner,
        sessionId,
        expiredBefore: compactBefore,
        acceptedAt: input.now,
        batchSize: input.batchSize,
      })

      if (result === 'complete') {
        owners.add(owner)
      }
    }

    return [...owners]
  }

  async resumeCleanup(batchSize: number) {
    const key = this.pendingMarkers.values().next().value as string | undefined

    if (!key) {
      return { completedOwners: [], processed: 0, pending: false }
    }
    const [owner, sessionId] = key.split('\0') as [string, string]
    const cleanup = this.cleanupSession(owner, sessionId, this.markers.get(key)!, batchSize)

    if (cleanup.complete) {
      this.pendingMarkers.delete(key)
    }

    return {
      completedOwners: cleanup.complete ? [owner] : [],
      processed: cleanup.processed,
      pending: this.pendingMarkers.size > 0,
    }
  }
}
