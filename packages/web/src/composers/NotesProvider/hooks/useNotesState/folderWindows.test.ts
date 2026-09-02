import { describe, expect, it } from 'vitest'

import type { NoteView } from '../../../../libs/wire'
import { replaceFolderWindow } from './folderWindows'

const note = (id: string, folder: string): NoteView => ({
  id,
  title: id,
  filePath: `${folder}/${id}.md`,
  class: 'user-doc',
  modifiedAt: null,
  createdAt: null,
})

describe('replaceFolderWindow', () => {
  it('prunes a relocated id without mutating the previous windows or membership', () => {
    const from = [note('moved', 'from'), note('kept', 'from')]
    const unrelated = [note('other', 'unrelated')]
    const previous = new Map([
      ['from', from],
      ['to', []],
      ['unrelated', unrelated],
    ])
    const membership = new Map([
      ['moved', 'from'],
      ['kept', 'from'],
      ['other', 'unrelated'],
    ])
    const current = [note('moved', 'to')]

    const next = replaceFolderWindow(previous, membership, 'to', current)

    expect(next.windows.get('from')).toEqual([note('kept', 'from')])
    expect(next.windows.get('to')).toBe(current)
    expect(next.windows.get('unrelated')).toBe(unrelated)
    expect(next.membership).toEqual({
      remove: [],
      upsert: [{ folder: 'to', id: 'moved' }],
    })
    expect(previous.get('from')).toBe(from)
    expect(from.map((row) => row.id)).toEqual(['moved', 'kept'])
    expect(membership.get('moved')).toBe('from')
  })

  it('retains every sibling array when the authoritative ids are already unique', () => {
    const from = [note('from', 'from')]
    const unrelated = [note('other', 'unrelated')]
    const previous = new Map([
      ['from', from],
      ['unrelated', unrelated],
    ])
    const membership = new Map([
      ['from', 'from'],
      ['other', 'unrelated'],
    ])

    const next = replaceFolderWindow(previous, membership, 'to', [note('to', 'to')])

    expect(next.windows.get('from')).toBe(from)
    expect(next.windows.get('unrelated')).toBe(unrelated)
  })

  it('removes memberships disproved by an authoritative window', () => {
    const previousRows = [note('removed', 'from'), note('moved', 'from')]
    const previous = new Map([['from', previousRows]])
    const membership = new Map([
      ['removed', 'from'],
      ['moved', 'elsewhere'],
    ])
    const current: NoteView[] = []

    const next = replaceFolderWindow(previous, membership, 'from', current)

    expect(next.windows.get('from')).toBe(current)
    expect(next.membership).toEqual({
      remove: [{ folder: 'from', id: 'removed' }],
      upsert: [],
    })
    expect(previous.get('from')).toBe(previousRows)
    expect(membership).toEqual(
      new Map([
        ['removed', 'from'],
        ['moved', 'elsewhere'],
      ]),
    )
  })
})
