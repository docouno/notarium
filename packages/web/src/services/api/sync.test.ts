import { afterEach, describe, expect, it, vi } from 'vitest'

import { syncApi } from './sync'

class FakeEventSource {
  static last: FakeEventSource | null = null

  readonly url: string
  readyState = 1
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.last = this
  }

  addEventListener = vi.fn()
  close = vi.fn()
}

afterEach(() => {
  FakeEventSource.last = null
  vi.unstubAllGlobals()
})

describe('sync events transport', () => {
  it('reports every successful EventSource open so reconnect can advance its epoch', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const onOpen = vi.fn()

    syncApi.events('space', vi.fn(), undefined, undefined, undefined, undefined, undefined, onOpen)
    FakeEventSource.last?.onopen?.({} as Event)

    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('subscribes to owner-scoped agent-session invalidation', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const onAgentSessions = vi.fn()

    syncApi.events('space', vi.fn(), undefined, undefined, undefined, undefined, onAgentSessions)

    expect(FakeEventSource.last?.addEventListener).toHaveBeenCalledWith(
      'agent-sessions',
      expect.any(Function),
    )
    const handler = FakeEventSource.last?.addEventListener.mock.calls.find(
      ([event]) => event === 'agent-sessions',
    )?.[1] as (() => void) | undefined
    handler?.()
    expect(onAgentSessions).toHaveBeenCalledOnce()
  })

  it('multiplexes sorted supplemental spaces onto the one active EventSource', () => {
    vi.stubGlobal('EventSource', FakeEventSource)

    syncApi.events(
      'active',
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ['foreign-b', 'active', 'foreign-a', 'foreign-b'],
    )

    expect(FakeEventSource.last?.url).toBe('/api/s/active/events?watch=foreign-a%2Cforeign-b')
  })

  it('delivers supplemental changed frames only through the Context callback', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const ordinary = vi.fn()
    const context = vi.fn()

    syncApi.events(
      'active',
      ordinary,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ['foreign'],
      context,
    )
    const handler = FakeEventSource.last?.addEventListener.mock.calls.find(
      ([event]) => event === 'context-changed',
    )?.[1] as ((event: MessageEvent) => void) | undefined

    handler?.({
      data: JSON.stringify({
        sourceSpace: 'foreign-id',
        event: { type: 'changed', upserts: ['n'], removed: [], folders: [] },
      }),
    } as MessageEvent)
    expect(context).toHaveBeenCalledWith(
      { type: 'changed', upserts: ['n'], removed: [], folders: [] },
      'foreign-id',
    )
    expect(ordinary).not.toHaveBeenCalled()
  })

  it('reports readiness only from the server marker and preserves reconnect identity', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const onReady = vi.fn()

    syncApi.events(
      'active',
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ['foreign'],
      undefined,
      onReady,
    )
    const ready = FakeEventSource.last?.addEventListener.mock.calls.find(
      ([event]) => event === 'ready',
    )?.[1] as (() => void) | undefined

    FakeEventSource.last?.onopen?.({} as Event)
    expect(onReady).not.toHaveBeenCalled()
    ready?.()
    expect(onReady).toHaveBeenLastCalledWith(false)

    FakeEventSource.last?.onopen?.({} as Event)
    ready?.()
    expect(onReady).toHaveBeenLastCalledWith(true)
  })

  it('bounds the encoded watch query before EventSource sees the request', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const spaces = Array.from(
      { length: 250 },
      (_, index) => `${String(index).padStart(3, '0')}-${'x'.repeat(60)}`,
    )

    syncApi.events(
      'active',
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      spaces,
    )

    expect(FakeEventSource.last?.url.length ?? Number.POSITIVE_INFINITY).toBeLessThan(4_200)
  })
})
