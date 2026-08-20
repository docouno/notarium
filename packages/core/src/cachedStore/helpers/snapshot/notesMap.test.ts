import { describe, expect, it } from 'vitest'

import type { NoteMeta } from '../../../knowledgeStore'
import { NotesMap } from './notesMap'

const meta = (id: string, sourceLocator?: string): NoteMeta => ({
  id,
  title: id,
  filePath: `${id}.md`,
  sourceLocator,
  modifiedAt: null,
  createdAt: null,
})

describe('NotesMap source-locator reverse lookup', () => {
  it('tracks set, reassignment, delete and clear without duplicate bindings', () => {
    const notes = new NotesMap()

    notes.set('a', meta('a', 'source:one'))
    notes.set('b', meta('b', 'source:one'))
    expect(notes.idsWithSourceLocator('source:one')).toEqual(['a', 'b'])

    notes.set('a', { ...meta('a', 'source:two'), filePath: 'moved/a.md' })
    notes.set('b', { ...meta('b', 'source:one'), title: 'B updated' })
    expect(notes.idsWithSourceLocator('source:one')).toEqual(['b'])
    expect(notes.idsWithSourceLocator('source:two')).toEqual(['a'])

    notes.delete('b')
    expect(notes.idsWithSourceLocator('source:one')).toEqual([])
    notes.clear()
    expect(notes.idsWithSourceLocator('source:two')).toEqual([])
  })

  it('answers from the reverse index without walking a large snapshot', () => {
    const notes = new NotesMap()

    for (let index = 0; index < 50_000; index++) {
      notes.set(`note-${index}`, meta(`note-${index}`))
    }
    notes.set('owner', meta('owner', 'source:target'))
    Object.defineProperty(notes, Symbol.iterator, {
      value: () => {
        throw new Error('source lookup walked the corpus')
      },
    })

    expect(notes.idsWithSourceLocator('source:target')).toEqual(['owner'])
    expect(notes.idsWithSourceLocator('source:missing')).toEqual([])
  })
})
