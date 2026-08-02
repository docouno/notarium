// The force-model accessors both layouts share: the client (ForceGraphCanvas)
// live sim and the server layout pass (layout.ts) run the exact same
// accessors, so every one lives here and only here. See ./consts for the shared
// tuning numbers and the client/server drift rationale.

import { SIZE_GAMMA, SIZE_MAX_R, SIZE_MIN_R, SIZE_UNIFORM_R } from './consts'

/** Repulsion scales with degree so densely-linked hubs (which otherwise
 *  collapse into an unreadable core) push their neighbourhood open while leaf
 *  nodes stay put. */
export const chargeStrength = (n: { degree?: number }) => -160 - (n.degree || 0) * 30

/** Radius for a metric value against the dataset max — the shared shape both
 *  the renderer and the layout's collision/link forces agree on. */
export const radiusFor = (metric: number, maxMetric: number, scale = 1): number => {
  if (maxMetric <= 0) {
    return SIZE_UNIFORM_R * scale
  }
  const t = Math.max(0, metric) / maxMetric
  return (SIZE_MIN_R + (SIZE_MAX_R - SIZE_MIN_R) * Math.pow(t, SIZE_GAMMA)) * scale
}

/** Anchor-ring radius for the group clustering force. */
export const clusterRingRadius = (nodeCount: number, spacing: number) =>
  26 * Math.sqrt(nodeCount) * spacing

/** Group keys → ring angle, exactly as the client derives them: unique keys,
 *  STRING-sorted (community ids arrive stringified), evenly spread. Clustering
 *  only engages with more than two groups — fewer reads better link-driven. */
export const clusterAngles = (groups: Iterable<string>): Map<string, number> => {
  const sorted = [...new Set(groups)].sort()
  return new Map(sorted.map((g, i) => [g, (i * 2 * Math.PI) / sorted.length]))
}
