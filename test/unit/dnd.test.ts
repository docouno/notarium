import { describe, expect, it } from 'vitest'
import {
  canDropAnyInto,
  canDropInto,
  type DragItem,
  dragKey,
  droppableInto,
  rangeSelect,
} from '../../packages/web/src/libs/dnd/dnd'

// canDropInto is the drop-legality rule for the folder tree (#6). The canonical
// spec is docs/drag-and-drop.md §canDropInto: reject no-ops and the illegal
// folder-into-self / folder-into-descendant cases. Tested here against that spec.

describe('canDropInto — notes', () => {
  const note = (srcFolder: string) => ({
    kind: 'note' as const,
    id: 'p/x',
    fileName: 'x.md',
    srcFolder,
  })

  it('accepts a move to a different folder', () => {
    expect(canDropInto(note('a'), 'b')).toBe(true)
    expect(canDropInto(note('a'), '')).toBe(true) // into root
  })
  it('rejects a no-op (already in the target folder)', () => {
    expect(canDropInto(note('a'), 'a')).toBe(false)
    expect(canDropInto(note(''), '')).toBe(false) // root note onto root
  })
})

describe('canDropInto — folders', () => {
  const folder = (id: string) => ({ kind: 'folder' as const, id })

  it('rejects dropping a folder onto itself', () => {
    expect(canDropInto(folder('a/b'), 'a/b')).toBe(false)
  })
  it('rejects when the folder already sits directly under the target', () => {
    expect(canDropInto(folder('a/b'), 'a')).toBe(false)
    expect(canDropInto(folder('top'), '')).toBe(false) // already at root
  })
  it('rejects dropping a folder into its own descendant', () => {
    expect(canDropInto(folder('a'), 'a/b')).toBe(false)
    expect(canDropInto(folder('a'), 'a/b/c')).toBe(false)
  })
  it('accepts a legal relocation to an unrelated branch', () => {
    expect(canDropInto(folder('a/b'), 'c')).toBe(true)
    expect(canDropInto(folder('a/b'), '')).toBe(true) // up to root
  })
  it('does not treat a name-prefix sibling as a descendant', () => {
    // "a/b" must be droppable into "a/bb" — startsWith on the bare id would be a
    // bug; the guard appends a slash so only true descendants are rejected.
    expect(canDropInto(folder('a/b'), 'a/bb')).toBe(true)
  })
})

it('rejects a null/missing payload', () => {
  expect(canDropInto(null, 'a')).toBe(false)
  expect(canDropInto(undefined, '')).toBe(false)
})

// A multi-select drag (#163) carries a SET. `droppableInto` keeps only the
// members that actually move into the target; `canDropAnyInto` is the highlight
// gate (true iff at least one moves). A mixed set lands its legal members and
// silently skips no-ops / illegal ones — see docs/drag-and-drop.md §6.
describe('droppableInto / canDropAnyInto — multi-select set', () => {
  const note = (id: string, srcFolder: string): DragItem => ({
    kind: 'note',
    id,
    fileName: `${id}.md`,
    srcFolder,
  })
  const folder = (id: string): DragItem => ({ kind: 'folder', id })

  it('keeps the movable members and drops the no-ops', () => {
    // a/n1 already in dest 'a' (no-op), b/n2 moves; folder 'c' moves.
    const set = [note('n1', 'a'), note('n2', 'b'), folder('c')]
    expect(droppableInto(set, 'a').map((i) => i.id)).toEqual(['n2', 'c'])
    expect(canDropAnyInto(set, 'a')).toBe(true)
  })

  it('skips an illegal folder (into its own descendant) but keeps a sibling', () => {
    const set = [folder('a'), folder('b')]
    // Dropping the set into a/sub: 'a' would go into its own subtree (illegal),
    // 'b' is a legal relocation.
    expect(droppableInto(set, 'a/sub').map((i) => i.id)).toEqual(['b'])
    expect(canDropAnyInto(set, 'a/sub')).toBe(true)
  })

  it('is a no-op (no highlight) when every member already lives in the target', () => {
    const set = [note('n1', 'a'), note('n2', 'a'), folder('a/sub')] // sub already under 'a'
    expect(droppableInto(set, 'a')).toEqual([])
    expect(canDropAnyInto(set, 'a')).toBe(false)
  })

  it('an empty set is never droppable', () => {
    expect(droppableInto([], 'a')).toEqual([])
    expect(canDropAnyInto([], 'a')).toBe(false)
  })
})

// rangeSelect resolves a shift-click into the inclusive run of rows between the
// anchor and the clicked index (#163, canon §4). It's the one piece of selection
// logic with non-trivial index math, so it's pulled out pure and tested here:
// direction-agnostic, skips non-selectable rows, and signals "anchor gone" with
// null so the caller degrades to a single-select instead of an empty selection.
describe('rangeSelect — shift-range over flattened rows', () => {
  const note = (id: string): DragItem => ({ kind: 'note', id, fileName: `${id}.md`, srcFolder: '' })
  const folder = (id: string): DragItem => ({ kind: 'folder', id })
  // A flat tree: folder a, its note n1, folder b, note n2, a skeleton (null), note n3.
  const rows: (DragItem | null)[] = [
    folder('a'),
    note('n1'),
    folder('b'),
    note('n2'),
    null,
    note('n3'),
  ]
  const keys = (m: Map<string, DragItem> | null) => (m ? [...m.keys()] : null)

  it('ranges downward from the anchor, inclusive, mixing notes and folders', () => {
    expect(keys(rangeSelect(rows, dragKey(folder('a')), 3))).toEqual([
      'folder:a',
      'note:n1',
      'folder:b',
      'note:n2',
    ])
  })

  it('ranges upward (anchor below the clicked row) with the same result', () => {
    expect(keys(rangeSelect(rows, dragKey(note('n2')), 0))).toEqual([
      'folder:a',
      'note:n1',
      'folder:b',
      'note:n2',
    ])
  })

  it('skips a non-selectable (skeleton) row inside the range', () => {
    // Anchor n2 (idx 3) → click n3 (idx 5): the null at idx 4 is dropped.
    expect(keys(rangeSelect(rows, dragKey(note('n2')), 5))).toEqual(['note:n2', 'note:n3'])
  })

  it('a single-row range (anchor === clicked) selects just that row', () => {
    expect(keys(rangeSelect(rows, dragKey(note('n1')), 1))).toEqual(['note:n1'])
  })

  it('returns null when the anchor is no longer present (collapsed/removed)', () => {
    expect(rangeSelect(rows, 'folder:gone', 3)).toBeNull()
  })

  it('returns null for an out-of-bounds clicked index', () => {
    expect(rangeSelect(rows, dragKey(folder('a')), -1)).toBeNull()
    expect(rangeSelect(rows, dragKey(folder('a')), 99)).toBeNull()
  })
})
