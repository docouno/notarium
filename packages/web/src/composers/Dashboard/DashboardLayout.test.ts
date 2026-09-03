// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEYS } from '../../libs/storageKeys'
import type * as DashboardData from './useDashboardData'

const harness = vi.hoisted(() => ({
  feed: {} as Record<string, unknown>,
  calls: [] as Array<[string, string, string]>,
}))

vi.mock('react-router', async () => {
  const { createElement: h } = await import('react')

  return {
    Link: (props: { to: string; children?: unknown; className?: string }) =>
      h('a', { href: props.to, className: props.className }, props.children as never),
    Outlet: () => null,
    useLocation: () => ({ pathname: '/s/work' }),
    useOutletContext: () => undefined,
  }
})
vi.mock('../SpaceProvider', () => ({
  useSpace: () => ({ space: 'work', spaceTransition: null }),
}))
vi.mock('../NotesProvider', () => ({
  useNotes: () => ({ tree: { stats: { total: 3, week: 1 } }, openNote: () => undefined }),
}))
vi.mock('../ProjectsProvider', () => ({ useProjects: () => ({ projects: [] }) }))
vi.mock('../Splash', () => ({ Splash: () => null }))
vi.mock('./useDashboardData', async (importOriginal) => ({
  ...(await importOriginal<typeof DashboardData>()),
  useDashboardData: () => ({
    activity: null,
    activityResolved: false,
    graph: null,
    health: null,
    recent: [],
    projects: [],
    tags: null,
    loading: true,
  }),
}))
vi.mock('./useDashboardActivityFeed', () => ({
  useDashboardActivityFeed: (space: string, group: string, preferredScope: string) => {
    harness.calls.push([space, group, preferredScope])
    return harness.feed
  },
}))

import { DashboardLayout } from './DashboardLayout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const feed = (gate: { resolved: boolean; canScope: boolean; scope: 'all' | 'mine' }) => ({
  group: 'note',
  scope: gate.scope,
  overview: null,
  gate: null,
  gateResolved: gate.resolved,
  canScope: gate.canScope,
  loading: false,
  invalidated: false,
  rebuilding: false,
  stale: false,
  error: null,
  recover: vi.fn(),
  retry: vi.fn(),
})

describe('DashboardLayout author scope toggle', () => {
  let container: HTMLDivElement
  let root: Root

  const render = () => act(() => root.render(createElement(DashboardLayout)))
  const scopeControl = () =>
    container.querySelector<HTMLElement>('[role="group"][aria-label="Activity author scope"]')
  const segment = (label: string) =>
    [...(scopeControl()?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === label,
    )

  beforeEach(() => {
    localStorage.clear()
    harness.calls = []
    harness.feed = feed({ resolved: true, canScope: true, scope: 'all' })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('paints the clicked scope in the same frame, before the gate re-resolves', () => {
    render()
    expect(segment('Everyone')?.getAttribute('aria-pressed')).toBe('true')
    expect(segment('Mine')?.getAttribute('aria-pressed')).toBe('false')

    // The feed mock keeps answering with the OLD resolved scope: the segment must
    // not wait for it.
    act(() => segment('Mine')!.click())

    expect(segment('Mine')?.getAttribute('aria-pressed')).toBe('true')
    expect(segment('Everyone')?.getAttribute('aria-pressed')).toBe('false')
    expect(harness.calls.at(-1)).toEqual(['work', 'note', 'mine'])
    expect(localStorage.getItem(STORAGE_KEYS.dashboardActivityScope)).toBe('mine')
  })

  it('keeps the control mounted and pressed through the slice reset the click causes', () => {
    render()
    act(() => segment('Mine')!.click())

    // The click resets the feed slice: the gate is unresolved until Mine publishes.
    harness.feed = feed({ resolved: false, canScope: false, scope: 'all' })
    render()

    expect(scopeControl()).not.toBeNull()
    expect(segment('Mine')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('shows no toggle while the gate has not allowed a choice', () => {
    harness.feed = feed({ resolved: true, canScope: false, scope: 'all' })
    render()
    expect(scopeControl()).toBeNull()

    harness.feed = feed({ resolved: false, canScope: false, scope: 'all' })
    render()
    expect(scopeControl()).toBeNull()
  })
})
