// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityGroupsResponse } from '@notarium/contract'
import { ApiError } from '../../services/api/client'

const harness = vi.hoisted(() => ({
  api: {
    activityEventsGet: vi.fn(),
    activityGroupsGet: vi.fn(),
  },
}))

vi.mock('../../services/api', () => ({ api: harness.api }))

import type { ActivityGroup } from './activityPreferences'
import type { ActivityFeedGate } from './useDashboardActivityFeed'
import type { ActivityScope } from './useDashboardData'
import { useDashboardDayActivity } from './useDashboardDayActivity'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const dayGroups = (total: number, itemType: 'note' | 'folder' = 'note'): ActivityGroupsResponse =>
  ({
    itemType,
    items: [],
    total,
    through: String(total),
    activityVersion: `activity-v${total}`,
    locationThrough: `location-${total}`,
    nextCursor: null,
  }) as ActivityGroupsResponse

describe('useDashboardDayActivity', () => {
  let container: HTMLDivElement
  let root: Root
  let state!: ReturnType<typeof useDashboardDayActivity>
  let props: {
    space: string
    scope: ActivityScope
    group: ActivityGroup
    day: string | null
    gate: ActivityFeedGate | null
    tz: number
    onSnapshotRecovery: ReturnType<typeof vi.fn>
  }

  const App = () => {
    state = useDashboardDayActivity(props)
    return null
  }

  const render = () => act(() => root.render(createElement(App)))

  const settle = async () => {
    await act(async () => {
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve()
      }
    })
  }

  beforeEach(() => {
    harness.api.activityEventsGet.mockReset()
    harness.api.activityGroupsGet.mockReset()
    props = {
      space: 'alpha',
      scope: 'all',
      group: 'note',
      day: '2026-08-30',
      gate: { through: '10', activityVersion: 'gate-v1', locationThrough: 'location-1' },
      tz: 0,
      onSnapshotRecovery: vi.fn(),
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('never publishes a day result under another space, scope, group, day, or gate cut', async () => {
    const pending: Array<ReturnType<typeof deferred<ActivityGroupsResponse>>> = []

    harness.api.activityGroupsGet.mockImplementation(() => pending.shift()!.promise)
    const load = async (response: ActivityGroupsResponse) => {
      const request = deferred<ActivityGroupsResponse>()

      pending.push(request)
      render()
      await settle()
      expect(state.overview).toBeNull()
      request.resolve(response)
      await settle()
      expect(state.overview?.response.total).toBe(response.total)
    }

    await load(dayGroups(1))

    props = { ...props, space: 'beta' }
    await load(dayGroups(2))

    props = { ...props, scope: 'mine' }
    await load(dayGroups(3))
    expect(harness.api.activityGroupsGet).toHaveBeenLastCalledWith(
      'beta',
      expect.objectContaining({ author: 'mine', by: 'note' }),
    )

    props = { ...props, group: 'folder' }
    await load(dayGroups(4, 'folder'))

    props = { ...props, day: '2026-08-29' }
    await load(dayGroups(5, 'folder'))

    props = {
      ...props,
      gate: { through: '11', activityVersion: 'gate-v2', locationThrough: 'location-6' },
    }
    await load(dayGroups(6, 'folder'))

    props = {
      ...props,
      gate: { ...props.gate!, locationThrough: 'location-7' },
    }
    await load(dayGroups(7, 'folder'))

    expect(harness.api.activityGroupsGet).toHaveBeenCalledTimes(7)
  })

  it('ignores a late response after the identity moves to another Space', async () => {
    const oldRequest = deferred<ActivityGroupsResponse>()
    const currentRequest = deferred<ActivityGroupsResponse>()

    harness.api.activityGroupsGet
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
    render()
    await settle()

    props = { ...props, space: 'beta' }
    render()
    await settle()
    oldRequest.resolve(dayGroups(1))
    await settle()

    expect(state.overview).toBeNull()

    currentRequest.resolve(dayGroups(2))
    await settle()
    expect(state.overview?.response.total).toBe(2)
  })

  it('invalidates the visible result and in-flight lane before retrying', async () => {
    const first = deferred<ActivityGroupsResponse>()
    const retry = deferred<ActivityGroupsResponse>()

    harness.api.activityGroupsGet
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retry.promise)
    render()
    await settle()
    first.resolve(dayGroups(1))
    await settle()
    expect(state.overview?.response.total).toBe(1)

    act(() => state.retry())
    expect(state.overview).toBeNull()
    await settle()

    retry.resolve(dayGroups(2))
    await settle()
    expect(state.overview?.response.total).toBe(2)
  })

  it.each([
    ['activity_projection_stale', false],
    ['activity_projection_rebuilding', true],
  ] as const)('preserves typed %s as a standing recovery signal', async (reason, rebuilding) => {
    const error = new ApiError('projection changed')

    error.reason = reason
    harness.api.activityGroupsGet.mockRejectedValue(error)
    render()
    await settle()

    expect(state.overview).toBeNull()
    expect(state.error).toBe('projection changed')
    expect(state.recovery).toEqual({ requestSequence: 1, rebuilding })
    expect(props.onSnapshotRecovery).toHaveBeenCalledOnce()
    expect(props.onSnapshotRecovery).toHaveBeenCalledWith(rebuilding)
  })

  it('keeps a generic day failure local to the day lane', async () => {
    harness.api.activityGroupsGet.mockRejectedValue(new Error('temporary failure'))
    render()
    await settle()

    expect(state.error).toBe('temporary failure')
    expect(state.recovery).toBeNull()
    expect(props.onSnapshotRecovery).not.toHaveBeenCalled()
  })
})
