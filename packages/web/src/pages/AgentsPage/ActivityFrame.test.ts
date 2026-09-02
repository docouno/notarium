// @vitest-environment jsdom

import { act, createElement, type ReactNode, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  asideOpen: true,
  version: 0,
  requests: [] as Array<{
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
    signal?: AbortSignal
    settled: boolean
  }>,
}))

vi.mock('../../composers/AgentsExplorerProvider', () => ({
  useAgentsExplorer: () => ({ versions: { sessions: harness.version } }),
}))
vi.mock('../../composers/ChromeProvider', () => ({
  useChrome: () => ({ asideOpen: harness.asideOpen }),
}))
vi.mock('../../composers/SyncProvider', () => ({ CHANGED_COALESCE_MS: 10 }))
vi.mock('./AgentsProvider', () => ({
  RECURRING_MISS_MIN: 2,
  useAgentsShell: () => ({ setBreadcrumbTail: () => {} }),
}))
vi.mock('react-router', () => ({
  Outlet: ({ context }: { context: { sessionsVersion: number } }) =>
    createElement('div', { 'data-testid': 'activity-version' }, context.sessionsVersion),
  useOutletContext: () => ({}),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), () => {}],
}))
vi.mock('./AgentsPanel', () => ({
  AgentsPanel: ({ panels }: { panels: Array<{ id: string; render: () => ReactNode }> }) =>
    createElement('div', {}, panels.find((panel) => panel.id === 'diagnostics')?.render()),
}))
vi.mock('../../services/api', () => ({
  api: {
    agentSessionEventsGet: vi.fn(
      (_id: string, _params: unknown, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          const request = {
            resolve: (value: unknown) => {
              request.settled = true
              resolve(value)
            },
            reject: (reason?: unknown) => {
              request.settled = true
              reject(reason)
            },
            signal,
            settled: false,
          }
          harness.requests.push(request)
        }),
    ),
  },
}))

import { ActivityFrame } from './ActivityFrame'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const aggregates = (query: string) => ({
  aggregates: {
    retrieval: {
      totalQueries: 1,
      missCount: 0,
      top: [
        {
          query,
          tool: 'search',
          count: 1,
          misses: 0,
          lastAt: '2099-08-05T10:54:00.000Z',
        },
      ],
      misses: [],
    },
    agents: [],
    recurringProblems: [],
  },
})

const settleEffects = async () => {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('the live Activity frame', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    harness.asideOpen = true
    harness.version = 0
    harness.requests.length = 0
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = async () => {
    await act(async () => root.render(createElement(StrictMode, {}, createElement(ActivityFrame))))
    await act(settleEffects)
  }

  const rerenderAt = async (version: number) => {
    harness.version = version
    await render()
    await act(settleEffects)
  }

  const activeRequests = () =>
    harness.requests.filter((request) => !request.settled && !request.signal?.aborted)

  it('keeps whole-history diagnostics single-flight, trails the newest revision and retries warm', async () => {
    await render()
    expect(harness.requests).toHaveLength(1)
    expect(activeRequests()).toHaveLength(1)

    await rerenderAt(1)
    await rerenderAt(2)
    expect(container.querySelector('[data-testid="activity-version"]')?.textContent).toBe('2')
    expect(activeRequests()).toHaveLength(1)

    await act(async () => {
      activeRequests()[0].resolve(aggregates('superseded'))
      await settleEffects()
    })
    expect(activeRequests()).toHaveLength(1)
    expect(container.textContent).not.toContain('superseded')

    await act(async () => {
      activeRequests()[0].resolve(aggregates('newest'))
      await settleEffects()
    })
    expect(harness.requests).toHaveLength(2)
    expect(container.textContent).toContain('newest')

    await rerenderAt(3)
    expect(activeRequests()).toHaveLength(1)
    await act(async () => {
      activeRequests()[0].reject(new Error('temporary failure'))
      await settleEffects()
    })
    expect(container.textContent).toContain('newest')
    expect(container.textContent).toContain('Couldn’t refresh retrieval diagnostics.')

    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry',
    )
    await act(async () => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(activeRequests()).toHaveLength(1)

    await act(async () => {
      activeRequests()[0].resolve(aggregates('retried'))
      await settleEffects()
    })
    expect(container.textContent).toContain('retried')
    expect(container.textContent).not.toContain('Couldn’t refresh retrieval diagnostics.')
  })

  it('keeps never-loaded diagnostics idle across revisions and reads only when opened', async () => {
    harness.asideOpen = false
    await render()
    expect(harness.requests).toHaveLength(0)

    await rerenderAt(1)
    await rerenderAt(2)
    expect(harness.requests).toHaveLength(0)

    harness.asideOpen = true
    await render()
    expect(activeRequests()).toHaveLength(1)
    await act(async () => {
      activeRequests()[0].resolve(aggregates('opened-at-newest'))
      await settleEffects()
    })
    expect(container.textContent).toContain('opened-at-newest')
  })

  it('advances at the fixed coalescing bound during sustained revisions', async () => {
    harness.asideOpen = false
    vi.useFakeTimers()
    try {
      await act(async () => root.render(createElement(ActivityFrame)))
      expect(container.querySelector('[data-testid="activity-version"]')?.textContent).toBe('0')

      harness.version = 1
      await act(async () => root.render(createElement(ActivityFrame)))
      await act(async () => vi.advanceTimersByTimeAsync(9))
      expect(container.querySelector('[data-testid="activity-version"]')?.textContent).toBe('0')

      harness.version = 2
      await act(async () => root.render(createElement(ActivityFrame)))
      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(container.querySelector('[data-testid="activity-version"]')?.textContent).toBe('2')
    } finally {
      vi.useRealTimers()
    }
  })
})
