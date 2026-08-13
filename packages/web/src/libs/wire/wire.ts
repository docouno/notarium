// The client's view layer over the /api/* wire. Since contract v2 (#54) the
// wire speaks camelCase domain shapes, so most views ARE the wire types —
// re-exported or aliased verbatim. The few mappers left are deliberate shape
// guards (the server's twin lives in packages/server/src/services/api/wire.ts,
// the note-history slice in libs/revisions): they keep the view types
// structurally independent from zod inference, so a contract change surfaces
// here as a type error instead of rippling silently through the app. In libs
// so every layer — the api service AND presentational widgets — can speak
// these shapes without crossing the boundary rules (widgets never import
// services).

import type {
  Author,
  CreateNoteRequest,
  IfExists,
  Preview,
  SaveResponse,
  TreeFolder,
  UpdateNoteRequest,
  GraphResponse as WireGraph,
  GraphNode as WireGraphNode,
  NoteListItem as WireNote,
  NoteDetail as WireNoteDetail,
  NotesResponse as WireNotesPage,
  SearchResult as WireSearchResult,
  TreeChildren as WireTreeChildren,
} from '@notarium/contract'

// ── camelCase-already wire shapes ────────────────────────────────────────────
// These cross the wire in their final shape — re-exported verbatim, no mapper.
// Consumers import them from here too, so the whole web app gets its transport
// types from one place.
export type {
  Bucket,
  BucketGran,
  BucketsResponse,
  Config,
  GraphLink,
  NoteSort,
  Preview,
  PreviewsResponse,
  StoreEvent,
  SyncStatus,
  Tree,
  TreeFolder,
} from '@notarium/contract'

import type { GraphLink } from '@notarium/contract'

// ── notes ────────────────────────────────────────────────────────────────────

export type NoteView = {
  /** The internal note-id (P7, #51) — THE identity every reference keys on. */
  id: string
  title: string
  /** Storage-view location: where the note lives as a file. */
  filePath: string
  /** Read-only mount class (#78): user-doc / agent-memory / profile. */
  class?: WireNote['class']
  /** The editable display slug (#100 phase 1) — the client builds `/n/<id>/<slug>`
   *  from it (canonical URL). Absent when the note has no custom slug (the URL tail
   *  then derives from the title). Resolving `[[my-slug]]` is NOT done here: the
   *  session inventory is partial, so a human reference goes to `api.noteResolve`. */
  slug?: string
  /** Alias-history as returned by the list wire. Human resolution runs server-side
   *  over the whole space, never against this cached window. */
  aliases?: string[]
  modifiedAt: string | null
  createdAt: string | null
  /** Warm cached preview, present only on a window asked for it (?preview=1). */
  preview?: Preview | null
}

export const noteView = (n: WireNote): NoteView => ({
  id: n.id,
  title: n.title,
  filePath: n.filePath,
  class: n.class,
  slug: n.slug,
  aliases: n.aliases,
  modifiedAt: n.modifiedAt,
  createdAt: n.createdAt,
  preview: n.preview,
})

export type NoteDetailView = {
  id: string
  /** The space the note lives in (#16) — scopes the chrome when a reader
   *  arrives via the space-free /n/<id>. Absent only in 409 envelopes. */
  space?: string
  title?: string
  filePath?: string
  /** Read-only mount class (#78): distinguishes user docs from agent-memory. */
  class?: WireNoteDetail['class']
  /** The editable display slug (#100 phase 1) — the reader prefills the slug field
   *  from it and the page canonicalises the URL to `/n/<id>/<slug>`. Absent when the
   *  note has no custom slug. */
  slug?: string
  /** Alias-history as returned by the detail wire. It is not local lookup material:
   *  every human reference goes to `api.noteResolve`. */
  aliases?: string[]
  content: string
  frontmatter: Record<string, unknown>
  modifiedAt?: string | null
  /** The note's resolved creation instant (#186), full ISO-8601 UTC — the editor
   *  prefills the editable date field from it. null/absent when the engine knows
   *  no date. */
  createdAt?: string | null
  /** Opaque CAS proof (#50, P3): echoed back on save so the server can detect
   *  the note changed underneath. The client never inspects it. */
  versionToken: string
  /** Trash state (#79): set when this id resolved to a DELETED note (its last
   *  state, read-only) — the reader shows a "deleted" banner instead of 404.
   *  `deletedBy` is the resolved, privacy-filtered author (null = external).
   *  `restorable` controls historical preview availability;
   *  restoreAvailability controls publication. Absent on a live note. */
  deleted?: boolean
  deletedAt?: string
  deletedBy?: Author | null
  restorable?: boolean
  restoreAvailability?: WireNoteDetail['restoreAvailability']
  /** Literal opaque deleted source; never Markdown-rendered. */
  source?: WireNoteDetail['source']
}

export const noteDetailView = (d: WireNoteDetail): NoteDetailView => ({
  id: d.id,
  space: d.space,
  title: d.title,
  filePath: d.filePath,
  class: d.class,
  slug: d.slug,
  aliases: d.aliases,
  content: d.content,
  frontmatter: d.frontmatter,
  modifiedAt: d.modifiedAt,
  createdAt: d.createdAt,
  versionToken: d.versionToken,
  deleted: d.deleted,
  deletedAt: d.deletedAt,
  deletedBy: d.deletedBy,
  restorable: d.restorable,
  restoreAvailability: d.restoreAvailability,
  source: d.source,
})

export type NotesPageView = { notes: NoteView[]; total: number }

export const notesPageView = (p: WireNotesPage): NotesPageView => ({
  notes: p.notes.map(noteView),
  total: p.total,
})

export type TreeChildrenView = { folders: TreeFolder[]; notes: NoteView[]; total: number }

export const treeChildrenView = (t: WireTreeChildren): TreeChildrenView => ({
  folders: t.folders,
  notes: t.notes.map(noteView),
  total: t.total,
})

// ── search ───────────────────────────────────────────────────────────────────

/** Always a known note (#54): `id` is required on the wire — the server drops
 *  hits the identity layer can't place. */
export type SearchResultView = {
  id: string
  title?: string
  filePath?: string
  modifiedAt: string | null
  createdAt: string | null
  noteType?: string
  score?: number
  snippet: string
  type?: string
}

export const searchResultView = (r: WireSearchResult): SearchResultView => ({
  id: r.id,
  title: r.title,
  filePath: r.filePath,
  modifiedAt: r.modifiedAt,
  createdAt: r.createdAt,
  noteType: r.noteType,
  score: r.score,
  snippet: r.snippet,
  type: r.type,
})

// ── graph ────────────────────────────────────────────────────────────────────

export type GraphRealNodeView = {
  id: string
  title: string
  filePath: string
  folder: string
  ghost: false
  degree: number
  /** The note's tags (#109), as authored — the graph's tag facet reads these. */
  tags?: string[]
  community?: number
  x?: number
  y?: number
}

export type GraphGhostNodeView = {
  id: string
  title: string
  ghost: true
  folder: ''
  degree: number
  target: string
  prefillTitle: string
  prefillDirectory?: string
  creatable: boolean
  sources?: Array<{ id?: string; title: string; folder: string }>
  x?: number
  y?: number
}

export type GraphNodeView = GraphRealNodeView | GraphGhostNodeView

export type GraphView = { nodes: GraphNodeView[]; links: GraphLink[] }

export const graphNodeView = (n: WireGraphNode): GraphNodeView =>
  n.ghost
    ? {
        id: n.id,
        title: n.title,
        ghost: true,
        folder: '',
        degree: n.degree,
        target: n.target,
        prefillTitle: n.prefillTitle,
        prefillDirectory: n.prefillDirectory,
        creatable: n.creatable,
        sources: n.sources,
        x: n.x,
        y: n.y,
      }
    : {
        id: n.id,
        title: n.title,
        filePath: n.filePath,
        folder: n.folder,
        ghost: false,
        degree: n.degree,
        tags: n.tags,
        community: n.community,
        x: n.x,
        y: n.y,
      }

export const graphView = (g: WireGraph): GraphView => ({
  nodes: g.nodes.map(graphNodeView),
  links: g.links,
})

// ── save (view → wire) ───────────────────────────────────────────────────────

/** The editor's save shape. `buildPayload()` produces it; the api service
 *  routes it onto the #16 split — `originalId` present → the id-addressed
 *  update (versionToken required, #50), absent → the space-scoped create. */
export type SaveInput = {
  /** No `title` since #156: the title is the document's leading `# H1`, carried in
   *  `content`. The server derives it at the write chokepoint. */
  content?: string
  directory?: string
  noteType?: string
  tags?: string[] | string
  /** The custom display slug (#100 phase 1) the editor addresses: a value sets it,
   *  '' clears it back to the implicit default. */
  slug?: string
  /** Authored creation instant (#186), full ISO-8601 UTC — the date-as-data axis
   *  the metadata aside edits. The editor sends it ONLY when the user changed the
   *  date (an untouched note keeps its exact instant, imported precision intact);
   *  absent leaves `created` alone. */
  createdAt?: string
  /** The note-id being edited in place — triggers move-then-write so a
   *  title/folder change renames rather than duplicating (the #8 invariant). */
  originalId?: string
  /** The version the editor read. REQUIRED with originalId (#50, P3). */
  versionToken?: string
  /** Create only: what to do when the folder already holds this title. Absent =
   *  refuse (the server default); 'uniquify' asks for the next free name — what
   *  Duplicate wants and the collision dialog's "save as …" retries with. */
  ifExists?: IfExists
}

export const createInputToWire = (i: SaveInput): CreateNoteRequest => ({
  content: i.content,
  directory: i.directory,
  noteType: i.noteType,
  tags: i.tags,
  slug: i.slug,
  createdAt: i.createdAt,
  ifExists: i.ifExists,
})

export const updateInputToWire = (i: SaveInput): UpdateNoteRequest => ({
  content: i.content,
  directory: i.directory,
  noteType: i.noteType,
  tags: i.tags,
  slug: i.slug,
  createdAt: i.createdAt,
  originalId: i.originalId as string,
  versionToken: i.versionToken as string,
})

/** What a save/restore answers with — the saved note's identity plus the fresh
 *  CAS token, so a client (or agent) can chain a follow-up save without a read. */
export type SaveResultView = {
  id: string
  filePath?: string
  /** The title the note landed under — what a `uniquify` create reports back. */
  title?: string
  versionToken: string
}

export const saveResultView = (r: SaveResponse): SaveResultView => ({
  id: r.id,
  filePath: r.filePath,
  title: r.title,
  versionToken: r.versionToken,
})
