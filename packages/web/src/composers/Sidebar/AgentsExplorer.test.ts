// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeAgentRolesResponse } from '@notarium/contract'

const harness = vi.hoisted(() => ({
  api: {
    agentRolesGet: vi.fn(),
    agentSkillsGet: vi.fn(),
    agentSessionsGet: vi.fn(),
  },
  version: 0,
  // Identity-stable, like the provider's own memo: every listing effect keys on it.
  scope: { spaceId: 'space-team' },
}))

vi.mock('../../services/api', () => ({ api: harness.api }))
vi.mock('../AuthProvider', () => ({ useAuth: () => ({ me: { username: 'maya' } }) }))
vi.mock('../SpaceProvider', () => ({
  useSpace: () => ({
    space: 'team',
    spaces: [{ id: 'space-team', slug: 'team', displayName: 'Team' }],
    personalSpace: null,
  }),
}))
vi.mock('./ExplorerVirtualRows', () => ({ ExplorerVirtualRows: () => null }))
vi.mock('./MemoryTree', () => ({ MemoryTree: () => null }))
vi.mock('../AgentsExplorerProvider', async () => {
  const { useCallback, useState } = await import('react')

  return {
    agentsExplorerGroupsStorageKey: (owner: string, spaceId: string) =>
      `agents-explorer:groups:${owner}:${spaceId}`,
    useAgentsExplorer: () => {
      const [cache, setCache] = useState<Record<string, unknown>>({
        roles: null,
        skills: null,
        memory: null,
        sessions: null,
      })
      const setAbilityPage = useCallback(
        (dataset: string, pageValue: unknown) =>
          setCache((current) => ({ ...current, [dataset]: pageValue })),
        [],
      )
      const setSessionPage = useCallback(
        (pageValue: unknown) => setCache((current) => ({ ...current, sessions: pageValue })),
        [],
      )

      return {
        dataset: 'roles',
        version: harness.version,
        cache,
        scope: harness.scope,
        setAbilityPage,
        setSessionPage,
      }
    },
  }
})
vi.mock('react-router', async () => {
  const { createElement: h } = await import('react')

  return {
    useLocation: () => ({ pathname: '/agents/abilities/roles' }),
    Link: (props: { to: string; children?: unknown }) =>
      h('a', { href: props.to }, props.children as never),
  }
})

import { AgentsExplorer } from './AgentsExplorer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A sentinel already inside the observer's margin — the real observer reports one
 *  the moment it is observed, which is how a parked continuation resumes with no
 *  action from the user. Delivery is its own task, never a call back inside
 *  `observe`. */
class InViewObserver {
  private nodes = new Set<Element>()

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(node: Element) {
    this.nodes.add(node)
    queueMicrotask(() => {
      if (!this.nodes.has(node)) {
        return
      }
      this.callback(
        [{ isIntersecting: true, target: node } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      )
    })
  }

  unobserve(node: Element) {
    this.nodes.delete(node)
  }

  disconnect() {
    this.nodes.clear()
  }
}

const page = (nextCursor: string | null): MeAgentRolesResponse =>
  ({
    items: [
      {
        source: 'owned',
        locator: {
          source: 'owned',
          kind: 'role',
          packageId: 'Reviewer1234',
          location: { scope: 'space', spaceId: 'space-team' },
        },
        title: 'Reviewer',
        name: 'Reviewer1234',
        description: 'Reviews',
        noteId: 'note-reviewer',
        origin: 'custom',
        enabled: true,
      },
    ],
    projects: [],
    activeRole: null,
    nextCursor,
    filteredTotal: 1,
    total: 1,
    facets: null,
    truncated: false,
  }) as unknown as MeAgentRolesResponse

describe('the Agents explorer parks a failed continuation until the user asks again', () => {
  let container: HTMLDivElement
  let root: Root
  let cursorCalls: number

  const render = () =>
    act(async () =>
      root.render(
        createElement(AgentsExplorer, {
          activeId: null,
          scrollRef: { current: null },
          visible: true,
          headH: 0,
        }),
      ),
    )

  beforeEach(async () => {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = InViewObserver
    harness.version = 0
    cursorCalls = 0
    harness.api.agentRolesGet.mockReset()
    harness.api.agentRolesGet.mockImplementation(async (query: { cursor?: string }) => {
      if (query.cursor) {
        cursorCalls += 1
        throw new Error('offline')
      }

      return page('cursor-2')
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await render()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const parked = () => document.querySelector('[data-testid="agents-explorer-more-error"]') !== null

  it('leaves a background refresh from moving the parked continuation', async () => {
    expect(cursorCalls).toBe(1)
    expect(parked()).toBe(true)

    // A live CHANGED frame, a reconnect, this tab's own save — every one of them
    // moves the reload key. The tree re-reads at the same depth; the continuation
    // the user has NOT retried stays where it stopped.
    harness.version += 1
    await render()

    expect(cursorCalls).toBe(1)
    expect(parked()).toBe(true)
  })

  it('asks again when the user presses Retry', async () => {
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry',
    )

    expect(retry).toBeDefined()
    await act(async () => retry!.click())

    expect(cursorCalls).toBe(2)
  })
})
