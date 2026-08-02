import { noteHasTag } from '@notarium/core/tags'
import { dirSelected, folderOf } from '../../tree/tree'
import type { GraphView as Graph, GraphNodeView as GraphNode } from '../../wire'
import { idOf } from '../graphId'

// Every facet ANDs into "is this node visible". A selection of size 0 for a facet
// means no constraint on that axis.
export type GraphVisibilityFilters = {
  selected: Set<string> // folder paths (inclusion, subtree-cascading)
  selectedClusters: Set<number> // link-community ids (inclusion)
  communityMap: Map<string, number> | null
  conn: string // any | connected | isolated (total degree)
  dead: string // any | with | without (has unresolved outgoing)
  linksToGhost: Set<string>
  tag: string // any | tagged | untagged (from the node's own tags)
  tagSel: Set<string> // specific tags (folded), OR-matched
  inDeg: Map<string, number>
  minInDeg: number
}

// The filter mask: every facet ANDs into "is this node visible". null = no active
// constraint (the canvas skips the set lookups entirely) — returned when every node
// survives, so toggling a facet off restores the null fast-path exactly.
export const computeVisibleIds = (data: Graph, f: GraphVisibilityFilters): Set<string> | null => {
  const keep = (n: GraphNode) => {
    if (n.ghost) {
      return true
    } // missing-note placeholders are always shown
    // Folder filter (#93/#109 inclusion): with a selection, keep only nodes under a
    // selected subtree; empty = no constraint.
    if (f.selected.size > 0 && !dirSelected(f.selected, folderOf(n.filePath))) {
      return false
    }
    // Cluster filter — the link-community inclusion filter, available in any
    // grouping mode (composes with the folder filter). With a selection, keep only
    // nodes in a selected cluster; nodes outside any cluster drop when it's active.
    if (f.selectedClusters.size > 0) {
      const c = f.communityMap?.get(n.id)

      if (c === undefined || !f.selectedClusters.has(c)) {
        return false
      }
    }
    // Connections (total degree)
    const isolated = (n.degree || 0) === 0

    if (f.conn === 'connected' && isolated) {
      return false
    }
    if (f.conn === 'isolated' && !isolated) {
      return false
    }
    // Dead links (has unresolved outgoing)
    const hasDead = f.linksToGhost.has(n.id)

    if (f.dead === 'with' && !hasDead) {
      return false
    }
    if (f.dead === 'without' && hasDead) {
      return false
    }
    // Tags (#109): tri-state from the node's OWN tags (no lazy fetch), plus the
    // specific-tag multiselect — a node is kept if it carries ANY selected tag (OR),
    // matched case-insensitively + hierarchically (`ml` also matches `ml/nlp`).
    const nodeTags = n.ghost ? [] : (n.tags ?? [])

    if (f.tag === 'tagged' && nodeTags.length === 0) {
      return false
    }
    if (f.tag === 'untagged' && nodeTags.length > 0) {
      return false
    }
    if (f.tagSel.size > 0 && ![...f.tagSel].some((sel) => noteHasTag(nodeTags, sel))) {
      return false
    }
    // Hubs (min in-degree)
    if ((f.inDeg.get(n.id) || 0) < f.minInDeg) {
      return false
    }

    return true
  }
  const ids = new Set<string>()

  for (const n of data.nodes) {
    if (keep(n)) {
      ids.add(n.id)
    }
  }

  return ids.size === data.nodes.length ? null : ids
}

// What's actually on the canvas after the filters — the mini-stat cards show this
// live. Ghosts are always rendered, so the unresolved count is reported separately.
export const countShown = (
  data: Graph,
  visibleIds: Set<string> | null,
): { real: number; links: number } => {
  if (!visibleIds) {
    return { real: data.nodes.filter((n) => !n.ghost).length, links: data.links.length }
  }
  let real = 0

  for (const n of data.nodes) {
    if (!n.ghost && visibleIds.has(n.id)) {
      real++
    }
  }
  let links = 0

  for (const l of data.links) {
    if (visibleIds.has(idOf(l.source)) && visibleIds.has(idOf(l.target))) {
      links++
    }
  }

  return { real, links }
}
