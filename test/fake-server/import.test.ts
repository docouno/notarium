// Import (#11, #191) end to end over the production buildApp (#18): POST
// /api/s/:space/import takes a multipart upload (a Claude/ChatGPT/memory export,
// bare .json or a .zip) and converts it to notes through the real write path +
// read-model (CachedStore over InMemoryStore). Since #191 the import is a DURABLE
// JOB by default (a meta-DB backs jobs): POST enqueues (202 + Job), the runner
// writes the notes off the request, the client polls /jobs/:id to terminal and reads
// the summary from job.result. Pins: format auto-detection, one note per
// conversation/entity, dates-as-data reaching the snapshot, idempotent re-import
// (deterministic source-id-keyed paths, no duplicates), a Claude ZIP importing BOTH
// its conversations and projects, memory relations becoming graph edges, kind-scoped
// job listing, and the synchronous NDJSON fallback on a none-mode host.

import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FRONTMATTER_BYTE_CAP } from '@notarium/core'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-06-20T12:00:00.000Z',
  spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
})

let app: FastifyInstance
beforeEach(async () => {
  app = await createApp(fixture())
})
afterEach(async () => {
  await app.close()
})

const BOUNDARY = '----notariumtestboundary'
const OVERSIZED_FRONTMATTER = `---\nauthor: ${'a'.repeat(FRONTMATTER_BYTE_CAP)}\n---\nBody.\n`
const FRONTMATTER_LIMIT_REASON = 'oversized.md: frontmatter exceeds the 64 KiB limit'
const YAML_NODE_REFERENCE_WRITE_ERROR =
  'frontmatter with YAML anchors or aliases is not supported by writes'
const ANCHORED_MARKDOWN = '---\nanchorKey: &source anchored\ncopy: *source\n---\nNew body.\n'

/** Build a minimal multipart/form-data body with one file field (+ optional
 *  text fields) — avoids a form-data dependency. */
const multipart = (
  filename: string,
  content: Buffer | string,
  type: string,
  fields: Record<string, string> = {},
) => {
  const parts: Buffer[] = []

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    )
  }
  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
  )
  parts.push(Buffer.isBuffer(content) ? content : Buffer.from(content))
  parts.push(Buffer.from(`\r\n--${BOUNDARY}--\r\n`))
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  }
}

type DirectMultipartPart =
  { field: string; value: string } | { field: 'file'; filename: string; content: string }

const directMultipart = (parts: DirectMultipartPart[]) => {
  const body: Buffer[] = []

  for (const part of parts) {
    body.push(
      'filename' in part
        ? Buffer.from(
            `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${part.filename}"\r\nContent-Type: text/markdown\r\n\r\n${part.content}\r\n`,
          )
        : Buffer.from(
            `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.field}"\r\n\r\n${part.value}\r\n`,
          ),
    )
  }
  body.push(Buffer.from(`--${BOUNDARY}--\r\n`))

  return {
    payload: Buffer.concat(body),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  }
}

const importFile = (
  filename: string,
  content: Buffer | string,
  type: string,
  fields?: Record<string, string>,
  space = 'main',
) =>
  app.inject({
    method: 'POST',
    url: `/api/s/${space}/import`,
    ...multipart(filename, content, type, fields),
  })

type FileResult = {
  file: string
  format: string
  imported: number
  skipped: number
  warnings: string[]
}
type Summary = {
  imported: number
  skipped: number
  failed: number
  files: FileResult[]
  errors: Array<{ title?: string; error: string }>
  created?: string[]
}
type WireJob = {
  id: string
  kind: string
  status: string
  error: string | null
  progress: { done: number; total: number | null; phase: string | null }
  result: Summary | null
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled'])
const JOB_POLL_INTERVAL_MS = 25
const getJob = async (id: string, space = 'main'): Promise<WireJob> =>
  JSON.parse(
    (await app.inject({ method: 'GET', url: `/api/s/${space}/jobs/${id}` })).payload,
  ) as WireJob

/** Enqueue a durable import (202) and poll to terminal — returns the final job. The
 *  summary lands in job.result on success; a bad upload ends in status 'failed'. */
const runImport = async (
  filename: string,
  content: Buffer | string,
  type: string,
  fields?: Record<string, string>,
  space = 'main',
  terminalTimeoutMs = 4_000,
): Promise<WireJob> => {
  const res = await importFile(filename, content, type, fields, space)
  expect(res.statusCode).toBe(202)
  const enq = JSON.parse(res.payload) as WireJob
  expect(enq.kind).toBe('import')
  let job = enq
  const deadline = Date.now() + terminalTimeoutMs

  while (!TERMINAL.has(job.status)) {
    const remaining = deadline - Date.now()

    if (remaining <= 0) {
      throw new Error(
        `import job ${enq.id} did not reach a terminal state within ${terminalTimeoutMs}ms; ` +
          `last status=${job.status}, progress=${JSON.stringify(job.progress)}`,
      )
    }
    await new Promise((r) => setTimeout(r, Math.min(JOB_POLL_INTERVAL_MS, remaining)))
    job = await getJob(enq.id, space)
  }

  return job
}

const notes = async (space = 'main') => {
  const res = await app.inject({ method: 'GET', url: `/api/s/${space}/notes?limit=1000` })
  return JSON.parse(res.payload).notes as Array<{
    id: string
    title: string
    filePath: string
    createdAt: string | null
  }>
}

/** The import response of a NONE-MODE host is an NDJSON stream — parse it into its
 *  lines, the final `done` summary, and any `error` (the synchronous fallback). */
type ImportLine = {
  type: string
  imported?: number
  skipped?: number
  failed?: number
  error?: string
  files?: FileResult[]
  errors?: Array<{ title?: string; error: string }>
  created?: string[]
}
const ndjson = (payload: string) => {
  const lines = payload
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ImportLine)
  return {
    lines,
    done: lines.find((l) => l.type === 'done'),
    error: lines.find((l) => l.type === 'error'),
  }
}

const CLAUDE_CONVERSATIONS = JSON.stringify([
  {
    uuid: 'c-001',
    name: 'Planning the trip',
    created_at: '2024-03-15T14:30:00Z',
    updated_at: '2024-03-15T15:00:00Z',
    chat_messages: [
      { sender: 'human', created_at: '2024-03-15T14:30:00Z', text: 'Where should we go?' },
      { sender: 'assistant', created_at: '2024-03-15T14:31:00Z', text: 'How about Lisbon?' },
    ],
  },
  {
    uuid: 'c-002',
    name: 'Untitled',
    created_at: '2023-01-02T09:00:00Z',
    chat_messages: [{ sender: 'human', text: 'hi' }],
  },
])

const MEMORY_JSON = [
  JSON.stringify({
    type: 'entity',
    name: 'Alice',
    entityType: 'person',
    observations: ['Likes tea'],
  }),
  JSON.stringify({
    type: 'entity',
    name: 'Acme',
    entityType: 'organization',
    observations: ['Founded 2010'],
  }),
  JSON.stringify({ type: 'relation', from: 'Alice', to: 'Acme', relationType: 'works at' }),
].join('\n')

const CLAUDE_PROJECTS = JSON.stringify([
  {
    uuid: 'p-001',
    name: 'Acme Redesign',
    created_at: '2024-01-10T09:00:00Z',
    updated_at: '2024-01-20T12:00:00Z',
    prompt_template: 'Be helpful.',
    docs: [{ uuid: 'd-001', filename: 'brief.md', content: '# Brief\nDo it.' }],
  },
])

// A realistic modern ChatGPT export (#113): a PARENT-POINTER mapping (every node
// has `parent`, NO `children` array), object-shaped text parts, and a title with
// leading/embedded quotes. The old converter emptied every body on this shape.
const CHATGPT = JSON.stringify([
  {
    title: '"Gameverse" launch plan',
    create_time: 1710512400, // 2024-03-15T14:20:00Z
    conversation_id: 'g-001',
    mapping: {
      a1: {
        id: 'a1',
        parent: 'u1',
        message: {
          author: { role: 'assistant' },
          recipient: 'all',
          create_time: 1710512410,
          content: {
            content_type: 'text',
            parts: [{ content_type: 'text', text: 'Ship in three phases.' }],
          },
        },
      },
      u1: {
        id: 'u1',
        parent: 'root',
        message: {
          author: { role: 'user' },
          create_time: 1710512400,
          content: { content_type: 'text', parts: ['How do we launch?'] },
        },
      },
      root: { id: 'root', parent: null, message: null },
    },
  },
])

// The evolved Claude export (#113): one project / memory / design-chat PER FILE.
const CLAUDE_PROJECT_OBJ = JSON.stringify({
  uuid: 'p-9',
  name: 'How to use Claude',
  prompt_template: 'You are helpful.',
  docs: [{ uuid: 'd-9', filename: 'guide.md', content: '# Guide\nText.' }],
})
const CLAUDE_MEMORIES = JSON.stringify([
  { conversations_memory: '**Work context**\nBuilding a note-taking tool.', account_uuid: 'acc-1' },
])
const CLAUDE_DESIGN_CHAT = JSON.stringify({
  uuid: 'dc-1',
  title: 'Landing page',
  project: { name: 'Landing Redesign' },
  created_at: '2024-04-22T23:02:40Z',
  messages: [
    {
      uuid: 'm1',
      role: 'user',
      content: { role: 'user', content: 'need a landing page' },
      created_at: '2024-04-22T23:02:40Z',
    },
  ],
})

describe('durable import (#191): POST /api/s/:space/import → job', () => {
  it.each([
    [
      'a second file',
      [
        { field: 'file', filename: 'a.md', content: '# A' },
        { field: 'file', filename: 'b.md', content: '# B' },
      ] as DirectMultipartPart[],
    ],
    [
      'a late field',
      [
        { field: 'file', filename: 'a.md', content: '# A' },
        { field: 'root', value: 'late' },
      ] as DirectMultipartPart[],
    ],
  ])('rejects ordinary multipart with %s before enqueue', async (_name, parts) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...directMultipart(parts),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toMatch(/exactly one file part/)
    expect(await notes()).toEqual([])
    const jobs = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/s/main/jobs?kind=import' })).payload,
    ).jobs

    expect(jobs).toEqual([])
  })

  it('imports Claude conversations, one note each, dates reaching the snapshot', async () => {
    const job = await runImport('conversations.json', CLAUDE_CONVERSATIONS, 'application/json')
    expect(job.status).toBe('succeeded')
    const done = job.result!
    expect(done.imported).toBe(2)
    expect(done.failed).toBe(0)
    expect(done.files[0].format).toBe('claude-conversations')

    const list = await notes()
    expect(list).toHaveLength(2)
    const trip = list.find((n) => n.title === 'Planning the trip')!
    // Dates-as-data: the note is dated by when the conversation happened, NOT
    // when it was imported (the fixture's `now` is 2026).
    expect(trip.createdAt).toBe('2024-03-15T14:30:00.000Z')
    expect(trip.filePath).toMatch(
      /^conversations\/claude\/20240315-planning-the-trip-[a-z0-9]{8}\.md$/,
    )
  })

  it('renders the conversation body and tags the source for provenance', async () => {
    await runImport('conversations.json', CLAUDE_CONVERSATIONS, 'application/json')
    const list = await notes()
    const trip = list.find((n) => n.title === 'Planning the trip')!
    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${trip.id}` })).payload,
    )
    expect(detail.content).toContain('### Human')
    expect(detail.content).toContain('How about Lisbon?')
    expect(detail.frontmatter.tags).toContain('claude')
  })

  it('re-import is idempotent — same files, no duplicates', async () => {
    await runImport('conversations.json', CLAUDE_CONVERSATIONS, 'application/json')
    const first = (await notes()).map((n) => n.filePath).sort()
    const job = await runImport('conversations.json', CLAUDE_CONVERSATIONS, 'application/json')
    expect(job.result!.imported).toBe(2)
    const second = (await notes()).map((n) => n.filePath).sort()
    expect(second).toEqual(first)
    expect(second).toHaveLength(2) // not 4
  })

  it('imports a modern ChatGPT export — parent-pointer mapping yields a NON-empty body (#113)', async () => {
    const job = await runImport('conversations.json', CHATGPT, 'application/json')
    expect(job.status).toBe('succeeded')
    const done = job.result!
    expect(done.imported).toBe(1)
    expect(done.failed).toBe(0)
    expect(done.files[0].format).toBe('chatgpt')

    const list = await notes()
    expect(list).toHaveLength(1)
    const conv = list[0]
    // Symptom B: the quoted title survives the round-trip intact (no `\"…\"`).
    expect(conv.title).toBe('"Gameverse" launch plan')
    expect(conv.createdAt).toBe('2024-03-15T14:20:00.000Z')
    expect(conv.filePath).toMatch(/^conversations\/chatgpt\//)

    // Symptom A: the body is rendered, both turns present, chronological order.
    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${conv.id}` })).payload,
    )
    expect(detail.content).toContain('### User')
    expect(detail.content).toContain('How do we launch?')
    expect(detail.content).toContain('### Assistant')
    expect(detail.content).toContain('Ship in three phases.')
    expect(detail.content.indexOf('How do we launch?')).toBeLessThan(
      detail.content.indexOf('Ship in three phases.'),
    )
    expect(detail.frontmatter.tags).toContain('chatgpt')
  })

  it('skips a content-less conversation instead of writing an empty note (#113)', async () => {
    const data = JSON.stringify([
      {
        uuid: 'has-content',
        name: 'Real',
        created_at: '2024-03-15T14:30:00Z',
        chat_messages: [{ sender: 'human', text: 'hello' }],
      },
      // An abandoned/empty conversation the export ships content-less: no note.
      {
        uuid: 'empty-1',
        name: '',
        created_at: '2024-03-15T09:00:00Z',
        chat_messages: [
          { sender: 'human', text: '' },
          { sender: 'assistant', text: '' },
        ],
      },
    ])
    const done = (await runImport('conversations.json', data, 'application/json')).result!
    expect(done.imported).toBe(1) // only the conversation with content
    expect(done.files[0].warnings.join(' ')).toMatch(/skipped 1 conversation/i)
    const list = await notes()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Real')
  })

  it('imports an MCP memory graph — entities as notes, relations as wikilink edges', async () => {
    const job = await runImport('memory.json', MEMORY_JSON, 'application/json')
    expect(job.result!.imported).toBe(2)
    const list = await notes()
    const alice = list.find((n) => n.title === 'Alice')!
    const acme = list.find((n) => n.title === 'Acme')!
    expect(alice.filePath).toBe('memory/person/alice.md')
    // The relation became a graph edge (Alice → Acme) — the graph builder may settle a
    // beat after the write, so poll it briefly.
    let edge = false

    for (let i = 0; i < 30 && !edge; i++) {
      const graph = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/s/main/graph' })).payload,
      )
      edge = graph.links.some(
        (l: { source: string; target: string }) => l.source === alice.id && l.target === acme.id,
      )
      if (!edge) {
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    expect(edge).toBe(true)
  })

  it('imports a Claude ZIP — both conversations.json and projects.json', async () => {
    const zip = new AdmZip()
    zip.addFile('conversations.json', Buffer.from(CLAUDE_CONVERSATIONS))
    zip.addFile('projects.json', Buffer.from(CLAUDE_PROJECTS))
    zip.addFile('users.json', Buffer.from('{"name":"me"}')) // unrelated member, skipped
    const done = (await runImport('claude-export.zip', zip.toBuffer(), 'application/zip')).result!
    const formats = done.files.map((f) => f.format).sort()
    expect(formats).toEqual(['claude-conversations', 'claude-projects'])
    // 2 conversations + 1 prompt-template + 1 doc.
    expect(done.imported).toBe(4)
    const paths = (await notes()).map((n) => n.filePath).sort()
    expect(paths).toContain('projects/acme-redesign/prompt-template.md')
    expect(paths).toContain('projects/acme-redesign/docs/brief.md')
  })

  it('fails an in-run destination collision instead of silently overwriting the first note', async () => {
    const colliding = JSON.stringify([
      {
        uuid: 'first-project',
        name: 'Same Project',
        prompt_template: 'FIRST PROMPT',
        docs: [{ uuid: 'first-doc', filename: 'same.md', content: 'FIRST DOC' }],
      },
      {
        uuid: 'second-project',
        name: 'Same Project',
        prompt_template: 'SECOND PROMPT',
        docs: [{ uuid: 'second-doc', filename: 'same.md', content: 'SECOND DOC' }],
      },
    ])
    const done = (await runImport('projects.json', colliding, 'application/json')).result!

    expect(done.imported).toBe(2)
    expect(done.failed).toBe(2)
    expect(done.errors.every((error) => /destination collision/.test(error.error))).toBe(true)
    const list = await notes()
    expect(list).toHaveLength(2)
    const contents = await Promise.all(
      list.map(
        async (note) =>
          JSON.parse(
            (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${note.id}` })).payload,
          ).content,
      ),
    )
    expect(contents.join('\n')).toContain('FIRST PROMPT')
    expect(contents.join('\n')).toContain('FIRST DOC')
    expect(contents.join('\n')).not.toContain('SECOND')
  })

  it('imports the evolved Claude ZIP — per-file project/memory/design-chat + surfaces a skipped member (#113)', async () => {
    const zip = new AdmZip()
    zip.addFile('conversations.json', Buffer.from(CLAUDE_CONVERSATIONS)) // 2 conversations
    zip.addFile('projects/019ad515.json', Buffer.from(CLAUDE_PROJECT_OBJ)) // prompt-template + 1 doc
    zip.addFile('memories.json', Buffer.from(CLAUDE_MEMORIES)) // 1 memory note
    zip.addFile('design_chats/dc-1.json', Buffer.from(CLAUDE_DESIGN_CHAT)) // 1 design chat
    zip.addFile('users.json', Buffer.from('{"name":"me"}')) // irrelevant — skipped SILENTLY
    zip.addFile('assets.json', Buffer.from('{"some":"unrelated json"}')) // unrecognised — skipped WITH a warning
    const done = (await runImport('claude-export.zip', zip.toBuffer(), 'application/zip')).result!

    // 2 conversations + (prompt-template + doc) + 1 memory + 1 design-chat.
    expect(done.imported).toBe(6)
    expect(done.failed).toBe(0)
    const byFormat = Object.fromEntries(done.files.map((f) => [f.format, f]))
    expect(byFormat['claude-conversations'].imported).toBe(2)
    expect(byFormat['claude-projects'].imported).toBe(2)
    expect(byFormat['claude-memory'].imported).toBe(1)
    expect(byFormat['claude-design-chat'].imported).toBe(1)

    // The unrecognised member is surfaced (no silent data loss); users.json is not.
    const skipped = byFormat['unsupported']
    expect(skipped).toBeTruthy()
    expect(skipped.warnings.join(' ')).toMatch(/assets\.json.*skipped/i)
    expect(done.files.some((f) => f.file.includes('users.json'))).toBe(false)

    const paths = (await notes()).map((n) => n.filePath).sort()
    expect(paths).toContain('projects/how-to-use-claude/prompt-template.md')
    expect(paths).toContain('projects/how-to-use-claude/docs/guide.md')
    expect(paths.some((p) => p.startsWith('memory/claude/'))).toBe(true)
    expect(paths.some((p) => p.startsWith('design-chats/landing-redesign/'))).toBe(true)
  })

  it('an unrecognised upload fails the job with a clear error', async () => {
    const job = await runImport('random.json', '{"hello":"world"}', 'application/json')
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/recognised/i)
    expect(await notes()).toHaveLength(0)
  })

  it('streams a large array element-by-element (many conversations)', async () => {
    const many = JSON.stringify(
      Array.from({ length: 600 }, (_, i) => ({
        uuid: `big-${i}`,
        name: `Chat ${i}`,
        created_at: '2024-05-05T00:00:00Z',
        chat_messages: [{ sender: 'human', text: `message ${i}` }],
      })),
    )
    const job = await runImport(
      'conversations.json',
      many,
      'application/json',
      undefined,
      'main',
      20_000,
    )
    expect(job.status).toBe('succeeded')
    expect(job.result!.imported).toBe(600)
    expect(await notes()).toHaveLength(600)
  }, 25_000)

  it('root folder nests the default structure under it', async () => {
    const job = await runImport('conversations.json', CLAUDE_CONVERSATIONS, 'application/json', {
      root: 'Archive/2024',
    })
    expect(job.result!.imported).toBe(2)
    const paths = (await notes()).map((n) => n.filePath)
    expect(paths.every((p) => p.startsWith('Archive/2024/conversations/claude/'))).toBe(true)
  })

  it('rejects an invalid import root instead of aliasing it to the space root', async () => {
    for (const root of ['../escape', '.notarium/x', '/absolute']) {
      const response = await importFile('spec.md', '# Spec', 'text/markdown', {
        format: 'markdown',
        root,
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'bad import root' })
    }

    expect(await notes()).toHaveLength(0)
  })

  it('accepts an existing legacy POSIX-only folder as the import root', async () => {
    await app.close()
    app = await createApp({
      ...fixture(),
      spaces: [
        {
          slug: 'main',
          displayName: 'Main',
          notes: [{ title: 'Legacy', filePath: 'foo:bar/legacy.md', content: 'old' }],
        },
      ],
    })

    const job = await runImport('spec.md', '# Spec\n\nDetails.', 'text/markdown', {
      format: 'markdown',
      root: 'foo:bar',
    })

    expect(job.status).toBe('succeeded')
    expect((await notes()).map((note) => note.filePath)).toContain('foo:bar/spec.md')
  })

  it('does not create a new POSIX-only folder through the import root', async () => {
    const job = await runImport('spec.md', '# Spec\n\nDetails.', 'text/markdown', {
      format: 'markdown',
      root: 'foo:bar',
    })

    expect(job.status).toBe('succeeded')
    expect(job.result).toMatchObject({ imported: 0, failed: 1 })
    expect(await notes()).toHaveLength(0)
  })

  it('re-imports frozen Windows-device paths byte-for-byte without exposing them to public writes', async () => {
    const project = JSON.stringify([
      {
        uuid: 'legacy-device-project',
        name: 'CON',
        docs: [{ uuid: 'legacy-device-doc', filename: 'NUL.md', content: 'v1' }],
      },
    ])
    const first = await runImport('projects.json', project, 'application/json', {
      format: 'claude-projects',
    })

    expect(first.result).toMatchObject({ imported: 1, failed: 0 })
    expect((await notes()).map((note) => note.filePath)).toEqual(['projects/con/docs/nul.md'])

    const second = await runImport(
      'projects.json',
      project.replace('v1', 'v2'),
      'application/json',
      { format: 'claude-projects' },
    )

    expect(second.result).toMatchObject({ imported: 1, failed: 0 })
    expect((await notes()).map((note) => note.filePath)).toEqual(['projects/con/docs/nul.md'])
  })

  it('skipExisting skips notes that already exist instead of overwriting', async () => {
    await runImport('conversations.json', CLAUDE_CONVERSATIONS, 'application/json')
    const done = (
      await runImport('conversations.json', CLAUDE_CONVERSATIONS, 'application/json', {
        skipExisting: 'true',
      })
    ).result!
    expect(done.imported).toBe(0)
    expect(done.skipped).toBe(2)
    expect(await notes()).toHaveLength(2) // not duplicated, not overwritten
  })

  it('memory=skip drops memory entities; memory=space hides them in agent memory', async () => {
    // skip: nothing imported.
    const skipped = await runImport('memory.json', MEMORY_JSON, 'application/json', {
      memory: 'skip',
    })
    expect(skipped.result!.imported).toBe(0)
    expect(await notes()).toHaveLength(0)

    // space: imported but NOT visible in the default (user-scope) notes list.
    const space = await runImport('memory.json', MEMORY_JSON, 'application/json', {
      memory: 'space',
    })
    expect(space.result!.imported).toBe(2)
    // Written (imported=2) but HIDDEN from the user-visible list — the agent-memory
    // class is excluded by the read-model's visibility chokepoint (#78). The real
    // engine also relocates them under the `.notarium/memory` mount (verified live).
    expect(await notes()).toHaveLength(0)
  })

  it('lists the import under ?kind=import and keeps it out of the export list', async () => {
    await runImport('conversations.json', CLAUDE_CONVERSATIONS, 'application/json')
    const imports = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/s/main/jobs?kind=import' })).payload,
    ).jobs as WireJob[]
    expect(imports).toHaveLength(1)
    expect(imports[0].kind).toBe('import')
    expect(imports[0].status).toBe('succeeded')
    // The default (export) list must not surface the import — kind isolation.
    const exports = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/s/main/jobs?kind=export' })).payload,
    ).jobs as WireJob[]
    expect(exports).toHaveLength(0)
  })

  // ── DnD text-file import (#223) — the `markdown` format rides the same job ──

  it('imports a dropped markdown file as one note, title lifted from the leading H1', async () => {
    const job = await runImport('notes.md', '# My Note\n\nBody paragraph.\n', 'text/markdown', {
      format: 'markdown',
    })
    expect(job.status).toBe('succeeded')
    const sum = job.result!
    expect(sum.imported).toBe(1)
    expect(sum.failed).toBe(0)
    expect(sum.files[0].format).toBe('markdown')
    const list = await notes()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('My Note')
    // Storage filename is the slug of the SOURCE basename (idempotent per file).
    expect(list[0].filePath).toBe('notes.md')
    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${list[0].id}` })).payload,
    )
    expect(detail.content).toContain('Body paragraph.')
    expect(detail.content).not.toContain('My Note') // the H1 is lifted into the title, not left in the body
  })

  it('returns the created note id so a single drop can open it (#223)', async () => {
    const job = await runImport('welcome.md', '# Welcome\n\nhi', 'text/markdown', {
      format: 'markdown',
    })
    const list = await notes()
    expect(job.result!.created).toEqual([list[0].id])
  })

  it('titles a dropped .txt from its filename when there is no H1', async () => {
    await runImport('todo list.txt', 'buy milk\ncall Sam\n', 'text/plain', { format: 'markdown' })
    const list = await notes()
    expect(list[0].title).toBe('todo list')
    expect(list[0].filePath).toBe('todo-list.md')
  })

  // ── the dropped file's own frontmatter is its own data (#280) ──

  it('lifts title, tags and the creation date out of a dropped file’s frontmatter', async () => {
    await runImport(
      'dogovor.md',
      '---\ntitle: Договор\ntags: [работа, 2025]\ncreated: 2025-03-14\n---\n\nТело договора.\n',
      'text/markdown',
      { format: 'markdown' },
    )
    const list = await notes()
    expect(list[0].title).toBe('Договор')
    expect(list[0].createdAt).toBe('2025-03-14T00:00:00.000Z')
    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${list[0].id}` })).payload,
    )
    expect(detail.frontmatter.tags).toEqual(['работа', '2025'])
    expect(detail.content).toContain('Тело договора.')
    // The block itself never leaks into the body — it became metadata, not text.
    expect(detail.content).not.toContain('---')
  })

  it('keeps the keys it does not model — an imported file is still the author’s file', async () => {
    await runImport(
      'obsidian.md',
      '---\ntitle: Vault Note\naliases: [Old Name]\nauthor: Sergey\nmeta:\n  source: obsidian\n---\nBody.\n',
      'text/markdown',
      { format: 'markdown' },
    )
    const list = await notes()
    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${list[0].id}` })).payload,
    )
    expect(list[0].title).toBe('Vault Note')
    expect(detail.frontmatter.author).toBe('Sergey')
    // `aliases:` is re-derived into the alias history, so inbound [[Old Name]] resolve.
    expect(detail.frontmatter.aliases).toEqual(['Old Name'])
    // A nested map is honestly ABSENT from the parsed frontmatter (we model no
    // shape for it) yet must still be in the FILE — "we don't understand it" is not
    // a licence to delete it. The export is where the file itself is observable.
    const zip = new AdmZip(
      (await app.inject({ method: 'GET', url: '/api/s/main/export' })).rawPayload,
    )
    const file = zip.getEntry('obsidian.md')!.getData().toString('utf8')
    expect(file).toContain('meta:\n  source: obsidian')
    expect(file).toContain('author: Sergey')
    expect(file).toContain('title: Vault Note')
  })

  it('rejects non-durable bytes hidden in carried frontmatter', async () => {
    const job = await runImport(
      'poisoned.md',
      '---\nauthor: safe\0poison\n---\nBody.\n',
      'text/markdown',
      { format: 'markdown' },
    )

    expect(job.status).toBe('succeeded')
    expect(job.result).toMatchObject({ imported: 0, failed: 1 })
    expect(await notes()).toHaveLength(0)
  })

  it('fails oversized frontmatter terminally with the exact source-file reason', async () => {
    const job = await runImport('oversized.md', OVERSIZED_FRONTMATTER, 'text/markdown', {
      format: 'markdown',
    })

    expect(job.status).toBe('failed')
    expect(job.error).toBe(FRONTMATTER_LIMIT_REASON)
    expect(job.result).toBeNull()
    expect(await notes()).toHaveLength(0)
  })

  it('refreshes present foreign keys without deleting absent ones on re-import', async () => {
    await runImport(
      'shared.md',
      '---\ntitle: Shared\nauthor: Old\nkept: yes\n---\nFirst.\n',
      'text/markdown',
      { format: 'markdown' },
    )
    const second = await runImport(
      'shared.md',
      '---\ntitle: Shared\nauthor: New\n---\nSecond.\n',
      'text/markdown',
      { format: 'markdown' },
    )

    expect(second.result).toMatchObject({ imported: 1, failed: 0 })
    expect(await notes()).toHaveLength(1)
    const note = (await notes())[0]
    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${note.id}` })).payload,
    )
    expect(detail.frontmatter.author).toBe('New')
    expect(detail.frontmatter.kept).toBe('yes')
    expect(detail.content).toContain('Second.')
  })

  it('a frontmatter title wins over a differing H1, which stays in the body', async () => {
    await runImport(
      'exported.md',
      '---\ntitle: Real Title\ntags: [a]\n---\n# Draft heading\n\nContent.\n',
      'text/markdown',
      { format: 'markdown' },
    )
    const list = await notes()
    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${list[0].id}` })).payload,
    )
    expect(list[0].title).toBe('Real Title')
    expect(detail.content).toContain('# Draft heading') // nothing is dropped
    expect(detail.content).toContain('Content.')
  })

  it('dates a frontmatter-less drop by the file’s own mtime, not by the import moment', async () => {
    const mtime = Date.UTC(2019, 4, 5, 10)
    await runImport('old note.md', '# Old note\n\nBody.\n', 'text/markdown', {
      format: 'markdown',
      lastModified: String(mtime),
    })
    expect((await notes())[0].createdAt).toBe(new Date(mtime).toISOString())
  })

  it('ignores an implausible mtime — a future date would pin the note atop the Feed', async () => {
    const future = Date.now() + 365 * 24 * 3600 * 1000
    await runImport('skewed.md', '# Skewed\n\nBody.\n', 'text/markdown', {
      format: 'markdown',
      lastModified: String(future),
    })
    const createdAt = (await notes())[0].createdAt
    expect(createdAt).not.toBe(new Date(future).toISOString())
    expect(new Date(createdAt!).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('an authored date beats the file mtime', async () => {
    await runImport('dated.md', '---\ncreated: 2011-02-03\n---\nBody.\n', 'text/markdown', {
      format: 'markdown',
      lastModified: String(Date.UTC(2019, 4, 5)),
    })
    expect((await notes())[0].createdAt).toBe('2011-02-03T00:00:00.000Z')
  })

  it('drops the file into the target folder via root (#223 — where it was dropped)', async () => {
    await runImport('spec.md', '# Spec\n\nDetails.', 'text/markdown', {
      format: 'markdown',
      root: 'Frontend',
    })
    const list = await notes()
    expect(list[0].filePath).toBe('Frontend/spec.md')
  })

  it('re-dropping the same file is idempotent under skipExisting', async () => {
    await runImport('dup.md', '# Dup\n\nOne.', 'text/markdown', { format: 'markdown' })
    const job = await runImport('dup.md', '# Dup\n\nTwo (edited).', 'text/markdown', {
      format: 'markdown',
      skipExisting: 'true',
    })
    expect(job.result!.imported).toBe(0)
    expect(job.result!.skipped).toBe(1)
    expect(await notes()).toHaveLength(1) // same path, not duplicated
  })

  it('checks skipExisting before refusing YAML references, but rejects a fresh write', async () => {
    await runImport('anchored.md', '# Existing\n\nOriginal body.', 'text/markdown', {
      format: 'markdown',
    })
    const existing = (await notes())[0]
    const skipped = await runImport('anchored.md', ANCHORED_MARKDOWN, 'text/markdown', {
      format: 'markdown',
      skipExisting: 'true',
    })

    expect(skipped.status).toBe('succeeded')
    expect(skipped.result).toMatchObject({ imported: 0, skipped: 1, failed: 0, errors: [] })
    const unchanged = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${existing.id}` })).payload,
    )
    expect(unchanged.content).toContain('Original body.')
    expect(unchanged.content).not.toContain('New body.')

    const refused = await runImport('fresh-anchored.md', ANCHORED_MARKDOWN, 'text/markdown', {
      format: 'markdown',
      skipExisting: 'true',
    })

    expect(refused.status).toBe('succeeded')
    expect(refused.result).toMatchObject({
      imported: 0,
      skipped: 0,
      failed: 1,
      errors: [{ title: 'fresh-anchored', error: YAML_NODE_REFERENCE_WRITE_ERROR }],
    })
    expect(await notes()).toEqual([existing])
  })

  it('rejects a non-multipart request', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/s/main/import', payload: { x: 1 } })
    expect(res.statusCode).toBe(400)
  })
})

describe('import degradation (#191): a none-mode host falls back to the synchronous NDJSON stream', () => {
  let syncApp: FastifyInstance
  beforeEach(async () => {
    syncApp = await createApp({ ...fixture(), noJobs: true })
  })
  afterEach(async () => {
    await syncApp.close()
  })

  it('POST /import streams NDJSON (200) and imports, jobs routes 404', async () => {
    const res = await syncApp.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...multipart('conversations.json', CLAUDE_CONVERSATIONS, 'application/json'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/ndjson/)
    const { done } = ndjson(res.payload)
    expect(done!.imported).toBe(2)
    const list = JSON.parse(
      (await syncApp.inject({ method: 'GET', url: '/api/s/main/notes?limit=1000' })).payload,
    ).notes
    expect(list).toHaveLength(2)
    // No durable job layer → the jobs surface 404s (consistent capability signal).
    expect(
      (await syncApp.inject({ method: 'GET', url: '/api/s/main/jobs?kind=import' })).statusCode,
    ).toBe(404)
  })

  it('surfaces an unrecognised upload as an in-band NDJSON error line (200)', async () => {
    const res = await syncApp.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...multipart('random.json', '{"hello":"world"}', 'application/json'),
    })
    expect(res.statusCode).toBe(200)
    const { done, error } = ndjson(res.payload)
    expect(done).toBeUndefined()
    expect(error?.error).toMatch(/recognised/i)
  })

  it('surfaces oversized frontmatter with the same exact reason in sync mode', async () => {
    const res = await syncApp.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...multipart('oversized.md', OVERSIZED_FRONTMATTER, 'text/markdown', {
        format: 'markdown',
      }),
    })

    expect(res.statusCode).toBe(200)
    const { done, error } = ndjson(res.payload)
    expect(done).toBeUndefined()
    expect(error?.error).toBe(FRONTMATTER_LIMIT_REASON)
  })

  it('a dropped markdown file imports via the sync fallback too (#223)', async () => {
    const res = await syncApp.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...multipart('hello.md', '# Hello\n\nbody', 'text/markdown', { format: 'markdown' }),
    })
    expect(res.statusCode).toBe(200)
    const { done } = ndjson(res.payload)
    expect(done!.imported).toBe(1)
    expect(done!.created?.[0]).toBeTruthy() // the created id rides the sync summary too (open-after-import)
    const list = JSON.parse(
      (await syncApp.inject({ method: 'GET', url: '/api/s/main/notes?limit=1000' })).payload,
    ).notes
    expect(list[0].title).toBe('Hello')
    expect(list[0].filePath).toBe('hello.md')
  })

  it('the frontmatter lift and the mtime date work on the fallback too (#280)', async () => {
    // Degradation is by CAPABILITY (no job layer), never by behaviour: a none-mode
    // host must not quietly import worse notes than a durable one.
    const mtime = Date.UTC(2019, 4, 5, 10)
    const res = await syncApp.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...multipart(
        'vault.md',
        '---\ntitle: Vault\ntags: [a]\nauthor: S\n---\nbody',
        'text/markdown',
        {
          format: 'markdown',
          lastModified: String(mtime),
        },
      ),
    })
    expect(res.statusCode).toBe(200)
    expect(ndjson(res.payload).done!.imported).toBe(1)
    const list = JSON.parse(
      (await syncApp.inject({ method: 'GET', url: '/api/s/main/notes?limit=1000' })).payload,
    ).notes
    expect(list[0].title).toBe('Vault')
    expect(list[0].createdAt).toBe(new Date(mtime).toISOString())
    const detail = JSON.parse(
      (await syncApp.inject({ method: 'GET', url: `/api/s/main/note?ref=${list[0].id}` })).payload,
    )
    expect(detail.frontmatter.tags).toEqual(['a'])
    expect(detail.frontmatter.author).toBe('S')
  })

  it('checks skipExisting before YAML-reference refusal in the sync fallback too', async () => {
    const first = await syncApp.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...multipart('anchored.md', '# Existing\n\nOriginal body.', 'text/markdown', {
        format: 'markdown',
      }),
    })
    expect(ndjson(first.payload).done).toMatchObject({ imported: 1, failed: 0 })
    const existing = JSON.parse(
      (await syncApp.inject({ method: 'GET', url: '/api/s/main/notes?limit=1000' })).payload,
    ).notes[0] as { id: string; filePath: string }
    const skipped = await syncApp.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...multipart('anchored.md', ANCHORED_MARKDOWN, 'text/markdown', {
        format: 'markdown',
        skipExisting: 'true',
      }),
    })

    expect(ndjson(skipped.payload).done).toMatchObject({
      imported: 0,
      skipped: 1,
      failed: 0,
      errors: [],
    })
    const unchanged = JSON.parse(
      (await syncApp.inject({ method: 'GET', url: `/api/s/main/note?ref=${existing.id}` })).payload,
    )
    expect(unchanged.content).toContain('Original body.')
    expect(unchanged.content).not.toContain('New body.')

    const refused = await syncApp.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...multipart('fresh-anchored.md', ANCHORED_MARKDOWN, 'text/markdown', {
        format: 'markdown',
        skipExisting: 'true',
      }),
    })
    const refusedResult = ndjson(refused.payload)

    expect(refusedResult.error).toBeUndefined()
    expect(refusedResult.done).toMatchObject({
      imported: 0,
      skipped: 0,
      failed: 1,
      errors: [{ title: 'fresh-anchored', error: YAML_NODE_REFERENCE_WRITE_ERROR }],
    })
    const after = JSON.parse(
      (await syncApp.inject({ method: 'GET', url: '/api/s/main/notes?limit=1000' })).payload,
    ).notes as Array<{ id: string; filePath: string }>
    expect(after).toEqual([existing])
  })
})
