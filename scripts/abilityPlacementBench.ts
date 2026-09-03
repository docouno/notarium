import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { REQUEST_TIMING_HEADER } from '@notarium/contract'
import { encodeAbilityLocator } from '@notarium/core'

import {
  abilityPlacementBenchmarkGateFailures,
  type AbilityPlacementBenchmarkReport,
  type AbilityPlacementHeartbeat,
  abilityPlacementStats,
} from './abilityPlacementBenchGates'

const execFileAsync = promisify(execFile)
const phase = process.env.BENCH_PHASE

if (phase !== 'pre' && phase !== 'post') {
  throw new Error(`BENCH_PHASE must be pre or post, got ${phase}`)
}

const required = (name: string): string => {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`${name} is required`)
  }

  return value
}

const BASE_URL = required('BASE_URL').replace(/\/$/, '')
const BENCH_COMMIT = required('BENCH_COMMIT')
const BENCH_IMAGE = required('BENCH_IMAGE')
const BENCH_CONTAINER = required('BENCH_CONTAINER')
const CASE_SOURCE_HASH = required('BENCH_CASE_SOURCE_HASH')
const BENCH_OUTPUT =
  process.env.BENCH_OUTPUT ?? join('test-results', 'ability-placement', `${phase}.json`)
const BENCH_BASELINE = process.env.BENCH_BASELINE?.trim()
const USERNAME = process.env.BENCH_USER?.trim() || 'admin'
const PASSWORD = process.env.BENCH_PASSWORD?.trim() || 'admin'
const WARMUPS = Number(process.env.WARMUPS ?? 5)
const MEASURED = Number(process.env.MEASURED ?? 30)
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 15_000)
const CASE_NAME = process.env.CASE?.trim() || 'agent-roles'
const NOW = process.env.NOW?.trim() || '2026-09-02T00:00:00.000Z'
const SCALE = process.env.SCALE?.trim() || '1'
const SEED = process.env.SEED?.trim() || 'ability-placement'

for (const [name, value, minimum] of [
  ['WARMUPS', WARMUPS, 5],
  ['MEASURED', MEASURED, 30],
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

const inspected = JSON.parse(
  (
    await execFileAsync('docker', ['container', 'inspect', BENCH_CONTAINER], {
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout,
) as Inspect[]
const container = inspected[0]

if (!container?.State?.Running || container.State.Health?.Status !== 'healthy') {
  throw new Error(`benchmark container ${BENCH_CONTAINER} is not healthy`)
}
if (container.Image !== BENCH_IMAGE) {
  throw new Error('BENCH_IMAGE does not match the running container')
}

const login = await fetch(`${BASE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
})

if (!login.ok) {
  throw new Error(`login failed: ${login.status} ${await login.text()}`)
}
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]

if (!cookie) {
  throw new Error('login did not set a cookie')
}

const fetchWithTimeout = async (path: string, init: RequestInit = {}): Promise<Response> => {
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

const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const response = await fetchWithTimeout(path, init)

  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
  }

  return response
}

type TimedResponse = {
  response: Response
  bodyText: string
  ms: number
  clientStartedAt: number
  clientEndedAt: number
  serverStartedAt: number | null
  serverEndedAt: number | null
}

const timedFetch = async (path: string, init: RequestInit = {}): Promise<TimedResponse> => {
  const started = performance.now()
  const clientStartedAt = performance.timeOrigin + started
  const response = await fetchWithTimeout(path, init)
  const bodyText = await response.text()
  const clientEndedAt = performance.timeOrigin + performance.now()

  return {
    response,
    bodyText,
    ms: performance.now() - started,
    clientStartedAt,
    clientEndedAt,
    serverStartedAt: response.headers.has(REQUEST_TIMING_HEADER.STARTED_AT)
      ? Number(response.headers.get(REQUEST_TIMING_HEADER.STARTED_AT))
      : null,
    serverEndedAt: response.headers.has(REQUEST_TIMING_HEADER.ENDED_AT)
      ? Number(response.headers.get(REQUEST_TIMING_HEADER.ENDED_AT))
      : null,
  }
}

const startHeartbeatPulse = async (): Promise<{
  start(): Promise<void>
  stop(): Promise<AbilityPlacementHeartbeat[]>
}> => {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads')
      const { performance } = require('node:perf_hooks')

      const sample = async (announce) => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), workerData.timeoutMs)
        const clientStartedAt = performance.timeOrigin + performance.now()
        try {
          const pending = fetch(workerData.url, { signal: controller.signal })
          if (announce) parentPort.postMessage({ type: 'started' })
          const response = await pending
          const serverStartedAt = Number(response.headers.get(workerData.startedHeader))
          const serverEndedAt = Number(response.headers.get(workerData.endedHeader))
          await response.arrayBuffer()
          return { status: response.status, clientStartedAt, clientEndedAt: performance.timeOrigin + performance.now(), serverStartedAt, serverEndedAt }
        } catch {
          return { status: null, clientStartedAt, clientEndedAt: performance.timeOrigin + performance.now(), serverStartedAt: NaN, serverEndedAt: NaN }
        } finally {
          clearTimeout(timeout)
        }
      }

      const run = async () => {
        await sample(false)
        parentPort.postMessage({ type: 'ready' })
        if ((await new Promise((resolve) => parentPort.once('message', resolve))) !== 'start') return
        let stopping = false
        let first = true
        let count = 0
        parentPort.on('message', (message) => { if (message === 'stop') stopping = true })
        do {
          parentPort.postMessage({ type: 'sample', sample: await sample(first) })
          first = false
          count += 1
          if (!stopping) await new Promise((resolve) => setTimeout(resolve, 1))
        } while (!stopping || count < 2)
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
        startedHeader: REQUEST_TIMING_HEADER.STARTED_AT,
        endedHeader: REQUEST_TIMING_HEADER.ENDED_AT,
      },
    },
  )
  const samples: AbilityPlacementHeartbeat[] = []
  let readyResolve: (() => void) | undefined
  let readyReject: ((error: Error) => void) | undefined
  let startedResolve: (() => void) | undefined
  let startedReject: ((error: Error) => void) | undefined
  let doneResolve: (() => void) | undefined
  let doneReject: ((error: Error) => void) | undefined
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const started = new Promise<void>((resolve, reject) => {
    startedResolve = resolve
    startedReject = reject
  })
  const done = new Promise<void>((resolve, reject) => {
    doneResolve = resolve
    doneReject = reject
  })

  worker.on('message', (message: { type?: string; sample?: AbilityPlacementHeartbeat }) => {
    if (message.type === 'ready') {
      readyResolve?.()
    }
    if (message.type === 'started') {
      startedResolve?.()
    }
    if (message.type === 'sample' && message.sample) {
      samples.push(message.sample)
    }
    if (message.type === 'done') {
      doneResolve?.()
    }
  })
  worker.on('error', (error) => {
    readyReject?.(error)
    startedReject?.(error)
    doneReject?.(error)
  })
  await ready
  let stopped: Promise<AbilityPlacementHeartbeat[]> | undefined

  return {
    start: async () => {
      worker.postMessage('start')
      await started
    },
    stop: () =>
      (stopped ??= (() => {
        worker.postMessage('stop')
        return done.then(() => samples)
      })()),
  }
}

const measure = async (run: (index: number, warmup: boolean) => Promise<number>) => {
  for (let index = 0; index < WARMUPS; index += 1) {
    await run(index, true)
  }
  const values: number[] = []

  for (let index = 0; index < MEASURED; index += 1) {
    values.push(await run(index, false))
  }

  return abilityPlacementStats(values)
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

const inventory = (await request('/api/me/agent-roles?source=owned&limit=100').then((response) =>
  response.json(),
)) as {
  projects: Array<{ id: string; handle: string; space: string; status: string }>
  items: Array<{
    name: string
    source: string
    locator?: { location?: { scope?: string } }
  }>
}
const project =
  inventory.projects.find((candidate) => candidate.handle === 'team/other') ??
  inventory.projects.find(
    (candidate) => candidate.handle.includes('/') && candidate.status === 'active',
  )

if (!project) {
  throw new Error('ability-placement benchmark requires one active shared project')
}
const sets = (await request('/api/context-sets').then((response) => response.json())) as {
  sets: Array<{
    id: string
    name: string
    homeSpace: string
    items: Array<{ space: string; noteId: string }>
  }>
}
const sourceSet =
  sets.sets.find((set) => set.name === 'Research source set' && set.items.length > 0) ??
  sets.sets.find((set) => set.items.length > 0)
const noteId = sourceSet?.items[0]?.noteId
const noteSpace = sourceSet?.items[0]?.space ?? sourceSet?.homeSpace

if (!sourceSet || !noteId || !noteSpace) {
  throw new Error('ability-placement benchmark seed needs a readable non-empty context set')
}

const harnessHash = createHash('sha256')
  .update(await readFile(new URL('./abilityPlacementBench.ts', import.meta.url)))
  .update(await readFile(new URL('./abilityPlacementBenchGates.ts', import.meta.url)))
  .update(await readFile('Makefile'))
  .digest('hex')
const dataRootHash = createHash('sha256')
  .update(
    JSON.stringify({
      caseName: CASE_NAME,
      now: NOW,
      scale: SCALE,
      seed: SEED,
      caseSourceHash: CASE_SOURCE_HASH,
      projects: inventory.projects
        .map(({ handle, status }) => ({ handle, status }))
        .sort((left, right) => left.handle.localeCompare(right.handle)),
      roles: inventory.items
        .map((item) => ({
          name: item.name,
          source: item.source,
          scope: item.locator?.location?.scope ?? null,
        }))
        .sort((left, right) =>
          `${left.name}:${left.source}:${left.scope}`.localeCompare(
            `${right.name}:${right.source}:${right.scope}`,
          ),
        ),
      sets: sets.sets
        .map((set) => ({ name: set.name, homeSpace: set.homeSpace, itemCount: set.items.length }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }),
  )
  .digest('hex')

const idleHeartbeat = await measure(async () => {
  const sample = await timedFetch('/api/health')

  if (sample.response.status !== 200) {
    throw new Error(`idle heartbeat returned ${sample.response.status}`)
  }
  if (sample.serverStartedAt === null || sample.serverEndedAt === null) {
    throw new Error('idle heartbeat returned no server timing interval')
  }

  return sample.serverEndedAt - sample.serverStartedAt
})

const setControlPath = `/api/s/${encodeURIComponent(project.space)}/projects/${encodeURIComponent(project.id)}/context-sets/${encodeURIComponent(sourceSet.id)}`
const projectSetControl = await measure(async () => {
  const started = performance.now()
  await request(setControlPath, { method: 'PUT' })
  await request(setControlPath, { method: 'DELETE' })
  return performance.now() - started
})
const pinControlPath = `/api/s/${encodeURIComponent(project.space)}/projects/${encodeURIComponent(project.id)}/context-pins`
const projectPinControl = await measure(async () => {
  const started = performance.now()
  await request(pinControlPath, {
    method: 'PUT',
    body: JSON.stringify({ space: noteSpace, noteId }),
  })
  await request(`${pinControlPath}/${encodeURIComponent(noteId)}`, { method: 'DELETE' })
  return performance.now() - started
})

const runRoleSample = async (index: number, warmup: boolean) => {
  const name = `placement-${phase}-${warmup ? 'w' : 'm'}-${index}`
  const created = (await request('/api/me/agent-roles/custom', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'Ability placement benchmark role.',
      instructions: `# ${name}\n\nCarry exact placement state.`,
      scope: 'project',
      project: project.handle,
    }),
  }).then((response) => response.json())) as { locator: unknown; noteId: string }
  const oldAddress = encodeAbilityLocator(created.locator as never)
  const roleSetPath = `/api/me/agent-roles/${oldAddress}/context-sets/${encodeURIComponent(sourceSet.id)}`
  const rolePinPath = `/api/me/agent-roles/${oldAddress}/context-pins`

  try {
    const setupStarted = performance.now()
    await request(roleSetPath, { method: 'PUT' })
    await request(rolePinPath, {
      method: 'PUT',
      body: JSON.stringify({ space: noteSpace, noteId }),
    })
    await request(`/api/me/agent-roles/${oldAddress}/context-order`, {
      method: 'PUT',
      body: JSON.stringify({
        entries: [
          { kind: 'pin', ref: noteId },
          { kind: 'set', ref: sourceSet.id },
        ],
      }),
    })
    await request(`/api/me/agent-abilities/${oldAddress}/enabled`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
    })
    const roleSetupMs = performance.now() - setupStarted

    const pulse = await startHeartbeatPulse()
    await pulse.start()
    const first = await timedFetch(`/api/me/agent-abilities/${oldAddress}/home`, {
      method: 'PUT',
      body: JSON.stringify({ scope: 'space' }),
    })
    const heartbeats = await pulse.stop()

    if (first.response.status !== 200) {
      throw new Error(`first home move failed: ${first.response.status}`)
    }
    const firstBody = JSON.parse(first.bodyText) as { locator: unknown }
    const currentAddress = encodeAbilityLocator(firstBody.locator as never)
    const replay = await timedFetch(`/api/me/agent-abilities/${oldAddress}/home`, {
      method: 'PUT',
      body: JSON.stringify({ scope: 'space' }),
    })
    const detail = (await request(`/api/me/agent-abilities/${currentAddress}`).then((response) =>
      response.json(),
    )) as { ability?: { enabled?: boolean } }
    const context = (await request(
      `/api/me/agent-roles/${currentAddress}/context?project=${encodeURIComponent(project.id)}`,
    ).then((response) => response.json())) as {
      role?: { pins?: Array<{ noteId?: string }>; sets?: Array<{ id?: string }> }
    }
    return {
      roleSetupMs,
      firstMoveMs: first.ms,
      firstMoveStatus: first.response.status,
      replayMs: replay.ms,
      replayStatus: replay.response.status,
      enabledStayedFalse: detail.ability?.enabled === false,
      contextCarried:
        context.role?.pins?.some((pin) => pin.noteId === noteId) === true &&
        context.role?.sets?.some((set) => set.id === sourceSet.id) === true,
      firstMoveClientStartedAt: first.clientStartedAt,
      firstMoveClientEndedAt: first.clientEndedAt,
      firstMoveServerStartedAt: first.serverStartedAt,
      firstMoveServerEndedAt: first.serverEndedAt,
      heartbeats,
    }
  } finally {
    await request(`/api/note?id=${encodeURIComponent(created.noteId)}`, { method: 'DELETE' })
    await request(`/api/s/${encodeURIComponent(project.space)}/trash/purge`, {
      method: 'POST',
      body: JSON.stringify({ ids: [created.noteId] }),
    })
  }
}

for (let index = 0; index < WARMUPS; index += 1) {
  await runRoleSample(index, true)
}
const samples = []

for (let index = 0; index < MEASURED; index += 1) {
  samples.push(await runRoleSample(index, false))
}

const report: AbilityPlacementBenchmarkReport = {
  phase,
  provenance: {
    commit: BENCH_COMMIT,
    builtAt: about.build.builtAt,
    image: BENCH_IMAGE,
    imageRevision,
    imageBuiltAt,
    container: BENCH_CONTAINER,
    baseUrl: BASE_URL,
    harnessHash,
    dataRootHash,
    node: process.version,
    npm: (await execFileAsync('npm', ['--version'])).stdout.trim(),
    caseName: CASE_NAME,
    caseSourceHash: CASE_SOURCE_HASH,
    now: NOW,
    scale: SCALE,
    seed: SEED,
  },
  warmups: WARMUPS,
  measured: MEASURED,
  idleHeartbeat,
  roleFirstMove: abilityPlacementStats(samples.map((sample) => sample.firstMoveMs)),
  roleSetup: abilityPlacementStats(samples.map((sample) => sample.roleSetupMs)),
  roleReplay: abilityPlacementStats(samples.map((sample) => sample.replayMs)),
  projectSetControl,
  projectPinControl,
  samples,
}
const baseline = BENCH_BASELINE
  ? (JSON.parse(await readFile(BENCH_BASELINE, 'utf8')) as AbilityPlacementBenchmarkReport)
  : undefined
const failures = abilityPlacementBenchmarkGateFailures(report, baseline)

report.gate = { baseline: BENCH_BASELINE ?? null, failures, passed: failures.length === 0 }
await mkdir(dirname(BENCH_OUTPUT), { recursive: true })
await writeFile(BENCH_OUTPUT, `${JSON.stringify(report, null, 2)}\n`)

if (failures.length > 0) {
  throw new Error(
    `ability-placement benchmark failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
  )
}

console.log(
  JSON.stringify({
    phase,
    output: BENCH_OUTPUT,
    harnessHash,
    firstMove: report.roleFirstMove,
    setup: report.roleSetup,
    replay: report.roleReplay,
    setControl: report.projectSetControl,
    pinControl: report.projectPinControl,
  }),
)
