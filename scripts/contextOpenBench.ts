// The measuring half of the context-open benchmark: it drives a real seeded stand
// and writes the report that `contextOpenBenchGates` then judges.
// canon: docs/seeds.md#cli

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

import {
  contextOpenBenchmarkGateFailures,
  type ContextOpenBenchmarkReport,
  contextOpenContainerFailures,
  contextOpenRuntimeFailures,
  contextOpenStats as stats,
} from './contextOpenBenchGates'

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8805').replace(/\/$/, '')
const USERNAME = process.env.BENCH_USER ?? 'admin'
const PASSWORD = process.env.BENCH_PASSWORD ?? 'admin'
const WARMUPS = Number(process.env.WARMUPS ?? 3)
const MEASURED = Number(process.env.MEASURED ?? 12)
const ABILITY_TIMEOUT_MS = Number(process.env.ABILITY_TIMEOUT_MS ?? 1_000)
const HEARTBEAT_INTERVAL_MS = 25
const phase = process.env.BENCH_PHASE ?? 'post'
const execFileAsync = promisify(execFile)

if (phase !== 'pre' && phase !== 'post') {
  throw new Error(`BENCH_PHASE must be pre or post, got ${phase}`)
}
const BENCH_PHASE: 'pre' | 'post' = phase
const BENCH_OUTPUT =
  process.env.BENCH_OUTPUT ?? join('test-results', 'context-open-bench', `${BENCH_PHASE}.json`)

const requiredProvenance = (name: 'BENCH_COMMIT' | 'BENCH_IMAGE' | 'BENCH_CONTAINER'): string => {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`${name} is required for a provenance-bound benchmark`)
  }

  return value
}
const BENCH_COMMIT = requiredProvenance('BENCH_COMMIT')
const BENCH_IMAGE = requiredProvenance('BENCH_IMAGE')
const BENCH_CONTAINER = requiredProvenance('BENCH_CONTAINER')

type ContainerInspect = {
  Config?: { Image?: string; Labels?: Record<string, string | undefined> }
  Image?: string
  State?: { Health?: { Status?: string }; Running?: boolean }
}

const inspectOutput = await execFileAsync('docker', ['container', 'inspect', BENCH_CONTAINER], {
  maxBuffer: 2 * 1024 * 1024,
})
const inspected = (JSON.parse(inspectOutput.stdout) as ContainerInspect[])[0]
const container = {
  builtAt: inspected?.Config?.Labels?.['org.opencontainers.image.created']?.trim(),
  health: inspected?.State?.Health?.Status,
  image: inspected?.Image?.trim(),
  revision: inspected?.Config?.Labels?.['org.opencontainers.image.revision']?.trim(),
  running: inspected?.State?.Running,
}
const containerFailures = contextOpenContainerFailures(
  { container: BENCH_CONTAINER, image: BENCH_IMAGE },
  container,
)

if (containerFailures.length > 0) {
  throw new Error(containerFailures.join('\n'))
}

type Sample = { ms: number; status: number }
type Stats = ReturnType<typeof stats>
type ProbeSample = { ms: number; status: number | null; error?: string }
type McpSample = ProbeSample & {
  isError?: boolean
  structured?: Record<string, unknown>
  text?: string
}
type AbilityOperation = {
  call: McpSample
  healthHeartbeat: ProbeSample[]
  unrelatedNote: ProbeSample
}
type AbilityCycle = {
  phase: 'warmup' | 'measured'
  applied: AbilityOperation
  noOp?: AbilityOperation
  conflict?: AbilityOperation
}

const maybeStats = (samples: readonly number[]): Stats | null =>
  samples.length > 0 ? stats(samples) : null

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const login = await fetch(`${BASE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: USERNAME, password: PASSWORD }),
})

if (!login.ok) {
  throw new Error(`login failed: ${login.status} ${await login.text()}`)
}
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]

if (!cookie) {
  throw new Error('login response did not set a session cookie')
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
const runtimeBuild = (await request('/api/about').then((response) => response.json())) as {
  build: { builtAt: string | null; commit: string | null }
}

const runtimeFailures = contextOpenRuntimeFailures(
  { commit: BENCH_COMMIT },
  container,
  runtimeBuild.build,
)

if (runtimeFailures.length > 0) {
  throw new Error(runtimeFailures.join('\n'))
}

const timed = async (path: string, init?: RequestInit): Promise<Sample> => {
  const started = performance.now()
  const response = await request(path, init)

  await response.arrayBuffer()
  return { ms: performance.now() - started, status: response.status }
}

const probeTimed = async (
  path: string,
  init?: RequestInit,
  timeoutMs = ABILITY_TIMEOUT_MS,
): Promise<ProbeSample> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const started = performance.now()

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        cookie,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    })

    await response.arrayBuffer()
    return { ms: performance.now() - started, status: response.status }
  } catch (error) {
    return { ms: performance.now() - started, status: null, error: errorText(error) }
  } finally {
    clearTimeout(timeout)
  }
}

const measure = async (run: () => Promise<unknown>): Promise<Stats> => {
  for (let index = 0; index < WARMUPS; index++) {
    await run()
  }
  const samples: number[] = []

  for (let index = 0; index < MEASURED; index++) {
    const started = performance.now()

    await run()
    samples.push(performance.now() - started)
  }

  return stats(samples)
}

const projectRows = (await request('/api/s/context-lab/projects').then((r) => r.json())) as {
  projects: Array<{ handle: string; id: string; path: string }>
}
const project = projectRows.projects.find((row) => row.path === 'product')

if (!project) {
  throw new Error('context-open project "product" was not found')
}
const projectContextPaths = [
  `/api/s/context-lab/projects/${encodeURIComponent(project.id)}/agent-context`,
  `/api/s/context-lab/projects/${encodeURIComponent(project.id)}/memory?order=eager`,
] as const

if (process.env.CONTEXT_ONLY === '1') {
  const personalContext = await measure(() => timed('/api/me/agent-context'))
  const projectContext = await measure(() =>
    Promise.all(projectContextPaths.map((path) => timed(path))),
  )

  console.log(JSON.stringify({ personalContext, projectContext }, null, 2))
  process.exit(0)
}

const dashboardPaths = [
  '/api/s/context-lab/tree',
  '/api/s/context-lab/projects',
  '/api/s/context-lab/activity?tz=0',
  '/api/s/context-lab/graph',
  '/api/s/context-lab/graph/health',
  '/api/s/context-lab/activity/events?limit=12',
  '/api/s/context-lab/activity/projects',
  '/api/s/context-lab/tags',
] as const

const coldDashboardStarted = performance.now()
const coldDashboardChannels = await Promise.all(
  dashboardPaths.map(async (path) => ({ path, ...(await timed(path)) })),
)
const coldDashboard = {
  totalMs: performance.now() - coldDashboardStarted,
  channels: coldDashboardChannels,
}
const warmDashboard = await measure(() => Promise.all(dashboardPaths.map((path) => timed(path))))
const warmGraphHealth = await measure(() => timed('/api/s/context-lab/graph/health'))

const personalContext = await measure(() => timed('/api/me/agent-context'))
const projectContext = await measure(() =>
  Promise.all(projectContextPaths.map((path) => timed(path))),
)
const projectMemoryRows = (await request(projectContextPaths[1]).then((r) => r.json())) as {
  categories: Array<{ noteId: string }>
}
const memoryNoteId = projectMemoryRows.categories[0]?.noteId

if (!memoryNoteId) {
  throw new Error('context-open project memory category was not found')
}
const memoryNotePath = `/api/note?id=${encodeURIComponent(memoryNoteId)}`
const memoryDetail = (await request(memoryNotePath).then((r) => r.json())) as {
  content: string
  id: string
  title?: string
  versionToken: string
}

const postMemoryWrite = async (): Promise<number> => {
  const saved = (await request('/api/note', {
    method: 'POST',
    body: JSON.stringify({
      originalId: memoryDetail.id,
      versionToken: memoryDetail.versionToken,
      content: `# ${memoryDetail.title ?? 'Memory'}\n\n${memoryDetail.content}`,
    }),
  }).then((r) => r.json())) as { versionToken: string }

  memoryDetail.versionToken = saved.versionToken
  const started = performance.now()

  await Promise.all(projectContextPaths.map((path) => timed(path)))
  return performance.now() - started
}

for (let index = 0; index < WARMUPS; index++) {
  await postMemoryWrite()
}
const postMemoryWriteSamples: number[] = []

for (let index = 0; index < MEASURED; index++) {
  postMemoryWriteSamples.push(await postMemoryWrite())
}

const noteRows = (await request('/api/s/context-lab/notes?folder=product%2Fcorpus&limit=1').then(
  (r) => r.json(),
)) as { notes: Array<{ id: string }> }
const noteId = noteRows.notes[0]?.id

if (!noteId) {
  throw new Error('context-open corpus note was not found')
}
const notePath = `/api/note?id=${encodeURIComponent(noteId)}`
const noteOpen = await measure(() => timed(notePath))

let detail = (await request(notePath).then((r) => r.json())) as {
  content: string
  frontmatter: { tags?: string[] }
  id: string
  title?: string
  versionToken: string
}
const authoredContent = (): string => `# ${detail.title ?? 'Context note'}\n\n${detail.content}`

for (let index = 0; index < WARMUPS; index++) {
  const saved = (await request('/api/note', {
    method: 'POST',
    body: JSON.stringify({
      originalId: detail.id,
      versionToken: detail.versionToken,
      content: authoredContent(),
      tags: ['context-open', 'reference'],
    }),
  }).then((r) => r.json())) as { versionToken: string }

  detail.versionToken = saved.versionToken
  detail = (await request(notePath).then((r) => r.json())) as typeof detail
}
const postWriteSamples: number[] = []

for (let index = 0; index < MEASURED; index++) {
  const saved = (await request('/api/note', {
    method: 'POST',
    body: JSON.stringify({
      originalId: detail.id,
      versionToken: detail.versionToken,
      content: authoredContent(),
      tags: ['context-open', 'reference'],
    }),
  }).then((r) => r.json())) as { versionToken: string }

  detail.versionToken = saved.versionToken
  const opened = await timed(notePath)

  postWriteSamples.push(opened.ms)
  detail = (await request(notePath).then((r) => r.json())) as typeof detail
}

const runAbilityBenchmark = async () => {
  const createdPat = (await request('/api/me/tokens', {
    method: 'POST',
    body: JSON.stringify({ name: 'context-open-bench', scope: 'write' }),
  }).then((response) => response.json())) as { token: string; pat: { id: string } }
  let rpcId = 0

  const mcpCall = async (
    name: string,
    arguments_: Record<string, unknown>,
    timeoutMs = ABILITY_TIMEOUT_MS,
  ): Promise<McpSample> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const started = performance.now()

    try {
      const response = await fetch(`${BASE_URL}/mcp`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${createdPat.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++rpcId,
          method: 'tools/call',
          params: { name, arguments: arguments_ },
        }),
      })
      const raw = await response.text()

      if (!response.ok) {
        return {
          ms: performance.now() - started,
          status: response.status,
          error: raw,
        }
      }
      const rpc = JSON.parse(raw) as {
        error?: unknown
        result?: {
          isError?: boolean
          structuredContent?: Record<string, unknown>
          content?: Array<{ text?: string }>
        }
      }
      const text = rpc.result?.content?.map((item) => item.text ?? '').join('\n')

      return {
        ms: performance.now() - started,
        status: response.status,
        ...(rpc.result?.isError !== undefined ? { isError: rpc.result.isError } : {}),
        ...(rpc.result?.structuredContent ? { structured: rpc.result.structuredContent } : {}),
        ...(text ? { text } : {}),
        ...(rpc.error ? { error: JSON.stringify(rpc.error) } : {}),
      }
    } catch (error) {
      return {
        ms: performance.now() - started,
        status: null,
        error: errorText(error),
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  const editWithProbes = async (arguments_: Record<string, unknown>): Promise<AbilityOperation> => {
    let settled = false
    const calling = mcpCall('edit_ability', arguments_).finally(() => {
      settled = true
    })
    const heartbeat = (async () => {
      const samples: ProbeSample[] = []

      do {
        samples.push(await probeTimed('/api/health'))
        if (!settled) {
          await delay(HEARTBEAT_INTERVAL_MS)
        }
      } while (!settled)

      return samples
    })()
    const [call, unrelatedNote, healthHeartbeat] = await Promise.all([
      calling,
      probeTimed(notePath),
      heartbeat,
    ])

    return { call, unrelatedNote, healthHeartbeat }
  }

  try {
    const discovery = await mcpCall(
      'list_abilities',
      {
        view: 'authoring',
        kind: 'role',
        source: 'owned',
        project: project.handle,
        q: 'context-benchmark',
        limit: 50,
      },
      Math.max(ABILITY_TIMEOUT_MS, 5_000),
    )
    const abilities = (discovery.structured?.abilities ?? []) as Array<{
      kind: string
      name: string
      ref: string
      source: string
    }>
    const summary = abilities.find(
      (ability) =>
        ability.name === 'context-benchmark' &&
        ability.kind === 'role' &&
        ability.source === 'owned',
    )

    if (!summary) {
      throw new Error(`seeded context-benchmark role was not found: ${discovery.text ?? ''}`)
    }
    const read = await mcpCall(
      'get_ability',
      { ref: summary.ref },
      Math.max(ABILITY_TIMEOUT_MS, 5_000),
    )
    const ability = read.structured?.ability as
      { instructions?: string; versionToken?: string } | undefined

    if (!ability?.versionToken) {
      throw new Error(`seeded context-benchmark role was not readable: ${read.text ?? ''}`)
    }
    let versionToken = ability.versionToken
    const firstMarker = ability.instructions?.includes('Performance marker: alpha.')
      ? 'beta'
      : 'alpha'
    const cycles: AbilityCycle[] = []
    const cycleCount = WARMUPS + MEASURED
    let failure: string | null = null

    for (let index = 0; index < cycleCount; index++) {
      const phase = index < WARMUPS ? 'warmup' : 'measured'
      const marker = index % 2 === 0 ? firstMarker : firstMarker === 'alpha' ? 'beta' : 'alpha'
      const instructions = `# Context benchmark\n\nPerformance marker: ${marker}.`
      const staleToken = versionToken
      const cycle: AbilityCycle = {
        phase,
        applied: await editWithProbes({
          ref: summary.ref,
          versionToken,
          instructions,
        }),
      }
      const appliedStep = (
        cycle.applied.call.structured?.steps as Array<{ outcome: string; step: string }> | undefined
      )?.[0]
      const appliedToken = cycle.applied.call.structured?.versionToken

      if (
        cycle.applied.call.status !== 200 ||
        cycle.applied.call.isError === true ||
        appliedStep?.step !== 'document' ||
        appliedStep.outcome !== 'applied' ||
        typeof appliedToken !== 'string'
      ) {
        cycles.push(cycle)
        failure = cycle.applied.call.error ?? cycle.applied.call.text ?? 'applied edit failed'
        break
      }
      versionToken = appliedToken
      cycle.noOp = await editWithProbes({
        ref: summary.ref,
        versionToken,
        instructions,
      })
      const noOpStep = (
        cycle.noOp.call.structured?.steps as Array<{ outcome: string; step: string }> | undefined
      )?.[0]

      if (noOpStep?.step !== 'document' || noOpStep.outcome !== 'skipped') {
        cycles.push(cycle)
        failure = cycle.noOp.call.error ?? cycle.noOp.call.text ?? 'semantic no-op failed'
        break
      }
      cycle.conflict = await editWithProbes({
        ref: summary.ref,
        versionToken: staleToken,
        instructions: '# Context benchmark\n\nA stale marker must never land.',
      })
      const conflictStep = (
        cycle.conflict.call.structured?.steps as
          Array<{ outcome: string; step: string }> | undefined
      )?.[0]

      cycles.push(cycle)
      if (conflictStep?.step !== 'document' || conflictStep.outcome !== 'failed') {
        failure = cycle.conflict.call.error ?? cycle.conflict.call.text ?? 'stale conflict failed'
        break
      }
    }

    const measured = cycles.filter((cycle) => cycle.phase === 'measured')
    const operationStats = (key: 'applied' | 'noOp' | 'conflict') =>
      maybeStats(
        measured.flatMap((cycle) => {
          const operation = cycle[key]

          return operation ? [operation.call.ms] : []
        }),
      )
    const probes = cycles.flatMap((cycle) =>
      [cycle.applied, cycle.noOp, cycle.conflict].filter(
        (operation): operation is AbilityOperation => operation !== undefined,
      ),
    )
    const heartbeatSamples = probes.flatMap((operation) => operation.healthHeartbeat)
    const unrelatedSamples = probes.map((operation) => operation.unrelatedNote)

    const rawOperation = (operation: AbilityOperation | undefined) => {
      if (!operation) {
        return undefined
      }
      const step = (
        operation.call.structured?.steps as
          Array<{ error?: string; outcome: string; step: string }> | undefined
      )?.[0]

      return {
        call: {
          ms: operation.call.ms,
          status: operation.call.status,
          ...(operation.call.isError !== undefined ? { isError: operation.call.isError } : {}),
          ...(operation.call.error ? { error: operation.call.error } : {}),
          ...(step ? { step } : {}),
        },
        unrelatedNote: operation.unrelatedNote,
        healthHeartbeat: operation.healthHeartbeat,
      }
    }

    return {
      completed: failure === null && cycles.length === cycleCount,
      failure,
      timeoutMs: ABILITY_TIMEOUT_MS,
      discovery: {
        calls: 1,
        ms: discovery.ms,
        status: discovery.status,
        returnedAbilityRows: abilities.length,
      },
      get: { ms: read.ms, status: read.status },
      applied: operationStats('applied'),
      noOp: operationStats('noOp'),
      conflict: operationStats('conflict'),
      unrelatedNote: maybeStats(unrelatedSamples.map((sample) => sample.ms)),
      healthHeartbeat: {
        samples: heartbeatSamples.length,
        stats: maybeStats(heartbeatSamples.map((sample) => sample.ms)),
        failures: heartbeatSamples.filter((sample) => sample.status !== 200),
      },
      raw: cycles.map((cycle) => ({
        phase: cycle.phase,
        applied: rawOperation(cycle.applied),
        ...(cycle.noOp ? { noOp: rawOperation(cycle.noOp) } : {}),
        ...(cycle.conflict ? { conflict: rawOperation(cycle.conflict) } : {}),
      })),
      targetRef: summary.ref,
    }
  } finally {
    await request(`/api/me/tokens/${encodeURIComponent(createdPat.pat.id)}`, {
      method: 'DELETE',
    })
  }
}

const abilityEdit = await runAbilityBenchmark()
const postAbilitySurfaces = abilityEdit.completed
  ? {
      status: await request('/api/s/context-lab/status').then((response) => response.json()),
      noteOpen: await measure(() => timed(notePath)),
      personalContext: await measure(() => timed('/api/me/agent-context')),
      projectContext: await measure(() =>
        Promise.all(projectContextPaths.map((path) => timed(path))),
      ),
      dashboard: await measure(() => Promise.all(dashboardPaths.map((path) => timed(path)))),
      graphHealth: await measure(() => timed('/api/s/context-lab/graph/health')),
    }
  : null

const report = {
  phase: BENCH_PHASE,
  provenance: {
    commit: runtimeBuild.build.commit,
    builtAt: runtimeBuild.build.builtAt,
    image: container.image,
    imageRevision: container.revision,
    imageBuiltAt: container.builtAt,
    container: BENCH_CONTAINER,
    dataRoot: createHash('sha256')
      .update([project.id, memoryNoteId, noteId, abilityEdit.targetRef].join('\0'))
      .digest('hex'),
    baseUrl: BASE_URL,
  },
  baseUrl: BASE_URL,
  measured: MEASURED,
  warmups: WARMUPS,
  coldDashboard,
  warmDashboard,
  warmGraphHealth,
  personalContext,
  projectContext,
  projectContextImmediatelyAfterMemoryWrite: stats(postMemoryWriteSamples),
  noteOpen,
  noteOpenImmediatelyAfterWrite: stats(postWriteSamples),
  abilityEdit,
  postAbilitySurfaces,
}
const baselinePath = process.env.BENCH_BASELINE
const baseline = baselinePath
  ? (JSON.parse(await readFile(baselinePath, 'utf8')) as ContextOpenBenchmarkReport)
  : undefined
const failures = contextOpenBenchmarkGateFailures(report as ContextOpenBenchmarkReport, baseline)
const output = {
  ...report,
  gate: {
    baseline: baselinePath ?? null,
    failures,
    passed: failures.length === 0,
  },
}
const serialized = `${JSON.stringify(output, null, 2)}\n`

await mkdir(dirname(BENCH_OUTPUT), { recursive: true })
await writeFile(BENCH_OUTPUT, serialized)
process.stdout.write(serialized)

if (failures.length > 0) {
  throw new Error(`context-open benchmark gates failed:\n${failures.join('\n')}`)
}
