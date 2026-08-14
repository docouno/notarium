import { describe, expect, it } from 'vitest'

import { DirectoryIndex } from './directoryIndex'

// The version counter is what the wikilink resolve table memoizes against, so a
// set change it fails to report is a SILENT mis-resolve (a ghost still offered a
// folder that no longer exists), not a slow read. These pin that every shape of
// mutation that moves the set moves the counter with it.
describe('DirectoryIndex change counter', () => {
  it('reports a move that only shrinks the set', () => {
    const dirs = new DirectoryIndex()

    dirs.add('a')
    dirs.add('b')
    const before = dirs.version

    // `a` re-keys onto a folder the index ALREADY tracks: the set goes {a,b} → {b}
    // with nothing added. Sizing the change around the add alone sees zero.
    expect(dirs.moveSubtree('a', 'b')).toBe(true)
    expect(dirs.list()).toEqual(['b'])
    expect(dirs.version).not.toBe(before)
  })

  it('stands still on a move that changes nothing', () => {
    const dirs = new DirectoryIndex()

    dirs.add('b')
    const before = dirs.version

    expect(dirs.moveSubtree('a', 'b')).toBe(false)
    expect(dirs.version).toBe(before)
  })

  it('reports an ordinary move, a removal and an add', () => {
    const dirs = new DirectoryIndex()

    dirs.add('from/child')
    const added = dirs.version

    expect(dirs.moveSubtree('from', 'to')).toBe(true)
    expect(dirs.list().sort()).toEqual(['to', 'to/child'])
    const moved = dirs.version

    expect(moved).not.toBe(added)
    expect(dirs.removeSubtree('to')).toBe(true)
    expect(dirs.version).not.toBe(moved)
  })
})
