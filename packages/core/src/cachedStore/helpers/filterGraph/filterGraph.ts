// Pure graph transforms for the read-model: no `this`, no snapshot — deterministic
// and testable in isolation.

import type { Graph } from '../../../knowledgeStore'
import { isVisibleOn, SURFACE } from '../../../visibility'

/** Strip hidden-class nodes (and any edge touching them) from an already
 *  shaped graph — the degraded error-mode path serves the engine's graph
 *  directly, which is unfiltered.
 *  @see docs/architecture.md#p11 */
export const filterGraphForUser = (graph: Graph): Graph => {
  const hidden = new Set(
    graph.nodes.filter((n) => !n.ghost && !isVisibleOn(SURFACE.graph, n.class)).map((n) => n.id),
  )

  if (!hidden.size) {
    return graph
  }
  const links = graph.links.filter((l) => !hidden.has(l.source) && !hidden.has(l.target))
  // A ghost legitimately exists only if a SURVIVING (visible-source) edge
  // points at it. After dropping a hidden note's edges, an orphan ghost would
  // otherwise survive carrying the link-text the user wrote inside a hidden
  // agent-memory body (e.g. [[Secret Codename]]) — a leak onto the user graph
  // in the degraded error path. Re-derive reachable ghosts from filtered
  // links (the snapshot path already keeps this invariant).
  const liveTargets = new Set(links.map((l) => l.target))
  const nodes = graph.nodes
    .filter((n) => !hidden.has(n.id) && (!n.ghost || liveTargets.has(n.id)))
    .map((n) => {
      // A ghost reached from BOTH a hidden and a visible note survives (the visible
      // edge keeps it), but its backlink `sources` still lists the hidden note's
      // id+title — scrub those so an agent-memory note's identity never rides out on
      // the broken-links backlinks. Untouched ghosts keep object identity.
      if (!n.ghost || !n.sources?.some((s) => s.id && hidden.has(s.id))) {
        return n
      }

      return { ...n, sources: n.sources.filter((s) => !s.id || !hidden.has(s.id)) }
    })
  return { nodes, links }
}
