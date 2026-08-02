// describeAuthor (#13): resolve a journal attribution string to a display-ready,
// PRIVACY-FILTERED author, relative to the viewer. The load-bearing rule: the
// viewer sees their OWN key's name (they minted it), but ANOTHER user's key is
// attributed to the owning USER — never the key name (that would leak what tools
// a colleague runs). One mechanism behind both note history and agent memory.

import { describe, expect, it } from 'vitest'

import { matchesAuthor } from '@notarium/core'

import { minePrincipalFilter } from '../../packages/server/src/libs/authors'
import { createAuthService } from '../../packages/server/src/services/auth'
import type { PatRecord } from '../../packages/server/src/services/metaDb'
import { InMemoryAuthPersistence } from '../fake-server/authPersistence'

const T = '2026-01-01T00:00:00.000Z'

const pat = (
  over: Partial<PatRecord> & Pick<PatRecord, 'id' | 'username' | 'name'>,
): PatRecord => ({
  secretHash: 'h',
  scope: 'write',
  spaces: null,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: T,
  ...over,
})

const setup = async () => {
  const db = new InMemoryAuthPersistence()

  for (const username of ['alice', 'bob']) {
    await db.createUser({
      username,
      displayName: username,
      passwordHash: 'x',
      admin: false,
      disabledAt: null,
      createdAt: T,
      personalSpace: null,
    })
  }
  await db.insertPat(pat({ id: 'alice-key', username: 'alice', name: 'Alice Laptop' }))
  await db.insertPat(pat({ id: 'bob-key', username: 'bob', name: 'Bob Secret CLI' }))
  return createAuthService({ mode: 'password', persistence: db })
}

describe('describeAuthor (#13 — viewer-relative, privacy-filtered attribution)', () => {
  it('null principal → external (no journal writer)', async () => {
    const auth = await setup()
    expect(await auth.describeAuthor(null, 'alice')).toEqual({
      kind: 'external',
      name: null,
      mine: false,
    })
  })

  it("'ui' (mode-none / pre-#10) → the lone principal is whoever is looking", async () => {
    const auth = await setup()
    expect(await auth.describeAuthor('ui', null)).toEqual({ kind: 'user', name: null, mine: true })
  })

  it('a human: the viewer is "mine"; another user is named but not mine', async () => {
    const auth = await setup()
    expect(await auth.describeAuthor('user:alice', 'alice')).toEqual({
      kind: 'user',
      name: 'alice',
      mine: true,
    })
    expect(await auth.describeAuthor('user:bob', 'alice')).toEqual({
      kind: 'user',
      name: 'bob',
      mine: false,
    })
  })

  it("the viewer's OWN key resolves to the KEY NAME (they own it)", async () => {
    const auth = await setup()
    expect(await auth.describeAuthor('pat:alice:alice-key', 'alice')).toEqual({
      kind: 'agent',
      name: 'Alice Laptop',
      mine: true,
    })
  })

  it("ANOTHER user's key is attributed to the OWNER, NEVER the key name (privacy)", async () => {
    const auth = await setup()
    // Alice views Bob's agent edit: she must NOT see 'Bob Secret CLI'.
    expect(await auth.describeAuthor('pat:bob:bob-key', 'alice')).toEqual({
      kind: 'agent',
      name: 'bob',
      mine: false,
    })
  })

  it("a revoked/unknown OWN key still says 'your agent', just without a name", async () => {
    const auth = await setup()
    expect(await auth.describeAuthor('pat:alice:gone', 'alice')).toEqual({
      kind: 'agent',
      name: null,
      mine: true,
    })
  })
})

// The "my activity" heatmap filter (#218) is the SQL/predicate twin of describeAuthor's
// `mine`: minePrincipalFilter(viewer) must select exactly the principals describeAuthor
// would flag mine for that same viewer. Pinning them together keeps the two encodings of
// "is this the viewer's own action" from drifting apart.
describe('minePrincipalFilter (#218) — parity with describeAuthor.mine', () => {
  const PRINCIPALS = [
    null,
    'ui',
    'user:alice',
    'user:bob',
    'pat:alice:alice-key',
    'pat:alice:gone', // a since-revoked key still counts as the owner's
    'pat:bob:bob-key',
    'oauth:alice:tok-1',
    'oauth:bob:tok-2',
    'system:cron', // an opaque system actor — nobody's "mine"
  ]

  it("alice's filter matches exactly the principals describeAuthor calls mine", async () => {
    const auth = await setup()
    const filter = minePrincipalFilter('alice')

    for (const p of PRINCIPALS) {
      const mineByDescribe = (await auth.describeAuthor(p, 'alice')).mine
      expect(matchesAuthor(p, filter)).toBe(mineByDescribe)
    }
  })

  it('a null viewer (mode none) matches only the lone `ui` writer', async () => {
    const auth = await setup()
    const filter = minePrincipalFilter(null)

    for (const p of PRINCIPALS) {
      const mineByDescribe = (await auth.describeAuthor(p, null)).mine
      expect(matchesAuthor(p, filter)).toBe(mineByDescribe)
    }
    expect(matchesAuthor('ui', filter)).toBe(true)
    expect(matchesAuthor('user:alice', filter)).toBe(false)
  })
})
