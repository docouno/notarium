// The init-context PULT (#165) end to end: the human curates what the agent loads
// at session start, and the SAME assembly the agent sees (start_session) drives the
// web preview (the REST agent-context endpoints). Runs over the production buildApp
// (REST space-corner + /api/me + the MCP gateway) with only the engine swapped (#18).
//
// What it pins:
//   - PERSONAL pins: a personal-domain user-doc tagged `always-load` is the
//     profile's alwaysLoad — surfaced identically by GET /api/me/agent-context AND
//     start_session's profile.alwaysLoad (one shared scan).
//   - PROJECT pins: a note in a project's subtree tagged `always-load` is the
//     project's per-project axis — GET …/projects/<id>/agent-context AND
//     start_session(project).project.alwaysLoad. Anti-enumeration 404 like memory.
//   - PIN write: PUT /api/note/pin toggles the tag; the preview/profile follow.
//   - MUTE write: PUT /api/note/mute keeps a memory category in the audit
//     (/api/me/memory shows muted:true) but DROPS it from the agent's eager profile.

import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { encodeAbilityLocator, estimateTokens } from '@notarium/core'
import { PERSONAL_TOKEN_BUDGET, PROJECT_TOKEN_BUDGET } from '@notarium/server'

import { createApp, type Fixture } from './app.js'

const customResearch = {
  source: 'custom' as const,
  name: 'research',
  description: 'Investigate a question with explicit evidence.',
  instructions: '# Research\n\nResearch the evidence before deciding.',
}

const fixture = (): Fixture => ({
  now: '2026-06-23T12:00:00.000Z',
  capabilities: { spaceCreate: true },
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        // A project-subtree pin + a plain sibling under `docs` (the project below).
        {
          id: 'fake-pin-docs',
          title: 'Deploy Runbook',
          class: 'user-doc',
          filePath: 'docs/deploy.md',
          tags: ['always-load'],
          content: 'staging then prod',
        },
        {
          id: 'fake-plain-docs',
          title: 'Docs Readme',
          class: 'user-doc',
          filePath: 'docs/readme.md',
          content: 'intro',
        },
      ],
    },
    // A space sam is NOT a member of — its project id must never confirm via main.
    { slug: 'other', displayName: 'Other', notes: [] },
    {
      slug: 'sam-personal',
      displayName: 'Personal',
      notes: [
        // A personal pin + a plain personal note (only the tagged one is a profile pin).
        {
          id: 'fake-pin-me',
          title: 'My Always Note',
          class: 'user-doc',
          filePath: 'always.md',
          tags: ['always-load'],
          content: 'load me',
        },
        {
          id: 'fake-plain-me',
          title: 'Scratch',
          class: 'user-doc',
          filePath: 'scratch.md',
          content: 'noise',
        },
      ],
    },
  ],
  projects: [
    { space: 'main', path: 'docs' },
    { space: 'other', path: 'secret' },
  ],
  agentRoles: [
    { ...customResearch, target: { kind: 'personal', user: 'sam' } },
    { ...customResearch, target: { kind: 'project', space: 'main', path: 'docs' } },
  ],
  auth: {
    users: [
      {
        username: 'sam',
        password: 'sam-password-1',
        displayName: 'Sam',
        personalSpace: 'sam-personal',
      },
      {
        username: 'robin',
        password: 'robin-password-1',
        displayName: 'Robin',
      },
      { username: 'mallory', password: 'mallory-password-1', displayName: 'Mallory' },
    ],
    members: [
      { space: 'main', username: 'sam', role: 'owner' },
      { space: 'main', username: 'robin', role: 'reader' },
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

type Rpc = { result?: { structuredContent?: Record<string, unknown>; isError?: boolean } }

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
const structured = (r: Rpc): Record<string, unknown> => r.result?.structuredContent ?? {}

const loginCookie = async (username: string, password: string): Promise<string> => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
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

const getJson = async (url: string, cookie: string) =>
  (await app.inject({ method: 'GET', url, headers: { cookie } })).json()
const putJson = (url: string, body: unknown, cookie: string) =>
  app.inject({ method: 'PUT', url, headers: { cookie }, payload: body as Record<string, unknown> })
const sendJson = (method: 'POST' | 'PUT' | 'DELETE', url: string, cookie: string, body?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie },
    payload: (body ?? {}) as Record<string, unknown>,
  })

const exactRole = async (
  cookie: string,
  scope: 'personal' | 'space' | 'project',
  projectId?: string,
): Promise<string> => {
  const context = await getJson(
    projectId ? `/api/s/main/projects/${projectId}/agent-context` : '/api/me/agent-context',
    cookie,
  )
  const role = (context.roles as Array<{ name: string; scope: string; locator: never }>).find(
    (candidate) => candidate.name === 'research' && candidate.scope === scope,
  )

  expect(role).toBeDefined()
  return encodeAbilityLocator(role!.locator)
}

const makeSet = async (
  cookie: string,
  homeSpace: string,
  name: string,
  items: Array<[string, string]>,
): Promise<string> => {
  const created = await sendJson('POST', `/api/s/${homeSpace}/context-sets`, cookie, { name })
  expect(created.statusCode).toBe(200)
  const id = created.json().set.id as string

  for (const [space, noteId] of items) {
    const added = await sendJson('POST', `/api/s/${homeSpace}/context-sets/${id}/items`, cookie, {
      space,
      noteId,
    })
    expect(added.statusCode).toBe(200)
  }

  return id
}

describe('agent-context pult (#165): preview', () => {
  it('PERSONAL agent-context lists the personal-domain always-load pins, not plain notes', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor('sam', 'sam-password-1')
    const ctx = await getJson('/api/me/agent-context', cookie)
    const pins = ctx.pins as Array<{ noteId: string; loaded: boolean }>
    const pinIds = pins.map((p) => p.noteId)
    expect(pinIds).toContain('fake-pin-me')
    expect(pinIds).not.toContain('fake-plain-me')
    expect(pins.every((p) => p.loaded)).toBe(true)
    // The pult's loaded pins are EXACTLY the agent's profile.alwaysLoad (one shared scan,
    // minus the reserved profile note which isn't saved here) — no re-derivation.
    const mcp = (
      structured(await callTool('start_session', {}, bearer)).profile as {
        alwaysLoad: Array<{ noteId: string }>
      }
    ).alwaysLoad.map((p) => p.noteId)
    expect(mcp).toContain('fake-pin-me')
  })

  it('PERSONAL agent-context trims pins by the TOKEN budget, not an item count (#208)', async () => {
    await app.close()
    const f = fixture()
    const personal = f.spaces.find((s) => s.slug === 'sam-personal')!
    // Five heavy pins, each ~30% of the ONE personal budget: three fit (≈90%), the
    // fourth would overflow, so the eager set is token-bounded — a strict prefix, not
    // a fixed count. `'a'.repeat(n*4)` is n ASCII tokens (≈4 chars/token). No memory
    // here, so the whole budget is the pins'.
    const perPinTokens = Math.floor(PERSONAL_TOKEN_BUDGET * 0.3)
    personal.notes = Array.from({ length: 5 }, (_, i) => ({
      id: `fake-pin-${i + 1}`,
      title: `Pinned ${i + 1}`,
      class: 'user-doc',
      filePath: `pin-${i + 1}.md`,
      tags: ['always-load'],
      content: 'a'.repeat(perPinTokens * 4),
    }))
    app = await createApp(f)
    port = await listen(app)

    const cookie = await loginCookie('sam', 'sam-password-1')
    const ctx = await getJson('/api/me/agent-context', cookie)
    const pins = ctx.pins as Array<{ noteId: string; loaded: boolean; tokens: number }>
    // Each pin weighs ~perPinTokens; three fit under the budget, two are trimmed.
    expect(pins).toHaveLength(5)
    expect(pins.every((p) => p.tokens >= perPinTokens - 2)).toBe(true)
    // Loaded is a strict prefix — the first three, then trimmed.
    expect(pins.filter((p) => p.loaded)).toHaveLength(3)
    expect(pins.slice(0, 3).every((p) => p.loaded)).toBe(true)
    expect(pins.slice(3).every((p) => !p.loaded)).toBe(true)
    // Token totals: loaded ≤ the ONE budget < loaded + one more pin; totals across five.
    expect(ctx.budgetTokens).toBe(PERSONAL_TOKEN_BUDGET)
    expect(ctx.loadedTokens).toBeLessThanOrEqual(ctx.budgetTokens)
    expect(ctx.loadedTokens + perPinTokens).toBeGreaterThan(ctx.budgetTokens)
  })

  it('PERSONAL agent-context: pins load first, then memory rides the SAME budget — over-budget pins trim ALL memory (#208 memory[].loaded)', async () => {
    await app.close()
    const f = fixture()
    const personal = f.spaces.find((s) => s.slug === 'sam-personal')!
    // Three pins ~40% of P each → the first two fit, the third overflows the ONE budget.
    const perPinTokens = Math.floor(PERSONAL_TOKEN_BUDGET * 0.4)
    personal.notes = Array.from({ length: 3 }, (_, i) => ({
      id: `fat-pin-${i + 1}`,
      title: `Fat ${i + 1}`,
      class: 'user-doc',
      filePath: `fat-${i + 1}.md`,
      tags: ['always-load'],
      content: 'a'.repeat(perPinTokens * 4),
    }))
    app = await createApp(f)
    port = await listen(app)

    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor('sam', 'sam-password-1')
    // A couple of memory categories — they queue AFTER the pins under the single budget.
    await callTool(
      'remember_about_user',
      { observation: 'prefers RU', category: 'lang', summary: 'RU' },
      bearer,
    )
    await callTool(
      'remember_about_user',
      { observation: 'uses vim', category: 'editor', summary: 'vim' },
      bearer,
    )

    const ctx = await getJson('/api/me/agent-context', cookie)
    expect(ctx.budgetTokens).toBe(PERSONAL_TOKEN_BUDGET)
    // Pins load FIRST: two fit the budget, the third is trimmed.
    expect((ctx.pins as Array<{ loaded: boolean }>).filter((p) => p.loaded)).toHaveLength(2)
    // Memory rides the SAME budget behind the pins — already spent, so every category is
    // trimmed (loaded:false), exactly what the pult's memory bars must show.
    const memory = ctx.memory as Array<{ noteId: string; loaded: boolean }>
    expect(memory.length).toBeGreaterThanOrEqual(2)
    expect(memory.every((m) => !m.loaded)).toBe(true)
  })

  it('PERSONAL agent-context finds pins past a large unpinned prefix', async () => {
    await app.close()
    const f = fixture()
    const personal = f.spaces.find((s) => s.slug === 'sam-personal')!
    personal.notes = [
      ...Array.from({ length: 105 }, (_, i) => ({
        id: `fake-plain-${i + 1}`,
        title: `Plain ${i + 1}`,
        class: 'user-doc' as const,
        filePath: `plain-${String(i + 1).padStart(3, '0')}.md`,
        content: `plain ${i + 1}`,
      })),
      {
        id: 'fake-late-pin',
        title: 'Late Pin',
        class: 'user-doc' as const,
        filePath: 'zz-late-pin.md',
        tags: ['always-load'],
        content: 'late but pinned',
      },
    ]
    app = await createApp(f)
    port = await listen(app)

    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor('sam', 'sam-password-1')
    const ctx = await getJson('/api/me/agent-context', cookie)
    expect((ctx.pins as Array<{ noteId: string }>).map((p) => p.noteId)).toContain('fake-late-pin')
    const profile = (
      structured(await callTool('start_session', {}, bearer)).profile as {
        alwaysLoad: Array<{ noteId: string }>
      }
    ).alwaysLoad.map((p) => p.noteId)
    expect(profile).toContain('fake-late-pin')
  })

  it('PERSONAL agent-context includes the reserved profile note in alwaysLoad, not editable pins', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const saved = await putJson(
      '/api/me/profile',
      { content: '# About Sam\n\nloads first' },
      cookie,
    )
    expect(saved.statusCode).toBe(200)
    const profileNoteId = saved.json().noteId as string
    const bearer = await patFor('sam', 'sam-password-1')

    const ctx = await getJson('/api/me/agent-context', cookie)
    const mcpAlwaysLoad = (
      structured(await callTool('start_session', {}, bearer)).profile as {
        alwaysLoad: Array<{ noteId: string; title: string }>
      }
    ).alwaysLoad
    // The reserved profile note leads the AGENT's alwaysLoad (loaded first, off the
    // budget) but never shows as an editable pin in the pult…
    expect(mcpAlwaysLoad.map((p) => p.noteId)[0]).toBe(profileNoteId)
    expect((ctx.pins as Array<{ noteId: string }>).map((p) => p.noteId)).not.toContain(
      profileNoteId,
    )
    // …and the pult's loaded pins are exactly the agent's alwaysLoad MINUS that note.
    expect(
      (ctx.pins as Array<{ noteId: string; loaded: boolean }>)
        .filter((p) => p.loaded)
        .map((p) => p.noteId),
    ).toEqual(mcpAlwaysLoad.slice(1).map((p) => p.noteId))
  })

  it('PROJECT agent-context lists project pins + embedded personal + the auto index (#208)', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const ctx = await getJson('/api/s/main/projects/proj-main-docs/agent-context', cookie)
    // The PROJECT's own pins load first under the ONE project budget Q (#210: each pin carries
    // its position `order` in the scope's pin+set list — here the single pin sits at 0).
    expect(
      ctx.pins as Array<{ noteId: string; loaded: boolean; tokens: number; order: number }>,
    ).toEqual([
      {
        noteId: 'fake-pin-docs',
        title: 'Deploy Runbook',
        loaded: true,
        tokens: estimateTokens('staging then prod'),
        order: 0,
      },
    ])
    expect(ctx.projectLoadedTokens).toBe(estimateTokens('staging then prod'))
    expect(ctx.budgetTokens).toBe(PROJECT_TOKEN_BUDGET)
    // The PERSONAL background embeds into Q's remainder — sam's personal pin rides along.
    const personalPinIds = (ctx.personal.pins as Array<{ noteId: string; loaded: boolean }>).map(
      (p) => p.noteId,
    )
    expect(personalPinIds).toContain('fake-pin-me')
    // The joint scale: project + personal fit, so loaded > the project part alone.
    expect(ctx.loadedTokens).toBeGreaterThan(ctx.projectLoadedTokens)
    expect(ctx.loadedTokens).toBeLessThanOrEqual(ctx.budgetTokens)
    // Two user-docs live under docs/ → the auto index reports the subtree count.
    expect(ctx.index.noteCount).toBe(2)
    expect(typeof ctx.index.folderCount).toBe('number')

    // A cover is not one of them. This number is the pult's promise to show exactly what
    // the agent loads, so it has to answer the way `start_session` does — otherwise the
    // two halves of one claim disagree by the number of pages in the subtree.
    const page = await app.inject({
      method: 'POST',
      url: '/api/s/main/folders/page',
      headers: { cookie },
      payload: { folderPath: 'docs' },
    })
    expect(page.statusCode).toBe(201)
    const withPage = await getJson('/api/s/main/projects/proj-main-docs/agent-context', cookie)
    expect(withPage.index.noteCount).toBe(2)
  })

  it('a token narrowed away from personal gets the project axis but no embedded personal background (#395)', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    // Read PAT narrowed to the WORK space only — sam-personal is out of reach.
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie },
      payload: { name: 'narrowed', scope: 'read', spaces: ['main'] },
    })
    expect(created.statusCode).toBe(201)
    const bearer = created.json().token as string
    const ctx = (
      await app.inject({
        method: 'GET',
        url: '/api/s/main/projects/proj-main-docs/agent-context',
        headers: { authorization: `Bearer ${bearer}` },
      })
    ).json()
    // The project's own axis still loads (main is in reach)…
    expect((ctx.pins as Array<{ noteId: string }>).map((p) => p.noteId)).toContain('fake-pin-docs')
    // …but the embedded personal background is empty — narrowing hid sam-personal.
    expect(ctx.personal.pins).toEqual([])
    expect(ctx.personal.memory).toEqual([])
  })

  it('PROJECT agent-context answers the same 404 for an unknown or foreign-space id (anti-enum #16)', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/s/main/projects/proj-main-nope/agent-context',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404)
    const foreign = await app.inject({
      method: 'GET',
      url: '/api/s/main/projects/proj-other-secret/agent-context',
      headers: { cookie },
    })
    expect(foreign.statusCode).toBe(404)
    expect(foreign.body).not.toContain('secret')
  })

  it('the ROLE-IDENTITY door answers the same 404 for an unknown or foreign project id (anti-enum #16)', async () => {
    // The same rule as the door above, on the door that grew a `?project=` of its own.
    // It reached the registry raw, so the parameter told a non-member two things it may
    // not know: that an id exists at all, and the slug of the space holding it.
    //
    // Asked on a PROJECT-scoped role on purpose. `project` is the only word this answer
    // has for a placement, and the producer grows it in the project arm alone: asked on
    // a personal role, "and it names nothing" is unfalsifiable by construction — the
    // field is absent under every behaviour, including the one it exists to forbid.
    const cookie = await loginCookie('sam', 'sam-password-1')
    const projectRole = await exactRole(cookie, 'project', 'proj-main-docs')
    const ask = (project: string) =>
      app.inject({
        method: 'GET',
        url: `/api/me/agent-roles/${projectRole}/context?project=${project}`,
        headers: { cookie },
      })
    const readable = await ask('proj-main-docs')
    const unknown = await ask('proj-main-nope')
    const foreign = await ask('proj-other-secret')

    // The world where the subject exists, read first so the negations below are read
    // against an answer that demonstrably CAN name a project: asked about one it may
    // read, this door names it, in the words a handle is spelled in.
    expect(readable.statusCode, readable.body).toBe(200)
    expect(readable.json().role.project).toBe('main/docs')

    expect(unknown.statusCode, unknown.body).toBe(404)
    // The refusal carries neither word that identifies the project the caller may not
    // know about — the slug of the space holding it, and the path that names it. Both
    // are spellings this very field has printed: it held the ASKED project's space slug
    // before it was made to read the addressed placement instead. The slug is matched as
    // a whole JSON value, since `other` is a substring of ordinary English; the path is
    // matched bare, so it is caught inside a handle too. Read before the
    // indistinguishability claim below, so each of the two is the first to observe its
    // own defect.
    expect(foreign.body).not.toContain('"other"')
    expect(foreign.body).not.toContain('secret')
    // And it is indistinguishable from the unknown one in BOTH halves of the answer,
    // asserted as one value so neither half can be the only one read: a refusal that can
    // be told apart IS the oracle, whether or not it also discloses a name.
    expect({ status: foreign.statusCode, body: foreign.body }).toEqual({
      status: unknown.statusCode,
      body: unknown.body,
    })
    // …and the door still answers about the role itself when nothing is claimed — the
    // same role, in the same words, as the preview door that stands in its project.
    expect((await getJson(`/api/me/agent-roles/${projectRole}/context`, cookie)).role.name).toBe(
      (
        await getJson(
          `/api/s/main/projects/proj-main-docs/agent-context?role=${projectRole}`,
          cookie,
        )
      ).role.name,
    )
  })

  it('names the project the ROLE stands in, in the words the preview door uses', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const projectRole = await exactRole(cookie, 'project', 'proj-main-docs')
    const preview = await getJson(
      `/api/s/main/projects/proj-main-docs/agent-context?role=${projectRole}`,
      cookie,
    )
    const named = await getJson(`/api/me/agent-roles/${projectRole}/context`, cookie)

    // One role, one place, one spelling. This field held a raw registry id when asked
    // without a project, a SPACE slug when asked with one, and the handle here — three
    // answers about the same placement, and no reader to notice.
    expect(preview.role.project).toBeDefined()
    expect(named.role.project).toBe(preview.role.project)
    expect(named.role.space).toBe(preview.role.space)
  })

  it('a non-member cannot read another space’s project agent-context (404, #10)', async () => {
    const cookie = await loginCookie('mallory', 'mallory-password-1')
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/s/main/projects/proj-main-docs/agent-context',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404)
  })
})

describe('owned role context (#308)', () => {
  it('keeps role sets and order on their exact placement, detaches, and guards ownership', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const personalRole = await exactRole(cookie, 'personal')
    const projectRole = await exactRole(cookie, 'project', 'proj-main-docs')
    const sharedSet = await makeSet(cookie, 'main', 'Role sources', [['main', 'fake-pin-docs']])
    const personalSet = await makeSet(cookie, 'sam-personal', 'Private sources', [
      ['sam-personal', 'fake-plain-me'],
    ])

    expect(
      (
        await putJson(
          `/api/me/agent-roles/${personalRole}/context-pins`,
          { space: 'sam-personal', noteId: 'fake-plain-me' },
          cookie,
        )
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await putJson(
          `/api/me/agent-roles/${projectRole}/context-pins`,
          { space: 'main', noteId: 'fake-plain-docs' },
          cookie,
        )
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await sendJson(
          'PUT',
          `/api/me/agent-roles/${personalRole}/context-sets/${sharedSet}`,
          cookie,
        )
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await sendJson(
          'PUT',
          `/api/me/agent-roles/${projectRole}/context-sets/${sharedSet}`,
          cookie,
        )
      ).statusCode,
    ).toBe(200)

    expect(
      (
        await putJson(
          `/api/me/agent-roles/${personalRole}/context-order`,
          {
            entries: [
              { kind: 'set', ref: sharedSet },
              { kind: 'pin', ref: 'fake-plain-me' },
            ],
          },
          cookie,
        )
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await putJson(
          `/api/me/agent-roles/${projectRole}/context-order`,
          {
            entries: [
              { kind: 'pin', ref: 'fake-plain-docs' },
              { kind: 'set', ref: sharedSet },
            ],
          },
          cookie,
        )
      ).statusCode,
    ).toBe(200)

    const personal = await getJson(`/api/me/agent-context?role=${personalRole}`, cookie)
    expect(personal.role).toMatchObject({
      scope: 'personal',
      pins: [expect.objectContaining({ noteId: 'fake-plain-me', order: 1 })],
      sets: [
        expect.objectContaining({
          id: sharedSet,
          order: 0,
          items: [expect.objectContaining({ noteId: 'fake-pin-docs', loaded: true })],
        }),
      ],
    })
    const project = await getJson(
      `/api/s/main/projects/proj-main-docs/agent-context?role=${projectRole}`,
      cookie,
    )
    expect(project.role).toMatchObject({
      scope: 'project',
      pins: [expect.objectContaining({ noteId: 'fake-plain-docs', order: 0 })],
      sets: [expect.objectContaining({ id: sharedSet, order: 1 })],
    })

    expect(
      (
        await sendJson(
          'DELETE',
          `/api/me/agent-roles/${projectRole}/context-sets/${sharedSet}`,
          cookie,
        )
      ).statusCode,
    ).toBe(200)
    const projectAfterDetach = await getJson(
      `/api/s/main/projects/proj-main-docs/agent-context?role=${projectRole}`,
      cookie,
    )
    expect(projectAfterDetach.role.sets).toEqual([])
    const personalAfterDetach = await getJson(`/api/me/agent-context?role=${personalRole}`, cookie)
    expect(personalAfterDetach.role.sets).toEqual([
      expect.objectContaining({ id: sharedSet, order: 0 }),
    ])

    const rejected = await sendJson(
      'PUT',
      `/api/me/agent-roles/${projectRole}/context-sets/${personalSet}`,
      cookie,
    )
    expect(rejected.statusCode).toBe(400)
    expect(rejected.body).toContain('personal set cannot be attached to a shared role')
  })

  it('keeps same-name role placements independent and sends the effective preset through MCP', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor('sam', 'sam-password-1')
    const projects = await getJson('/api/s/main/projects', cookie)
    const docs = (projects.projects as Array<{ id: string; slug: string }>).find(
      (project) => project.slug === 'docs',
    )!
    const personalRole = await exactRole(cookie, 'personal')
    const projectRole = await exactRole(cookie, 'project', docs.id)

    expect(
      (
        await putJson(
          `/api/me/agent-roles/${personalRole}/context-pins`,
          { space: 'sam-personal', noteId: 'fake-plain-me' },
          cookie,
        )
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await putJson(
          `/api/me/agent-roles/${projectRole}/context-pins`,
          { space: 'main', noteId: 'fake-plain-docs' },
          cookie,
        )
      ).statusCode,
    ).toBe(200)

    const base = await getJson('/api/me/agent-context', cookie)
    expect(base.roles).toEqual([expect.objectContaining({ name: 'research', scope: 'personal' })])
    expect(base.role).toBeUndefined()

    const personal = await getJson(`/api/me/agent-context?role=${personalRole}`, cookie)
    expect(personal.role).toMatchObject({
      name: 'research',
      scope: 'personal',
      pins: [expect.objectContaining({ noteId: 'fake-plain-me' })],
    })
    const project = await getJson(
      `/api/s/main/projects/${docs.id}/agent-context?role=${projectRole}`,
      cookie,
    )
    expect(project.role).toMatchObject({
      name: 'research',
      scope: 'project',
      pins: [expect.objectContaining({ noteId: 'fake-plain-docs' })],
    })
    expect(project.role.pins.map((pin: { noteId: string }) => pin.noteId)).not.toContain(
      'fake-plain-me',
    )

    const started = structured(
      await callTool(
        'start_session',
        { project: 'main/docs', role: 'research', responseFormat: 'detailed' },
        bearer,
      ),
    )
    expect(started.activeRole).toMatchObject({
      role: { name: 'research', scope: 'project' },
      context: { alwaysLoad: [{ noteId: 'fake-plain-docs', title: 'Docs Readme' }] },
    })
    expect(
      (started.profile as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad,
    ).toContainEqual(expect.objectContaining({ noteId: 'fake-pin-me' }))
    expect(
      (started.project as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad,
    ).toContainEqual(expect.objectContaining({ noteId: 'fake-pin-docs' }))
    const used = structured(
      await callTool(
        'use_role',
        { project: 'main/docs', role: 'research', budgetTokens: 4_000 },
        bearer,
      ),
    )
    expect(used.context).toMatchObject({
      alwaysLoad: (started.activeRole as { context: { alwaysLoad: Array<{ noteId: string }> } })
        .context.alwaysLoad,
      replacement: {
        profile: started.profile,
        project: {
          alwaysLoad: (started.project as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad,
        },
      },
    })
  })

  it('rejects a malformed exact locator without mutating the Personal role preset', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const personalRole = await exactRole(cookie, 'personal')
    const response = await putJson(
      '/api/me/agent-roles/not-a-locator/context-pins',
      { space: 'sam-personal', noteId: 'fake-plain-me' },
      cookie,
    )

    expect(response.statusCode).toBe(404)
    const preview = await getJson(`/api/me/agent-context?role=${personalRole}`, cookie)
    expect(preview.role.pins).toEqual([])
  })

  it('returns a full base replacement when late role activation evicts a bootstrap pin', async () => {
    await app.close()
    const f = fixture()
    const personal = f.spaces.find((candidate) => candidate.slug === 'sam-personal')!
    const baseTokens = Math.floor(PERSONAL_TOKEN_BUDGET * 0.5)
    const roleTokens = Math.floor(PERSONAL_TOKEN_BUDGET * 0.75)
    personal.notes.push(
      {
        id: 'fake-base-heavy',
        title: 'Heavy base reference',
        class: 'user-doc',
        filePath: 'heavy-base.md',
        tags: ['always-load'],
        content: 'b'.repeat(baseTokens * 4),
      },
      {
        id: 'fake-role-heavy',
        title: 'Heavy role reference',
        class: 'user-doc',
        filePath: 'heavy-role.md',
        content: 'r'.repeat(roleTokens * 4),
      },
    )
    app = await createApp(f)
    port = await listen(app)

    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor('sam', 'sam-password-1')
    const personalRole = await exactRole(cookie, 'personal')
    expect(
      (
        await putJson(
          `/api/me/agent-roles/${personalRole}/context-pins`,
          { space: 'sam-personal', noteId: 'fake-role-heavy' },
          cookie,
        )
      ).statusCode,
    ).toBe(200)
    const started = structured(await callTool('start_session', {}, bearer))
    const sessionId = (started.session as { id: string }).id
    expect(
      (started.profile as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad.map(
        (note) => note.noteId,
      ),
    ).toContain('fake-base-heavy')

    const activated = structured(
      await callTool('use_role', { role: 'research', session: sessionId }, bearer),
    )
    const context = activated.context as {
      alwaysLoad: Array<{ noteId: string }>
      replacement: { profile: { alwaysLoad: Array<{ noteId: string }> } }
    }
    expect(context.alwaysLoad.map((note) => note.noteId)).toContain('fake-role-heavy')
    expect(context.replacement.profile.alwaysLoad.map((note) => note.noteId)).not.toContain(
      'fake-base-heavy',
    )
  })

  it('resolves a Space placement and degrades only its preset when context facets are absent', async () => {
    await app.close()
    const f = fixture()
    f.projects!.push({ space: 'main', path: 'space-scope' })
    f.agentRoles!.push({ ...customResearch, target: { kind: 'space', space: 'main' } })
    f.noContextFacets = true
    app = await createApp(f)
    port = await listen(app)

    const bearer = await patFor('sam', 'sam-password-1')
    const started = structured(
      await callTool('start_session', { project: 'main/space-scope', role: 'research' }, bearer),
    )
    expect(started.activeRole).toMatchObject({
      role: { name: 'research', scope: 'space' },
      context: { alwaysLoad: [] },
    })
    const used = structured(
      await callTool('use_role', { project: 'main/space-scope', role: 'research' }, bearer),
    )
    expect(used).toMatchObject({
      role: { name: 'research', scope: 'space' },
      instructions: expect.stringContaining('Research'),
      context: { alwaysLoad: [], replacement: { profile: expect.any(Object) } },
    })
  })

  it('does not let role selection expand a reader into a role-context writer', async () => {
    const cookie = await loginCookie('robin', 'robin-password-1')
    const projectRole = await exactRole(cookie, 'project', 'proj-main-docs')
    const response = await putJson(
      `/api/me/agent-roles/${projectRole}/context-pins`,
      { space: 'main', noteId: 'fake-plain-docs' },
      cookie,
    )

    expect(response.statusCode).toBe(403)
    const preview = await getJson(
      `/api/s/main/projects/proj-main-docs/agent-context?role=${projectRole}`,
      cookie,
    )
    expect(preview.role).toMatchObject({ name: 'research', scope: 'project', pins: [] })
  })
})

describe('the addressed role vs the role the agent loads (#309)', () => {
  /** Turning a role off is a private READING preference. Whether its shared context may
   *  be configured is a question about the space — so the IDENTITY door keeps answering
   *  which role the address names, and answers it without a budget. Folding the two
   *  questions into the preview broke one of them each way round: it first told a member
   *  their own shared role did not exist, then charged its layer to a budget the agent
   *  never spends. */
  it('names a role the viewer switched off, hands back its layer, and says it is not loaded', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const personalRole = await exactRole(cookie, 'personal')

    expect(
      (
        await putJson(
          `/api/me/agent-roles/${personalRole}/context-pins`,
          { space: 'sam-personal', noteId: 'fake-plain-me' },
          cookie,
        )
      ).statusCode,
    ).toBe(200)
    expect(
      (await putJson(`/api/me/agent-abilities/${personalRole}/enabled`, { enabled: false }, cookie))
        .statusCode,
    ).toBe(200)

    const named = await getJson(`/api/me/agent-roles/${personalRole}/context`, cookie)

    expect(named.active).toBe(false)
    expect(named.inactive).toBe('disabled')
    // The layer is what the page edits, so it arrives — and carries no word about a
    // budget this door does not weigh.
    expect(named.role.pins.map((pin: { noteId: string }) => pin.noteId)).toEqual(['fake-plain-me'])
    expect(named.role.pins.every((pin: object) => !('loaded' in pin))).toBe(true)
    expect('loadedTokens' in named.role).toBe(false)
  })

  /** The blocker of round 7, stated as an arc. The preview exists to mirror what the
   *  agent loads; charging it for a layer the agent does not load made it report a
   *  personal always-load pin as dropped while `start_session` went on loading it. */
  it('charges the preview budget nothing for a role the agent does not load', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const personalRole = await exactRole(cookie, 'personal')
    await putJson(
      `/api/me/agent-roles/${personalRole}/context-pins`,
      { space: 'sam-personal', noteId: 'fake-plain-me' },
      cookie,
    )
    const base = await getJson('/api/me/agent-context', cookie)
    await putJson(`/api/me/agent-abilities/${personalRole}/enabled`, { enabled: false }, cookie)

    const preview = await getJson(`/api/me/agent-context?role=${personalRole}`, cookie)

    expect(preview.role).toBeUndefined()
    expect(preview.loadedTokens).toBe(base.loadedTokens)
    expect(preview.pins.map((pin: { noteId: string; loaded: boolean }) => pin.loaded)).toEqual(
      base.pins.map((pin: { loaded: boolean }) => pin.loaded),
    )
  })

  /** The same claim on the PROJECT door — and it is the door that needed it. The
   *  sentinel above was written for the personal one, while all three reasons a role can
   *  be inactive live here: reach is a question about a project, and health is read in
   *  one. Mutating the project door's budget gate alone left the whole run green. */
  it('charges the PROJECT preview budget nothing for a role the agent does not load', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const projectRole = await exactRole(cookie, 'project', 'proj-main-docs')
    await putJson(
      `/api/me/agent-roles/${projectRole}/context-pins`,
      { space: 'main', noteId: 'fake-pin-docs' },
      cookie,
    )
    const url = `/api/s/main/projects/proj-main-docs/agent-context`
    const withRole = await getJson(`${url}?role=${projectRole}`, cookie)

    // The subject exists: the role IS loaded here to start with, and it carries a layer.
    // Stated as the anti-vacuum guard, because a world where the role is absent would
    // satisfy every assertion below without observing anything.
    expect(withRole.role).toBeDefined()
    expect(withRole.role.pins.length).toBeGreaterThan(0)
    const base = await getJson(url, cookie)
    await putJson(`/api/me/agent-abilities/${projectRole}/enabled`, { enabled: false }, cookie)

    const inactive = await getJson(`${url}?role=${projectRole}`, cookie)

    expect(inactive.role).toBeUndefined()
    expect(inactive.loadedTokens).toBe(base.loadedTokens)
    expect(inactive.projectLoadedTokens).toBe(base.projectLoadedTokens)
    expect(inactive.pins.map((pin: { loaded: boolean }) => pin.loaded)).toEqual(
      base.pins.map((pin: { loaded: boolean }) => pin.loaded),
    )
    await putJson(`/api/me/agent-abilities/${projectRole}/enabled`, { enabled: true }, cookie)
  })

  /** The door that CONFIGURES a role lists everything the author put on it. Curation is
   *  asked for the order and nothing else: its dedup is a rule about LOADING — "a note
   *  the agent would load twice loads once" — and applying it to the editing view
   *  deleted the second membership of a note that legitimately sits in two sets. With the
   *  row gone there was no `Remove from set` to reach it by, while the sets endpoint went
   *  on showing the note in both. */
  it('lists a note that sits in two of the role sets, in both of them', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const personalRole = await exactRole(cookie, 'personal')
    const shared = 'fake-plain-me'
    const first = await makeSet(cookie, 'sam-personal', 'Twin A', [['sam-personal', shared]])
    const second = await makeSet(cookie, 'sam-personal', 'Twin B', [['sam-personal', shared]])

    for (const id of [first, second]) {
      expect(
        (
          await sendJson(
            'PUT',
            `/api/me/agent-roles/${personalRole}/context-sets/${id}`,
            cookie,
            {},
          )
        ).statusCode,
      ).toBe(200)
    }

    const named = await getJson(`/api/me/agent-roles/${personalRole}/context`, cookie)
    const sets = named.role.sets as Array<{
      id: string
      items: Array<{ noteId: string; sourceIndex?: number }>
    }>

    // Both memberships are real and both are the author's — the surface that edits them
    // has to show both, or one of them cannot be removed at all.
    expect(sets.map((set) => set.id).sort()).toEqual([first, second].sort())
    expect(sets.map((set) => set.items.filter((item) => item.noteId === shared).length)).toEqual([
      1, 1,
    ])
    expect(sets.flatMap((set) => set.items).every((item) => item.sourceIndex === undefined)).toBe(
      true,
    )
  })

  /** The picker offers what the agent would load. A role the viewer switched off is not
   *  that, and it was being offered. */
  it('drops a role the viewer switched off from the choices it offers', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const personalRole = await exactRole(cookie, 'personal')
    const before = await getJson('/api/me/agent-context', cookie)

    expect(before.roles.length).toBeGreaterThan(0)
    await putJson(`/api/me/agent-abilities/${personalRole}/enabled`, { enabled: false }, cookie)

    const after = await getJson('/api/me/agent-context', cookie)

    expect(
      after.roles.map((role: { locator: unknown }) => encodeAbilityLocator(role.locator as never)),
    ).not.toContain(personalRole)
  })
})

describe('agent-context pult (#165): pin / unpin', () => {
  it('PUT /api/note/pin toggles always-load membership; the preview AND start_session follow', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor('sam', 'sam-password-1')

    // Pin a previously-plain personal note.
    const pin = await putJson('/api/note/pin', { id: 'fake-plain-me', pinned: true }, cookie)
    expect(pin.statusCode).toBe(200)
    expect(pin.json().pinned).toBe(true)

    // The REST preview now lists both pins (loaded under the budget)…
    const afterPin = await getJson('/api/me/agent-context', cookie)
    expect((afterPin.pins as Array<{ noteId: string }>).map((p) => p.noteId).sort()).toEqual([
      'fake-pin-me',
      'fake-plain-me',
    ])
    // …and the AGENT sees exactly the same via start_session (one shared scan).
    const profile = (
      structured(await callTool('start_session', {}, bearer)).profile as {
        alwaysLoad: Array<{ noteId: string }>
      }
    ).alwaysLoad.map((p) => p.noteId)
    expect(profile.sort()).toEqual(['fake-pin-me', 'fake-plain-me'])

    // Unpin the original pin → it drops from both surfaces.
    await putJson('/api/note/pin', { id: 'fake-pin-me', pinned: false }, cookie)
    const afterUnpin = await getJson('/api/me/agent-context', cookie)
    expect((afterUnpin.pins as Array<{ noteId: string }>).map((p) => p.noteId)).toEqual([
      'fake-plain-me',
    ])
  })

  it('PUT /api/note/pin rejects agent-memory notes', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor('sam', 'sam-password-1')
    await callTool(
      'remember_about_user',
      { observation: 'private fact', category: 'memory-only', summary: 'private' },
      bearer,
    )

    const memory = await getJson('/api/me/memory', cookie)
    const row = (memory.categories as Array<{ category: string; noteId: string }>).find(
      (c) => c.category === 'memory-only',
    )!
    const res = await putJson('/api/note/pin', { id: row.noteId, pinned: true }, cookie)
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('only user-doc')
  })

  it('a project pin surfaces in start_session(project).project.alwaysLoad', async () => {
    const bearer = await patFor('sam', 'sam-password-1')
    const project = structured(await callTool('start_session', { project: 'main/docs' }, bearer))
      .project as {
      alwaysLoad: Array<{ noteId: string }>
    }
    expect(project.alwaysLoad.map((p) => p.noteId)).toEqual(['fake-pin-docs'])
  })
})

describe('agent-context pult (#165): mute / unmute', () => {
  it('mute keeps a memory category in the audit but DROPS it from the eager profile', async () => {
    const bearer = await patFor('sam', 'sam-password-1')
    const cookie = await loginCookie('sam', 'sam-password-1')

    // The agent records two about-user categories.
    await callTool(
      'remember_about_user',
      { observation: 'prefers RU', category: 'language', summary: 'RU' },
      bearer,
    )
    await callTool(
      'remember_about_user',
      { observation: 'old fact', category: 'stale', summary: 'outdated' },
      bearer,
    )

    const before = await getJson('/api/me/memory', cookie)
    const stale = (
      before.categories as Array<{ category: string; noteId: string; muted: boolean }>
    ).find((c) => c.category === 'stale')!
    expect(stale.muted).toBe(false)
    // Both load into the eager profile to start.
    const profBefore = (
      structured(await callTool('start_session', {}, bearer)).profile as {
        memory: Array<{ category: string }>
      }
    ).memory.map((m) => m.category)
    expect(profBefore).toEqual(expect.arrayContaining(['language', 'stale']))

    // Mute the stale category.
    const mute = await putJson('/api/note/mute', { id: stale.noteId, muted: true }, cookie)
    expect(mute.statusCode).toBe(200)
    expect(mute.json().muted).toBe(true)

    // The AUDIT still shows it, now flagged muted…
    const after = await getJson('/api/me/memory', cookie)
    expect(
      (after.categories as Array<{ category: string; muted: boolean }>).find(
        (c) => c.category === 'stale',
      )?.muted,
    ).toBe(true)
    // …but the agent's eager profile DROPS it (still loads the other).
    const profAfter = (
      structured(await callTool('start_session', {}, bearer)).profile as {
        memory: Array<{ category: string }>
      }
    ).memory.map((m) => m.category)
    expect(profAfter).toContain('language')
    expect(profAfter).not.toContain('stale')

    // Un-mute → it reloads.
    await putJson('/api/note/mute', { id: stale.noteId, muted: false }, cookie)
    const profUnmuted = (
      structured(await callTool('start_session', {}, bearer)).profile as {
        memory: Array<{ category: string }>
      }
    ).memory.map((m) => m.category)
    expect(profUnmuted).toContain('stale')
  })

  it('project-memory HONORS ?order=eager (stable buildMemoryIndex order), distinct from the default newest-first — #210 dim-in-place', async () => {
    const bearer = await patFor('sam', 'sam-password-1')
    const cookie = await loginCookie('sam', 'sam-password-1')

    // The write order deliberately differs from both title directions, so the
    // no-param route proves newest-first instead of accidentally aliasing a display sort.
    for (const c of ['b', 'a', 'c']) {
      await callTool(
        'remember_about_project',
        { project: 'main/docs', observation: c, category: `proj-${c}`, summary: c },
        bearer,
      )
    }
    const base = '/api/s/main/projects/proj-main-docs/memory'
    const orderOf = async (q: string) =>
      ((await getJson(`${base}${q}`, cookie)).categories as Array<{ category: string }>).map(
        (c) => c.category,
      )

    // The endpoint HONORS order=eager: the stable buildMemoryIndex (write) order [b,a,c] — NOT
    // the default newest-first [c,a,b]. If the param were ignored the two would match; they must
    // differ, proving the Context constructor gets the stable axis it asks for.
    const eager = await orderOf('?order=eager')
    const dflt = await orderOf('')
    expect(eager).toEqual(['proj-b', 'proj-a', 'proj-c'])
    expect(dflt).toEqual(['proj-c', 'proj-a', 'proj-b'])
    expect(await orderOf('?sort=title&dir=desc')).toEqual(['proj-c', 'proj-b', 'proj-a'])
    // Constructor order is a distinct, stronger axis: even an explicit display
    // order cannot reorder what the agent eagerly loads.
    expect(await orderOf('?order=eager&sort=title&dir=desc')).toEqual(eager)

    // And muting a category (a WRITE) leaves the eager order UNCHANGED — the muted row dims where
    // it sits, never reflowing (the profile axis already did this; #210 makes project match). On
    // the real engine a mute bumps modifiedAt to the front of the DEFAULT axis — which is exactly
    // why the constructor must ask for eager; the removed client `orderByState` no longer masks it.
    const first = (
      (await getJson(`${base}?order=eager`, cookie)).categories as Array<{ noteId: string }>
    )[0]
    expect(
      (await putJson('/api/note/mute', { id: first.noteId, muted: true }, cookie)).statusCode,
    ).toBe(200)
    expect(await orderOf('?order=eager')).toEqual(eager)
  })

  it('muting a PROJECT memory category hides it from start_session knownValues but keeps it in the audit (#207)', async () => {
    const bearer = await patFor('sam', 'sam-password-1')
    const cookie = await loginCookie('sam', 'sam-password-1')

    // Two about-project categories under main/docs (the agent records them).
    await callTool(
      'remember_about_project',
      { project: 'main/docs', observation: 'kept fact', category: 'keep', summary: 'k' },
      bearer,
    )
    await callTool(
      'remember_about_project',
      { project: 'main/docs', observation: 'hush fact', category: 'hush', summary: 'h' },
      bearer,
    )

    const projects = (await getJson('/api/s/main/projects', cookie)).projects as Array<{
      id: string
      slug: string
    }>
    const docs = projects.find((p) => p.slug === 'docs')!

    // Both category names ride the start_session vocabulary hint to begin with.
    const knownBefore = (
      structured(await callTool('start_session', { project: 'main/docs' }, bearer)).project as {
        knownValues: { categories: string[] }
      }
    ).knownValues.categories
    expect(knownBefore).toEqual(expect.arrayContaining(['keep', 'hush']))

    // Mute `hush` (id-addressed; the audit feed carries the noteId).
    const audit = (await getJson(`/api/s/main/projects/${docs.id}/memory`, cookie))
      .categories as Array<{ category: string; noteId: string; muted: boolean }>
    const hush = audit.find((c) => c.category === 'hush')!
    expect(hush.muted).toBe(false)
    const mute = await putJson('/api/note/mute', { id: hush.noteId, muted: true }, cookie)
    expect(mute.statusCode).toBe(200)

    // The AUDIT still shows it, now flagged muted — opt-out, not delete.
    const auditAfter = (await getJson(`/api/s/main/projects/${docs.id}/memory`, cookie))
      .categories as Array<{ category: string; muted: boolean }>
    expect(auditAfter.find((c) => c.category === 'hush')?.muted).toBe(true)

    // …but the agent's vocabulary hint DROPS it (still hints the other) (#207).
    const knownAfter = (
      structured(await callTool('start_session', { project: 'main/docs' }, bearer)).project as {
        knownValues: { categories: string[] }
      }
    ).knownValues.categories
    expect(knownAfter).toContain('keep')
    expect(knownAfter).not.toContain('hush')

    // Un-mute → it returns to the hint.
    await putJson('/api/note/mute', { id: hush.noteId, muted: false }, cookie)
    const knownUnmuted = (
      structured(await callTool('start_session', { project: 'main/docs' }, bearer)).project as {
        knownValues: { categories: string[] }
      }
    ).knownValues.categories
    expect(knownUnmuted).toContain('hush')
  })

  it('PUT /api/note/mute rejects user-doc notes', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const res = await putJson('/api/note/mute', { id: 'fake-pin-me', muted: true }, cookie)
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('only agent-memory')
  })
})

describe('mute under the memory-category fence (#341)', () => {
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })

    return { promise, resolve }
  }

  /** Park a target read until another writer commits. The route guard is read #1;
   *  mute's pre-fence key read is #2. Parking its write would deadlock the fixed tree. */
  const parkingMuteOnRead = async (
    nth: number,
  ): Promise<{ arm: (noteId: string) => void; parked: Promise<void>; release: () => void }> => {
    await app.close()
    const parked = deferred()
    const committed = deferred()
    let target = ''
    let armed = false
    let reads = 0

    app = await createApp(fixture(), {
      configureWorld: ({ slug, store }) => {
        if (slug !== 'main') {
          return
        }
        const read = store.read.bind(store)
        const write = store.write.bind(store)

        store.read = async (id, opts) => {
          const note = await read(id, opts)

          if (armed && id === target) {
            reads += 1

            if (reads === nth) {
              armed = false
              parked.resolve()
              await committed.promise
            }
          }

          return note
        }
        store.write = async (input, opts) => {
          const result = await write(input, opts)

          if (input.originalId === target) {
            committed.resolve()
          }

          return result
        }
      },
    })
    port = await listen(app)

    return {
      arm: (noteId: string) => {
        target = noteId
        armed = true
      },
      parked: parked.promise,
      release: committed.resolve,
    }
  }

  const seedCategory = async (
    bearer: string,
    category: string,
    observation: string,
  ): Promise<string> => {
    const r = await callTool(
      'remember_about_project',
      { project: 'main/docs', observation, category },
      bearer,
    )

    expect(r.result?.isError).toBeFalsy()
    return structured(r).noteId as string
  }

  it('mute survives a remember that commits while it waits', async () => {
    const seam = await parkingMuteOnRead(2)
    const bearer = await patFor('sam', 'sam-password-1')
    const cookie = await loginCookie('sam', 'sam-password-1')
    const noteId = await seedCategory(bearer, 'ops', 'seed')

    seam.arm(noteId)
    const muting = putJson('/api/note/mute', { id: noteId, muted: true }, cookie)

    await seam.parked
    // This commit makes the parked mute's pre-fence token stale.
    const remembered = await callTool(
      'remember_about_project',
      { project: 'main/docs', observation: 'obs-0', category: 'ops' },
      bearer,
    )

    expect(remembered.result?.isError).toBeFalsy()
    const res = await muting

    expect(res.statusCode).toBe(200)
    expect(res.json().muted).toBe(true)
  })

  it('keeps the observation committed while mute waited', async () => {
    const seam = await parkingMuteOnRead(2)
    const bearer = await patFor('sam', 'sam-password-1')
    const cookie = await loginCookie('sam', 'sam-password-1')
    const noteId = await seedCategory(bearer, 'ops', 'seed')

    seam.arm(noteId)
    const muting = putJson('/api/note/mute', { id: noteId, muted: true }, cookie)

    await seam.parked
    await callTool(
      'remember_about_project',
      { project: 'main/docs', observation: 'obs-0', category: 'ops' },
      bearer,
    )
    await muting

    // Guards against token #2 paired with body #1, which would erase obs-0.
    const note = await getJson(`/api/note?id=${encodeURIComponent(noteId)}`, cookie)

    expect(note.content).toBe('seed\n\nobs-0')
    expect(note.frontmatter.muted).toBe('true')
  })

  // A global or prefix claim blocks this unrelated write behind the held mute.
  it('does not hold up another category while it owns the fence', async () => {
    const seam = await parkingMuteOnRead(3)
    const bearer = await patFor('sam', 'sam-password-1')
    const cookie = await loginCookie('sam', 'sam-password-1')
    const noteId = await seedCategory(bearer, 'ops', 'seed')

    seam.arm(noteId)
    const muting = putJson('/api/note/mute', { id: noteId, muted: true }, cookie)

    await seam.parked
    const other = await callTool(
      'remember_about_project',
      { project: 'main/docs', observation: 'unrelated', category: 'people' },
      bearer,
    )

    expect(other.result?.isError).toBeFalsy()
    seam.release()
    expect((await muting).statusCode).toBe(200)
  })
})
