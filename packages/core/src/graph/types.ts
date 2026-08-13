// Public graph edge and layout data shapes.
// canon: docs/core.md#graph-derivation

import type { GRAPH_GHOST_TARGET } from '../knowledgeStore'

export type GraphEdgeLike = {
  source: string
  target: string
  type: string
  [GRAPH_GHOST_TARGET]?: true
}

export type LayoutPositions = ReadonlyMap<string, { x: number; y: number }>

export type LayoutOptions = {
  /** Previous run's positions — warm start. Nodes found here keep their spot
   *  and the simulation only relaxes (low alpha); a mostly-new graph runs the
   *  full cold anneal instead. */
  positions?: LayoutPositions
  /** Node id → cluster key for the anchor-ring force (the client's "Group"
   *  clustering). Communities by default; null/absent keys anchor to centre,
   *  exactly like the live simulation does. */
  groupOf?: (nodeId: string) => string | null
  /** Yield to the event loop every N ticks so a big layout doesn't block the
   *  host (0 = run synchronously, for tests/tiny graphs). */
  yieldEvery?: number
  /** Host-owned cooperative yield. The server injects its process-global
   *  scheduler; engine-less/fake callers omit it and use a local macrotask. */
  yieldToHost?: () => Promise<void>
  /** Lifecycle cancellation for an obsolete layout. Checked between ticks, so
   *  both scheduler-backed and bare hosts stop at the next existing boundary. */
  signal?: AbortSignal
}

export type EnrichOptions = Pick<
  LayoutOptions,
  'positions' | 'yieldEvery' | 'yieldToHost' | 'signal'
>
