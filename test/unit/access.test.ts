import { describe, expect, it } from 'vitest'
import type { AuthSession, Me } from '@notarium/contract'
import {
  canManageSpace,
  canWriteSpace,
  classifyAccess,
  fallbackSpace,
  withGrant,
} from '../../packages/web/src/libs/access/access'

// #111 — the runtime-access-loss classifier. The SSE drop and a 403/404 on the
// active space are only triggers; the verdict comes from the session's live
// grants. These pin the truth table the React detector relies on.
//
// #123 extends it with alias-awareness: when the ACTIVE space is renamed, the fresh
// session reports the NEW slug while the client's `active` lags a render on the OLD
// one. Without tolerating the past slug (the grant's `aliases`) that reads as a lost
// grant — a false `space-lost` takeover and a read-only chrome flash.

const me = (over: Partial<Me> = {}): Me => ({
  username: 'bob',
  displayName: 'Bob',
  admin: false,
  spaces: [{ slug: 'work', role: 'writer' }],
  personalSpace: 'bob-personal',
  ...over,
})

const session = (over: Partial<AuthSession> = {}): AuthSession => ({
  mode: 'password',
  setup: false,
  me: me(),
  ...over,
})

describe('classifyAccess', () => {
  it('a granted space is ok', () => {
    expect(classifyAccess(session(), 'work')).toEqual({ kind: 'ok' })
  })

  it('the personal domain counts as a grant', () => {
    expect(classifyAccess(session(), 'bob-personal')).toEqual({ kind: 'ok' })
  })

  it('an active space no longer in the grants is space-lost (revoke/archive/delete)', () => {
    expect(classifyAccess(session(), 'main')).toEqual({ kind: 'space-lost' })
  })

  it('a null principal is session-lost (expired cookie / disabled account)', () => {
    expect(classifyAccess(session({ me: null }), 'work')).toEqual({ kind: 'session-lost' })
  })

  it("mode 'none' is the all-access principal — never loses a space", () => {
    // The desktop/dev opt-out: me is null but there are no memberships to lose,
    // so an SSE drop must NOT read as a revocation.
    expect(classifyAccess({ mode: 'none', setup: false, me: null }, 'anything')).toEqual({
      kind: 'ok',
    })
  })

  it('a host without a personal domain (personalSpace null) + no grant → space-lost (no null crash)', () => {
    expect(
      classifyAccess(session({ me: me({ personalSpace: null, spaces: [] }) }), 'main'),
    ).toEqual({
      kind: 'space-lost',
    })
  })

  it('empty grants but the active space IS the personal domain → ok (the #99 invariant the takeover leans on)', () => {
    expect(
      classifyAccess(
        session({ me: me({ spaces: [], personalSpace: 'bob-personal' }) }),
        'bob-personal',
      ),
    ).toEqual({
      kind: 'ok',
    })
  })

  it('a just-renamed active slug is ok via the grant aliases — no false takeover (#123)', () => {
    // The session already reports `work-new`; the client still sits on `work-old`.
    const renamed = session({
      me: me({ spaces: [{ slug: 'work-new', role: 'writer', aliases: ['work-old'] }] }),
    })
    expect(classifyAccess(renamed, 'work-old')).toEqual({ kind: 'ok' })
    expect(classifyAccess(renamed, 'work-new')).toEqual({ kind: 'ok' })
  })

  it('a multi-rename chain keeps EVERY past slug ok, not just the most recent (#123)', () => {
    // Renamed v1 → v2 → v3: a tab still on the oldest handle must not false-takeover.
    const chained = session({
      me: me({ spaces: [{ slug: 'v3', role: 'reader', aliases: ['v1', 'v2'] }] }),
    })
    expect(classifyAccess(chained, 'v1')).toEqual({ kind: 'ok' })
    expect(classifyAccess(chained, 'v2')).toEqual({ kind: 'ok' })
    expect(classifyAccess(chained, 'v3')).toEqual({ kind: 'ok' })
    expect(classifyAccess(chained, 'v0')).toEqual({ kind: 'space-lost' }) // a never-held handle
  })
})

describe('canWriteSpace', () => {
  it('a writer can write', () => {
    expect(
      canWriteSpace(me({ spaces: [{ slug: 'work', role: 'writer' }] }), 'password', 'work'),
    ).toBe(true)
  })

  it('an owner can write', () => {
    expect(
      canWriteSpace(me({ spaces: [{ slug: 'work', role: 'owner' }] }), 'password', 'work'),
    ).toBe(true)
  })

  it('a reader cannot write (the bug this gates)', () => {
    expect(
      canWriteSpace(me({ spaces: [{ slug: 'work', role: 'reader' }] }), 'password', 'work'),
    ).toBe(false)
  })

  it('the personal domain is always writable (owned), even if not in the grants list', () => {
    expect(
      canWriteSpace(me({ personalSpace: 'bob-personal', spaces: [] }), 'password', 'bob-personal'),
    ).toBe(true)
  })

  it('host-admin does NOT get write without a grant — mirrors the server (admin override is management-only)', () => {
    const admin = me({
      admin: true,
      personalSpace: 'admin-personal',
      spaces: [{ slug: 'admin-personal', role: 'owner' }],
    })
    expect(canWriteSpace(admin, 'password', 'shared')).toBe(false)
  })

  it("mode 'none' (desktop/dev) is the all-access principal — always writable", () => {
    expect(canWriteSpace(null, 'none', 'anything')).toBe(true)
  })

  it('an anonymous principal cannot write', () => {
    expect(canWriteSpace(null, 'password', 'work')).toBe(false)
  })

  it('alias-tolerant: a just-renamed active slug keeps write via the grant aliases (#123)', () => {
    const renamed = me({ spaces: [{ slug: 'work-new', role: 'writer', aliases: ['work-old'] }] })
    expect(canWriteSpace(renamed, 'password', 'work-old')).toBe(true)
  })
})

describe('canManageSpace (#123 — owner-need, mirrors can(space:manage))', () => {
  it('an owner can manage, a writer/reader cannot', () => {
    expect(
      canManageSpace(me({ spaces: [{ slug: 'work', role: 'owner' }] }), 'password', 'work'),
    ).toBe(true)
    expect(
      canManageSpace(me({ spaces: [{ slug: 'work', role: 'writer' }] }), 'password', 'work'),
    ).toBe(false)
    expect(
      canManageSpace(me({ spaces: [{ slug: 'work', role: 'reader' }] }), 'password', 'work'),
    ).toBe(false)
  })

  it('a host-admin can manage — the owner-need recovery override (#121), unlike data writes', () => {
    expect(
      canManageSpace(
        me({ admin: true, spaces: [{ slug: 'work', role: 'reader' }] }),
        'password',
        'work',
      ),
    ).toBe(true)
  })

  it('alias-tolerant: a just-renamed active slug keeps management available (#123)', () => {
    const renamed = me({ spaces: [{ slug: 'work-new', role: 'owner', aliases: ['work-old'] }] })
    expect(canManageSpace(renamed, 'password', 'work-old')).toBe(true)
  })

  it('the personal domain is manageable; mode none is all-access; anonymous is not', () => {
    expect(
      canManageSpace(me({ personalSpace: 'bob-personal', spaces: [] }), 'password', 'bob-personal'),
    ).toBe(true)
    expect(canManageSpace(null, 'none', 'anything')).toBe(true)
    expect(canManageSpace(null, 'password', 'work')).toBe(false)
  })
})

describe('fallbackSpace', () => {
  it('prefers the personal domain (the landing home, #99)', () => {
    expect(fallbackSpace(me(), 'main')).toBe('bob-personal')
  })

  it('falls back to the first other readable space when personal is the lost one', () => {
    expect(fallbackSpace(me({ personalSpace: 'main' }), 'main')).toBe('work')
  })

  it('never offers the lost space back', () => {
    const target = fallbackSpace(
      me({ personalSpace: null, spaces: [{ slug: 'main', role: 'reader' }] }),
      'main',
    )
    expect(target).toBeNull()
  })

  it('skips the lost space when a stale session still lists it, picking the next readable', () => {
    const target = fallbackSpace(
      me({
        personalSpace: null,
        spaces: [
          { slug: 'main', role: 'reader' },
          { slug: 'work', role: 'writer' },
        ],
      }),
      'main',
    )
    expect(target).toBe('work')
  })

  it('returns null when nothing is left to switch to', () => {
    expect(fallbackSpace(me({ personalSpace: null, spaces: [] }), 'main')).toBeNull()
  })
})

// #154 — the creator of a fresh space owns it by construction, so the client reflects the
// owner grant locally (no session round-trip) to light up the write affordance the instant
// it lands in the space. This is the pure core of AuthProvider.addLocalGrant; combined with
// canWriteSpace above, the full client chain (grant added → canWrite true) is pinned here.
describe('withGrant — optimistic local grant on space creation (#154)', () => {
  const spaces: Me['spaces'] = [{ slug: 'work', role: 'writer', aliases: ['work-old'] }]

  it('appends the new grant when the slug is absent', () => {
    expect(withGrant(spaces, 'research', 'owner')).toEqual([
      { slug: 'work', role: 'writer', aliases: ['work-old'] },
      { slug: 'research', role: 'owner' },
    ])
    // …and canWriteSpace then sees it — the very affordance #154 was missing.
    expect(
      canWriteSpace(me({ spaces: withGrant(spaces, 'research', 'owner') }), 'password', 'research'),
    ).toBe(true)
  })

  it('is a no-op (same array reference) when the slug is already held — never re-roles', () => {
    const held: Me['spaces'] = [{ slug: 'research', role: 'reader' }]
    const out = withGrant(held, 'research', 'owner')
    expect(out).toBe(held) // idempotent: a held reader is NOT silently promoted to owner
  })

  it('preserves existing grants (and their aliases) and does not mutate the input', () => {
    const out = withGrant(spaces, 'research', 'owner')
    expect(out).not.toBe(spaces)
    expect(spaces).toHaveLength(1) // input untouched
    expect(out[0]).toEqual({ slug: 'work', role: 'writer', aliases: ['work-old'] })
  })
})
