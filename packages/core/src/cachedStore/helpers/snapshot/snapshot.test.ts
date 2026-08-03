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
