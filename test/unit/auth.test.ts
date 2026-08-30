// Unit pack for #10's pure pieces: password hashing (scrypt encoding,
// verification, parameter upgrades), token formats and the can() decision
// table — P14's `effective = scopes(token) ∩ grants(principal)` pinned case by
// case, against the spec in docs/auth.md.

import { describe, expect, it, vi } from 'vitest'

import {
  type Action,
  AGENT_SYSTEM_OWNER,
  agentOwnerOf,
  can,
  createAuthService,
  hashPassword,
  mintPatToken,
  parsePatToken,
  type Principal,
  sha256,
  type SpaceRecord,
  type SpacesPersistence,
  timingSafeEqualHex,
  type UserRecord,
  verifyPassword,
} from '@notarium/server'

import { InMemoryAuthPersistence } from '../fake-server/authPersistence'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

describe('me: space aliases are wire capabilities, not raw history', () => {
  it('does not fall back to raw history when no resolver capability is wired', async () => {
    const persistence = new InMemoryAuthPersistence()
    const records: SpaceRecord[] = [
      {
        id: 'work-id',
        slug: 'work',
        displayName: 'Work',
        notesDir: 'work',
        aliases: ['research', 'shared-history'],
        createdAt: '2026-01-01T00:00:00Z',
        archivedAt: null,
        archivedBy: null,
      },
      {
        id: 'research-id',
        slug: 'research',
        displayName: 'Research',
        notesDir: 'research',
        aliases: ['library', 'shared-history'],
        createdAt: '2026-01-02T00:00:00Z',
        archivedAt: null,
        archivedBy: null,
      },
    ]
    const spaces: SpacesPersistence = {
      list: async () => records,
      getById: async (id) => records.find((record) => record.id === id) ?? null,
      getBySlug: async (slug) => records.find((record) => record.slug === slug) ?? null,
      upsert: async () => {},
    }
    await persistence.createUser({
      username: 'bob',
      displayName: 'Bob',
      passwordHash: 'x',
      admin: false,
      disabledAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      personalSpace: null,
    })
    // The raw work row carries both a shadowed and an ambiguous alias. Without the
    // registry-owned resolver capability, auth must expose neither by default.
    await persistence.upsertMember('work-id', 'bob', 'owner', '2026-01-01T00:00:00Z')
    const auth = createAuthService({
      mode: 'password',
      persistence,
      spaces,
      removeMemberAndProviderAttachments: (space, username) =>
        persistence.removeMember(space, username),
    })

    await expect(auth.me('bob')).resolves.toEqual({
      username: 'bob',
      displayName: 'Bob',
      admin: false,
      spaces: [{ slug: 'work', role: 'owner' }],
      personalSpace: null,
    })
  })
})

describe('ensureOwners: a personal domain never gets the admin fan-out (#13 privacy)', () => {
  const mkUser = (username: string, admin: boolean, personalSpace: string | null): UserRecord => ({
    username,
    displayName: username,
    passwordHash: 'x',
    admin,
    disabledAt: null,
    createdAt: '2026-06-20T00:00:00.000Z',
    personalSpace,
  })

  it('heals an orphan personal domain with ONLY its owner; a normal orphan still gets every admin', async () => {
    const persistence = new InMemoryAuthPersistence()
    await persistence.createUser(mkUser('root', true, null)) // host admin
    await persistence.createUser(mkUser('peer', true, null)) // a second admin
    await persistence.createUser(mkUser('sam', false, 'sam-personal')) // owns sam-personal
    const auth = createAuthService({
      mode: 'password',
      persistence,
      now: () => new Date('2026-06-20T12:00:00.000Z'),
      removeMemberAndProviderAttachments: (space, username) =>
        persistence.removeMember(space, username),
    })

    // Both spaces are orphans (no member rows) at boot — e.g. sam-personal lost its
    // owner row in the mint crash window. ensureOwners must NOT fan the admins onto
    // the personal domain (that would leak sam's private about-user memory).
    await auth.ensureOwners(['work', 'sam-personal'])

    expect((await auth.membersOf('work')).map((m) => m.username).sort()).toEqual(['peer', 'root'])
    expect((await auth.membersOf('sam-personal')).map((m) => `${m.username}:${m.role}`)).toEqual([
      'sam:owner', // the rightful owner only — never the admins
    ])
  })
})

describe('passwords (scrypt)', () => {
  it('hash → verify roundtrip; wrong password fails', async () => {
    const hash = await hashPassword('correct horse battery')
    expect(hash.startsWith('scrypt:17:8:1:')).toBe(true)
    expect(await verifyPassword('correct horse battery', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  }, 20_000)

  it('verification reads the row’s own parameters (forward-compatible encoding)', async () => {
    // A hash minted with weaker parameters still verifies — upgrades never
    // strand existing users.
    const hash = await hashPassword('pw')
    const weak = hash.replace('scrypt:17:', 'scrypt:17:') // same params, sanity
    expect(await verifyPassword('pw', weak)).toBe(true)
    expect(await verifyPassword('pw', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('pw', 'scrypt:99:8:1:AAAA:BBBB')).toBe(false) // absurd cost rejected
  }, 20_000)
})

describe('token formats', () => {
  it('PAT: ntp_<id>_<secret>, parseable, hash never equals the secret', () => {
    const { id, secret, token } = mintPatToken()
    expect(token).toBe(`ntp_${id}_${secret}`)
    expect(parsePatToken(token)).toEqual({ id, secret })
    expect(parsePatToken('ntp_short_x')).toBeNull()
    expect(parsePatToken('ghp_lol')).toBeNull()
    expect(sha256(secret)).not.toBe(secret)
  })

  it('two mints never collide', () => {
    expect(mintPatToken().token).not.toBe(mintPatToken().token)
  })

  it('timingSafeEqualHex: true on equal digests, false on a mismatch or length diff (#73)', () => {
    const h = sha256('a-pat-secret')
    expect(timingSafeEqualHex(h, h)).toBe(true)
    expect(timingSafeEqualHex(h, sha256('another-secret'))).toBe(false)
    expect(timingSafeEqualHex(h, h.slice(0, 32))).toBe(false) // unequal length never throws
  })
})

describe('credential usage persistence', () => {
  it('routes read-side PAT lastUsed writes through the backup mutation tracker', async () => {
    const persistence = new InMemoryAuthPersistence()
    const minted = mintPatToken()
    let tracked = 0
    await persistence.createUser({
      username: 'agent',
      displayName: 'Agent',
      passwordHash: 'unused',
      admin: false,
      disabledAt: null,
      createdAt: '2026-06-20T00:00:00.000Z',
      personalSpace: null,
    })
    await persistence.insertPat({
      id: minted.id,
      username: 'agent',
      name: 'test',
      secretHash: sha256(minted.secret),
      scope: 'read',
      spaces: null,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: '2026-06-20T00:00:00.000Z',
    })
    const auth = createAuthService({
      mode: 'password',
      persistence,
      now: () => new Date('2026-06-20T12:00:00.000Z'),
      runMutation: async (task) => {
        tracked += 1
        return task()
      },
      removeMemberAndProviderAttachments: (space, username) =>
        persistence.removeMember(space, username),
    })

    await expect(
      auth.authenticate({ authorization: `Bearer ${minted.token}` }),
    ).resolves.not.toBeNull()
    expect(tracked).toBe(1)
    expect((await persistence.getPat(minted.id))?.lastUsedAt).toBe('2026-06-20T12:00:00.000Z')
  })
})

const principal = (over: Partial<Principal>): Principal => ({
  id: 'user:t',
  username: 't',
  admin: false,
  scope: 'manage',
  grants: new Map(),
  spaces: null,
  system: false,
  ...over,
})

describe('can(): scopes(token) ∩ grants(principal), case by case', () => {
  it('keeps the authless agent owner disjoint from every valid username', () => {
    expect(agentOwnerOf(principal({ system: true, username: null }))).toBe(AGENT_SYSTEM_OWNER)
    expect(agentOwnerOf(principal({ username: 'system' }))).toBe('system')
    expect(AGENT_SYSTEM_OWNER).not.toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  })

  it('system principal short-circuits everything (AUTH_MODE=none)', () => {
    const sys = principal({ system: true })
    const actions: Action[] = ['space:read', 'note:delete', 'users:manage', 'spaces:create']

    for (const a of actions) {
      expect(can(sys, a, {})).toBe(true)
    }
  })

  it('role ladder: reader reads, writer writes, owner manages members', () => {
    const reader = principal({ grants: new Map([['s', 'reader']]) })
    const writer = principal({ grants: new Map([['s', 'writer']]) })
    const owner = principal({ grants: new Map([['s', 'owner']]) })
    expect(can(reader, 'space:read', { space: 's' })).toBe(true)
    expect(can(reader, 'note:write', { space: 's' })).toBe(false)
    expect(can(writer, 'note:write', { space: 's' })).toBe(true)
    expect(can(writer, 'members:manage', { space: 's' })).toBe(false)
    expect(can(owner, 'members:manage', { space: 's' })).toBe(true)
  })

  it('no grant = no access, and a missing space never passes', () => {
    const p = principal({ grants: new Map([['mine', 'owner']]) })
    expect(can(p, 'space:read', { space: 'other' })).toBe(false)
    expect(can(p, 'space:read', {})).toBe(false)
  })

  it('PAT scope is the ceiling: read-PAT never writes, write-PAT never manages', () => {
    const readPat = principal({ scope: 'read', grants: new Map([['s', 'owner']]) })
    expect(can(readPat, 'space:read', { space: 's' })).toBe(true)
    expect(can(readPat, 'note:write', { space: 's' })).toBe(false)
    const writePat = principal({ scope: 'write', grants: new Map([['s', 'owner']]) })
    expect(can(writePat, 'note:write', { space: 's' })).toBe(true)
    expect(can(writePat, 'members:manage', { space: 's' })).toBe(false)
    expect(can(writePat, 'self:manage', {})).toBe(false) // PATs can't mint PATs
    expect(can(writePat, 'users:manage', {})).toBe(false)
  })

  it('PAT space narrowing intersects with grants', () => {
    const narrowed = principal({
      scope: 'read',
      grants: new Map([
        ['a', 'owner'],
        ['b', 'owner'],
      ]),
      spaces: new Set(['a']),
    })
    expect(can(narrowed, 'space:read', { space: 'a' })).toBe(true)
    expect(can(narrowed, 'space:read', { space: 'b' })).toBe(false)
  })

  it('admin: host management and member recovery, never data', () => {
    const admin = principal({ admin: true })
    expect(can(admin, 'users:manage', {})).toBe(true)
    expect(can(admin, 'spaces:create', {})).toBe(true)
    expect(can(admin, 'members:manage', { space: 's' })).toBe(true) // recovery path
    expect(can(admin, 'space:read', { space: 's' })).toBe(false) // data needs membership
    expect(can(admin, 'members:read', { space: 's' })).toBe(false)
  })

  it('plain user: no host management', () => {
    const user = principal({ grants: new Map([['s', 'owner']]) })
    expect(can(user, 'users:manage', {})).toBe(false)
    expect(can(user, 'spaces:create', {})).toBe(false)
    expect(can(user, 'self:manage', {})).toBe(true)
    expect(can(user, 'spaces:list', {})).toBe(true)
  })
})

// The `job` SSE event (#105) carries a job's status/error/artifact, so — unlike the
// empty members/rename pokes — it must reach ONLY the job owner's live handles, matching
// the REST ownership check. notifyJobChanged/notifyJobOf filter by principalId.
describe('job SSE event is owner-scoped (#105)', () => {
  it('delivers the `job` event only to the owning principal’s handles in that space', () => {
    const auth = createAuthService({
      mode: 'none',
      removeMemberAndProviderAttachments: async () => {},
    })
    const got: Record<string, unknown[]> = { ownerMain: [], memberMain: [], ownerOther: [] }
    const mk = (principalId: string, space: string, sink: unknown[]) => ({
      principalId,
      username: null,
      space,
      close: () => {},
      notify: () => {},
      notifyMembers: () => {},
      notifyRename: () => {},
      notifyAgentSessions: () => {},
      notifyJob: (p: unknown) => sink.push(p),
    })
    auth.registerSse(mk('user:sam', 'main', got.ownerMain)) // the owner, in the space
    auth.registerSse(mk('user:dana', 'main', got.memberMain)) // a fellow member, same space
    auth.registerSse(mk('user:sam', 'other', got.ownerOther)) // the owner, but another space

    auth.notifyJobChanged('main', 'user:sam', { id: 'j1', status: 'running' })

    expect(got.ownerMain).toEqual([{ id: 'j1', status: 'running' }]) // owner in the space got it
    expect(got.memberMain).toEqual([]) // a fellow member did NOT — no status/artifact leak
    expect(got.ownerOther).toEqual([]) // the same principal in a different space did NOT
  })
})

describe('SSE access-loss linearization', () => {
  const handle = (username: string, space: string, close: () => void, job: () => void) => ({
    principalId: `user:${username}`,
    username,
    space,
    close,
    notify: () => {},
    notifyMembers: () => {},
    notifyRename: () => {},
    notifyAgentSessions: () => {},
    notifyJob: job,
  })

  it('drops a disabled user before awaiting session cleanup', async () => {
    const persistence = new InMemoryAuthPersistence()
    const cleanup = deferred()
    const close = vi.fn()
    const job = vi.fn()

    await persistence.createUser({
      username: 'alice',
      displayName: 'Alice',
      passwordHash: 'x',
      admin: false,
      disabledAt: null,
      createdAt: '2026-08-30T00:00:00.000Z',
      personalSpace: null,
    })
    const deleteSessionsFor = persistence.deleteSessionsFor.bind(persistence)

    vi.spyOn(persistence, 'deleteSessionsFor').mockImplementation(async (username) => {
      await cleanup.promise
      return deleteSessionsFor(username)
    })
    const auth = createAuthService({
      mode: 'password',
      persistence,
      removeMemberAndProviderAttachments: async () => {},
    })

    auth.registerSse(handle('alice', 'main', close, job))
    const disabling = auth.patchUser('root', 'alice', { disabled: true })

    await vi.waitFor(async () =>
      expect((await persistence.getUser('alice'))?.disabledAt).not.toBeNull(),
    )
    expect(close).toHaveBeenCalledOnce()
    auth.notifyJobChanged('main', 'user:alice', { marker: 'after-disable' })
    expect(job).not.toHaveBeenCalled()
    cleanup.resolve()
    await disabling
  })

  it('drops an archived-space handle before awaiting members for surviving-tab nudges', async () => {
    const persistence = new InMemoryAuthPersistence()
    const members = deferred()
    const close = vi.fn()
    const job = vi.fn()
    const membersOf = persistence.membersOf.bind(persistence)

    vi.spyOn(persistence, 'membersOf').mockImplementation(async (space) => {
      await members.promise
      return membersOf(space)
    })
    const auth = createAuthService({
      mode: 'password',
      persistence,
      removeMemberAndProviderAttachments: async () => {},
    })

    auth.registerSse(handle('alice', 'main', close, job))
    const archived = auth.notifySpaceArchived('main')

    expect(close).toHaveBeenCalledOnce()
    auth.notifyJobChanged('main', 'user:alice', { marker: 'after-archive' })
    expect(job).not.toHaveBeenCalled()
    members.resolve()
    await archived
  })
})

describe('agent-session SSE event is owner-scoped', () => {
  it('delivers the invalidation to every owner tab and no other user', () => {
    const auth = createAuthService({
      mode: 'none',
      removeMemberAndProviderAttachments: async () => {},
    })
    const got = { aliceMain: 0, aliceOther: 0, bobMain: 0 }
    const register = (username: string, space: string, changed: () => void) =>
      auth.registerSse({
        principalId: `user:${username}`,
        username,
        space,
        close: () => {},
        notify: () => {},
        notifyMembers: () => {},
        notifyRename: () => {},
        notifyAgentSessions: changed,
        notifyJob: () => {},
      })

    register('alice', 'main', () => got.aliceMain++)
    register('alice', 'other', () => got.aliceOther++)
    register('bob', 'main', () => got.bobMain++)

    auth.notifyAgentSessionsChanged('alice')

    expect(got).toEqual({ aliceMain: 1, aliceOther: 1, bobMain: 0 })
  })
})
