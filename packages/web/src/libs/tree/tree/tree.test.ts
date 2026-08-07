import { describe, expect, it } from 'vitest'

import type { TreeFolder } from '../../wire'
import { canonicalFolderPath, carryOpenKeys, joinPath, singleChainOpen } from './tree'

// A tiny tree builder for the expansion tests: nested { path, children } only —
// singleChainOpen is blind to name/count, it walks the single-child spine.
type N = { path: string; children: N[] }
const n = (path: string, ...children: N[]): N => ({ path, children })

describe('joinPath', () => {
  it('joins a parent and a segment', () => {
    expect(joinPath('a/b', 'c')).toBe('a/b/c')
  })
  it('a root ("") parent leaves the segment standing alone', () => {
    expect(joinPath('', 'top')).toBe('top')
  })
})

// carryOpenKeys re-keys the expanded-folder set across a rename/move: the folder's
// PATH is its identity, so when the path changes the open state has to follow. New
// keys are added and the OLD ones kept (so nothing collapses before the server
// skeleton lands — the self-heal effect sweeps the stale keys afterwards).
// singleChainOpen (#98 item 3): VS Code-style "reveal the single chain" — drill while
// each level has exactly one folder with children, stop where the tree branches.
describe('singleChainOpen', () => {
  it('drills the whole single-folder spine down to the first branch/leaf', () => {
    // a → a/b → a/b/c (branches: x, y). Open a, a/b, a/b/c; stop at the branch.
    const tree = [n('a', n('a/b', n('a/b/c', n('a/b/c/x'), n('a/b/c/y'))))]
    expect(singleChainOpen(tree)).toEqual(['a', 'a/b', 'a/b/c'])
  })

  it('opens nothing when the top level branches (>1 folder)', () => {
    expect(singleChainOpen([n('a', n('a/x')), n('b')])).toEqual([])
  })

  it('opens nothing for a single leaf folder (one node, no children)', () => {
    expect(singleChainOpen([n('a')])).toEqual([])
  })

  it('stops at the first level that branches, even after a single-folder run', () => {
    // solo → solo/x, solo/y: open only `solo`, then stop (its level branches).
    expect(singleChainOpen([n('solo', n('solo/x'), n('solo/y'))])).toEqual(['solo'])
  })

  it('is a no-op for an empty or flat axis list (Memory rows)', () => {
    expect(singleChainOpen([])).toEqual([])
    expect(singleChainOpen([n('me'), n('proj')])).toEqual([]) // flat, >1 → nothing
  })
})

describe('carryOpenKeys', () => {
  it('re-keys the renamed folder itself', () => {
    const next = carryOpenKeys(new Set(['demo']), 'demo', 'demo-renamed')
    expect(next.has('demo-renamed')).toBe(true) // carried to the new path…
    expect(next.has('demo')).toBe(true) // …and the old kept (swept later by self-heal)
  })

  it('re-keys every expanded descendant under the moved folder', () => {
    const open = new Set(['demo', 'demo/sub', 'demo/sub/deep', 'other'])
    const next = carryOpenKeys(open, 'demo', 'archive/demo')
    expect(next.has('archive/demo')).toBe(true)
    expect(next.has('archive/demo/sub')).toBe(true)
    expect(next.has('archive/demo/sub/deep')).toBe(true)
    expect(next.has('other')).toBe(true) // untouched branch survives
  })

  it('uses a per-segment boundary — a sibling sharing a name PREFIX is not disturbed', () => {
    // `demo` must not match `demo2` (substring) — only `demo` and `demo/…`.
    const next = carryOpenKeys(new Set(['demo', 'demo2', 'demo2/x']), 'demo', 'moved')
    expect(next.has('moved')).toBe(true)
    expect(next.has('demo2')).toBe(true) // sibling prefix-share untouched
    expect(next.has('demo2/x')).toBe(true)
    expect(next.has('moved2')).toBe(false) // never re-keyed demo2 → moved2
  })

  it('returns the SAME set reference on a no-op (newPath === oldPath)', () => {
    const open = new Set(['demo'])
    expect(carryOpenKeys(open, 'demo', 'demo')).toBe(open) // identity → caller skips a render
  })

  it('returns the SAME set reference when nothing matched', () => {
    const open = new Set(['a', 'b'])
    expect(carryOpenKeys(open, 'demo', 'demo-renamed')).toBe(open)
  })

  it('does not mutate the input set', () => {
    const open = new Set(['demo', 'demo/sub'])
    carryOpenKeys(open, 'demo', 'renamed')
    expect([...open].sort()).toEqual(['demo', 'demo/sub'])
  })
})

describe('canonicalFolderPath (#100 phase 3 — old folder URL → current path redirect)', () => {
  const f = (path: string, aliases?: string[]): TreeFolder => ({
    path,
    name: path.split('/').pop()!,
    count: 0,
    direct: 0,
    ...(aliases ? { aliases } : {}),
  })

  it('redirects an old (aliased) folder path to the current one (slug-space match, cyrillic)', () => {
    const folders = [f('Орбита', ['Космос']), f('Архив')]
    expect(canonicalFolderPath('Космос', folders)).toBe('Орбита')
    expect(canonicalFolderPath('kosmos', folders)).toBe('Орбита') // already-slug form resolves too
  })

  it('rewrites a descendant of an old path to the REAL current folder (a/sub after a→b → b/sub)', () => {
    // The descendant must exist as a current folder for the redirect to land on it.
    expect(canonicalFolderPath('old/sub', [f('new', ['old']), f('new/sub')])).toBe('new/sub')
    // Gone descendant → fall back to the renamed parent (a safe, existing target).
    expect(canonicalFolderPath('old/gone', [f('new', ['old'])])).toBe('new')
  })

  it('maps a cyrillic descendant back to its RAW path (no slug-glue — dirs are stored RAW)', () => {
    // Космос→Орбита, real RAW subfolder Орбита/Спутник. /files/Космос/Спутник must
    // redirect to the RAW 'Орбита/Спутник', NOT the slug-glued 'Орбита/sputnik'
    // (which is not a real folder → reveal/listing would fail).
    expect(
      canonicalFolderPath('Космос/Спутник', [f('Орбита', ['Космос']), f('Орбита/Спутник')]),
    ).toBe('Орбита/Спутник')
  })

  // #296 — the CONSUMING half of the folder path-history. The producer (`nextPathAliases`)
  // retires `📥` into the history because `namePathKey('📥')` is non-empty, and every
  // wikilink surface resolves `[[📥/note]]` after the rename. This surface keyed on the
  // bare slug, which is '' for such a name, so it dropped exactly those aliases: the link
  // worked and the bookmark 404'd.
  it('redirects a folder whose name has no romanisable letters', () => {
    expect(canonicalFolderPath('📥', [f('Inbox', ['📥'])])).toBe('Inbox')
    expect(canonicalFolderPath('第三季度', [f('Q3', ['第三季度'])])).toBe('Q3')
  })

  it('rewrites a descendant under such a folder, and keeps the RAW target', () => {
    expect(canonicalFolderPath('📥/архив', [f('Inbox', ['📥']), f('Inbox/архив')])).toBe(
      'Inbox/архив',
    )
  })

  it('does not merge two letterless folder aliases onto one key', () => {
    // Both alias keys are '' under the bare slug, so whichever folder came first
    // answered for both — a bookmark to `📥` could land in `Archive`.
    const folders = [f('Inbox', ['📥']), f('Archive', ['🗄️'])]
    expect(canonicalFolderPath('📥', folders)).toBe('Inbox')
    expect(canonicalFolderPath('🗄️', folders)).toBe('Archive')
  })

  it('returns null for a live folder (no redirect) or an unknown path', () => {
    expect(canonicalFolderPath('Орбита', [f('Орбита', ['Космос'])])).toBeNull() // already current
    expect(canonicalFolderPath('nowhere', [f('a', ['b'])])).toBeNull()
  })

  it('redirects a key-equivalent stale spelling to the current raw path', () => {
    expect(canonicalFolderPath('Inbox', [f('inbox')])).toBe('inbox')
    expect(canonicalFolderPath('Cafe\u0301', [f('Café')])).toBe('Café')
    expect(canonicalFolderPath('inbox', [f('inbox')])).toBeNull()
  })

  it('does not redirect either of two key-equivalent folders that both exist raw', () => {
    expect(canonicalFolderPath('Inbox', [f('Inbox'), f('inbox')])).toBeNull()
    expect(canonicalFolderPath('inbox', [f('inbox'), f('Inbox')])).toBeNull()
  })

  it('does not let an alias answer an ambiguous current-name key', () => {
    const folders = [f('Inbox'), f('inbox'), f('Archive', ['INBOX'])]
    expect(canonicalFolderPath('INBOX', folders)).toBeNull()
    expect(canonicalFolderPath('INBOX', [...folders].reverse())).toBeNull()
  })

  it('does not choose between two folders that claim the same retired path', () => {
    const folders = [f('Inbox', ['Old']), f('Archive', ['old'])]

    expect(canonicalFolderPath('OLD', folders)).toBeNull()
    expect(canonicalFolderPath('OLD', [...folders].reverse())).toBeNull()
  })

  it('falls back to a case/NFC-renamed parent for a missing descendant', () => {
    expect(canonicalFolderPath('Inbox/gone', [f('inbox')])).toBe('inbox')
    expect(canonicalFolderPath('Cafe\u0301/gone', [f('Café')])).toBe('Café')
    expect(canonicalFolderPath('inbox/gone', [f('inbox')])).toBeNull()
  })

  it('does not choose between ambiguous current descendants by input order', () => {
    const folders = [f('new', ['old']), f('new/Sub'), f('new/sub')]
    expect(canonicalFolderPath('old/SUB', folders)).toBe('new')
    expect(canonicalFolderPath('old/SUB', [...folders].reverse())).toBe('new')
  })

  it('never shadows a LIVE folder by another folder’s alias', () => {
    // 'docs' is BOTH a live folder and a past alias of 'guides' — the live one wins.
    expect(canonicalFolderPath('docs', [f('docs'), f('guides', ['docs'])])).toBeNull()
  })
})
