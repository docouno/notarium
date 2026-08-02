// Ambient types for the canvas test-hook the E2E harness arms (see
// ForceGraphCanvas's window.__graphTest block and test/e2e/fixtures.ts).
export {}

type GraphTestHandle = {
  nodes: () => { id: string; ghost: boolean; title: string }[]
  click: (id: string) => void
  hover: (id: string | null) => void
  focusId: () => string | null
  ready: () => boolean
  settle: () => void
}

declare global {
  interface Window {
    __NOTARIUM_TEST__?: boolean
    __graphTest?: GraphTestHandle
    /** Set by pwa.spec.ts's synthetic beforeinstallprompt when prompt() is called. */
    __pwaPrompted?: boolean
  }
}
