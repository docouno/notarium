import { describe, expect, it } from 'vitest'

import { makeOwnerRemap } from '../../scripts/seedOwner'

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
})
