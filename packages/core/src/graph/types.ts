// Shared types for the graph service: edge identity/dedup shapes, the wikilink
// resolve index and its aliases (graph.ts), plus the server-side layout/enrich
// option and position shapes (layout.ts/enrich.ts). Split out so the impl files
// carry only functions.
// canon: docs/core.md#graph-derivation

export type GraphEdgeLike = {
  source: string
  target: string
  type: string
}

/** A ghost's identity + create-from-ghost prefill, as the read-model
 *  registry keeps it. Degree and backlink sources are derived at shape time. */
export type GhostStub = {
  id: string
  title: string
  target: string
  prefillTitle: string
}

/** slug key → node id. Keys cover every way a [[wikilink]] names a note: the
 *  slugged full path, the slugged filename, the slugged title, the note's custom
 *  display slug, and — so a rename never breaks inbound links —
 *  the slug of each past name (alias). */
export type LinkIndex = Map<string, string>

/** A folder's past path → its current path. Both RAW, space-relative;
 *  slugified at index-build. Lets [[oldpath/note]] resolve after a folder rename/
 *  move: the note's current key is `current/…`, this registers the `alias/…` key
 *  too. Folder identity lives server-side (marker/meta-DB), so the map is injected
 *  only where the read-model builds the index — the engine passes none. */
export type FolderAlias = { current: string; alias: string }

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
}

export type EnrichOptions = Pick<LayoutOptions, 'positions' | 'yieldEvery'>
