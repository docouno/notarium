import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  GRAPH_REVISION_NOTE_COUNT,
  GRAPH_REVISION_TARGET_TITLE,
} from '../test/cases/cases/graphRevision'
import { type GraphRevisionBenchReport, graphRevisionGateFailures } from './graphRevisionBenchGates'

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8806').replace(/\/$/, '')
const SPACE = 'graph-revision'
const OUTPUT =
  process.env.GRAPH_REVISION_OUTPUT ?? join('test-results', 'graph-revision', 'runtime.json')
const CHANNEL_TIMEOUT_MS = Number(process.env.GRAPH_REVISION_CHANNEL_TIMEOUT_MS ?? 600_000)
const ADJACENCY_OBSERVATION_TIMEOUT_MS = Number(
  process.env.GRAPH_REVISION_ADJACENCY_TIMEOUT_MS ?? 5_000,
)

type AdjacencyObservation = {
  generation: number
  totalNodes: number
  directedEdges: number
  source: string
  target: string
  hasEdge: boolean
}

const required = (
  name:
    | 'BENCH_COMMIT'
    | 'BENCH_IMAGE'
    | 'BENCH_IMAGE_REVISION'
    | 'BENCH_CONTAINER'
    | 'GRAPH_REVISION_CORPUS_REPORT'
    | 'GRAPH_REVISION_ADJACENCY_REPORT',
): string => {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`${name} is required for the graph revision gate`)
  }

  return value
}

const commit = required('BENCH_COMMIT')
const image = required('BENCH_IMAGE')
const imageRevision = required('BENCH_IMAGE_REVISION')
const containerName = required('BENCH_CONTAINER')
const corpusReport = required('GRAPH_REVISION_CORPUS_REPORT')
const adjacencyReport = required('GRAPH_REVISION_ADJACENCY_REPORT')

const readAdjacencyObservation = async (): Promise<AdjacencyObservation> =>
  JSON.parse(await readFile(adjacencyReport, 'utf8')) as AdjacencyObservation

const waitForAdjacencyObservation = async (
  accept: (observation: AdjacencyObservation) => boolean,
  timeoutMs = ADJACENCY_OBSERVATION_TIMEOUT_MS,
  trigger?: () => Promise<void>,
): Promise<AdjacencyObservation> => {
  const deadline = performance.now() + timeoutMs
  let last: AdjacencyObservation | undefined

  do {
    await trigger?.()
    try {
      last = await readAdjacencyObservation()
      if (accept(last)) {
        return last
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  } while (performance.now() < deadline)

  throw new Error(`adjacency observation did not converge: ${JSON.stringify(last ?? null)}`)
}

const login = await fetch(`${BASE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})

if (!login.ok) {
  throw new Error(`graph revision login failed: ${login.status} ${await login.text()}`)
}
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]

if (!cookie) {
  throw new Error('graph revision login did not return a session cookie')
}

const request = async (path: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
  }

  return response
}

const timed = async <T>(operation: () => Promise<T>): Promise<{ ms: number; value: T }> => {
  const started = performance.now()
  const value = await operation()

  return { ms: performance.now() - started, value }
}

const about = (await request('/api/about').then((response) => response.json())) as {
  build: { commit: string | null }
  search: { vector: boolean; graphBoost: boolean }
}

if (about.build.commit !== commit) {
  throw new Error(`runtime commit ${about.build.commit ?? 'null'} does not match ${commit}`)
}
if (!about.search.vector || !about.search.graphBoost) {
  throw new Error('graph revision stand requires search.vector=true and graphBoost=true')
}

type SyncStatus = { engine: { indexed?: number; vector?: { mode: string } } }
const waitForVectorChannel = async (): Promise<SyncStatus> => {
  const deadline = Date.now() + CHANNEL_TIMEOUT_MS
  let last: SyncStatus | undefined

  while (Date.now() < deadline) {
    last = (await request(`/api/s/${SPACE}/status`).then((response) =>
      response.json(),
    )) as SyncStatus
    if (
      last.engine.indexed === GRAPH_REVISION_NOTE_COUNT &&
      last.engine.vector?.mode === 'vector'
    ) {
      return last
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`graph revision vector channel did not become live: ${JSON.stringify(last)}`)
}
const status = await waitForVectorChannel()
const observedCorpus = JSON.parse(await readFile(corpusReport, 'utf8')) as {
  notes?: unknown
  bytes?: unknown
}

// Warm both independent consumers before the one-note revision. A query may
// honestly degrade to FTS while the model is still cold, so keep exercising the
// graph-enabled search path until it publishes its first adjacency or the
// channel-wide boot deadline expires.
await request(`/api/s/${SPACE}/graph/health`).then((response) => response.arrayBuffer())
const beforeAdjacency = await (async (): Promise<AdjacencyObservation> => {
  const deadline = performance.now() + CHANNEL_TIMEOUT_MS

  do {
    await request(`/api/s/${SPACE}/search?q=revision-query-marker`).then((response) =>
      response.arrayBuffer(),
    )
    try {
      return await readAdjacencyObservation()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (performance.now() < deadline)

  throw new Error('graph-enabled search did not publish its initial adjacency')
})()

if (beforeAdjacency.hasEdge) {
  throw new Error('graph completion edge must be absent before the adjacency mutation')
}

type NoteDetail = { id: string; title: string; content: string; versionToken: string }
const source = (await request(
  `/api/s/${SPACE}/note?ref=${encodeURIComponent('Graph Revision Source')}`,
).then((response) => response.json())) as NoteDetail

await request('/api/note', {
  method: 'POST',
  body: JSON.stringify({
    originalId: source.id,
    versionToken: source.versionToken,
    title: source.title,
    content: `${source.content}\n\n[[${GRAPH_REVISION_TARGET_TITLE}]]`,
  }),
})

let operationsDone = false
const heartbeat = (async () => {
  const intervalMs = 50
  let scheduled = performance.now()
  let samples = 0
  let blocksOverOneSecond = 0
  let totalLatenessMs = 0
  let maxResponseMs = 0

  while (!operationsDone || samples === 0) {
    scheduled += intervalMs
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, scheduled - performance.now())))
    const started = performance.now()
    await request('/api/health').then((response) => response.arrayBuffer())
    const finished = performance.now()
    const responseMs = finished - started
    const lateness = Math.max(0, finished - scheduled)
    samples++
    totalLatenessMs += lateness
    maxResponseMs = Math.max(maxResponseMs, responseMs)
    if (responseMs > 1_000 || lateness > 1_000) {
      blocksOverOneSecond++
    }
  }

  return { samples, blocksOverOneSecond, totalLatenessMs, maxResponseMs }
})()

const graphHealth = timed(() =>
  request(`/api/s/${SPACE}/graph/health`).then((response) => response.arrayBuffer()),
)
const unrelated = timed(() =>
  request(`/api/s/${SPACE}/note?ref=${encodeURIComponent('Graph corpus 1000')}`).then((response) =>
    response.arrayBuffer(),
  ),
)
const adjacencyRefresh = timed(async () => {
  // The request exercises the real graph-enabled production search path and
  // starts its stale-while-revalidate rebuild. Repeat while dirty because a
  // mutation racing an older single-flight deliberately needs the next query to
  // start its successor. Completion is proven privately by a later published
  // adjacency generation, never by rank-dependent results.
  return waitForAdjacencyObservation(
    (observation) => observation.generation > beforeAdjacency.generation && observation.hasEdge,
    ADJACENCY_OBSERVATION_TIMEOUT_MS,
    async () => {
      await request(`/api/s/${SPACE}/search?q=revision-query-marker`).then((response) =>
        response.arrayBuffer(),
      )
    },
  )
})

const [healthResult, adjacencyResult, unrelatedResult] = await Promise.all([
  graphHealth,
  adjacencyRefresh,
  unrelated,
]).finally(() => {
  operationsDone = true
})
const heartbeatResult = await heartbeat
const report: GraphRevisionBenchReport = {
  scenario: 'graph-revision-v2',
  provenance: { commit, image, imageRevision, container: containerName },
  capabilities: {
    vector: about.search.vector,
    graphBoost: about.search.graphBoost,
    vectorMode: status.engine.vector?.mode ?? 'missing',
  },
  corpus: {
    indexedNotes: status.engine.indexed ?? 0,
    observedNotes: Number(observedCorpus.notes),
    observedBytes: Number(observedCorpus.bytes),
  },
  mutation: {
    graphHealthMs: healthResult.ms,
    adjacencyRefreshMs: adjacencyResult.ms,
    unrelatedNoteMs: unrelatedResult.ms,
    adjacency: {
      source: adjacencyResult.value.source,
      target: adjacencyResult.value.target,
      beforeGeneration: beforeAdjacency.generation,
      afterGeneration: adjacencyResult.value.generation,
      beforeHasEdge: beforeAdjacency.hasEdge,
      afterHasEdge: adjacencyResult.value.hasEdge,
    },
    heartbeat: heartbeatResult,
  },
}
const failures = graphRevisionGateFailures(report)

await mkdir(dirname(OUTPUT), { recursive: true })
await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (failures.length) {
  throw new Error(`graph revision gates failed:\n${failures.join('\n')}`)
}
