import { describe, expect, it } from 'vitest'

// Deep import on purpose: @notarium/server's root pulls the whole Fastify host;
// the test needs only the pure nearest-ancestor function (#13). The e2e fixtures
// only seed ROOT projects (path ''), so the path-boundary / nested / longest-wins
// branches have no coverage there — this is their regression home.
import { projectHandleForNote } from '../../packages/server/src/services/mcp/helpers/projectAddressing'
import type { ProjectRecord } from '../../packages/server/src/services/metaDb/types'

const proj = (space: string, path: string, slug: string): ProjectRecord => ({
  id: `id-${space}-${slug}`,
  space,
  path,
  slug,
  aliases: [],
  pathAliases: [],
  displayName: slug,
  status: 'active',
  lastSeen: '2026-06-18T00:00:00Z',
  createdAt: '2026-06-18T00:00:00Z',
})

describe('projectHandleForNote (#13 nearest-ancestor)', () => {
  it('a root project (path "") owns every note — its handle COLLAPSES to the space (#13)', () => {
    const ps = [proj('team', '', 'team')]
    // A root project owns the whole space, so its handle is just `<space>` (not the
    // redundant `team/team`) — handleOf collapses path '' to the space slug.
    expect(projectHandleForNote('team', 'x.md', ps)).toBe('team')
    expect(projectHandleForNote('team', 'a/b/c.md', ps)).toBe('team')
  })

  it('a non-root project owns only its subtree — path-boundary, NOT prefix', () => {
    const ps = [proj('team', 'billing', 'billing')]
    // A note directly under the project folder.
    expect(projectHandleForNote('team', 'billing/inv.md', ps)).toBe('team/billing')
    // A note deeper in the subtree.
    expect(projectHandleForNote('team', 'billing/2026/q1.md', ps)).toBe('team/billing')
    // CRITICAL boundary: 'billing-archive' is NOT under 'billing' (no path boundary).
    expect(projectHandleForNote('team', 'billing-archive/old.md', ps)).toBeUndefined()
    // A note at the space root is not in the 'billing' subtree.
    expect(projectHandleForNote('team', 'readme.md', ps)).toBeUndefined()
    // A file literally named 'billing.md' at root is not the 'billing' folder.
    expect(projectHandleForNote('team', 'billing.md', ps)).toBeUndefined()
  })

  it('nested projects: the LONGEST owning path wins', () => {
    const ps = [proj('team', 'billing', 'billing'), proj('team', 'billing/sub', 'sub')]
    expect(projectHandleForNote('team', 'billing/sub/x.md', ps)).toBe('team/sub') // nested beats parent
    expect(projectHandleForNote('team', 'billing/x.md', ps)).toBe('team/billing') // parent only
    expect(projectHandleForNote('team', 'billing/subother/x.md', ps)).toBe('team/billing') // 'subother' ≠ 'sub' boundary
  })

  it('a root project plus a nested one: the nested folder beats the root, siblings fall to root', () => {
    const ps = [proj('team', '', 'team'), proj('team', 'billing', 'billing')]
    expect(projectHandleForNote('team', 'billing/x.md', ps)).toBe('team/billing') // longer beats root
    expect(projectHandleForNote('team', 'roadmap/x.md', ps)).toBe('team') // root catches the rest (collapsed)
    expect(projectHandleForNote('team', 'x.md', ps)).toBe('team')
  })

  it('agent-mount notes (.notarium/…) are NEVER project notes, even under a root project (#78)', () => {
    const ps = [proj('team', '', 'team')]
    expect(projectHandleForNote('team', '.notarium/memory/abc123/general.md', ps)).toBeUndefined()
  })

  it('no marked project containing the note → undefined', () => {
    expect(projectHandleForNote('team', 'x.md', [])).toBeUndefined()
    expect(projectHandleForNote('team', 'a/x.md', [proj('team', 'b', 'b')])).toBeUndefined()
  })
})
