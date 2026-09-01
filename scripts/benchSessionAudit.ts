import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import pg from 'pg'

import { createMutationGate } from '../packages/server/src/libs/mutationGate'
import { createAgentCalls } from '../packages/server/src/services/agentCalls'
import { createAgentCallsFacet as createPgAgentCallsFacet } from '../packages/server/src/services/metaDb/drivers/pg/agentCalls'
import { createRetrievalLogFacet as createPgRetrievalLogFacet } from '../packages/server/src/services/metaDb/drivers/pg/retrievalLog'
import { createSessionAuditFacet as createPgSessionAuditFacet } from '../packages/server/src/services/metaDb/drivers/pg/sessionAudit'
import { createSessionsFacet as createPgSessionsFacet } from '../packages/server/src/services/metaDb/drivers/pg/sessions'
import { createAgentCallsFacet as createSqliteAgentCallsFacet } from '../packages/server/src/services/metaDb/drivers/sqlite/agentCalls'
import { createRetrievalLogFacet as createSqliteRetrievalLogFacet } from '../packages/server/src/services/metaDb/drivers/sqlite/retrievalLog'
import { createSessionAuditFacet as createSqliteSessionAuditFacet } from '../packages/server/src/services/metaDb/drivers/sqlite/sessionAudit'
import { createSessionsFacet as createSqliteSessionsFacet } from '../packages/server/src/services/metaDb/drivers/sqlite/sessions'
import {
  runPgMigrations,
  runSqliteMigrations,
} from '../packages/server/src/services/metaDb/migrations'
import type {
  AgentCallTracePersistence,
  AgentSessionAuditEventCursor,
  AgentSessionAuditPersistence,
  AgentSessionsPersistence,
  RetrievalLogPersistence,
} from '../packages/server/src/services/metaDb/types'
import {
  benchmarkGateFailures,
  type BenchmarkGateProbe,
  type BenchmarkGateReport,
} from './benchSessionAuditGates'

const OWNER = 'bench-owner'
const TARGET_SESSION = 'ses_target_bench'
const LIMIT = 50
const WARMUPS = 5
const MEASURED = 20
const STORAGE_ROWS = 25
const BASE_TIME = Date.parse('2025-01-01T00:00:00.000Z')

type Scope = { kind: 'all' } | { kind: 'outside' } | { kind: 'session'; id: string }
type Filter = 'all' | 'reads' | 'writes'
type Page = 'first' | 'next'
type DriverName = 'sqlite' | 'postgres'

type SqlTrace = {
  sql: string
  params: unknown[]
}

type Plan = SqlTrace & {
  output: unknown
}

type CellResult = {
  driver: DriverName
  dataset: number
  scope: Scope['kind']
  filter: Filter
  page: Page
  mode: 'production' | 'diagnostic-reference'
  warmups: number
  measured: number
  rawMs: number[]
  medianMs: number
  plans: Plan[]
}

type AggregatePair = {
  driver: DriverName
  dataset: number
  disabledRawMs: number[]
  disabledMedianMs: number
  enabledRawMs: number[]
  enabledMedianMs: number
  ratio: number
  components: {
    timelineMedianMs: number
    retrievalsMedianMs: number
    agentsMedianMs: number
    problemsMedianMs: number
  }
}

type ScaleProbe = {
  driver: DriverName
  dataset: number
  kind: BenchmarkGateProbe['kind']
  warmups: number
  measured: number
  rawMs: number[]
  medianMs: number
  plans: Plan[]
}

type TraceProbe = {
  driver: DriverName
  dataset: number
  kind: 'compact-write' | 'detailed-write' | 'maintenance' | 'dense-export'
  rows: number
  rawMs: number[]
  medianMs: number
  components?: {
    pages?: number
    eventsMs?: number
    detailsMs?: number
    passes?: number
    maxPassMs?: number
    p99PassMs?: number
    processed?: number
    remaining?: number
    yields?: number
  }
}

type StorageProbe = {
  driver: DriverName
  dataset: number
  mode: 'compact' | 'detailed'
  method: 'sqlite-json-payload-v1' | 'postgres-row-size-v1'
  rows: number
  bytes: number
  bytesPerRow: number
}

type Report = {
  phase: string
  startedAt: string
  finishedAt?: string
  gitCommit: string | null
  gitTree: string | null
  node: string
  images: { node: string | null; postgres: string | null }
  policy: {
    sizes: number[]
    limit: number
    warmups: number
    measured: number
    sqliteAnalyze: false
    postgresAnalyze: true
  }
  versions: Partial<Record<DriverName, string>>
  cells: CellResult[]
  aggregatePairs: AggregatePair[]
  probes: ScaleProbe[]
  traceProbes: TraceProbe[]
  storageProbes: StorageProbe[]
  gate?: {
    baseline: string
    baselineCommit: string | null
    baselineTree: string | null
    failures: string[]
    passed: boolean
  }
}

type ReferenceRow = {
  source: 'retrieval' | 'write'
  sourceRank: number
  id: string
  at: string
}

type ReferenceQuery = {
  sql: string
  params: unknown[]
}

type Driver = {
  name: DriverName
  audit: AgentSessionAuditPersistence
  retrievals: RetrievalLogPersistence
  calls: AgentCallTracePersistence
  sessions: AgentSessionsPersistence
  seed(size: number): Promise<void>
  supportsAll(): Promise<boolean>
  reference(filter: Filter, before?: AgentSessionAuditEventCursor): Promise<ReferenceRow[]>
  referencePlan(filter: Filter, before?: AgentSessionAuditEventCursor): Promise<Plan[]>
  productionPlan(
    scope: Scope,
    filter: Filter,
    before?: AgentSessionAuditEventCursor,
    agent?: string,
  ): Promise<Plan[]>
  detailPlan(): Promise<Plan[]>
  prepareRetrievalOrder(): Promise<void>
  prepareOutsideOrder(): Promise<void>
  agents(): Promise<unknown>
  setTraceDetailed(enabled: boolean): Promise<void>
  traceWrite(): Promise<string>
  storageBytes(ids: readonly string[]): Promise<number>
  prepareDenseTrace(): Promise<number>
  exportDenseTrace(): Promise<{ rows: number; pages: number; eventsMs: number; detailsMs: number }>
  maintainTrace(): Promise<{
    passes: number
    maxPassMs: number
    p99PassMs: number
    processed: number
    remaining: number
    yields: number
  }>
  version(): Promise<string>
  close(): Promise<void>
}

const sizeList = (): number[] => {
  const raw = process.env.BENCH_SIZES ?? '10000,100000,500000'
  const sizes = raw.split(',').map((value) => Number(value.trim()))

  if (
    sizes.length === 0 ||
    sizes.some((size) => !Number.isSafeInteger(size) || size < 400 || size % 4 !== 0)
  ) {
    throw new Error('BENCH_SIZES must contain comma-separated integers >= 400 divisible by 4')
  }

  return sizes
}

const median = (values: readonly number[]): number => {
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? 0)
}

const p99 = (values: readonly number[]): number => {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.99) - 1)] ?? 0
}

const measure = async (run: () => Promise<unknown>): Promise<{ raw: number[]; median: number }> => {
  for (let index = 0; index < WARMUPS; index += 1) {
    await run()
  }
  const raw: number[] = []

  for (let index = 0; index < MEASURED; index += 1) {
    const started = performance.now()
    await run()
    raw.push(performance.now() - started)
  }

  return { raw, median: median(raw) }
}

const measureComponent = async (run: () => Promise<unknown>): Promise<number> => {
  const raw: number[] = []

  for (let index = 0; index < 3; index += 1) {
    const started = performance.now()
    await run()
    raw.push(performance.now() - started)
  }

  return median(raw)
}

const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const filterType = (filter: Filter): 'retrieval' | 'write' | undefined =>
  filter === 'reads' ? 'retrieval' : filter === 'writes' ? 'write' : undefined

const compatibilitySessionId = (scope: Scope): string | null =>
  scope.kind === 'session'
    ? scope.id
    : scope.kind === 'outside'
      ? null
      : '__unsupported_all_scope__'

const events = (
  audit: AgentSessionAuditPersistence,
  scope: Scope,
  filter: Filter,
  before?: AgentSessionAuditEventCursor,
  agent?: string,
) => {
  const call = audit.events as (query: {
    owner: string
    scope: Scope
    sessionId: string | null
    type?: 'retrieval' | 'write'
    limit: number
    before?: AgentSessionAuditEventCursor
    agent?: string
  }) => ReturnType<AgentSessionAuditPersistence['events']>
  return call({
    owner: OWNER,
    scope,
    sessionId: compatibilitySessionId(scope),
    type: filterType(filter),
    limit: LIMIT,
    before,
    agent,
  })
}

const cursorOfEvent = (
  event: Awaited<ReturnType<AgentSessionAuditPersistence['events']>>['items'][number],
): AgentSessionAuditEventCursor =>
  event.type === 'call'
    ? { at: event.record.startedAt, source: 'call', id: event.record.id }
    : event.type === 'retrieval'
      ? { at: event.record.createdAt, source: 'retrieval', id: event.record.id }
      : { at: event.at, source: 'write', id: event.id }

const cursorOfReference = (row: ReferenceRow): AgentSessionAuditEventCursor => ({
  at: row.at,
  source: row.source,
  id: row.id,
})

const safeParams = (params: readonly unknown[]): unknown[] =>
  params.map((value) => (typeof value === 'bigint' ? value.toString() : value))

const timestamp = (index: number): string => new Date(BASE_TIME + index * 1000).toISOString()

const traceSessionRecord = {
  id: 'ses_trace_write',
  owner: OWNER,
  name: 'Trace write benchmark',
  named: true,
  parentId: null,
  createdAt: timestamp(1),
  lastSeenAt: timestamp(1),
  calls: 1,
  role: null,
  roleLocator: null,
  roleContextProjectId: null,
  projectId: null,
}

const productionTraceWriter = (
  calls: AgentCallTracePersistence,
  retrievals: RetrievalLogPersistence,
  next: () => { id: string; at: string },
) => {
  const gate = createMutationGate()
  let current = { id: '', at: timestamp(1) }
  const service = createAgentCalls({
    persistence: calls,
    mintId: () => current.id,
    now: () => new Date(current.at),
  })
  const principal = {
    id: `pat:${OWNER}:bench`,
    username: OWNER,
    admin: false,
    scope: 'write' as const,
    grants: new Map(),
    spaces: null,
    system: false,
    label: 'Bench agent',
  }

  return async (): Promise<string> => {
    current = next()
    const query = `trace-write-${current.id}`

    await gate.run(async () => {
      const span = await service.begin(principal, 'search', { query }, current.id)
      await service.projectInput(span, { query })
      await service.bind(span, { record: traceSessionRecord, attach: 'declared' })
      await retrievals.append({
        owner: OWNER,
        principal: principal.id,
        agent: principal.label,
        sessionId: traceSessionRecord.id,
        sessionName: traceSessionRecord.name,
        sessionAttach: 'declared',
        agentCallId: span?.id ?? null,
        tool: 'search',
        query,
        project: null,
        classFilter: null,
        resultCount: 0,
        topScore: null,
        hits: [],
        createdAt: current.at,
      })
      await service.finish(span, {
        outcome: 'success',
        output: { hits: [], resultCount: 0 },
      })
    })
    return current.id
  }
}

const sessionOf = (index: number, sessionPerSource: number): string | null => {
  if (index <= 100) {
    return TARGET_SESSION
  }
  if (index > sessionPerSource) {
    return null
  }

  return `ses_other_${String((index - 101) % 100).padStart(3, '0')}`
}

const callIdOf = (index: number): string => `call_${index.toString(16).padStart(12, '0')}`

const sqliteReferenceQuery = (
  filter: Filter,
  before?: AgentSessionAuditEventCursor,
): ReferenceQuery => {
  const branches: string[] = []
  const params: unknown[] = []

  if (filter !== 'writes') {
    branches.push(
      `SELECT 'retrieval' AS source, 1 AS source_rank, id, created_at
         FROM agent_retrievals WHERE owner = ?`,
    )
    params.push(OWNER)
  }
  if (filter !== 'reads') {
    branches.push(
      `SELECT 'write' AS source, 0 AS source_rank, id, created_at
         FROM note_revisions WHERE agent_owner = ?`,
    )
    params.push(OWNER)
  }
  const cursor = before
    ? 'WHERE (created_at < ? OR (created_at = ? AND (source_rank < ? OR (source_rank = ? AND id < ?))))'
    : ''

  if (before) {
    const rank = before.source === 'retrieval' ? 1 : 0
    params.push(before.at, before.at, rank, rank, BigInt(before.id))
  }
  params.push(LIMIT + 1)
  return {
    sql: `WITH events AS (${branches.join(' UNION ALL ')})
          SELECT source, source_rank, id, created_at FROM events ${cursor}
          ORDER BY created_at DESC, source_rank DESC, id DESC LIMIT ?`,
    params,
  }
}

const pgReferenceQuery = (
  filter: Filter,
  before?: AgentSessionAuditEventCursor,
): ReferenceQuery => {
  const branches: string[] = []
  const params: unknown[] = []

  const bind = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }

  if (filter !== 'writes') {
    const owner = bind(OWNER)
    branches.push(
      `SELECT 'retrieval' AS source, 1 AS source_rank, id, created_at
         FROM agent_retrievals WHERE owner = ${owner}`,
    )
  }
  if (filter !== 'reads') {
    const owner = bind(OWNER)
    branches.push(
      `SELECT 'write' AS source, 0 AS source_rank, id, created_at
         FROM note_revisions WHERE agent_owner = ${owner}`,
    )
  }
  let cursor = ''

  if (before) {
    const at = bind(before.at)
    const rank = bind(before.source === 'retrieval' ? 1 : 0)
    const id = bind(before.id)
    cursor = `WHERE (created_at < ${at} OR (created_at = ${at} AND
      (source_rank < ${rank} OR (source_rank = ${rank} AND id < ${id}::bigint))))`
  }
  const limit = bind(LIMIT + 1)
  return {
    sql: `WITH events AS (${branches.join(' UNION ALL ')})
          SELECT source, source_rank, id, created_at FROM events ${cursor}
          ORDER BY created_at DESC, source_rank DESC, id DESC LIMIT ${limit}`,
    params,
  }
}

const sqlitePlan = (db: DatabaseSync, trace: SqlTrace): Plan => ({
  ...trace,
  params: safeParams(trace.params),
  output: db.prepare(`EXPLAIN QUERY PLAN ${trace.sql}`).all(...(trace.params as SQLInputValue[])),
})

const pgPlan = async (pool: pg.Pool, trace: SqlTrace): Promise<Plan> => {
  const result = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${trace.sql}`,
    trace.params,
  )
  return {
    ...trace,
    params: safeParams(trace.params),
    output: result.rows.map((row) => row['QUERY PLAN']),
  }
}

const recordingSqliteAudit = (
  db: DatabaseSync,
  traces: SqlTrace[],
): AgentSessionAuditPersistence => {
  const recording = new Proxy(db, {
    get: (target, property) => {
      if (property !== 'prepare') {
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }

      return (sql: string) => {
        const statement = target.prepare(sql)
        return new Proxy(statement, {
          get: (statementTarget, statementProperty) => {
            const value = Reflect.get(
              statementTarget,
              statementProperty,
              statementTarget,
            ) as unknown

            if (
              (statementProperty === 'all' || statementProperty === 'get') &&
              typeof value === 'function'
            ) {
              return (...params: unknown[]) => {
                traces.push({ sql, params })
                return value.apply(statementTarget, params)
              }
            }

            return typeof value === 'function' ? value.bind(statementTarget) : value
          },
        })
      }
    },
  })
  return createSqliteSessionAuditFacet({
    ensureInit: async () => {},
    checkpointWal: async () => {},
    close: async () => {},
    required: recording,
  })
}

const recordingPgAudit = (pool: pg.Pool, traces: SqlTrace[]): AgentSessionAuditPersistence => {
  const recording = {
    query: async (sql: string, params: unknown[] = []) => {
      traces.push({ sql, params })
      return pool.query(sql, params)
    },
  } as unknown as pg.Pool
  return createPgSessionAuditFacet({
    ensureInit: async () => {},
    close: async () => {},
    required: recording,
  })
}

const createSqliteDriver = (): Driver => {
  const root = join(tmpdir(), `notarium-session-audit-bench-${process.pid}`)
  const path = join(root, 'meta.db')
  mkdirSync(root, { recursive: true })
  const db = new DatabaseSync(path)
  runSqliteMigrations(db)
  const ctx = {
    ensureInit: async () => {},
    checkpointWal: async () => {},
    close: async () => {},
    required: db,
  }
  const audit = createSqliteSessionAuditFacet(ctx)
  const retrievals = createSqliteRetrievalLogFacet(ctx)
  const calls = createSqliteAgentCallsFacet(ctx)
  const sessions = createSqliteSessionsFacet(ctx)
  let traceCounter = 0
  const traceWrite = productionTraceWriter(calls, retrievals, () => {
    traceCounter += 1
    return {
      id: `call_perf_${String(traceCounter).padStart(8, '0')}`,
      at: new Date(BASE_TIME + 700_000_000 + traceCounter).toISOString(),
    }
  })

  return {
    name: 'sqlite',
    audit,
    retrievals,
    calls,
    sessions,
    seed: async (size) => {
      const half = size / 2
      const sessionPerSource = size / 4
      db.exec(`DELETE FROM agent_call_details; DELETE FROM agent_retrievals; DELETE FROM note_revisions;
        DELETE FROM agent_calls; DELETE FROM agent_session_cleanup_markers;
        DELETE FROM mcp_delta_session_cursors; DELETE FROM agent_sessions;
        DELETE FROM sqlite_sequence WHERE name IN ('agent_retrievals', 'note_revisions')`)
      const call = db.prepare(
        `INSERT INTO agent_calls
           (id, owner, principal, agent, transport, request_id, session_id, session_name,
            session_attach, tool, effect, domain, started_at, finished_at, duration_ms,
            outcome, reason_code, input_bytes, output_bytes, input_shape, issue_summary,
            target_summary, result_summary, fingerprint, projection_version, redacted,
            truncated, detail_capture_failed)
         VALUES (?, ?, ?, ?, 'mcp', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 64, 32,
                 '{}', ?, ?, '{}', ?, 1, 1, 0, 0)`,
      )
      const retrieval = db.prepare(
        `INSERT INTO agent_retrievals
           (owner, principal, agent, session_id, session_name, session_attach, agent_call_id, tool, query,
            project, class_filter, result_count, top_score, hits, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, '[]', ?)`,
      )
      const revision = db.prepare(
        `INSERT INTO note_revisions
           (note_id, space, kind, principal, content_hash, title, tags, created_at,
            chars_added, chars_removed, class, agent_owner, agent_name, session_id,
            session_name, session_attach, agent_call_id, entry_role, state_format, integrity)
         VALUES (?, 'bench-space', 'write', ?, NULL, ?, '[]', ?, 1, 0, 'user-doc', ?, ?, ?, ?, ?, ?,
                 'change', NULL, 'trusted')`,
      )
      db.exec('BEGIN IMMEDIATE')

      try {
        for (let index = 1; index <= size; index += 1) {
          const session = sessionOf(index, size / 2)
          const agent = index % 17 === 0 ? 'Deleted token' : `Bench agent ${index % 8}`
          const at = timestamp(index)
          const invalid = index % 11 === 0
          const effect = index % 3 === 0 ? 'read' : index % 3 === 1 ? 'mutation' : 'control'
          const tool =
            effect === 'read' ? 'search' : effect === 'mutation' ? 'create_note' : 'whoami'
          call.run(
            callIdOf(index),
            OWNER,
            `pat:${OWNER}:bench`,
            agent,
            session,
            session ? `Benchmark ${session}` : null,
            session ? (index % 2 === 0 ? 'declared' : 'inferred') : null,
            tool,
            effect,
            effect === 'read' ? 'retrieval' : effect === 'mutation' ? 'note' : 'identity',
            at,
            at,
            1,
            invalid ? 'invalid_arguments' : 'success',
            invalid ? 'input_validation' : null,
            invalid ? '[{"path":["limit"],"code":"invalid_type"}]' : null,
            effect === 'read' ? JSON.stringify({ query: `query-${index % 64}` }) : '{}',
            invalid ? `invalid-${index % 64}` : `shape-${index % 64}`,
          )
        }
        for (let index = 1; index <= half; index += 1) {
          const session = sessionOf(index, sessionPerSource)
          const agent = index % 17 === 0 ? 'Deleted token' : `Bench agent ${index % 8}`
          const at = timestamp(index)
          retrieval.run(
            OWNER,
            `pat:${OWNER}:bench`,
            agent,
            session,
            session ? `Benchmark ${session}` : null,
            session ? (index % 2 === 0 ? 'declared' : 'inferred') : null,
            index % 10 === 0 ? null : callIdOf(index),
            index % 3 === 0 ? 'recall' : 'search',
            `query-${index % 64}`,
            index % 11 === 0 ? 0 : 3,
            index % 11 === 0 ? null : 0.9,
            at,
          )
          revision.run(
            `bench-note-${index}`,
            `pat:${OWNER}:bench`,
            `Benchmark note ${index}`,
            at,
            OWNER,
            agent,
            session,
            session ? `Benchmark ${session}` : null,
            session ? (index % 2 === 0 ? 'declared' : 'inferred') : null,
            index % 10 === 0 ? null : callIdOf(index),
          )
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      traceCounter = 0
      await sessions.insert({
        id: 'ses_trace_write',
        owner: OWNER,
        name: 'Trace write benchmark',
        named: true,
        parentId: null,
        createdAt: timestamp(size + 1),
        lastSeenAt: timestamp(size + 1),
        calls: 1,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: null,
      })
    },
    supportsAll: async () => (await events(audit, { kind: 'all' }, 'all')).items.length > 0,
    reference: async (filter, before) => {
      const query = sqliteReferenceQuery(filter, before)
      const rows = db.prepare(query.sql).all(...(query.params as SQLInputValue[])) as Array<{
        source: 'retrieval' | 'write'
        source_rank: number
        id: number | bigint
        created_at: string
      }>
      return rows.slice(0, LIMIT).map((row) => ({
        source: row.source,
        sourceRank: Number(row.source_rank),
        id: String(row.id),
        at: row.created_at,
      }))
    },
    referencePlan: async (filter, before) => [sqlitePlan(db, sqliteReferenceQuery(filter, before))],
    productionPlan: async (scope, filter, before, agent) => {
      const traces: SqlTrace[] = []
      await events(recordingSqliteAudit(db, traces), scope, filter, before, agent)
      return traces.map((trace) => sqlitePlan(db, trace))
    },
    detailPlan: async () => {
      const traces: SqlTrace[] = []
      await recordingSqliteAudit(db, traces).find(OWNER, TARGET_SESSION, timestamp(0))
      return traces.map((trace) => sqlitePlan(db, trace))
    },
    prepareRetrievalOrder: async () => {
      db.prepare('UPDATE agent_retrievals SET created_at = ? WHERE owner = ?').run(
        timestamp(1),
        OWNER,
      )
    },
    prepareOutsideOrder: async () => {
      db.prepare(
        `UPDATE agent_retrievals
            SET created_at = CASE WHEN session_id IS NULL THEN ? ELSE ? END
          WHERE owner = ?`,
      ).run(timestamp(1), timestamp(2), OWNER)
      db.prepare(
        `UPDATE note_revisions
            SET created_at = CASE WHEN session_id IS NULL THEN ? ELSE ? END
          WHERE agent_owner = ?`,
      ).run(timestamp(1), timestamp(2), OWNER)
    },
    agents: async () => audit.agentFacet(OWNER),
    setTraceDetailed: async (enabled) => {
      const config = await calls.config()

      if (config.detailedEnabled !== enabled) {
        await calls.patchConfig({
          expectedVersionToken: config.versionToken,
          detailedEnabled: enabled,
          updatedAt: timestamp(1),
        })
      }
    },
    traceWrite,
    storageBytes: async (ids) => {
      const encoded = JSON.stringify(ids)
      const row = db
        .prepare(
          `SELECT
             COALESCE((
               SELECT SUM(length(json_object(
                 'id', id, 'owner', owner, 'principal', principal, 'agent', agent,
                 'transport', transport, 'request_id', request_id, 'session_id', session_id,
                 'session_name', session_name, 'session_attach', session_attach, 'tool', tool,
                 'effect', effect, 'domain', domain, 'started_at', started_at,
                 'finished_at', finished_at, 'duration_ms', duration_ms, 'outcome', outcome,
                 'reason_code', reason_code, 'input_bytes', input_bytes,
                 'output_bytes', output_bytes, 'input_shape', input_shape,
                 'issue_summary', issue_summary, 'target_summary', target_summary,
                 'result_summary', result_summary, 'fingerprint', fingerprint,
                 'projection_version', projection_version, 'redacted', redacted,
                 'truncated', truncated, 'detail_capture_failed', detail_capture_failed
               ))) FROM agent_calls WHERE id IN (SELECT value FROM json_each(?))
             ), 0) +
             COALESCE((
               SELECT SUM(length(payload)) FROM agent_call_details
                WHERE agent_call_id IN (SELECT value FROM json_each(?))
             ), 0) +
             COALESCE((
               SELECT SUM(length(json_object(
                 'id', id, 'agent_call_id', agent_call_id, 'owner', owner,
                 'principal', principal, 'agent', agent, 'session_id', session_id,
                 'session_name', session_name, 'session_attach', session_attach,
                 'tool', tool, 'query', query, 'project', project,
                 'class_filter', class_filter, 'result_count', result_count,
                 'top_score', top_score, 'hits', hits, 'created_at', created_at
               ))) FROM agent_retrievals
                WHERE agent_call_id IN (SELECT value FROM json_each(?))
             ), 0) AS bytes`,
        )
        .get(encoded, encoded, encoded) as { bytes: number | bigint }
      return Number(row.bytes)
    },
    prepareDenseTrace: async () => {
      db.prepare(
        `UPDATE agent_calls SET session_id = ?, session_name = ?, session_attach = 'declared'`,
      ).run(TARGET_SESSION, 'Dense export')
      db.prepare(
        `UPDATE agent_calls SET tool = 'start_session', effect = 'mutation', domain = 'session',
                result_summary = ?
          WHERE id = (SELECT id FROM agent_calls ORDER BY started_at, id LIMIT 1)`,
      ).run(JSON.stringify({ 'session.state': 'new' }))
      const row = db.prepare('SELECT COUNT(*) AS n FROM agent_calls').get() as {
        n: number | bigint
      }
      db.prepare(
        `INSERT OR REPLACE INTO agent_sessions
           (id, owner, name, named, parent_id, created_at, last_seen_at, calls, role,
            role_locator, role_context_project_id, project_id)
         VALUES (?, ?, ?, 1, NULL, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run(TARGET_SESSION, OWNER, 'Dense export', timestamp(0), timestamp(0), Number(row.n))
      return Number(row.n)
    },
    exportDenseTrace: async () => {
      let before: AgentSessionAuditEventCursor | undefined
      let count = 0
      let pages = 0
      let eventsMs = 0
      let detailsMs = 0

      for (;;) {
        let started = performance.now()
        const page = await audit.events({
          owner: OWNER,
          scope: { kind: 'session', id: TARGET_SESSION },
          limit: 1_000,
          before,
          withTotal: before == null,
        })
        eventsMs += performance.now() - started
        const ids = page.items.flatMap((event) => (event.type === 'call' ? [event.record.id] : []))
        started = performance.now()
        await calls.exportDetails(OWNER, ids, '2026-01-01T00:00:00.000Z')
        detailsMs += performance.now() - started
        count += page.items.length
        pages += 1
        const last = page.items.at(-1)

        if (!page.hasMore || !last) {
          return { rows: count, pages, eventsMs, detailsMs }
        }
        before = cursorOfEvent(last)
      }
    },
    maintainTrace: async () => {
      const remaining = () =>
        Number(
          (
            db
              .prepare(
                `SELECT
                   (SELECT COUNT(*) FROM agent_calls
                     WHERE owner = ? AND session_id = ?) +
                   (SELECT COUNT(*) FROM agent_retrievals
                     WHERE owner = ? AND session_id = ? AND agent_call_id IS NOT NULL) +
                   (SELECT COUNT(*) FROM agent_call_details detail
                     JOIN agent_calls call ON call.id = detail.agent_call_id
                    WHERE call.owner = ? AND call.session_id = ?) AS n`,
              )
              .get(OWNER, TARGET_SESSION, OWNER, TARGET_SESSION, OWNER, TARGET_SESSION) as {
              n: number | bigint
            }
          ).n,
        )
      const initial = remaining()
      let passes = 0
      let maxPassMs = 0
      const passMs: number[] = []
      let yields = 0
      let pending = true

      while (pending) {
        const started = performance.now()

        if (passes === 0) {
          await calls.maintain({ now: '2026-01-01T00:00:00.000Z', batchSize: 500 })
        }
        const progress = await calls.resumeCleanup(500)
        const elapsed = performance.now() - started
        passMs.push(elapsed)
        maxPassMs = Math.max(maxPassMs, elapsed)
        passes += 1
        pending = progress.pending

        if (pending) {
          if (progress.processed === 0) {
            throw new Error('SQLite trace cleanup made no progress')
          }
          await yieldTurn()
          yields += 1
        }
      }
      const left = remaining()
      return {
        passes,
        maxPassMs,
        p99PassMs: p99(passMs),
        processed: initial - left,
        remaining: left,
        yields,
      }
    },
    version: async () => {
      const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string }
      return row.version
    },
    close: async () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const createPostgresDriver = async (url: string): Promise<Driver> => {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  await runPgMigrations(client)
  await client.end()
  const pool = new pg.Pool({ connectionString: url })
  const ctx = { ensureInit: async () => {}, close: async () => {}, required: pool }
  const audit = createPgSessionAuditFacet(ctx)
  const retrievals = createPgRetrievalLogFacet(ctx)
  const calls = createPgAgentCallsFacet(ctx)
  const sessions = createPgSessionsFacet(ctx)
  let traceCounter = 0
  const traceWrite = productionTraceWriter(calls, retrievals, () => {
    traceCounter += 1
    return {
      id: `call_perf_${String(traceCounter).padStart(8, '0')}`,
      at: new Date(BASE_TIME + 700_000_000 + traceCounter).toISOString(),
    }
  })

  return {
    name: 'postgres',
    audit,
    retrievals,
    calls,
    sessions,
    seed: async (size) => {
      const half = size / 2
      const sessionPerSource = size / 4
      const seedClient = await pool.connect()

      try {
        await seedClient.query('BEGIN')
        await seedClient.query('SET LOCAL synchronous_commit = off')
        await seedClient.query(
          'TRUNCATE agent_call_details, agent_retrievals, note_revisions, agent_calls, agent_session_cleanup_markers, mcp_delta_session_cursors, agent_sessions RESTART IDENTITY',
        )
        await seedClient.query('ALTER TABLE note_revisions DISABLE TRIGGER USER')
        await seedClient.query(
          `INSERT INTO agent_calls
             (id, owner, principal, agent, transport, request_id, session_id, session_name,
              session_attach, tool, effect, domain, started_at, finished_at, duration_ms,
              outcome, reason_code, input_bytes, output_bytes, input_shape, issue_summary,
              target_summary, result_summary, fingerprint, projection_version, redacted,
              truncated, detail_capture_failed)
           SELECT 'call_' || lpad(to_hex(n), 12, '0'), $1, 'pat:' || $1 || ':bench',
                  CASE WHEN n % 17 = 0 THEN 'Deleted token' ELSE 'Bench agent ' || n % 8 END,
                  'mcp', NULL,
                  CASE WHEN n <= 100 THEN $2
                       WHEN n <= $3 THEN 'ses_other_' || lpad(((n - 101) % 100)::text, 3, '0')
                       ELSE NULL END,
                  CASE WHEN n <= 100 THEN 'Benchmark ' || $2
                       WHEN n <= $3 THEN 'Benchmark ses_other_' || lpad(((n - 101) % 100)::text, 3, '0')
                       ELSE NULL END,
                  CASE WHEN n <= $3 THEN CASE WHEN n % 2 = 0 THEN 'declared' ELSE 'inferred' END ELSE NULL END,
                  CASE WHEN n % 3 = 0 THEN 'search' WHEN n % 3 = 1 THEN 'create_note' ELSE 'whoami' END,
                  CASE WHEN n % 3 = 0 THEN 'read' WHEN n % 3 = 1 THEN 'mutation' ELSE 'control' END,
                  CASE WHEN n % 3 = 0 THEN 'retrieval' WHEN n % 3 = 1 THEN 'note' ELSE 'identity' END,
                  to_char(timestamp '2025-01-01 00:00:00' + n * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  to_char(timestamp '2025-01-01 00:00:00' + n * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  1,
                  CASE WHEN n % 11 = 0 THEN 'invalid_arguments' ELSE 'success' END,
                  CASE WHEN n % 11 = 0 THEN 'input_validation' ELSE NULL END,
                  64, 32, '{}'::jsonb,
                  CASE WHEN n % 11 = 0 THEN '[{"path":["limit"],"code":"invalid_type"}]'::jsonb ELSE NULL END,
                  CASE WHEN n % 3 = 0 THEN jsonb_build_object('query', 'query-' || n % 64) ELSE '{}'::jsonb END,
                  '{}'::jsonb,
                  CASE WHEN n % 11 = 0 THEN 'invalid-' || n % 64 ELSE 'shape-' || n % 64 END,
                  1, true, false, false
             FROM generate_series(1, $4::integer) AS generated(n)`,
          [OWNER, TARGET_SESSION, size / 2, size],
        )
        await seedClient.query(
          `INSERT INTO agent_retrievals
             (owner, principal, agent, session_id, session_name, session_attach, agent_call_id, tool, query,
              project, class_filter, result_count, top_score, hits, created_at)
           SELECT $1,
                  'pat:' || $1 || ':bench',
                  CASE WHEN n % 17 = 0 THEN 'Deleted token' ELSE 'Bench agent ' || n % 8 END,
                  CASE WHEN n <= 100 THEN $2
                       WHEN n <= $3 THEN 'ses_other_' || lpad(((n - 101) % 100)::text, 3, '0')
                       ELSE NULL END,
                  CASE WHEN n <= 100 THEN 'Benchmark ' || $2
                       WHEN n <= $3 THEN 'Benchmark ses_other_' || lpad(((n - 101) % 100)::text, 3, '0')
                       ELSE NULL END,
                  CASE WHEN n <= $3 THEN CASE WHEN n % 2 = 0 THEN 'declared' ELSE 'inferred' END
                       ELSE NULL END,
                  CASE WHEN n % 10 = 0 THEN NULL ELSE 'call_' || lpad(to_hex(n), 12, '0') END,
                  CASE WHEN n % 3 = 0 THEN 'recall' ELSE 'search' END,
                  'query-' || n % 64,
                  NULL, NULL,
                  CASE WHEN n % 11 = 0 THEN 0 ELSE 3 END,
                  CASE WHEN n % 11 = 0 THEN NULL ELSE 0.9 END,
                  '[]',
                  to_char(timestamp '2025-01-01 00:00:00' + n * interval '1 second',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             FROM generate_series(1, $4::integer) AS generated(n)`,
          [OWNER, TARGET_SESSION, sessionPerSource, half],
        )
        await seedClient.query(
          `INSERT INTO note_revisions
             (note_id, space, kind, principal, content_hash, title, tags, created_at,
              chars_added, chars_removed, class, agent_owner, agent_name, session_id,
              session_name, session_attach, agent_call_id, entry_role, state_format, integrity)
           SELECT 'bench-note-' || n,
                  'bench-space', 'write', 'pat:' || $1 || ':bench', NULL,
                  'Benchmark note ' || n, '[]',
                  to_char(timestamp '2025-01-01 00:00:00' + n * interval '1 second',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  1, 0, 'user-doc', $1,
                  CASE WHEN n % 17 = 0 THEN 'Deleted token' ELSE 'Bench agent ' || n % 8 END,
                  CASE WHEN n <= 100 THEN $2
                       WHEN n <= $3 THEN 'ses_other_' || lpad(((n - 101) % 100)::text, 3, '0')
                       ELSE NULL END,
                  CASE WHEN n <= 100 THEN 'Benchmark ' || $2
                       WHEN n <= $3 THEN 'Benchmark ses_other_' || lpad(((n - 101) % 100)::text, 3, '0')
                       ELSE NULL END,
                  CASE WHEN n <= $3 THEN CASE WHEN n % 2 = 0 THEN 'declared' ELSE 'inferred' END
                       ELSE NULL END,
                  CASE WHEN n % 10 = 0 THEN NULL ELSE 'call_' || lpad(to_hex(n), 12, '0') END,
                  'change', NULL, 'trusted'
             FROM generate_series(1, $4::integer) AS generated(n)`,
          [OWNER, TARGET_SESSION, sessionPerSource, half],
        )
        await seedClient.query('ALTER TABLE note_revisions ENABLE TRIGGER USER')
        await seedClient.query('COMMIT')
      } catch (error) {
        await seedClient.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        seedClient.release()
      }
      await pool.query('ANALYZE agent_retrievals')
      await pool.query('ANALYZE note_revisions')
      await pool.query('ANALYZE agent_calls')
      traceCounter = 0
      await sessions.insert({
        id: 'ses_trace_write',
        owner: OWNER,
        name: 'Trace write benchmark',
        named: true,
        parentId: null,
        createdAt: timestamp(size + 1),
        lastSeenAt: timestamp(size + 1),
        calls: 1,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: null,
      })
    },
    supportsAll: async () => (await events(audit, { kind: 'all' }, 'all')).items.length > 0,
    reference: async (filter, before) => {
      const query = pgReferenceQuery(filter, before)
      const result = await pool.query(query.sql, query.params)
      return (
        result.rows as Array<{
          source: 'retrieval' | 'write'
          source_rank: number
          id: string | number
          created_at: string
        }>
      )
        .slice(0, LIMIT)
        .map((row) => ({
          source: row.source,
          sourceRank: Number(row.source_rank),
          id: String(row.id),
          at: row.created_at,
        }))
    },
    referencePlan: async (filter, before) => [await pgPlan(pool, pgReferenceQuery(filter, before))],
    productionPlan: async (scope, filter, before, agent) => {
      const traces: SqlTrace[] = []
      await events(recordingPgAudit(pool, traces), scope, filter, before, agent)
      return Promise.all(traces.map((trace) => pgPlan(pool, trace)))
    },
    detailPlan: async () => {
      const traces: SqlTrace[] = []
      await recordingPgAudit(pool, traces).find(OWNER, TARGET_SESSION, timestamp(0))
      return Promise.all(traces.map((trace) => pgPlan(pool, trace)))
    },
    prepareRetrievalOrder: async () => {
      await pool.query('UPDATE agent_retrievals SET created_at = $1 WHERE owner = $2', [
        timestamp(1),
        OWNER,
      ])
      await pool.query('VACUUM ANALYZE agent_retrievals')
    },
    prepareOutsideOrder: async () => {
      await pool.query(
        `UPDATE agent_retrievals
            SET created_at = CASE WHEN session_id IS NULL THEN $1 ELSE $2 END
          WHERE owner = $3`,
        [timestamp(1), timestamp(2), OWNER],
      )
      await pool.query(
        `UPDATE note_revisions
            SET created_at = CASE WHEN session_id IS NULL THEN $1 ELSE $2 END
          WHERE agent_owner = $3`,
        [timestamp(1), timestamp(2), OWNER],
      )
      await pool.query('VACUUM ANALYZE agent_retrievals')
      await pool.query('VACUUM ANALYZE note_revisions')
    },
    agents: async () => audit.agentFacet(OWNER),
    setTraceDetailed: async (enabled) => {
      const config = await calls.config()

      if (config.detailedEnabled !== enabled) {
        await calls.patchConfig({
          expectedVersionToken: config.versionToken,
          detailedEnabled: enabled,
          updatedAt: timestamp(1),
        })
      }
    },
    traceWrite,
    storageBytes: async (ids) => {
      const row = (
        await pool.query(
          `SELECT
             COALESCE((SELECT SUM(pg_column_size(call)) FROM agent_calls call
                        WHERE id = ANY($1::text[])), 0) +
             COALESCE((SELECT SUM(pg_column_size(detail)) FROM agent_call_details detail
                        WHERE agent_call_id = ANY($1::text[])), 0) +
             COALESCE((SELECT SUM(pg_column_size(retrieval)) FROM agent_retrievals retrieval
                        WHERE agent_call_id = ANY($1::text[])), 0) AS bytes`,
          [ids],
        )
      ).rows[0] as { bytes: number | string }
      return Number(row.bytes)
    },
    prepareDenseTrace: async () => {
      await pool.query(
        `UPDATE agent_calls SET session_id = $1, session_name = 'Dense export',
                session_attach = 'declared'`,
        [TARGET_SESSION],
      )
      await pool.query(
        `UPDATE agent_calls SET tool = 'start_session', effect = 'mutation', domain = 'session',
                result_summary = $1::jsonb
          WHERE id = (SELECT id FROM agent_calls ORDER BY started_at, id LIMIT 1)`,
        [JSON.stringify({ 'session.state': 'new' })],
      )
      const count = Number((await pool.query('SELECT COUNT(*) AS n FROM agent_calls')).rows[0].n)
      await pool.query(
        `INSERT INTO agent_sessions
           (id, owner, name, named, parent_id, created_at, last_seen_at, calls, role,
            role_locator, role_context_project_id, project_id)
         VALUES ($1, $2, 'Dense export', true, NULL, $3, $3, $4, NULL, NULL, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET owner = EXCLUDED.owner, name = EXCLUDED.name,
           last_seen_at = EXCLUDED.last_seen_at, calls = EXCLUDED.calls`,
        [TARGET_SESSION, OWNER, timestamp(0), count],
      )
      await pool.query('ANALYZE agent_calls')
      return count
    },
    exportDenseTrace: async () => {
      let before: AgentSessionAuditEventCursor | undefined
      let count = 0
      let pages = 0
      let eventsMs = 0
      let detailsMs = 0

      for (;;) {
        let started = performance.now()
        const page = await audit.events({
          owner: OWNER,
          scope: { kind: 'session', id: TARGET_SESSION },
          limit: 1_000,
          before,
          withTotal: before == null,
        })
        eventsMs += performance.now() - started
        const ids = page.items.flatMap((event) => (event.type === 'call' ? [event.record.id] : []))
        started = performance.now()
        await calls.exportDetails(OWNER, ids, '2026-01-01T00:00:00.000Z')
        detailsMs += performance.now() - started
        count += page.items.length
        pages += 1
        const last = page.items.at(-1)

        if (!page.hasMore || !last) {
          return { rows: count, pages, eventsMs, detailsMs }
        }
        before = cursorOfEvent(last)
      }
    },
    maintainTrace: async () => {
      const remaining = async () =>
        Number(
          (
            await pool.query(
              `SELECT
                 (SELECT COUNT(*) FROM agent_calls
                   WHERE owner = $1 AND session_id = $2) +
                 (SELECT COUNT(*) FROM agent_retrievals
                   WHERE owner = $1 AND session_id = $2 AND agent_call_id IS NOT NULL) +
                 (SELECT COUNT(*) FROM agent_call_details detail
                   JOIN agent_calls call ON call.id = detail.agent_call_id
                  WHERE call.owner = $1 AND call.session_id = $2) AS n`,
              [OWNER, TARGET_SESSION],
            )
          ).rows[0].n,
        )
      const initial = await remaining()
      let passes = 0
      let maxPassMs = 0
      const passMs: number[] = []
      let yields = 0
      let pending = true

      while (pending) {
        const started = performance.now()

        if (passes === 0) {
          await calls.maintain({ now: '2026-01-01T00:00:00.000Z', batchSize: 500 })
        }
        const progress = await calls.resumeCleanup(500)
        const elapsed = performance.now() - started
        passMs.push(elapsed)
        maxPassMs = Math.max(maxPassMs, elapsed)
        passes += 1
        pending = progress.pending

        if (pending) {
          if (progress.processed === 0) {
            throw new Error('PostgreSQL trace cleanup made no progress')
          }
          await yieldTurn()
          yields += 1
        }
      }
      const left = await remaining()
      return {
        passes,
        maxPassMs,
        p99PassMs: p99(passMs),
        processed: initial - left,
        remaining: left,
        yields,
      }
    },
    version: async () => String((await pool.query('SHOW server_version')).rows[0].server_version),
    close: async () => {
      await pool.end()
    },
  }
}

const benchmarkDriver = async (
  driver: Driver,
  sizes: readonly number[],
  report: Report,
  persist: () => void,
): Promise<void> => {
  report.versions[driver.name] = await driver.version()

  for (const size of sizes) {
    process.stdout.write(`session-audit-bench: ${driver.name} seed ${size}\n`)
    await driver.seed(size)
    const supportsAll = await driver.supportsAll()

    for (const scope of [
      { kind: 'all' } as const,
      { kind: 'outside' } as const,
      { kind: 'session', id: TARGET_SESSION } as const,
    ]) {
      for (const filter of ['all', 'reads', 'writes'] as const) {
        const production = scope.kind !== 'all' || supportsAll
        let nextCursor: AgentSessionAuditEventCursor

        if (production) {
          const first = await events(driver.audit, scope, filter)
          const last = first.items.at(-1)

          if (!last) {
            throw new Error(`${driver.name} ${size} ${scope.kind}/${filter} produced no first page`)
          }
          nextCursor = cursorOfEvent(last)
        } else {
          const first = await driver.reference(filter)
          const last = first.at(-1)

          if (!last) {
            throw new Error(`${driver.name} ${size} ${scope.kind}/${filter} produced no first page`)
          }
          nextCursor = cursorOfReference(last)
        }

        for (const page of ['first', 'next'] as const) {
          const before = page === 'next' ? nextCursor : undefined
          const run = production
            ? () => events(driver.audit, scope, filter, before)
            : () => driver.reference(filter, before)
          const measured = await measure(run)
          const plans = production
            ? await driver.productionPlan(scope, filter, before)
            : await driver.referencePlan(filter, before)
          report.cells.push({
            driver: driver.name,
            dataset: size,
            scope: scope.kind,
            filter,
            page,
            mode: production ? 'production' : 'diagnostic-reference',
            warmups: WARMUPS,
            measured: MEASURED,
            rawMs: measured.raw,
            medianMs: measured.median,
            plans,
          })
          process.stdout.write(
            `session-audit-bench: ${driver.name} ${size} ${scope.kind}/${filter}/${page} ` +
              `${measured.median.toFixed(3)} ms (${production ? 'production' : 'reference'})\n`,
          )
          persist()
        }
      }
    }

    const allRun = supportsAll
      ? () => events(driver.audit, { kind: 'all' }, 'all')
      : () => driver.reference('all')
    const disabled = await measure(allRun)
    const enabled = await measure(() =>
      Promise.all([
        allRun(),
        driver.retrievals.aggregates(OWNER),
        driver.agents(),
        driver.calls.recurringProblems(OWNER, timestamp(0), 8),
      ]),
    )
    const components = {
      timelineMedianMs: await measureComponent(allRun),
      retrievalsMedianMs: await measureComponent(() => driver.retrievals.aggregates(OWNER)),
      agentsMedianMs: await measureComponent(() => driver.agents()),
      problemsMedianMs: await measureComponent(() =>
        driver.calls.recurringProblems(OWNER, timestamp(0), 8),
      ),
    }
    report.aggregatePairs.push({
      driver: driver.name,
      dataset: size,
      disabledRawMs: disabled.raw,
      disabledMedianMs: disabled.median,
      enabledRawMs: enabled.raw,
      enabledMedianMs: enabled.median,
      ratio: enabled.median / disabled.median,
      components,
    })
    process.stdout.write(
      `session-audit-bench: ${driver.name} ${size} aggregates ` +
        `${disabled.median.toFixed(3)} -> ${enabled.median.toFixed(3)} ms ` +
        `(timeline ${components.timelineMedianMs.toFixed(3)}, ` +
        `retrievals ${components.retrievalsMedianMs.toFixed(3)}, ` +
        `agents ${components.agentsMedianMs.toFixed(3)}, ` +
        `problems ${components.problemsMedianMs.toFixed(3)})\n`,
    )
    persist()

    const detail = await measure(() => driver.audit.find(OWNER, TARGET_SESSION, timestamp(0)))
    report.probes.push({
      driver: driver.name,
      dataset: size,
      kind: 'detail',
      warmups: WARMUPS,
      measured: MEASURED,
      rawMs: detail.raw,
      medianMs: detail.median,
      plans: await driver.detailPlan(),
    })
    const agent = await measure(() =>
      events(driver.audit, { kind: 'all' }, 'all', undefined, 'Deleted token'),
    )
    report.probes.push({
      driver: driver.name,
      dataset: size,
      kind: 'agent',
      warmups: WARMUPS,
      measured: MEASURED,
      rawMs: agent.raw,
      medianMs: agent.median,
      plans: await driver.productionPlan({ kind: 'all' }, 'all', undefined, 'Deleted token'),
    })

    await driver.prepareRetrievalOrder()
    const retrievalOrder = await measure(() => events(driver.audit, { kind: 'all' }, 'reads'))
    report.probes.push({
      driver: driver.name,
      dataset: size,
      kind: 'retrieval-order',
      warmups: WARMUPS,
      measured: MEASURED,
      rawMs: retrievalOrder.raw,
      medianMs: retrievalOrder.median,
      plans: await driver.productionPlan({ kind: 'all' }, 'reads'),
    })

    await driver.prepareOutsideOrder()
    const outsideReads = await measure(() => events(driver.audit, { kind: 'outside' }, 'reads'))
    report.probes.push({
      driver: driver.name,
      dataset: size,
      kind: 'outside-reads',
      warmups: WARMUPS,
      measured: MEASURED,
      rawMs: outsideReads.raw,
      medianMs: outsideReads.median,
      plans: await driver.productionPlan({ kind: 'outside' }, 'reads'),
    })
    const outsideWrites = await measure(() => events(driver.audit, { kind: 'outside' }, 'writes'))
    report.probes.push({
      driver: driver.name,
      dataset: size,
      kind: 'outside-writes',
      warmups: WARMUPS,
      measured: MEASURED,
      rawMs: outsideWrites.raw,
      medianMs: outsideWrites.median,
      plans: await driver.productionPlan({ kind: 'outside' }, 'writes'),
    })
    process.stdout.write(
      `session-audit-bench: ${driver.name} ${size} detail ${detail.median.toFixed(3)} ms, ` +
        `agent ${agent.median.toFixed(3)} ms, retrieval-order ` +
        `${retrievalOrder.median.toFixed(3)} ms, outside ` +
        `${outsideReads.median.toFixed(3)}/${outsideWrites.median.toFixed(3)} ms\n`,
    )
    persist()

    for (const [kind, detailed] of [
      ['compact-write', false],
      ['detailed-write', true],
    ] as const) {
      await driver.setTraceDetailed(detailed)
      const measured = await measure(() => driver.traceWrite())
      report.traceProbes.push({
        driver: driver.name,
        dataset: size,
        kind,
        rows: 1,
        rawMs: measured.raw,
        medianMs: measured.median,
      })
      const storageIds: string[] = []

      for (let index = 0; index < STORAGE_ROWS; index += 1) {
        storageIds.push(await driver.traceWrite())
      }
      const bytes = await driver.storageBytes(storageIds)
      report.storageProbes.push({
        driver: driver.name,
        dataset: size,
        mode: detailed ? 'detailed' : 'compact',
        method: driver.name === 'sqlite' ? 'sqlite-json-payload-v1' : 'postgres-row-size-v1',
        rows: storageIds.length,
        bytes,
        bytesPerRow: bytes / storageIds.length,
      })
      process.stdout.write(
        `session-audit-bench: ${driver.name} ${size} ${kind} ${measured.median.toFixed(3)} ms, ` +
          `${(bytes / storageIds.length).toFixed(1)} logical bytes/row\n`,
      )
    }

    await driver.prepareDenseTrace()
    let started = performance.now()
    const exported = await driver.exportDenseTrace()
    const exportMs = performance.now() - started
    report.traceProbes.push({
      driver: driver.name,
      dataset: size,
      kind: 'dense-export',
      rows: exported.rows,
      rawMs: [exportMs],
      medianMs: exportMs,
      components: {
        pages: exported.pages,
        eventsMs: exported.eventsMs,
        detailsMs: exported.detailsMs,
      },
    })
    started = performance.now()
    const maintenance = await driver.maintainTrace()
    const maintenanceMs = performance.now() - started
    report.traceProbes.push({
      driver: driver.name,
      dataset: size,
      kind: 'maintenance',
      rows: maintenance.processed,
      rawMs: [maintenanceMs],
      medianMs: maintenanceMs,
      components: maintenance,
    })
    process.stdout.write(
      `session-audit-bench: ${driver.name} ${size} dense-export ${exported.rows} rows / ` +
        `${exportMs.toFixed(3)} ms (events ${exported.eventsMs.toFixed(3)}, ` +
        `details ${exported.detailsMs.toFixed(3)}); maintenance ${maintenanceMs.toFixed(3)} ms ` +
        `(${maintenance.passes} passes, p99/max ${maintenance.p99PassMs.toFixed(3)}/` +
        `${maintenance.maxPassMs.toFixed(3)} ms, ` +
        `${maintenance.remaining} remaining)\n`,
    )
    persist()
  }
}

const main = async () => {
  const sizes = sizeList()
  const output =
    process.env.BENCH_OUTPUT ?? join('test-results', 'session-audit-bench', 'manual.json')
  const report: Report = {
    phase: process.env.BENCH_PHASE ?? 'manual',
    startedAt: new Date().toISOString(),
    gitCommit: process.env.BENCH_COMMIT ?? process.env.CI_COMMIT_SHA ?? null,
    gitTree: process.env.BENCH_TREE ?? null,
    node: process.version,
    images: {
      node: process.env.BENCH_NODE_IMAGE ?? null,
      postgres: process.env.BENCH_PG_IMAGE ?? null,
    },
    policy: {
      sizes,
      limit: LIMIT,
      warmups: WARMUPS,
      measured: MEASURED,
      sqliteAnalyze: false,
      postgresAnalyze: true,
    },
    versions: {},
    cells: [],
    aggregatePairs: [],
    probes: [],
    traceProbes: [],
    storageProbes: [],
  }

  const persist = () => {
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  }
  persist()
  const postgresUrl = process.env.TEST_PG_URL

  if (!postgresUrl) {
    throw new Error('TEST_PG_URL is required; run make bench-session-audit')
  }
  const drivers: Driver[] = [createSqliteDriver(), await createPostgresDriver(postgresUrl)]

  try {
    for (const driver of drivers) {
      await benchmarkDriver(driver, sizes, report, persist)
    }
    if (report.phase === 'post') {
      const baselinePath = process.env.BENCH_BASELINE
      const baselineRaw = baselinePath
        ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as BenchmarkGateReport)
        : undefined
      const baseline = baselineRaw
        ? {
            ...baselineRaw,
            gitTree: baselineRaw.gitTree ?? process.env.BENCH_BASELINE_TREE ?? null,
          }
        : undefined
      const failures = benchmarkGateFailures(report, baseline)
      report.gate = {
        baseline: baselinePath ?? '',
        baselineCommit: baseline?.gitCommit ?? null,
        baselineTree: baseline?.gitTree ?? null,
        failures,
        passed: failures.length === 0,
      }
      persist()

      if (failures.length > 0) {
        throw new Error(`session audit benchmark gates failed:\n${failures.join('\n')}`)
      }
    }
    report.finishedAt = new Date().toISOString()
    persist()
    process.stdout.write(`session-audit-bench: report ${output}\n`)
  } finally {
    await Promise.allSettled(drivers.map((driver) => driver.close()))
  }
}

await main()
