import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import pg from 'pg'

import { createRetrievalLogFacet as createPgRetrievalLogFacet } from '../packages/server/src/services/metaDb/drivers/pg/retrievalLog'
import { createSessionAuditFacet as createPgSessionAuditFacet } from '../packages/server/src/services/metaDb/drivers/pg/sessionAudit'
import { createRetrievalLogFacet as createSqliteRetrievalLogFacet } from '../packages/server/src/services/metaDb/drivers/sqlite/retrievalLog'
import { createSessionAuditFacet as createSqliteSessionAuditFacet } from '../packages/server/src/services/metaDb/drivers/sqlite/sessionAudit'
import {
  runPgMigrations,
  runSqliteMigrations,
} from '../packages/server/src/services/metaDb/migrations'
import type {
  AgentSessionAuditEventCursor,
  AgentSessionAuditPersistence,
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

type Report = {
  phase: string
  startedAt: string
  finishedAt?: string
  gitCommit: string | null
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
  gate?: { baseline: string; failures: string[]; passed: boolean }
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
  event.type === 'retrieval'
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

const sessionOf = (index: number, sessionPerSource: number): string | null => {
  if (index <= 100) {
    return TARGET_SESSION
  }
  if (index > sessionPerSource) {
    return null
  }

  return `ses_other_${String((index - 101) % 100).padStart(3, '0')}`
}

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
  const ctx = { ensureInit: async () => {}, close: async () => {}, required: db }
  const audit = createSqliteSessionAuditFacet(ctx)
  const retrievals = createSqliteRetrievalLogFacet(ctx)

  return {
    name: 'sqlite',
    audit,
    retrievals,
    seed: async (size) => {
      const half = size / 2
      const sessionPerSource = size / 4
      db.exec(`DELETE FROM agent_retrievals; DELETE FROM note_revisions;
        DELETE FROM sqlite_sequence WHERE name IN ('agent_retrievals', 'note_revisions')`)
      const retrieval = db.prepare(
        `INSERT INTO agent_retrievals
           (owner, principal, agent, session_id, session_name, session_attach, tool, query,
            project, class_filter, result_count, top_score, hits, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, '[]', ?)`,
      )
      const revision = db.prepare(
        `INSERT INTO note_revisions
           (note_id, space, kind, principal, content_hash, title, tags, created_at,
            chars_added, chars_removed, class, agent_owner, agent_name, session_id,
            session_name, session_attach, entry_role, state_format, integrity)
         VALUES (?, 'bench-space', 'write', ?, NULL, ?, '[]', ?, 1, 0, 'user-doc', ?, ?, ?, ?, ?,
                 'change', NULL, 'trusted')`,
      )
      db.exec('BEGIN IMMEDIATE')

      try {
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
          )
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
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
    agents: async () =>
      db
        .prepare(
          `SELECT agent, COUNT(*) AS count FROM (
             SELECT agent FROM agent_retrievals
              WHERE owner = ? AND agent IS NOT NULL AND agent != ''
             UNION ALL
             SELECT agent_name AS agent FROM note_revisions
              WHERE agent_owner = ? AND integrity != 'quarantined'
                AND agent_name IS NOT NULL AND agent_name != ''
           ) GROUP BY agent ORDER BY count DESC, agent`,
        )
        .all(OWNER, OWNER),
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

  return {
    name: 'postgres',
    audit,
    retrievals,
    seed: async (size) => {
      const half = size / 2
      const sessionPerSource = size / 4
      const seedClient = await pool.connect()

      try {
        await seedClient.query('BEGIN')
        await seedClient.query('SET LOCAL synchronous_commit = off')
        await seedClient.query('TRUNCATE agent_retrievals, note_revisions RESTART IDENTITY')
        await seedClient.query('ALTER TABLE note_revisions DISABLE TRIGGER USER')
        await seedClient.query(
          `INSERT INTO agent_retrievals
             (owner, principal, agent, session_id, session_name, session_attach, tool, query,
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
              session_name, session_attach, entry_role, state_format, integrity)
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
    agents: async () =>
      (
        await pool.query(
          `SELECT agent, COUNT(*) AS count FROM (
             SELECT agent FROM agent_retrievals
              WHERE owner = $1 AND agent IS NOT NULL AND agent != ''
             UNION ALL
             SELECT agent_name AS agent FROM note_revisions
              WHERE agent_owner = $1 AND integrity != 'quarantined'
                AND agent_name IS NOT NULL AND agent_name != ''
           ) AS attributed GROUP BY agent ORDER BY count DESC, agent`,
          [OWNER],
        )
      ).rows,
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
      Promise.all([allRun(), driver.retrievals.aggregates(OWNER), driver.agents()]),
    )
    report.aggregatePairs.push({
      driver: driver.name,
      dataset: size,
      disabledRawMs: disabled.raw,
      disabledMedianMs: disabled.median,
      enabledRawMs: enabled.raw,
      enabledMedianMs: enabled.median,
      ratio: enabled.median / disabled.median,
    })
    process.stdout.write(
      `session-audit-bench: ${driver.name} ${size} aggregates ` +
        `${disabled.median.toFixed(3)} -> ${enabled.median.toFixed(3)} ms\n`,
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
      const baseline = baselinePath
        ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as BenchmarkGateReport)
        : undefined
      const failures = benchmarkGateFailures(report, baseline)
      report.gate = {
        baseline: baselinePath ?? '',
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
