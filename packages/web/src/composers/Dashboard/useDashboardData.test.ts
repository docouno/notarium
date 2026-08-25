// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_EVENT } from '@notarium/contract/events'

const harness = vi.hoisted(() => ({
  api: {
    activityEventsGet: vi.fn(),
    activityGet: vi.fn(),
    activityProjectsGet: vi.fn(),
    graphGet: vi.fn(),
    graphHealthGet: vi.fn(),
    tagsGet: vi.fn(),
  },
  listeners: new Set<(event: { type: string }) => void>(),
  location: { pathname: '/s/work' },
  space: 'work',
}))

vi.mock('../../services/api', () => ({ api: harness.api }))
vi.mock('../SyncProvider', () => ({
  CHANGED_COALESCE_MS: 1,
  useSync: () => ({
    subscribe: (listener: (event: { type: string }) => void) => {
      harness.listeners.add(listener)
      return () => harness.listeners.delete(listener)
    },
  }),
}))
vi.mock('react-router', () => ({
  useLocation: () => harness.location,
  useOutletContext: vi.fn(),
}))

import { type DashData, useDashboardData } from './useDashboardData'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const activity = (label: string) => ({
  days: [],
  from: '2026-01-01',
  hasOtherAuthors: false,
  label,
  to: '2026-01-02',
})
const graph = (id: string) => ({ links: [], nodes: [{ id }] })
const health = (staleNamed: number) => ({
  edges: [],
  ghosts: [],
  staleNamed,
  totalLinks: 0,
  via: { folderAlias: 0, noteAlias: 0, slug: 0 },
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

describe('useDashboardData freshness lanes', () => {
  let container: HTMLDivElement
  let root: Root
  let state!: DashData

  const App = () => {
    state = useDashboardData(harness.space)
    return null
  }

  const settle = async () => {
    await act(async () => {
      for (let turn = 0; turn < 8; turn++) {
        await Promise.resolve()
      }
    })
  }

  const emitMany = async (types: string[]) => {
    await act(async () => {
      for (const type of types) {
        for (const listener of harness.listeners) {
          listener({ type })
        }
      }
      vi.advanceTimersByTime(1)
      for (let turn = 0; turn < 8; turn++) {
        await Promise.resolve()
      }
    })
  }
  const emit = (type: string) => emitMany([type])

  beforeEach(async () => {
    vi.useFakeTimers()
    harness.listeners.clear()
    harness.location.pathname = '/s/work'
    harness.space = 'work'
    harness.api.activityGet.mockReset().mockResolvedValue(activity('initial'))
    harness.api.activityEventsGet.mockReset().mockResolvedValue({ events: [] })
    harness.api.activityProjectsGet.mockReset().mockResolvedValue({ projects: [] })
    harness.api.tagsGet.mockReset().mockResolvedValue({ total: 0 })
    harness.api.graphGet.mockReset().mockResolvedValue(graph('initial'))
    harness.api.graphHealthGet.mockReset().mockResolvedValue(health(0))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root.render(createElement(App)))
    await settle()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
    container.remove()
  })

  it('refreshes journal channels on changed without touching graph channels', async () => {
    await emit(STORE_EVENT.CHANGED)
    await settle()

    expect(harness.api.activityGet).toHaveBeenCalledTimes(2)
    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(2)
    expect(harness.api.activityProjectsGet).toHaveBeenCalledTimes(2)
    expect(harness.api.tagsGet).toHaveBeenCalledTimes(2)
    expect(harness.api.graphGet).toHaveBeenCalledOnce()
    expect(harness.api.graphHealthGet).toHaveBeenCalledOnce()
  })

  it('refreshes graph channels on graph without refetching journal channels', async () => {
    await emit(STORE_EVENT.GRAPH)
    await settle()

    expect(harness.api.graphGet).toHaveBeenCalledTimes(2)
    expect(harness.api.graphHealthGet).toHaveBeenCalledTimes(2)
    expect(harness.api.activityGet).toHaveBeenCalledOnce()
    expect(harness.api.activityEventsGet).toHaveBeenCalledOnce()
    expect(harness.api.activityProjectsGet).toHaveBeenCalledOnce()
    expect(harness.api.tagsGet).toHaveBeenCalledOnce()
  })

  it('does not let a later activity refresh discard an in-flight graph result', async () => {
    const nextGraph = deferred<ReturnType<typeof graph>>()
    const nextHealth = deferred<ReturnType<typeof health>>()

    harness.api.graphGet.mockReturnValueOnce(nextGraph.promise)
    harness.api.graphHealthGet.mockReturnValueOnce(nextHealth.promise)
    await emit(STORE_EVENT.GRAPH)

    harness.api.activityGet.mockResolvedValueOnce(activity('after write'))
    await emit(STORE_EVENT.CHANGED)
    await settle()
    expect(state.activity).toMatchObject({ label: 'after write' })
    expect(state.graph).toMatchObject({ nodes: [{ id: 'initial' }] })

    await act(async () => {
      nextGraph.resolve(graph('fresh'))
      nextHealth.resolve(health(1))
      await Promise.resolve()
    })

    expect(state.graph).toMatchObject({ nodes: [{ id: 'fresh' }] })
    expect(state.health?.staleNamed).toBe(1)
    expect(state.activity).toMatchObject({ label: 'after write' })
  })

  it('does not let either late lane from the previous space replace the new bundle', async () => {
    const oldActivity = deferred<ReturnType<typeof activity>>()
    const oldGraph = deferred<ReturnType<typeof graph>>()
    const oldHealth = deferred<ReturnType<typeof health>>()

    harness.api.activityGet.mockReturnValueOnce(oldActivity.promise)
    harness.api.graphGet.mockReturnValueOnce(oldGraph.promise)
    harness.api.graphHealthGet.mockReturnValueOnce(oldHealth.promise)
    await emitMany([STORE_EVENT.CHANGED, STORE_EVENT.GRAPH])

    harness.space = 'next'
    harness.location.pathname = '/s/next'
    harness.api.activityGet.mockResolvedValueOnce(activity('next'))
    harness.api.graphGet.mockResolvedValueOnce(graph('next'))
    harness.api.graphHealthGet.mockResolvedValueOnce(health(2))
    act(() => root.render(createElement(App)))
    await settle()

    expect(state.activity).toMatchObject({ label: 'next' })
    expect(state.graph).toMatchObject({ nodes: [{ id: 'next' }] })

    await act(async () => {
      oldActivity.resolve(activity('old-late'))
      oldGraph.resolve(graph('old-late'))
      oldHealth.resolve(health(99))
      await Promise.resolve()
    })

    expect(state.activity).toMatchObject({ label: 'next' })
    expect(state.graph).toMatchObject({ nodes: [{ id: 'next' }] })
    expect(state.health?.staleNamed).toBe(2)
  })
})
