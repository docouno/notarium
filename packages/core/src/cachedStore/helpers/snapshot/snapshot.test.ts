import { describe, expect, it, vi } from 'vitest'

import { Snapshot } from './snapshot'

describe('Snapshot hidden-class edge derivation', () => {
  it('drops stale hidden-source edges without building the user-corpus link index', () => {
    const snapshot = new Snapshot('links_to')
    snapshot.notes.set('doc', {
      id: 'doc',
      title: 'Document',
      class: 'user-doc',
      filePath: 'document.md',
      modifiedAt: null,
      createdAt: null,
    })
    snapshot.notes.set('memory', {
      id: 'memory',
      title: 'Memory',
      class: 'agent-memory',
      filePath: '.notarium/memory/memory.md',
      modifiedAt: null,
      createdAt: null,
    })
    snapshot.edgesBySource.set('memory', [{ source: 'memory', target: 'doc', type: 'links_to' }])
    const graphVisibleNotes = vi.spyOn(snapshot, 'graphVisibleNotes')

    expect(snapshot.patchNoteEdges('memory', '[[Document]]')).toBe(true)
    expect(snapshot.edgesBySource.has('memory')).toBe(false)
    expect(snapshot.patchNoteEdges('memory', '[[Document]]')).toBe(false)
    expect(graphVisibleNotes).not.toHaveBeenCalled()
  })
})

// The alias set a snapshot meta carries is filtered by the SAME name key the resolver
// and the alias history use. On the bare slug a letterless past name and a letterless
// current title both key on '', so the filter dropped the retired name entirely — the
// note's `aliases` came back empty and every inbound `[[🎉🎉]]` re-ghosted after the
// next boot or trash restore (#296).
describe('Snapshot.aliasesFor keeps a letterless retired name', () => {
  it('retires a past name whose slug is empty instead of dropping it', () => {
    const snapshot = new Snapshot('links_to')
    snapshot.pastNames.set('n', ['🎉🎉'])

    expect(snapshot.aliasesFor('n', undefined, '✨✨')).toEqual(['🎉🎉'])
  })

  it('still drops a past name that IS the current title', () => {
    const snapshot = new Snapshot('links_to')
    snapshot.pastNames.set('n', ['🎉🎉'])

    // A→B→A leaves no stale self-alias, letterless or not.
    expect(snapshot.aliasesFor('n', undefined, '🎉🎉')).toBeUndefined()
  })

  it('treats one glyph in its two spellings as one name', () => {
    const snapshot = new Snapshot('links_to')
    snapshot.pastNames.set('n', ['❤️'])

    // `❤️` (with VS16) and `❤` are the same name — the retired form must not survive
    // as an alias of the title it already equals.
    expect(snapshot.aliasesFor('n', undefined, '❤')).toBeUndefined()
  })
})
