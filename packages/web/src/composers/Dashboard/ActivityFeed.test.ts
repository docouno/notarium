// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ActivityFolderGroup,
  ActivityGroupsResponse,
  ActivityLocation,
  ActivityNoteGroup,
} from '@notarium/contract'
import { folderRoute } from '../../libs/routing/routePaths'
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
  activityFeedBusy,
  activityFolderGroupLabel,
  activityLocationIdentity,
  type Branch,
  reconcileBranches,
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
  location: ActivityLocation = { kind: 'root' },
): ActivityOverview => ({
  kind: 'groups',
  response: {
    itemType: 'folder',
    items: [
      {
        type: 'folder',
        location,
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
  location: ActivityLocation = { kind: 'root' },
): Extract<ActivityGroupsResponse, { itemType: 'note' }> => ({
  itemType: 'note',
  items: [
    {
      type: 'note',
      noteId,
      title,
      location,
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

const eventDetail = (
  through: string,
  activityVersion: string,
  title: string,
  nextCursor: string | null = null,
) => ({
  events: [event('note-1', title, through)],
  total: 1,
  through,
  activityVersion,
  nextCursor,
})

const noteGroup = (
  noteId: string,
  title: string,
  revisionId: string,
  count = '1',
): ActivityNoteGroup => ({
  type: 'note',
  noteId,
  title,
  location: { kind: 'root' },
  count,
  charsAdded: '1',
  charsRemoved: '0',
  lastEvent: event(noteId, title, revisionId),
})

const folderGroup = (
  eventCount = '1',
  lastAt = '2026-08-30T12:00:00.000Z',
): ActivityFolderGroup => ({
  type: 'folder',
  location: { kind: 'root' },
  noteCount: 1,
  eventCount,
  charsAdded: '1',
  charsRemoved: '0',
  lastAt,
})

type GroupsOverview = Extract<ActivityOverview, { kind: 'groups' }>

const notesOverview = (
  through: string,
  notes: ActivityNoteGroup[],
  locationThrough = 'location-1',
  activityVersion = 'activity-v1',
): GroupsOverview => ({
  kind: 'groups',
  response: {
    itemType: 'note',
    items: notes,
    total: notes.length,
    through,
    activityVersion,
    locationThrough,
    nextCursor: null,
  },
})

const foldersOverview = (through: string, folder: ActivityFolderGroup): GroupsOverview => ({
  kind: 'groups',
  response: {
    itemType: 'folder',
    items: [folder],
    total: 1,
    through,
    activityVersion: 'activity-v1',
    locationThrough: 'location-1',
    nextCursor: null,
  },
})

const eventBranch = (overrides: Partial<Extract<Branch, { kind: 'events' }>> = {}): Branch => ({
  kind: 'events',
  items: [event('note-1', 'Grouped note', 'rev-1')],
  through: '10',
  activityVersion: 'activity-v1',
  nextCursor: null,
  locationThrough: 'location-1',
  count: '1',
  charsAdded: '1',
  charsRemoved: '0',
  lastRevisionId: 'rev-1',
  loading: false,
  error: null,
  ...overrides,
})

const folderBranch = (overrides: Partial<Extract<Branch, { kind: 'notes' }>> = {}): Branch => ({
  kind: 'notes',
  response: folderDetail('10', 'activity-v1', 'note-1', 'Grouped note'),
  locationThrough: 'location-1',
  through: '10',
  activityVersion: 'activity-v1',
  noteCount: 1,
  eventCount: '1',
  charsAdded: '1',
  charsRemoved: '0',
  lastAt: '2026-08-30T12:00:00.000Z',
  loading: false,
  error: null,
  ...overrides,
})

const keyOf = (kind: 'folder' | 'note', id: string) => `${kind}:${id}`
// Whether a branch's `loading` still has a request behind it. Every cut advance
// discards the requests it finds in flight, so the pass needs this told to it: the
// default here is "live", and `orphaned` models the branch a lease bump stranded.
const pending = () => true
const orphaned = () => false

describe('activityFeedBusy', () => {
  const overview = noteOverview('10', 'activity-v1')

  it.each([
    ['cold start', null, null, false, true],
    ['published rows, refresh in flight', overview, null, false, false],
    ['published rows under a warm failure', overview, 'temporary failure', false, false],
    ['latched recovery with an error', null, 'location cut changed', true, true],
    ['latched rebuild without an error', null, null, true, true],
    ['terminal failure with no latch', null, 'network failure', false, false],
  ] as const)('standing lane: %s', (_, standingOverview, error, invalidated, busy) => {
    expect(activityFeedBusy(standingOverview, error, invalidated, null, null, null)).toBe(busy)
  })

  it.each([
    ['day still loading', null, null, true],
    ['day published', overview, null, false],
    ['day failed', null, 'day failure', false],
  ] as const)('drill lane: %s', (_, dayOverview, dayError, busy) => {
    // The drill half ignores the standing lane entirely — a terminal standing
    // failure under an open day is still the day's own skeleton.
    expect(
      activityFeedBusy(null, 'standing failure', false, '2026-08-30', dayOverview, dayError),
    ).toBe(busy)
  })
})

describe('reconcileBranches', () => {
  it('keeps a branch at the same cut without writing or requesting', () => {
    const branches = { 'note:note-1': eventBranch() }
    const parent = notesOverview('10', [noteGroup('note-1', 'Grouped note', 'rev-1')]).response

    expect(reconcileBranches(branches, parent, new Set(['note:note-1']), keyOf, pending)).toEqual({
      rekeyed: [],
      refresh: new Set(),
    })
  })

  it('re-keys a settled branch whose row did not move across a source-cut advance', () => {
    const parent = notesOverview('11', [noteGroup('note-1', 'Grouped note', 'rev-1')]).response
    const result = reconcileBranches(
      { 'note:note-1': eventBranch() },
      parent,
      new Set(['note:note-1']),
      keyOf,
      pending,
    )

    expect(result.refresh).toEqual(new Set())
    expect(result.rekeyed).toEqual([['note:note-1', eventBranch({ through: '11' })]])
  })

  it.each([
    ['count', noteGroup('note-1', 'Grouped note', 'rev-1', '2')],
    ['newest revision', noteGroup('note-1', 'Grouped note', 'rev-2')],
    ['churn', { ...noteGroup('note-1', 'Grouped note', 'rev-1'), charsAdded: '9' }],
  ])('refreshes a branch whose row moved by %s', (_, note) => {
    const result = reconcileBranches(
      { 'note:note-1': eventBranch() },
      notesOverview('11', [note]).response,
      new Set(['note:note-1']),
      keyOf,
      pending,
    )

    expect(result.rekeyed).toEqual([])
    expect(result.refresh).toEqual(new Set(['note:note-1']))
  })

  it.each([
    ['still loading', eventBranch({ loading: true })],
    ['carrying an error', eventBranch({ error: 'detail failure' })],
    ['holding a continuation cursor', eventBranch({ nextCursor: 'page-2' })],
    ['loaded under another model lease', eventBranch({ activityVersion: 'activity-v0' })],
    ['loaded under another location cut', eventBranch({ locationThrough: 'location-0' })],
    ['of the wrong kind', folderBranch()],
  ])('refreshes an unchanged row whose branch is %s', (_, branch) => {
    const result = reconcileBranches(
      { 'note:note-1': branch },
      notesOverview('11', [noteGroup('note-1', 'Grouped note', 'rev-1')]).response,
      new Set(['note:note-1']),
      keyOf,
      pending,
    )

    expect(result.rekeyed).toEqual([])
    expect(result.refresh).toEqual(new Set(['note:note-1']))
  })

  it('never issues a request for a settled branch when the parent repeats its cut', () => {
    // The coalesced-`changed` shape: the same cut arriving again and again. Neither
    // a paginated, an errored nor a loading branch may fire on it — the safety
    // tests gate the re-stamp, not the action.
    const branches = {
      'note:paginated': eventBranch({ nextCursor: 'page-2' }),
      'note:errored': eventBranch({ error: 'detail failure' }),
      'note:loading': eventBranch({ loading: true, items: [] }),
    }
    const parent = notesOverview('10', [
      noteGroup('paginated', 'Paginated', '10'),
      noteGroup('errored', 'Errored', '10'),
      noteGroup('loading', 'Loading', '10'),
    ]).response

    for (let turn = 0; turn < 3; turn++) {
      expect(
        reconcileBranches(branches, parent, new Set(Object.keys(branches)), keyOf, pending),
      ).toEqual({
        rekeyed: [],
        refresh: new Set(),
      })
    }
  })

  it('refreshes a branch whose loading claim has no request behind it', () => {
    const branches = { 'note:note-1': eventBranch({ loading: true, items: [] }) }
    const parent = notesOverview('10', [noteGroup('note-1', 'Grouped note', 'rev-1')]).response
    const open = new Set(['note:note-1'])

    // Same cut, so this is the KEEP outcome — and KEEP is exactly where a branch
    // stranded by a lease bump would sit forever, rendering `Loading…` with nothing
    // in flight and a disclosure that issues nothing on re-expand.
    expect(reconcileBranches(branches, parent, open, keyOf, orphaned)).toEqual({
      rekeyed: [],
      refresh: new Set(['note:note-1']),
    })
    // With the request still live there is nothing to repair.
    expect(reconcileBranches(branches, parent, open, keyOf, pending)).toEqual({
      rekeyed: [],
      refresh: new Set(),
    })

    // The folder lane is the same rule, not a copy that drifted.
    const folders = { 'folder:root': folderBranch({ loading: true, response: null }) }
    const folderParent = foldersOverview('10', folderGroup()).response
    const folderOpen = new Set(['folder:root'])

    expect(reconcileBranches(folders, folderParent, folderOpen, keyOf, orphaned)).toEqual({
      rekeyed: [],
      refresh: new Set(['folder:root']),
    })
    expect(reconcileBranches(folders, folderParent, folderOpen, keyOf, pending)).toEqual({
      rekeyed: [],
      refresh: new Set(),
    })
  })

  it('touches only open keys the parent supplies a row for', () => {
    const branches = {
      'note:collapsed': eventBranch(),
      'note:gone': eventBranch(),
      'note:nested': eventBranch(),
    }
    // Folder grouping: `open` routinely holds nested note keys while the parent
    // holds folder rows; a top-level note whose row left the overview is likewise
    // outside the domain. Neither may be written to or requested.
    const noteParent = notesOverview('11', [noteGroup('collapsed', 'Collapsed', 'rev-1')]).response
    const folderParent = foldersOverview('11', folderGroup()).response

    expect(
      reconcileBranches(
        branches,
        noteParent,
        new Set(['note:gone', 'note:nested']),
        keyOf,
        pending,
      ),
    ).toEqual({ rekeyed: [], refresh: new Set() })
    expect(
      reconcileBranches(
        branches,
        folderParent,
        new Set(['note:nested', 'folder:root']),
        keyOf,
        pending,
      ),
    ).toEqual({ rekeyed: [], refresh: new Set(['folder:root']) })
  })

  it('compares the folder row field by field, not by its newest time alone', () => {
    const open = new Set(['folder:root'])

    expect(
      reconcileBranches(
        { 'folder:root': folderBranch() },
        foldersOverview('11', folderGroup('2')).response,
        open,
        keyOf,
        pending,
      ).refresh,
    ).toEqual(new Set(['folder:root']))
    expect(
      reconcileBranches(
        { 'folder:root': folderBranch() },
        foldersOverview('11', folderGroup()).response,
        open,
        keyOf,
        pending,
      ).rekeyed,
    ).toEqual([['folder:root', folderBranch({ through: '11' })]])
    expect(
      reconcileBranches(
        {
          'folder:root': folderBranch({
            response: folderDetail(
              '10',
              'activity-v1',
              'note-1',
              'Grouped note',
              'location-1',
              'p2',
            ),
          }),
        },
        foldersOverview('11', folderGroup()).response,
        open,
        keyOf,
        pending,
      ).refresh,
    ).toEqual(new Set(['folder:root']))
  })

  it('never re-keys onto a null source cut', () => {
    const parent = { ...notesOverview('10', []).response, through: null, items: [] }

    expect(
      reconcileBranches(
        { 'note:note-1': eventBranch() },
        parent,
        new Set(['note:note-1']),
        keyOf,
        pending,
      ),
    ).toEqual({ rekeyed: [], refresh: new Set() })
  })
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
          invalidated: false,
          rebuildingProlonged: false,
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

  const disclosureFor = (label: string) =>
    [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith(label),
    )

  const buttonNamed = (text: string) =>
    [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === text)

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

  it('links every folder path segment of a Note row without touching its title link', () => {
    render(
      {
        kind: 'groups',
        response: folderDetail('10', 'activity-v1', 'note-1', 'Nested note', 'location-1', null, {
          kind: 'folder',
          path: 'alpha/beta',
        }),
      },
      { group: 'note' },
    )
    const row = container.querySelector('[data-testid="dashboard-activity-note-group"]')!
    const crumbs = [...row.querySelectorAll<HTMLAnchorElement>(`a.${styles.eventCrumbLink}`)]

    expect(crumbs.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['alpha', folderRoute('work', 'alpha')],
      ['beta', folderRoute('work', 'alpha/beta')],
    ])
    expect(row.querySelector('a[data-id="note-1"]')?.textContent).toBe('Nested note')
    // The note is the subject here, so its whole location stays context — no segment
    // is promoted the way the Folder row promotes its own.
    expect(crumbs.some((link) => link.classList.contains(styles.eventCrumbSubject))).toBe(false)
  })

  it('links the folder path segments behind the Folder qualifier of a Folder row', () => {
    render(
      folderOverview('10', 'activity-v1', 'location-1', { kind: 'folder', path: 'alpha/beta' }),
    )
    const row = container.querySelector('[data-testid="dashboard-activity-folder-group"]')!
    const crumbs = [...row.querySelectorAll<HTMLAnchorElement>(`a.${styles.eventCrumbLink}`)]

    expect(row.textContent).toContain('Folder · ')
    expect(crumbs.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['alpha', folderRoute('work', 'alpha')],
      ['beta', folderRoute('work', 'alpha/beta')],
    ])
    expect(row.querySelector('button[aria-expanded]')?.getAttribute('aria-label')).toBe(
      'Expand notes in Folder · alpha/beta',
    )
    // Everything but the row's own subject is context: the qualifier and the parent
    // segment are dimmed, the folder's own segment carries the voice — the same
    // hierarchy the note row has, where the title is bright over a dim breadcrumb.
    expect(row.querySelector(`.${styles.folderQualifier}`)?.textContent).toContain('Folder · ')
    expect(crumbs.map((link) => link.classList.contains(styles.eventCrumbSubject))).toEqual([
      false,
      true,
    ])
  })

  it('keeps structural buckets as labels and adds no location where none renders today', () => {
    render(folderOverview('10', 'activity-v1', 'location-1', { kind: 'unavailable' }))
    const folderRow = container.querySelector('[data-testid="dashboard-activity-folder-group"]')!

    expect(folderRow.textContent).toContain('No current folder')
    expect(folderRow.querySelectorAll(`a.${styles.eventCrumbLink}`)).toHaveLength(0)

    render(noteOverview('10', 'activity-v1'), { group: 'note' })
    const noteRow = container.querySelector('[data-testid="dashboard-activity-note-group"]')!

    expect(noteRow.querySelector(`.${styles.eventCrumbs}`)).toBeNull()
    expect(noteRow.textContent).not.toContain('Workspace root')

    render(
      {
        kind: 'events',
        response: {
          events: [event('note-root', 'Root note', 'revision-root')],
          total: 1,
          through: '10',
          activityVersion: 'activity-v1',
          nextCursor: null,
        },
      },
      { group: 'none' },
    )
    const eventRow = container.querySelector('[data-testid="dashboard-activity-row"]')!

    expect(eventRow.querySelector(`.${styles.eventCrumbs}`)).toBeNull()
  })

  it('navigates from a crumb without toggling disclosure or opening the note', () => {
    const onOpen = vi.fn()

    container.addEventListener('click', (clickEvent) => clickEvent.preventDefault())
    render(
      {
        kind: 'groups',
        response: folderDetail('10', 'activity-v1', 'note-1', 'Nested note', 'location-1', null, {
          kind: 'folder',
          path: 'alpha',
        }),
      },
      { group: 'note', onOpen },
    )
    const crumb = container.querySelector<HTMLAnchorElement>(`a.${styles.eventCrumbLink}`)!

    act(() => crumb.click())

    expect(container.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(onOpen).not.toHaveBeenCalled()
    expect(harness.api.activityEventsGet).not.toHaveBeenCalled()
  })

  it('draws the skeleton for every state without data except a terminal failure', () => {
    render(null, { group: 'note' })
    expect(container.querySelector('[data-skeleton]')).not.toBeNull()
    expect(container.textContent).not.toContain('No activity yet')

    render(null, { group: 'note', invalidated: true, error: 'location cut changed' })
    expect(container.querySelector('[data-skeleton]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('location cut changed')
    expect(buttonNamed('Retry')).toBeDefined()

    render(null, { group: 'note', error: 'network failure' })
    expect(container.querySelector('[data-skeleton]')).toBeNull()
    expect(container.querySelector(`.${styles.feedEmpty}`)).not.toBeNull()
    expect(buttonNamed('Retry')).toBeDefined()

    render(noteOverview('10', 'activity-v1'), { group: 'note' })
    expect(container.querySelector('[data-skeleton]')).toBeNull()
  })

  it('explains a prolonged rebuild as a status — never an alert or a retry — in both lanes', () => {
    render(null, { group: 'note', invalidated: true })
    expect(container.querySelector('[data-skeleton]')).not.toBeNull()
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0)
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
    expect(buttonNamed('Retry')).toBeUndefined()

    render(null, { group: 'note', invalidated: true, rebuildingProlonged: true })
    const standing = container.querySelectorAll('[role="status"]')

    expect(standing).toHaveLength(1)
    expect(standing[0]?.textContent).toBe(
      'Rebuilding the activity summary. This can take a while; the feed will refresh on its own when it’s done.',
    )
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
    expect(buttonNamed('Retry')).toBeUndefined()
    expect(container.querySelector('[data-skeleton]')).not.toBeNull()

    render(null, { group: 'note', invalidated: true, rebuildingProlonged: true, day: '2026-08-30' })
    const drill = container.querySelectorAll('[role="status"]')

    expect(drill).toHaveLength(1)
    expect(drill[0]?.textContent).toBe(
      'Rebuilding the activity summary. This can take a while; the feed will refresh on its own when it’s done.',
    )
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
    expect(buttonNamed('Retry')).toBeUndefined()
    expect(container.querySelector('[data-skeleton]')).not.toBeNull()
  })

  it('yields the rebuild line to a failure that owns the lane, and keeps it where none does', () => {
    // Standing: the failure notice is right here with a working Retry, so the calm
    // "it will refresh on its own" would promise a `changed` frame no network error
    // sends.
    render(null, {
      group: 'note',
      invalidated: true,
      rebuildingProlonged: true,
      error: 'server failure',
    })
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('server failure')
    expect(buttonNamed('Retry')).toBeDefined()

    // Drill: that same notice is standing-only, and a rebuild closes the day's own
    // gate, so this line is the reader's ONLY explanation of the skeleton. Suppress
    // it here and the open day goes mute — no text, no Retry, nothing to act on.
    render(null, {
      group: 'note',
      invalidated: true,
      rebuildingProlonged: true,
      error: 'server failure',
      day: '2026-08-30',
    })
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
    expect(container.querySelector('[data-skeleton]')).not.toBeNull()
  })

  it('keeps a real failure an alert with a working retry in both lanes', () => {
    render(null, { group: 'note', error: 'network failure' })
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0)
    act(() => buttonNamed('Retry')!.click())
    expect(onRetry).toHaveBeenCalledOnce()

    render(noteOverview('10', 'activity-v1'), {
      group: 'note',
      day: '2026-08-30',
      dayError: 'day failure',
    })
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('day failure')
    act(() => buttonNamed('Retry')!.click())
    expect(onDayRetry).toHaveBeenCalledOnce()
  })

  it('expands a branch with exactly one request', async () => {
    harness.api.activityEventsGet.mockResolvedValueOnce(eventDetail('10', 'activity-v1', 'One'))
    render(noteOverview('10', 'activity-v1'), { group: 'note' })
    await settle()

    act(() => disclosureFor('Expand changes for Grouped note')!.click())
    await settle()

    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('One')
  })

  it('re-keys a settled Note branch across a cut advance without a request', async () => {
    harness.api.activityEventsGet.mockResolvedValueOnce(
      eventDetail('10', 'activity-v1', 'Kept event'),
    )
    render(notesOverview('10', [noteGroup('note-1', 'Grouped note', 'rev-1')]), { group: 'note' })
    await settle()
    act(() => disclosureFor('Expand changes for Grouped note')!.click())
    await settle()
    expect(container.textContent).toContain('Kept event')

    render(notesOverview('11', [noteGroup('note-1', 'Grouped note', 'rev-1')]), { group: 'note' })
    await settle()

    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Kept event')
    expect(container.textContent).not.toContain('Loading…')
    expect(disclosureFor('Collapse changes for Grouped note')?.getAttribute('aria-expanded')).toBe(
      'true',
    )
  })

  it('refreshes exactly the branch whose row moved and keeps its items while the reload runs', async () => {
    const replacement = deferred<ReturnType<typeof eventDetail>>()

    harness.api.activityEventsGet
      .mockResolvedValueOnce(eventDetail('10', 'activity-v1', 'First event'))
      .mockResolvedValueOnce({
        ...eventDetail('10', 'activity-v1', 'Second event'),
        events: [event('note-2', 'Second event', 'rev-second')],
      })
      .mockReturnValueOnce(replacement.promise)
    render(
      notesOverview('10', [
        noteGroup('note-1', 'First', 'rev-1'),
        noteGroup('note-2', 'Second', 'rev-1'),
      ]),
      { group: 'note' },
    )
    await settle()
    act(() => disclosureFor('Expand changes for First')!.click())
    await settle()
    act(() => disclosureFor('Expand changes for Second')!.click())
    await settle()
    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(2)

    render(
      notesOverview('11', [
        noteGroup('note-1', 'First', 'rev-2', '2'),
        noteGroup('note-2', 'Second', 'rev-1'),
      ]),
      { group: 'note' },
    )
    await settle()

    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(3)
    expect(harness.api.activityEventsGet).toHaveBeenLastCalledWith(
      'work',
      expect.objectContaining({ noteId: 'note-1', through: '11' }),
    )
    expect(container.textContent).toContain('First event')
    expect(container.textContent).toContain('Second event')
    expect(container.textContent).not.toContain('Loading…')

    replacement.resolve(eventDetail('11', 'activity-v1', 'Fresh first event'))
    await settle()

    expect(container.textContent).toContain('Fresh first event')
    expect(container.textContent).not.toContain('First event')
    expect(container.textContent).toContain('Second event')
  })

  it('refreshes a branch still loading at the old cut and never strands it at Loading…', async () => {
    const first = deferred<ReturnType<typeof eventDetail>>()
    const second = deferred<ReturnType<typeof eventDetail>>()

    harness.api.activityEventsGet
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    render(notesOverview('10', [noteGroup('note-1', 'Grouped note', 'rev-1')]), { group: 'note' })
    await settle()
    act(() => disclosureFor('Expand changes for Grouped note')!.click())
    await settle()
    expect(container.textContent).toContain('Loading…')

    render(notesOverview('11', [noteGroup('note-1', 'Grouped note', 'rev-1')]), { group: 'note' })
    await settle()
    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(2)

    first.resolve(eventDetail('10', 'activity-v1', 'Stale event'))
    await settle()
    second.resolve(eventDetail('11', 'activity-v1', 'Current event'))
    await settle()

    expect(container.textContent).toContain('Current event')
    expect(container.textContent).not.toContain('Stale event')
    expect(container.textContent).not.toContain('Loading…')
  })

  it('heals a branch carrying an error and items on the next cut without a click', async () => {
    harness.api.activityEventsGet
      .mockResolvedValueOnce(eventDetail('10', 'activity-v1', 'Warm event', 'page-2'))
      .mockRejectedValueOnce(new Error('page failure'))
      .mockResolvedValueOnce(eventDetail('11', 'activity-v1', 'Healed event'))
    render(notesOverview('10', [noteGroup('note-1', 'Grouped note', 'rev-1')]), { group: 'note' })
    await settle()
    act(() => disclosureFor('Expand changes for Grouped note')!.click())
    await settle()
    act(() => buttonNamed('Load older changes')!.click())
    await settle()
    expect(container.textContent).toContain('page failure')
    expect(container.textContent).toContain('Warm event')

    render(notesOverview('11', [noteGroup('note-1', 'Grouped note', 'rev-1')]), { group: 'note' })
    await settle()

    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain('Healed event')
    expect(container.textContent).not.toContain('page failure')
    expect(container.textContent).not.toContain('Loading…')
  })

  it('shows Loading… only while a branch with nothing to show heals', async () => {
    harness.api.activityEventsGet
      .mockRejectedValueOnce(new Error('cold detail failure'))
      .mockResolvedValueOnce(eventDetail('11', 'activity-v1', 'Healed event'))
    render(notesOverview('10', [noteGroup('note-1', 'Grouped note', 'rev-1')]), { group: 'note' })
    await settle()
    act(() => disclosureFor('Expand changes for Grouped note')!.click())
    await settle()
    expect(container.textContent).toContain('cold detail failure')

    render(notesOverview('11', [noteGroup('note-1', 'Grouped note', 'rev-1')]), { group: 'note' })

    expect(container.textContent).toContain('Loading…')
    expect(container.textContent).not.toContain('cold detail failure')
    await settle()
    expect(container.textContent).toContain('Healed event')
    expect(container.textContent).not.toContain('Loading…')
  })

  it('drops a continuation cursor across a cut change and pages again after the refresh', async () => {
    const refresh = deferred<ReturnType<typeof eventDetail>>()

    harness.api.activityEventsGet
      .mockResolvedValueOnce(eventDetail('10', 'activity-v1', 'Page one', 'page-2'))
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValueOnce({
        ...eventDetail('11', 'activity-v1', 'Page two'),
        events: [event('note-1', 'Page two', 'rev-page-two')],
      })
    render(notesOverview('10', [noteGroup('note-1', 'Grouped note', 'rev-1')]), { group: 'note' })
    await settle()
    act(() => disclosureFor('Expand changes for Grouped note')!.click())
    await settle()
    expect(buttonNamed('Load older changes')).toBeDefined()

    render(notesOverview('11', [noteGroup('note-1', 'Grouped note', 'rev-1')]), { group: 'note' })
    await settle()

    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(2)
    expect(harness.api.activityEventsGet.mock.calls.at(-1)?.[1].cursor).toBeUndefined()
    expect(container.textContent).toContain('Page one')
    expect(buttonNamed('Load older changes')).toBeUndefined()

    refresh.resolve(eventDetail('11', 'activity-v1', 'Page one again', 'page-3'))
    await settle()
    expect(buttonNamed('Load older changes')).toBeDefined()

    act(() => buttonNamed('Load older changes')!.click())
    await settle()

    expect(harness.api.activityEventsGet).toHaveBeenLastCalledWith(
      'work',
      expect.objectContaining({ cursor: 'page-3', through: '11' }),
    )
    expect(container.textContent).toContain('Page one again')
    expect(container.textContent).toContain('Page two')
  })

  it('issues no request when an unchanged parent keeps arriving', async () => {
    const stuck = deferred<ReturnType<typeof eventDetail>>()

    harness.api.activityEventsGet.mockImplementation(
      (_space: string, params: { noteId: string }) =>
        params.noteId === 'paginated'
          ? Promise.resolve({
              ...eventDetail('10', 'activity-v1', 'Paginated event', 'page-2'),
              events: [event('paginated', 'Paginated event', 'rev-p')],
            })
          : params.noteId === 'errored'
            ? Promise.reject(new Error('detail failure'))
            : stuck.promise,
    )
    const notes = () => [
      noteGroup('paginated', 'Paginated', 'rev-1'),
      noteGroup('errored', 'Errored', 'rev-1'),
      noteGroup('loading', 'Loading', 'rev-1'),
    ]

    render(notesOverview('10', notes()), { group: 'note' })
    await settle()
    for (const title of ['Paginated', 'Errored', 'Loading']) {
      act(() => disclosureFor(`Expand changes for ${title}`)!.click())
      await settle()
    }
    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(3)

    for (let turn = 0; turn < 3; turn++) {
      render(notesOverview('10', notes()), { group: 'note' })
      await settle()
    }

    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain('Paginated event')
    expect(container.textContent).toContain('detail failure')
    expect(container.textContent).toContain('Loading…')
  })

  it('leaves a nested note branch to its folder branch on a cut advance', async () => {
    harness.api.activityGroupsGet.mockResolvedValueOnce(
      folderDetail('10', 'activity-v1', 'note-1', 'Nested note'),
    )
    harness.api.activityEventsGet.mockResolvedValueOnce(
      eventDetail('10', 'activity-v1', 'Nested event'),
    )
    render(foldersOverview('10', folderGroup()))
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    act(() => disclosureFor('Expand changes for Nested note')!.click())
    await settle()
    expect(container.textContent).toContain('Nested event')

    render(foldersOverview('11', folderGroup()))
    await settle()

    expect(harness.api.activityGroupsGet).toHaveBeenCalledTimes(1)
    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Nested event')
    expect(container.textContent).not.toContain('Loading…')
  })

  it('ignores an open branch whose row left the overview', async () => {
    harness.api.activityEventsGet.mockResolvedValueOnce({
      ...eventDetail('10', 'activity-v1', 'Second event'),
      events: [event('note-2', 'Second event', 'rev-second')],
    })
    render(
      notesOverview('10', [
        noteGroup('note-1', 'First', 'rev-1'),
        noteGroup('note-2', 'Second', 'rev-1'),
      ]),
      { group: 'note' },
    )
    await settle()
    act(() => disclosureFor('Expand changes for Second')!.click())
    await settle()

    render(notesOverview('11', [noteGroup('note-1', 'First', 'rev-1')]), { group: 'note' })
    await settle()

    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(1)
  })

  it('refreshes a Folder branch whose event count moved under an unchanged newest time', async () => {
    harness.api.activityGroupsGet
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-1', 'Old nested'))
      .mockResolvedValueOnce(folderDetail('11', 'activity-v1', 'note-1', 'New nested'))
    render(foldersOverview('10', folderGroup()))
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()

    render(foldersOverview('11', folderGroup('2')))
    await settle()

    expect(harness.api.activityGroupsGet).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('New nested')
    expect(container.textContent).not.toContain('Old nested')
  })

  it('refreshes a paginated Folder branch to page one and pages again from the new cut', async () => {
    const refresh = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()

    harness.api.activityGroupsGet
      .mockResolvedValueOnce(
        folderDetail('10', 'activity-v1', 'note-a', 'Alpha', 'location-1', 'page-2'),
      )
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-b', 'Beta'))
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValueOnce(folderDetail('11', 'activity-v1', 'note-c', 'Gamma'))
    render(foldersOverview('10', folderGroup()))
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    act(() => buttonNamed('Load older notes')!.click())
    await settle()
    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).toContain('Beta')

    render(foldersOverview('11', folderGroup('2')))
    await settle()

    expect(harness.api.activityGroupsGet).toHaveBeenCalledTimes(3)
    expect(harness.api.activityGroupsGet.mock.calls.at(-1)?.[1].cursor).toBeUndefined()
    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).toContain('Beta')
    expect(container.textContent).not.toContain('Loading…')
    expect(buttonNamed('Load older notes')).toBeUndefined()

    refresh.resolve(folderDetail('11', 'activity-v1', 'note-a', 'Alpha', 'location-1', 'page-3'))
    await settle()
    expect(container.textContent).not.toContain('Beta')
    expect(buttonNamed('Load older notes')).toBeDefined()

    act(() => buttonNamed('Load older notes')!.click())
    await settle()

    expect(harness.api.activityGroupsGet).toHaveBeenLastCalledWith(
      'work',
      expect.objectContaining({ cursor: 'page-3', through: '11' }),
    )
    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).toContain('Gamma')
  })

  it('re-seeds a note expanded while its folder refresh is in flight', async () => {
    const refresh = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()

    harness.api.activityGroupsGet
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-1', 'Nested note'))
      .mockReturnValueOnce(refresh.promise)
    harness.api.activityEventsGet
      .mockResolvedValueOnce(eventDetail('10', 'activity-v1', 'Old nested event'))
      .mockResolvedValueOnce(eventDetail('11', 'activity-v1', 'New nested event'))
    render(foldersOverview('10', folderGroup()))
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()

    render(foldersOverview('11', folderGroup('2')))
    await settle()
    expect(container.textContent).toContain('Nested note')
    act(() => disclosureFor('Expand changes for Nested note')!.click())
    await settle()
    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Old nested event')

    refresh.resolve(folderDetail('11', 'activity-v1', 'note-1', 'Nested note'))
    await settle()

    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(2)
    expect(harness.api.activityEventsGet).toHaveBeenLastCalledWith(
      'work',
      expect.objectContaining({ noteId: 'note-1', through: '11' }),
    )
    expect(container.textContent).toContain('New nested event')
    expect(container.textContent).not.toContain('Loading…')
  })

  it('refreshes a folder whose nested branch has a request in flight instead of re-keying it', async () => {
    const nested = deferred<ReturnType<typeof eventDetail>>()

    harness.api.activityGroupsGet
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-1', 'Nested note'))
      .mockResolvedValueOnce(folderDetail('11', 'activity-v1', 'note-1', 'Nested note'))
    harness.api.activityEventsGet
      .mockReturnValueOnce(nested.promise)
      .mockResolvedValueOnce(eventDetail('11', 'activity-v1', 'Nested event'))
    render(foldersOverview('10', folderGroup()))
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    act(() => disclosureFor('Expand changes for Nested note')!.click())
    await settle()
    expect(container.textContent).toContain('Loading…')

    // The cut advances while the folder's own row is byte-identical. Re-keying it
    // would issue no request, while the lease bump has already orphaned the nested
    // request in flight — and no other producer owns a nested key.
    render(foldersOverview('11', folderGroup()))
    await settle()
    nested.resolve(eventDetail('10', 'activity-v1', 'Orphaned nested event'))
    await settle()

    expect(container.textContent).toContain('Nested event')
    expect(container.textContent).not.toContain('Loading…')
    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(2)
    expect(harness.api.activityEventsGet).toHaveBeenLastCalledWith(
      'work',
      expect.objectContaining({ noteId: 'note-1', through: '11' }),
    )
  })

  it('repairs a top-level branch orphaned by an excursion at an unchanged cut', async () => {
    const stranded = deferred<ReturnType<typeof eventDetail>>()

    harness.api.activityEventsGet
      .mockReturnValueOnce(stranded.promise)
      .mockResolvedValueOnce(eventDetail('10', 'activity-v1', 'Repaired event'))
    const overview = noteOverview('10', 'activity-v1')

    render(overview, { group: 'note' })
    await settle()
    act(() => disclosureFor('Expand changes for Grouped note')!.click())
    await settle()
    expect(container.textContent).toContain('Loading…')

    // The overview goes away and comes back at the SAME cut — the one excursion that
    // moves the lease without moving the cut. It discards the request in flight, and
    // the pass's KEEP outcome is the arm that would otherwise leave the branch
    // claiming to load with nothing behind it.
    render(null, { group: 'note' })
    await settle()
    render(overview, { group: 'note' })
    await settle()
    stranded.resolve(eventDetail('10', 'activity-v1', 'Orphaned event'))
    await settle()

    expect(harness.api.activityEventsGet).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Repaired event')
    expect(container.textContent).not.toContain('Orphaned event')
    expect(container.textContent).not.toContain('Loading…')
  })

  it('keeps a nested branch on Loading… while the folder reload that will re-seed it runs', async () => {
    const nested = deferred<ReturnType<typeof eventDetail>>()
    const refresh = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()

    harness.api.activityGroupsGet
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-1', 'Nested note'))
      .mockReturnValueOnce(refresh.promise)
    harness.api.activityEventsGet
      .mockReturnValueOnce(nested.promise)
      .mockResolvedValueOnce(eventDetail('11', 'activity-v1', 'Nested event'))
    render(foldersOverview('10', folderGroup()))
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    act(() => disclosureFor('Expand changes for Nested note')!.click())
    await settle()

    // An ordinary append. The nested request in flight is discarded and the folder is
    // refreshed to re-seed it — so for the length of that round trip the promise is
    // honest, and the reader must not see a failure flashed over a healthy path.
    render(foldersOverview('11', folderGroup()))
    await settle()
    nested.resolve(eventDetail('10', 'activity-v1', 'Orphaned nested event'))
    await settle()

    expect(container.textContent).toContain('Loading…')
    expect(container.textContent).not.toContain('Could not load changes')

    refresh.resolve(folderDetail('11', 'activity-v1', 'note-1', 'Nested note'))
    await settle()
    expect(container.textContent).toContain('Nested event')
    expect(container.textContent).not.toContain('Loading…')
  })

  it('discards a nested page that lost the race to its folder re-seed', async () => {
    const refresh = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()
    const page = deferred<ReturnType<typeof eventDetail>>()

    harness.api.activityGroupsGet
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-1', 'Nested note'))
      .mockReturnValueOnce(refresh.promise)
    harness.api.activityEventsGet
      .mockResolvedValueOnce(eventDetail('10', 'activity-v1', 'Page one', 'evt-page-2'))
      .mockReturnValueOnce(page.promise)
      .mockResolvedValueOnce(eventDetail('11', 'activity-v1', 'Re-seeded event'))
    render(foldersOverview('10', folderGroup()))
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    act(() => disclosureFor('Expand changes for Nested note')!.click())
    await settle()
    expect(container.textContent).toContain('Page one')

    // The folder's row moved, so the pass refreshes it; its carried page keeps the
    // nested row on screen, and the user pages that row while the folder reload is
    // still in flight. Now TWO requests are live for the nested key under one lease
    // and one epoch — the only state the sequence guard exists for.
    render(foldersOverview('11', folderGroup('2')))
    await settle()
    act(() => buttonNamed('Load older changes')!.click())
    await settle()
    refresh.resolve(folderDetail('11', 'activity-v1', 'note-1', 'Nested note'))
    await settle()
    page.resolve(eventDetail('10', 'activity-v1', 'Stale page two'))
    await settle()

    // The re-seed is the later request, so the page that lost the race must not land:
    // it would stamp the branch at the old cut under the new parent and blank the row.
    expect(container.textContent).toContain('Re-seeded event')
    expect(container.textContent).not.toContain('Stale page two')
    expect(container.textContent).not.toContain('Loading…')
  })

  it('draws Loading… for a nested branch with its own request while its folder is idle', async () => {
    const nested = deferred<ReturnType<typeof eventDetail>>()

    harness.api.activityGroupsGet.mockResolvedValueOnce(
      folderDetail('10', 'activity-v1', 'note-1', 'Nested note'),
    )
    harness.api.activityEventsGet.mockReturnValueOnce(nested.promise)
    render(foldersOverview('10', folderGroup()))
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()

    // The folder's own request has settled, so nothing is in flight for its key. The
    // nested branch is delivering for itself, and reading only the producer would
    // call this healthy first expand a failure.
    act(() => disclosureFor('Expand changes for Nested note')!.click())
    await settle()

    expect(container.textContent).toContain('Loading…')
    expect(container.textContent).not.toContain('Could not load changes')
    nested.resolve(eventDetail('10', 'activity-v1', 'Nested event'))
    await settle()
    expect(container.textContent).toContain('Nested event')
  })

  it('does not treat a settled folder request as a producer for a stranded nested branch', async () => {
    const stranded = deferred<ReturnType<typeof eventDetail>>()
    const folders = foldersOverview('10', folderGroup())

    harness.api.activityGroupsGet
      .mockResolvedValueOnce(
        folderDetail('10', 'activity-v1', 'note-1', 'Nested note', 'location-1', 'page-2'),
      )
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-2', 'Second note'))
    harness.api.activityEventsGet.mockReturnValueOnce(stranded.promise)
    render(folders)
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    act(() => disclosureFor('Expand changes for Nested note')!.click())
    await settle()
    render(null)
    await settle()
    render(folders)
    await settle()
    stranded.resolve(eventDetail('10', 'activity-v1', 'Orphaned nested event'))
    await settle()
    expect(container.textContent).toContain('Could not load changes')

    // Paging the folder puts its key back in flight and then settles it. That request
    // never re-seeded the stranded row — it fetched the NEXT page — so once it is
    // done nothing is coming for that row again, and the surface must say so.
    act(() => buttonNamed('Load older notes')!.click())
    await settle()

    expect(container.textContent).toContain('Second note')
    expect(container.textContent).toContain('Could not load changes')
    expect(container.textContent).not.toContain('Loading…')
    harness.api.activityEventsGet.mockResolvedValueOnce(
      eventDetail('10', 'activity-v1', 'Nested event'),
    )
    const nestedRow = container.querySelector('[data-testid="dashboard-activity-note-group"]')!

    act(() =>
      [...nestedRow.querySelectorAll('button')]
        .find((button) => button.textContent === 'Retry')!
        .click(),
    )
    await settle()
    expect(container.textContent).toContain('Nested event')
  })

  it('offers a way out of a collapsed folder branch orphaned at an unchanged cut', async () => {
    const stranded = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()
    const folders = foldersOverview('10', folderGroup())

    harness.api.activityGroupsGet.mockReturnValueOnce(stranded.promise)
    render(folders)
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    act(() => disclosureFor('Collapse notes in Workspace root')!.click())
    await settle()

    // Collapsed, so the pass never visits the key; the excursion kills its request.
    // Re-expanding is inert — the stored branch still matches the parent — so the
    // folder lane needs the same way out the note lane has.
    render(null)
    await settle()
    render(folders)
    await settle()
    stranded.resolve(folderDetail('10', 'activity-v1', 'note-1', 'Nested note'))
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()

    expect(container.textContent).not.toContain('Loading…')
    expect(container.textContent).toContain('Could not load changes')
    harness.api.activityGroupsGet.mockResolvedValueOnce(
      folderDetail('10', 'activity-v1', 'note-1', 'Recovered note'),
    )
    act(() => buttonNamed('Retry')!.click())
    await settle()
    expect(container.textContent).toContain('Recovered note')
  })

  it('offers a way out of a nested branch the pass does not own', async () => {
    const stranded = deferred<ReturnType<typeof eventDetail>>()
    const folders = foldersOverview('10', folderGroup())

    harness.api.activityGroupsGet.mockResolvedValue(
      folderDetail('10', 'activity-v1', 'note-1', 'Nested note'),
    )
    harness.api.activityEventsGet.mockReturnValueOnce(stranded.promise)
    render(folders)
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    act(() => disclosureFor('Expand changes for Nested note')!.click())
    await settle()
    expect(container.textContent).toContain('Loading…')

    // Same excursion, but the folder's own row is settled and unchanged, so the pass
    // KEEPS it and issues nothing — and a nested key is outside the pass entirely.
    // Nobody is coming, and the disclosure is inert: its parent page still matches.
    render(null)
    await settle()
    render(folders)
    await settle()
    stranded.resolve(eventDetail('10', 'activity-v1', 'Orphaned nested event'))
    await settle()

    expect(container.textContent).not.toContain('Loading…')
    expect(container.textContent).toContain('Could not load changes')
    harness.api.activityEventsGet.mockResolvedValueOnce(
      eventDetail('10', 'activity-v1', 'Nested event'),
    )
    const nestedRow = container.querySelector('[data-testid="dashboard-activity-note-group"]')!

    act(() =>
      [...nestedRow.querySelectorAll('button')]
        .find((button) => button.textContent === 'Retry')!
        .click(),
    )
    await settle()
    expect(container.textContent).toContain('Nested event')
  })

  it('leaves a nested branch with a live request alone when a folder page fails', async () => {
    const nested = deferred<ReturnType<typeof eventDetail>>()
    const page = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()

    harness.api.activityGroupsGet
      .mockResolvedValueOnce(
        folderDetail('10', 'activity-v1', 'note-1', 'Nested note', 'location-1', 'page-2'),
      )
      .mockReturnValueOnce(page.promise)
    harness.api.activityEventsGet.mockReturnValueOnce(nested.promise)
    render(foldersOverview('10', folderGroup()))
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    act(() => disclosureFor('Expand changes for Nested note')!.click())
    await settle()

    // "Load older notes" at an unchanged cut: the lease never moved, so the nested
    // request is alive and its own page is still coming. A failure of the folder's
    // page must not accuse it.
    act(() => buttonNamed('Load older notes')!.click())
    await settle()
    page.reject(new Error('server failure'))
    await settle()

    expect(container.textContent).not.toContain('Could not load changes')
    nested.resolve(eventDetail('10', 'activity-v1', 'Nested event'))
    await settle()
    expect(container.textContent).toContain('Nested event')
  })

  it('gives a nested branch the failure when the folder reload that owned it fails', async () => {
    const nested = deferred<ReturnType<typeof eventDetail>>()
    const refresh = deferred<Extract<ActivityGroupsResponse, { itemType: 'note' }>>()

    harness.api.activityGroupsGet
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-1', 'Nested note'))
      .mockReturnValueOnce(refresh.promise)
    harness.api.activityEventsGet.mockReturnValueOnce(nested.promise)
    render(foldersOverview('10', folderGroup()))
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    act(() => disclosureFor('Expand changes for Nested note')!.click())
    await settle()

    // The cut advances, the nested request in flight is discarded, and the folder is
    // refreshed to re-seed it — but that reload is the one producer, and it fails.
    render(foldersOverview('11', folderGroup()))
    await settle()
    refresh.reject(new Error('server failure'))
    await settle()
    nested.resolve(eventDetail('10', 'activity-v1', 'Orphaned nested event'))
    await settle()

    // The nested row must not sit at `Loading…` with nothing coming: it says what
    // happened and offers a Retry that works.
    expect(container.textContent).not.toContain('Loading…')
    expect(container.textContent).toContain('Could not load changes')
    harness.api.activityEventsGet.mockResolvedValueOnce(
      eventDetail('10', 'activity-v1', 'Nested event'),
    )
    // Its own Retry, not the folder's: the nested branch is repairable on the page
    // that is still under it, at the cut that page was fetched for.
    const nestedRow = container.querySelector('[data-testid="dashboard-activity-note-group"]')!
    const nestedRetry = [...nestedRow.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry',
    )

    act(() => nestedRetry!.click())
    await settle()
    expect(container.textContent).toContain('Nested event')
    expect(harness.api.activityEventsGet).toHaveBeenLastCalledWith(
      'work',
      expect.objectContaining({ noteId: 'note-1', through: '10' }),
    )
  })

  it('keeps the wholesale clear armed across a drill close that lands on a warm overview', async () => {
    harness.api.activityGroupsGet
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-1', 'Standing detail'))
      .mockResolvedValueOnce(folderDetail('10', 'activity-v1', 'note-1', 'Reopened detail'))
      .mockResolvedValueOnce(
        folderDetail('10', 'activity-v1', 'note-1', 'Moved detail', 'location-2'),
      )
    const standing = folderOverview('10', 'activity-v1')

    render(standing)
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    expect(container.textContent).toContain('Standing detail')

    render(standing, { day: '2026-08-30', dayOverview: folderOverview('10', 'activity-v1') })
    await settle()
    render(standing, { day: null })
    await settle()
    act(() => disclosureFor('Expand notes in Workspace root')!.click())
    await settle()
    expect(container.textContent).toContain('Reopened detail')

    render(folderOverview('10', 'activity-v1', 'location-2'))
    await settle()

    expect(harness.api.activityGroupsGet).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain('Moved detail')
    expect(container.textContent).not.toContain('Loading…')
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
