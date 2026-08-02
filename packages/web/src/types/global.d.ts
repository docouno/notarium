// Ambient globals the SPA installs at runtime. Kept out of component code so the
// window augmentation lives in one place.
export {}

/** Test-only handle the graph canvas exposes so E2E specs can drive it by node id
 *  (set only when window.__NOTARIUM_TEST__ is on). */
type GraphTestHandle = {
  nodes: () => Array<{ id: string; ghost: boolean; title: string }>
  click: (id: string) => void
  hover: (id: string | null) => void
  focusId: () => string | null
  ready: () => boolean
  settle: () => void
}

declare global {
  interface Window {
    /** Set by the E2E harness to switch the graph into deterministic test mode. */
    __NOTARIUM_TEST__?: boolean
    __graphTest?: GraphTestHandle
  }
}
