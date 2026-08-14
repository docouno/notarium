// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FavoriteItem } from '@notarium/contract'
import type { NoteView } from '../../libs/wire'

const harness = vi.hoisted(() => ({
  api: { favoritesGet: vi.fn(), favoriteDelete: vi.fn(), favoritePut: vi.fn() },
  cache: new Map<string, NoteView>(),
  observationEpoch: () => 0,
  resolveKnown: (id: string) => harness.cache.get(id),
  syncListener: null as ((event: { type: string }) => void) | null,
  subscribe: (listener: (event: { type: string }) => void) => {
    harness.syncListener = listener
    return () => {
      if (harness.syncListener === listener) {
        harness.syncListener = null
      }
    }
  },
  remember: vi.fn((notes: readonly NoteView[]) => {
    for (const note of notes) {
      harness.cache.set(note.id, note)
    }

    return [...notes]
  }),
}))

vi.mock('../../services/api', () => ({ api: harness.api }))
vi.mock('../NotesProvider', () => ({
  useNotes: () => ({
    remember: harness.remember,
    resolveKnown: harness.resolveKnown,
  }),
}))
vi.mock('../SpaceProvider', () => ({ useSpace: () => ({ space: 'work' }) }))
vi.mock('../SyncProvider', () => ({
  useSync: () => ({
    connectionRevision: 0,
    observationEpoch: harness.observationEpoch,
    subscribe: harness.subscribe,
  }),
}))

import { FavoritesProvider } from './FavoritesProvider'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const favorite = (filePath: string): FavoriteItem => ({
  kind: 'note',
  id: 'note-1',
  favoritedAt: '2026-01-01T00:00:00.000Z',
  note: {
    id: 'note-1',
    title: 'Favorite',
    filePath,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-02T00:00:00.000Z',
  },
})

describe('FavoritesProvider cache interleavings', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    harness.api.favoritesGet.mockReset()
    harness.api.favoriteDelete.mockReset()
    harness.api.favoritePut.mockReset()
    harness.cache.clear()
    harness.remember.mockClear()
    harness.syncListener = null
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = () => act(() => root.render(createElement(FavoritesProvider, null, null)))

  it('does not let a late favorite snapshot overwrite an optimistic move', async () => {
    const request = deferred<{ items: FavoriteItem[]; total: number }>()
    harness.api.favoritesGet.mockReturnValue(request.promise)
    render()
    harness.cache.set('note-1', {
      id: 'note-1',
      title: 'Favorite',
      filePath: 'new/favorite.md',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-03T00:00:00.000Z',
    })

    await act(async () => request.resolve({ items: [favorite('old/favorite.md')], total: 1 }))

    expect(harness.cache.get('note-1')?.filePath).toBe('new/favorite.md')
  })

  it('still seeds a cold point favorite into the Notes cache', async () => {
    harness.api.favoritesGet.mockResolvedValue({ items: [favorite('cold/favorite.md')], total: 1 })
    render()
    await act(async () => {
      await Promise.resolve()
    })

    expect(harness.cache.get('note-1')?.filePath).toBe('cold/favorite.md')
  })

  it('refreshes only a fallback that Favorites itself seeded', async () => {
    harness.api.favoritesGet
      .mockResolvedValueOnce({ items: [favorite('old/favorite.md')], total: 1 })
      .mockResolvedValueOnce({ items: [favorite('external/favorite.md')], total: 1 })
      .mockResolvedValueOnce({ items: [favorite('stale/favorite.md')], total: 1 })
    render()
    await act(async () => {
      await Promise.resolve()
    })
    expect(harness.cache.get('note-1')?.filePath).toBe('old/favorite.md')

    await act(async () => {
      harness.syncListener?.({ type: 'changed' })
      await Promise.resolve()
    })

    expect(harness.cache.get('note-1')?.filePath).toBe('external/favorite.md')

    harness.cache.set('note-1', {
      id: 'note-1',
      title: 'Favorite',
      filePath: 'live/favorite.md',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-04T00:00:00.000Z',
    })
    await act(async () => {
      harness.syncListener?.({ type: 'changed' })
      await Promise.resolve()
    })

    expect(harness.cache.get('note-1')?.filePath).toBe('live/favorite.md')
  })
})
