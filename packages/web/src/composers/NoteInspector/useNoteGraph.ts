import { useEffect, useMemo, useState } from 'react'
import { idOf } from '../../libs/graph/graphId'
import type { GraphView as Graph, GraphLink, GraphNodeView as GraphNode } from '../../libs/wire'
import { api } from '../../services/api'

// One link as the inspector's link panels consume it: the note on the other end
// plus the relation type. Backlinks and outgoing Links are the two directions of
// the same edge set, so they share this shape — a ghost target carries the
// create-from-ghost prefill on its node (#25).
export type GraphLinkRef = { node: GraphNode; type: string }

export type NoteGraph = {
  data: Graph | null
  error: string | null
  depth: number
  setDepth: (d: number) => void
  /** The active note's neighbourhood, sliced to `depth` hops, laid out fresh as a
   *  star (server positions stripped) — what the Graph panel renders. */
  slice: { nodes: GraphNode[]; links: Graph['links'] }
  /** Incoming edges (notes that point AT the active note), title-sorted. */
  backlinks: GraphLinkRef[]
  /** Outgoing edges (the active note's own [[wikilinks]]), in body order — the
   *  read-model patches these from the live body so they're honest, unlike the
   *  engine's lagging relation index (#35/#60). */
  outgoing: GraphLinkRef[]
}

// The single source of graph data for the note inspector: it fetches the whole
// /api/graph once and derives every panel's slice from it (the graph square, the
// backlinks list, the outgoing links list). Hoisting the fetch here — above the
// individual panels — means the three link-aware panels share ONE request even
// when the user splits them across separate aside groups.
export const useNoteGraph = (activeId: string | null | undefined, space: string): NoteGraph => {
  const [data, setData] = useState<Graph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [depth, setDepth] = useState(1)

  useEffect(() => {
    let alive = true
    setData(null)
    setError(null)
    api
      .graphGet(space)
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [space])

  // Undirected adjacency over the full graph, used for the BFS slice.
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>()

    if (!data) {
      return m
    }
    for (const l of data.links) {
      const s = idOf(l.source)
      const t = idOf(l.target)

      if (!m.has(s)) {
        m.set(s, new Set())
      }
      if (!m.has(t)) {
        m.set(t, new Set())
      }
      m.get(s)!.add(t)
      m.get(t)!.add(s)
    }

    return m
  }, [data])

  // Slice to the nodes within `depth` hops of the active note.
  const slice = useMemo(() => {
    if (!data || !activeId) {
      return { nodes: [] as GraphNode[], links: [] as Graph['links'] }
    }
    const keep = new Set([activeId])
    let frontier = [activeId]

    for (let d = 0; d < depth; d++) {
      const next: string[] = []

      for (const id of frontier) {
        for (const nb of adj.get(id) || []) {
          if (!keep.has(nb)) {
            keep.add(nb)
            next.push(nb)
          }
        }
      }
      frontier = next
    }
    // Strip the server's full-graph positions (#62): this panel lays its slice
    // out as a fresh star around the active note — a handful of nodes spread
    // across global-map coordinates would be the wrong shape entirely.
    const nodes = data.nodes
      .filter((n) => keep.has(n.id))
      .map((n) => {
        const copy = { ...n }
        delete copy.x
        delete copy.y
        return copy
      })
    const present = new Set(nodes.map((n) => n.id))
    const links = data.links
      .filter((l) => present.has(idOf(l.source)) && present.has(idOf(l.target)))
      .map((l) => ({ ...l }))
    return { nodes, links }
  }, [data, activeId, depth, adj])

  // Incoming links: notes that point AT the active one. Title-sorted (no
  // meaningful body order exists across many source notes).
  const backlinks = useMemo<GraphLinkRef[]>(
    () =>
      directedLinks(data, activeId, 'in').sort((a, b) => a.node.title.localeCompare(b.node.title)),
    [data, activeId],
  )

  // Outgoing links: the active note's own [[wikilinks]]. Kept in graph order,
  // which is the note's body order — the read-model derives these edges straight
  // from the live body (deriveNoteEdges), so the order is the order they appear.
  const outgoing = useMemo<GraphLinkRef[]>(
    () => directedLinks(data, activeId, 'out'),
    [data, activeId],
  )

  return { data, error, depth, setDepth, slice, backlinks, outgoing }
}

// Collect the edges touching `activeId` in one direction, resolving the note on
// the far end. Deduped by (other-note, relation type) — the same pair can be
// linked under one type more than once across the graph payload.
const directedLinks = (
  data: Graph | null,
  activeId: string | null | undefined,
  dir: 'in' | 'out',
): GraphLinkRef[] => {
  if (!data || !activeId) {
    return []
  }
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const out: GraphLinkRef[] = []

  for (const l of data.links) {
    const near = dir === 'in' ? idOf(l.target) : idOf(l.source)

    if (near !== activeId) {
      continue
    }
    const far = dir === 'in' ? idOf(l.source) : idOf(l.target)
    const key = `${far}|${l.type}`

    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const node = byId.get(far)

    if (node) {
      out.push({ node, type: l.type })
    }
  }

  return out
}

export type { GraphLink }
