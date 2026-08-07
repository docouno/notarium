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

    syncApi.events('space', vi.fn(), undefined, undefined, undefined, undefined, onOpen)
    FakeEventSource.last?.onopen?.({} as Event)

    expect(onOpen).toHaveBeenCalledOnce()
  })
})
