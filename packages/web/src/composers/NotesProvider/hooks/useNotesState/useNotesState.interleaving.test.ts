// @vitest-environment jsdom

import { act, createElement } from 'react'
import type { DependencyList, EffectCallback } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_EVENT } from '@notarium/contract/events'

import type { NoteDetailView, NoteView, Tree, TreeChildrenView } from '../../../../libs/wire'
import { FOLDER_RETRY_DELAYS_MS } from '../../consts'
import type { NotesContextValue } from '../../types'

type ReactModule = Record<string, unknown> & {
  useEffect: (effect: EffectCallback, deps?: DependencyList) => void
}

const harness = vi.hoisted(() => ({
  api: {
    noteGet: vi.fn(),
    noteResolve: vi.fn(),
    treeChildrenGet: vi.fn(),
    treeGet: vi.fn(),
  },
  connectionRevision: 0,
  epoch: 0,
  listeners: new Set<(event: unknown) => void>(),
  location: { pathname: '/', state: null as unknown },
  navigate: vi.fn(),
  reportNoteSpace: vi.fn(),
  space: 'work',
  cacheMirrorEffects: [] as Array<() => void | (() => void)>,
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<ReactModule>()

  const useEffect: ReactModule['useEffect'] = (effect, deps) => {
    // The removed implementation mirrored cache state back into refs from two
    // passive effects. Hold those effects so the test can deterministically
    // replay an older render after a newer folder response has committed.
    if (deps?.length === 1 && deps[0] instanceof Map) {
      harness.cacheMirrorEffects.push(effect)
      return
    }

    return actual.useEffect(effect, deps)
  }

  return { ...actual, useEffect }
})

vi.mock('../../../../services/api', () => ({ api: harness.api }))
vi.mock('../../../SpaceProvider', () => ({
  useSpace: () => ({
    space: harness.space,
    personalSpace: null,
    reportNoteSpace: harness.reportNoteSpace,
  }),
}))
vi.mock('../../../SyncProvider', () => {
  const observationEpoch = () => harness.epoch

  const subscribe = (listener: (event: unknown) => void) => {
    harness.listeners.add(listener)
    return () => harness.listeners.delete(listener)
  }

  return {
    CHANGED_COALESCE_MS: 1,
    useSync: () => ({
      connectionRevision: harness.connectionRevision,
      observationEpoch,
      subscribe,
    }),
  }
})
vi.mock('react-router', () => ({
  useLocation: () => harness.location,
  useNavigate: () => harness.navigate,
}))

import { useNotesState } from './useNotesState'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, reject, resolve }
}

const tree = (path: string): Tree => ({
  folders: [{ path, name: path, count: 0, direct: 0 }],
  stats: { total: 0, root: 0, week: 0 },
})

const listedNote = (folder: string): NoteView => ({
  id: `id-${folder}`,
  title: `Note ${folder}`,
  filePath: `${folder}/note.md`,
  class: 'user-doc',
  modifiedAt: null,
  createdAt: null,
})

const listing = (folder: string): TreeChildrenView => ({
  folders: [],
  notes: [listedNote(folder)],
  total: 1,
})

const folderListing = (...notes: NoteView[]): TreeChildrenView => ({
  folders: [],
  notes,
  total: notes.length,
})

const movedNote = (folder: string): NoteView => ({
  id: 'moved',
  title: 'Moved note',
  filePath: `${folder}/moved.md`,
  class: 'user-doc',
  modifiedAt: null,
  createdAt: null,
})

const orderListing = (folder: string, order: readonly string[]): TreeChildrenView => {
  const rows: Record<string, NoteView> = {
    alpha: {
      id: 'alpha',
      title: 'Alpha',
      filePath: `${folder}/alpha.md`,
      modifiedAt: '2026-03-03T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    bravo: {
      id: 'bravo',
      title: 'Bravo',
      filePath: `${folder}/bravo.md`,
      modifiedAt: '2026-03-01T00:00:00.000Z',
      createdAt: '2026-01-03T00:00:00.000Z',
    },
    charlie: {
      id: 'charlie',
      title: 'Charlie',
      filePath: `${folder}/charlie.md`,
      modifiedAt: '2026-03-02T00:00:00.000Z',
      createdAt: '2026-01-02T00:00:00.000Z',
    },
  }

  return { folders: [], notes: order.map((id) => rows[id]), total: order.length }
}

const detail = (deleted = false): NoteDetailView => ({
  id: 'D',
  title: deleted ? 'Deleted D' : 'Live D',
  filePath: 'd.md',
  content: deleted ? 'deleted' : 'live',
  frontmatter: {},
  versionToken: 'v1',
  ...(deleted ? { deleted: true, restorable: true } : {}),
})

describe('useNotesState interleavings', () => {
  let container: HTMLDivElement
  let root: Root
  let state: NotesContextValue

  const App = () => {
    state = useNotesState()
    return null
  }

  const render = () => {
    act(() => root.render(createElement(App)))
  }

  const settle = async () => {
    await act(async () => {
      await Promise.resolve()
    })
  }

  const emitChanged = async (upserts: string[], removed: string[]) => {
    await act(async () => {
      harness.epoch++
      for (const listener of harness.listeners) {
        listener({ type: STORE_EVENT.CHANGED, upserts, removed, folders: [] })
      }
      await Promise.resolve()
    })
  }

  const setPath = (pathname: string) => {
    harness.location.pathname = pathname
    window.history.replaceState(null, '', pathname)
  }

  beforeEach(() => {
    harness.api.noteGet.mockReset()
    harness.api.noteResolve.mockReset()
    harness.api.treeChildrenGet.mockReset()
    harness.api.treeGet.mockReset().mockResolvedValue(tree('boot'))
    harness.connectionRevision = 0
    harness.epoch = 0
    harness.listeners.clear()
    setPath('/')
    harness.location.state = null
    harness.navigate.mockReset()
    harness.reportNoteSpace.mockReset()
    harness.space = 'work'
    harness.cacheMirrorEffects.length = 0
    localStorage.clear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
    container.remove()
  })

  it('reconciles the first open once when the stream becomes ready before the reader', async () => {
    const reader = deferred<NoteDetailView>()

    setPath('/n/D')
    harness.api.noteGet.mockReturnValue(reader.promise)
    render()

    harness.connectionRevision = 1
    render()
    expect(harness.api.treeGet).toHaveBeenCalledOnce()

    await act(async () => reader.resolve(detail()))
    expect(harness.api.treeGet).toHaveBeenCalledTimes(2)

    render()
    expect(harness.api.treeGet).toHaveBeenCalledTimes(2)
  })

  it('reconciles the first open once when the reader becomes ready before the stream', async () => {
    render()
    await settle()
    expect(harness.api.treeGet).toHaveBeenCalledOnce()

    harness.connectionRevision = 1
    render()
    await settle()
    expect(harness.api.treeGet).toHaveBeenCalledTimes(2)

    render()
    expect(harness.api.treeGet).toHaveBeenCalledTimes(2)
  })

  it('does not let stale tree A overwrite newer same-space response B', async () => {
    const requestA = deferred<Tree>()
    const requestB = deferred<Tree>()

    harness.api.treeGet.mockReturnValueOnce(requestA.promise).mockReturnValueOnce(requestB.promise)
    render()
    let refresh!: Promise<void>

    await act(async () => {
      refresh = state.refreshFolders([])
      await Promise.resolve()
    })
    await act(async () => requestB.resolve(tree('new')))
    await refresh
    expect(state.tree?.folders[0]?.path).toBe('new')

    await act(async () => requestA.resolve(tree('old')))
    expect(state.tree?.folders[0]?.path).toBe('new')
    expect(state.listError).toBeNull()
  })

  it('does not let a stale tree error replace a newer successful response', async () => {
    const requestA = deferred<Tree>()
    const requestB = deferred<Tree>()

    harness.api.treeGet.mockReturnValueOnce(requestA.promise).mockReturnValueOnce(requestB.promise)
    render()
    let refresh!: Promise<void>

    await act(async () => {
      refresh = state.refreshFolders([])
      await Promise.resolve()
    })
    await act(async () => requestB.resolve(tree('new')))
    await refresh
    await act(async () => requestA.reject(new Error('stale failure')))

    expect(state.tree?.folders[0]?.path).toBe('new')
    expect(state.listError).toBeNull()
  })

  it('does not let an older render roll back an accepted folder listing', async () => {
    const folders = ['one', 'two', 'three']
    const requests = new Map(folders.map((folder) => [folder, deferred<TreeChildrenView>()]))

    harness.api.treeChildrenGet.mockImplementation(
      (_space: string, folder: string) => requests.get(folder)?.promise,
    )
    render()
    await settle()
    harness.cacheMirrorEffects.length = 0

    act(() => {
      for (const folder of folders) {
        state.ensureFolder(folder)
      }
    })
    await act(async () => {
      requests.get('one')?.resolve(listing('one'))
      await Promise.resolve()
    })
    const staleMirrorEffects = harness.cacheMirrorEffects.splice(0)

    await act(async () => {
      requests.get('two')?.resolve(listing('two'))
      await Promise.resolve()
      for (const effect of staleMirrorEffects) {
        effect()
      }
      requests.get('three')?.resolve(listing('three'))
      await Promise.resolve()
    })

    expect(state.knownNotes.map((note) => note.id).sort()).toEqual(
      folders.map((folder) => `id-${folder}`).sort(),
    )
  })

  it('retries an initial listing invalidated without a successor', async () => {
    vi.useFakeTimers()
    const first = deferred<TreeChildrenView>()
    const second = deferred<TreeChildrenView>()

    harness.api.treeChildrenGet
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    render()
    await settle()

    act(() => state.ensureFolder('held'))
    await emitChanged([], ['unrelated-removal'])
    await act(async () => first.resolve(listing('held')))
    expect(state.notesIn('held')).toBeNull()

    await act(async () => vi.advanceTimersByTimeAsync(FOLDER_RETRY_DELAYS_MS[0]))
    expect(harness.api.treeChildrenGet).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve(listing('held')))
    expect(state.notesIn('held')?.map((note) => note.id)).toEqual(['id-held'])
  })

  it('starts a fresh lifecycle when the terminal listing is invalidated', async () => {
    vi.useFakeTimers()
    const final = deferred<TreeChildrenView>()

    harness.api.treeChildrenGet
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(final.promise)
      .mockResolvedValueOnce(listing('held'))
    render()
    await settle()

    act(() => state.ensureFolder('held'))
    await settle()
    await act(async () => vi.advanceTimersByTimeAsync(FOLDER_RETRY_DELAYS_MS[0]))
    await act(async () => vi.advanceTimersByTimeAsync(FOLDER_RETRY_DELAYS_MS[1]))
    expect(harness.api.treeChildrenGet).toHaveBeenCalledTimes(3)

    await emitChanged([], ['unrelated-removal'])
    await act(async () => vi.advanceTimersByTimeAsync(1))
    act(() => state.ensureFolder('held'))
    await act(async () => final.resolve(listing('held')))
    await settle()

    expect(harness.api.treeChildrenGet).toHaveBeenCalledTimes(4)
    expect(state.notesIn('held')?.map((note) => note.id)).toEqual(['id-held'])
  })

  it('starts a fresh lifecycle when the rejected terminal listing is invalidated', async () => {
    vi.useFakeTimers()
    const final = deferred<TreeChildrenView>()

    harness.api.treeChildrenGet
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(final.promise)
      .mockResolvedValueOnce(listing('held'))
    render()
    await settle()

    act(() => state.ensureFolder('held'))
    await settle()
    await act(async () => vi.advanceTimersByTimeAsync(FOLDER_RETRY_DELAYS_MS[0]))
    await act(async () => vi.advanceTimersByTimeAsync(FOLDER_RETRY_DELAYS_MS[1]))
    expect(harness.api.treeChildrenGet).toHaveBeenCalledTimes(3)

    await emitChanged([], ['unrelated-removal'])
    await act(async () => vi.advanceTimersByTimeAsync(1))
    act(() => state.ensureFolder('held'))
    await act(async () => final.reject(new Error('stale offline')))
    await settle()

    expect(harness.api.treeChildrenGet).toHaveBeenCalledTimes(4)
    expect(state.notesIn('held')?.map((note) => note.id)).toEqual(['id-held'])
  })

  it('runs the named initial-listing schedule to an empty timer queue', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const attemptedAt: number[] = []

    harness.api.treeChildrenGet.mockImplementation(async () => {
      attemptedAt.push(Date.now())
      throw new Error('offline')
    })
    render()
    await settle()

    act(() => state.ensureFolder('missing'))
    await act(async () => vi.runAllTimersAsync())
    const expectedAt = [0]

    for (const delay of FOLDER_RETRY_DELAYS_MS) {
      expectedAt.push(expectedAt.at(-1)! + delay)
    }
    expect(FOLDER_RETRY_DELAYS_MS).toHaveLength(2)
    expect(attemptedAt).toEqual(expectedAt)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases an exhausted initial-listing owner for a later lifecycle', async () => {
    vi.useFakeTimers()
    harness.api.treeChildrenGet.mockRejectedValue(new Error('offline'))
    render()
    await settle()

    act(() => state.ensureFolder('missing'))
    await act(async () => vi.runAllTimersAsync())
    expect(harness.api.treeChildrenGet).toHaveBeenCalledTimes(3)

    harness.api.treeChildrenGet.mockResolvedValueOnce(listing('missing'))
    act(() => state.ensureFolder('missing'))
    await settle()

    expect(harness.api.treeChildrenGet).toHaveBeenCalledTimes(4)
    expect(state.notesIn('missing')?.map((note) => note.id)).toEqual(['id-missing'])
  })

  it('does not let an old A lifecycle commit into or release a new A lifecycle', async () => {
    const oldA = deferred<TreeChildrenView>()
    const newA = deferred<TreeChildrenView>()

    harness.api.treeChildrenGet.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(newA.promise)
    render()
    await settle()
    act(() => state.ensureFolder('shared'))

    harness.space = 'other'
    render()
    await settle()
    harness.space = 'work'
    render()
    await settle()
    act(() => state.ensureFolder('shared'))
    expect(harness.api.treeChildrenGet).toHaveBeenCalledTimes(2)

    await act(async () => oldA.resolve(listing('shared')))
    expect(state.notesIn('shared')).toBeNull()
    act(() => state.ensureFolder('shared'))
    expect(harness.api.treeChildrenGet).toHaveBeenCalledTimes(2)

    await act(async () => newA.resolve(listing('shared')))
    expect(state.notesIn('shared')?.map((note) => note.id)).toEqual(['id-shared'])
  })

  it('does not retry an initial listing after unmount', async () => {
    vi.useFakeTimers()
    harness.api.treeChildrenGet.mockRejectedValue(new Error('offline'))
    render()
    await settle()
    act(() => state.ensureFolder('orphaned'))
    await settle()

    await act(async () => root.unmount())
    await act(async () => vi.runAllTimersAsync())
    expect(harness.api.treeChildrenGet).toHaveBeenCalledOnce()
  })

  it('updates cache-owner refs before React flushes a local move', async () => {
    const from = deferred<TreeChildrenView>()
    const to = deferred<TreeChildrenView>()

    harness.api.treeChildrenGet.mockImplementation((_space: string, folder: string) =>
      folder === 'from' ? from.promise : to.promise,
    )
    render()
    await settle()

    await act(async () => {
      state.ensureFolder('from')
      state.ensureFolder('to')
      from.resolve(listing('from'))
      to.resolve(listing('to'))
      await Promise.resolve()
    })

    act(() => {
      const previous = state.applyLocalMove('id-from', 'from', 'to', 'to/moved.md')

      expect(previous?.filePath).toBe('from/note.md')
      // Async callbacks resolve through the mutable cache owner before React
      // publishes its render projection. The old state-only move left this ref
      // stale until a passive effect and fails this assertion.
      expect(state.resolveKnown('id-from')?.filePath).toBe('to/moved.md')
    })

    expect(state.notesIn('from')?.map((note) => note.id)).toEqual([])
    expect(
      state
        .notesIn('to')
        ?.map((note) => note.id)
        .sort(),
    ).toEqual(['id-from', 'id-to'])
  })

  it('publishes a destination listing without duplicating its ids across held folders', async () => {
    harness.api.treeChildrenGet.mockImplementation(async (_space: string, folder: string) =>
      folder === 'from' ? folderListing(movedNote('from')) : folderListing(),
    )
    render()
    await settle()

    await act(async () => {
      state.ensureFolder('from')
      state.ensureFolder('to')
      await Promise.resolve()
    })

    expect(state.notesIn('from')?.map((note) => note.id)).toEqual(['moved'])
    expect(state.notesIn('to')).toEqual([])

    const from = deferred<TreeChildrenView>()
    const to = deferred<TreeChildrenView>()

    harness.api.treeChildrenGet.mockImplementation((_space: string, folder: string) =>
      folder === 'from' ? from.promise : to.promise,
    )
    let refresh!: Promise<void>

    await act(async () => {
      refresh = state.refreshFolders(['from', 'to'])
      await Promise.resolve()
    })
    await act(async () => to.resolve(folderListing(movedNote('to'))))

    const membership = ['from', 'to'].flatMap((folder) => state.notesIn(folder) ?? [])

    expect(membership.filter((note) => note.id === 'moved')).toHaveLength(1)
    expect(state.notesIn('to')?.map((note) => note.id)).toEqual(['moved'])

    await act(async () => from.resolve(folderListing()))
    await refresh
    expect(state.notesIn('from')).toEqual([])
    expect(state.notesIn('to')?.map((note) => note.id)).toEqual(['moved'])
  })

  it('reorders every held folder immediately and reconciles with the same server query', async () => {
    const reconcile = deferred<TreeChildrenView>()

    harness.api.treeChildrenGet
      .mockResolvedValueOnce(orderListing('held', ['alpha', 'bravo', 'charlie']))
      .mockReturnValueOnce(reconcile.promise)
    render()
    await settle()
    await act(async () => {
      state.ensureFolder('held')
      await Promise.resolve()
    })
    expect(state.notesIn('held')?.map((note) => note.id)).toEqual(['alpha', 'bravo', 'charlie'])

    act(() => state.setExplorerSort('modified'))
    expect(state.notesIn('held')?.map((note) => note.id)).toEqual(['bravo', 'charlie', 'alpha'])
    expect(harness.api.treeChildrenGet).toHaveBeenLastCalledWith('work', 'held', {
      sort: 'modified',
      dir: 'asc',
    })

    await act(async () => reconcile.resolve(orderListing('held', ['bravo', 'charlie', 'alpha'])))
    expect(state.notesIn('held')?.map((note) => note.id)).toEqual(['bravo', 'charlie', 'alpha'])
  })

  it('does not let a response issued under the old order overwrite the new one', async () => {
    const oldOrder = deferred<TreeChildrenView>()
    const newOrder = deferred<TreeChildrenView>()

    harness.api.treeChildrenGet
      .mockResolvedValueOnce(orderListing('held', ['alpha', 'bravo', 'charlie']))
      .mockReturnValueOnce(oldOrder.promise)
      .mockReturnValueOnce(newOrder.promise)
    render()
    await settle()
    await act(async () => {
      state.ensureFolder('held')
      await Promise.resolve()
    })
    let refresh!: Promise<void>

    await act(async () => {
      refresh = state.refreshFolders(['held'])
      await Promise.resolve()
    })
    act(() => state.setExplorerSort('created'))
    expect(state.notesIn('held')?.map((note) => note.id)).toEqual(['alpha', 'charlie', 'bravo'])

    await act(async () => oldOrder.resolve(orderListing('held', ['alpha', 'bravo', 'charlie'])))
    await refresh
    expect(state.notesIn('held')?.map((note) => note.id)).toEqual(['alpha', 'charlie', 'bravo'])

    await act(async () => newOrder.resolve(orderListing('held', ['alpha', 'charlie', 'bravo'])))
    expect(state.notesIn('held')?.map((note) => note.id)).toEqual(['alpha', 'charlie', 'bravo'])
  })

  it('retries D@0 after removed@1 without publishing the late live response', async () => {
    const staleLive = deferred<NoteDetailView>()
    const freshDeleted = deferred<NoteDetailView>()

    setPath('/n/D')
    harness.api.noteGet
      .mockReturnValueOnce(staleLive.promise)
      .mockReturnValueOnce(freshDeleted.promise)
    render()
    await emitChanged([], ['D'])

    await act(async () => staleLive.resolve(detail()))
    expect(harness.api.noteGet).toHaveBeenCalledTimes(2)
    expect(state.note).toBeNull()

    await act(async () => freshDeleted.resolve(detail(true)))
    expect(state.note?.deleted).toBe(true)
    expect(state.note?.title).toBe('Deleted D')
  })

  it('keeps reloadNote from publishing a live response older than removal', async () => {
    const staleLive = deferred<NoteDetailView>()
    const freshDeleted = deferred<NoteDetailView>()

    setPath('/n/D')
    harness.api.noteGet.mockResolvedValueOnce(detail())
    render()
    await settle()
    expect(state.note?.title).toBe('Live D')
    harness.api.noteGet
      .mockReturnValueOnce(staleLive.promise)
      .mockReturnValueOnce(freshDeleted.promise)
    let reloaded!: Promise<boolean>

    await act(async () => {
      reloaded = state.reloadNote()
      await Promise.resolve()
    })
    await emitChanged([], ['D'])
    await act(async () => staleLive.resolve({ ...detail(), title: 'Stale response' }))
    expect(harness.api.noteGet).toHaveBeenCalledTimes(3)
    expect(state.note?.title).toBe('Live D')

    await act(async () => freshDeleted.resolve(detail(true)))
    await reloaded
    expect(state.note?.deleted).toBe(true)
  })

  it('does not repeat an SSE detail read already satisfied after that event', async () => {
    vi.useFakeTimers()
    setPath('/n/D')
    harness.api.noteGet
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce({ ...detail(), versionToken: 'v2', content: 'fresh' })
    render()
    await settle()

    await emitChanged(['D'], [])
    await act(async () => {
      await state.reloadNote()
    })
    await act(async () => vi.advanceTimersByTimeAsync(1))

    expect(state.note?.versionToken).toBe('v2')
    expect(harness.api.noteGet).toHaveBeenCalledTimes(2)
  })

  it('retries an opening detail whose response predates an upsert event', async () => {
    vi.useFakeTimers()
    const stale = deferred<NoteDetailView>()
    const fresh = deferred<NoteDetailView>()

    harness.api.noteGet.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    render()
    await settle()
    let opened!: Promise<void>

    await act(async () => {
      opened = state.openNote('D')
      await Promise.resolve()
    })
    await emitChanged(['D'], [])
    await act(async () => vi.advanceTimersByTimeAsync(1))

    await act(async () => stale.resolve({ ...detail(), content: 'stale' }))
    expect(harness.api.noteGet).toHaveBeenCalledTimes(2)
    await act(async () => fresh.resolve({ ...detail(), versionToken: 'v2', content: 'fresh' }))
    await opened

    expect(state.note?.content).toBe('fresh')
    expect(harness.api.noteGet).toHaveBeenCalledTimes(2)
  })

  it('rejects a late deleted detail after restore and retries the live note', async () => {
    const staleDeleted = deferred<NoteDetailView>()
    const freshLive = deferred<NoteDetailView>()

    render()
    await settle()
    await emitChanged([], ['D'])
    harness.api.noteGet
      .mockReturnValueOnce(staleDeleted.promise)
      .mockReturnValueOnce(freshLive.promise)
    let opened!: Promise<void>

    await act(async () => {
      opened = state.openNote('D')
      await Promise.resolve()
    })
    await emitChanged(['D'], [])
    await act(async () => staleDeleted.resolve(detail(true)))
    expect(harness.api.noteGet).toHaveBeenCalledTimes(2)
    expect(state.note).toBeNull()

    await act(async () => freshLive.resolve(detail()))
    await opened
    expect(state.note?.deleted).not.toBe(true)
    expect(state.note?.title).toBe('Live D')
  })
})
