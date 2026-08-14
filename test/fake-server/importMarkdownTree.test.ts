// Importing a Markdown TREE (#302) end to end over the production buildApp: a
// ZIP of `.md` files becomes notes that reproduce the archive's folders under
// the selected root, through the same durable job and the same write path every
// other import uses.
//
// The pins here are the ones a folder-shaped import can get wrong: the wrapper
// folder survives, empty directory records materialise nothing, a recognised
// foreign export still wins the archive, non-Markdown members are reported
// rather than silently dropped, and every structural refusal happens with ZERO
// notes written.

import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

const BOUNDARY = '----notariumtreeboundary'

const multipart = (filename: string, content: Buffer, fields: Record<string, string> = {}) => {
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
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
  )
  parts.push(content)
  parts.push(Buffer.from(`\r\n--${BOUNDARY}--\r\n`))

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  }
}

type Member = { name: string; body?: string; date?: Date }

const zipOf = (members: Member[]): Buffer => {
  const zip = new AdmZip()

  for (const member of members) {
    if (member.name.endsWith('/')) {
      zip.addFile(member.name, Buffer.alloc(0))
      continue
    }
    zip.addFile(member.name, Buffer.from(member.body ?? '', 'utf8'))
    if (member.date) {
      zip.getEntry(member.name)!.header.time = member.date
    }
  }

  return zip.toBuffer()
}

type Summary = {
  imported: number
  skipped: number
  failed: number
  files: Array<{
    file: string
    format: string
    imported: number
    skipped: number
    warnings?: string[]
  }>
  errors: Array<{ title?: string; error: string }>
  ignored?: { count: number; files: string[]; filesOmitted?: number }
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

const runImport = async (members: Member[], fields?: Record<string, string>): Promise<WireJob> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/s/main/import',
    ...multipart('vault.zip', zipOf(members), fields),
  })

  expect(res.statusCode).toBe(202)
  const enqueued = JSON.parse(res.payload) as WireJob
  let job = enqueued
  const deadline = Date.now() + 8_000

  while (!TERMINAL.has(job.status)) {
    if (Date.now() > deadline) {
      throw new Error(`import ${enqueued.id} stuck at ${job.status}`)
    }
    await new Promise((r) => setTimeout(r, 20))
    job = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/jobs/${enqueued.id}` })).payload,
    ) as WireJob
  }

  return job
}

const notes = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/s/main/notes?limit=1000' })

  return JSON.parse(res.payload).notes as Array<{
    id: string
    title: string
    filePath: string
    createdAt: string | null
  }>
}

const NOTE = (title: string) => `# ${title}\n\nBody of ${title}.\n`

describe('markdown tree import (#302)', () => {
  it('reproduces the archive tree under the root, keeping the wrapper folder', async () => {
    const job = await runImport(
      [
        { name: 'vault/' },
        { name: 'vault/inbox/' },
        { name: 'vault/index.md', body: NOTE('Index') },
        { name: 'vault/inbox/today.md', body: NOTE('Today') },
        { name: 'vault/projects/deep/spec.md', body: NOTE('Spec') },
      ],
      { root: 'imported' },
    )

    expect(job.status).toBe('succeeded')
    expect(job.result?.imported).toBe(3)
    expect((await notes()).map((n) => n.filePath).sort()).toEqual([
      'imported/vault/inbox/today.md',
      'imported/vault/index.md',
      'imported/vault/projects/deep/spec.md',
    ])
  })

  it('imports into the space root when no root is given', async () => {
    const job = await runImport([{ name: 'notes/a.md', body: NOTE('A') }])

    expect(job.status).toBe('succeeded')
    expect((await notes())[0].filePath).toBe('notes/a.md')
  })

  it('lifts the file frontmatter the same way a dropped .md does', async () => {
    const job = await runImport([
      {
        name: 'vault/note.md',
        body: '---\ntitle: Real Title\ntags: [alpha, beta]\ntype: spec\ncreated: 2019-05-04T10:00:00Z\nplugin-field: kept\n---\n\nBody.\n',
      },
    ])

    expect(job.status).toBe('succeeded')
    const [note] = await notes()

    expect(note.title).toBe('Real Title')
    expect(note.createdAt?.slice(0, 10)).toBe('2019-05-04')
    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${note.id}` })).payload,
    ) as { content: string; frontmatter: Record<string, unknown> }

    expect(detail.frontmatter.tags).toEqual(['alpha', 'beta'])
    expect(detail.frontmatter.type).toBe('spec')
    // An unmodelled key rides along verbatim (#280) — file-first, not ours to drop.
    expect(detail.frontmatter['plugin-field']).toBe('kept')
  })

  it('dates a note from the archive entry mtime when its frontmatter names none', async () => {
    const job = await runImport([
      { name: 'vault/old.md', body: NOTE('Old'), date: new Date('2021-07-08T09:10:00Z') },
    ])

    expect(job.status).toBe('succeeded')
    expect((await notes())[0].createdAt?.slice(0, 10)).toBe('2021-07-08')
  })

  it('reports non-Markdown members instead of dropping them silently', async () => {
    const job = await runImport([
      { name: 'vault/a.md', body: NOTE('A') },
      { name: 'vault/attachments/photo.png', body: 'PNG' },
      { name: 'vault/.obsidian/workspace.json', body: '{"x":1}' },
      { name: '__MACOSX/._a.md', body: 'noise' },
    ])

    expect(job.status).toBe('succeeded')
    expect(job.result?.imported).toBe(1)
    // Container noise is not a user file and is not counted as a loss.
    expect(job.result?.ignored?.count).toBe(2)
    expect([...(job.result?.ignored?.files ?? [])].sort()).toEqual([
      'vault/.obsidian/workspace.json',
      'vault/attachments/photo.png',
    ])
  })

  it('draws a determinate bar: the total is the planned member count', async () => {
    const job = await runImport([
      { name: 'a.md', body: NOTE('A') },
      { name: 'b.md', body: NOTE('B') },
      { name: 'c.md', body: NOTE('C') },
    ])

    expect(job.progress.total).toBe(3)
    expect(job.progress.done).toBe(3)
    expect(job.progress.phase).toBe('done')
  })

  it('still imports a recognised foreign export that ships .md files beside it', async () => {
    const conversations = JSON.stringify([
      {
        uuid: 'c-1',
        name: 'Planning',
        created_at: '2024-03-15T14:30:00Z',
        chat_messages: [
          { sender: 'human', created_at: '2024-03-15T14:30:00Z', text: 'Where should we go?' },
        ],
      },
    ])
    const job = await runImport([
      { name: 'conversations.json', body: conversations },
      { name: 'readme.md', body: NOTE('Readme') },
    ])

    expect(job.status).toBe('succeeded')
    const paths = (await notes()).map((n) => n.filePath)

    // The foreign importer owns the archive: its folder layout, and no note from
    // the stray Markdown member.
    expect(paths.every((p) => p.startsWith('conversations/claude/'))).toBe(true)
    expect(paths.some((p) => p.endsWith('readme.md'))).toBe(false)
  })

  // Which archive this is cannot depend on the order the zip lists its members
  // in. The `.md` here refuses the TREE — but the archive is not a tree, and the
  // export that wins it never needed that member read.
  it('lets the foreign export win even when an unplannable .md is listed first', async () => {
    const conversations = JSON.stringify([
      {
        uuid: 'c-1',
        name: 'Planning',
        created_at: '2024-03-15T14:30:00Z',
        chat_messages: [
          { sender: 'human', created_at: '2024-03-15T14:30:00Z', text: 'Where should we go?' },
        ],
      },
    ])
    const job = await runImport([
      { name: '.obsidian/templates/daily.md', body: NOTE('Template') },
      { name: 'conversations.json', body: conversations },
    ])

    expect(job.status).toBe('succeeded')
    expect((await notes()).every((n) => n.filePath.startsWith('conversations/claude/'))).toBe(true)
  })

  // An explicit foreign format answers the question classification asks, so the
  // archive's own members get no vote. The auto-probe recognises nothing here, so
  // the caller who named `claude-projects` gets that importer's honest empty
  // answer — not a Markdown tree built from a file they never mentioned.
  it('keeps the existing path when a foreign format is named outright', async () => {
    const job = await runImport(
      [
        { name: 'notes/stray.md', body: NOTE('Stray') },
        { name: 'data.json', body: '{"theme":"dark"}' },
      ],
      { format: 'claude-projects' },
    )

    expect(job.status).toBe('succeeded')
    expect(job.result?.files).toEqual([
      expect.objectContaining({ file: 'data.json', format: 'claude-projects', imported: 0 }),
    ])
    expect(await notes()).toEqual([])
  })

  it('fails the whole import with zero notes written on a destination collision', async () => {
    // Two distinct source files whose portable storage names normalise to the
    // same `my-note.md` — the exact case a per-file importer would silently
    // overwrite halfway through the run.
    const job = await runImport([
      { name: 'vault/a/my note.md', body: NOTE('One') },
      { name: 'vault/a/my-note.md', body: NOTE('Two') },
      { name: 'vault/good.md', body: NOTE('Good') },
    ])

    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/destination collision/)
    expect(await notes()).toEqual([])
  })

  it('fails with zero notes written when one member is unwritable', async () => {
    const job = await runImport([
      { name: 'vault/good.md', body: NOTE('Good') },
      { name: 'vault/bad.md', body: '---\nanchor: &a x\ncopy: *a\n---\nBody.\n' },
    ])

    expect(job.status).toBe('failed')
    expect(await notes()).toEqual([])
  })

  it('imports as a COPY: source identities never become the notes’ own', async () => {
    const job = await runImport([
      { name: 'vault/a.md', body: '---\nnotarium-id: src-alpha\n---\n# A\n\nAlpha.\n' },
      { name: 'vault/b.md', body: '---\nnotarium-id: src-beta\n---\n# B\n\nBeta.\n' },
    ])

    expect(job.status).toBe('succeeded')
    const imported = await notes()

    expect(imported).toHaveLength(2)
    expect(imported.map((n) => n.id)).not.toContain('src-alpha')
    expect(imported.map((n) => n.id)).not.toContain('src-beta')
    // The claim is not smuggled into the file either — the write path mints ours.
    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${imported[0].id}` })).payload,
    ) as { content: string }

    expect(detail.content).not.toContain('src-alpha')
  })

  it('repoints exact links between two notes of the same archive at their copies', async () => {
    const job = await runImport([
      {
        name: 'vault/a.md',
        body: '---\nnotarium-id: src-alpha\n---\n# A\n\nSee [[notarium-id:src-beta|Beta]] and `[[notarium-id:src-beta]]`.\n',
      },
      {
        name: 'vault/b.md',
        body: '---\nnotarium-id: src-beta\n---\n# B\n\nBack to [[notarium-id:src-alpha]] and [[notarium-id:elsewhere]].\n',
      },
    ])

    expect(job.status).toBe('succeeded')
    const imported = await notes()
    const idOf = (path: string) => imported.find((n) => n.filePath === path)!.id
    const contentOf = async (path: string) =>
      (
        JSON.parse(
          (await app.inject({ method: 'GET', url: `/api/s/main/note?ref=${idOf(path)}` })).payload,
        ) as { content: string }
      ).content

    const a = await contentOf('vault/a.md')
    const b = await contentOf('vault/b.md')

    expect(a).toContain(`[[notarium-id:${idOf('vault/b.md')}|Beta]]`)
    expect(b).toContain(`[[notarium-id:${idOf('vault/a.md')}]]`)
    // A copy inside a code span is the author's text, not a link: byte-identical.
    expect(a).toContain('`[[notarium-id:src-beta]]`')
    // An identity outside this archive is not ours to repoint.
    expect(b).toContain('[[notarium-id:elsewhere]]')
  })

  // An unreadable claim imports as an ordinary note under a fresh identity — the
  // right outcome, but a silent one would leave the user to discover on their own
  // that every link naming that id now goes nowhere.
  it('says out loud when a file named an identity it could not use', async () => {
    const job = await runImport([
      { name: 'vault/a.md', body: '---\nnotarium-id: [not, a, scalar]\n---\n# A\n\nAlpha.\n' },
    ])

    expect(job.status).toBe('succeeded')
    expect(job.result?.imported).toBe(1)
    expect(job.result?.files[0].warnings).toEqual([expect.stringMatching(/unreadable notarium-id/)])
    expect((await notes())[0].id).toBeTruthy()
  })

  it('refuses an archive where two files claim one identity', async () => {
    const job = await runImport([
      { name: 'vault/a.md', body: '---\nnotarium-id: same-id\n---\n# A\n\nAlpha.\n' },
      { name: 'vault/b.md', body: '---\nnotarium-id: same-id\n---\n# B\n\nBeta.\n' },
    ])

    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/duplicate/)
    expect(await notes()).toEqual([])
  })

  it('keeps an existing destination’s identity when a re-import overwrites it', async () => {
    const members = [
      { name: 'vault/a.md', body: '---\nnotarium-id: src-alpha\n---\n# A\n\nAlpha.\n' },
    ]

    await runImport(members)
    const before = await notes()

    await runImport([{ ...members[0], body: '---\nnotarium-id: src-alpha\n---\n# A\n\nEdited.\n' }])
    const after = await notes()

    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(before[0].id)
  })

  it('is idempotent: a re-import overwrites the same files and creates no duplicates', async () => {
    const members = [
      { name: 'vault/a.md', body: NOTE('A') },
      { name: 'vault/sub/b.md', body: NOTE('B') },
    ]

    expect((await runImport(members)).status).toBe('succeeded')
    const first = await notes()

    expect((await runImport(members)).status).toBe('succeeded')
    const second = await notes()

    expect(second.map((n) => n.filePath).sort()).toEqual(first.map((n) => n.filePath).sort())
  })

  it('skips existing notes instead of overwriting when asked', async () => {
    const members = [{ name: 'vault/a.md', body: NOTE('A') }]

    await runImport(members)
    const job = await runImport(members, { skipExisting: 'true' })

    expect(job.result?.skipped).toBe(1)
    expect(job.result?.imported).toBe(0)
    expect(await notes()).toHaveLength(1)
  })
})
