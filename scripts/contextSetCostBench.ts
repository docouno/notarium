import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { REQUEST_TIMING_HEADER } from '@notarium/contract'

import {
  contextSetCostBenchmarkGateFailures,
  type ContextSetCostBenchmarkReport,
  contextSetCostStats,
} from './contextSetCostBenchGates'

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8805').replace(/\/$/, '')
const USERNAME = process.env.BENCH_USER ?? 'admin'
const PASSWORD = process.env.BENCH_PASSWORD ?? 'admin'
const WARMUPS = Number(process.env.WARMUPS ?? 2)
const MEASURED = Number(process.env.MEASURED ?? 8)
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 10_000)
const HEARTBEAT_LAUNCH_DELAY_MS = 5
const HEARTBEAT_PULSE_CADENCE_MS = 5
const HEARTBEAT_MINIMUM_SAMPLES = 2
const phase = process.env.BENCH_PHASE ?? 'post'
const execFileAsync = promisify(execFile)

if (phase !== 'pre' && phase !== 'post') {
  throw new Error(`BENCH_PHASE must be pre or post, got ${phase}`)
}
const BENCH_PHASE = phase as 'pre' | 'post'
const BENCH_OUTPUT =
  process.env.BENCH_OUTPUT ?? join('test-results', 'context-set-cost-bench', `${phase}.json`)

const required = (name: 'BENCH_COMMIT' | 'BENCH_IMAGE' | 'BENCH_CONTAINER') => {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`${name} is required`)
  }

  return value
}
const BENCH_COMMIT = required('BENCH_COMMIT')
const BENCH_IMAGE = required('BENCH_IMAGE')
const BENCH_CONTAINER = required('BENCH_CONTAINER')

for (const [name, value, minimum] of [
  ['WARMUPS', WARMUPS, 0],
  ['MEASURED', MEASURED, 1],
  ['REQUEST_TIMEOUT_MS', REQUEST_TIMEOUT_MS, 1],
] as const) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`)
  }
}

type Inspect = {
  Config?: { Labels?: Record<string, string | undefined> }
  Image?: string
  State?: { Health?: { Status?: string }; Running?: boolean }
}
const inspect = JSON.parse(
  (
    await execFileAsync('docker', ['container', 'inspect', BENCH_CONTAINER], {
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout,
) as Inspect[]
const container = inspect[0]

if (!container?.State?.Running || container.State.Health?.Status !== 'healthy') {
  throw new Error(`benchmark container ${BENCH_CONTAINER} is not healthy`)
}
if (container.Image !== BENCH_IMAGE) {
  throw new Error('BENCH_IMAGE does not match the running container')
}

const login = await fetch(`${BASE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: USERNAME, password: PASSWORD }),
})

if (!login.ok) {
  throw new Error(`login failed: ${login.status}`)
}
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]

if (!cookie) {
  throw new Error('login did not set a cookie')
}

const fetchWithTimeout = async (path: string, init: RequestInit = {}) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    return await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        cookie,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    })
  } finally {
    clearTimeout(timeout)
  }
}

const request = async (path: string, init: RequestInit = {}) => {
  const response = await fetchWithTimeout(path, init)

  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
  }

  return response
}

const timed = async (run: () => Promise<unknown>) => {
  const started = performance.now()
  await run()
  return performance.now() - started
}

const measure = async (run: () => Promise<unknown>) => {
  for (let index = 0; index < WARMUPS; index += 1) {
    await run()
  }
  const values: number[] = []

  for (let index = 0; index < MEASURED; index += 1) {
    values.push(await timed(run))
  }

  return contextSetCostStats(values)
}

type HeartbeatSample = {
  ms: number
  status: number | null
  startedAt: number
  endedAt: number
  serverStartedAt: number
  serverEndedAt: number
}

/** Keep the liveness probe off the benchmark client's event loop. Otherwise a GC
 * pause while this process serializes the 1000-ref request/response is
 * indistinguishable from server starvation and produces a false gate failure. */
const startHeartbeatPulse = async (): Promise<{
  start(): Promise<void>
  stop(): Promise<HeartbeatSample[]>
}> => {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads')
      const { performance } = require('node:perf_hooks')

      const sample = async (announce = false) => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), workerData.timeoutMs)
        const started = performance.now()
        const startedAt = performance.timeOrigin + started

        try {
          const request = fetch(workerData.url, { signal: controller.signal })
          if (announce) parentPort.postMessage({ type: 'started' })
          const response = await request
          const serverStartedAt = Number(response.headers.get(workerData.startedHeader))
          const serverEndedAt = Number(response.headers.get(workerData.endedHeader))
          await response.arrayBuffer()
          return { ms: performance.now() - started, status: response.status, startedAt, endedAt: performance.timeOrigin + performance.now(), serverStartedAt, serverEndedAt }
        } catch {
          return { ms: performance.now() - started, status: null, startedAt, endedAt: performance.timeOrigin + performance.now(), serverStartedAt: Number.NaN, serverEndedAt: Number.NaN }
        } finally {
          clearTimeout(timeout)
        }
      }

      const run = async () => {
        // Warm Undici/DNS/socket setup before timing the server under load. The
        // first fetch in a fresh worker otherwise contributes ~50 ms of client
        // startup and is not an event-loop signal from the container.
        await sample()
        parentPort.postMessage({ type: 'ready' })
        const command = await new Promise((resolve) => parentPort.once('message', resolve))

        if (command !== 'start') {
          parentPort.postMessage({ type: 'done' })
          parentPort.close()
          return
        }
        let stopping = false
        let first = true
        let sampleCount = 0

        parentPort.on('message', (message) => {
          if (message === 'stop') stopping = true
        })
        do {
          parentPort.postMessage({ type: 'sample', sample: await sample(first) })
          first = false
          sampleCount += 1
          if (!stopping) {
            await new Promise((resolve) => setTimeout(resolve, workerData.cadenceMs))
          }
        } while (!stopping || sampleCount < workerData.minimumSamples)
        parentPort.postMessage({ type: 'done' })
        parentPort.close()
      }

      void run()
    `,
    {
      eval: true,
      workerData: {
        url: `${BASE_URL}/api/health`,
        timeoutMs: REQUEST_TIMEOUT_MS,
        cadenceMs: HEARTBEAT_PULSE_CADENCE_MS,
        minimumSamples: HEARTBEAT_MINIMUM_SAMPLES,
        startedHeader: REQUEST_TIMING_HEADER.STARTED_AT,
        endedHeader: REQUEST_TIMING_HEADER.ENDED_AT,
      },
    },
  )
  const samples: HeartbeatSample[] = []
  let readyResolve: (() => void) | undefined
  let startedResolve: (() => void) | undefined
  let doneResolve: (() => void) | undefined
  let readyReject: ((error: Error) => void) | undefined
  let startedReject: ((error: Error) => void) | undefined
  let doneReject: ((error: Error) => void) | undefined
  const ready = new Promise<void>((resolve, rejectPromise) => {
    readyResolve = resolve
    readyReject = rejectPromise
  })
  const done = new Promise<void>((resolve, rejectPromise) => {
    doneResolve = resolve
    doneReject = rejectPromise
  })
  const started = new Promise<void>((resolve, rejectPromise) => {
    startedResolve = resolve
    startedReject = rejectPromise
  })

  worker.on('message', (message: { type?: string; sample?: HeartbeatSample }) => {
    if (message.type === 'ready') {
      readyResolve?.()
    } else if (message.type === 'started') {
      startedResolve?.()
    } else if (message.type === 'sample' && message.sample) {
      samples.push(message.sample)
    } else if (message.type === 'done') {
      doneResolve?.()
    }
  })
  worker.on('error', (error) => {
    readyReject?.(error)
    startedReject?.(error)
    doneReject?.(error)
  })
  await ready
  let stopPromise: Promise<HeartbeatSample[]> | null = null

  return {
    start: async () => {
      worker.postMessage('start')
      await started
    },
    stop: async () => {
      stopPromise ??= (() => {
        worker.postMessage('stop')
        return done.then(() => samples)
      })()
      return stopPromise
    },
  }
}

const measureIdleHeartbeat = async () => {
  const run = async () => {
    const pulse = await startHeartbeatPulse()

    await pulse.start()
    const [sample] = await pulse.stop()

    if (!sample || sample.status !== 200) {
      throw new Error('idle heartbeat did not complete successfully')
    }

    return sample.ms
  }

  for (let index = 0; index < WARMUPS; index += 1) {
    await run()
  }
  const values: number[] = []

  for (let index = 0; index < MEASURED; index += 1) {
    values.push(await run())
  }

  return contextSetCostStats(values)
}

const about = (await request('/api/about').then((response) => response.json())) as {
  build: { builtAt: string | null; commit: string | null }
}
const labels = container.Config?.Labels ?? {}
const imageRevision = labels['org.opencontainers.image.revision']?.trim() ?? ''
const imageBuiltAt = labels['org.opencontainers.image.created']?.trim() ?? ''

if (about.build.commit !== BENCH_COMMIT || imageRevision !== BENCH_COMMIT) {
  throw new Error('runtime/OCI commit does not match BENCH_COMMIT')
}
if (!about.build.builtAt || about.build.builtAt !== imageBuiltAt) {
  throw new Error('runtime/OCI build time mismatch')
}

const projects = (await request('/api/s/context-cost-lab/projects').then((r) => r.json())) as {
  projects: Array<{ id: string; path: string }>
}
const project = projects.projects.find((candidate) => candidate.path === 'product')

if (!project) {
  throw new Error('context-sets-cost project "product" was not found')
}
const sets = (await request('/api/context-sets').then((r) => r.json())) as {
  sets: Array<{ id: string; name: string; homeSpace: string; items: Array<{ noteId: string }> }>
}
const heavy = sets.sets.find((set) => set.name === 'context-heavy-1000')
const bulkTarget = sets.sets.find((set) => set.name === 'context-bulk-target')

if (!heavy || heavy.items.length !== 1000 || !bulkTarget) {
  throw new Error('context-sets-cost heavy/bulk seed state is incomplete')
}
const projectPath = `/api/s/context-cost-lab/projects/${encodeURIComponent(project.id)}/agent-context`
const initialPreview = (await request(projectPath).then((r) => r.json())) as {
  pins: Array<{ noteId: string; loaded: boolean; order: number; tokens: number }>
  sets: Array<{
    id: string
    order: number
    items: Array<{ noteId: string; loaded: boolean; sourceIndex?: number; tokens: number }>
    itemsLoaded?: number
    itemsTotal?: number
    itemsCursor?: number
    trimmed?: boolean
  }>
}

const assertHeavyPreview = (preview: typeof initialPreview) => {
  const previewHeavy = preview.sets.find((set) => set.id === heavy.id)
  const pinsValid =
    preview.pins.length === 6 &&
    preview.pins.every(
      (pin, index) => pin.order === index && pin.tokens === 3_445 && pin.loaded === true,
    )

  if (!previewHeavy || !pinsValid) {
    throw new Error('context-sets-cost eager preview lost its attached heavy set or six pins')
  }
  if (
    BENCH_PHASE === 'post' &&
    (previewHeavy.itemsTotal !== 1_000 ||
      previewHeavy.itemsLoaded !== 32 ||
      previewHeavy.itemsCursor !== 33 ||
      previewHeavy.items.length !== 33 ||
      previewHeavy.trimmed !== true ||
      previewHeavy.items.some(
        (item, index) =>
          item.noteId !== heavy.items[index]?.noteId ||
          item.sourceIndex !== index ||
          item.tokens !== 530 ||
          item.loaded !== index < 32,
      ))
  ) {
    throw new Error('context-sets-cost post preview lost its exact 32/33 bounded prefix')
  }
}

const assertHeavyManager = (payload: typeof sets) => {
  const managed = payload.sets.find((set) => set.id === heavy.id)

  if (
    !managed ||
    managed.items.length !== 1000 ||
    managed.items.some((item, index) => item.noteId !== heavy.items[index]?.noteId)
  ) {
    throw new Error('context-sets-cost manager lost the heavy membership/order')
  }
}

assertHeavyPreview(initialPreview)
const dataRoot = createHash('sha256')
  .update(
    JSON.stringify({
      project: project.id,
      heavy: heavy.id,
      membership: heavy.items.map((item) => item.noteId),
      pins: initialPreview.pins.map((pin) => [pin.noteId, pin.order, pin.tokens, pin.loaded]),
      order: initialPreview.sets.map((set) => [set.id, set.order]),
    }),
  )
  .digest('hex')

const manager = await measure(async () => {
  const payload = (await request('/api/context-sets').then((response) => response.json())) as {
    sets: typeof sets.sets
  }

  assertHeavyManager(payload)
})
const reorder = await measure(async () => {
  const payload = (await request(
    `/api/s/context-cost-lab/context-sets/${encodeURIComponent(heavy.id)}/order`,
    {
      method: 'PUT',
      body: JSON.stringify({ noteIds: heavy.items.map((item) => item.noteId) }),
    },
  ).then((response) => response.json())) as { set: (typeof sets.sets)[number] }

  assertHeavyManager({ sets: [payload.set] })
})
assertHeavyManager(
  (await request('/api/context-sets').then((response) => response.json())) as typeof sets,
)
const eager = await measure(async () => {
  const preview = (await request(projectPath).then((response) =>
    response.json(),
  )) as typeof initialPreview

  assertHeavyPreview(preview)
})
const idleHeartbeat = await measureIdleHeartbeat()

const runBulk = async (keep: boolean) => {
  let pulse: Awaited<ReturnType<typeof startHeartbeatPulse>> | null = null
  let setId = ''
  let call: Promise<Response> | null = null
  let requestStartedAt = Number.NaN

  try {
    pulse = await startHeartbeatPulse()
    const created = (await request('/api/s/context-cost-lab/context-sets', {
      method: 'POST',
      body: JSON.stringify({ name: `bench-${Date.now()}-${Math.random()}` }),
    }).then((r) => r.json())) as { set: { id: string } }

    setId = created.set.id
    requestStartedAt = performance.timeOrigin + performance.now()
    call = fetchWithTimeout(
      `/api/s/context-cost-lab/context-sets/${encodeURIComponent(setId)}/add-many`,
      {
        method: 'POST',
        body: JSON.stringify({
          items: heavy.items.map((item) => ({ space: 'context-cost-lab', noteId: item.noteId })),
        }),
      },
    )
    // Give the already-dispatched bulk request one short network turn before the
    // independent worker launches health. The gate still decides from server-observed
    // intervals, so this improves sampling reliability without manufacturing overlap.
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_LAUNCH_DELAY_MS))
    await pulse.start()
    const response = await call

    call = null
    const requestEndedAt = performance.timeOrigin + performance.now()
    const serverStartedAt = Number(response.headers.get(REQUEST_TIMING_HEADER.STARTED_AT))
    const serverEndedAt = Number(response.headers.get(REQUEST_TIMING_HEADER.ENDED_AT))
    const beatsPromise = pulse.stop()
    const json = (await response.json()) as {
      added?: string[]
      failed?: unknown[]
      set?: { items?: Array<{ noteId?: string }> }
      error?: string
    }
    const beats = await beatsPromise
    const expectedIds = heavy.items.map((item) => item.noteId)
    const returnedIds = json.set?.items?.map((item) => item.noteId) ?? []
    const exactMembership =
      json.added?.length === expectedIds.length &&
      json.added.every((noteId, index) => noteId === expectedIds[index]) &&
      returnedIds.length === expectedIds.length &&
      returnedIds.every((noteId, index) => noteId === expectedIds[index])

    return {
      setId,
      status: response.status,
      added: json.added?.length ?? 0,
      failed: json.failed?.length ?? 0,
      items: json.set?.items?.length ?? 0,
      ms: requestEndedAt - requestStartedAt,
      requestStartedAt,
      requestEndedAt,
      serverStartedAt,
      serverEndedAt,
      heartbeat: beats,
      ...(json.error || !exactMembership
        ? { error: json.error ?? 'bulk membership/order did not match the requested fixture' }
        : {}),
    }
  } catch (error) {
    const requestEndedAt = performance.timeOrigin + performance.now()
    const beats = pulse ? await pulse.stop().catch(() => []) : []
    return {
      setId,
      status: null,
      added: 0,
      failed: 0,
      items: 0,
      ms: requestEndedAt - requestStartedAt,
      requestStartedAt,
      requestEndedAt,
      serverStartedAt: Number.NaN,
      serverEndedAt: Number.NaN,
      heartbeat: beats,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  } finally {
    await pulse?.stop().catch(() => {})
    if (call) {
      const pending = call

      call = null
      await pending.then((response) => response.arrayBuffer()).catch(() => {})
    }
    if (!keep && setId) {
      await request(`/api/s/context-cost-lab/context-sets/${encodeURIComponent(setId)}`, {
        method: 'DELETE',
      })
    }
  }
}

let bulk: ContextSetCostBenchmarkReport['bulk']

if (BENCH_PHASE === 'pre') {
  const absent = await fetchWithTimeout(
    `/api/s/context-cost-lab/context-sets/${encodeURIComponent(bulkTarget.id)}/add-many`,
    { method: 'POST', body: JSON.stringify({ items: [] }) },
  )
  bulk = { available: false, absentStatus: absent.status, samples: [] }
} else {
  for (let index = 0; index < WARMUPS; index += 1) {
    await runBulk(false)
  }
  const samples = []

  for (let index = 0; index < MEASURED; index += 1) {
    samples.push(await runBulk(false))
  }
  bulk = { available: true, samples }
}

const report: ContextSetCostBenchmarkReport = {
  phase: BENCH_PHASE,
  provenance: {
    commit: BENCH_COMMIT,
    builtAt: about.build.builtAt,
    image: BENCH_IMAGE,
    imageRevision,
    imageBuiltAt,
    container: BENCH_CONTAINER,
    dataRoot,
    baseUrl: BASE_URL,
  },
  measured: MEASURED,
  manager,
  reorder,
  eager,
  idleHeartbeat,
  bulk,
}
const baseline = process.env.BENCH_BASELINE
  ? (JSON.parse(
      await readFile(process.env.BENCH_BASELINE, 'utf8'),
    ) as ContextSetCostBenchmarkReport)
  : undefined
const failures = contextSetCostBenchmarkGateFailures(report, baseline)
report.gate = {
  baseline: process.env.BENCH_BASELINE ?? null,
  failures,
  passed: failures.length === 0,
}
await mkdir(dirname(BENCH_OUTPUT), { recursive: true })
await writeFile(BENCH_OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))

if (failures.length > 0) {
  process.exitCode = 1
}
