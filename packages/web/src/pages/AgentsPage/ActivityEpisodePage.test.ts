// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionEvents } from '@notarium/contract'

const harness = vi.hoisted(() => ({
  requests: [] as Array<{
    cursor?: string
    reject: (reason?: unknown) => void
    resolve: (value: unknown) => void
  }>,
  version: 0,
}))

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement('a', { href: to }, children),
  useParams: () => ({ id: 'session-race' }),
}))
vi.mock('./ActivityFrame', () => ({
  useActivityFrame: () => ({
    searchParams: new URLSearchParams(),
    sessionsVersion: harness.version,
    setDetailTitle: () => {},
    setState: () => {},
    state: {
      agent: null,
      group: 'none',
      outcome: 'all',
      q: null,
      show: 'all',
      tool: null,
    },
  }),
}))
vi.mock('../../services/api', () => {
  class ApiError extends Error {
    status?: number
  }

  return {
    ApiError,
    api: {
      agentSessionEventsGet: vi.fn(
        (_id: string, params: { cursor?: string }) =>
          new Promise((resolve, reject) => {
            harness.requests.push({ cursor: params.cursor, reject, resolve })
          }),
      ),
    },
  }
})

import { ActivityEpisodePage } from './ActivityEpisodePage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const event = (id: string) =>
  ({
    agent: null,
    at: '2099-08-05T10:55:00.000Z',
    class: 'user-doc',
    id,
    noteId: `note-${id}`,
    principal: null,
    revisionKind: 'write',
    sessionAttach: 'declared',
    sessionId: 'session-race',
    sessionName: 'Race session',
    space: 'main',
    title: id,
    type: 'write',
  }) as const

const page = (id: string, nextCursor: string | null): AgentSessionEvents => ({
  aggregates: null,
  events: [event(id)],
  hasMore: nextCursor != null,
  nextCursor,
  target: {
    active: true,
    calls: 4,
    complete: true,
    createdAt: '2099-08-05T10:00:00.000Z',
    id: 'session-race',
    kind: 'session',
    lastSeenAt: '2099-08-05T10:55:00.000Z',
    name: 'Race session',
    named: true,
    parentId: null,
    reads: 1,
    retained: true,
    writes: 3,
  },
  total: 4,
})

const settle = async () => {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('the live deep Activity window', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    harness.requests.length = 0
    harness.version = 0
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = async () => {
    await act(async () => root.render(createElement(ActivityEpisodePage)))
    await act(settle)
  }

  const resolve = async (index: number, value: AgentSessionEvents) => {
    await act(async () => {
      harness.requests[index].resolve(value)
      await settle()
    })
  }

  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    )
    expect(button).toBeDefined()
    await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(settle)
  }

  it('keeps N+1 against an out-of-order stale response and retries the same warm depth', async () => {
    await render()
    await resolve(0, page('initial', 'initial-cursor'))
    await click('Load older activity')
    expect(harness.requests[1].cursor).toBe('initial-cursor')

    harness.version = 1
    await render()
    expect(harness.requests[2].cursor).toBeUndefined()
    await resolve(2, page('new-first', 'new-cursor'))
    expect(harness.requests[3].cursor).toBe('new-cursor')
    await resolve(3, page('new-second', null))
    expect(container.textContent).toContain('new-first')
    expect(container.textContent).toContain('new-second')

    await resolve(1, page('old-second', null))
    expect(container.textContent).not.toContain('old-second')
    expect(container.textContent).toContain('new-second')

    harness.version = 2
    await render()
    await act(async () => {
      harness.requests[4].reject(new Error('temporary failure'))
      await settle()
    })
    expect(container.textContent).toContain('new-first')
    expect(container.textContent).toContain('Couldn’t load this activity episode.')

    await click('Retry')
    expect(harness.requests[5].cursor).toBeUndefined()
    await resolve(5, page('retry-first', 'retry-cursor'))
    expect(harness.requests[6].cursor).toBe('retry-cursor')
    await resolve(6, page('retry-second', null))
    expect(container.textContent).toContain('retry-first')
    expect(container.textContent).toContain('retry-second')
    expect(container.textContent).not.toContain('new-first')
  })

  it('loads depth ten with exactly one request per committed page', async () => {
    await render()
    await resolve(0, page('page-1', 'c2'))

    for (let depth = 2; depth <= 10; depth += 1) {
      await click('Load older activity')
      expect(harness.requests.at(-1)?.cursor).toBe(`c${depth}`)
      await resolve(depth - 1, page(`page-${depth}`, depth === 10 ? null : `c${depth + 1}`))
    }

    expect(harness.requests).toHaveLength(10)
    expect(harness.requests.map((request) => request.cursor)).toEqual([
      undefined,
      'c2',
      'c3',
      'c4',
      'c5',
      'c6',
      'c7',
      'c8',
      'c9',
      'c10',
    ])
    expect(container.textContent).toContain('page-1')
    expect(container.textContent).toContain('page-10')
  })
})
