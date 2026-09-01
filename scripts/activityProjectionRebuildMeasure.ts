import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import type { AuthorFilter, RevisionInput } from '@notarium/core'

import { PgMetaDb } from '../packages/server/src/services/metaDb/pgMetaDb'
import { SqliteMetaDb } from '../packages/server/src/services/metaDb/sqliteMetaDb'

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=')
    return [key!, value.join('=')]
  }),
)
const dialect = args.get('dialect') as 'sqlite' | 'postgres'
const target = args.get('target')
const output = args.get('output')
const space = args.get('space') ?? 'activity-groups'
const durationSeconds = Number(args.get('duration-seconds') ?? 0)
const foreground = args.get('foreground') === 'true'
const sqliteWorkerEntry = args.get('sqlite-worker-entry')

if (!target || !output || !['sqlite', 'postgres'].includes(dialect)) {
  throw new Error(
    'usage: --dialect=sqlite|postgres --target=<db path/url> --output=<json> [--space=<id>] [--duration-seconds=90] [--foreground=true]',
  )
}

const intervalMs = 50
const waitTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, intervalMs))
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const nearestRank = (values: readonly number[], percentile: number): number => {
  if (!values.length) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!
}
const stats = (values: readonly number[]) => ({
  count: values.length,
  medianMs: nearestRank(values, 0.5),
  p95Ms: nearestRank(values, 0.95),
  maxMs: values.length ? Math.max(...values) : 0,
})

type LivenessPhase =
  | 'paced-rebuild'
  | 'near-publication-invalidation'
  | 'restart'
  | 'replacement-publication'
  | 'generation-gc'
  | 'ready-reads'
type MutablePhaseObservation = {
  phase: LivenessPhase
  startedAt: number
  durationMs: number
  workUnits: number
  heartbeatSamples: number
  blocksOverOneSecond: number
  totalLatenessMs: number
  latenessMaxMs: number
  responseMaxMs: number
}

const openDb = () =>
  dialect === 'sqlite'
    ? new SqliteMetaDb(target, {
        ...(sqliteWorkerEntry
          ? { activityWorkerEntry: pathToFileURL(resolve(sqliteWorkerEntry)) }
          : {}),
      })
    : new PgMetaDb(target)
let db = openDb()
let totalLatenessMs = 0
let latenessMaxMs = 0
let blocksOverOneSecond = 0
let heartbeat: ReturnType<typeof setInterval> | null = null
let activePhase: MutablePhaseObservation | null = null
const observedPhases: MutablePhaseObservation[] = []
const phasePointMs = new Map<LivenessPhase, number[]>()
const phaseAppendMs = new Map<LivenessPhase, number[]>()

const startHeartbeat = (): void => {
  let lastTick = performance.now()

  heartbeat = setInterval(() => {
    const now = performance.now()
    const lateness = Math.max(0, now - lastTick - intervalMs)

    if (activePhase) {
      activePhase.heartbeatSamples++
      activePhase.totalLatenessMs += lateness
      activePhase.latenessMaxMs = Math.max(activePhase.latenessMaxMs, lateness)
    }
    // Keep the legacy aggregate paired with durationSeconds: it describes the
    // paced 90-second window. Recovery phases have their own observations and
    // duration-scaled debt ceilings below instead of contaminating that pair.
    if (activePhase?.phase === 'paced-rebuild') {
      totalLatenessMs += lateness
      latenessMaxMs = Math.max(latenessMaxMs, lateness)
    }
    if (lateness > 1_000) {
      if (activePhase) {
        activePhase.blocksOverOneSecond++
      }
      if (activePhase?.phase === 'paced-rebuild') {
        blocksOverOneSecond++
      }
    }
    lastTick = now
  }, intervalMs)
}

const stopHeartbeat = (): void => {
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
}

type ProjectionProgress = {
  state: 'ready' | 'rebuilding'
  rebuildCursor: bigint
  nextSourceOrdinal: bigint
  activeGeneration: string | null
}

const projectionProgress = async (): Promise<ProjectionProgress> => {
  if (dialect === 'sqlite') {
    const inspected = new DatabaseSync(target, { readOnly: true })

    try {
      const row = inspected
        .prepare(
          `SELECT state, rebuild_cursor, next_source_ordinal, active_generation
             FROM activity_projection_status WHERE space = ?`,
        )
        .get(space) as
        | {
            state: 'ready' | 'rebuilding'
            rebuild_cursor: number | bigint | null
            next_source_ordinal: number | bigint
            active_generation: number | bigint | null
          }
        | undefined

      if (!row) {
        throw new Error(`Activity projection status is missing for ${space}`)
      }

      return {
        state: row.state,
        rebuildCursor: BigInt(row.rebuild_cursor ?? 0),
        nextSourceOrdinal: BigInt(row.next_source_ordinal),
        activeGeneration: row.active_generation == null ? null : String(row.active_generation),
      }
    } finally {
      inspected.close()
    }
  }

  const pool = new pg.Pool({ connectionString: target })

  try {
    const result = await pool.query(
      `SELECT state, rebuild_cursor::text, next_source_ordinal::text,
              active_generation::text
         FROM activity_projection_status WHERE space = $1`,
      [space],
    )
    const row = result.rows[0] as
      | {
          state: 'ready' | 'rebuilding'
          rebuild_cursor: string | null
          next_source_ordinal: string
          active_generation: string | null
        }
      | undefined

    if (!row) {
      throw new Error(`Activity projection status is missing for ${space}`)
    }

    return {
      state: row.state,
      rebuildCursor: BigInt(row.rebuild_cursor ?? 0),
      nextSourceOrdinal: BigInt(row.next_source_ordinal),
      activeGeneration: row.active_generation,
    }
  } finally {
    await pool.end()
  }
}

const invalidateSourceGeneration = async (): Promise<void> => {
  if (dialect === 'sqlite') {
    const writer = new DatabaseSync(target)

    try {
      const changed = writer
        .prepare(
          `UPDATE note_revisions SET integrity = 'quarantined'
            WHERE id = (
              SELECT id FROM note_revisions
               WHERE space = ? AND integrity = 'trusted' AND entry_role <> 'baseline'
               ORDER BY id LIMIT 1
            )`,
        )
        .run(space)

      if (Number(changed.changes) !== 1) {
        throw new Error('Activity liveness invalidation did not change exactly one source row')
      }
    } finally {
      writer.close()
    }

    return
  }

  const pool = new pg.Pool({ connectionString: target })

  try {
    const changed = await pool.query(
      `UPDATE note_revisions SET integrity = 'quarantined'
        WHERE id = (
          SELECT id FROM note_revisions
           WHERE space = $1 AND integrity = 'trusted' AND entry_role <> 'baseline'
           ORDER BY id LIMIT 1
        )`,
      [space],
    )

    if (changed.rowCount !== 1) {
      throw new Error('Activity liveness invalidation did not change exactly one source row')
    }
  } finally {
    await pool.end()
  }
}

const rawActivityCardinality = async (): Promise<{ events: bigint; notes: number }> => {
  if (dialect === 'sqlite') {
    const inspected = new DatabaseSync(target, { readOnly: true })

    try {
      const row = inspected
        .prepare(
          `SELECT COUNT(*) AS events, COUNT(DISTINCT note_id) AS notes
             FROM note_revisions
            WHERE space = ? AND (integrity = 'quarantined' OR entry_role <> 'baseline')`,
        )
        .get(space) as { events: number | bigint; notes: number }

      return { events: BigInt(row.events), notes: Number(row.notes) }
    } finally {
      inspected.close()
    }
  }

  const pool = new pg.Pool({ connectionString: target })

  try {
    const result = await pool.query(
      `SELECT COUNT(*)::text AS events, COUNT(DISTINCT note_id)::int AS notes
         FROM note_revisions
        WHERE space = $1 AND (integrity = 'quarantined' OR entry_role <> 'baseline')`,
      [space],
    )
    return { events: BigInt(result.rows[0].events), notes: Number(result.rows[0].notes) }
  } finally {
    await pool.end()
  }
}

const foregroundRevision = (index: number): RevisionInput => ({
  noteId: `activity-gate-append-${index}`,
  space,
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  kind: 'external',
  entryRole: 'origin',
  principal: 'user:viewer',
  contentHash: null,
  title: `Activity gate append ${index}`,
  class: 'user-doc',
  slug: null,
  tags: [],
  createdAt: new Date(Date.UTC(2026, 7, 30, 18, 0, index)).toISOString(),
  charsAdded: null,
  charsRemoved: null,
})

const pointMs: number[] = []
const appendMs: number[] = []
const foregroundFailures: string[] = []
let pointActive = false
let appendActive = false
let appendIndex = 0
let pointTimer: ReturnType<typeof setInterval> | null = null
let appendTimer: ReturnType<typeof setInterval> | null = null

const pointProbe = async (phase: LivenessPhase): Promise<void> => {
  if (pointActive) {
    return
  }
  pointActive = true
  const started = performance.now()

  try {
    await db.revisions.get(space, '1')
    const elapsed = performance.now() - started

    pointMs.push(elapsed)
    phasePointMs.get(phase)?.push(elapsed)
  } catch (error) {
    foregroundFailures.push(`${phase}/point: ${(error as Error).message}`)
  } finally {
    pointActive = false
  }
}

const appendProbe = async (phase: LivenessPhase): Promise<void> => {
  if (appendActive) {
    return
  }
  appendActive = true
  const started = performance.now()

  try {
    await db.revisions.append(foregroundRevision(++appendIndex), null)
    const elapsed = performance.now() - started

    appendMs.push(elapsed)
    phaseAppendMs.get(phase)?.push(elapsed)
  } catch (error) {
    foregroundFailures.push(`${phase}/append: ${(error as Error).message}`)
  } finally {
    appendActive = false
  }
}

const startForeground = (): void => {
  if (!foreground || pointTimer || appendTimer) {
    return
  }
  pointTimer = setInterval(() => {
    if (activePhase) {
      void pointProbe(activePhase.phase)
    }
  }, 250)
  appendTimer = setInterval(() => {
    if (activePhase) {
      void appendProbe(activePhase.phase)
    }
  }, 1_000)
}

const stopForeground = async (): Promise<void> => {
  if (pointTimer) {
    clearInterval(pointTimer)
    pointTimer = null
  }
  if (appendTimer) {
    clearInterval(appendTimer)
    appendTimer = null
  }
  while (pointActive || appendActive) {
    await delay(5)
  }
}

const sampleForeground = async (): Promise<void> => {
  if (!foreground || !activePhase) {
    return
  }
  while (pointActive || appendActive) {
    await delay(5)
  }
  const phase = activePhase.phase

  await Promise.all([pointProbe(phase), appendProbe(phase)])
}

const beginPhase = async (phase: LivenessPhase): Promise<void> => {
  if (activePhase || observedPhases.some((observation) => observation.phase === phase)) {
    throw new Error(`Activity liveness phase cannot start twice or overlap: ${phase}`)
  }
  const observation: MutablePhaseObservation = {
    phase,
    startedAt: performance.now(),
    durationMs: 0,
    workUnits: 0,
    heartbeatSamples: 0,
    blocksOverOneSecond: 0,
    totalLatenessMs: 0,
    latenessMaxMs: 0,
    responseMaxMs: 0,
  }

  phasePointMs.set(phase, [])
  phaseAppendMs.set(phase, [])
  observedPhases.push(observation)
  activePhase = observation
  await sampleForeground()
}

const finishPhase = async (sampleAtEnd = true): Promise<void> => {
  if (!activePhase) {
    throw new Error('Activity liveness phase is not active')
  }
  if (sampleAtEnd) {
    await sampleForeground()
  }
  while (pointActive || appendActive) {
    await delay(5)
  }
  const heartbeatSamplesBeforeSettling = activePhase.heartbeatSamples
  const heartbeatDeadline = performance.now() + intervalMs * 4

  // Let the interval account for blocking in the last awaited unit before the
  // phase label changes. Otherwise its delayed tick would be charged to the
  // following phase and could hide the actual blocker.
  while (
    activePhase.heartbeatSamples === heartbeatSamplesBeforeSettling &&
    performance.now() < heartbeatDeadline
  ) {
    await waitTurn()
  }
  activePhase.durationMs = performance.now() - activePhase.startedAt
  activePhase = null
}

const recordPhaseUnit = (elapsed: number): void => {
  if (!activePhase) {
    throw new Error('Activity liveness work unit ran outside an observed phase')
  }
  activePhase.workUnits++
  activePhase.responseMaxMs = Math.max(activePhase.responseMaxMs, elapsed)
}

const observePhaseUnit = async <T>(operation: () => Promise<T>): Promise<T> => {
  const unitStarted = performance.now()

  try {
    return await operation()
  } finally {
    recordPhaseUnit(performance.now() - unitStarted)
  }
}

const started = performance.now()
let warmupBatchMs = 0
let warmupRows = 0
let rebuildBatches = 0
let rebuildRows = 0
let maxRebuildBatchMs = 0
let publicationMs = 0
let gcBatches = 0
let gcRows = 0
let maxGcBatchMs = 0
let completed = false
let gcFinishedMs = 0
let published = false
let restarted = false
let invalidationRecovered = false
let gcDrained = false
let referenceMatched = false
let readyReadMaxMs = 0
let readyReadLatenessMaxMs = 0

const recordRebuildStep = (
  step: {
    processed: number
    state: 'ready' | 'rebuilding'
    published: boolean
  },
  elapsed: number,
): void => {
  rebuildBatches++
  rebuildRows += step.processed
  maxRebuildBatchMs = Math.max(maxRebuildBatchMs, elapsed)
  recordPhaseUnit(elapsed)
  published ||= step.published
}

const drainNearPublication = async (): Promise<void> => {
  let turns = 0

  for (;;) {
    if (turns % 250 === 0) {
      const progress = await observePhaseUnit(projectionProgress)
      const remaining = progress.nextSourceOrdinal - progress.rebuildCursor

      if (progress.state === 'ready') {
        throw new Error('Activity liveness corpus published before invalidation proof')
      }
      if (remaining <= 5_000n) {
        return
      }
    }
    const batchStarted = performance.now()
    const step = await db.revisions.maintainActivityProjection(space)

    recordRebuildStep(step, performance.now() - batchStarted)
    if (step.state === 'ready') {
      throw new Error('Activity liveness corpus published before invalidation proof')
    }
    turns++
    if (turns > 500_000) {
      throw new Error('Activity rebuild did not approach publication within 500000 turns')
    }
  }
}

const drainRebuild = async (): Promise<void> => {
  for (let turns = 0; turns < 500_000; turns++) {
    const batchStarted = performance.now()
    const step = await db.revisions.maintainActivityProjection(space)

    recordRebuildStep(step, performance.now() - batchStarted)
    if (step.state === 'ready') {
      completed = true
      publicationMs = performance.now() - started
      return
    }
  }

  throw new Error('Activity rebuild did not converge within 500000 turns')
}

const drainGc = async (): Promise<void> => {
  for (let turns = 0; turns < 500_000; turns++) {
    const batchStarted = performance.now()
    const step = await db.revisions.maintainActivityProjectionGc(space)
    const elapsed = performance.now() - batchStarted

    gcBatches++
    gcRows += step.deleted
    maxGcBatchMs = Math.max(maxGcBatchMs, elapsed)
    recordPhaseUnit(elapsed)
    if (!step.pending) {
      gcDrained = true
      gcFinishedMs = performance.now() - started
      return
    }
  }

  throw new Error('Activity generation GC did not drain within 500000 turns')
}

const measureReadyReads = async (): Promise<void> => {
  const mine: AuthorFilter = {
    exact: ['ui', 'user:viewer'],
    prefixes: ['pat:viewer:', 'oauth:viewer:'],
  }
  const readyDurationMs = durationSeconds >= 90 ? 5_000 : 1_000
  const readOnce = () =>
    Promise.all([
      db.revisions.activityGroupsByNote(space, { viewerAuthor: mine }),
      db.revisions.activityGroupsByNote(space, { author: mine }),
      db.revisions.activityEvents(space, {
        offset: 0,
        limit: 12,
        viewerAuthor: mine,
      }),
    ])

  // Connection/worker startup is already reported by the cold latency cells.
  // This phase answers the user-visible steady ready-read/event-loop question.
  await observePhaseUnit(readOnce)
  const deadline = performance.now() + readyDurationMs

  while (performance.now() < deadline) {
    const readStarted = performance.now()

    await observePhaseUnit(readOnce)
    readyReadMaxMs = Math.max(readyReadMaxMs, performance.now() - readStarted)
    await delay(0)
  }
}

try {
  const prepared = await db.revisions.prepareActivityProjection(space)

  if (prepared.state !== 'rebuilding') {
    throw new Error(
      `Activity projection is ${prepared.state}; a deferred upgrade corpus is required`,
    )
  }
  // Worker/process startup is a separate cold fact. The 90-second liveness clock
  // measures steady bounded units, not module-loader latency.
  const warmupStarted = performance.now()
  const warmup = await db.revisions.maintainActivityProjection(space)
  warmupBatchMs = performance.now() - warmupStarted
  warmupRows = warmup.processed
  rebuildRows += warmup.processed
  completed = warmup.state === 'ready'
  if (completed) {
    publicationMs = performance.now() - started
  }

  startHeartbeat()
  startForeground()
  await beginPhase('paced-rebuild')
  const measuredStarted = performance.now()

  while (
    !completed &&
    (durationSeconds <= 0 || performance.now() - measuredStarted < durationSeconds * 1_000)
  ) {
    await waitTurn()
    const batchStarted = performance.now()
    const step = await db.revisions.maintainActivityProjection(space)
    const elapsed = performance.now() - batchStarted

    recordRebuildStep(step, elapsed)
    if (step.state === 'ready') {
      publicationMs = performance.now() - started
      completed = true
      break
    }
  }
  await finishPhase()
  if (completed) {
    throw new Error('Activity liveness corpus must remain rebuilding through the measured window')
  }

  await beginPhase('near-publication-invalidation')
  await drainNearPublication()
  await observePhaseUnit(invalidateSourceGeneration)
  const invalidated = await observePhaseUnit(() => db.revisions.prepareActivityProjection(space))

  if (invalidated.state !== 'rebuilding') {
    throw new Error('Activity source invalidation did not retire the near-complete generation')
  }
  invalidationRecovered = true
  await finishPhase()

  await beginPhase('restart')
  await stopForeground()
  const restartStarted = performance.now()

  await db.close()
  db = openDb()
  const resumed = await db.revisions.prepareActivityProjection(space)

  recordPhaseUnit(performance.now() - restartStarted)
  startForeground()

  if (resumed.state !== 'rebuilding') {
    throw new Error('Activity rebuild did not resume after the connection/worker restart')
  }
  restarted = true
  await finishPhase()

  await beginPhase('replacement-publication')
  await drainRebuild()
  await finishPhase()

  await beginPhase('generation-gc')
  await drainGc()
  await finishPhase()

  await beginPhase('ready-reads')
  await measureReadyReads()
  // Make the final foreground append part of the reference oracle instead of
  // claiming parity for a snapshot taken before the ready-phase mutation.
  await sampleForeground()
  await stopForeground()
  const groups = await observePhaseUnit(() => db.revisions.activityGroupsByNote(space, {}))
  const raw = await observePhaseUnit(rawActivityCardinality)
  const projectedEvents = groups.items.reduce((sum, group) => sum + BigInt(group.count), 0n)

  referenceMatched = groups.items.length === raw.notes && projectedEvents === raw.events
  if (!referenceMatched) {
    throw new Error(
      `Activity projection/reference mismatch: groups ${groups.items.length}/${raw.notes}, events ${projectedEvents}/${raw.events}`,
    )
  }
  const settled = await observePhaseUnit(projectionProgress)

  if (settled.state !== 'ready' || settled.activeGeneration == null) {
    throw new Error('Activity projection did not publish one active generation')
  }
  await finishPhase(false)
} finally {
  await stopForeground()
  stopHeartbeat()
  await db.close()
}

const cardinality: Record<string, number> = {}
let projectionBytes: number | null = null

if (dialect === 'sqlite') {
  const inspected = new DatabaseSync(target, { readOnly: true })

  try {
    for (const table of [
      'activity_projection_status',
      'activity_revision_order',
      'activity_note_actor_states',
      'activity_note_actor_heads',
      'activity_projection_gc',
    ]) {
      cardinality[table] = Number(
        (inspected.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      )
    }
    projectionBytes = Number(
      (
        inspected
          .prepare(
            "SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name LIKE 'activity_%'",
          )
          .get() as { bytes: number }
      ).bytes,
    )
  } finally {
    inspected.close()
  }
} else {
  const pool = new pg.Pool({ connectionString: target })

  try {
    for (const table of [
      'activity_projection_status',
      'activity_revision_order',
      'activity_note_actor_states',
      'activity_note_actor_heads',
      'activity_projection_gc',
    ]) {
      const result = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)
      cardinality[table] = Number(result.rows[0].n)
    }
    const size = await pool.query(
      `SELECT SUM(pg_total_relation_size(quote_ident(tablename)))::text AS bytes
         FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'activity_%'`,
    )
    projectionBytes = Number(size.rows[0].bytes ?? 0)
  } finally {
    await pool.end()
  }
}

const phaseObservations = observedPhases.map((observation) => ({
  phase: observation.phase,
  durationMs: observation.durationMs,
  workUnits: observation.workUnits,
  heartbeatSamples: observation.heartbeatSamples,
  blocksOverOneSecond: observation.blocksOverOneSecond,
  totalLatenessMs: observation.totalLatenessMs,
  latenessMaxMs: observation.latenessMaxMs,
  responseMaxMs: observation.responseMaxMs,
  foregroundPoint: stats(phasePointMs.get(observation.phase) ?? []),
  foregroundAppend: stats(phaseAppendMs.get(observation.phase) ?? []),
}))
const readyObservation = phaseObservations.find(({ phase }) => phase === 'ready-reads')

readyReadLatenessMaxMs = readyObservation?.latenessMaxMs ?? 0

const report = {
  dialect,
  target,
  space,
  intervalMs,
  durationSeconds,
  foreground,
  completed,
  published,
  restarted,
  invalidationRecovered,
  gcDrained,
  referenceMatched,
  warmupBatchMs,
  warmupRows,
  rebuildBatches,
  rebuildRows,
  rebuildMs: publicationMs,
  maxRebuildBatchMs,
  gcBatches,
  gcRows,
  gcMs: completed ? gcFinishedMs - publicationMs : 0,
  maxGcBatchMs,
  blocksOverOneSecond,
  totalLatenessMs,
  latenessMaxMs,
  readyReadMaxMs,
  readyReadLatenessMaxMs,
  foregroundPoint: stats(pointMs),
  foregroundAppend: stats(appendMs),
  foregroundFailures,
  phaseObservations,
  cardinality,
  projectionBytes,
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
