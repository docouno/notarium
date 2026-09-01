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
vi.mock('react-router', async () => {
  const { createElement: h } = await import('react')

  return {
    Link: (props: { to: string; children?: unknown; className?: string }) =>
      h('a', { href: props.to, className: props.className }, props.children as never),
  }
})

import {
  activityChurnText,
  ActivityFeed,
  activityFolderGroupLabel,
  activityLocationIdentity,
} from './ActivityFeed'
import type { ActivityOverview } from './useDashboardActivityFeed'
import styles from './Dashboard.module.scss'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

const event = (noteId: string, title: string, revisionId: string) => ({
  revisionId,
  noteId,
  kind: 'edited' as const,
  at: '2026-08-30T12:00:00.000Z',
  title,
  path: '',
  principal: 'user:viewer',
  author: { kind: 'user' as const, name: 'User', mine: true },
  charsAdded: 1,
  charsRemoved: 0,
})

const folderOverview = (
  through: string,
  activityVersion: string,
  locationThrough = 'location-1',
): ActivityOverview => ({
  kind: 'groups',
  response: {
    itemType: 'folder',
    items: [
      {
        type: 'folder',
        location: { kind: 'root' },
        noteCount: 1,
        eventCount: '1',
        charsAdded: '1',
        charsRemoved: '0',
        lastAt: '2026-08-30T12:00:00.000Z',
      },
    ],
    total: 1,
    through,
    activityVersion,
    locationThrough,
    nextCursor: null,
  },
})

const folderDetail = (
  through: string,
  activityVersion: string,
  noteId: string,
  title: string,
  locationThrough = 'location-1',
  nextCursor: string | null = null,
): Extract<ActivityGroupsResponse, { itemType: 'note' }> => ({
  itemType: 'note',
  items: [
    {
      type: 'note',
      noteId,
      title,
      location: { kind: 'root' },
      count: '1',
      charsAdded: '1',
      charsRemoved: '0',
      lastEvent: event(noteId, title, through),
    },
  ],
  total: 1,
  through,
  activityVersion,
  locationThrough,
  nextCursor,
})

const noteOverview = (through: string, activityVersion: string): ActivityOverview => ({
  kind: 'groups',
  response: folderDetail(through, activityVersion, 'note-1', 'Grouped note'),
})

const eventDetail = (through: string, activityVersion: string, title: string) => ({
  events: [event('note-1', title, through)],
  total: 1,
  through,
  activityVersion,
  nextCursor: null,
})

describe('ActivityFeed grouped branches', () => {
  let container: HTMLDivElement
  let root: Root
  let onRetry: ReturnType<typeof vi.fn>
  let onSnapshotRecovery: ReturnType<typeof vi.fn>
  let onDayRetry: ReturnType<typeof vi.fn>

  const render = (
    overview: ActivityOverview | null,
    overrides: Partial<Parameters<typeof ActivityFeed>[0]> = {},
  ) => {
    act(() =>
      root.render(
        createElement(ActivityFeed, {
          space: 'work',
          overview,
          loading: false,
          error: null,
          stale: false,
          onRetry,
          onSnapshotRecovery,
          group: 'folder',
          onGroupChange: vi.fn(),
          scope: 'all',
          day: null,
          dayOverview: null,
          dayError: null,
          onDayRetry,
          onClearDay: vi.fn(),
          onOpen: vi.fn(),
          ...overrides,
        }),
      ),
    )
  }

  const settle = async () => {
    await act(async () => {
      for (let turn = 0; turn < 5; turn++) {
        await Promise.resolve()
      }
    })
  }

  beforeEach(() => {
    harness.api.activityEventsGet.mockReset()
    harness.api.activityGroupsGet.mockReset()
    onRetry = vi.fn()
    onSnapshotRecovery = vi.fn()
    onDayRetry = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps structural root/unavailable identities distinct from literal folder names', () => {
    expect(activityLocationIdentity({ kind: 'root' })).not.toBe(
      activityLocationIdentity({ kind: 'folder', path: 'Workspace root' }),
    )
    expect(activityLocationIdentity({ kind: 'unavailable' })).not.toBe(
      activityLocationIdentity({ kind: 'folder', path: 'No current folder' }),
    )
    expect(activityFolderGroupLabel({ kind: 'root' })).not.toBe(
      activityFolderGroupLabel({ kind: 'folder', path: 'Workspace root' }),
    )
    expect(activityFolderGroupLabel({ kind: 'unavailable' })).not.toBe(
      activityFolderGroupLabel({ kind: 'folder', path: 'No current folder' }),
    )
  })

  it('renders only the churn axes whose values are known', () => {
    expect(activityChurnText(null, null)).toBeNull()
    expect(activityChurnText('5', null)).toBe('+5')
    expect(activityChurnText(null, '3')).toBe('−3')
    expect(activityChurnText('0', '0')).toBe('+0 −0')
  })

  it('uses the exact raw Activity title treatment for grouped note links', () => {
    render(noteOverview('10', 'activity-v1'), { group: 'note' })

    const grouped = container.querySelector<HTMLAnchorElement>('a[data-id="note-1"]')

    expect(grouped).not.toBeNull()
    expect(grouped!.classList.contains(styles.eventTitle)).toBe(true)
    const groupedClassName = grouped!.className

    render(
      {
        kind: 'events',
        response: {
          events: [event('note-raw', 'Raw note', 'revision-raw')],
          total: 1,
          through: '10',
          activityVersion: 'activity-v1',
          nextCursor: null,
        },
      },
      { group: 'none' },
    )
    const raw = container.querySelector<HTMLAnchorElement>('a[data-id="note-raw"]')

    expect(raw).not.toBeNull()
    expect(groupedClassName).toBe(raw!.className)
  })

  it('ignores a late folder response from the previous Activity lease', async () => {
    const first = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()
    const second = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()
    harness.api.activityGroupsGet
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    render(folderOverview('10', 'activity-v1'))
    await settle()
    const disclosure = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Expand notes in Workspace root'),
    )

    expect(disclosure).toBeDefined()
    act(() => disclosure!.click())
    await settle()
    render(folderOverview('11', 'activity-v2'))
    await settle()
    expect(harness.api.activityGroupsGet).toHaveBeenCalledTimes(2)

    second.resolve(folderDetail('11', 'activity-v2', 'note-current', 'Current note'))
    await settle()
    first.resolve(folderDetail('10', 'activity-v1', 'note-stale', 'Stale note'))
    await settle()

    expect(container.textContent).toContain('Current note')
    expect(container.textContent).not.toContain('Stale note')
  })

  it.each([
    'activity_location_stale',
    'activity_projection_stale',
    'activity_projection_rebuilding',
  ] as const)(
    'promotes a typed current %s detail failure to standing snapshot recovery',
    async (reason) => {
      const stale = new ApiError('location cut changed')

      stale.reason = reason
      harness.api.activityGroupsGet.mockRejectedValue(stale)
      render(folderOverview('10', 'activity-v1'))
      await settle()
      const disclosure = [...container.querySelectorAll('button')].find((button) =>
        button.getAttribute('aria-label')?.startsWith('Expand notes in Workspace root'),
      )

      act(() => disclosure!.click())
      await settle()

      expect(onRetry).not.toHaveBeenCalled()
      expect(onSnapshotRecovery).toHaveBeenCalledWith(reason === 'activity_projection_rebuilding')
      expect(onDayRetry).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('location cut changed')
    },
  )

  it('routes a rebuilding detail through recovery of the active day overview', async () => {
    const stale = new ApiError('projection rebuilding')

    stale.reason = 'activity_projection_rebuilding'
    harness.api.activityGroupsGet.mockRejectedValue(stale)
    const overview = folderOverview('10', 'activity-v1')

    render(overview, { day: '2026-08-30', dayOverview: overview })
    await settle()
    const disclosure = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Expand notes in Workspace root'),
    )

    act(() => disclosure!.click())
    await settle()

    expect(onDayRetry).toHaveBeenCalledOnce()
    expect(onSnapshotRecovery).toHaveBeenCalledWith(true)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('promotes a typed note-event detail failure to standing snapshot recovery', async () => {
    const stale = new ApiError('event lease changed')

    stale.reason = 'activity_projection_stale'
    harness.api.activityEventsGet.mockRejectedValue(stale)
    render(noteOverview('10', 'activity-v1'), { group: 'note' })
    await settle()
    const disclosure = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Expand changes for Grouped note'),
    )

    act(() => disclosure!.click())
    await settle()

    expect(onSnapshotRecovery).toHaveBeenCalledWith(false)
    expect(onRetry).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('event lease changed')
  })

  it('keeps a generic detail failure local to its branch', async () => {
    harness.api.activityGroupsGet.mockRejectedValue(new Error('network detail failure'))
    render(folderOverview('10', 'activity-v1'))
    await settle()
    const disclosure = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Expand notes in Workspace root'),
    )

    act(() => disclosure!.click())
    await settle()

    expect(onRetry).not.toHaveBeenCalled()
    expect(container.textContent).toContain('network detail failure')
  })

  it('keeps an exact warm detail visible when a generic pagination request fails', async () => {
    harness.api.activityGroupsGet
      .mockResolvedValueOnce(
        folderDetail('10', 'activity-v1', 'note-warm', 'Warm detail', 'location-1', 'next-page'),
      )
      .mockRejectedValueOnce(new Error('temporary page failure'))
    render(folderOverview('10', 'activity-v1'))
    await settle()
    const disclosure = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Expand notes in Workspace root'),
    )

    act(() => disclosure!.click())
    await settle()
    const loadOlder = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load older notes',
    )

    act(() => loadOlder!.click())
    await settle()

    expect(onRetry).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Warm detail')
    expect(container.textContent).toContain('temporary page failure')
  })

  it('does not call a cold standing failure an empty Activity feed', () => {
    render(null, { group: 'note', error: 'standing request failed' })

    expect(container.textContent).toContain('standing request failed')
    expect(container.textContent).not.toContain('No activity yet')
    expect(container.querySelector(`.${styles.feedEmpty}`)?.textContent).toBe('')
  })

  it('does not call a failed day request an empty day', () => {
    render(noteOverview('10', 'activity-v1'), {
      group: 'note',
      day: '2026-08-30',
      dayOverview: null,
      dayError: 'day request failed',
    })

    expect(container.textContent).toContain('day request failed')
    expect(container.textContent).not.toContain('Nothing changed this day')
    expect(container.querySelector(`.${styles.feedEmpty}`)?.textContent).toBe('')
  })

  it.each([
    ['source cut', folderDetail('11', 'activity-v1', 'note-newer', 'Newer note', 'location-1')],
    [
      'Activity version',
      folderDetail('10', 'activity-v2', 'note-newer', 'Newer note', 'location-1'),
    ],
    ['location cut', folderDetail('10', 'activity-v1', 'note-newer', 'Newer note', 'location-2')],
  ])('promotes a successful response with a different %s to snapshot recovery', async (_, page) => {
    harness.api.activityGroupsGet.mockResolvedValue(page)
    render(folderOverview('10', 'activity-v1'))
    await settle()
    const disclosure = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Expand notes in Workspace root'),
    )

    act(() => disclosure!.click())
    await settle()

    expect(onSnapshotRecovery).toHaveBeenCalledWith(false)
    expect(onRetry).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Newer note')
  })

  it('hides an old detail branch as soon as its parent cut changes', async () => {
    const replacement = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()

    harness.api.activityGroupsGet
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-old', 'Old detail'))
      .mockReturnValueOnce(replacement.promise)
    render(folderOverview('10', 'activity-v1'))
    await settle()
    const disclosure = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Expand notes in Workspace root'),
    )

    act(() => disclosure!.click())
    await settle()
    expect(container.textContent).toContain('Old detail')

    render(folderOverview('10', 'activity-v1', 'location-2'))

    expect(container.textContent).not.toContain('Old detail')
    expect(container.textContent).toContain('Loading…')

    replacement.resolve(folderDetail('10', 'activity-v1', 'note-new', 'New detail', 'location-2'))
    await settle()
    expect(container.textContent).toContain('New detail')
  })

  it('reloads a collapsed Note detail whose parent source cut advanced', async () => {
    harness.api.activityEventsGet
      .mockResolvedValueOnce(eventDetail('10', 'activity-v1', 'Old event'))
      .mockResolvedValueOnce(eventDetail('11', 'activity-v1', 'Current event'))
    render(noteOverview('10', 'activity-v1'), { group: 'note' })
    await settle()
    const expand = () =>
      [...container.querySelectorAll('button')].find((button) =>
        button.getAttribute('aria-label')?.startsWith('Expand changes for Grouped note'),
      )

    act(() => expand()!.click())
    await settle()
    expect(container.textContent).toContain('Old event')
    const collapse = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Collapse changes for Grouped note'),
    )

    act(() => collapse!.click())
    render(noteOverview('11', 'activity-v1'), { group: 'note' })
    await settle()
    act(() => expand()!.click())
    await settle()

    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Current event')
    expect(container.textContent).not.toContain('Old event')
  })

  it('reloads a collapsed Folder detail whose parent source cut advanced', async () => {
    harness.api.activityGroupsGet
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-old', 'Old folder detail'))
      .mockResolvedValueOnce(
        folderDetail('11', 'activity-v1', 'note-current', 'Current folder detail'),
      )
    render(folderOverview('10', 'activity-v1'))
    await settle()
    const expand = () =>
      [...container.querySelectorAll('button')].find((button) =>
        button.getAttribute('aria-label')?.startsWith('Expand notes in Workspace root'),
      )

    act(() => expand()!.click())
    await settle()
    expect(container.textContent).toContain('Old folder detail')
    const collapse = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Collapse notes in Workspace root'),
    )

    act(() => collapse!.click())
    render(folderOverview('11', 'activity-v1'))
    await settle()
    act(() => expand()!.click())
    await settle()

    expect(harness.api.activityGroupsGet).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Current folder detail')
    expect(container.textContent).not.toContain('Old folder detail')
  })

  it('ignores a delayed typed stale failure from a superseded cut', async () => {
    const first = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()
    const second = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()

    harness.api.activityGroupsGet
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    render(folderOverview('10', 'activity-v1'))
    await settle()
    const disclosure = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Expand notes in Workspace root'),
    )

    act(() => disclosure!.click())
    await settle()
    render(folderOverview('11', 'activity-v2'))
    await settle()
    second.resolve(folderDetail('11', 'activity-v2', 'note-current', 'Current detail'))
    await settle()

    const stale = new ApiError('old location cut')

    stale.reason = 'activity_location_stale'
    first.reject(stale)
    await settle()

    expect(onRetry).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Current detail')
    expect(container.textContent).not.toContain('old location cut')
  })
})
