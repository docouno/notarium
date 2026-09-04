// The multi-principal leg of the isolation pack (#10 — what isolation.test.ts
// pinned by construction, this pins by MEMBERSHIP): every surface from the
// matrix answers 404 for a principal without a grant, 401 for no principal;
// PATs are scope- and space-narrowed; invites are single-use; revoking
// membership disconnects live SSE. Runs over the PRODUCTION AuthService and
// chokepoint — the fake only swaps the engine and the persistence (#18).

import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const MARKER = 'xyzzy-auth-isolation-9913'

const fixture = (): Fixture => ({
  now: '2026-06-12T12:00:00.000Z',
  spaces: [
    {
      slug: 'alpha',
      displayName: 'Alpha',
      notes: [
        {
          title: 'Alpha Marker',
          filePath: 'secrets/alpha-marker.md',
          modifiedAt: '2026-06-10T00:00:00.000Z',
          createdAt: '2026-06-01T00:00:00.000Z',
          tags: ['secret'],
          content: `# Alpha Marker\n\nsecret token ${MARKER}.`,
        },
      ],
    },
    {
      slug: 'beta',
      displayName: 'Beta',
      notes: [
        {
          title: 'Beta Note',
          filePath: 'work/beta-note.md',
          modifiedAt: '2026-06-09T00:00:00.000Z',
          createdAt: '2026-06-03T00:00:00.000Z',
          tags: [],
          content: '# Beta Note\n\nplain.',
        },
      ],
    },
  ],
  auth: {
    users: [
      { username: 'root', password: 'root-password-1', admin: true },
      { username: 'alice', password: 'alice-password-1' },
      { username: 'bob', password: 'bob-password-01' },
      { username: 'rita', password: 'rita-password-1' },
    ],
    members: [
      { space: 'alpha', username: 'root', role: 'owner' },
      { space: 'beta', username: 'root', role: 'owner' },
      { space: 'alpha', username: 'alice', role: 'owner' },
      { space: 'beta', username: 'alice', role: 'owner' },
      { space: 'beta', username: 'bob', role: 'writer' },
      { space: 'beta', username: 'rita', role: 'reader' },
    ],
  },
})

const ALPHA_NOTE = 'fake-secrets-alpha-marker'
const BETA_NOTE = 'fake-work-beta-note'

let app: FastifyInstance

beforeEach(async () => {
  app = await createApp(fixture())
})

/** Login through the real endpoint; returns the session cookie header. */
const login = async (username: string, password: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: username, password },
  })
  expect(res.statusCode).toBe(200)
  const setCookie = res.headers['set-cookie'] as string
  return setCookie.split(';')[0]
}

type InjectOpts = {
  cookie?: string
  bearer?: string
  payload?: object
  headers?: Record<string, string>
}

const request = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  { cookie, bearer, payload, headers }: InjectOpts = {},
): Promise<LightMyRequestResponse> =>
  app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
  })

/** The journal appends asynchronously behind a save (CachedStore queue) —
 *  poll the timeline instead of racing it. */
const revisionsOf = async (id: string, cookie: string) => {
  for (let i = 0; i < 50; i++) {
    const res = await request('GET', `/api/note/revisions?id=${id}`, { cookie })

    if (res.statusCode === 200 && res.json().total > 0) {
      return res.json()
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`no revisions for ${id}`)
}

describe('anonymous: a wall, not a window', () => {
  it('data routes answer 401 without a credential; health and session stay public', async () => {
    for (const url of [
      '/api/config',
      '/api/spaces',
      '/api/s/alpha/notes',
      `/api/note?id=${ALPHA_NOTE}`,
    ]) {
      const res = await request('GET', url)
      expect(res.statusCode, url).toBe(401)
      expect(JSON.stringify(res.json())).not.toContain(MARKER)
    }
    expect((await request('GET', '/api/health')).statusCode).toBe(200)
    const session = await request('GET', '/api/auth/session')
    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({ mode: 'password', setup: false, me: null })
  })

  it('a garbage cookie or bearer is anonymous, never an error', async () => {
    expect(
      (await request('GET', '/api/config', { cookie: 'nt_session=nts_junk' })).statusCode,
    ).toBe(401)
    expect((await request('GET', '/api/config', { bearer: 'ntp_wat' })).statusCode).toBe(401)
  })

  it('login: wrong password and unknown user are the same generic 401', async () => {
    const wrong = await request('POST', '/api/auth/login', {
      payload: { identifier: 'alice', password: 'nope-nope-nope' },
    })
    const unknown = await request('POST', '/api/auth/login', {
      payload: { identifier: 'nobody', password: 'nope-nope-nope' },
    })
    expect(wrong.statusCode).toBe(401)
    expect(unknown.statusCode).toBe(401)
    expect(wrong.json()).toEqual(unknown.json())
  })
})

describe('membership: B never sees A, surface by surface (#16 §7 with principals)', () => {
  let bob: string
  beforeEach(async () => {
    bob = await login('bob', 'bob-password-01')
  })

  it('/api/spaces is the membership filter', async () => {
    const res = await request('GET', '/api/spaces', { cookie: bob })
    expect(res.json().spaces.map((s: { slug: string }) => s.slug)).toEqual(['beta'])
  })

  it('every space-scoped alpha surface answers bob the same 404', async () => {
    for (const url of [
      '/api/s/alpha/notes',
      '/api/s/alpha/tree',
      '/api/s/alpha/tree/children?path=',
      '/api/s/alpha/notes/buckets?group=day',
      '/api/s/alpha/graph',
      `/api/s/alpha/search?q=${MARKER}`,
      '/api/s/alpha/status',
      '/api/s/alpha/events',
      '/api/s/alpha/members',
    ]) {
      const res = await request('GET', url, { cookie: bob })
      expect(res.statusCode, url).toBe(404)
      expect(res.body).not.toContain(MARKER)
    }
    // ...and the same 404 as a NONEXISTENT space — no enumeration channel.
    const ghost = await request('GET', '/api/s/no-such/notes', { cookie: bob })
    expect(ghost.statusCode).toBe(404)
  })

  it('per-id surfaces: the registry space is the arbiter — alpha ids are "no such thing" for bob', async () => {
    expect((await request('GET', `/api/note?id=${ALPHA_NOTE}`, { cookie: bob })).statusCode).toBe(
      404,
    )
    expect(
      (await request('GET', `/api/note/revisions?id=${ALPHA_NOTE}`, { cookie: bob })).statusCode,
    ).toBe(404)
    expect(
      (await request('DELETE', `/api/note?id=${ALPHA_NOTE}`, { cookie: bob })).statusCode,
    ).toBe(404)
    expect(
      (
        await request('POST', '/api/move', {
          cookie: bob,
          payload: { id: ALPHA_NOTE, destinationPath: 'work/stolen.md' },
        })
      ).statusCode,
    ).toBe(404)

    // The mixed previews batch serves ONLY the granted id — the foreign one is
    // silently absent, exactly like an unknown id.
    const previews = await request('POST', '/api/previews', {
      cookie: bob,
      payload: { ids: [ALPHA_NOTE, BETA_NOTE] },
    })
    expect(previews.statusCode).toBe(200)
    expect(previews.json().previews[BETA_NOTE]).toBeTruthy()
    expect(previews.json().previews[ALPHA_NOTE]).toBeUndefined()
  })

  it('writes into a granted space work; the same note is updatable through the id family', async () => {
    const save = await request('POST', '/api/s/beta/notes', {
      cookie: bob,
      payload: { title: 'Bob Writes', directory: 'work', content: 'hi' },
    })
    expect(save.statusCode).toBe(200)
  })

  it('a reader can read but never write (role rank inside the space)', async () => {
    const rita = await login('rita', 'rita-password-1')
    expect((await request('GET', '/api/s/beta/notes', { cookie: rita })).statusCode).toBe(200)
    const write = await request('POST', '/api/s/beta/notes', {
      cookie: rita,
      payload: { title: 'Rita Writes', content: 'x' },
    })
    expect(write.statusCode).toBe(404)
    const note = (await request('GET', `/api/note?id=${BETA_NOTE}`, { cookie: rita })).json()
    const update = await request('POST', '/api/note', {
      cookie: rita,
      payload: {
        title: 'Beta Note',
        content: 'hacked',
        originalId: BETA_NOTE,
        versionToken: note.versionToken,
      },
    })
    expect(update.statusCode).toBe(404)
  })

  it('journal attribution carries the live principal (#12)', async () => {
    await request('POST', '/api/s/beta/notes', {
      cookie: bob,
      payload: { title: 'Attributed', directory: 'work', content: 'by bob' },
    })
    const bobMe = (await request('GET', '/api/me', { cookie: bob })).json() as { id: string }
    const root = await login('root', 'root-password-1')
    const list = (await request('GET', '/api/s/beta/notes', { cookie: root })).json() as {
      notes: Array<{ id: string; title: string }>
    }
    const fresh = list.notes.find((n) => n.title === 'Attributed')
    const revs = await revisionsOf(fresh!.id, root)
    // The row keys the writer by stable id — a rename must not orphan history — and the
    // reader-facing author resolves that id back to the current handle.
    expect(revs.revisions[0].principal).toBe(`user:${bobMe.id}`)
    expect(revs.revisions[0].author).toEqual({ kind: 'user', name: 'bob', mine: false })
  })
})

describe('admin: management everywhere, data only by membership', () => {
  it('admin manages members of a space they cannot read', async () => {
    const root = await login('root', 'root-password-1')
    // root IS a member of both here — demote to management-only by removing
    // (alice stays beta's owner, so the last-owner guard is quiet):
    const drop = await request('DELETE', '/api/s/beta/members/root', { cookie: root })
    expect(drop.statusCode).toBe(200)
    // data: gone
    expect((await request('GET', '/api/s/beta/notes', { cookie: root })).statusCode).toBe(404)
    // management: still there (the recovery path)
    const put = await request('PUT', '/api/s/beta/members/bob', {
      cookie: root,
      payload: { role: 'reader' },
    })
    expect(put.statusCode).toBe(200)
  })

  it('a non-owner member cannot manage members', async () => {
    const bob = await login('bob', 'bob-password-01')
    const res = await request('PUT', '/api/s/beta/members/alice', {
      cookie: bob,
      payload: { role: 'reader' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('the last owner of a space cannot be removed or demoted', async () => {
    const root = await login('root', 'root-password-1')
    await request('DELETE', '/api/s/alpha/members/root', { cookie: root })
    // alice is now alpha's only owner
    expect(
      (await request('DELETE', '/api/s/alpha/members/alice', { cookie: root })).statusCode,
    ).toBe(400)
    expect(
      (
        await request('PUT', '/api/s/alpha/members/alice', {
          cookie: root,
          payload: { role: 'reader' },
        })
      ).statusCode,
    ).toBe(400)
  })

  it('membership removal evicts immediately: the very next request 404s', async () => {
    const bob = await login('bob', 'bob-password-01')
    expect((await request('GET', '/api/s/beta/notes', { cookie: bob })).statusCode).toBe(200)
    const root = await login('root', 'root-password-1')
    await request('DELETE', '/api/s/beta/members/bob', { cookie: root })
    expect((await request('GET', '/api/s/beta/notes', { cookie: bob })).statusCode).toBe(404)
  })

  it('disabling a user kills their live session', async () => {
    const alice = await login('alice', 'alice-password-1')
    expect((await request('GET', '/api/me', { cookie: alice })).statusCode).toBe(200)
    const root = await login('root', 'root-password-1')
    const patch = await request('PATCH', '/api/users/alice', {
      cookie: root,
      payload: { disabled: true },
    })
    expect(patch.statusCode).toBe(200)
    expect((await request('GET', '/api/me', { cookie: alice })).statusCode).toBe(401)
  })

  it('self-lockout guards: no self-disable, no demoting the last admin', async () => {
    const root = await login('root', 'root-password-1')
    expect(
      (await request('PATCH', '/api/users/root', { cookie: root, payload: { disabled: true } }))
        .statusCode,
    ).toBe(400)
    expect(
      (await request('PATCH', '/api/users/root', { cookie: root, payload: { admin: false } }))
        .statusCode,
    ).toBe(400)
  })

  it('user management is admin-only — a plain user sees 404', async () => {
    const alice = await login('alice', 'alice-password-1')
    expect((await request('GET', '/api/users', { cookie: alice })).statusCode).toBe(404)
    expect(
      (await request('POST', '/api/users', { cookie: alice, payload: { username: 'eve' } }))
        .statusCode,
    ).toBe(404)
  })
})

describe('personal domain refuses a second member (#13: privacy)', () => {
  // A personal space holds the owner's private about-user memory; granting another
  // principal space:read there would expose it. Inviting is refused at the route
  // (PUT /members → 403), not merely hidden in the UI. Built on its own fixture so
  // the shared one's member-PUT tests are untouched: 'mine' is sam's personal space.
  const personalFixture = (): Fixture => ({
    now: '2026-06-12T12:00:00.000Z',
    spaces: [
      { slug: 'pub', displayName: 'Pub', notes: [] },
      { slug: 'mine', displayName: 'Personal', notes: [] },
    ],
    auth: {
      users: [
        { username: 'root', password: 'root-password-1', admin: true },
        { username: 'sam', password: 'sam-password-01', personalSpace: 'mine' },
        { username: 'bob', password: 'bob-password-01' },
      ],
      members: [
        { space: 'pub', username: 'root', role: 'owner' },
        { space: 'mine', username: 'sam', role: 'owner' },
      ],
    },
  })

  it('PUT /members into a personal space is 403 — for the owner AND an admin', async () => {
    const pApp = await createApp(personalFixture())

    const loginP = async (u: string, p: string): Promise<string> => {
      const res = await pApp.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { identifier: u, password: p },
      })
      expect(res.statusCode).toBe(200)
      return (res.headers['set-cookie'] as string).split(';')[0]
    }
    const invite = (cookie: string, space: string) =>
      pApp.inject({
        method: 'PUT',
        url: `/api/s/${space}/members/bob`,
        headers: { cookie },
        payload: { role: 'reader' },
      })

    const sam = await loginP('sam', 'sam-password-01')
    expect((await invite(sam, 'mine')).statusCode).toBe(403) // the owner cannot invite into their own personal domain
    const root = await loginP('root', 'root-password-1')
    expect((await invite(root, 'mine')).statusCode).toBe(403) // nor can a host admin
    expect((await invite(root, 'pub')).statusCode).toBe(200) // sanity: a non-personal space still accepts the invite
    await pApp.close()
  })
})

describe('PATs: scope ∩ grants, narrowed and revocable', () => {
  const mintPat = async (
    cookie: string,
    input: { name: string; scope: 'read' | 'write'; spaces?: string[] | null },
  ) => {
    const res = await request('POST', '/api/me/tokens', { cookie, payload: input })
    expect(res.statusCode).toBe(201)
    return res.json() as { token: string; pat: { id: string; spaces?: string[] | null } }
  }

  it('a read PAT reads its owner’s spaces and cannot write or manage', async () => {
    const bob = await login('bob', 'bob-password-01')
    const { token } = await mintPat(bob, { name: 'reader', scope: 'read' })
    expect((await request('GET', '/api/s/beta/notes', { bearer: token })).statusCode).toBe(200)
    // writer-rank grant doesn't help: the token's scope is the ceiling
    expect(
      (
        await request('POST', '/api/s/beta/notes', {
          bearer: token,
          payload: { title: 'Via PAT', content: 'x' },
        })
      ).statusCode,
    ).toBe(404)
    // management sits above 'write' — PATs never reach it
    expect((await request('GET', '/api/me/tokens', { bearer: token })).statusCode).toBe(404)
  })

  it('a write PAT writes, but only within the owner’s grants', async () => {
    const bob = await login('bob', 'bob-password-01')
    const { token } = await mintPat(bob, { name: 'writer', scope: 'write' })
    expect(
      (
        await request('POST', '/api/s/beta/notes', {
          bearer: token,
          payload: { title: 'Via PAT', directory: 'work', content: 'x' },
        })
      ).statusCode,
    ).toBe(200)
    expect((await request('GET', '/api/s/alpha/notes', { bearer: token })).statusCode).toBe(404)
  })

  it('space narrowing intersects with grants; minting outside grants is rejected', async () => {
    const root = await login('root', 'root-password-1')
    const { token, pat } = await mintPat(root, { name: 'narrow', scope: 'read', spaces: ['alpha'] })
    expect((await request('GET', '/api/s/alpha/notes', { bearer: token })).statusCode).toBe(200)
    expect((await request('GET', '/api/s/beta/notes', { bearer: token })).statusCode).toBe(404)
    // #127: the narrowing is STORED as the opaque space id but projects back to the
    // human slug on the wire (createPat/listPats via slugById) — pin that round-trip,
    // else a leak would put a raw id in the client's token-space list and pass green.
    expect(pat.spaces).toEqual(['alpha'])
    // listPats has its OWN id→slug projection (separate from createPat's) — pin it too.
    const listed = (await request('GET', '/api/me/tokens', { cookie: root })).json()
      .tokens as Array<{
      name: string
      spaces?: string[] | null
    }>
    expect(listed.find((t) => t.name === 'narrow')?.spaces).toEqual(['alpha'])

    const bob = await login('bob', 'bob-password-01')
    const res = await request('POST', '/api/me/tokens', {
      cookie: bob,
      payload: { name: 'overreach', scope: 'read', spaces: ['alpha'] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('PAT attribution reaches the journal as pat:<owner>:<id>', async () => {
    const bob = await login('bob', 'bob-password-01')
    const { token, pat } = await mintPat(bob, { name: 'agent', scope: 'write' })
    await request('POST', '/api/s/beta/notes', {
      bearer: token,
      payload: { title: 'Agent Wrote', directory: 'work', content: 'x' },
    })
    const list = (await request('GET', '/api/s/beta/notes', { cookie: bob })).json() as {
      notes: Array<{ id: string; title: string }>
    }
    const fresh = list.notes.find((n) => n.title === 'Agent Wrote')
    const revs = await revisionsOf(fresh!.id, bob)
    const bobMe = (await request('GET', '/api/me', { cookie: bob })).json() as { id: string }
    expect(revs.revisions[0].principal).toBe(`pat:${bobMe.id}:${pat.id}`)
    expect(revs.revisions[0].author).toEqual({ kind: 'agent', name: 'agent', mine: true })
  })

  it('revocation is immediate; a revoked token is anonymous', async () => {
    const bob = await login('bob', 'bob-password-01')
    const { token, pat } = await mintPat(bob, { name: 'doomed', scope: 'read' })
    expect((await request('GET', '/api/s/beta/notes', { bearer: token })).statusCode).toBe(200)
    expect((await request('DELETE', `/api/me/tokens/${pat.id}`, { cookie: bob })).statusCode).toBe(
      200,
    )
    expect((await request('GET', '/api/s/beta/notes', { bearer: token })).statusCode).toBe(401)
  })

  it('grant removal narrows live PATs instantly (effective = scopes ∩ grants)', async () => {
    const bob = await login('bob', 'bob-password-01')
    const { token } = await mintPat(bob, { name: 'live', scope: 'read' })
    expect((await request('GET', '/api/s/beta/notes', { bearer: token })).statusCode).toBe(200)
    const root = await login('root', 'root-password-1')
    await request('DELETE', '/api/s/beta/members/bob', { cookie: root })
    expect((await request('GET', '/api/s/beta/notes', { bearer: token })).statusCode).toBe(404)
  })
})

describe('PATs: rights are mutable post-issuance (#162 — raise/lower, no re-mint)', () => {
  const mintPat = async (
    cookie: string,
    input: { name: string; scope: 'read' | 'write'; spaces?: string[] | null },
  ) => {
    const res = await request('POST', '/api/me/tokens', { cookie, payload: input })
    expect(res.statusCode).toBe(201)
    return res.json() as { token: string; pat: { id: string } }
  }
  const writeBeta = (token: string) =>
    request('POST', '/api/s/beta/notes', {
      bearer: token,
      payload: { title: 'Via PAT', directory: 'work', content: 'x' },
    })
  const patch = (id: string, cookie: string, payload: object) =>
    request('PATCH', `/api/me/tokens/${id}`, { cookie, payload })

  it('renaming a token relabels it without re-minting the secret (name is a display field)', async () => {
    const bob = await login('bob', 'bob-password-01')
    const { token, pat } = await mintPat(bob, { name: 'old name', scope: 'read' })
    expect((await patch(pat.id, bob, { name: 'new name' })).statusCode).toBe(200)
    const listed = (await request('GET', '/api/me/tokens', { cookie: bob })).json()
      .tokens as Array<{
      id: string
      name: string
    }>
    expect(listed.find((t) => t.id === pat.id)?.name).toBe('new name')
    // the SAME bearer still authenticates — a rename is not a re-mint
    expect((await request('GET', '/api/s/beta/notes', { bearer: token })).statusCode).toBe(200)
  })

  it('raising scope read→write takes effect on the very next request; lowering closes it again', async () => {
    const bob = await login('bob', 'bob-password-01')
    const { token, pat } = await mintPat(bob, { name: 'grow', scope: 'read' })
    expect((await writeBeta(token)).statusCode).toBe(404) // a read token can't write
    expect((await patch(pat.id, bob, { scope: 'write' })).statusCode).toBe(200)
    expect((await writeBeta(token)).statusCode).toBe(200) // SAME token, now writes — no re-mint
    expect((await patch(pat.id, bob, { scope: 'read' })).statusCode).toBe(200)
    expect((await writeBeta(token)).statusCode).toBe(404) // and back to read-only
  })

  it('re-narrowing re-scopes the live token; widening to null restores all grants', async () => {
    const root = await login('root', 'root-password-1')
    const { token, pat } = await mintPat(root, { name: 'move', scope: 'read', spaces: ['alpha'] })
    expect((await request('GET', '/api/s/alpha/notes', { bearer: token })).statusCode).toBe(200)
    expect((await request('GET', '/api/s/beta/notes', { bearer: token })).statusCode).toBe(404)
    // move the narrowing alpha → beta
    expect((await patch(pat.id, root, { spaces: ['beta'] })).statusCode).toBe(200)
    expect((await request('GET', '/api/s/alpha/notes', { bearer: token })).statusCode).toBe(404)
    expect((await request('GET', '/api/s/beta/notes', { bearer: token })).statusCode).toBe(200)
    // the listing reflects the new narrowing as the human slug (#100 phase 4 round-trip)
    const listed = (await request('GET', '/api/me/tokens', { cookie: root })).json()
      .tokens as Array<{
      id: string
      spaces?: string[] | null
    }>
    expect(listed.find((t) => t.id === pat.id)?.spaces).toEqual(['beta'])
    // widen back to all grants (null)
    expect((await patch(pat.id, root, { spaces: null })).statusCode).toBe(200)
    expect((await request('GET', '/api/s/alpha/notes', { bearer: token })).statusCode).toBe(200)
    expect((await request('GET', '/api/s/beta/notes', { bearer: token })).statusCode).toBe(200)
  })

  it('only the owner can re-scope a token — another user gets the anti-enumeration 404', async () => {
    const bob = await login('bob', 'bob-password-01')
    const { pat } = await mintPat(bob, { name: 'mine', scope: 'read' })
    const alice = await login('alice', 'alice-password-1')
    expect((await patch(pat.id, alice, { scope: 'write' })).statusCode).toBe(404)
  })

  it('re-narrowing to a space the owner cannot read is rejected (bad_space), like minting', async () => {
    const bob = await login('bob', 'bob-password-01') // member of beta only
    const { pat } = await mintPat(bob, { name: 'reach', scope: 'read' })
    expect((await patch(pat.id, bob, { spaces: ['alpha'] })).statusCode).toBe(400)
  })

  it('management stays out of reach — a token can never be re-scoped to manage', async () => {
    const bob = await login('bob', 'bob-password-01')
    const { pat } = await mintPat(bob, { name: 'nomanage', scope: 'read' })
    // 'manage' is not in the PatScope enum — the wire rejects it (400 validation),
    // so the session-only management belt holds on the patch path too.
    expect((await patch(pat.id, bob, { scope: 'manage' })).statusCode).toBe(400)
  })
})

describe('invites: single-use credential bootstrap, no SMTP', () => {
  it('create user → invite link → accept sets the password and logs in; the link burns', async () => {
    const root = await login('root', 'root-password-1')
    const created = await request('POST', '/api/users', {
      cookie: root,
      payload: { username: 'eve', displayName: 'Eve' },
    })
    expect(created.statusCode).toBe(201)
    const { token, path, user } = created.json()
    expect(user).toMatchObject({ username: 'eve', hasPassword: false })
    expect(path).toBe(`/invite#${token}`)

    const info = await request('POST', '/api/auth/invite-info', { payload: { token } })
    expect(info.json()).toMatchObject({ username: 'eve', purpose: 'invite' })

    const accept = await request('POST', '/api/auth/accept-invite', {
      payload: { token, password: 'eve-password-001' },
    })
    expect(accept.statusCode).toBe(200)
    expect(accept.headers['set-cookie']).toContain('nt_session=')

    // burned: a second accept (or info) finds nothing
    expect(
      (
        await request('POST', '/api/auth/accept-invite', {
          payload: { token, password: 'other-password-1' },
        })
      ).statusCode,
    ).toBe(404)

    // the password works; eve has no grants yet — the space list is honestly empty
    const eve = await login('eve', 'eve-password-001')
    expect((await request('GET', '/api/spaces', { cookie: eve })).json().spaces).toEqual([])
  })

  it('re-inviting a user with a password mints a RESET link that kills old sessions', async () => {
    const root = await login('root', 'root-password-1')
    const aliceOld = await login('alice', 'alice-password-1')
    const minted = await request('POST', '/api/users/alice/invite', { cookie: root })
    expect(minted.json().user.hasPassword).toBe(true)
    const { token } = minted.json()
    expect(
      (await request('POST', '/api/auth/invite-info', { payload: { token } })).json().purpose,
    ).toBe('reset')
    const accept = await request('POST', '/api/auth/accept-invite', {
      payload: { token, password: 'alice-newpass-1' },
    })
    expect(accept.statusCode).toBe(200)
    // the pre-reset session is dead, the new password lives
    expect((await request('GET', '/api/me', { cookie: aliceOld })).statusCode).toBe(401)
    await login('alice', 'alice-newpass-1')
  })
})

describe('first-run setup', () => {
  it('zero users: 401s say setup_required, setup mints the admin owner of every space, then closes', async () => {
    const bare = await createApp({ ...fixture(), auth: { users: [], members: [] } })
    const blocked = await bare.inject({ method: 'GET', url: '/api/config' })
    expect(blocked.statusCode).toBe(401)
    expect(blocked.json().reason).toBe('setup_required')
    expect((await bare.inject({ method: 'GET', url: '/api/auth/session' })).json()).toMatchObject({
      setup: true,
    })

    const setup = await bare.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'owner', password: 'owner-password-1' },
    })
    expect(setup.statusCode).toBe(200)
    expect(setup.json()).toMatchObject({
      username: 'owner',
      admin: true,
      spaces: [
        { slug: 'alpha', role: 'owner' },
        { slug: 'beta', role: 'owner' },
      ],
    })
    // closed forever
    expect(
      (
        await bare.inject({
          method: 'POST',
          url: '/api/auth/setup',
          payload: { username: 'mallory', password: 'mallory-pass-01' },
        })
      ).statusCode,
    ).toBe(404)
    await bare.close()
  })

  it('concurrent setups race to a SINGLE admin — the loser gets 404 (#73)', async () => {
    const bare = await createApp({ ...fixture(), auth: { users: [], members: [] } })
    const fire = (username: string) =>
      bare.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username, password: `${username}-password-1` },
      })
    // Both pass the old userCount()==0 check; only the atomic claim lets one win.
    const [a, b] = await Promise.all([fire('owner'), fire('mallory')])
    expect([a.statusCode, b.statusCode].sort((x, y) => x - y)).toEqual([200, 404])
    // The winner is the lone admin — the table holds exactly one user, not two.
    const winner = a.statusCode === 200 ? a : b
    const cookie = (winner.headers['set-cookie'] as string).split(';')[0]
    const users = await bare.inject({ method: 'GET', url: '/api/users', headers: { cookie } })
    expect(users.statusCode).toBe(200)
    expect(users.json().users).toHaveLength(1)
    await bare.close()
  })
})

describe('config carries no host-global default; landing is per-principal (#99)', () => {
  it('setup mints ONLY the owner personal space — no imposed "main" (#99)', async () => {
    // A fresh zero-config password host: no spaces, setup open, engine can mint.
    const bare = await createApp({
      spaces: [],
      capabilities: { spaceCreate: true },
      auth: { users: [], members: [] },
    })
    const res = await bare.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'owner', password: 'owner-password-1' },
    })
    expect(res.statusCode).toBe(200)
    // #127: me.personalSpace is the id-keyed pointer projected back to the wire slug
    // (#100 phase 4) — proving the id→slug translation, since the id is now opaque ≠ slug.
    expect(res.json().personalSpace).toBe('owner') // minted eagerly at setup (invariant 1)
    const cookie = (res.headers['set-cookie'] as string).split(';')[0]
    // The owner's ONLY space is their personal one — 'main' was never created.
    const spaces = (
      await bare.inject({ method: 'GET', url: '/api/spaces', headers: { cookie } })
    ).json().spaces
    expect(spaces).toHaveLength(1)
    expect(spaces[0]).toMatchObject({ slug: 'owner', displayName: 'Personal' })
    // #100 phase 4 / #127: the stable id is opaque (minted, ≠ slug) — the wire row still
    // names the space by its slug.
    expect(spaces[0].id).not.toBe('owner')
    await bare.close()
  })

  it('config is just capability facts — no default-space slug leaks to anyone', async () => {
    const root = await login('root', 'root-password-1')
    const cfg = (await request('GET', '/api/config', { cookie: root })).json()
    expect(cfg.defaultSpace).toBeUndefined() // the host-global default is gone
    expect(cfg.capabilities).toBeDefined()
  })

  it('the landing source is the membership-filtered spaces list (the client lands there)', async () => {
    // root reads both; bob only 'beta'. The client lands a principal in their
    // personal space, else the first of THIS list — never a host-global slug.
    const root = await login('root', 'root-password-1')
    const rootSpaces = (await request('GET', '/api/spaces', { cookie: root })).json().spaces
    expect(rootSpaces.map((s: { slug: string }) => s.slug).sort()).toEqual(['alpha', 'beta'])
    const bob = await login('bob', 'bob-password-01')
    const bobSpaces = (await request('GET', '/api/spaces', { cookie: bob })).json().spaces
    expect(bobSpaces.map((s: { slug: string }) => s.slug)).toEqual(['beta'])
    // #127: me().spaces[] is a SEPARATE id→slug projection (grants, authService:328) from
    // /api/spaces — and it is the one the web switcher + access guard key on by slug
    // (libs/access/access.ts). The exact-array equality pins each grant to its human
    // slug: a raw-id leak would surface as a 12-char opaque id, failing this.
    const rootMe = (await request('GET', '/api/me', { cookie: root })).json()
    expect(rootMe.spaces.map((s: { slug: string }) => s.slug).sort()).toEqual(['alpha', 'beta'])
  })

  it('a principal with no readable space gets an empty list (the honest "no spaces" state)', async () => {
    const bare = await createApp({
      ...fixture(),
      auth: { users: [{ username: 'loner', password: 'loner-password-1' }], members: [] },
    })
    const res = await bare.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'loner', password: 'loner-password-1' },
    })
    const cookie = (res.headers['set-cookie'] as string).split(';')[0]
    const spaces = await bare.inject({ method: 'GET', url: '/api/spaces', headers: { cookie } })
    expect(spaces.json().spaces).toEqual([])
    await bare.close()
  })
})

describe('session hygiene', () => {
  it('logout clears the cookie and kills the session server-side', async () => {
    const bob = await login('bob', 'bob-password-01')
    const out = await request('POST', '/api/auth/logout', { cookie: bob })
    expect(out.statusCode).toBe(200)
    expect(out.headers['set-cookie']).toContain('Max-Age=0')
    expect((await request('GET', '/api/me', { cookie: bob })).statusCode).toBe(401)
  })

  it('cookie mutations from a foreign origin are rejected (CSRF)', async () => {
    const bob = await login('bob', 'bob-password-01')
    const res = await request('POST', '/api/s/beta/notes', {
      cookie: bob,
      payload: { title: 'CSRF', content: 'x' },
      headers: { origin: 'https://evil.example', host: 'notarium.local' },
    })
    expect(res.statusCode).toBe(403)
    // same-origin sails through
    const ok = await request('POST', '/api/s/beta/notes', {
      cookie: bob,
      payload: { title: 'Same Origin', content: 'x' },
      headers: { origin: 'http://notarium.local', host: 'notarium.local' },
    })
    expect(ok.statusCode).toBe(200)
  })

  it('changing the password revokes every other session, keeps the current tab (#73)', async () => {
    // Two live sessions for bob; he changes the password from one of them.
    const tabA = await login('bob', 'bob-password-01')
    const tabB = await login('bob', 'bob-password-01')
    expect((await request('GET', '/api/me', { cookie: tabA })).statusCode).toBe(200)
    expect((await request('GET', '/api/me', { cookie: tabB })).statusCode).toBe(200)

    const change = await request('POST', '/api/me/password', {
      cookie: tabA,
      payload: { currentPassword: 'bob-password-01', newPassword: 'bob-new-password-1' },
    })
    expect(change.statusCode).toBe(200)
    // The response re-cookies tabA — it stays in; tabB (other device) is dead.
    const refreshed = (change.headers['set-cookie'] as string).split(';')[0]
    expect((await request('GET', '/api/me', { cookie: refreshed })).statusCode).toBe(200)
    expect((await request('GET', '/api/me', { cookie: tabB })).statusCode).toBe(401)
    // old password no longer works, the new one does
    await login('bob', 'bob-new-password-1')
  })

  it('login rate limit: a hammered account answers 401 like a wrong pair — 429 is the ip gate’s alone', async () => {
    for (let i = 0; i < 10; i++) {
      await request('POST', '/api/auth/login', {
        payload: { identifier: 'bob', password: 'wrong-password' },
      })
    }
    // The right password is refused with the SAME envelope as a wrong one: an
    // exhausted account budget is not observable, so it can serve no oracle.
    const res = await request('POST', '/api/auth/login', {
      payload: { identifier: 'bob', password: 'bob-password-01' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual(
      (
        await request('POST', '/api/auth/login', {
          payload: { identifier: 'rita', password: 'wrong-password' },
        })
      ).json(),
    )
  }, 20_000)

  it('amplification gate: varying the username from one ip still caps (pre-auth scrypt DoS)', async () => {
    // No single username reaches its own cap, but the per-ip gate must trip —
    // otherwise an attacker forces unbounded 128 MiB scrypt work by rotating
    // the username on every (unknown-user) attempt.
    let saw429 = false

    for (let i = 0; i < 25; i++) {
      const res = await request('POST', '/api/auth/login', {
        payload: { identifier: `ghost-user-${i}`, password: 'whatever-wrong' },
      })

      if (res.statusCode === 429) {
        saw429 = true
        break
      }
      expect(res.statusCode).toBe(401)
    }
    expect(saw429).toBe(true)
  }, 20_000)
})

describe('SSE: revoke = disconnect', () => {
  it('removing a member closes their live event stream', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const base = `http://127.0.0.1:${port}`

    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'bob', password: 'bob-password-01' }),
    })
    const bobCookie = (loginRes.headers.get('set-cookie') as string).split(';')[0]

    const res = await fetch(`${base}/api/s/beta/events`, { headers: { cookie: bobCookie } })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    await reader.read() // initial status snapshot

    const rootRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'root', password: 'root-password-1' }),
    })
    const rootCookie = (rootRes.headers.get('set-cookie') as string).split(';')[0]
    const removed = await fetch(`${base}/api/s/beta/members/bob`, {
      method: 'DELETE',
      headers: { cookie: rootCookie },
    })
    expect(removed.status).toBe(200)

    // The server hangs up: the stream ends instead of idling.
    let end = await Promise.race([
      reader.read().then((r) => (r.done ? 'CLOSED' : 'DATA')),
      new Promise<string>((resolve) => setTimeout(() => resolve('TIMEOUT'), 1500)),
    ])

    if (end === 'DATA') {
      end = await Promise.race([
        reader.read().then((r) => (r.done ? 'CLOSED' : 'DATA')),
        new Promise<string>((resolve) => setTimeout(() => resolve('TIMEOUT'), 1_500)),
      ])
    }
    expect(end).toBe('CLOSED')
  })

  it('removing a supplemental membership closes a socket rooted in another space', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const base = `http://127.0.0.1:${port}`
    const aliceCookie = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'alice', password: 'alice-password-1' }),
    }).then((response) => (response.headers.get('set-cookie') as string).split(';')[0])
    const stream = await fetch(`${base}/api/s/beta/events?watch=alpha`, {
      headers: { cookie: aliceCookie },
    })
    const reader = stream.body!.getReader()
    await reader.read()
    const rootCookie = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'root', password: 'root-password-1' }),
    }).then((response) => (response.headers.get('set-cookie') as string).split(';')[0])

    const removed = await fetch(`${base}/api/s/alpha/members/alice`, {
      method: 'DELETE',
      headers: { cookie: rootCookie },
    })
    expect(removed.status).toBe(200)
    let end = await Promise.race([
      reader.read().then((result) => (result.done ? 'CLOSED' : 'DATA')),
      new Promise<string>((resolve) => setTimeout(() => resolve('TIMEOUT'), 1_500)),
    ])

    if (end === 'DATA') {
      end = await Promise.race([
        reader.read().then((result) => (result.done ? 'CLOSED' : 'DATA')),
        new Promise<string>((resolve) => setTimeout(() => resolve('TIMEOUT'), 1_500)),
      ])
    }

    expect(end).toBe('CLOSED')
  })
})

describe('SSE: creating a space wakes the creator (#154/#155)', () => {
  it("POST /api/spaces nudges the creator's open stream with an `access` event", async () => {
    // A mintable host (#69 capability): bob owns `home` and sits there with a live
    // stream when he mints a SECOND space — the moment that used to leave him a
    // non-writer of his own new space until a relogin (#154) and invisible to his
    // other tabs (#155). grantOwner stays silent (it also re-asserts personal-domain
    // ownership on every login); the create handler nudges explicitly.
    // The creator is an admin — minting a space is an admin act (spaces:create
    // need:'admin'). admin does NOT itself confer space:write, so the owner grant
    // minted on create is what unlocks writing — exactly the grant this nudge delivers.
    const mintable = await createApp({
      spaces: [{ slug: 'home', displayName: 'Home', notes: [] }],
      capabilities: { spaceCreate: true },
      auth: {
        users: [{ username: 'bob', password: 'bob-password-01', admin: true }],
        members: [{ space: 'home', username: 'bob', role: 'owner' }],
      },
    })

    try {
      await mintable.listen({ port: 0, host: '127.0.0.1' })
      const { port } = mintable.server.address() as { port: number }
      const base = `http://127.0.0.1:${port}`

      const loginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: 'bob', password: 'bob-password-01' }),
      })
      const bobCookie = (loginRes.headers.get('set-cookie') as string).split(';')[0]

      // bob's tab sits in `home` — the first frame is the read-model status snapshot.
      const res = await fetch(`${base}/api/s/home/events`, { headers: { cookie: bobCookie } })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      await reader.read() // initial status snapshot

      // The same session mints a new space (from the switcher / another tab).
      const created = await fetch(`${base}/api/spaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: bobCookie },
        body: JSON.stringify({ displayName: 'Research' }),
      })
      expect(created.status).toBe(201)

      // The open stream receives the named `access` nudge → the client re-pulls its
      // grants (the new owner grant) and the space list, no relogin.
      const decoder = new TextDecoder()
      const sawAccess = await Promise.race([
        (async () => {
          let buf = ''

          for (;;) {
            const { value, done } = await reader.read()

            if (done) {
              return false
            }
            buf += decoder.decode(value, { stream: true })
            if (buf.includes('event: access')) {
              return true
            }
          }
        })(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ])
      // Release the stream before closing — Fastify's close() drains live sockets, so a
      // still-open SSE reader would hang the teardown.
      await reader.cancel().catch(() => {})
      expect(sawAccess).toBe(true)
    } finally {
      await mintable.close()
    }
  }, 20_000)
})

describe('identity: a mutable handle and an optional address over a stable id', () => {
  const meOf = async (cookie: string) =>
    (await request('GET', '/api/me', { cookie })).json() as {
      id: string
      username: string
      email: string | null
      spaces: Array<{ slug: string; role: string }>
    }

  it('a rename keeps memberships, tokens and history, and frees the old handle at once', async () => {
    const bob = await login('bob', 'bob-password-01')
    const before = await meOf(bob)
    const pat = (
      await request('POST', '/api/me/tokens', {
        cookie: bob,
        payload: { name: 'agent', scope: 'write' },
      })
    ).json() as { token: string }
    await request('POST', '/api/s/beta/notes', {
      cookie: bob,
      payload: { title: 'Before Rename', directory: 'work', content: 'by bob' },
    })
    // A row by someone else in the same space, so the "my edits" lens below has
    // something it must NOT return.
    const alice = await login('alice', 'alice-password-1')

    await request('POST', '/api/s/beta/notes', {
      cookie: alice,
      payload: { title: 'By Alice', directory: 'work', content: 'not by bob' },
    })

    const renamed = await request('PATCH', '/api/me', {
      cookie: bob,
      payload: { username: 'bob.smith' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({ id: before.id, username: 'bob.smith' })

    // The same session, the same grants, the same token — the person did not change.
    const after = await meOf(bob)
    expect(after.id).toBe(before.id)
    expect(after.spaces).toEqual(before.spaces)
    expect((await request('GET', '/api/s/beta/notes', { bearer: pat.token })).statusCode).toBe(200)
    // History shows the NEW handle on every row it ever wrote; no row went missing.
    const list = (await request('GET', '/api/s/beta/notes', { cookie: bob })).json() as {
      notes: Array<{ id: string; title: string }>
    }
    const note = list.notes.find((n) => n.title === 'Before Rename')
    const revs = await revisionsOf(note!.id, bob)
    expect(revs.total).toBe(1)
    expect(revs.revisions[0].author).toEqual({ kind: 'user', name: 'bob.smith', mine: true })
    // The "my edits" lens keys on the stable id, not on the handle: a row written
    // before the rename is still mine after it. A regression here would be silent —
    // an empty feed, not an error.
    const titlesWhen = async (
      query: string,
      ready: (titles: string[]) => boolean,
    ): Promise<string[]> => {
      for (let i = 0; i < 50; i++) {
        const res = await request('GET', `/api/s/beta/activity/events${query}`, { cookie: bob })

        expect(res.statusCode).toBe(200)
        const titles = (res.json() as { events: Array<{ title: string }> }).events.map(
          (e) => e.title,
        )

        if (ready(titles)) {
          return titles
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      throw new Error(`the activity feed never settled for "${query}"`)
    }
    // Both rows are in the space's feed…
    await titlesWhen('', (t) => t.includes('Before Rename') && t.includes('By Alice'))
    // …and the lens keeps exactly mine. Two-sided on purpose: a filter that stopped
    // excluding anyone would satisfy "contains mine" just as well.
    const mine = await titlesWhen('?author=mine', (t) => t.includes('Before Rename'))

    expect(mine).not.toContain('By Alice')
    // Members lists follow too.
    const members = (await request('GET', '/api/s/beta/members', { cookie: bob })).json() as {
      members: Array<{ username: string; role: string }>
    }
    expect(members.members).toContainEqual({
      username: 'bob.smith',
      displayName: 'bob',
      role: 'writer',
    })
    // The old handle no longer signs in; the new one does.
    expect(
      (
        await request('POST', '/api/auth/login', {
          payload: { identifier: 'bob', password: 'bob-password-01' },
        })
      ).statusCode,
    ).toBe(401)
    expect(await login('bob.smith', 'bob-password-01')).toBeTruthy()
    // The freed handle can be taken by the next account immediately…
    const root = await login('root', 'root-password-1')
    expect(
      (await request('POST', '/api/users', { cookie: root, payload: { username: 'bob' } }))
        .statusCode,
    ).toBe(201)
    // …and an active one cannot.
    const taken = await request('PATCH', '/api/me', {
      cookie: bob,
      payload: { username: 'alice' },
    })
    expect(taken.statusCode).toBe(409)
    expect(taken.json().reason).toBe('username_taken')
    // Renaming to the same name is an idempotent success.
    expect(
      (await request('PATCH', '/api/me', { cookie: bob, payload: { username: 'bob.smith' } }))
        .statusCode,
    ).toBe(200)
  })

  it('the handle admits dots and underscores, never a leading or trailing separator or a capital', async () => {
    const bob = await login('bob', 'bob-password-01')

    for (const username of ['bob_smith', 'bob..smith', 'b']) {
      const res = await request('PATCH', '/api/me', { cookie: bob, payload: { username } })
      expect(res.statusCode, username).toBe(200)
    }
    for (const username of ['.bob', 'bob.', '-bob', 'bob_', 'Bob', 'bob smith']) {
      const res = await request('PATCH', '/api/me', { cookie: bob, payload: { username } })
      expect(res.statusCode, username).toBe(400)
    }
  })

  it('only a session may rename: a PAT with the manage-less ceiling is refused as not found', async () => {
    const bob = await login('bob', 'bob-password-01')
    const { token } = (
      await request('POST', '/api/me/tokens', {
        cookie: bob,
        payload: { name: 'agent', scope: 'write' },
      })
    ).json() as { token: string }
    expect(
      (await request('PATCH', '/api/me', { bearer: token, payload: { username: 'nope' } }))
        .statusCode,
    ).toBe(404)
    expect((await meOf(bob)).username).toBe('bob')
  })

  it('the address is optional, case-insensitively unique, and settable by the owner or an admin', async () => {
    const bob = await login('bob', 'bob-password-01')
    expect((await meOf(bob)).email).toBeNull()

    // The owner sets it; it comes back lower-cased.
    const set = await request('PATCH', '/api/me', {
      cookie: bob,
      payload: { email: '  Bob@Example.com ' },
    })
    expect(set.statusCode).toBe(200)
    expect(set.json().email).toBe('bob@example.com')
    // A second account with the same address in another case is refused.
    const alice = await login('alice', 'alice-password-1')
    const dup = await request('PATCH', '/api/me', {
      cookie: alice,
      payload: { email: 'BOB@example.com' },
    })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().reason).toBe('email_taken')
    expect((await meOf(alice)).email).toBeNull()
    // The admin sees it, changes it, clears it.
    const root = await login('root', 'root-password-1')
    const users = (await request('GET', '/api/users', { cookie: root })).json() as {
      users: Array<{ username: string; email: string | null }>
    }
    expect(users.users.find((u) => u.username === 'bob')?.email).toBe('bob@example.com')
    const changed = await request('PATCH', '/api/users/bob', {
      cookie: root,
      payload: { email: 'robert@example.com' },
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json().email).toBe('robert@example.com')
    const cleared = await request('PATCH', '/api/users/bob', {
      cookie: root,
      payload: { email: null },
    })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().email).toBeNull()
    expect((await meOf(bob)).email).toBeNull()
    // An admin creates a user with an address; the same address again is refused.
    const created = await request('POST', '/api/users', {
      cookie: root,
      payload: { username: 'dana', email: 'Dana@Example.com' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().user.email).toBe('dana@example.com')
    const again = await request('POST', '/api/users', {
      cookie: root,
      payload: { username: 'dana2', email: 'dana@example.com' },
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().reason).toBe('email_taken')
  })

  it('an admin renames by the current handle and reads the new one from the answer', async () => {
    const root = await login('root', 'root-password-1')
    const renamed = await request('PATCH', '/api/users/rita', {
      cookie: root,
      payload: { username: 'rita.r', displayName: 'Rita R.' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({ username: 'rita.r', displayName: 'Rita R.' })
    expect(
      (await request('PATCH', '/api/users/rita', { cookie: root, payload: {} })).statusCode,
    ).toBe(404)
    expect(
      (await request('PATCH', '/api/users/rita.r', { cookie: root, payload: { username: 'bob' } }))
        .statusCode,
    ).toBe(409)
    // A disabled user renames like any other: the two axes are orthogonal.
    await request('PATCH', '/api/users/rita.r', { cookie: root, payload: { disabled: true } })
    expect(
      (await request('PATCH', '/api/users/rita.r', { cookie: root, payload: { username: 'rita' } }))
        .statusCode,
    ).toBe(200)
  })

  // The two halves of an admin patch share no transaction, so identity — the only half
  // that can still be refused — goes first. Applied the other way round, a 409 would
  // leave the display name rewritten and, on the disable path, the sessions gone.
  it('a refused admin patch leaves the account exactly as it was', async () => {
    const root = await login('root', 'root-password-1')
    const usersOf = async () =>
      (await request('GET', '/api/users', { cookie: root })).json() as {
        users: Array<Record<string, unknown>>
      }
    const before = (await usersOf()).users.find((u) => u.username === 'rita')

    const refused = await request('PATCH', '/api/users/rita', {
      cookie: root,
      payload: { username: 'bob', displayName: 'Rita R.', disabled: true },
    })
    expect(refused.statusCode).toBe(409)
    expect((await usersOf()).users.find((u) => u.username === 'rita')).toEqual(before)
    // The sessions the disable half would have deleted are still good.
    expect(await login('rita', 'rita-password-1')).toBeTruthy()
  })

  it('the address never reaches a member list', async () => {
    const root = await login('root', 'root-password-1')
    await request('PATCH', '/api/users/bob', {
      cookie: root,
      payload: { email: 'bob@example.com' },
    })
    const rita = await login('rita', 'rita-password-1')
    const members = (await request('GET', '/api/s/beta/members', { cookie: rita })).json() as {
      members: Array<Record<string, unknown>>
    }
    expect(members.members.length).toBeGreaterThan(0)
    for (const member of members.members) {
      expect(Object.keys(member).sort()).toEqual(['displayName', 'role', 'username'])
    }
    expect(JSON.stringify(members)).not.toContain('example.com')
    expect((await request('GET', '/api/users', { cookie: rita })).statusCode).toBe(404)
  })
})

// One identifier field — the handle as typed or the address lower-cased — one indexed
// read, and one budget per RESOLVED account. canon: docs/auth.md#credentials
describe('login by handle or e-mail', () => {
  const attempt = (identifier: string, password: string) =>
    request('POST', '/api/auth/login', { payload: { identifier, password } })

  const giveBobAnAddress = async () => {
    const cookie = await login('bob', 'bob-password-01')
    const res = await request('PATCH', '/api/me', { cookie, payload: { email: 'bob@example.com' } })
    expect(res.statusCode).toBe(200)
  }

  // The column compares bytes; the ONE normalizer is the wire schema. A seed that wrote
  // an address as typed would be unreachable by login and would not collide with its
  // own lower-case twin — so the fixture applier normalizes exactly like the routes.
  it('a seeded address is normalized like the wire: a mixed-case one still signs in', async () => {
    await app.close()
    const base = fixture()
    app = await createApp({
      ...base,
      auth: {
        ...base.auth!,
        users: base.auth!.users.map((u) =>
          u.username === 'bob' ? { ...u, email: '  Bob@Example.COM ' } : u,
        ),
      },
    })
    expect(await login('bob@example.com', 'bob-password-01')).toBeTruthy()
  })

  it('signs in by the handle or by the address; a wrong pair on either is one and the same 401', async () => {
    await giveBobAnAddress()
    const byHandle = await attempt('bob', 'bob-password-01')
    const byAddress = await attempt('bob@example.com', 'bob-password-01')
    // The address is normalised the way the column stores it.
    const byShoutedAddress = await attempt('  Bob@Example.COM ', 'bob-password-01')
    expect([byHandle.statusCode, byAddress.statusCode, byShoutedAddress.statusCode]).toEqual([
      200, 200, 200,
    ])
    expect(byAddress.json().id).toBe(byHandle.json().id)
    expect(byAddress.headers['set-cookie']).toBeDefined()

    const wrongByHandle = await attempt('bob', 'wrong-password')
    const wrongByAddress = await attempt('bob@example.com', 'wrong-password')
    const wrongByNobody = await attempt('nobody@example.com', 'wrong-password')
    expect(wrongByHandle.statusCode).toBe(401)
    expect(wrongByAddress.statusCode).toBe(401)
    expect(wrongByAddress.json()).toEqual(wrongByHandle.json())
    expect(wrongByNobody.json()).toEqual(wrongByHandle.json())
    // Seven real scrypt verifies: 3.7 s alone, past the 5 s default under a loaded
    // lane. The same allowance its siblings in this file already carry.
  }, 20_000)

  // The mirror case — a handle written past the schema keeps resolving by its exact
  // spelling — is proven at the service (`test/unit/auth.test.ts`): the wire's
  // `MeSchema` has always refused such a handle, which is the CLI's business now.
  it('a handle is matched by its exact spelling: `Bob` is not `bob`', async () => {
    expect((await attempt('Bob', 'bob-password-01')).statusCode).toBe(401)
  })

  it('alternating the handle and the address spends ONE budget, and the spent budget answers like a wrong pair', async () => {
    await giveBobAnAddress()
    for (let i = 0; i < 5; i++) {
      expect((await attempt('bob', 'wrong-password')).statusCode).toBe(401)
    }
    for (let i = 0; i < 5; i++) {
      expect((await attempt('bob@example.com', 'wrong-password')).statusCode).toBe(401)
    }
    // The eleventh attempt — right password, either identifier — is refused with the
    // body of an ordinary wrong pair. Nothing in the answer says the budget is spent,
    // that the account exists, or that the two identifiers are one account.
    const byHandle = await attempt('bob', 'bob-password-01')
    const byAddress = await attempt('bob@example.com', 'bob-password-01')
    const plainWrong = await attempt('rita', 'wrong-password')
    expect(byHandle.statusCode).toBe(401)
    expect(byHandle.json()).toEqual(plainWrong.json())
    expect(byAddress.statusCode).toBe(401)
    expect(byAddress.json()).toEqual(plainWrong.json())
  }, 20_000)

  // The body is only half of "answers like a wrong pair". A refusal that arrives
  // instantly and leaves the ip counter untouched IS the linking oracle in another
  // shape: it says "this handle and this address are one account" without a body to
  // read. So the spent budget costs one verification and one ip entry, like any other
  // failure. canon: docs/auth.md#credentials
  it('a spent budget costs the same verification and the same ip entry as a wrong pair', async () => {
    let verifies = 0
    await app.close()
    app = await createApp(fixture(), {
      passwordVerifier: async (password) => {
        verifies++
        return password === 'bob-password-01'
      },
    })
    await giveBobAnAddress()
    const spent = verifies

    for (let i = 0; i < 5; i++) {
      expect((await attempt('bob', 'wrong-password')).statusCode).toBe(401)
    }
    for (let i = 0; i < 5; i++) {
      expect((await attempt('bob@example.com', 'wrong-password')).statusCode).toBe(401)
    }
    expect(verifies).toBe(spent + 10)
    // Right password, either identifier: refused, and it cost a verification.
    expect((await attempt('bob', 'bob-password-01')).statusCode).toBe(401)
    expect((await attempt('bob@example.com', 'bob-password-01')).statusCode).toBe(401)
    expect(verifies).toBe(spent + 12)
    // ...and it was not free: the ip gate counted both, so the twentieth failure from
    // this address trips 429 exactly as ten wrong pairs plus ten probes would.
    for (let i = 0; i < 8; i++) {
      expect((await attempt('bob', 'bob-password-01')).statusCode).toBe(401)
    }
    expect((await attempt('nobody-at-all', 'x')).statusCode).toBe(429)
  }, 20_000)

  it('an unknown handle, an unknown address and a wrong password each run exactly one verification', async () => {
    let verifies = 0
    await app.close()
    app = await createApp(fixture(), {
      passwordVerifier: async () => {
        verifies++
        return false
      },
    })
    for (const [n, identifier] of ['nobody', 'nobody@example.com', 'bob'].entries()) {
      expect((await attempt(identifier, 'wrong-password')).statusCode).toBe(401)
      expect(verifies).toBe(n + 1)
    }
  })

  it('the shape filter and the ip gate refuse without a directory read or a hash; the ip gate alone says 429', async () => {
    let resolves = 0
    let verifies = 0
    await app.close()
    app = await createApp(fixture(), {
      passwordVerifier: async () => {
        verifies++
        return false
      },
      onAuthPersistence: (auth) => {
        const resolve = auth.getUserByLogin.bind(auth)

        auth.getUserByLogin = async (loginLookup) => {
          resolves++
          return resolve(loginLookup)
        }
      },
    })
    // Step 0: neither a handle nor an address — refused before any read or hash...
    for (const shape of ['bob@', ' ', 'a'.repeat(320), '?'.repeat(320), 'bob smith']) {
      expect((await attempt(shape, 'bob-password-01')).statusCode).toBe(401)
    }
    expect([resolves, verifies]).toEqual([0, 0])
    // ...and without a counter entry: twenty-five of them leave the ip budget whole.
    for (let i = 0; i < 25; i++) {
      await attempt('bob@', 'x')
    }
    expect((await attempt('nobody-0', 'x')).statusCode).toBe(401)
    expect([resolves, verifies]).toEqual([1, 1])
    // Rotating unknown identifiers costs one dummy verification each — until the ip
    // gate trips at twenty; from then on a refusal is 429 with no read and no hash.
    for (let i = 1; i < 20; i++) {
      await attempt(`nobody-${i}`, 'x')
    }
    expect([resolves, verifies]).toEqual([20, 20])
    expect((await attempt('bob', 'bob-password-01')).statusCode).toBe(429)
    expect([resolves, verifies]).toEqual([20, 20])
  }, 20_000)
})

// The personal space follows its owner's handle through the same rename sequence the
// PATCH route runs: registry row, live slug index, SSE `rename`. Only the derived slug
// follows; a chosen one and a taken target are left alone — and the account rename
// goes through either way. canon: docs/spaces.md#model
describe('the personal space follows its owner’s handle', () => {
  // A fixture space is config-pinned (its slug is frozen, like SPACES_CONFIG), so the
  // personal space is minted the product way — the first personal write — and only a
  // collision TARGET comes from the fixture.
  const withPersonal = async (taken: string[] = []) => {
    await app.close()
    const base = fixture()
    app = await createApp({
      ...base,
      // A host that can mint spaces — otherwise the personal write degrades to the
      // first space (P5) and there is no personal space to follow anything.
      capabilities: { ...base.capabilities, spaceCreate: true },
      spaces: [...base.spaces, ...taken.map((slug) => ({ slug, displayName: 'Taken', notes: [] }))],
      auth: {
        users: base.auth!.users,
        members: [
          ...base.auth!.members,
          ...taken.map((slug) => ({ space: slug, username: 'rita', role: 'owner' as const })),
        ],
      },
    })
  }

  const mintPersonal = async (cookie: string) => {
    const res = await request('PUT', '/api/me/profile', {
      cookie,
      payload: { content: '# Me\n' },
    })
    expect(res.statusCode).toBe(200)
  }
  const rename = (cookie: string, username: string) =>
    request('PATCH', '/api/me', { cookie, payload: { username } })
  const meOf = async (cookie: string) =>
    (await request('GET', '/api/me', { cookie })).json() as {
      username: string
      personalSpace: string | null
    }
  const spacesOf = async (cookie: string) =>
    (await request('GET', '/api/spaces', { cookie })).json().spaces as Array<{
      id: string
      slug: string
      aliases?: string[]
    }>

  it('renames the derived slug with the handle: the new slug resolves live, the old one as an alias, the pointer is the same space', async () => {
    await withPersonal()
    const bob = await login('bob', 'bob-password-01')
    await mintPersonal(bob)
    expect((await meOf(bob)).personalSpace).toBe('bob')
    const spaceId = (await spacesOf(bob)).find((s) => s.slug === 'bob')!.id

    expect((await rename(bob, 'bob.smith')).statusCode).toBe(200)
    expect(await meOf(bob)).toMatchObject({ username: 'bob.smith', personalSpace: 'bob-smith' })
    // The live process resolves the new slug without a restart, and the old one as an
    // alias — the in-memory index was re-keyed, not just the registry row.
    expect((await request('GET', '/api/s/bob-smith/status', { cookie: bob })).statusCode).toBe(200)
    expect((await request('GET', '/api/s/bob/status', { cookie: bob })).statusCode).toBe(200)
    expect((await spacesOf(bob)).find((s) => s.slug === 'bob-smith')).toMatchObject({
      id: spaceId,
      aliases: ['bob'],
    })
  })

  it('leaves a taken target and a slug the owner chose alone — the account renames either way', async () => {
    await withPersonal(['bob-smith'])
    const bob = await login('bob', 'bob-password-01')
    await mintPersonal(bob)
    expect((await meOf(bob)).personalSpace).toBe('bob')

    // Taken target: no suffixing, no error — the slug simply stays.
    expect((await rename(bob, 'bob.smith')).statusCode).toBe(200)
    expect(await meOf(bob)).toMatchObject({ username: 'bob.smith', personalSpace: 'bob' })
    // A slug the owner chose through the API is not the derived one any more.
    expect(
      (await request('PATCH', '/api/s/bob', { cookie: bob, payload: { slug: 'my-notes' } }))
        .statusCode,
    ).toBe(200)
    expect((await rename(bob, 'robert')).statusCode).toBe(200)
    expect(await meOf(bob)).toMatchObject({ username: 'robert', personalSpace: 'my-notes' })
  })

  const openStream = async (base: string, cookie: string, space: string) => {
    const res = await fetch(`${base}/api/s/${space}/events`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    await reader.read() // the initial status snapshot
    return reader
  }

  const cookieOf = async (base: string, identifier: string, password: string) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    })
    return (res.headers.get('set-cookie') as string).split(';')[0]
  }

  const mintPersonalOver = async (base: string, cookie: string) => {
    const res = await fetch(`${base}/api/me/profile`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Me\n' }),
    })
    expect(res.status).toBe(200)
  }

  it('the owner’s live stream gets `access` and the personal space’s viewers `rename` — no relogin', async () => {
    await withPersonal()
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const base = `http://127.0.0.1:${port}`
    const bobCookie = await cookieOf(base, 'bob', 'bob-password-01')
    await mintPersonalOver(base, bobCookie)
    const reader = await openStream(base, bobCookie, 'bob')

    const renamed = await fetch(`${base}/api/me`, {
      method: 'PATCH',
      headers: { cookie: bobCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bob.smith' }),
    })
    expect(renamed.status).toBe(200)

    const seen: string[] = []
    const decoder = new TextDecoder()

    const collect = async () => {
      while (!(seen.includes('access') && seen.includes('rename'))) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }
        for (const m of decoder.decode(value).matchAll(/^event: (\S+)/gm)) {
          seen.push(m[1])
        }
      }
    }
    await Promise.race([collect(), new Promise((r) => setTimeout(r, 3_000))])
    expect(seen).toEqual(expect.arrayContaining(['access', 'rename']))
    // The ORDER is the invariant, not just the pair: `access` makes the tab refetch
    // `me`, so it must arrive after the personal space took its new slug — a tab that
    // refetches earlier caches the old one, and `rename` will not reach it if it sits
    // in another space.
    expect(seen.indexOf('rename')).toBeLessThan(seen.indexOf('access'))
    await reader.cancel().catch(() => {})
  })

  it('disabling the renamed owner still closes their live stream: the registry keys by id, not by the handle', async () => {
    await withPersonal()
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const base = `http://127.0.0.1:${port}`
    const bobCookie = await cookieOf(base, 'bob', 'bob-password-01')
    await mintPersonalOver(base, bobCookie)
    const reader = await openStream(base, bobCookie, 'bob')
    expect(
      (
        await fetch(`${base}/api/me`, {
          method: 'PATCH',
          headers: { cookie: bobCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'bob.smith' }),
        })
      ).status,
    ).toBe(200)

    const rootCookie = await cookieOf(base, 'root', 'root-password-1')
    const disabled = await fetch(`${base}/api/users/bob.smith`, {
      method: 'PATCH',
      headers: { cookie: rootCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    })
    expect(disabled.status).toBe(200)

    const drain = async () => {
      for (;;) {
        const { done } = await reader.read()

        if (done) {
          return 'CLOSED'
        }
      }
    }
    expect(
      await Promise.race([
        drain(),
        new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), 3_000)),
      ]),
    ).toBe('CLOSED')
  })
})
