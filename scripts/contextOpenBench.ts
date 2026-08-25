import { performance } from 'node:perf_hooks'

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8805').replace(/\/$/, '')
const USERNAME = process.env.BENCH_USER ?? 'admin'
const PASSWORD = process.env.BENCH_PASSWORD ?? 'admin'
const WARMUPS = Number(process.env.WARMUPS ?? 3)
const MEASURED = Number(process.env.MEASURED ?? 12)

type Sample = { ms: number; status: number }
type Stats = { medianMs: number; p95Ms: number; maxMs: number; rawMs: number[] }

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0
}

const stats = (samples: readonly number[]): Stats => ({
  medianMs: percentile(samples, 0.5),
  p95Ms: percentile(samples, 0.95),
  maxMs: Math.max(...samples),
  rawMs: [...samples],
})

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

const timed = async (path: string, init?: RequestInit): Promise<Sample> => {
  const started = performance.now()
  const response = await request(path, init)

  await response.arrayBuffer()
  return { ms: performance.now() - started, status: response.status }
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
  projects: Array<{ id: string; path: string }>
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

console.log(
  JSON.stringify(
    {
      baseUrl: BASE_URL,
      measured: MEASURED,
      warmups: WARMUPS,
      coldDashboard,
      warmDashboard,
      personalContext,
      projectContext,
      projectContextImmediatelyAfterMemoryWrite: stats(postMemoryWriteSamples),
      noteOpen,
      noteOpenImmediatelyAfterWrite: stats(postWriteSamples),
    },
    null,
    2,
  ),
)
