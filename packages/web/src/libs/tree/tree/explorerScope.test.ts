import { describe, expect, it } from 'vitest'

import {
  type ExplorerScope,
  findSkeletonNode,
  isFilesSection,
  nearestProjectPath,
  outermostProjects,
  pushRecent,
  railScopeActive,
  scopeHidesFolder,
} from './explorerScope'
import type { SkeletonNode } from './tree'

// A terse skeleton builder — outermostProjects/findSkeletonNode only read
// path + children (count/direct are irrelevant to the scope algebra).
const node = (path: string, ...children: SkeletonNode[]): SkeletonNode => ({
  name: path.split('/').pop() ?? '',
  path,
  count: 0,
  direct: 0,
  children,
})

// A project membership predicate from a set of marked folder paths. The real
// caller (Sidebar's isProjectFolder) returns false for the space root '', and the
// project-scoped helpers (nearestProjectPath/scopeHidesFolder) never query '' for
// membership anyway — so an auto-marked root can't collapse Projects into Files.
const projectsFrom =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p)

describe('findSkeletonNode', () => {
  const tree = [node('a', node('a/b', node('a/b/c'))), node('d')]
  it('finds a nested node by exact path', () => {
    expect(findSkeletonNode(tree, 'a/b/c')?.path).toBe('a/b/c')
  })
  it('returns null for an unknown path', () => {
    expect(findSkeletonNode(tree, 'a/x')).toBeNull()
  })
})

describe('outermostProjects', () => {
  it('takes a top-level project and does NOT descend into it', () => {
    const tree = [node('Roadmap', node('Roadmap/specs')), node('demo')]
    const out = outermostProjects(tree, projectsFrom('Roadmap', 'Roadmap/specs'))
    expect(out.map((n) => n.path)).toEqual(['Roadmap']) // nested Roadmap/specs stays inside
  })

  it('surfaces a project buried under plain folders as a top-level row', () => {
    // demo is NOT a project, demo/sub IS — show demo/sub at the top, hiding demo.
    const tree = [node('demo', node('demo/sub', node('demo/sub/x')))]
    const out = outermostProjects(tree, projectsFrom('demo/sub'))
    expect(out.map((n) => n.path)).toEqual(['demo/sub'])
  })

  it('returns every outermost sibling project, sorted by skeleton order', () => {
    const tree = [node('Billing'), node('demo'), node('Roadmap')]
    const out = outermostProjects(tree, projectsFrom('Billing', 'Roadmap'))
    expect(out.map((n) => n.path)).toEqual(['Billing', 'Roadmap'])
  })

  it('is empty when there are no (non-root) projects', () => {
    expect(outermostProjects([node('demo')], projectsFrom())).toEqual([])
  })
})

describe('nearestProjectPath', () => {
  const isP = projectsFrom('Roadmap', 'Roadmap/deep')
  it('matches the path itself', () => {
    expect(nearestProjectPath('Roadmap', isP)).toBe('Roadmap')
  })
  it('walks up to the nearest project ancestor', () => {
    expect(nearestProjectPath('Roadmap/a/b', isP)).toBe('Roadmap')
  })
  it('prefers the deepest (nearest) project ancestor', () => {
    expect(nearestProjectPath('Roadmap/deep/x', isP)).toBe('Roadmap/deep')
  })
  it('is null when no ancestor is a project', () => {
    expect(nearestProjectPath('demo/x', isP)).toBeNull()
  })
  it('treats the space root as non-project', () => {
    expect(nearestProjectPath('', projectsFrom(''))).toBeNull()
  })
})

describe('scopeHidesFolder', () => {
  const isP = projectsFrom('Roadmap')
  const files: ExplorerScope = { kind: 'files' }
  const projects: ExplorerScope = { kind: 'projects' }
  const focus: ExplorerScope = { kind: 'project', path: 'Roadmap' }

  it('Files hides nothing', () => {
    expect(scopeHidesFolder(files, 'demo', isP)).toBe(false)
    expect(scopeHidesFolder(files, '', isP)).toBe(false)
  })
  it('Projects hides folders outside every project', () => {
    expect(scopeHidesFolder(projects, 'demo', isP)).toBe(true)
    expect(scopeHidesFolder(projects, '', isP)).toBe(true) // a root note
    expect(scopeHidesFolder(projects, 'Roadmap', isP)).toBe(false)
    expect(scopeHidesFolder(projects, 'Roadmap/sub', isP)).toBe(false)
  })
  it('single-project focus hides everything but that project subtree', () => {
    expect(scopeHidesFolder(focus, 'Roadmap', isP)).toBe(false)
    expect(scopeHidesFolder(focus, 'Roadmap/sub', isP)).toBe(false)
    expect(scopeHidesFolder(focus, 'demo', isP)).toBe(true)
    expect(scopeHidesFolder(focus, 'Roadmapper', isP)).toBe(true) // prefix-boundary, not substring
    expect(scopeHidesFolder(focus, '', isP)).toBe(true) // a root note (and the boot '' placeholder) is hidden
  })
})

describe('isFilesSection (#245 merged Files section surface signal)', () => {
  const f = (browsing: boolean, memoryNoteOpen: boolean, navType: 'all' | 'feed' | 'folder') =>
    isFilesSection({ browsing, memoryNoteOpen, navType })
  it('is true on the feed overview and on a folder/note (nav folder)', () => {
    expect(f(true, false, 'feed')).toBe(true)
    expect(f(true, false, 'folder')).toBe(true)
  })
  it('is false on the home dashboard, a memory note, and chrome surfaces', () => {
    expect(f(true, false, 'all')).toBe(false) // home dashboard
    expect(f(true, true, 'folder')).toBe(false) // /m memory note
    expect(f(false, false, 'feed')).toBe(false) // chrome (browsing false)
  })
})

describe('railScopeActive (#245 merged Files+Feed rail highlight)', () => {
  // Terse driver: browsing (=not a chrome page) defaults true; supply the axes
  // that matter per case. `chrome` flips browsing off (graph/agents/trash/settings).
  const active = (o: {
    chrome?: boolean
    memory?: boolean
    nav: 'all' | 'feed' | 'folder'
    scope: ExplorerScope['kind']
  }) =>
    railScopeActive({
      browsing: !o.chrome,
      memoryNoteOpen: !!o.memory,
      navType: o.nav,
      scopeKind: o.scope,
    })

  it('feed overview lights Files (feed is the section default, not its own icon)', () => {
    expect(active({ nav: 'feed', scope: 'files' })).toEqual({
      filesActive: true,
      favoritesActive: false,
    })
  })
  it('a folder page / open note lights Files', () => {
    expect(active({ nav: 'folder', scope: 'files' })).toEqual({
      filesActive: true,
      favoritesActive: false,
    })
  })
  it('the home dashboard lights NEITHER (its logo owns home)', () => {
    expect(active({ nav: 'all', scope: 'files' })).toEqual({
      filesActive: false,
      favoritesActive: false,
    })
  })

  it('the favorites lens OWNS the rail and the Files icon yields (mutual exclusion)', () => {
    // On every Files-section face, favorites lit ⇒ Files dark.
    for (const nav of ['feed', 'folder'] as const) {
      expect(active({ nav, scope: 'favorites' })).toEqual({
        filesActive: false,
        favoritesActive: true,
      })
    }
  })
  it('the home dashboard lights NEITHER, even with the favorites lens (#245 consistency)', () => {
    // Symmetric with Files: no file-tree icon lights on the dashboard. Picking a lens
    // off-section navigates to the section first (Sidebar.pickScope), so the star
    // lights where you land — never on the bare dashboard.
    expect(active({ nav: 'all', scope: 'favorites' })).toEqual({
      filesActive: false,
      favoritesActive: false,
    })
  })

  it('a memory note (/m) belongs to Agents — neither Files nor the star lights', () => {
    expect(active({ memory: true, nav: 'folder', scope: 'files' })).toEqual({
      filesActive: false,
      favoritesActive: false,
    })
    // …even with a sticky favorites lens: /m is not the Files section.
    expect(active({ memory: true, nav: 'folder', scope: 'favorites' })).toEqual({
      filesActive: false,
      favoritesActive: false,
    })
  })

  it('a chrome surface (graph/agents/trash/settings) lights neither, even with a sticky favorites scope', () => {
    for (const nav of ['all', 'feed', 'folder'] as const) {
      expect(active({ chrome: true, nav, scope: 'files' })).toEqual({
        filesActive: false,
        favoritesActive: false,
      })
      expect(active({ chrome: true, nav, scope: 'favorites' })).toEqual({
        filesActive: false,
        favoritesActive: false,
      })
    }
  })

  it('a projects/single-project lens still reads as the Files icon (only favorites yields it)', () => {
    expect(active({ nav: 'folder', scope: 'projects' })).toEqual({
      filesActive: true,
      favoritesActive: false,
    })
    expect(active({ nav: 'feed', scope: 'project' })).toEqual({
      filesActive: true,
      favoritesActive: false,
    })
  })

  it('across the WHOLE matrix: never both, and nothing lights off the Files section', () => {
    for (const chrome of [false, true]) {
      for (const memory of [false, true]) {
        for (const nav of ['all', 'feed', 'folder'] as const) {
          for (const scope of ['files', 'favorites', 'projects', 'project'] as const) {
            const { filesActive, favoritesActive } = active({ chrome, memory, nav, scope })
            // Exclusion invariant: the two file-tree rail icons are never lit together.
            expect(filesActive && favoritesActive).toBe(false)
            // Surface gating (the non-tautological part): a chrome page, a memory
            // note, or the home dashboard (nav 'all') is OFF the section — NEITHER icon
            // may light there, whatever the persisted lens. This is what catches a
            // regression that lit a lens icon on the dashboard/chrome.
            if (chrome || memory || nav === 'all') {
              expect(filesActive).toBe(false)
              expect(favoritesActive).toBe(false)
            }
          }
        }
      }
    }
  })
})

describe('pushRecent', () => {
  it('prepends a new id', () => {
    expect(pushRecent(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
  })
  it('moves an existing id to the front (dedup)', () => {
    expect(pushRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
  })
  it('caps the list (default 5, drops the oldest)', () => {
    expect(pushRecent(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd'])
  })
})
