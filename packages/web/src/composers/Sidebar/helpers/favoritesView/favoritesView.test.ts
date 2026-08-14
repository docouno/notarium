import { describe, expect, it } from 'vitest'
import type { FavoriteItem, NoteSort, SortDir } from '@notarium/contract'
import type { NoteView } from '../../../../libs/wire'
import { favoriteNoteFolders } from './favoritesView'

const favorite = (
  id: string,
  title: string,
  filePath: string,
  createdAt: string | null,
  modifiedAt: string | null,
): FavoriteItem => ({
  kind: 'note',
  id,
  favoritedAt: '2026-01-01T00:00:00.000Z',
  note: { id, title, filePath, createdAt, modifiedAt },
})

const items = [
  favorite('alpha', 'Alpha', 'old/alpha.md', '2026-01-01T00:00:00.000Z', null),
  favorite(
    'bravo',
    'Bravo',
    'old/bravo.md',
    '2026-01-03T00:00:00.000Z',
    '2026-02-01T00:00:00.000Z',
  ),
  favorite(
    'charlie',
    'Charlie',
    'old/charlie.md',
    '2026-01-02T00:00:00.000Z',
    '2026-02-03T00:00:00.000Z',
  ),
]

describe('favoriteNoteFolders', () => {
  it.each<[NoteSort, SortDir, string[]]>([
    ['title', 'asc', ['alpha', 'bravo', 'charlie']],
    ['title', 'desc', ['charlie', 'bravo', 'alpha']],
    ['created', 'asc', ['alpha', 'charlie', 'bravo']],
    ['created', 'desc', ['bravo', 'charlie', 'alpha']],
    ['modified', 'asc', ['bravo', 'charlie', 'alpha']],
    ['modified', 'desc', ['charlie', 'bravo', 'alpha']],
  ])('uses the shared %s/%s order', (sort, dir, expected) => {
    const folders = favoriteNoteFolders(items, [], sort, dir)

    expect(folders.get('old')?.map((note) => note.id)).toEqual(expected)
  })

  it('prefers the reactive Notes-cache view over a stale favorite snapshot', () => {
    const moved: NoteView = {
      id: 'alpha',
      title: 'Alpha live',
      filePath: 'new/alpha.md',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-02-04T00:00:00.000Z',
    }
    const folders = favoriteNoteFolders(items, [moved], 'title', 'asc')

    expect(folders.has('old')).toBe(true)
    expect(folders.get('old')?.map((note) => note.id)).toEqual(['bravo', 'charlie'])
    expect(folders.get('new')).toEqual([moved])
  })
})
