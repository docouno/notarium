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
  peekPersonalSpace,
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

const makeAuth = async () => {
  const db = new InMemoryAuthPersistence()
  const auth = createAuthService({
    mode: 'password',
    persistence: db,
    removeMemberAndProviderAttachments: (space, username) => db.removeMember(space, username),
  })
  await db.createUser({
    username: 'alice',
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

    const slug = await ensurePersonalSpaceFor({ auth, spaces }, 'alice')
    expect(slug).toBe('alice')
    expect(spaces.has('alice')).toBe(true)
    expect(await auth.personalSpaceOf('alice')).toBe('alice')
    expect(await db.grantsFor('alice')).toEqual([{ space: 'alice', role: 'owner' }])

    // Second call returns the same slug and does not mint a second space.
    const again = await ensurePersonalSpaceFor({ auth, spaces }, 'alice')
    expect(again).toBe('alice')
    expect(spaces.list().filter((s) => s.slug === 'alice')).toHaveLength(1)
  })

  it('a slug already taken by a project space gets a unique suffix', async () => {
    const { auth } = await makeAuth()
    const spaces = makeManager()
    spaces.add({ slug: 'alice', displayName: 'A project named alice' })

    const slug = await ensurePersonalSpaceFor({ auth, spaces }, 'alice')
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
      username: 'Ann.O Nymous',
      displayName: 'Ann',
      passwordHash: null,
      admin: false,
      disabledAt: null,
      createdAt: '2026-06-14T00:00:00Z',
      personalSpace: null,
    })
    const spaces = makeManager()
    const slug = await ensurePersonalSpaceFor({ auth, spaces }, 'Ann.O Nymous')
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
    await expect(ensurePersonalSpaceFor({ auth, spaces: empty }, 'alice')).rejects.toThrow(
      /the host has no spaces/i,
    )
    // The read path never throws — it returns null so a GET surface shows an honest empty state.
    expect(await peekPersonalSpace({ auth, spaces: empty }, SYSTEM_PRINCIPAL)).toBeNull()
  })

  it('concurrent first-touches for the SAME user converge to one space, one grant', async () => {
    const { db, auth } = await makeAuth()
    const spaces = makeManager()
    const [a, b, c] = await Promise.all([
      ensurePersonalSpaceFor({ auth, spaces }, 'alice'),
      ensurePersonalSpaceFor({ auth, spaces }, 'alice'),
      ensurePersonalSpaceFor({ auth, spaces }, 'alice'),
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
        username,
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
      ensurePersonalSpaceFor({ auth, spaces }, 'Bob'),
      ensurePersonalSpaceFor({ auth, spaces }, 'bob'),
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

    const slug = await ensurePersonalSpaceFor({ auth, spaces }, 'alice')
    expect(slug).toBe('alice') // same slug, not a duplicate
    expect(spaces.has('alice')).toBe(true) // space re-created
    expect(await db.grantsFor('alice')).toEqual([{ space: 'alice', role: 'owner' }]) // ownership re-asserted
  })
})
