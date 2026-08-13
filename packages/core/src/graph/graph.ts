// Pure graph edge derivation and snapshot shaping over the shared resolver.
// canon: docs/core.md#graph-derivation

import type {
  Graph,
  GraphGhostNode,
  GraphHealth,
  GraphHealthEdge,
  GraphLink,
  GraphRealNode,
  NoteMeta,
  ResolvedVia,
} from '../knowledgeStore'
import { GRAPH_GHOST_TARGET, RESOLVED_VIA } from '../knowledgeStore'
import { parseWikilinks } from '../libs/markdown'
import { deKebab } from '../libs/slug'
import type { GhostStub, LinkIndex } from '../referenceResolver'
import { resolveLink } from '../referenceResolver'
import type { GraphEdgeLike } from './types'

type GraphHealthSource = { id?: string; title: string; folder: string }

const graphHealthCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const compareHealthText = (a: string, b: string): number => graphHealthCollator.compare(a, b)
const compareGhostSources = (a: GraphHealthSource, b: GraphHealthSource): number =>
  compareHealthText(a.folder, b.folder) ||
  compareHealthText(a.title, b.title) ||
  compareHealthText(a.id ?? '', b.id ?? '')

/** Identity of an edge: same source, relation type and target. */
export const edgeKey = (e: GraphEdgeLike): string =>
  `${e.source}\u0000${e.type}\u0000${e.target}\u0000${e[GRAPH_GHOST_TARGET] ? 'ghost' : 'real'}`

/** Drop duplicate edges, keeping first occurrence order stable. */
export const dedupeEdges = <T extends GraphEdgeLike>(edges: T[]): T[] => {
  const seen = new Set<string>()
  const out: T[] = []

  for (const e of edges) {
    const key = edgeKey(e)

    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(e)
  }

  return out
}

/** A note's outbound edges derived from its live body — the write-through /
 *  read-refresh patch source. The body is the truth the index only
 *  approximates (an MVP slice), so a patch wholesale REPLACES the note's
 *  previous outbound edges. */
export const deriveNoteEdges = (
  sourceId: string,
  content: string,
  index: LinkIndex,
  relationType: string,
  /** Provenance map from `buildLinkIndex`. When present, each resolved
   *  edge carries `resolvedVia`; omit it and edges stay lean (the read-model's
   *  incremental write-through path passes none). */
  provenance?: Map<string, ResolvedVia>,
): { edges: GraphLink[]; ghosts: GhostStub[] } => {
  // Collapse duplicate source→target edges, but when the SAME target is reached
  // both by its current name and by a former one (a note that links [[Gagarin]]
  // AND [[Korolev]] to the renamed note), prefer the `current` resolution so the
  // grooming metric is deterministic — it must not depend on which wikilink
  // happens to appear first in the body, and a note that already references the
  // live name isn't really a back-fill target. With no provenance every edge is
  // via-less, so this degrades to plain first-occurrence dedup (the hot path).
  const byKey = new Map<string, GraphLink>()
  const ghosts: GhostStub[] = []

  for (const label of parseWikilinks(content)) {
    const { targetId, ghost, resolvedVia } = resolveLink(label, index, provenance)

    if (!ghost && targetId === sourceId) {
      continue
    }
    const edge: GraphLink = {
      source: sourceId,
      target: targetId,
      type: relationType,
      ...(ghost ? { [GRAPH_GHOST_TARGET]: true as const } : {}),
      ...(resolvedVia ? { resolvedVia } : {}),
    }
    const key = edgeKey(edge)
    const prev = byKey.get(key)

    if (!prev) {
      byKey.set(key, edge)
    } else if (
      prev.resolvedVia &&
      prev.resolvedVia !== RESOLVED_VIA.current &&
      (!resolvedVia || resolvedVia === RESOLVED_VIA.current)
    ) {
      byKey.set(key, edge)
    } // upgrade to the healthier current-name resolution, in place
    if (ghost) {
      ghosts.push(ghost)
    }
  }

  return { edges: [...byKey.values()], ghosts }
}

/** A ghost for an edge target the registry doesn't know — typically a real
 *  note that was deleted while inbound links still point at it (then the id is
 *  a note-id or a bare-engine storage path, hence the .md strip). */
const synthesizeGhost = (id: string): GhostStub => {
  const target = id.replace(/^ghost:/, '').replace(/\.md$/, '')
  const title = deKebab(target.split('/').pop() || target)
  return { id, title, target, prefillTitle: title, creatable: true }
}

/** Assemble the domain Graph from the read-model's parts: live notes, per-source
 *  edge lists and the ghost registry. Tolerant by design — edges whose source
 *  is gone are dropped (stale), edges whose target is gone become ghosts,
 *  self-loops and duplicates are skipped; degree and ghost backlink `sources`
 *  are recomputed from scratch on every shape. */
export const shapeGraph = (
  notes: Iterable<NoteMeta>,
  edgesBySource: Iterable<[string, GraphLink[]]>,
  ghosts: ReadonlyMap<string, GhostStub>,
): Graph => {
  const nodes = new Map<string, GraphRealNode | GraphGhostNode>()

  for (const n of notes) {
    const id = n.id ?? n.filePath
    nodes.set(id, {
      id,
      title: n.title,
      filePath: n.filePath,
      folder: n.filePath.split('/')[0] || '',
      ghost: false,
      degree: 0,
      class: n.class,
      // The tag axis on the node: the graph's tag facet reads these from
      // the index, not a lazy per-node preview sweep. Omit when untagged.
      ...(n.tags?.length ? { tags: n.tags } : {}),
    })
  }

  // Ghost ids are graph-internal node keys, while real note ids are opaque user data.
  // The historical `ghost:<target>` spelling can therefore be a perfectly valid real
  // id. Allocate a deterministic collision-free projection for every ghost target
  // actually referenced by an edge; keep the familiar spelling when it is free.
  const edgeBuckets = [...edgesBySource]
  const ghostTargets = new Set<string>()
  const occupiedNodeIds = new Set(nodes.keys())

  for (const [, edges] of edgeBuckets) {
    for (const edge of edges) {
      if (edge[GRAPH_GHOST_TARGET]) {
        ghostTargets.add(edge.target)
      } else {
        // An unmarked target owns its raw id even when its real note vanished and
        // shapeGraph must synthesize a fallback node for it.
        occupiedNodeIds.add(edge.target)
      }
    }
  }
  const ghostNodeIds = new Map<string, string>()

  for (const rawId of [...ghostTargets].sort()) {
    let graphId = rawId

    while (occupiedNodeIds.has(graphId)) {
      graphId = `ghost:${graphId}`
    }
    occupiedNodeIds.add(graphId)
    ghostNodeIds.set(rawId, graphId)
  }

  const links: GraphLink[] = []
  const seen = new Set<string>()
  const ghostSources = new Map<
    string,
    Map<string, { id?: string; title: string; folder: string }>
  >()

  for (const [sourceId, edges] of edgeBuckets) {
    const source = nodes.get(sourceId)

    if (!source || source.ghost) {
      continue
    } // stale: the source note is gone
    for (const e of edges) {
      const isGhostTarget = e[GRAPH_GHOST_TARGET] === true
      const targetId = isGhostTarget ? (ghostNodeIds.get(e.target) ?? e.target) : e.target
      const publicEdge = { ...e }

      delete publicEdge[GRAPH_GHOST_TARGET]
      const shapedEdge = targetId === e.target ? publicEdge : { ...publicEdge, target: targetId }

      if (shapedEdge.target === shapedEdge.source) {
        continue
      }
      const key = edgeKey(shapedEdge)

      if (seen.has(key)) {
        continue
      }
      let target = nodes.get(targetId)

      if (!target) {
        const stub = isGhostTarget
          ? (ghosts.get(e.target) ?? synthesizeGhost(e.target))
          : synthesizeGhost(e.target)
        target = {
          id: targetId,
          title: stub.title,
          ghost: true,
          folder: '',
          degree: 0,
          target: stub.target,
          prefillTitle: stub.prefillTitle,
          ...(stub.prefillDirectory ? { prefillDirectory: stub.prefillDirectory } : {}),
          creatable: stub.creatable,
        }
        nodes.set(targetId, target)
      }
      seen.add(key)
      links.push(shapedEdge)
      source.degree++
      target.degree++
      if (target.ghost) {
        if (!ghostSources.has(targetId)) {
          ghostSources.set(targetId, new Map())
        }
        const folder = source.filePath.split('/').slice(0, -1).join('/')
        ghostSources.get(targetId)!.set(sourceId, { id: source.id, title: source.title, folder })
      }
    }
  }

  for (const [gid, srcMap] of ghostSources) {
    const g = nodes.get(gid)

    if (g && g.ghost) {
      g.sources = [...srcMap.values()]
    }
  }

  return { nodes: [...nodes.values()], links }
}

/** Read-only grooming health from a FRESH graph — one whose links carry
 *  `resolvedVia` (engine/fake `graph()` derive it with a provenance map; the
 *  read-model's incremental snapshot does NOT, so never feed this that). Counts the
 *  edges resolving through a name other than the target's current one, lists those
 *  edges (with titles) as the grooming/back-fill targeting set, and lifts the ghost
 *  (broken) links off the ghost nodes. Pure — visibility filtering is the caller's
 *  (it feeds an already-filtered graph). */
export const aggregateGraphHealth = (graph: Graph): GraphHealth => {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const via = { slug: 0, noteAlias: 0, folderAlias: 0 }
  const edges: GraphHealthEdge[] = []
  let totalLinks = 0

  for (const l of graph.links) {
    const target = nodeById.get(l.target)

    if (!target || target.ghost) {
      continue
    } // ghosts are the separate broken-links facet
    totalLinks++
    const v = l.resolvedVia

    if (!v || v === RESOLVED_VIA.current) {
      continue
    }
    if (v === RESOLVED_VIA.slug) {
      via.slug++
    } else if (v === RESOLVED_VIA.noteAlias) {
      via.noteAlias++
    } else {
      via.folderAlias++
    }
    const source = nodeById.get(l.source)
    edges.push({
      source: { id: l.source, title: source && !source.ghost ? source.title : l.source },
      target: { id: l.target, title: target.title },
      via: v,
    })
  }
  const ghosts = graph.nodes
    .filter((n): n is GraphGhostNode => n.ghost)
    .map((g) => {
      const sources = [...(g.sources ?? [])].sort(compareGhostSources)
      return { id: g.id, title: g.title, target: g.target, refCount: sources.length, sources }
    })
    .sort(
      (a, b) =>
        b.refCount - a.refCount ||
        compareHealthText(a.title || a.target, b.title || b.target) ||
        compareHealthText(a.target, b.target) ||
        compareHealthText(a.id, b.id),
    )
  return { totalLinks, staleNamed: via.noteAlias + via.folderAlias, via, edges, ghosts }
}
