// The about-PROJECT memory axis (#13 I5/F4) end to end: the AGENT records memory
// ABOUT a project (remember_about_project → `.notarium/memory/<id>/`) and a space
// MEMBER audits it via the REST twin of /api/me/memory —
// GET /api/s/<slug>/projects/<id>/memory. Runs over the production buildApp (the
// REST space-corner AND the MCP gateway) with only the engine + persistence
// swapped (#18). The contrasts it pins: about-project surfaces with #12 provenance
// like about-user, but is SPACE-scoped (a member reads it, not just the author),
// it NEVER bleeds into the about-user feed (subdir isolation), sibling projects
// stay isolated, an archived project is still readable, and a foreign / unknown id
// answers the SAME 404 (anti-enumeration #16) — never confirming a project that
// lives in a space the caller can't reach.

import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp, fakeUserId, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-06-14T12:00:00.000Z',
  capabilities: { spaceCreate: true },
  spaces: [
    { slug: 'main', displayName: 'Main', notes: [] },
    // A space sam is NOT a member of — holds a project whose id sam must never
    // be able to confirm through main's endpoint.
    { slug: 'other', displayName: 'Other', notes: [] },
    { slug: 'sam-personal', displayName: 'Personal', notes: [] },
  ],
  // Marked-folder projects (#13). Default id = `proj-<space>-<slug>`, handle =
  // `<space>/<slug>`. `docs`/`api` are two siblings (isolation), `old` is archived
  // (readable, archive is a list filter), `other/secret` lives in a foreign space.
  projects: [
    { space: 'main', path: 'docs' },
    { space: 'main', path: 'api' },
    { space: 'main', path: 'old', status: 'archived' },
    { space: 'other', path: 'secret' },
  ],
  auth: {
    users: [
      {
        username: 'sam',
        password: 'sam-password-1',
        displayName: 'Sam',
        personalSpace: 'sam-personal',
      },
      // dana is a SECOND member of `main` — reads memory sam's agent wrote, to
      // exercise the cross-member privacy filter (#13).
      { username: 'dana', password: 'dana-password-1', displayName: 'Dana' },
      // mallory is a member of `other` only — exercises the cross-space read denial.
      { username: 'mallory', password: 'mallory-password-1', displayName: 'Mallory' },
    ],
    members: [
      { space: 'main', username: 'sam', role: 'owner' },
      { space: 'main', username: 'dana', role: 'reader' },
      { space: 'sam-personal', username: 'sam', role: 'owner' },
      { space: 'other', username: 'mallory', role: 'owner' },
    ],
  },
})

let app: FastifyInstance
let port: number

const listen = async (instance: FastifyInstance): Promise<number> => {
  await instance.listen({ port: 0, host: '127.0.0.1' })
  return (instance.server.address() as AddressInfo).port
}

beforeEach(async () => {
  app = await createApp(fixture())
  port = await listen(app)
})

afterEach(async () => {
  await app.close()
})

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } }

const callTool = async (
  name: string,
  args: Record<string, unknown>,
  bearer: string,
): Promise<Rpc> => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  return res.status === 200 ? ((await res.json()) as Rpc) : ({} as Rpc)
}
const isError = (r: Rpc): boolean => Boolean(r.result?.isError)

const loginCookie = async (username: string, password: string): Promise<string> => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: username, password },
  })
  expect(login.statusCode).toBe(200)
  return (login.headers['set-cookie'] as string).split(';')[0]
}

const patFor = async (username: string, password: string): Promise<string> => {
  const cookie = await loginCookie(username, password)
  const created = await app.inject({
    method: 'POST',
    url: '/api/me/tokens',
    headers: { cookie },
    payload: { name: 'write-token', scope: 'write' },
  })
  expect(created.statusCode).toBe(201)
  return created.json().token as string
}

const memoryOf = (space: string, id: string, cookie: string) =>
  app.inject({ method: 'GET', url: `/api/s/${space}/projects/${id}/memory`, headers: { cookie } })

describe('about-project memory (#13 I5): READ surface', () => {
  it('a project the agent recorded nothing about reads an empty feed (honest, not an error)', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const res = await memoryOf('main', 'proj-main-docs', cookie)
    expect(res.statusCode).toBe(200)
    expect(res.json().categories).toEqual([])
  })

  it('memory the agent recorded about a project surfaces to a member with #12 provenance', async () => {
    const bearer = await patFor('sam', 'sam-password-1')
    const w = await callTool(
      'remember_about_project',
      {
        project: 'main/docs',
        observation: 'Deploys go staging → prod and need two approvals.',
        category: 'deploy',
        summary: 'Staging then prod, 2 approvals.',
      },
      bearer,
    )
    expect(isError(w)).toBe(false)

    const cookie = await loginCookie('sam', 'sam-password-1')
    const mem = (await memoryOf('main', 'proj-main-docs', cookie)).json()
    expect(mem.categories).toHaveLength(1)
    const cat = mem.categories[0]
    expect(cat.category).toBe('deploy')
    expect(cat.summary).toBe('Staging then prod, 2 approvals.')
    // Provenance: an agent (PAT) wrote it — `pat:<user>:<id>`, kind 'write'.
    expect(cat.principal).toMatch(new RegExp(`^pat:${fakeUserId('sam')}:`))
    expect(cat.kind).toBe('write')
    // …resolved to a display author (#13): sam reads memory written by sam's OWN
    // key, so the key NAME shows and `mine` is true → the UI says "your agent
    // write-token". (Privacy for a foreign key is covered in the unit test.)
    expect(cat.author).toEqual({ kind: 'agent', name: 'write-token', mine: true })

    // Readable/editable by id (direct read is not visibility-scoped); class stays
    // agent-memory (#78) — the same trust story as about-user memory.
    const detail = (
      await app.inject({
        method: 'GET',
        url: `/api/note?id=${encodeURIComponent(cat.noteId)}`,
        headers: { cookie },
      })
    ).json()
    expect(detail.class).toBe('agent-memory')
    expect(detail.content).toContain('two approvals')
  })

  it('a DIFFERENT member reading it sees neither the raw principal nor the key name (cross-member privacy #13)', async () => {
    // sam's agent records about-project memory…
    const sam = await patFor('sam', 'sam-password-1')
    await callTool(
      'remember_about_project',
      {
        project: 'main/docs',
        observation: 'Internal: rotate creds quarterly.',
        category: 'security',
        summary: 'Quarterly rotation.',
      },
      sam,
    )
    // …and dana, another member of `main` (space:read), reads the project memory.
    const danaCookie = await loginCookie('dana', 'dana-password-1')
    const cat = (await memoryOf('main', 'proj-main-docs', danaCookie)).json().categories[0]

    // The raw principal (sam's pat id) is REDACTED for a non-owner…
    expect(cat.principal).toBeNull()
    // …and the author is attributed to the OWNER USERNAME, NEVER the key name.
    expect(cat.author).toEqual({ kind: 'agent', name: 'sam', mine: false })
    // Belt: sam's key name 'write-token' must appear nowhere in the payload.
    expect(JSON.stringify(cat)).not.toContain('write-token')
  })

  it('sibling projects in one space keep their memory isolated', async () => {
    const bearer = await patFor('sam', 'sam-password-1')
    await callTool(
      'remember_about_project',
      { project: 'main/docs', observation: 'x', category: 'docs-only' },
      bearer,
    )
    await callTool(
      'remember_about_project',
      { project: 'main/api', observation: 'y', category: 'api-only' },
      bearer,
    )

    const cookie = await loginCookie('sam', 'sam-password-1')
    const docs = (await memoryOf('main', 'proj-main-docs', cookie)).json()
    const apiMem = (await memoryOf('main', 'proj-main-api', cookie)).json()
    expect(docs.categories.map((c: { category: string }) => c.category)).toEqual(['docs-only'])
    expect(apiMem.categories.map((c: { category: string }) => c.category)).toEqual(['api-only'])
  })

  it('about-project memory never bleeds into the about-user feed (subdir isolation)', async () => {
    const bearer = await patFor('sam', 'sam-password-1')
    await callTool(
      'remember_about_project',
      { project: 'main/docs', observation: 'x', category: 'project-fact' },
      bearer,
    )
    await callTool('remember_about_user', { observation: 'y', category: 'user-fact' }, bearer)

    const cookie = await loginCookie('sam', 'sam-password-1')
    const userMem = (
      await app.inject({ method: 'GET', url: '/api/me/memory', headers: { cookie } })
    ).json()
    const projMem = (await memoryOf('main', 'proj-main-docs', cookie)).json()
    expect(userMem.categories.map((c: { category: string }) => c.category)).toEqual(['user-fact'])
    expect(projMem.categories.map((c: { category: string }) => c.category)).toEqual([
      'project-fact',
    ])
  })

  it('an archived project stays readable (archive is a list filter, not a read-lock)', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const res = await memoryOf('main', 'proj-main-old', cookie)
    expect(res.statusCode).toBe(200)
    expect(res.json().categories).toEqual([])
  })

  it('an unknown or foreign-space project id answers the same 404 (anti-enumeration #16)', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    // Unknown id under a space sam CAN read.
    expect((await memoryOf('main', 'proj-main-nope', cookie)).statusCode).toBe(404)
    // A real id, but it lives in `other` — must answer the SAME 404, never
    // confirming it exists in a space sam can't reach.
    const foreign = await memoryOf('main', 'proj-other-secret', cookie)
    expect(foreign.statusCode).toBe(404)
    expect(foreign.body).not.toContain('other')
  })

  it('a non-member cannot read another space’s project memory', async () => {
    // mallory is a member of `other`, not `main` — "no access" is the same 404 as
    // "no such space" (#10): the endpoint never confirms main exists to her.
    const cookie = await loginCookie('mallory', 'mallory-password-1')
    const res = await memoryOf('main', 'proj-main-docs', cookie)
    expect(res.statusCode).toBe(404)
  })
})

// The append's retry budget against a writer OUTSIDE the category fence (#341), on
// the production buildApp. N-sided interleaving is gated at the core level (where it
// is racy without any seam); what only the real stack can show is that a live MCP
// call survives a STREAM of foreign commits — and that the seam terminates, because
// the injected writer is not the one being held.
describe('about-project memory: append against a foreign writer', () => {
  /** Rebuild the host with a writer that lands `commits` of its own between the
   *  memory op's read and its write — each one costing the op exactly one CAS
   *  refusal. Anything an engine can't distinguish from a human editing in the UI. */
  const withForeignCommits = async (commits: number): Promise<void> => {
    await app.close()
    let injected = 0

    app = await createApp(fixture(), {
      configureWorld: ({ slug, store }) => {
        if (slug !== 'main') {
          return
        }
        const write = store.write.bind(store)
        const read = store.read.bind(store)

        store.write = async (input, opts) => {
          if (input.originalId && injected < commits) {
            injected += 1
            const live = await read(input.originalId)

            await write({
              title: live.title ?? '',
              content: `${live.content}\n\nforeign-${injected}`,
              originalId: input.originalId,
              versionToken: live.versionToken ?? '',
            })
          }

          return write(input, opts)
        }
      },
    })
    port = await listen(app)
  }

  const remember = (bearer: string, observation: string): Promise<Rpc> =>
    callTool(
      'remember_about_project',
      { project: 'main/docs', observation, category: 'deploy' },
      bearer,
    )

  const bodyOf = async (noteId: string): Promise<string> => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const res = await app.inject({
      method: 'GET',
      url: `/api/note?id=${encodeURIComponent(noteId)}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    return res.json().content as string
  }

  // 2 is the control: the pre-fix budget allowed three passes, so this one is green
  // on BOTH trees and proves the seam itself doesn't fail the call.
  it.each([2, 3, 4])('records the observation through %i foreign commits', async (commits) => {
    await withForeignCommits(commits)
    const bearer = await patFor('sam', 'sam-password-1')
    // The create is not intercepted (no originalId) — the append that follows is.
    expect(isError(await remember(bearer, 'first fact'))).toBe(false)
    const appended = await remember(bearer, 'second fact')

    expect(isError(appended)).toBe(false)
    const body = await bodyOf((appended.result?.structuredContent as { noteId: string }).noteId)

    expect(body.split('\n\n')).toEqual([
      'first fact',
      ...Array.from({ length: commits }, (_, i) => `foreign-${i + 1}`),
      'second fact',
    ])
  })
})
