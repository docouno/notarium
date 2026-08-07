import { describe, expect, it } from 'vitest'

import {
  makeOwnerRemap,
  resolveSeedAgentActivityOwner,
  resolveSeedAgentDeltaCursorOwner,
  shouldAutoGrantSeedOwner,
} from '../../scripts/seedOwner'

// The catalog authors primary content as `sergey`; the real applier renames it to the
// init user (SEED_USER, default `admin`) so the default login IS the content author —
// the invariant the "mine" heatmap/feed rely on, and the reason the whole in-process
// applier exists. The applier's orchestration isn't otherwise unit-tested (it writes to
// a real engine/DB), so this guards the headline remap at zero cost.
describe('owner remap (sergey → SEED_USER)', () => {
  const { asUser, remapPrincipal } = makeOwnerRemap('sergey', 'admin')

  it('renames the catalog owner in a bare username, keeps others', () => {
    expect(asUser('sergey')).toBe('admin')
    expect(asUser('alex')).toBe('alex')
  })

  it('renames the owner segment in user:/pat: principals, keeps the rest', () => {
    expect(remapPrincipal('user:sergey')).toBe('user:admin')
    expect(remapPrincipal('pat:sergey:tok-9')).toBe('pat:admin:tok-9')
    expect(remapPrincipal('user:alex')).toBe('user:alex')
    expect(remapPrincipal('ui')).toBe('ui')
    expect(remapPrincipal(undefined)).toBeUndefined()
  })

  it('is identity when the owner already equals the init user', () => {
    const same = makeOwnerRemap('sergey', 'sergey')
    expect(same.remapPrincipal('user:sergey')).toBe('user:sergey')
  })

  it('does not partial-match a different user that contains the owner name', () => {
    expect(asUser('sergey2')).toBe('sergey2')
    expect(remapPrincipal('user:sergey2')).toBe('user:sergey2')
  })

  it("auto-grants ordinary spaces but never another user's personal domain", () => {
    expect(shouldAutoGrantSeedOwner({ primaryUsername: 'admin', asUser })).toBe(true)
    expect(
      shouldAutoGrantSeedOwner({
        personalFor: 'sergey',
        primaryUsername: 'admin',
        asUser,
      }),
    ).toBe(true)
    expect(shouldAutoGrantSeedOwner({ personalFor: 'bob', primaryUsername: 'admin', asUser })).toBe(
      false,
    )
  })

  it('derives a cursor owner from its bound non-primary session', () => {
    expect(
      resolveSeedAgentDeltaCursorOwner({
        sessionOwner: 'bob',
        fallbackOwner: 'admin',
        asUser,
      }),
    ).toBe('bob')
  })

  it('rejects an explicit cursor owner that differs from its session owner', () => {
    expect(() =>
      resolveSeedAgentDeltaCursorOwner({
        cursorOwner: 'sergey',
        sessionOwner: 'bob',
        fallbackOwner: 'admin',
        asUser,
      }),
    ).toThrow('cursor owner admin does not match session owner bob')
  })

  it('compares owners after applying the catalog-owner remap', () => {
    expect(
      resolveSeedAgentDeltaCursorOwner({
        cursorOwner: 'sergey',
        sessionOwner: 'admin',
        fallbackOwner: 'admin',
        asUser,
      }),
    ).toBe('admin')
  })

  it('inherits a bound session owner for reads and writes', () => {
    for (const kind of ['write', 'retrieval'] as const) {
      expect(
        resolveSeedAgentActivityOwner({
          kind,
          sessionOwner: 'sergey',
          fallbackOwner: 'admin',
          asUser,
        }),
      ).toBe('admin')
    }
  })

  it('rejects hostile activity that assigns another owner to a bound session', () => {
    for (const kind of ['write', 'retrieval'] as const) {
      expect(() =>
        resolveSeedAgentActivityOwner({
          kind,
          activityOwner: 'bob',
          sessionOwner: 'sergey',
          fallbackOwner: 'admin',
          asUser,
        }),
      ).toThrow(`agent ${kind} owner bob does not match session owner admin`)
    }
  })
})
