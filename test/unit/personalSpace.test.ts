// ensurePersonalSpace (#21/#13): resolve-or-mint the user's personal domain,
// idempotently. Pins: first touch mints a space + owner grant + pointer; repeat
// touches return the same slug; a slug already taken gets a unique suffix; the
// none-mode principal and hosts that can't mint spaces degrade to the host's
// first space (#99: no host-global default) without recording a pointer.

import { describe, expect, it, vi } from 'vitest'
import type { SyncStatus } from '@notarium/core'

import { createAuthService } from '../../packages/server/src/services/auth'
import { type Principal, SYSTEM_PRINCIPAL } from '../../packages/server/src/services/authz'
import {
  ensurePersonalSpace,
  ensurePersonalSpaceFor,
  followPersonalSpaceRename,
  peekPersonalSpace,
  personalSlugBase,
  personalSlugFollows,
  SpaceManager,
  type SpaceStore,
} from '../../packages/server/src/services/spaces'
import { InMemoryAuthPersistence } from '../fake-server/authPersistence'

const READY: SyncStatus = {
  scan: { phase: 'ready', startedAt: null, readyAt: null, error: null },
  delta: { cursor: null, lastPollAt: null, lastChangeAt: null, intervalMs: 0 },
  engine: { indexing: 'unknown' },
  counts: null,
}

const stubStore = (): SpaceStore =>
  ({
    list: async () => [],
    syncStatus: async () => READY,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    settle: vi.fn(async () => {}),
    capabilities: {
      fts: true,
      vector: false,
      hybrid: false,
      graphExpand: false,
      identity: true,
      cas: true,
      revisions: false,
      trash: false,
      visibility: false,
      watch: false,
    },
  }) as unknown as SpaceStore

/** A host whose engine owns namespaces (spaceCreate on) — like the #69 engine
 *  or the e2e fake. `canMint=false` models an operator-static host. */
const makeManager = (canMint = true) =>
  new SpaceManager({
    spaces: [{ slug: 'main', displayName: 'Main' }],
    createStore: () => stubStore(),
    createSpace: canMint ? async () => {} : undefined,
    spaceCreateEnabled: () => canMint,
  })

/** Test accounts key by their handle: the id IS the handle here. */
const ALICE = { id: 'alice', username: 'alice' }

const makeAuth = async () => {
  const db = new InMemoryAuthPersistence()
  const auth = createAuthService({
    mode: 'password',
    persistence: db,
    removeMemberAndProviderAttachments: (space, username) => db.removeMember(space, username),
  })
  await db.createUser({
    id: 'alice',
    username: 'alice',
    email: null,
    displayName: 'Alice',
    passwordHash: null,
    admin: false,
    disabledAt: null,
    createdAt: '2026-06-14T00:00:00Z',
    personalSpace: null,
  })
  return { db, auth }
}

const patPrincipal = (username: string | null): Principal => ({
  id: username ? `pat:${username}:t1` : 'anon',
  userId: username,
  username,
  admin: false,
  scope: 'write',
  grants: new Map(),
  spaces: null,
  system: false,
})

describe('ensurePersonalSpace (#21/#13)', () => {
  it('first touch mints a personal space + owner grant + pointer; repeat is idempotent', async () => {
    const { db, auth } = await makeAuth()
    const spaces = makeManager()

    const slug = await ensurePersonalSpaceFor({ auth, spaces }, ALICE)
    expect(slug).toBe('alice')
    expect(spaces.has('alice')).toBe(true)
    expect(await auth.personalSpaceOf('alice')).toBe('alice')
    expect(await db.grantsFor('alice')).toEqual([{ space: 'alice', role: 'owner' }])

    // Second call returns the same slug and does not mint a second space.
    const again = await ensurePersonalSpaceFor({ auth, spaces }, ALICE)
    expect(again).toBe('alice')
    expect(spaces.list().filter((s) => s.slug === 'alice')).toHaveLength(1)
  })

  it('a slug already taken by a project space gets a unique suffix', async () => {
    const { auth } = await makeAuth()
    const spaces = makeManager()
    spaces.add({ slug: 'alice', displayName: 'A project named alice' })

    const slug = await ensurePersonalSpaceFor({ auth, spaces }, ALICE)
    expect(slug).toBe('alice-2')
    expect(await auth.personalSpaceOf('alice')).toBe('alice-2')
  })

  it('normalises an untidy username into a valid slug base', async () => {
    const db = new InMemoryAuthPersistence()
    const auth = createAuthService({
      mode: 'password',
      persistence: db,
      removeMemberAndProviderAttachments: (space, username) => db.removeMember(space, username),
    })
    await db.createUser({
      id: 'ann',
      username: 'Ann.O Nymous',
      email: null,
      displayName: 'Ann',
      passwordHash: null,
      admin: false,
      disabledAt: null,
      createdAt: '2026-06-14T00:00:00Z',
      personalSpace: null,
    })
    const spaces = makeManager()
    const slug = await ensurePersonalSpaceFor(
      { auth, spaces },
      { id: 'ann', username: 'Ann.O Nymous' },
    )
    expect(slug).toBe('ann-o-nymous')
    expect(spaces.has(slug)).toBe(true)
  })

  it("the none-mode / system principal degrades to the host's first space, minting nothing", async () => {
    const { auth } = await makeAuth()
    const spaces = makeManager()
    const slug = await ensurePersonalSpace({ auth, spaces }, SYSTEM_PRINCIPAL)
    expect(slug).toBe('main')
    expect(spaces.list()).toHaveLength(1) // only the one configured space exists
  })

  it("a host that cannot mint spaces degrades to the host's first space without recording a pointer", async () => {
    const { auth } = await makeAuth()
    const spaces = makeManager(false)
    const slug = await ensurePersonalSpace({ auth, spaces }, patPrincipal('alice'))
    expect(slug).toBe('main')
    expect(await auth.personalSpaceOf('alice')).toBeNull() // honest: no real personal domain
  })

  it('a host with ZERO spaces and no mint capability has no fallback — throws / peeks null (#99)', async () => {
    const { auth } = await makeAuth()
    // A fresh password host before its first user: 0 spaces, no createSpace.
    const empty = new SpaceManager({ spaces: [], createStore: () => stubStore() })
    // No space to land on and nothing to mint → honest, loud failure (not a
    // silent wrong slug). On a real password host this path is unreachable
    // (setup mints the first space before any resolution); the throw guards the
    // misconfiguration where it isn't.
    await expect(ensurePersonalSpace({ auth, spaces: empty }, SYSTEM_PRINCIPAL)).rejects.toThrow(
      /no space available/i,
    )
    await expect(ensurePersonalSpaceFor({ auth, spaces: empty }, ALICE)).rejects.toThrow(
      /the host has no spaces/i,
    )
    // The read path never throws — it returns null so a GET surface shows an honest empty state.
    expect(await peekPersonalSpace({ auth, spaces: empty }, SYSTEM_PRINCIPAL)).toBeNull()
  })

  it('concurrent first-touches for the SAME user converge to one space, one grant', async () => {
    const { db, auth } = await makeAuth()
    const spaces = makeManager()
    const [a, b, c] = await Promise.all([
      ensurePersonalSpaceFor({ auth, spaces }, ALICE),
      ensurePersonalSpaceFor({ auth, spaces }, ALICE),
      ensurePersonalSpaceFor({ auth, spaces }, ALICE),
    ])
    expect(a).toBe('alice')
    expect(b).toBe('alice')
    expect(c).toBe('alice')
    expect(spaces.list().filter((s) => s.slug.startsWith('alice'))).toHaveLength(1)
    expect(await db.grantsFor('alice')).toEqual([{ space: 'alice', role: 'owner' }])
  })

  it('concurrent first-touches for DIFFERENT users that normalise to the same base never share a space', async () => {
    // 'Bob' and 'bob' both slugify to base 'bob' — the mint must hand them
    // distinct, separately-owned spaces (no cross-user personal-space sharing).
    const db = new InMemoryAuthPersistence()
    const auth = createAuthService({
      mode: 'password',
      persistence: db,
      removeMemberAndProviderAttachments: (space, username) => db.removeMember(space, username),
    })

    for (const username of ['Bob', 'bob']) {
      await db.createUser({
        id: username,
        username,
        email: null,
        displayName: username,
        passwordHash: null,
        admin: false,
        disabledAt: null,
        createdAt: '2026-06-14T00:00:00Z',
        personalSpace: null,
      })
    }
    const spaces = makeManager()
    const [s1, s2] = await Promise.all([
      ensurePersonalSpaceFor({ auth, spaces }, { id: 'Bob', username: 'Bob' }),
      ensurePersonalSpaceFor({ auth, spaces }, { id: 'bob', username: 'bob' }),
    ])
    expect(s1).not.toBe(s2) // distinct personal domains
    expect(new Set([s1, s2])).toEqual(new Set(['bob', 'bob-2']))
    // Each user owns ONLY their own personal space.
    expect(await db.grantsFor('Bob')).toEqual([
      { space: await auth.personalSpaceOf('Bob'), role: 'owner' },
    ])
    expect(await db.grantsFor('bob')).toEqual([
      { space: await auth.personalSpaceOf('bob'), role: 'owner' },
    ])
    expect(await auth.personalSpaceOf('Bob')).not.toBe(await auth.personalSpaceOf('bob'))
  })

  it('self-heals a partial mint: a pointer whose space is missing is re-created and re-owned', async () => {
    const { db, auth } = await makeAuth()
    const spaces = makeManager()
    // Simulate "pointer recorded, but create/grant never landed".
    await auth.setPersonalSpace('alice', 'alice')
    expect(spaces.has('alice')).toBe(false)

    const slug = await ensurePersonalSpaceFor({ auth, spaces }, ALICE)
    expect(slug).toBe('alice') // same slug, not a duplicate
    expect(spaces.has('alice')).toBe(true) // space re-created
    expect(await db.grantsFor('alice')).toEqual([{ space: 'alice', role: 'owner' }]) // ownership re-asserted
  })
})

// The slug of a personal space follows its owner's handle only while it is still the
// derived one — a chosen slug is never overwritten, a taken target is left alone.
// canon: docs/spaces.md#model
describe('a personal space follows its owner’s handle by rule', () => {
  it('derives the base the way the mint does: separators collapse, case is ascii-slugged', () => {
    expect(personalSlugBase('sergey.padurets')).toBe('sergey-padurets')
    expect(personalSlugBase('bob..smith')).toBe('bob-smith')
    expect(personalSlugBase('bob_smith')).toBe('bob_smith')
  })

  it('recognises the minted slug — the base or the base with the `-<n>` suffix — and nothing else', () => {
    expect(personalSlugFollows('bob', 'bob')).toBe(true)
    expect(personalSlugFollows('bob-2', 'bob')).toBe(true)
    expect(personalSlugFollows('bob-smith', 'bob.smith')).toBe(true)
    expect(personalSlugFollows('my-notes', 'bob')).toBe(false)
    expect(personalSlugFollows('bob-notes', 'bob')).toBe(false)
    expect(personalSlugFollows('bobby', 'bob')).toBe(false)
  })

  // At the length boundary the mint SHORTENS the base to fit its `-N`, so the rule has
  // to recognise the truncated form too — otherwise the mint's own output reads as a
  // slug the owner chose, and the space stays behind on the old handle forever.
  it('recognises the truncated base the mint produces at the length boundary', () => {
    const long = 'a'.repeat(32)
    expect(personalSlugBase(long)).toBe(long)
    expect(personalSlugFollows(`${'a'.repeat(30)}-2`, long)).toBe(true)
    expect(personalSlugFollows(`${'a'.repeat(29)}-10`, long)).toBe(true)
    // Still not a licence to overwrite anything that ends in a number.
    expect(personalSlugFollows(`${'a'.repeat(20)}-2`, long)).toBe(false)
    expect(personalSlugFollows('team-notes-2', long)).toBe(false)
  })

  const user = (username: string, personalSpace: string | null) => ({
    id: 'u1',
    username,
    email: null,
    displayName: username,
    passwordHash: null,
    admin: false,
    disabledAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    personalSpace,
  })

  const world = (slugs: Record<string, string>) => {
    const renames: Array<{ id: string; slug: string }> = []
    const byId = new Map(Object.entries(slugs).map(([slug, id]) => [id, slug]))

    return {
      renames,
      deps: {
        spaces: {
          slugOf: (id: string) => byId.get(id),
          resolveId: (slug: string) => slugs[slug] ?? null,
        },
        rename: async (input: { id: string; slug: string }) => {
          renames.push(input)
          return { code: 'ok' }
        },
      },
    }
  }

  it('renames the derived slug onto the new handle, and only that', async () => {
    const w = world({ bob: 'ps' })
    await expect(
      followPersonalSpaceRename(w.deps, { user: user('bob.smith', 'ps'), previousUsername: 'bob' }),
    ).resolves.toBe('renamed')
    expect(w.renames).toEqual([{ id: 'ps', slug: 'bob-smith' }])
  })

  it('leaves a chosen slug, a taken target and an account without a personal space alone', async () => {
    const chosen = world({ 'my-notes': 'ps' })
    await expect(
      followPersonalSpaceRename(chosen.deps, {
        user: user('bob.smith', 'ps'),
        previousUsername: 'bob',
      }),
    ).resolves.toBe('kept')
    expect(chosen.renames).toEqual([])

    const taken = world({ bob: 'ps', 'bob-smith': 'other' })
    await expect(
      followPersonalSpaceRename(taken.deps, {
        user: user('bob.smith', 'ps'),
        previousUsername: 'bob',
      }),
    ).resolves.toBe('kept')
    expect(taken.renames).toEqual([])

    const none = world({})
    await expect(
      followPersonalSpaceRename(none.deps, {
        user: user('bob.smith', null),
        previousUsername: 'bob',
      }),
    ).resolves.toBe('none')
  })

  it('a rename that only changes separators keeps the slug: the base is unchanged', async () => {
    const w = world({ 'bob-smith': 'ps' })
    await expect(
      followPersonalSpaceRename(w.deps, {
        user: user('bob..smith', 'ps'),
        previousUsername: 'bob.smith',
      }),
    ).resolves.toBe('kept')
    expect(w.renames).toEqual([])
  })
})
