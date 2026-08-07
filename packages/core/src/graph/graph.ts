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
import { GRAPH_GHOST_TARGET, RESOLVED_VIA } from '../knowledgeStore'
import {
  decodeWikilinkIdentity,
  isWikilinkIdentityTarget,
  normalizeWikilinkTarget,
  parseWikilinks,
} from '../libs/markdown'
import { deKebab, linkKey, nameKey, namePathKey } from '../libs/slug'
import type { FolderAlias, GhostStub, GraphEdgeLike, LinkIndex } from './types'

type GraphHealthSource = { id?: string; title: string; folder: string }

const graphHealthCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const compareHealthText = (a: string, b: string): number => graphHealthCollator.compare(a, b)
const compareGhostSources = (a: GraphHealthSource, b: GraphHealthSource): number =>
  compareHealthText(a.folder, b.folder) ||
  compareHealthText(a.title, b.title) ||
  compareHealthText(a.id ?? '', b.id ?? '')

const idIndexKey = (id: string): string => `\u0000id:${id}`
const rawPathIndexKey = (path: string): string => `\u0000path:${path}`

export type FolderResolveContext = {
  aliases: readonly FolderAlias[]
  currentPaths: readonly string[]
}

/** Folder context belongs to an index build but is not itself a link key. Keeping it
 *  out of the Map prevents reserved metadata from participating in normal resolution. */
const folderContextByIndex = new WeakMap<LinkIndex, FolderResolveContext>()

const pathParts = (path: string): string[] => path.split('/').filter(Boolean)
const prefixOf = (parts: readonly string[], length: number): string =>
  parts.slice(0, length).join('/')

/** Canonicalize a folder-shaped human reference using the same precedence as note
 *  resolution: an exact live RAW path wins, then a unique key-equivalent live path,
 *  then the longest historical alias. A tie between distinct current paths is unsafe
 *  and returns null; an unknown path is returned unchanged. */
export const resolveFolderReference = (
  rawPath: string,
  aliases: readonly FolderAlias[] = [],
  currentPaths: readonly string[] = [],
): string | null => {
  if (!rawPath) {
    return ''
  }
  const rawParts = pathParts(rawPath)

  if (!rawParts.length) {
    return rawPath
  }
  const currents = [...new Set(currentPaths.filter(Boolean))]
  const currentSet = new Set(currents)
  let currentClaim: { length: number; path: string } | { length: number; path: null } | undefined

  // Find the most-specific live ancestor. Exact RAW wins a tie against an
  // equivalent spelling, but not against a LONGER historical prefix: a live
  // parent `old/` must not steal the retired child `old/sub→other`.
  for (let length = rawParts.length; length > 0; length--) {
    const rawPrefix = prefixOf(rawParts, length)

    if (currentSet.has(rawPrefix)) {
      currentClaim = { length, path: rawPath }
      break
    }
    const key = namePathKey(rawPrefix)

    if (!key) {
      continue
    }
    const matches = currents.filter((path) => namePathKey(path) === key)

    if (matches.length > 1) {
      currentClaim = { length, path: null }
      break
    }
    if (matches.length === 1) {
      const suffix = rawParts.slice(length).join('/')
      currentClaim = {
        length,
        path: suffix ? `${matches[0]}/${suffix}` : matches[0],
      }
      break
    }
  }

  type AliasClaim = { aliasLength: number; current: string; exact: boolean }
  const claims: AliasClaim[] = []

  for (const pair of aliases) {
    const aliasParts = pathParts(pair.alias)
    const aliasKey = namePathKey(pair.alias)

    if (
      !aliasKey ||
      aliasKey === namePathKey(pair.current) ||
      aliasParts.length > rawParts.length
    ) {
      continue
    }
    const rawPrefix = prefixOf(rawParts, aliasParts.length)

    if (namePathKey(rawPrefix) === aliasKey) {
      claims.push({
        aliasLength: aliasParts.length,
        current: pair.current,
        exact: rawPrefix === pair.alias,
      })
    }
  }

  const longest = claims.length ? Math.max(...claims.map((claim) => claim.aliasLength)) : 0

  if (currentClaim && currentClaim.length >= longest) {
    return currentClaim.path
  }
  if (!longest) {
    return rawPath
  }
  const mostSpecific = claims.filter((claim) => claim.aliasLength === longest)
  const exact = mostSpecific.filter((claim) => claim.exact)
  const targets = new Set((exact.length ? exact : mostSpecific).map((claim) => claim.current))

  if (targets.size !== 1) {
    return null
  }
  const current = [...targets][0]!
  const suffix = rawParts.slice(longest).join('/')
  return suffix ? `${current}/${suffix}` : current
}

const currentFoldersOf = (notes: readonly NoteMeta[]): string[] => {
  const folders = new Set<string>()

  for (const note of notes) {
    const parts = note.filePath.replace(/\.md$/i, '').split('/').slice(0, -1)

    for (let length = 1; length <= parts.length; length++) {
      folders.add(prefixOf(parts, length))
    }
  }

  return [...folders]
}

/** Add an exact stable-id address without changing the graph node's own key. Bare
 *  engines key nodes by path but still know the file's frontmatter id claim, so they
 *  register `id → path`; read-model/client indexes naturally register `id → id`. */
export const registerLinkIdentity = (index: LinkIndex, id: string, targetId: string): void => {
  if (id && !index.has(idIndexKey(id))) {
    index.set(idIndexKey(id), targetId)
  }
}

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
  /** First-class directory inventory (empty folders included). Note-derived
   *  ancestors are always added; callers with a directory channel provide the rest. */
  currentFolders?: readonly string[],
): LinkIndex => {
  const index: LinkIndex = new Map()
  // Inventory order differs by adapter (SQL path order, insertion order, cache
  // arrival). A collision must still choose one deterministic note everywhere.
  const list = [...notes].sort((a, b) =>
    a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0,
  )
  const folderContext: FolderResolveContext = {
    aliases: folderAliases ?? [],
    currentPaths: [...new Set([...currentFoldersOf(list), ...(currentFolders ?? [])])],
  }
  folderContextByIndex.set(index, folderContext)
  const idOf = (n: NoteMeta): string => n.id ?? n.filePath // note-id or storage path (bare engine)

  const claimCurrent = (key: string, id: string): void => {
    if (!key || index.has(key)) {
      return
    }
    index.set(key, id)
    provenance?.set(key, RESOLVED_VIA.current)
  }

  // Exact RAW storage spelling is a current-name axis ahead of the normalized
  // name key. Two files may legally differ only by case or Unicode composition;
  // `[[foo]]` must then choose the literal `foo.md`, just like the engine's direct
  // reader, while a non-exact spelling still follows the deterministic normalized
  // collision rule below.
  for (const n of list) {
    const rawPath = n.filePath.replace(/\.md$/i, '')

    if (!rawPath) {
      continue
    }
    const key = rawPathIndexKey(rawPath)

    if (!index.has(key)) {
      index.set(key, idOf(n))
      provenance?.set(key, RESOLVED_VIA.current)
    }
  }

  for (const n of list) {
    if (n.id) {
      registerLinkIdentity(index, n.id, idOf(n))
    }
  }

  // Pass 1 — CURRENT names of EVERY note (path, filename, title). A live note's
  // own names always win, so no note can be shadowed by another's stale alias.
  // An EMPTY key is never registered: it is not a name, and every note whose name
  // slugs to nothing would otherwise share it — the whole non-Latin corpus resolving
  // as one arbitrary note (#296). The later passes already guarded it; pass 1 did not.
  // Axes are separate passes: literal path > filename > title. Interleaving them per
  // note lets a later title overwrite an earlier filename and makes list order part of
  // the product contract. First claimant in bytewise path order wins within an axis.
  for (const n of list) {
    claimCurrent(namePathKey(n.filePath.replace(/\.md$/, '')), idOf(n))
  }
  for (const n of list) {
    const path = n.filePath.replace(/\.md$/, '')
    claimCurrent(nameKey(path.split('/').pop() ?? ''), idOf(n))
  }
  for (const n of list) {
    claimCurrent(nameKey(n.title), idOf(n))
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
    const key = nameKey(n.slug)

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
      const key = nameKey(alias)

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
  const rawFolderAliasClaims = new Map<string, Set<string>>()
  const folderAliasClaims = new Map<string, Set<string>>()

  for (const fa of folderAliases ?? []) {
    const aliasKey = namePathKey(fa.alias)

    if (!aliasKey || aliasKey === namePathKey(fa.current)) {
      continue
    }

    for (const n of list) {
      const notePath = n.filePath.replace(/\.md$/i, '')

      // Folder membership is RAW. `Inbox` and `inbox` can be two real directories
      // on a case-sensitive medium; key-space membership made one history steal the
      // other's notes.
      if (notePath !== fa.current && !notePath.startsWith(fa.current + '/')) {
        continue
      }
      const candidate = fa.alias + notePath.slice(fa.current.length)
      const candidateParts = candidate.split('/')
      const candidateDir = candidateParts.slice(0, -1).join('/')
      const actualDir = notePath.split('/').slice(0, -1).join('/')
      const resolvedDir = resolveFolderReference(
        candidateDir,
        folderContext.aliases,
        folderContext.currentPaths,
      )

      // Re-run the shared longest-prefix/live-first rule before claiming the key.
      // A broad `old→new` must not claim `old/sub/note` when the more specific
      // `old/sub→other` history says that authored path belongs under `other`.
      if (resolvedDir !== actualDir) {
        continue
      }
      const key = namePathKey(candidate)
      const id = idOf(n)

      if (key) {
        const rawTargets = rawFolderAliasClaims.get(candidate) ?? new Set<string>()
        rawTargets.add(id)
        rawFolderAliasClaims.set(candidate, rawTargets)
        const targets = folderAliasClaims.get(key) ?? new Set<string>()
        targets.add(id)
        folderAliasClaims.set(key, targets)
      }
    }
  }

  // Exact RAW history has the same priority rung as exact RAW current paths and
  // distinguishes `Old` from `old`. Aggregate before publishing so two folder
  // identities claiming the SAME retired spelling fail closed instead of making
  // the first alias-array entry win.
  for (const [candidate, targets] of rawFolderAliasClaims) {
    const key = rawPathIndexKey(candidate)

    if (targets.size === 1 && !index.has(key)) {
      index.set(key, [...targets][0]!)
      provenance?.set(key, RESOLVED_VIA.folderAlias)
    }
  }
  for (const [key, targets] of folderAliasClaims) {
    if (targets.size === 1 && !index.has(key)) {
      index.set(key, [...targets][0]!)
      provenance?.set(key, RESOLVED_VIA.folderAlias)
    }
  }

  return index
}

/** Canonical unresolved-link payload shared by graph shaping and the reader's
 *  server-miss create flow. A create intent is offered only when its prefill can
 *  actually claim the missing last-segment key. */
export const ghostForWikilinkTarget = (
  label: string,
  folderContext?: Partial<FolderResolveContext>,
): GhostStub => {
  const normalized = normalizeWikilinkTarget(label)
  const identityEnvelope = isWikilinkIdentityTarget(normalized)
  const envelopedId = decodeWikilinkIdentity(normalized)

  if (identityEnvelope) {
    return {
      id: `ghost:${normalized}`,
      title: envelopedId ?? normalized,
      target: normalized,
      prefillTitle: envelopedId ?? normalized,
      creatable: false,
    }
  }
  const path = namePathKey(normalized)
  const last = path.split('/').pop() || ''
  const target = linkKey(normalized)
  const rawParts = normalized.replaceAll('\\', '/').split('/')
  const rawDirectoryParts = rawParts.slice(0, -1)
  let safeDirectory: string | null = ''

  if (normalized.includes('\0') || normalized.replaceAll('\\', '/').startsWith('/')) {
    safeDirectory = null
  } else {
    const clean: string[] = []

    for (const segment of rawDirectoryParts) {
      if (!segment || segment === '.') {
        continue
      }
      if (segment === '..' || segment.startsWith('.')) {
        safeDirectory = null
        break
      }
      clean.push(segment)
    }
    if (safeDirectory !== null) {
      safeDirectory = clean.join('/')
    }
  }
  const prefillDirectory =
    safeDirectory == null
      ? null
      : resolveFolderReference(safeDirectory, folderContext?.aliases, folderContext?.currentPaths)

  if (!last || prefillDirectory == null) {
    return {
      id: `ghost:${target}`,
      title: normalized || label.trim(),
      target,
      prefillTitle: '',
      creatable: false,
    }
  }
  const candidate = nameKey(normalized) === last ? normalized : deKebab(last)
  const prefillTitle =
    nameKey(candidate) === last ? candidate : (normalized.split('/').pop() ?? '').trim()

  return {
    id: `ghost:${target}`,
    title: prefillTitle,
    target,
    prefillTitle,
    ...(prefillDirectory ? { prefillDirectory } : {}),
    creatable: nameKey(prefillTitle) === last,
  }
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
  const normalized = normalizeWikilinkTarget(label)
  const identityEnvelope = isWikilinkIdentityTarget(normalized)
  const envelopedId = decodeWikilinkIdentity(normalized)
  // Canonical resolver order is id-first. Plain ids remain supported when they
  // contain no wikilink syntax; the reserved envelope makes this axis total.
  const exactId = identityEnvelope ? envelopedId : normalized
  const byId = exactId == null ? undefined : index.get(idIndexKey(exactId))

  if (byId !== undefined) {
    return { targetId: byId, resolvedVia: RESOLVED_VIA.current }
  }
  if (identityEnvelope) {
    // The reserved namespace is identity-only. Never reinterpret a stale/deleted id
    // as a human title or path: a decoy note whose name resembles the envelope must
    // not capture the edge. Keep it as a distinct ghost for graph-health reporting.
    const ghost = ghostForWikilinkTarget(normalized, folderContextByIndex.get(index))
    return { targetId: ghost.id, ghost }
  }
  const exactPathKey = rawPathIndexKey(normalized)
  const byExactPath = index.get(exactPathKey)

  if (byExactPath !== undefined) {
    return { targetId: byExactPath, resolvedVia: provenance?.get(exactPathKey) }
  }
  // `namePathKey` is total where `slugifyPath` is not: a label with nothing sluggable
  // keys on its raw form (so `[[🎉🎉]]` reaches the note `buildLinkIndex` registered
  // under the same form), and one whose LAST segment names nothing keys on '' rather
  // than on the folder-shaped junk `docs/` that merged every such link into one ghost.
  const path = namePathKey(normalized)
  const last = path.split('/').pop() || ''
  // Track WHICH key hit so provenance reads the right entry.
  let matchedKey = path
  let hit = path ? index.get(path) : undefined

  if (hit === undefined && path.includes('/')) {
    hit = index.get(last)
    matchedKey = last
  }
  if (hit !== undefined) {
    return { targetId: hit, resolvedVia: provenance?.get(matchedKey) }
  }
  // The #25 invariant, ASSERTED rather than approximated: the prefill must key back to
  // this ghost's `last`, or a note created from the ghost does not resolve the link that
  // made it. De-kebabbing is the pretty form (`dir/missing-note` → "Missing Note") and
  // the raw label is the exact one; the old test picked between them by comparing the
  // WHOLE label's key against `last`, which is a proxy that lies on a path form: for
  // `[[dir/🎉-🚀]]` it flattened to `dir`, took the de-kebab branch, and prefilled
  // `🎉 🚀` — a title keyed `🎉 🚀`, so the ghost survived its own creation and offered
  // to create the note again. Check the invariant itself and fall back to the label's
  // last segment, which satisfies it by construction (`last` IS its `nameKey`).
  const ghost = ghostForWikilinkTarget(normalized, folderContextByIndex.get(index))
  return { targetId: ghost.id, ghost }
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
