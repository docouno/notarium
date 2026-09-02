// Installed through page.addInitScript: keep this function self-contained so
// Playwright can serialize it into the browser before application code runs.
export const installControlledEventSource = () => {
  class ControlledEventSource extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSED = 2
    readonly url: string
    readonly withCredentials = false
    readyState = ControlledEventSource.OPEN
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null

    constructor(url: string | URL) {
      super()
      this.url = String(url)
      ;(
        window as typeof window & { __notariumEventSources?: ControlledEventSource[] }
      ).__notariumEventSources?.push(this)
    }

    close() {
      this.readyState = ControlledEventSource.CLOSED
    }
  }

  Object.defineProperty(window, '__notariumEventSources', {
    configurable: true,
    value: [] as ControlledEventSource[],
  })
  Object.defineProperty(window, 'EventSource', {
    configurable: true,
    value: ControlledEventSource,
  })
}
