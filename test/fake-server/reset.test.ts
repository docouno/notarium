// The e2e reset hook (POST /api/__test/reset) swaps the whole fixture world between
// Playwright specs. Since #127 the fake mints opaque space ids (id ≠ slug, #100 phase 4),
// so the reset's remove/add dance + the registry mirror that keeps id↔slug
// translation exact are non-trivial — and ONLY this route exercises them (the other
// vitest suites build a fresh app per test, never reset). This pins that a fixture
// swap lands a working id≠slug world (the new space reachable BY ITS SLUG, the wire
// projecting slugs throughout) and tears the old one down.

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SYSTEM_OWNER } from '@notarium/server'

import { createApp, type Fixture } from './app.js'

const base = (): Fixture => ({
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          title: 'Main Note',
          filePath: 'main/Main Note.md',
          modifiedAt: '2026-06-08T00:00:00.000Z',
          createdAt: '2026-06-01T00:00:00.000Z',
          tags: [],
          content: '# Main Note\n\nlives in main',
        },
      ],
    },
  ],
})

// A two-space swap: 'main' survives, 'work' is brand-new (the reset-add path —
// SpaceManager.add mints its opaque id, the registry mirror picks it up).
const TWO: Fixture = {
  now: '2026-06-10T12:00:00.000Z',
  capabilities: { spaceCreate: true },
  spaces: [
    base().spaces[0],
    {
      slug: 'work',
      displayName: 'Work',
      notes: [
        {
          title: 'Work Note',
          filePath: 'projects/Work Note.md',
          modifiedAt: '2026-06-09T00:00:00.000Z',
          createdAt: '2026-06-02T00:00:00.000Z',
          tags: [],
          content: '# Work Note\n\nlives in work',
        },
      ],
    },
  ],
}

const ARCHIVED: Fixture = {
  ...base(),
  spaces: [base().spaces[0], { slug: 'old', displayName: 'Old', archived: true, notes: [] }],
}

const AUDIT_SESSION_ID = 'ses_resetwrite01'
const withAuditSession = (value: Fixture): Fixture => ({
  ...value,
  agentSessions: [
    {
      id: AUDIT_SESSION_ID,
      owner: AGENT_SYSTEM_OWNER,
      name: 'Reset write audit',
      named: true,
      parentId: null,
      createdAt: '2026-06-10T10:00:00.000Z',
      lastSeenAt: '2026-06-10T10:00:00.000Z',
      calls: 1,
      role: null,
      roleLocator: null,
      roleContextProjectId: null,
      projectId: null,
    },
  ],
})

let app: FastifyInstance

beforeEach(async () => {
  app = await createApp(base())
})
afterEach(async () => {
  await app.close()
})

const reset = (fixture?: Fixture) =>
  app.inject({ method: 'POST', url: '/api/__test/reset', payload: fixture ? { fixture } : {} })
const spacesOf = async (): Promise<Array<{ id: string; slug: string; displayName: string }>> =>
  (await app.inject({ method: 'GET', url: '/api/spaces' })).json().spaces

describe('reset hook fixture swap (#127: opaque space ids)', () => {
  it('a fixture swap lands a fresh id≠slug world reachable by slug; reset back removes it', async () => {
    // Base: one space, already opaque (id ≠ slug).
    let spaces = await spacesOf()
    expect(spaces.map((s) => s.slug)).toEqual(['main'])
    expect(spaces[0].id).not.toBe('main')

    // Swap → main survives, work is added (the reset-add mint path).
    expect((await reset(TWO)).statusCode).toBe(200)
    spaces = await spacesOf()
    expect(spaces.map((s) => s.slug).sort()).toEqual(['main', 'work'])
    // EVERY space is opaque — the seam holds across a swap, for survivor and newcomer.
    for (const s of spaces) {
      expect(s.id).not.toBe(s.slug)
    }

    // The new space's notes are live and reachable BY ITS SLUG (URL slug → id resolve).
    const notes = (await app.inject({ method: 'GET', url: '/api/s/work/notes' })).json()
      .notes as Array<{
      id: string
    }>
    expect(notes.length).toBe(1)

    // A space-FREE note URL (the /n/<id> re-anchor path) resolves the space from the
    // id (resolveNote → opaque work id) and projects its SLUG, never the raw id.
    const detail = (
      await app.inject({ method: 'GET', url: `/api/note?id=${notes[0].id}` })
    ).json() as {
      space?: string
    }
    expect(detail.space).toBe('work')
    expect(detail.space).not.toBe(spaces.find((s) => s.slug === 'work')!.id)

    // Reset back to the canonical base → work is torn down, only main remains.
    expect((await reset()).statusCode).toBe(200)
    expect((await spacesOf()).map((s) => s.slug)).toEqual(['main'])
    // …and work is gone from the registry too: its slug no longer resolves a space.
    expect((await app.inject({ method: 'GET', url: '/api/s/work/notes' })).statusCode).toBe(404)
  })

  it('re-adding a removed space mints a FRESH opaque id (no stale registry row survives)', async () => {
    const idOf = async (slug: string) => (await spacesOf()).find((s) => s.slug === slug)?.id
    expect((await reset(TWO)).statusCode).toBe(200)
    const work1 = await idOf('work')
    expect(work1).toBeTruthy()

    // Drop work…
    expect((await reset(base())).statusCode).toBe(200)
    expect(await idOf('work')).toBeUndefined()

    // …and bring it back: a brand-new mint, not the resurrected old id.
    expect((await reset(TWO)).statusCode).toBe(200)
    const work2 = await idOf('work')
    expect(work2).toBeTruthy()
    expect(work2).not.toBe(work1)
    // The slug still resolves cleanly to exactly the new id (no stale row shadowing).
    expect((await app.inject({ method: 'GET', url: '/api/s/work/notes' })).statusCode).toBe(200)
  })

  it('seeds a runtime Space archived and repeats the reset without a lifecycle race', async () => {
    expect((await reset(ARCHIVED)).statusCode).toBe(200)
    expect((await spacesOf()).map((space) => space.slug)).toEqual(['main'])
    expect((await app.inject({ method: 'GET', url: '/api/s/old/notes' })).statusCode).toBe(404)

    expect((await reset(base())).statusCode).toBe(200)
    expect((await reset(ARCHIVED)).statusCode).toBe(200)
    expect((await spacesOf()).map((space) => space.slug)).toEqual(['main'])
  })

  it('a retired alias cannot capture a current slug introduced by the next fixture', async () => {
    await app.close()
    const aliased = base()
    aliased.spaces[0] = { ...aliased.spaces[0], aliases: ['work'] }
    app = await createApp(aliased)

    // Before reset, /work is legitimately main's retired alias. The next fixture
    // promotes work to a current slug while retaining main, with work deliberately
    // first to pin that reset does not depend on declaration order.
    expect((await app.inject({ method: 'GET', url: '/api/s/work/notes' })).statusCode).toBe(200)
    const next: Fixture = { ...TWO, spaces: [TWO.spaces[1], base().spaces[0]] }
    expect((await reset(next)).statusCode).toBe(200)
    expect((await spacesOf()).map((space) => space.slug).sort()).toEqual(['main', 'work'])

    const workNotes = (await app.inject({ method: 'GET', url: '/api/s/work/notes' })).json()
      .notes as Array<{ title: string }>
    expect(workNotes.map((note) => note.title)).toEqual(['Work Note'])
  })

  it('drops captured writes when reset purges a dynamic space world', async () => {
    await app.close()
    let appendWorkRevision: ((space: string) => Promise<unknown>) | undefined
    app = await createApp(withAuditSession(base()), {
      configureWorld: ({ slug, revisions }) => {
        if (slug === 'work') {
          appendWorkRevision = (space) =>
            revisions.append(
              {
                noteId: 'reset-audit-note',
                space,
                baseRevisionId: null,
                theirRevisionId: null,
                sourceRevisionId: null,
                kind: 'write',
                entryRole: 'origin',
                principal: 'ui',
                contentHash: 'reset-audit-hash',
                title: 'Reset audit note',
                class: 'user-doc',
                slug: null,
                tags: [],
                createdAt: '2026-06-10T11:00:00.000Z',
                charsAdded: 1,
                charsRemoved: 0,
                agent: {
                  owner: AGENT_SYSTEM_OWNER,
                  agent: 'Test connector',
                  session: {
                    id: AUDIT_SESSION_ID,
                    name: 'Reset write audit',
                    attach: 'declared',
                  },
                },
              },
              'captured write',
            )
        }
      },
    })

    expect((await reset(withAuditSession(TWO))).statusCode).toBe(200)
    const work = (await spacesOf()).find((space) => space.slug === 'work')
    expect(work).toBeTruthy()
    expect(appendWorkRevision).toBeTypeOf('function')
    await appendWorkRevision!(work!.id)

    const detail = () =>
      app.inject({ method: 'GET', url: `/api/me/agent-sessions/${AUDIT_SESSION_ID}` })
    expect((await detail()).json()).toMatchObject({ total: 1 })

    expect((await reset()).statusCode).toBe(200)
    expect((await detail()).json()).toMatchObject({ total: 0, events: [] })
  })
})
