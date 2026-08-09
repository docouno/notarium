// @vitest-environment jsdom

import { act, createElement } from 'react'
import type { DependencyList, EffectCallback } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_EVENT } from '@notarium/contract/events'

import type { NoteDetailView, NoteView, Tree, TreeChildrenView } from '../../../../libs/wire'
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
    space: 'work',
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
    harness.cacheMirrorEffects.length = 0
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
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
    let reloaded!: Promise<void>

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
