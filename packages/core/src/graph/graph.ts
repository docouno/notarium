// The pure part of graph assembly: resolve [[wikilinks]] from a live note body
// into edges (buildLinkIndex / deriveNoteEdges) and shape a nodes+edges snapshot
// back into the domain Graph (shapeGraph) — what the read-model cache needs
// to keep the graph fresh without the engine.
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
import { RESOLVED_VIA } from '../knowledgeStore'
import { parseWikilinks } from '../libs/markdown'
import { deKebab, slugify, slugifyPath } from '../libs/slug'
import type { FolderAlias, GhostStub, GraphEdgeLike, LinkIndex } from './types'

type GraphHealthSource = { id?: string; title: string; folder: string }

const graphHealthCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const compareHealthText = (a: string, b: string): number => graphHealthCollator.compare(a, b)
const compareGhostSources = (a: GraphHealthSource, b: GraphHealthSource): number =>
  compareHealthText(a.folder, b.folder) ||
  compareHealthText(a.title, b.title) ||
  compareHealthText(a.id ?? '', b.id ?? '')

/** Identity of an edge: same source, relation type and target. */
export const edgeKey = (e: GraphEdgeLike): string => `${e.source}\u0000${e.type}\u0000${e.target}`

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

export const buildLinkIndex = (
  notes: Iterable<NoteMeta>,
  folderAliases?: readonly FolderAlias[],
  /** Optional out-param: for each index key, which axis CLAIMED it —
   *  `current` (pass 1), `slug` (1.5), `note-alias` (2), `folder-alias` (3). The
   *  grooming health derivation passes one in to learn HOW each edge resolved; the
   *  hot resolve paths (engine/read-model/fake/client) pass none and pay nothing. A
   *  key is claimed exactly once (passes 1.5–3 only fill FREE keys), so its
   *  provenance is unambiguous. */
  provenance?: Map<string, ResolvedVia>,
): LinkIndex => {
  const index: LinkIndex = new Map()
  const list = [...notes]
  const idOf = (n: NoteMeta): string => n.id ?? n.filePath // note-id or storage path (bare engine)

  // Pass 1 — CURRENT names of EVERY note (path, filename, title). A live note's
  // own names always win, so no note can be shadowed by another's stale alias.
  for (const n of list) {
    const id = idOf(n)
    const path = n.filePath.replace(/\.md$/, '')

    for (const key of [
      slugifyPath(path),
      slugify(path.split('/').pop() || path),
      slugify(n.title),
    ]) {
      index.set(key, id)
      provenance?.set(key, RESOLVED_VIA.current)
    }
  }
  // Pass 1.5 — CUSTOM slugs. A user-set `slug:` is a current resolve
  // name, so [[my-slug]] reaches its note. It fills only FREE keys (never shadows
  // another live note's path/filename/title) and ranks ABOVE aliases — a live
  // custom slug beats any note's stale past name. Absent on a note whose slug is
  // the implicit title default (that key is already pass-1's slugify(title)).
  for (const n of list) {
    if (!n.slug) {
      continue
    }
    const key = slugify(n.slug)

    if (key && !index.has(key)) {
      index.set(key, idOf(n))
      provenance?.set(key, RESOLVED_VIA.slug)
    }
  }
  // Pass 2 — ALIAS names, registered only on keys no current name (incl. a
  // custom slug) claimed (collision rule: current > slug > alias). An [[Old Name]]
  // then resolves to the note it was renamed from, unless a different live note
  // now bears that name.
  // canon: docs/note-model.md#note-ontology
  for (const n of list) {
    const id = idOf(n)

    for (const alias of n.aliases ?? []) {
      const key = slugify(alias)

      if (key && !index.has(key)) {
        index.set(key, id)
        provenance?.set(key, RESOLVED_VIA.noteAlias)
      }
    }
  }
  // Pass 3 — FOLDER PATH aliases. A folder rename/move retires its old
  // path; for a note now under the folder's CURRENT path, register the key it
  // would have had under each OLD path, so [[oldpath/note]] still resolves to the
  // (unmoved-identity) note. LOWEST priority (current > slug > note-alias >
  // folder-alias) — fills only FREE keys, never shadowing a live note. A single
  // prefix-swap per (folder-alias, note); folder aliases are few (only renamed
  // folders), so the extra passes are cheap.
  for (const fa of folderAliases ?? []) {
    const cur = slugifyPath(fa.current)
    const ali = slugifyPath(fa.alias)

    if (!ali || cur === ali) {
      continue
    }
    for (const n of list) {
      const p = slugifyPath(n.filePath.replace(/\.md$/, ''))

      if (p !== cur && !p.startsWith(cur + '/')) {
        continue
      }
      const key = ali + p.slice(cur.length)

      if (!index.has(key)) {
        index.set(key, idOf(n))
        provenance?.set(key, RESOLVED_VIA.folderAlias)
      }
    }
  }

  return index
}

/** Resolve one [[wikilink]] label against the index: the slugged full form
 *  first ("dir/note"), then the bare last segment. A miss yields a ghost stub
 *  whose prefill title is guaranteed to slug back to the ghost's target — so a
 *  note created from it resolves the link that produced it. */
export const resolveLink = (
  label: string,
  index: LinkIndex,
  /** The provenance map from `buildLinkIndex`. When present, a hit reports
   *  `resolvedVia` — the axis that claimed the matched key. Omit it on the hot path. */
  provenance?: Map<string, ResolvedVia>,
): { targetId: string; ghost?: GhostStub; resolvedVia?: ResolvedVia } => {
  const path = slugifyPath(label)
  const last = path.split('/').pop() || ''
  // Track WHICH key hit so provenance reads the right entry.
  let hit = index.get(path)
  let matchedKey = path

  if (hit === undefined && path.includes('/')) {
    hit = index.get(last)
    matchedKey = last
  }
  if (hit !== undefined) {
    return { targetId: hit, resolvedVia: provenance?.get(matchedKey) }
  }
  const prefillTitle = slugify(label) === last ? label.trim() : deKebab(last)
  return {
    targetId: `ghost:${path}`,
    ghost: { id: `ghost:${path}`, title: prefillTitle, target: path, prefillTitle },
  }
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

    if (targetId === sourceId) {
      continue
    }
    const edge: GraphLink = {
      source: sourceId,
      target: targetId,
      type: relationType,
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
  return { id, title, target, prefillTitle: title }
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

  const links: GraphLink[] = []
  const seen = new Set<string>()
  const ghostSources = new Map<
    string,
    Map<string, { id?: string; title: string; folder: string }>
  >()

  for (const [sourceId, edges] of edgesBySource) {
    const source = nodes.get(sourceId)

    if (!source || source.ghost) {
      continue
    } // stale: the source note is gone
    for (const e of edges) {
      if (e.target === e.source) {
        continue
      }
      const key = edgeKey(e)

      if (seen.has(key)) {
        continue
      }
      let target = nodes.get(e.target)

      if (!target) {
        const stub = ghosts.get(e.target) ?? synthesizeGhost(e.target)
        target = {
          id: e.target,
          title: stub.title,
          ghost: true,
          folder: '',
          degree: 0,
          target: stub.target,
          prefillTitle: stub.prefillTitle,
        }
        nodes.set(e.target, target)
      }
      seen.add(key)
      links.push(e)
      source.degree++
      target.degree++
      if (target.ghost) {
        if (!ghostSources.has(e.target)) {
          ghostSources.set(e.target, new Map())
        }
        const folder = source.filePath.split('/').slice(0, -1).join('/')
        ghostSources.get(e.target)!.set(sourceId, { id: source.id, title: source.title, folder })
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
