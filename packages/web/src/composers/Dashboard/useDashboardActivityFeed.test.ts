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

import { STORE_EVENT } from '@notarium/contract/events'
import { activityFeedBusy } from './ActivityFeed'
import {
  type ActivityGroup,
  type ActivityScopeChrome,
  activityScopeChrome,
} from './activityPreferences'
import {
  type DashboardActivityFeed,
  REBUILD_NOTICE_DELAY_MS,
  useDashboardActivityFeed,
} from './useDashboardActivityFeed'
import type { ActivityScope } from './useDashboardData'
import { useDashboardDayActivity } from './useDashboardDayActivity'

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
  let day: string

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

  // The standing feed and an open day composed the way ActivitySurface wires them:
  // the day reads the feed's resolved gate and the scope the data belongs to.
  let dayState!: ReturnType<typeof useDashboardDayActivity>

  const DayApp = () => {
    state = useDashboardActivityFeed(space, group, scope)
    dayState = useDashboardDayActivity({
      space,
      scope: state.scope,
      group,
      day,
      gate: state.gateResolved ? state.gate : null,
      tz: 0,
      onSnapshotRecovery: state.recover,
    })

    return null
  }

  const standingSkeleton = () =>
    activityFeedBusy(state.overview, state.error, state.invalidated, null, null, null)

  // The drill half of the same predicate, composed exactly as ActivitySurface wires
  // it: the open day's own two fields decide, the standing ones do not.
  const drillSkeleton = () =>
    activityFeedBusy(
      state.overview,
      state.error,
      state.invalidated,
      day,
      dayState.overview,
      dayState.error,
    )

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
    day = '2026-08-30'
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
    expect(state.error).toBeNull()
    expect(standingSkeleton()).toBe(true)
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

  it('returns to the skeleton tuple on a Group switch', async () => {
    const folder = deferred<ReturnType<typeof groups>>()

    harness.api.activityGroupsGet.mockImplementation(
      (_space: string, params: { by: ActivityGroup }) =>
        params.by === 'folder' ? folder.promise : Promise.resolve(groups('note rows', true)),
    )
    act(() => root.render(createElement(App)))
    await settle()
    expect(state.overview).toMatchObject({ response: { label: 'note rows' } })

    group = 'folder'
    act(() => root.render(createElement(App)))
    await settle()

    expect(state.overview).toBeNull()
    expect(state.error).toBeNull()
    expect(state.invalidated).toBe(false)
    expect(standingSkeleton()).toBe(true)
  })

  it('resets the slice in the click frame when the preferred scope changes', async () => {
    const mine = deferred<ReturnType<typeof mineGroups>>()

    harness.api.activityGroupsGet.mockImplementation(
      (_space: string, params: { author?: 'mine' }) =>
        params.author ? mine.promise : Promise.resolve(groups('all rows', true)),
    )
    act(() => root.render(createElement(App)))
    await settle()
    expect(state.overview).toMatchObject({ response: { label: 'all rows' } })

    scope = 'mine'
    act(() => root.render(createElement(App)))

    expect(state.overview).toBeNull()
    expect(state.gateResolved).toBe(false)
    expect(state.error).toBeNull()
    expect(standingSkeleton()).toBe(true)
    // The toggle cannot vanish in the reset window: an unresolved gate retains the
    // previous chrome by identity.
    expect(chrome).toMatchObject({ committed: true, canScope: true })

    await settle()
    mine.resolve(mineGroups('mine rows'))
    await settle()

    expect(state.scope).toBe('mine')
    expect(state.overview).toMatchObject({ response: { label: 'mine rows' } })
  })

  it('keeps the rebuild and invalidation latches across a preferred-scope change', async () => {
    const error = new ApiError('projection unavailable')

    error.reason = 'activity_projection_rebuilding'
    harness.api.activityGroupsGet.mockRejectedValue(error)
    act(() => root.render(createElement(App)))
    await settle()
    expect(state.rebuilding).toBe(true)

    scope = 'mine'
    act(() => root.render(createElement(App)))

    expect(state.rebuilding).toBe(true)
    expect(state.invalidated).toBe(true)
    expect(state.overview).toBeNull()
    await settle()
  })

  it.each([
    ['Everyone → Mine', 'all', 'mine'],
    ['Mine → Everyone', 'mine', 'all'],
  ] as const)(
    'never republishes the previous scope after a transient failure on the flip (%s)',
    async (_, from, to) => {
      let flipped = false

      harness.api.activityGroupsGet.mockImplementation(
        (_space: string, params: { author?: 'mine' }) => {
          if (!flipped) {
            return Promise.resolve(
              params.author ? mineGroups('mine rows') : groups('all rows', true),
            )
          }
          if (to === 'mine') {
            return params.author
              ? Promise.reject(new Error('flip failure'))
              : Promise.resolve(groups('all rows', true))
          }

          return Promise.reject(new Error('flip failure'))
        },
      )
      scope = from
      act(() => root.render(createElement(App)))
      await settle()
      expect(state.overview).toMatchObject({
        response: { label: from === 'mine' ? 'mine rows' : 'all rows' },
      })
      flipped = true

      scope = to
      act(() => root.render(createElement(App)))
      await settle()

      expect(state.overview).toBeNull()
      expect(state.stale).toBe(false)
      expect(state.error).toBe('flip failure')
    },
  )

  it('closes the day gate on a scope flip and never requests the day under the old gate', async () => {
    harness.api.activityGroupsGet.mockImplementation(
      (_space: string, params: { author?: 'mine'; from?: string }) => {
        if (params.from) {
          return Promise.resolve(mineGroups(`day ${params.author ?? 'all'}`))
        }

        return Promise.resolve(params.author ? mineGroups('mine rows') : groups('all rows', true))
      },
    )
    act(() => root.render(createElement(DayApp)))
    await settle()
    expect(dayState.overview).toMatchObject({ response: { label: 'day all' } })
    const dayRequestsBefore = harness.api.activityGroupsGet.mock.calls.filter(
      ([, params]) => (params as { from?: string }).from,
    ).length

    scope = 'mine'
    act(() => root.render(createElement(DayApp)))

    expect(dayState.overview).toBeNull()
    await settle()

    expect(dayState.overview).toMatchObject({ response: { label: 'day mine' } })
    const dayRequestsAfter = harness.api.activityGroupsGet.mock.calls
      .filter(([, params]) => (params as { from?: string }).from)
      .slice(dayRequestsBefore)

    expect(dayRequestsAfter).toHaveLength(1)
    expect(dayRequestsAfter[0]?.[1]).toMatchObject({ author: 'mine' })
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
    expect(state.rebuildingProlonged).toBe(false)
    expect(state.stale).toBe(false)
    expect(state.error).toBeNull()
    expect(standingSkeleton()).toBe(true)
  })

  it('keeps a generic failure an error with a working retry', async () => {
    harness.api.activityGroupsGet.mockRejectedValue(new Error('server failure'))
    act(() => root.render(createElement(App)))
    await settle()

    expect(state.error).toBe('server failure')
    expect(state.rebuilding).toBe(false)
    expect(state.invalidated).toBe(false)
    expect(standingSkeleton()).toBe(false)

    harness.api.activityGroupsGet.mockResolvedValue(groups('recovered', true))
    act(() => state.retry())
    await settle()

    expect(state.error).toBeNull()
    expect(state.overview).toMatchObject({ response: { label: 'recovered' } })
  })

  it('lands a rebuild discovered by the day lane on the bit, not on the error channel', async () => {
    harness.api.activityGroupsGet.mockResolvedValue(groups('warm all', true))
    act(() => root.render(createElement(App)))
    await settle()
    harness.api.activityGroupsGet.mockImplementation(
      () => new Promise<ReturnType<typeof groups>>(() => undefined),
    )

    act(() => state.recover(true))

    expect(state.rebuilding).toBe(true)
    expect(state.invalidated).toBe(true)
    expect(state.error).toBeNull()
    expect(state.overview).toBeNull()
    expect(standingSkeleton()).toBe(true)
  })

  it('explains a rebuild only after the threshold and never re-arms it on a coalesced reload', async () => {
    vi.useFakeTimers()
    try {
      const error = new ApiError('projection unavailable')

      error.reason = 'activity_projection_rebuilding'
      harness.api.activityGroupsGet.mockRejectedValue(error)
      act(() => root.render(createElement(App)))
      await settle()
      expect(state.rebuilding).toBe(true)
      expect(state.error).toBeNull()
      expect(state.rebuildingProlonged).toBe(false)
      const requestsAfterFirst = harness.api.activityGroupsGet.mock.calls.length
      const changed = () =>
        act(() => {
          for (const listener of harness.listeners) {
            listener({ type: STORE_EVENT.CHANGED })
          }
        })

      act(() => vi.advanceTimersByTime(REBUILD_NOTICE_DELAY_MS - 1))
      expect(state.rebuildingProlonged).toBe(false)
      act(() => vi.advanceTimersByTime(1))
      expect(state.rebuildingProlonged).toBe(true)
      // The waiting window issued no request of its own: no polling.
      expect(harness.api.activityGroupsGet.mock.calls.length).toBe(requestsAfterFirst)

      // A coalesced `changed` frame during the rebuild reloads — and rebuilds
      // again. The episode is the same one: the notice stays, nothing re-arms.
      changed()
      act(() => vi.advanceTimersByTime(1))
      await settle()
      expect(harness.api.activityGroupsGet.mock.calls.length).toBe(requestsAfterFirst + 1)
      expect(state.rebuilding).toBe(true)
      expect(state.rebuildingProlonged).toBe(true)
      act(() => vi.advanceTimersByTime(REBUILD_NOTICE_DELAY_MS))
      expect(state.rebuildingProlonged).toBe(true)

      // Publication ends the episode; the next one starts its own threshold.
      harness.api.activityGroupsGet.mockResolvedValue(groups('rebuilt', true))
      changed()
      act(() => vi.advanceTimersByTime(1))
      await settle()
      expect(state.rebuilding).toBe(false)
      expect(state.rebuildingProlonged).toBe(false)
      expect(state.overview).toMatchObject({ response: { label: 'rebuilt' } })

      harness.api.activityGroupsGet.mockRejectedValue(error)
      changed()
      act(() => vi.advanceTimersByTime(1))
      await settle()
      expect(state.rebuilding).toBe(true)
      expect(state.rebuildingProlonged).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the open day silent when the day lane is the producer that finds the rebuild', async () => {
    const rebuild = new ApiError('projection unavailable')

    rebuild.reason = 'activity_projection_rebuilding'
    let standingCut = '10'
    let dayRebuilds = false
    let standingCalls = 0

    harness.api.activityGroupsGet.mockImplementation(
      (_space: string, params: { from?: string }) => {
        if (params.from) {
          return dayRebuilds ? Promise.reject(rebuild) : Promise.resolve(mineGroups('day rows'))
        }
        standingCalls++

        // The standing reload triggered by the recovery never settles, so the state
        // under assertion is the one the DAY lane produced — nothing else can have
        // closed the gate or cleared the record on its behalf.
        return standingCalls > 2
          ? new Promise<ReturnType<typeof groups>>(() => undefined)
          : Promise.resolve(groups('standing rows', false, { through: standingCut }))
      },
    )
    act(() => root.render(createElement(DayApp)))
    await settle()
    expect(dayState.overview).toMatchObject({ response: { label: 'day rows' } })
    expect(drillSkeleton()).toBe(false)

    // An ordinary append advances the gate, the day refetches on the soft part of
    // its key, and that refetch is the request that discovers the rebuild.
    dayRebuilds = true
    standingCut = '11'
    act(() => {
      for (const listener of harness.listeners) {
        listener({ type: STORE_EVENT.CHANGED })
      }
    })
    // The subscription coalesces on a real timer, and the chain that follows is
    // standing publish → day refetch → typed failure → recovery → standing reload.
    // Poll the outcome rather than sleeping a fixed span: a fixed wait is a flake on
    // a loaded machine, and the last link of the chain deliberately never resolves.
    for (let turn = 0; turn < 200 && !state.rebuilding; turn++) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 5))
      })
    }
    await settle()

    // Criterion 1, the half no other test composes: the rebuild reaches the drill as
    // a STATE. The day publishes neither an error nor a recovery, so the drill has
    // nothing red to render and no Retry to offer — it is a skeleton with the
    // standing explanation above it.
    expect(state.rebuilding).toBe(true)
    expect(state.error).toBeNull()
    expect(state.gateResolved).toBe(false)
    expect(dayState.error).toBeNull()
    expect(dayState.recovery).toBeNull()
    expect(dayState.overview).toBeNull()
    expect(drillSkeleton()).toBe(true)
  })

  it('draws the drill skeleton across a day change until the new day lands', async () => {
    harness.api.activityGroupsGet.mockImplementation((_space: string, params: { from?: string }) =>
      Promise.resolve(params.from ? mineGroups(`day ${day}`) : groups('standing rows', false)),
    )
    act(() => root.render(createElement(DayApp)))
    await settle()
    expect(dayState.overview).toMatchObject({ response: { label: 'day 2026-08-30' } })
    expect(drillSkeleton()).toBe(false)

    day = '2026-08-31'
    act(() => root.render(createElement(DayApp)))

    // The day is a hard member of the retention key: the previous day's rows are
    // gone in the click frame, and the drill reads as a skeleton — never as the old
    // day's content and never as an empty state.
    expect(dayState.overview).toBeNull()
    expect(dayState.error).toBeNull()
    expect(drillSkeleton()).toBe(true)

    await settle()
    expect(dayState.overview).toMatchObject({ response: { label: 'day 2026-08-31' } })
    expect(drillSkeleton()).toBe(false)
  })

  it('keeps the rebuild latch through an ordinary failure of the next reload', async () => {
    vi.useFakeTimers()
    try {
      const rebuild = new ApiError('projection unavailable')

      rebuild.reason = 'activity_projection_rebuilding'
      harness.api.activityGroupsGet.mockRejectedValue(rebuild)
      act(() => root.render(createElement(App)))
      await settle()
      act(() => vi.advanceTimersByTime(REBUILD_NOTICE_DELAY_MS))
      expect(state.rebuildingProlonged).toBe(true)

      // The projection is still rebuilding; the next reload merely failed for an
      // ordinary reason. The hook keeps both facts — the latch AND the error — and
      // leaves it to the surface to decide which one the reader is shown, because
      // only the surface knows which lane is open (ActivityFeed.test.ts).
      harness.api.activityGroupsGet.mockRejectedValue(new Error('server failure'))
      act(() => {
        for (const listener of harness.listeners) {
          listener({ type: STORE_EVENT.CHANGED })
        }
      })
      act(() => vi.advanceTimersByTime(1))
      await settle()

      expect(state.rebuilding).toBe(true)
      expect(state.error).toBe('server failure')
      expect(state.rebuildingProlonged).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
