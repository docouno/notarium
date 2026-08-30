// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  refresh: vi.fn(),
  reloadArchived: vi.fn(),
  reloadSpaces: vi.fn(),
  verify: vi.fn(),
  space: 'active',
  streams: [] as Array<{
    close: ReturnType<typeof vi.fn>
    onEvent: (event: never) => void
    onError: (closed: boolean) => void
    onReady: (reconnected: boolean) => void
    watch: readonly string[]
  }>,
  value: null as null | {
    connectionRevision: number
    contextWatchRevision: number
    status: unknown
    changedLastMinute: () => number
    watchSpaces: (spaces: readonly string[]) => void
  },
}))

vi.mock('../../services/api', () => ({
  api: {
    events: vi.fn(
      (
        _space: string,
        onEvent: (event: never) => void,
        onError: (closed: boolean) => void,
        _onAccess: unknown,
        _onMembers: unknown,
        _onRename: unknown,
        _onAgentSessions: unknown,
        _onOpen: unknown,
        watch: readonly string[],
        _onContextEvent: unknown,
        onReady: (reconnected: boolean) => void,
      ) => {
        const close = vi.fn()

        harness.streams.push({ close, onEvent, onError, onReady, watch })
        return close
      },
    ),
  },
}))
vi.mock('../../services/previews', () => ({ dropPreviews: vi.fn() }))
vi.mock('../AuthProvider', () => ({ useAuth: () => ({ refresh: harness.refresh }) }))
vi.mock('../SpaceAccessProvider', () => ({
  useSpaceAccess: () => ({ verify: harness.verify }),
}))
vi.mock('../SpaceProvider', () => ({
  useSpace: () => ({
    space: harness.space,
    reloadSpaces: harness.reloadSpaces,
    reloadArchived: harness.reloadArchived,
  }),
}))

import { SyncProvider, useSync } from './SyncProvider'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const Probe = () => {
  const sync = useSync()

  harness.value = sync
  return null
}

describe('SyncProvider stream handoff', () => {
  let container: HTMLDivElement
  let root: Root | null

  beforeEach(() => {
    harness.streams = []
    harness.value = null
    harness.space = 'active'
    harness.refresh.mockReset()
    harness.reloadArchived.mockReset()
    harness.reloadSpaces.mockReset()
    harness.verify.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    container.remove()
  })

  const mount = async () => {
    await act(async () => {
      root?.render(createElement(SyncProvider, null, createElement(Probe)))
    })
    const initial = harness.streams[0]

    await act(async () => initial.onReady(false))
    return initial
  }

  const beginWatchHandoff = async () => {
    await act(async () => harness.value?.watchSpaces(['foreign']))
    return harness.streams[1]
  }

  it('keeps the previous stream until the replacement reports server readiness', async () => {
    const active = await mount()
    const connectionBefore = harness.value?.connectionRevision
    const contextBefore = harness.value?.contextWatchRevision
    const pending = await beginWatchHandoff()

    expect(pending.watch).toEqual(['foreign'])
    expect(active.close).not.toHaveBeenCalled()
    await act(async () => pending.onReady(false))
    expect(active.close).toHaveBeenCalledOnce()
    expect(harness.value?.connectionRevision).toBe(connectionBefore)
    expect(harness.value?.contextWatchRevision).toBe((contextBefore ?? 0) + 1)
  })

  it('keeps active status and recent activity through a watch-only replacement', async () => {
    const active = await mount()
    const liveStatus = { scan: { phase: 'ready' } }

    await act(async () => {
      active.onEvent({ type: 'status', status: liveStatus } as never)
      active.onEvent({ type: 'changed', upserts: ['n'], removed: [], folders: [] } as never)
    })
    expect(harness.value?.status).toBe(liveStatus)
    expect(harness.value?.changedLastMinute()).toBe(1)

    const pending = await beginWatchHandoff()

    expect(harness.value?.status).toBe(liveStatus)
    expect(harness.value?.changedLastMinute()).toBe(1)
    await act(async () => pending.onReady(false))
    expect(harness.value?.status).toBe(liveStatus)
    expect(harness.value?.changedLastMinute()).toBe(1)
  })

  it('reconciles a controlled handoff when the retained stream became unavailable', async () => {
    const active = await mount()
    const before = harness.value?.connectionRevision
    const pending = await beginWatchHandoff()

    active.onError(false)
    await act(async () => pending.onReady(false))

    expect(harness.value?.connectionRevision).toBe((before ?? 0) + 1)
  })

  it('closes both retained active and pending streams on final unmount', async () => {
    const active = await mount()
    const pending = await beginWatchHandoff()

    await act(async () => root?.unmount())
    root = null

    expect(active.close).toHaveBeenCalledOnce()
    expect(pending.close).toHaveBeenCalledOnce()
  })
})
