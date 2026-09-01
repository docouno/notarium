import Fastify from 'fastify'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

import { AUTHOR_KIND } from '@notarium/contract'
import { CachedStore } from '@notarium/core'
import { InMemoryStore, type StoreSnapshot } from '@notarium/engine-memory'
import { encodeActivityVersion } from '../packages/core/src/revisionJournal/helpers'
import type { ApiRouteCtx } from '../packages/server/src/apps/server/routes/_shared'
import { activityRoutes } from '../packages/server/src/apps/server/routes/activity/activity'
import { PgMetaDb } from '../packages/server/src/services/metaDb/pgMetaDb'
import { SqliteMetaDb } from '../packages/server/src/services/metaDb/sqliteMetaDb'
import type { ActivityGroupsManifest } from './activityGroupsBenchGates'

type Variant = 'base' | 'revision-10x' | 'breadth-10x'
type GroupBy = 'note' | 'folder'
type Scope = 'all' | 'mine'

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=')
    return [key!, value.join('=')]
  }),
)
const dialect = args.get('dialect') as 'sqlite' | 'postgres'
const variant = args.get('variant') as Variant
const target = args.get('target')
const output = args.get('output')
const samples = Number(args.get('samples') ?? 20)
const requestedBy = args.get('by') as GroupBy | undefined
const requestedScope = args.get('scope') as Scope | undefined
const cut = (args.get('cut') ?? 'current') as 'current' | 'historical'
const sqliteWorkerEntry = args.get('sqlite-worker-entry')
const manifest = JSON.parse(
  readFileSync(args.get('manifest') ?? 'test/cases/manifests/activity-groups-v1.json', 'utf8'),
) as ActivityGroupsManifest
const HEARTBEAT_INTERVAL_MS = 50
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const startProductionHeartbeat = () => {
  let previous = performance.now()
  let productionTurns = 0
  let timerActiveTurns = 0
  let heartbeatSamples = 0
  let blocksOverOneSecond = 0
  let totalLatenessMs = 0
  let latenessMaxMs = 0
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    const now = performance.now()
    const lateness = Math.max(0, now - previous - HEARTBEAT_INTERVAL_MS)

    heartbeatSamples++
    totalLatenessMs += lateness
    latenessMaxMs = Math.max(latenessMaxMs, lateness)
    if (lateness > 1_000) {
      blocksOverOneSecond++
    }
    previous = now
  }, HEARTBEAT_INTERVAL_MS)

  return {
    measure: async <T>(turn: () => Promise<T>): Promise<T> => {
      if (timer === null) {
        throw new Error('production heartbeat timer is not active')
      }
      productionTurns++
      timerActiveTurns++
      return turn()
    },
    stop: async () => {
      if (timer === null) {
        throw new Error('production heartbeat timer stopped before measurement completed')
      }
      // Charge a synchronous tail in the final route/churn turn before stopping.
      await delay(HEARTBEAT_INTERVAL_MS * 2)
      clearInterval(timer)
      timer = null
      return {
        productionTurns,
        timerActiveTurns,
        heartbeatSamples,
        blocksOverOneSecond,
        totalLatenessMs,
        latenessMaxMs,
      }
    },
  }
}

if (
  !target ||
  !output ||
  (requestedBy != null && !['note', 'folder'].includes(requestedBy)) ||
  (requestedScope != null && !['all', 'mine'].includes(requestedScope)) ||
  !['current', 'historical'].includes(cut) ||
  !manifest.variants[variant] ||
  !['sqlite', 'postgres'].includes(dialect)
) {
  throw new Error(
    'usage: --dialect=sqlite|postgres --variant=<variant> --target=<db path/url> --output=<json>',
  )
}

const db =
  dialect === 'sqlite'
    ? new SqliteMetaDb(target, {
        ...(sqliteWorkerEntry
          ? { activityWorkerEntry: pathToFileURL(resolve(sqliteWorkerEntry)) }
          : {}),
      })
    : new PgMetaDb(target)
await db.revisions.init()
const shape = manifest.variants[variant]
const preparation = await db.revisions.prepareActivityProjection('activity-groups')

if (preparation.state !== 'ready' || preparation.lease.through == null) {
  throw new Error('Activity groups latency corpus must be ready and non-empty')
}

/** The latency corpus has a real live-index twin. Missing active ids deliberately
 * become the production `unavailable` location; extra live notes prove that the
 * projection join is by stable id rather than by two arrays' positions. */
const snapshotOf = (): StoreSnapshot => {
  const notes: StoreSnapshot['notes'] = []
  const unavailableStart = Math.ceil((shape.activeNotes * manifest.locations.rootPercent) / 100)
  const unavailableEnd = Math.ceil(
    (shape.activeNotes * (manifest.locations.rootPercent + manifest.locations.unavailablePercent)) /
      100,
  )

  for (let index = 0; index < shape.activeNotes; index++) {
    if (index >= unavailableStart && index < unavailableEnd) {
      continue
    }
    const basename = `note-${String(index).padStart(6, '0')}.md`
    const root = index < unavailableStart
    const folder = `folder-${String(index % shape.folders).padStart(5, '0')}`

    notes.push({
      id: basename.slice(0, -3),
      title: `Current note ${index}`,
      filePath: root ? basename : `${folder}/${basename}`,
      content: '',
      modifiedAt: '2026-08-30T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
    })
  }

  for (let index = notes.length; index < shape.liveNotes; index++) {
    const id = `live-only-${String(index).padStart(6, '0')}`
    notes.push({
      id,
      title: `Live only ${index}`,
      filePath: `live-only-${String(index % shape.folders).padStart(5, '0')}/${id}.md`,
      content: '',
      modifiedAt: '2026-08-30T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
    })
  }

  return { space: 'activity-groups', now: '2026-08-30T00:00:00.000Z', notes }
}

const inner = new InMemoryStore(snapshotOf())
let releaseBackground!: () => void
let backgroundHeld = true
const backgroundHold = new Promise<void>((resolveHold) => {
  releaseBackground = () => {
    backgroundHeld = false
    resolveHold()
  }
})
const scheduler = {
  awaitTurn: async (signal?: AbortSignal): Promise<void> => {
    if (!backgroundHeld) {
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
      return
    }
    if (signal?.aborted) {
      return
    }
    await Promise.race([
      backgroundHold,
      new Promise<void>((resolveAbort) =>
        signal?.addEventListener('abort', () => resolveAbort(), { once: true }),
      ),
    ])
  },
  enterInteractive: () => undefined,
  exitInteractive: () => undefined,
}
const store = new CachedStore({
  inner,
  revisionPersistence: db.revisions,
  space: 'activity-groups',
  pollIntervalMs: 0,
  scheduler,
})
await store.start()

const app = Fastify({ logger: false })
app.decorateRequest('principal', null)
app.decorateRequest('spaceId', '')
app.addHook('onRequest', async (request) => {
  request.principal = {
    id: 'user:viewer',
    username: 'viewer',
    admin: true,
    scope: 'manage',
    grants: new Map([['activity-groups', 'owner']]),
    spaces: null,
    system: false,
  }
  request.spaceId = 'activity-groups'
})
await activityRoutes(app, {
  spaceStoreFor: async () => store,
  auth: {
    describeAuthor: async (principal: string | null, viewer: string | null) => ({
      kind:
        principal == null
          ? AUTHOR_KIND.external
          : principal.startsWith('pat:')
            ? AUTHOR_KIND.agent
            : principal === 'ui'
              ? AUTHOR_KIND.system
              : AUTHOR_KIND.user,
      name: principal?.replace(/^user:/, '') ?? null,
      mine:
        principal === 'ui' ||
        principal === `user:${viewer}` ||
        (viewer != null && principal?.startsWith(`pat:${viewer}:`) === true),
    }),
  },
} as unknown as ApiRouteCtx)
await app.ready()

type WireResult = {
  items: unknown[]
  total: number
  through: string
  activityVersion: string
  locationThrough: string
  scopeGate?: { hasOtherAuthors: boolean }
}

const inject = async (
  by: GroupBy,
  scope: Scope,
  snapshot?: { through: string; activityVersion: string },
): Promise<{ body: WireResult; retainedBytes: number }> => {
  const query = new URLSearchParams({ by, limit: '12' })

  if (scope === 'mine') {
    query.set('author', 'mine')
  }
  if (snapshot) {
    query.set('through', snapshot.through)
    query.set('activityVersion', snapshot.activityVersion)
  }
  const response = await app.inject({
    method: 'GET',
    url: `/api/s/activity-groups/activity/groups?${query.toString()}`,
  })

  if (response.statusCode !== 200) {
    throw new Error(
      `Activity groups production route returned ${response.statusCode}: ${response.body}`,
    )
  }

  return {
    body: JSON.parse(response.body) as WireResult,
    retainedBytes: Buffer.byteLength(response.rawPayload),
  }
}

const requestedSnapshot =
  cut === 'historical'
    ? {
        through: String(Math.max(1, Math.floor(shape.revisions / 2))),
        activityVersion: encodeActivityVersion('activity-groups', preparation.lease),
      }
    : undefined

const sample = async (by: GroupBy, scope: Scope) => {
  const started = performance.now()
  const result = await inject(by, scope, requestedSnapshot)
  const elapsedMs = performance.now() - started

  return {
    elapsedMs,
    groups: result.body.total,
    responseItems: result.body.items.length,
    retainedBytes: result.retainedBytes,
    through: result.body.through,
    hasOtherAuthors: result.body.scopeGate?.hasOtherAuthors,
    locationThrough: result.body.locationThrough,
  }
}

/** Move through the real engine's external-change boundary, let CachedStore
 * reconcile its snapshot/version, and serve the next response through Fastify.
 * The result measures the user-visible location-churn turn, not a benchmark-only
 * map rewrite. */
let locationChurnSequence = 0

const sampleLocationChurn = async (by: GroupBy, scope: Scope) => {
  const noteId = 'note-000000'
  const destinationPath = `location-churn/${by}-${scope}-${locationChurnSequence++}/${noteId}.md`
  const started = performance.now()

  await inner.move({ id: noteId, destinationPath, identityOnly: true })
  await store.reconcile()
  const result = await inject(by, scope)

  return {
    elapsedMs: performance.now() - started,
    responseItems: result.body.items.length,
    through: result.body.through,
    locationThrough: result.body.locationThrough,
  }
}

const cells = []
const byValues = requestedBy ? [requestedBy] : (['note', 'folder'] as const)
const scopeValues = requestedScope ? [requestedScope] : (['all', 'mine'] as const)

try {
  for (const by of byValues) {
    for (const scope of scopeValues) {
      const productionHeartbeatMeasure = startProductionHeartbeat()
      const cold = await productionHeartbeatMeasure.measure(() => sample(by, scope))
      releaseBackground()

      for (let warmup = 0; warmup < 3; warmup++) {
        await productionHeartbeatMeasure.measure(() => sample(by, scope))
      }
      const warm = []

      for (let index = 0; index < samples; index++) {
        warm.push(await productionHeartbeatMeasure.measure(() => sample(by, scope)))
      }
      const locationChurn =
        cut === 'current'
          ? await productionHeartbeatMeasure.measure(() => sampleLocationChurn(by, scope))
          : undefined
      const productionHeartbeat = await productionHeartbeatMeasure.stop()

      cells.push({ by, scope, cold, warm, locationChurn, productionHeartbeat })
    }
  }
} finally {
  releaseBackground()
  await app.close()
  store.stop()
  await store.settle()
  await db.close()
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(
  output,
  `${JSON.stringify(
    {
      dialect,
      variant,
      cut,
      samples,
      consumerPath: ['fastify-rest-wire', 'cached-store', 'history-surface', 'revision-journal'],
      coldProtocol: 'background-maintenance-held-until-after-cold',
      cells,
    },
    null,
    2,
  )}\n`,
)
console.log(
  cells
    .map(
      (cell) =>
        `${cut}/${cell.by}/${cell.scope}: cold=${cell.cold.elapsedMs.toFixed(1)}ms warm-max=${Math.max(...cell.warm.map((entry) => entry.elapsedMs)).toFixed(1)}ms${cell.locationChurn ? ` churn=${cell.locationChurn.elapsedMs.toFixed(1)}ms` : ''}`,
    )
    .join('\n'),
)
