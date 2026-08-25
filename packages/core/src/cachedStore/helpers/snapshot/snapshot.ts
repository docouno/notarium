import { deriveNoteEdges, edgeKey } from '../../../graph'
import {
  type Graph,
  GRAPH_GHOST_TARGET,
  type GraphLink,
  type NoteMeta,
} from '../../../knowledgeStore'
import { dedupeAliases } from '../../../libs/aliases'
import { parseWikilinks } from '../../../libs/markdown'
import { nameKey } from '../../../libs/slug'
import {
  buildLinkIndex,
  type FolderAlias,
  ghostForWikilinkTarget,
  type GhostStub,
  type LinkIndex,
  resolveLink,
} from '../../../referenceResolver'
import { isVisibleOn, SURFACE } from '../../../visibility'
import { NotesMap } from './notesMap'

/** The read-model's derived state: notes by note-id, outbound edges by source
 *  note-id, and the ghost prefill registry — everything /api/notes, /api/recent and
 *  /api/graph serve. Rebuilt from scratch by a boot scan (P2 — nothing here is a
 *  second source of truth); the class orchestrates mutations, this object owns the
 *  maps and the edge-derivation primitives over them.
 *  @see docs/core.md#read-model · docs/core.md#graph-derivation */
export class Snapshot {
  /** Notes by note-id, with the write path's `filePath → ids` reverse lookup. */
  readonly notes = new NotesMap()
  /** Outbound edges by source note-id. */
  readonly edgesBySource = new Map<string, GraphLink[]>()
  /** Ghost (unresolved-link) prefill registry by ghost id. */
  readonly ghosts = new Map<string, GhostStub>()
  /** noteId → distinct PAST titles from the journal (alias backfill), read once
   *  at boot. These heal legacy broken inbound links — a note renamed before the
   *  alias channel existed carries its old titles only here, not yet in the file.
   *  Merged (union with the file-truth `aliases:`, minus the current title) into
   *  EVERY snapshot meta the engine hands us — at boot AND on every delta poll — so
   *  the engine's alias-less inventory meta never wipes the heal. Reassigned wholesale
   *  by the class's reloadHistoricalNames. */
  pastNames = new Map<string, string[]>()
  /** The space's folder path-history: identified folders' current→past path
   *  pairs from the server registry. Folder identity is server-side (the engine never
   *  reads the markers), so `[[oldpath/note]]` can't resolve in the engine's own index
   *  — it heals HERE: buildIndex registers `oldpath/…` keys from these, and
   *  reresolveGhosts retargets the engine's old-path ghosts. Empty when no port is
   *  wired (bare engine). */
  folderAliases: FolderAlias[] = []
  /** The memoized resolve table and the state it was built from. `pastNames` is
   *  deliberately NOT part of it: the journal's past titles are not an input to
   *  `buildLinkIndex` — they reach the table as `aliases` ON THE METAS, and every
   *  such merge (boot, poll, `reloadHistoricalNames`) is a `notes` mutation, which
   *  the counter below already sees. Keying on the history as well only made the
   *  table drop on a reload that changed no name at all. */
  private index: LinkIndex | null = null
  /** What the memoized table was built from. `notes.resolveVersion` is total over
   *  the fields `buildLinkIndex` consumes, without invalidating on timestamps/tags;
   *  the retraction counter is what {@link batchIndex} compares so a batch caller
   *  can ask whether an id has left the map since. */
  private indexKey: {
    resolve: number
    retractions: number
    folders: number
    aliases: FolderAlias[]
  } | null = null

  /** Edge type for body-derived links — matches what the engine's boot graph uses so
   *  patched and swept edges dedupe against each other. */
  constructor(
    private readonly relationType: string,
    private readonly currentFolders: () => readonly string[] = () => [],
    /** Change counter of the folder set behind `currentFolders`. The resolve
     *  table depends on it, and a callback returning a fresh array every time
     *  cannot be compared — so the owner reports when it moved. Without one the
     *  table is simply rebuilt every time, which is the old behaviour. */
    private readonly foldersVersion: () => number = () => Number.NaN,
  ) {}

  /** The graph-visible slice of the snapshot — agent-memory (and any non-graph
   *  class) is neither a node nor a link target in the user graph. */
  graphVisibleNotes(): NoteMeta[] {
    return [...this.notes.values()].filter((n) => isVisibleOn(SURFACE.graph, n.class))
  }

  /** Is the note behind an id allowed in the user graph? (Ghost targets — ids not in
   *  the snapshot — are graph elements in their own right, so true.) */
  isGraphVisibleId(id: string): boolean {
    const meta = this.notes.get(id)
    return !meta || isVisibleOn(SURFACE.graph, meta.class)
  }

  /** The alias set a snapshot meta should carry: the engine's FILE-truth aliases
   *  UNION the journal's past titles (backfill), minus the now-current title.
   *  Applied wherever an engine meta enters the snapshot (boot list + every delta
   *  inventory/upsert) so the journal-only heal SURVIVES a poll — the engine's
   *  inventory omits `aliases` for a legacy note whose file has none, and a bare
   *  `{ ...meta }` would otherwise wipe the backfilled value on the first poll.
   *  Idempotent: nextAliases-style dedup-by-slug + current-title filter means an
   *  A→B→A history never re-adds the dropped self-alias. Returns undefined (not [])
   *  when empty, so the wire/index see "no aliases" rather than an empty array. */
  aliasesFor(id: string, fileAliases: string[] | undefined, title: string): string[] | undefined {
    const past = this.pastNames.get(id)

    if (!past?.length) {
      return fileAliases
    } // no backfill for this note — keep file truth verbatim
    // `nameKey`, not `slugify`: the alias history keeps a letterless past name (a note
    // titled `🎉🎉`), and filtering it here on the bare slug would drop exactly those —
    // undoing one layer up what the history and the resolver agreed on.
    const currentKey = nameKey(title)
    const merged = dedupeAliases([...(fileAliases ?? []), ...past]).filter(
      (a) => nameKey(a) !== currentKey,
    )
    return merged.length ? merged : undefined
  }

  /** The link index over the graph-visible notes + folder path-aliases — the
   *  resolve table [[wikilink]]s and ghost re-resolution consult.
   *
   *  EXACT: memoized on everything it is built FROM, so it is rebuilt whenever any
   *  of that moved and never otherwise. The key must stay TOTAL over the inputs —
   *  a missed one hands back a table that resolves a link to a note it no longer
   *  names, which is a wrong answer rather than a slow one. `NaN !== NaN` makes an
   *  owner that reports no folder version fall back to rebuilding, which is
   *  exactly the old behaviour.
   *
   *  Building is O(visible notes), and a write moves the note set — so a caller
   *  that writes and then asks for an exact table pays the corpus per write, which
   *  is what made a bulk import quadratic. Such callers apply a BATCH and take
   *  {@link batchIndex} instead; this one is for a single, settled answer. */
  buildIndex(): LinkIndex {
    const folders = this.currentFolders()
    const key = {
      resolve: this.notes.resolveVersion,
      retractions: this.notes.retractions,
      folders: this.foldersVersion(),
      aliases: this.folderAliases,
    }

    if (
      this.index &&
      this.indexKey &&
      this.indexKey.resolve === key.resolve &&
      this.indexKey.folders === key.folders &&
      this.indexKey.aliases === key.aliases
    ) {
      return this.index
    }
    this.index = buildLinkIndex(this.graphVisibleNotes(), this.folderAliases, undefined, folders)
    this.indexKey = key

    return this.index
  }

  /** The resolve table for a caller applying a BATCH of writes — an import
   *  bracket, a delta poll — where rebuilding per note is the O(N²) the batch
   *  exists to avoid.
   *
   *  It survives everything the batch does to notes it HOLDS — additions and
   *  renames alike — and never survives an id LEAVING the map. That is the line
   *  that matters: a table naming a note that is gone answers with an id nothing
   *  can repair into a real edge, while a table naming a live note under a name it
   *  just stopped bearing (or not yet naming the note that just took it) is stale
   *  about WHICH live note — and the batch's close re-derives every source against
   *  a fresh table, which is exactly the repair for that. Rebuilding per rename
   *  instead would put the corpus back in the loop: a re-import of an archive whose
   *  titles changed renames on every write, which is the same O(N²) the batch
   *  exists to avoid, reached through the other door.
   *
   *  A NEW FOLDER is an addition too, and a batch that reproduces a directory tree
   *  makes one per folder — so paying a rebuild for each would put the corpus back
   *  in the loop, just counted in folders. The folder set reaches the table on two
   *  axes: which note a `[[oldpath/note]]` belongs to (folder path-HISTORY, pass 3)
   *  and which spelling a ghost offers to create into. Only the first can name the
   *  wrong note, and it exists only when the space HAS folder history — so that is
   *  the case that rebuilds, and a space with none rides the batch table across its
   *  own new folders.
   *
   *  The bound, stated plainly, and it is NOT a symmetric tie: `buildLinkIndex`
   *  ranks a current name strictly above an alias and orders claimants within an
   *  axis by path, so an addition or a rename can take a key from a note whose
   *  claim on it was strictly weaker — and until the close this table still hands
   *  that key to the note that no longer holds it. Likewise a link to a note the
   *  batch just added ghosts until the close, and a ghost minted mid-batch can
   *  offer the folder spelling as AUTHORED where a fresh table would answer with
   *  the spelling the batch just created on disk. The close settles all of it in
   *  one pass — see `CachedStore.flushBulkGraphContext`. What does NOT settle is a
   *  write's link CLAIM (see {@link resolvedTargetIds}), which is concurrency
   *  control taken and released inside the batch. */
  batchIndex(): LinkIndex {
    if (
      this.index &&
      this.indexKey &&
      this.indexKey.retractions === this.notes.retractions &&
      this.indexKey.aliases === this.folderAliases &&
      (!this.folderAliases.length || this.indexKey.folders === this.foldersVersion())
    ) {
      return this.index
    }

    return this.buildIndex()
  }

  /** Real note ids addressed by the authored body under the current resolver index.
   *  A write claims these ids so it cannot introduce a new inbound edge while the
   *  selected target is being deleted. Ghosts need no claim: no live resource owns
   *  them yet.
   *
   *  A batch caller passes its own table (see {@link batchIndex}), and what it
   *  claims is therefore what that table says — which inside a batch can be the
   *  note that held the name before the batch's own addition took it. The claim is
   *  then taken on a live note that this write does not link, and the note it does
   *  link goes unclaimed for the length of this one write. The exposure is that
   *  window and nothing longer: the edge itself is re-derived against a fresh table
   *  at the close, and a delete racing it re-reads the source bodies it finds
   *  targeting the victim rather than trusting the edge projection
   *  ({@link sourceIdsTargeting}). Buying the exact claim instead would mean the
   *  exact table per write — the corpus per write, which is the cost this whole
   *  channel exists to remove. */
  resolvedTargetIds(content: string, batch?: LinkIndex): string[] {
    const labels = parseWikilinks(content)

    if (!labels.length) {
      return []
    }
    const index = batch ?? this.buildIndex()
    const targets = new Set<string>()

    for (const label of labels) {
      const resolved = resolveLink(label, index)

      if (!resolved.ghost) {
        targets.add(resolved.targetId)
      }
    }

    return [...targets]
  }

  /** Sources whose currently-derived edges reach any of `targetIds`. A real target
   *  can have collapsed several authored intents (human name + stable envelope) into
   *  one edge, so callers use this set to re-read the source bodies when the target
   *  disappears instead of guessing a tombstone from the lossy edge projection. */
  sourceIdsTargeting(targetIds: Iterable<string>): string[] {
    const targets = new Set(targetIds)
    const sources: string[] = []

    for (const [sourceId, edges] of this.edgesBySource) {
      if (edges.some((edge) => targets.has(edge.target))) {
        sources.push(sourceId)
      }
    }

    return sources
  }

  /** Move everything keyed under a superseded id to the note's real id (the edge
   *  half of a re-key; the class handles the note + preview halves). */
  renameEdges(oldId: string, newId: string): void {
    const outbound = this.edgesBySource.get(oldId)

    if (outbound) {
      this.edgesBySource.delete(oldId)
      this.edgesBySource.set(
        newId,
        outbound.map((e) => ({ ...e, source: newId })),
      )
    }
    for (const [source, edges] of this.edgesBySource) {
      if (!edges.some((e) => !e[GRAPH_GHOST_TARGET] && e.target === oldId)) {
        continue
      }
      this.edgesBySource.set(
        source,
        edges.map((e) =>
          !e[GRAPH_GHOST_TARGET] && e.target === oldId ? { ...e, target: newId } : e,
        ),
      )
    }
  }

  /** Replace a note's outbound edges from its body. Also re-resolves the ghost
   *  registry — a note that just appeared may be the target older ghost edges
   *  were waiting for. Returns whether anything actually changed. */
  patchNoteEdges(
    sourceId: string,
    content: string,
    opts?: { index?: LinkIndex; deferReresolve?: boolean },
  ): boolean {
    // A hidden source can never contribute to the user graph. Bail out before
    // buildIndex(): deriving an agent-memory body would otherwise rebuild the
    // O(user corpus) link index on every memory read, despite discarding that
    // source at graph shape time. Also heal any stale pre-invariant edge bucket.
    if (!this.isGraphVisibleId(sourceId)) {
      return this.edgesBySource.delete(sourceId)
    }
    // Index only graph-visible notes: a [[link]] to an agent-memory title must
    // ghost, never resolve into the hidden note. Folder path-aliases
    // let `[[oldpath/note]]` retarget after a folder rename.
    // Building the index is O(visible notes); a caller applying a BATCH (applyDelta
    // over a large delta, a write inside an import bracket) passes one table for the
    // whole batch, turning what was an O(N²) re-derive of the whole snapshot into
    // O(N) (a 3k-note catch-up poll was a ~48s synchronous freeze before this).
    // deferReresolve likewise lets the batch caller re-resolve ghosts ONCE at the
    // end instead of per note — and it is that ONE pass, over a fresh table, that
    // pays back what a batch table was behind on. See `batchIndex`.
    const index = opts?.index ?? this.buildIndex()
    const { edges, ghosts } = deriveNoteEdges(sourceId, content, index, this.relationType)

    for (const g of ghosts) {
      this.ghosts.set(g.id, g)
    }

    const before = this.edgesBySource.get(sourceId) ?? []
    const changedEdges =
      before.length !== edges.length || edges.some((e, i) => edgeKey(e) !== edgeKey(before[i]))

    if (edges.length) {
      this.edgesBySource.set(sourceId, edges)
    } else {
      this.edgesBySource.delete(sourceId)
    }

    if (opts?.deferReresolve) {
      return changedEdges
    }

    return this.reresolveGhosts(index) || changedEdges
  }

  /** Retarget edges whose ghost target now resolves to a real note, dropping
   *  the satisfied ghost. Cheap (ghost registry is small) and idempotent. */
  reresolveGhosts(index: LinkIndex): boolean {
    const resolved = new Map<string, string>()

    for (const [ghostId, stub] of this.ghosts) {
      const { targetId, ghost } = resolveLink(stub.target, index)

      if (!ghost) {
        this.ghosts.delete(ghostId)
        // Even when the real target happens to have the SAME raw id as the ghost,
        // record the transition: the edge must still lose its ghost provenance.
        resolved.set(ghostId, targetId)
      }
    }
    if (!resolved.size) {
      return false
    }
    for (const [source, edges] of this.edgesBySource) {
      if (!edges.some((e) => e[GRAPH_GHOST_TARGET] && resolved.has(e.target))) {
        continue
      }
      this.edgesBySource.set(
        source,
        edges.map((e) => {
          if (!e[GRAPH_GHOST_TARGET] || !resolved.has(e.target)) {
            return e
          }
          const next = { ...e, target: resolved.get(e.target)! }

          delete next[GRAPH_GHOST_TARGET]
          return next
        }),
      )
    }

    return true
  }

  /** Take the engine-built graph as the edge baseline: group its links by source
   *  and remember each ghost's prefill payload. Body-derived patches refine from
   *  here. The engine speaks storage ids (file paths) — its edges are remapped onto
   *  our note-ids; ghost targets pass through. */
  adoptEdgeBaseline(graph: Graph, graphUsesIdentity: boolean): void {
    this.edgesBySource.clear()
    this.adoptSourceEdgeBaseline(graph, this.notes.keys(), graphUsesIdentity)
  }

  /** Repair only selected source buckets from an engine graph. A delete owns the
   *  removed note and its known inbound sources, but deliberately does not stop
   *  unrelated writers. Replacing the whole baseline from a graph captured during
   *  that narrow lease could therefore erase a concurrent source patch. */
  adoptSourceEdgeBaseline(
    graph: Graph,
    rawSourceIds: Iterable<string>,
    graphUsesIdentity: boolean,
  ): void {
    const sourceIds = new Set(rawSourceIds)

    for (const sourceId of sourceIds) {
      this.edgesBySource.delete(sourceId)
    }
    const toId = new Map<string, string>()
    const ghostIds = new Set(graph.nodes.filter((node) => node.ghost).map((node) => node.id))

    if (!graphUsesIdentity) {
      for (const meta of this.notes.values()) {
        if (meta.id) {
          toId.set(meta.filePath, meta.id)
        }
      }
    }
    for (const raw of graph.links) {
      const ghostTarget = ghostIds.has(raw.target)
      // A bare engine graph may have observed a just-committed file before the
      // read-model mutation published that file into this snapshot. Its real path
      // cannot yet be converted to a stable id. Keep the edge as an explicitly
      // re-resolvable path ghost; the following snapshot upsert then heals it.
      // Leaving the raw path unmarked would make reresolveGhosts ignore it forever.
      const temporarilyUnmapped = !graphUsesIdentity && !ghostTarget && !toId.has(raw.target)
      const temporaryGhost = temporarilyUnmapped ? ghostForWikilinkTarget(raw.target) : undefined
      const link: GraphLink = {
        ...raw,
        source: graphUsesIdentity ? raw.source : (toId.get(raw.source) ?? raw.source),
        target:
          temporaryGhost?.id ??
          (graphUsesIdentity || ghostTarget ? raw.target : (toId.get(raw.target) ?? raw.target)),
        ...(ghostTarget || temporaryGhost ? { [GRAPH_GHOST_TARGET]: true as const } : {}),
      }

      if (temporaryGhost) {
        this.ghosts.set(temporaryGhost.id, temporaryGhost)
      }

      if (!sourceIds.has(link.source)) {
        continue
      }
      // Don't adopt edges into/out of hidden-class notes (agent-memory): they'd
      // surface a memory note as a spurious ghost at shape time.
      if (!this.isGraphVisibleId(link.source) || !this.isGraphVisibleId(link.target)) {
        continue
      }
      const bucket = this.edgesBySource.get(link.source)

      if (bucket) {
        bucket.push(link)
      } else {
        this.edgesBySource.set(link.source, [link])
      }
    }
    for (const node of graph.nodes) {
      if (!node.ghost) {
        continue
      }
      this.ghosts.set(node.id, {
        id: node.id,
        title: node.title,
        target: node.target,
        prefillTitle: node.prefillTitle,
        ...(node.prefillDirectory ? { prefillDirectory: node.prefillDirectory } : {}),
        creatable: node.creatable,
      })
    }
  }

  /** Drop the whole snapshot (rescan rebuilds it from the engine). */
  clear(): void {
    this.notes.clear()
    this.edgesBySource.clear()
    this.ghosts.clear()
  }
}
