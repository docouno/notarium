// Deploy-time graph-channel toggle: the engine ships this channel ON (wGraph 0.5); this
// pins it OFF for deployments, GRAPH_BOOST=on opts back in. A separate TESTED pure fn, not
// an inline ternary in main.ts (a top-level-await entry no test reaches) — inlining drops
// coverage, then a flipped default ships a search regression under a green suite.
// canon: docs/search.md#graph-channel-hub-robust-1-hop
import type { SearchTuning } from '@notarium/engine'

export const graphSearchTuning = (
  graphBoostEnv: string | undefined,
): Partial<SearchTuning> | undefined => {
  const on = (graphBoostEnv ?? 'off') !== 'off'
  return on ? undefined : { wGraph: 0 }
}

/** Migration-free rollback for the engine-local parsed-wikilink cache. It ships
 * ON; only the literal `off` returns both engine derivations to their atomic
 * full-body reference path after process restart. */
export const wikilinkParseCacheFromEnv = (raw: string | undefined): boolean =>
  (raw ?? 'on') !== 'off'
