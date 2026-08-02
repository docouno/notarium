import { useCallback, useMemo } from 'react'
import { SIZE_GAMMA, SIZE_MAX_R, SIZE_MIN_R, SIZE_UNIFORM_R } from '@notarium/core/force-model'
import { idOf } from '../../../../libs/graph/graphId'
import type { GraphInput, SimNode } from '../../types'

/** Node sizing over the *current* slice (so the local-graph panel sizes by its own
 *  neighbourhood, not the whole base). Owns the degree maps, the active "Size by"
 *  metric and the radius mapping — `radiusOf` is shared by the renderer, the click
 *  hit-area and the collision force so all three agree. */
export const useNodeMetrics = (
  graph: GraphInput,
  sizeBy: string,
  sizeData: Map<string, number> | null,
  sizeScale: number,
) => {
  // In- and out-degree over the current slice. in = links pointing AT a node (how
  // referenced), out = links it makes; their sum is total connections.
  const deg = useMemo(() => {
    const inn = new Map<string, number>()
    const out = new Map<string, number>()

    for (const l of graph.links) {
      const s = idOf(l.source)
      const t = idOf(l.target)
      out.set(s, (out.get(s) || 0) + 1)
      inn.set(t, (inn.get(t) || 0) + 1)
    }

    return { inn, out }
  }, [graph])
  const inDeg = deg.inn // alias kept for the hub-label set (most-referenced)

  // The value driving a node's size under the active "Size by" mode. Connections
  // (total degree) is the default — it matches the lines you can count touching a
  // node; backlinks (in-degree) is the authority lens; words is content mass (lazy,
  // fed in via sizeData). Uniform short-circuits in radiusOf.
  const metricOf = useCallback(
    (n: SimNode) => {
      if (sizeBy === 'words') {
        return sizeData?.get(n.id) || 0
      }
      if (sizeBy === 'references') {
        return deg.inn.get(n.id) || 0
      }
      // 'degree' = the node's FULL-vault connectivity (the API's n.degree), independent
      // of the rendered slice — so the local-graph panel sizes by how connected each
      // note is overall, not just within the few hops it shows.
      if (sizeBy === 'degree') {
        return n.degree || 0
      }

      return (deg.inn.get(n.id) || 0) + (deg.out.get(n.id) || 0) // connections (this slice)
    },
    [sizeBy, sizeData, deg],
  )

  // Normalise against the dataset max so any metric maps into the same radius gamut.
  const maxMetric = useMemo(() => {
    if (sizeBy === 'uniform') {
      return 0
    }
    let m = 0

    for (const n of graph.nodes) {
      const v = metricOf(n)

      if (v > m) {
        m = v
      }
    }

    return m
  }, [graph, metricOf, sizeBy])

  // Radius = floor + range·(value/max)^gamma, times the user's overall scale. Shared
  // by the renderer, the click hit-area and the collision force so all three agree.
  const radiusOf = useCallback(
    (n: SimNode) => {
      if (sizeBy === 'uniform' || maxMetric <= 0) {
        return SIZE_UNIFORM_R * sizeScale
      }
      const t = (metricOf(n) || 0) / maxMetric
      return (SIZE_MIN_R + (SIZE_MAX_R - SIZE_MIN_R) * Math.pow(t, SIZE_GAMMA)) * sizeScale
    },
    [sizeBy, metricOf, maxMetric, sizeScale],
  )

  return { deg, inDeg, metricOf, maxMetric, radiusOf }
}
