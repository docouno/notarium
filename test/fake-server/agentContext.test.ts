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
import { estimateTokens } from '@notarium/core'
import { PERSONAL_TOKEN_BUDGET, PROJECT_TOKEN_BUDGET } from '@notarium/server'

import { createApp, type Fixture } from './app.js'

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
  auth: {
    users: [
      {
        username: 'sam',
        password: 'sam-password-1',
        displayName: 'Sam',
        personalSpace: 'sam-personal',
      },
      { username: 'mallory', password: 'mallory-password-1', displayName: 'Mallory' },
    ],
    members: [
      { space: 'main', username: 'sam', role: 'owner' },
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
    expect(ctx.totalTokens).toBe(pins.reduce((sum, p) => sum + p.tokens, 0))
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

    // The agent records three about-PROJECT categories (into main/docs), a, b, c in that order.
    for (const c of ['a', 'b', 'c']) {
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

    // The endpoint HONORS order=eager: the stable buildMemoryIndex (write) order [a,b,c] — NOT
    // the default newest-first [c,b,a]. If the param were ignored the two would match; they must
    // differ, proving the Context constructor gets the stable axis it asks for.
    const eager = await orderOf('?order=eager')
    const dflt = await orderOf('')
    expect(eager).toEqual(['proj-a', 'proj-b', 'proj-c'])
    expect(dflt).toEqual(['proj-c', 'proj-b', 'proj-a'])

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
