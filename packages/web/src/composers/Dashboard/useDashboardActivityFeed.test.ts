// @vitest-environment jsdom

import { act, createElement, useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../services/api/client'

const harness = vi.hoisted(() => ({
  api: {
    activityEventsGet: vi.fn(),
    activityGet: vi.fn(),
    activityGroupsGet: vi.fn(),
  },
  listeners: new Set<(event: { type: string }) => void>(),
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

import {
  type ActivityGroup,
  type ActivityScopeChrome,
  activityScopeChrome,
} from './activityPreferences'
import { type DashboardActivityFeed, useDashboardActivityFeed } from './useDashboardActivityFeed'
import type { ActivityScope } from './useDashboardData'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const groups = (
  label: string,
  hasOtherAuthors: boolean,
  cut: { through?: string; activityVersion?: string; locationThrough?: string } = {},
) => {
  const through = cut.through ?? '10'
  const activityVersion = cut.activityVersion ?? 'activity-v1'

  return {
    itemType: 'note' as const,
    items: [],
    total: 0,
    through,
    activityVersion,
    locationThrough: cut.locationThrough ?? 'location-1',
    nextCursor: null,
    scopeGate: { hasOtherAuthors, through, activityVersion },
    label,
  }
}

const mineGroups = (
  label: string,
  cut: { through?: string; activityVersion?: string; locationThrough?: string } = {},
) => ({
  ...groups(label, false, cut),
  scopeGate: undefined,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('useDashboardActivityFeed', () => {
  let container: HTMLDivElement
  let root: Root
  let state!: DashboardActivityFeed
  let chrome!: ActivityScopeChrome
  let chromeHistory: ActivityScopeChrome[]
  let space: string
  let group: ActivityGroup
  let scope: ActivityScope

  const App = () => {
    state = useDashboardActivityFeed(space, group, scope)
    const chromeCache = useRef<ActivityScopeChrome | null>(null)
    const nextChrome = activityScopeChrome(
      space,
      { resolved: state.gateResolved, canScope: state.canScope, scope: state.scope },
      chromeCache.current,
    )

    chrome = nextChrome
    chromeHistory.push(nextChrome)
    useLayoutEffect(() => {
      chromeCache.current = nextChrome
    }, [nextChrome])
    return null
  }

  const settle = async () => {
    await act(async () => {
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve()
      }
    })
  }

  beforeEach(() => {
    harness.listeners.clear()
    harness.api.activityEventsGet.mockReset()
    harness.api.activityGet.mockReset()
    harness.api.activityGroupsGet.mockReset().mockResolvedValue(groups('all', false))
    chromeHistory = []
    space = 'work'
    group = 'note'
    scope = 'all'
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('starts directly with the saved group and never touches the heatmap lane', async () => {
    group = 'folder'
    act(() => root.render(createElement(App)))
    await settle()

    expect(harness.api.activityGroupsGet).toHaveBeenCalledOnce()
    expect(harness.api.activityGroupsGet).toHaveBeenCalledWith(
      'work',
      expect.objectContaining({ by: 'folder' }),
    )
    expect(harness.api.activityGet).not.toHaveBeenCalled()
    expect(state.group).toBe('folder')
  })

  it('drops the previous Space before the route-intended Space request resolves', async () => {
    const beta = deferred<ReturnType<typeof groups>>()

    harness.api.activityGroupsGet.mockImplementation((requestedSpace: string) =>
      requestedSpace === 'beta' ? beta.promise : Promise.resolve(groups('alpha all', true)),
    )
    act(() => root.render(createElement(App)))
    await settle()
    expect(state.overview).toMatchObject({ response: { label: 'alpha all' } })

    space = 'beta'
    act(() => root.render(createElement(App)))
    await settle()

    expect(state.overview).toBeNull()
    expect(state.gateResolved).toBe(false)
    expect(chrome).toEqual({
      space: 'beta',
      committed: false,
      canScope: false,
      scope: 'all',
    })

    beta.resolve(
      groups('beta all', true, {
        through: '20',
        activityVersion: 'activity-v2',
        locationThrough: 'location-2',
      }),
    )
    await settle()
    expect(state.overview).toMatchObject({ response: { label: 'beta all' } })
  })

  it('publishes saved Mine only after the unscoped all-time gate resolves', async () => {
    const all = deferred<ReturnType<typeof groups>>()
    harness.api.activityGroupsGet.mockImplementation(
      (_space: string, params: { author?: 'mine' }) =>
        params.author ? Promise.resolve(mineGroups('mine')) : all.promise,
    )
    scope = 'mine'
    act(() => root.render(createElement(App)))
    await settle()

    expect(state.gateResolved).toBe(false)
    expect(state.overview).toBeNull()

    await act(async () => {
      all.resolve(groups('all', true))
      await Promise.resolve()
    })
    await settle()

    expect(state.gateResolved).toBe(true)
    expect(state.scope).toBe('mine')
    expect(state.overview).toMatchObject({ response: { label: 'mine' } })
  })

  it('keeps preferred Mine latent in a solo space and publishes Everyone', async () => {
    harness.api.activityGroupsGet.mockImplementation(
      (_space: string, params: { author?: 'mine' }) =>
        Promise.resolve(params.author ? mineGroups('mine') : groups('all', false)),
    )
    scope = 'mine'
    act(() => root.render(createElement(App)))
    await settle()

    expect(state.canScope).toBe(false)
    expect(state.scope).toBe('all')
    expect(state.overview).toMatchObject({ response: { label: 'all' } })
  })

  it('refetches early Mine on the exact gate cut before publishing it', async () => {
    harness.api.activityGroupsGet.mockImplementation(
      (_space: string, params: { author?: 'mine'; through?: string }) => {
        if (!params.author) {
          return Promise.resolve(groups('all', true))
        }

        return Promise.resolve(
          params.through
            ? mineGroups('aligned', { through: params.through })
            : mineGroups('early', { through: '9' }),
        )
      },
    )
    scope = 'mine'
    act(() => root.render(createElement(App)))
    await settle()

    expect(harness.api.activityGroupsGet).toHaveBeenCalledTimes(3)
    expect(harness.api.activityGroupsGet).toHaveBeenLastCalledWith(
      'work',
      expect.objectContaining({
        author: 'mine',
        through: '10',
        activityVersion: 'activity-v1',
        locationThrough: 'location-1',
      }),
    )
    expect(state.overview).toMatchObject({ response: { label: 'aligned', through: '10' } })
  })

  it('does not let a delayed Mine alignment publish after another Group supersedes it', async () => {
    const oldAlignment = deferred<ReturnType<typeof mineGroups>>()

    harness.api.activityGroupsGet.mockImplementation(
      (_space: string, params: { author?: 'mine'; by: ActivityGroup; through?: string }) => {
        if (params.by === 'note') {
          if (!params.author) {
            return Promise.resolve(groups('old all', true))
          }

          return params.through
            ? oldAlignment.promise
            : Promise.resolve(mineGroups('old early', { through: '9' }))
        }
        const cut = {
          through: '20',
          activityVersion: 'activity-v2',
          locationThrough: 'location-2',
        }

        return Promise.resolve(
          params.author ? mineGroups('current mine', cut) : groups('current all', true, cut),
        )
      },
    )
    scope = 'mine'
    act(() => root.render(createElement(App)))
    await settle()
    expect(state.gateResolved).toBe(false)

    group = 'folder'
    act(() => root.render(createElement(App)))
    await settle()
    expect(state.overview).toMatchObject({ response: { label: 'current mine' } })

    oldAlignment.resolve(mineGroups('old aligned'))
    await settle()

    expect(state.group).toBe('folder')
    expect(state.gateResolved).toBe(true)
    expect(state.overview).toMatchObject({ response: { label: 'current mine' } })
  })

  it.each(['all', 'mine'] as const)(
    'keeps Everyone/Mine chrome stable with %s selected through rapid Groups and reverse delayed responses',
    async (selectedScope) => {
      scope = selectedScope
      harness.api.activityGroupsGet.mockResolvedValue(groups('initial note', true))
      act(() => root.render(createElement(App)))
      await settle()
      expect(chrome).toMatchObject({ canScope: true, scope: selectedScope })

      const folder = deferred<ReturnType<typeof groups>>()
      const none = deferred<{
        events: never[]
        total: number
        through: string
        activityVersion: string
        nextCursor: null
        scopeGate: { hasOtherAuthors: boolean; through: string; activityVersion: string }
      }>()
      const note = deferred<ReturnType<typeof groups>>()

      harness.api.activityGroupsGet.mockImplementation(
        (_space: string, params: { by: ActivityGroup }) =>
          params.by === 'folder' ? folder.promise : note.promise,
      )
      harness.api.activityEventsGet.mockReturnValue(none.promise)
      chromeHistory = []

      for (const next of ['folder', 'none', 'note'] as const) {
        group = next
        act(() => root.render(createElement(App)))
        await settle()
        expect(chrome).toMatchObject({ canScope: true, scope: selectedScope })
      }

      none.resolve({
        events: [],
        total: 0,
        through: '30',
        activityVersion: 'activity-v3',
        nextCursor: null,
        scopeGate: { hasOtherAuthors: false, through: '30', activityVersion: 'activity-v3' },
      })
      folder.resolve(
        groups('stale folder', false, {
          through: '20',
          activityVersion: 'activity-v2',
          locationThrough: 'location-2',
        }),
      )
      await settle()

      expect(state.group).toBe('note')
      expect(chrome).toMatchObject({ canScope: true, scope: selectedScope })

      note.resolve(
        groups('current note', true, {
          through: '40',
          activityVersion: 'activity-v4',
          locationThrough: 'location-4',
        }),
      )
      await settle()

      expect(state.group).toBe('note')
      expect(state.overview).toMatchObject({ response: { label: 'current note' } })
      expect(chromeHistory).not.toHaveLength(0)
      expect(
        chromeHistory.every((sample) => sample.canScope && sample.scope === selectedScope),
      ).toBe(true)
    },
  )

  it('retains warm Mine only when every applicable gate cut is still exact', async () => {
    let failing = false

    harness.api.activityGroupsGet.mockImplementation(
      (_space: string, params: { author?: 'mine' }) => {
        if (params.author && failing) {
          return Promise.reject(new Error('temporary Mine failure'))
        }

        return Promise.resolve(params.author ? mineGroups('warm mine') : groups('all', true))
      },
    )
    scope = 'mine'
    act(() => root.render(createElement(App)))
    await settle()
    failing = true

    act(() => state.retry())
    await settle()

    expect(state.overview).toMatchObject({ response: { label: 'warm mine' } })
    expect(state.stale).toBe(true)
    expect(state.error).toBe('temporary Mine failure')
  })

  it.each([
    [
      'source cut',
      { through: '11', activityVersion: 'activity-v1', locationThrough: 'location-1' },
    ],
    [
      'Activity lease',
      { through: '10', activityVersion: 'activity-v2', locationThrough: 'location-1' },
    ],
    [
      'location cut',
      { through: '10', activityVersion: 'activity-v1', locationThrough: 'location-2' },
    ],
  ])('does not publish a previous Mine overview against a different %s', async (_, nextCut) => {
    let next = false

    harness.api.activityGroupsGet.mockImplementation(
      (_space: string, params: { author?: 'mine' }) => {
        if (!next) {
          return Promise.resolve(params.author ? mineGroups('warm mine') : groups('all', true))
        }
        if (params.author) {
          return Promise.reject(new Error('temporary Mine failure'))
        }

        return Promise.resolve(groups('new all', true, nextCut))
      },
    )
    scope = 'mine'
    act(() => root.render(createElement(App)))
    await settle()
    next = true

    act(() => state.retry())
    await settle()

    expect(state.gate).toEqual({
      through: nextCut.through,
      activityVersion: nextCut.activityVersion,
      locationThrough: nextCut.locationThrough,
    })
    expect(state.overview).toBeNull()
    expect(state.stale).toBe(false)
    expect(state.error).toBe('temporary Mine failure')
  })

  it('clears a warm standing slice while the Activity projection rebuilds', async () => {
    let rebuilding = false
    const error = new ApiError('projection unavailable')

    error.reason = 'activity_projection_rebuilding'
    harness.api.activityGroupsGet.mockImplementation(() =>
      rebuilding ? Promise.reject(error) : Promise.resolve(groups('warm all', true)),
    )
    act(() => root.render(createElement(App)))
    await settle()
    expect(state.overview).toMatchObject({ response: { label: 'warm all' } })
    expect(state.rebuilding).toBe(false)
    rebuilding = true

    act(() => state.retry())
    await settle()

    expect(state.overview).toBeNull()
    expect(state.gate).toBeNull()
    expect(state.gateResolved).toBe(false)
    expect(state.loading).toBe(true)
    expect(state.invalidated).toBe(true)
    expect(state.rebuilding).toBe(true)
    expect(state.stale).toBe(false)
    expect(state.error).toBe('Rebuilding activity summary…')
  })

  it('keeps a typed rebuilding boundary while another Group request is pending', async () => {
    const projectionError = new ApiError('projection unavailable')

    projectionError.reason = 'activity_projection_rebuilding'
    let rebuilding = false

    harness.api.activityGroupsGet.mockImplementation((_space: string, params: { by: string }) => {
      if (!rebuilding) {
        return Promise.resolve(groups('warm all', true))
      }

      return params.by === 'note'
        ? Promise.reject(projectionError)
        : new Promise<ReturnType<typeof groups>>(() => undefined)
    })
    act(() => root.render(createElement(App)))
    await settle()
    rebuilding = true

    act(() => state.retry())
    await settle()
    expect(state.rebuilding).toBe(true)

    group = 'folder'
    act(() => root.render(createElement(App)))
    await settle()

    expect(state.group).toBe('folder')
    expect(state.rebuilding).toBe(true)
    expect(state.invalidated).toBe(true)
    expect(state.overview).toBeNull()
    expect(chrome).toMatchObject({ committed: true, canScope: true })
  })

  it('immediately invalidates a standing lease promoted by a day/detail failure', async () => {
    const replacement = deferred<ReturnType<typeof groups>>()
    let recovering = false

    harness.api.activityGroupsGet.mockImplementation(() =>
      recovering ? replacement.promise : Promise.resolve(groups('warm all', true)),
    )
    act(() => root.render(createElement(App)))
    await settle()
    expect(state.overview).toMatchObject({ response: { label: 'warm all' } })
    recovering = true

    act(() => state.recover(false))
    await settle()

    expect(state.invalidated).toBe(true)
    expect(state.rebuilding).toBe(false)
    expect(state.overview).toBeNull()
    expect(state.gateResolved).toBe(false)

    replacement.resolve(
      groups('replacement all', true, {
        through: '20',
        activityVersion: 'activity-v2',
        locationThrough: 'location-2',
      }),
    )
    await settle()

    expect(state.invalidated).toBe(false)
    expect(state.overview).toMatchObject({ response: { label: 'replacement all' } })
  })

  it('keeps recovery fail-closed when replacement All succeeds but Mine fails', async () => {
    let recovering = false

    scope = 'mine'
    harness.api.activityGroupsGet.mockImplementation(
      (_space: string, params: { author?: 'mine' }) => {
        if (!recovering) {
          return Promise.resolve(params.author ? mineGroups('warm mine') : groups('warm all', true))
        }
        const cut = {
          through: '20',
          activityVersion: 'activity-v2',
          locationThrough: 'location-2',
        }

        return params.author
          ? Promise.reject(new Error('replacement Mine failed'))
          : Promise.resolve(groups('replacement all', true, cut))
      },
    )
    act(() => root.render(createElement(App)))
    await settle()
    recovering = true

    act(() => state.recover(false))
    await settle()

    expect(state.gateResolved).toBe(true)
    expect(state.overview).toBeNull()
    expect(state.invalidated).toBe(true)
    expect(state.loading).toBe(true)
    expect(state.error).toBe('replacement Mine failed')
  })

  it('keeps recovery fail-closed when unscoped standing omits its gate', async () => {
    let recovering = false

    harness.api.activityGroupsGet.mockImplementation(() =>
      Promise.resolve(
        recovering
          ? mineGroups('missing gate', {
              through: '20',
              activityVersion: 'activity-v2',
              locationThrough: 'location-2',
            })
          : groups('warm all', true),
      ),
    )
    act(() => root.render(createElement(App)))
    await settle()
    recovering = true

    act(() => state.recover(false))
    await settle()

    expect(state.gateResolved).toBe(false)
    expect(state.overview).toBeNull()
    expect(state.invalidated).toBe(true)
    expect(state.error).toBe('Activity scope snapshot was not returned')
  })

  it('lets None own its gate and refetches Mine without a note id', async () => {
    group = 'none'
    scope = 'mine'
    harness.api.activityEventsGet.mockImplementation(
      (_space: string, params: { author?: 'mine'; through?: string }) =>
        Promise.resolve(
          params.author
            ? {
                events: [],
                total: 0,
                through: params.through ?? '9',
                activityVersion: 'activity-v1',
                nextCursor: null,
              }
            : {
                events: [],
                total: 0,
                through: '10',
                activityVersion: 'activity-v1',
                nextCursor: null,
                scopeGate: {
                  hasOtherAuthors: true,
                  through: '10',
                  activityVersion: 'activity-v1',
                },
              },
        ),
    )
    act(() => root.render(createElement(App)))
    await settle()

    expect(harness.api.activityGroupsGet).not.toHaveBeenCalled()
    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(3)
    expect(harness.api.activityEventsGet).toHaveBeenLastCalledWith(
      'work',
      expect.objectContaining({
        author: 'mine',
        through: '10',
        activityVersion: 'activity-v1',
      }),
    )
    expect(harness.api.activityEventsGet.mock.calls.at(-1)?.[1]).not.toHaveProperty('noteId')
    expect(state.scope).toBe('mine')
  })
})
