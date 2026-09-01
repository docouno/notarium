import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import pg from 'pg'
import type { RevisionInput } from '@notarium/core'

import { PgMetaDb } from '../packages/server/src/services/metaDb/pgMetaDb'
import { nearestRank } from './activityGroupsBenchGates'

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=')
    return [key!, value.join('=')]
  }),
)
const target = args.get('target')
const output = args.get('output')
const writes = Number(args.get('writes') ?? 128)
const concurrency = Number(args.get('concurrency') ?? 10)

if (!target || !output || !Number.isInteger(writes) || !Number.isInteger(concurrency)) {
  throw new Error('usage: --target=<postgres url> --output=<json> [--writes=128 --concurrency=10]')
}
if (writes < 2 || concurrency < 2 || concurrency > writes) {
  throw new Error('PostgreSQL producer contention needs writes >= concurrency >= 2')
}

const applicationName = `notarium-activity-producer-${process.pid}`
const writerUrl = new URL(target)
writerUrl.searchParams.set('application_name', applicationName)
const db = new PgMetaDb(writerUrl.toString())
const observer = new pg.Pool({ connectionString: target, max: 1 })

const projection = await db.revisions.prepareActivityProjection('activity-groups')

if (projection.state !== 'ready') {
  throw new Error('PostgreSQL contention proof requires a fresh-ready Activity projection')
}

const activityCounts = async () => {
  const result = await observer.query(`SELECT
    (SELECT COUNT(*)::int FROM note_revisions WHERE space = 'activity-groups') AS source_rows,
    (SELECT COUNT(*)::int FROM activity_revision_order WHERE space = 'activity-groups') AS order_rows,
    (SELECT COUNT(*)::int FROM activity_note_actor_states WHERE space = 'activity-groups') AS state_rows,
    (SELECT COUNT(*)::int FROM activity_note_actor_heads WHERE space = 'activity-groups') AS head_rows`)
  const row = result.rows[0] as Record<string, number>

  return {
    sourceRows: Number(row.source_rows),
    orderRows: Number(row.order_rows),
    stateRows: Number(row.state_rows),
    headRows: Number(row.head_rows),
  }
}

const before = await activityCounts()
let sampling = true
let samples = 0
let activeSamples = 0
let waitingSamples = 0
let lockWaitingSamples = 0
let maxActive = 0
let maxWaiting = 0
const waitEvents: Record<string, number> = {}

const sampler = (async () => {
  while (sampling) {
    const result = await observer.query(
      `SELECT wait_event_type, wait_event
         FROM pg_stat_activity
        WHERE application_name = $1 AND state = 'active'`,
      [applicationName],
    )
    samples++
    maxActive = Math.max(maxActive, result.rows.length)
    activeSamples += result.rows.length
    const waiting = result.rows.filter(({ wait_event_type }) => wait_event_type != null)
    const lockWaiting = waiting.filter(({ wait_event_type }) => wait_event_type === 'Lock')
    waitingSamples += waiting.length
    lockWaitingSamples += lockWaiting.length
    maxWaiting = Math.max(maxWaiting, waiting.length)

    for (const row of waiting) {
      const key = `${row.wait_event_type}:${row.wait_event}`
      waitEvents[key] = (waitEvents[key] ?? 0) + 1
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
})()

let next = 0
let inFlight = 0
let maxInFlight = 0
const latencies: number[] = []
const started = performance.now()

const worker = async () => {
  for (;;) {
    const index = next++

    if (index >= writes) {
      return
    }
    const noteId = `producer-contention-${process.pid}-${String(index).padStart(6, '0')}`
    const revision: RevisionInput = {
      noteId,
      space: 'activity-groups',
      baseRevisionId: null,
      theirRevisionId: null,
      sourceRevisionId: null,
      kind: 'write',
      entryRole: 'origin',
      principal: index % 2 === 0 ? 'user:viewer' : 'user:other',
      contentHash: null,
      stateFormat: null,
      title: noteId,
      class: 'user-doc',
      slug: null,
      tags: [],
      createdAt: new Date(Date.UTC(2026, 7, 30) + index).toISOString(),
      charsAdded: 1,
      charsRemoved: 0,
    }
    const appendStarted = performance.now()

    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await db.revisions.append(revision, null)
      latencies.push(performance.now() - appendStarted)
    } finally {
      inFlight--
    }
  }
}

try {
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
} finally {
  sampling = false
  await sampler
}
const elapsedMs = performance.now() - started
const after = await activityCounts()
const delta = {
  sourceRows: after.sourceRows - before.sourceRows,
  orderRows: after.orderRows - before.orderRows,
  stateRows: after.stateRows - before.stateRows,
  headRows: after.headRows - before.headRows,
}

if (
  latencies.length !== writes ||
  maxInFlight < 2 ||
  delta.sourceRows !== writes ||
  delta.orderRows !== writes ||
  delta.stateRows !== writes ||
  delta.headRows !== writes
) {
  throw new Error(`PostgreSQL producer contention proof was incomplete: ${JSON.stringify(delta)}`)
}

const report = {
  writes,
  concurrency,
  elapsedMs,
  throughputPerSecond: (writes * 1_000) / elapsedMs,
  appendLatencyMs: {
    median: nearestRank(latencies, 0.5),
    p95: nearestRank(latencies, 0.95),
    max: Math.max(...latencies),
  },
  overlap: { maxInFlight },
  postgresWaits: {
    samples,
    activeSamples,
    waitingSamples,
    lockWaitingSamples,
    maxActive,
    maxWaiting,
    waitEvents,
  },
  rowAmplification: {
    ...delta,
    auxiliaryRows: delta.orderRows + delta.stateRows + delta.headRows,
    auxiliaryRowsPerSource: (delta.orderRows + delta.stateRows + delta.headRows) / delta.sourceRows,
  },
}

await db.close()
await observer.end()
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(
  `postgres producer contention: ${writes} writes, p95=${report.appendLatencyMs.p95.toFixed(1)}ms, lock-wait-observations=${lockWaitingSamples}`,
)
