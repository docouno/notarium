import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import type {
  ActivityNoteGroupCount,
  AuthorFilter,
  RevisionInput,
  RevisionPersistence,
} from '@notarium/core'
import { SqliteMetaDb } from '../packages/server/src/services/metaDb/sqliteMetaDb'
import {
  type ActivityProjectionSpikeDb,
  openActivityProjectionSpikeDb,
} from './activityProjectionWorkerSpike.local'

type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { message: string; reason?: string } }

type ActivityWorkerCall = {
  op: 'init' | 'prepare' | 'maintain' | 'gc' | 'groups' | 'get' | 'append' | 'close'
  space?: string
  author?: AuthorFilter
  viewerAuthor?: AuthorFilter
  revisionId?: string
  revision?: RevisionInput
}

class ActivityWorker {
  private sequence = 0
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly worker: Worker

  constructor(path: string, batchSize: number) {
    this.worker = new Worker(
      new URL('./activityProjectionWorkerSpike.worker.ts', import.meta.url),
      {
        execArgv: process.execArgv,
        workerData: { path, batchSize },
      },
    )
    this.worker.on('message', (reply: WorkerReply) => {
      const waiter = this.pending.get(reply.id)

      if (!waiter) {
        return
      }
      this.pending.delete(reply.id)
      if (reply.ok) {
        waiter.resolve(reply.value)
      } else {
        const error = new Error(reply.error.message) as Error & { reason?: string }
        error.reason = reply.error.reason
        waiter.reject(error)
      }
    })
    this.worker.on('error', (error) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(error)
      }
      this.pending.clear()
    })
  }

  call<T>(request: ActivityWorkerCall): Promise<T> {
    const id = ++this.sequence

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      this.worker.postMessage({ id, ...request })
    })
  }

  async close(): Promise<void> {
    await this.call({ op: 'close' })
    await this.worker.terminate()
  }
}

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=')
    return [key!, value.join('=')]
  }),
)
const source = args.get('source')
const output = args.get('output')
const durationSeconds = Number(args.get('duration-seconds') ?? 30)
const workerBatchSize = Number(args.get('worker-batch-size') ?? 25)
const livenessOnly = args.get('liveness-only') === 'true'
const space = args.get('space') ?? 'activity-groups'

if (
  !source ||
  !output ||
  !Number.isFinite(durationSeconds) ||
  durationSeconds <= 0 ||
  !Number.isInteger(workerBatchSize) ||
  workerBatchSize <= 0
) {
  throw new Error(
    'usage: --source=<deferred sqlite db> --output=<directory> [--duration-seconds=30]',
  )
}

mkdirSync(output, { recursive: true })
const samePath = join(output, 'same-thread.sqlite')
const workerPath = join(output, 'worker.sqlite')
copyFileSync(source, samePath)
copyFileSync(source, workerPath)

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

const heartbeatOf = () => {
  const intervalMs = 50
  let previous = performance.now()
  let totalLatenessMs = 0
  let latenessMaxMs = 0
  let blocksOverOneSecond = 0
  const timer = setInterval(() => {
    const now = performance.now()
    const lateness = Math.max(0, now - previous - intervalMs)

    totalLatenessMs += lateness
    latenessMaxMs = Math.max(latenessMaxMs, lateness)
    if (lateness > 1_000) {
      blocksOverOneSecond++
    }
    previous = now
  }, intervalMs)

  return () => {
    clearInterval(timer)
    return { intervalMs, totalLatenessMs, latenessMaxMs, blocksOverOneSecond }
  }
}

const revision = (index: number): RevisionInput => ({
  noteId: `spike-append-${index}`,
  space,
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  kind: 'external',
  entryRole: 'origin',
  principal: 'user:viewer',
  contentHash: null,
  title: `Spike append ${index}`,
  class: 'user-doc',
  slug: null,
  tags: [],
  createdAt: new Date(Date.UTC(2026, 7, 30, 15, 0, index)).toISOString(),
  charsAdded: null,
  charsRemoved: null,
})

const startForegroundLoad = (db: { revisions: Pick<RevisionPersistence, 'get' | 'append'> }) => {
  const pointMs: number[] = []
  const appendMs: number[] = []
  let appendIndex = 0
  let pointActive = false
  let appendActive = false
  const pointTimer = setInterval(() => {
    if (pointActive) {
      return
    }
    pointActive = true
    const started = performance.now()
    void db.revisions
      .get(space, '1')
      .then(() => pointMs.push(performance.now() - started))
      .finally(() => (pointActive = false))
  }, 250)
  const appendTimer = setInterval(() => {
    if (appendActive) {
      return
    }
    appendActive = true
    const started = performance.now()
    void db.revisions
      .append(revision(++appendIndex), null)
      .then(() => appendMs.push(performance.now() - started))
      .finally(() => (appendActive = false))
  }, 1_000)

  return async () => {
    clearInterval(pointTimer)
    clearInterval(appendTimer)
    while (pointActive || appendActive) {
      await delay(10)
    }

    return { point: stats(pointMs), append: stats(appendMs), appends: appendIndex }
  }
}

type MaintenanceStep = { state: 'ready' | 'rebuilding'; processed: number; published: boolean }

const sameThreadControl = async () => {
  const db = openActivityProjectionSpikeDb(samePath, 25)
  await db.revisions.init()
  const prepared = await db.revisions.prepareActivityProjection(space)

  if (prepared.state !== 'rebuilding') {
    throw new Error('same-thread control requires a deferred rebuild')
  }
  const stopHeartbeat = heartbeatOf()
  const stopForeground = startForegroundLoad(db)
  const batches: number[] = []
  let rows = 0
  const started = performance.now()

  while (performance.now() - started < durationSeconds * 1_000) {
    await delay(50)
    const batchStarted = performance.now()
    const step = await db.revisions.maintainActivityProjection(space)
    batches.push(performance.now() - batchStarted)
    rows += step.processed
    if (step.state === 'ready') {
      break
    }
  }
  const foreground = await stopForeground()
  const heartbeat = stopHeartbeat()
  await db.close()
  return { rows, batches: stats(batches), foreground, heartbeat }
}

const workerProbe = async () => {
  const db = new SqliteMetaDb(workerPath)
  const worker = new ActivityWorker(workerPath, workerBatchSize)
  await db.revisions.init()
  await worker.call({ op: 'init' })
  const prepared = await worker.call<{ state: 'ready' | 'rebuilding' }>({
    op: 'prepare',
    space,
  })

  if (prepared.state !== 'rebuilding') {
    throw new Error('worker probe requires a deferred rebuild')
  }
  const stopHeartbeat = heartbeatOf()
  const stopForeground = startForegroundLoad(db)
  const batches: number[] = []
  let rows = 0
  const started = performance.now()
  let completed = false

  while (performance.now() - started < durationSeconds * 1_000) {
    await delay(50)
    const batchStarted = performance.now()
    const step = await worker.call<MaintenanceStep>({ op: 'maintain', space })
    batches.push(performance.now() - batchStarted)
    rows += step.processed
    if (step.state === 'ready') {
      completed = true
      break
    }
  }
  const foreground = await stopForeground()
  const heartbeat = stopHeartbeat()
  let convergenceBatches = batches.length

  while (!completed && !livenessOnly) {
    await delay(50)
    const step = await worker.call<MaintenanceStep>({ op: 'maintain', space })
    rows += step.processed
    convergenceBatches++
    completed = step.state === 'ready'
    if (convergenceBatches % 1_000 === 0) {
      console.log(`worker rebuild: ${rows} source rows`)
    }
  }
  if (completed) {
    for (;;) {
      const gc = await worker.call<{ pending: boolean }>({ op: 'gc', space })

      if (!gc.pending) {
        break
      }
      await delay(50)
    }
  }
  const convergenceMs = performance.now() - started

  return {
    db,
    worker,
    rows,
    batches: stats(batches),
    foreground,
    heartbeat,
    convergenceMs,
    completed,
  }
}

const locationOf = (noteId: string): string => {
  const index = Number(noteId.slice('note-'.length))
  return Number.isFinite(index) ? `folder-${String(index % 1_280).padStart(5, '0')}` : 'root'
}

const shape = (items: readonly ActivityNoteGroupCount[], by: 'note' | 'folder'): number => {
  if (by === 'note') {
    return [...items]
      .sort((left, right) => {
        const a = BigInt(left.lastSourceOrdinal)
        const b = BigInt(right.lastSourceOrdinal)
        return a === b ? left.noteId.localeCompare(right.noteId) : a > b ? -1 : 1
      })
      .slice(0, 12).length
  }
  const folders = new Map<string, bigint>()

  for (const note of items) {
    const key = locationOf(note.noteId)
    folders.set(key, (folders.get(key) ?? 0n) + BigInt(note.count))
  }

  return [...folders].sort(([left], [right]) => left.localeCompare(right)).slice(0, 12).length
}

const readySamples = async (
  load: (author?: AuthorFilter) => Promise<{ items: ActivityNoteGroupCount[] }>,
) => {
  const mine: AuthorFilter = { exact: ['user:viewer'], prefixes: ['pat:viewer:'] }
  const cells = []

  for (const by of ['note', 'folder'] as const) {
    for (const scope of ['all', 'mine'] as const) {
      const values: number[] = []
      let groups = 0

      for (let index = 0; index < 12; index++) {
        const started = performance.now()
        const result = await load(scope === 'mine' ? mine : undefined)
        shape(result.items, by)
        values.push(performance.now() - started)
        groups = result.items.length
      }
      cells.push({ by, scope, groups, latency: stats(values) })
    }
  }

  return cells
}

const same = await sameThreadControl()
const workerResult = await workerProbe()

if (livenessOnly) {
  await workerResult.worker.close()
  await workerResult.db.close()
  const report = {
    scenario: 'activity-projection-worker-spike-v1',
    source,
    durationSeconds,
    workerBatchSize,
    livenessOnly,
    sameThread: same,
    worker: {
      rows: workerResult.rows,
      batches: workerResult.batches,
      foreground: workerResult.foreground,
      heartbeat: workerResult.heartbeat,
      completed: workerResult.completed,
    },
  }
  const reportPath = join(output, 'report.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}
const workerHeartbeatStop = heartbeatOf()
const workerReady = await readySamples((author) =>
  workerResult.worker.call({
    op: 'groups',
    space,
    author,
    viewerAuthor: author ? undefined : { exact: ['user:viewer'], prefixes: ['pat:viewer:'] },
  }),
)
const workerReadyHeartbeat = workerHeartbeatStop()
await workerResult.worker.close()
await workerResult.db.close()

const readyDb: ActivityProjectionSpikeDb = openActivityProjectionSpikeDb(workerPath, 25)
await readyDb.revisions.init()
const sameReadyHeartbeatStop = heartbeatOf()
const sameReady = await readySamples((author) =>
  readyDb.revisions.activityGroupsByNote(space, {
    author,
    viewerAuthor: author ? undefined : { exact: ['user:viewer'], prefixes: ['pat:viewer:'] },
  }),
)
const sameReadyHeartbeat = sameReadyHeartbeatStop()
await readyDb.close()

const report = {
  scenario: 'activity-projection-worker-spike-v1',
  source,
  durationSeconds,
  workerBatchSize,
  sameThread: same,
  worker: {
    rows: workerResult.rows,
    batches: workerResult.batches,
    foreground: workerResult.foreground,
    heartbeat: workerResult.heartbeat,
    convergenceMs: workerResult.convergenceMs,
  },
  ready: {
    sameThread: sameReady,
    sameThreadHeartbeat: sameReadyHeartbeat,
    worker: workerReady,
    workerHeartbeat: workerReadyHeartbeat,
  },
}

const reportPath = join(output, 'report.json')
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
