// The transport boundary's domain↔wire mappers.
// canon: docs/contract.md#mappers-at-the-boundaries-a-idmappersa

import { ACTIVITY_EVENT_KIND, REVISION_KIND } from '@notarium/contract'
import type {
  ActivityEventKind,
  Author,
  CreateNoteRequest,
  MoveRequest,
  UpdateNoteRequest,
  ActivityEvent as WireActivityEvent,
  GraphHealth as WireGraphHealth,
  GraphLink as WireGraphLink,
  GraphNode as WireGraphNode,
  NoteListItem as WireNote,
  NoteDetail as WireNoteDetail,
  NoteRevision as WireRevision,
  NoteRevisionDetail as WireRevisionDetail,
  SearchResult as WireSearchResult,
  TrashItem as WireTrashItem,
} from '@notarium/contract'
import { RESOLVED_VIA } from '@notarium/core'
import type {
  ConflictNote,
  Graph,
  GraphHealth,
  MoveInput,
  NoteContent,
  NoteMeta,
  Revision,
  RevisionDetail,
  SearchResult,
  TrashEntry,
  WriteInput,
} from '@notarium/core'

/** Wire datetime → canonical ISO-8601 UTC instant; undefined passes through. */
const isoOrUndefined = (v: string | undefined): string | undefined =>
  v == null ? undefined : new Date(v).toISOString()

// ── domain → wire ───────────────────────────────────────────────────────────

/** One /api/notes row. `id` is widened to optional here though the wire requires
 *  it — stamped upstream by the identity layer, enforced by a downstream zod parse. */
export const noteToWire = (n: NoteMeta): Omit<WireNote, 'id'> & { id?: string } => ({
  id: n.id,
  title: n.title,
  class: n.class,
  filePath: n.filePath,
  ...(n.slug ? { slug: n.slug } : {}),
  ...(n.aliases?.length ? { aliases: n.aliases } : {}),
  modifiedAt: n.modifiedAt,
  createdAt: n.createdAt,
})

export const noteDetailToWire = (
  d: NoteContent,
  space?: string,
  deletedBy?: Author | null,
): Omit<WireNoteDetail, 'id' | 'versionToken'> & { id?: string; versionToken?: string } => ({
  id: d.id,
  space,
  title: d.title,
  class: d.class,
  filePath: d.filePath,
  content: d.content,
  frontmatter: d.frontmatter,
  ...(d.slug ? { slug: d.slug } : {}),
  ...(d.aliases?.length ? { aliases: d.aliases } : {}),
  ...(d.modifiedAt != null ? { modifiedAt: d.modifiedAt } : {}),
  ...(d.createdAt != null ? { createdAt: d.createdAt } : {}),
  versionToken: d.versionToken,
  ...(d.deleted
    ? {
        deleted: true,
        deletedAt: d.deletedAt,
        deletedBy: deletedBy ?? null,
        restorable: d.restorable,
      }
    : {}),
})

export const conflictToWire = (c: ConflictNote): WireNoteDetail => ({
  id: c.id,
  title: c.title,
  filePath: c.filePath,
  content: c.content,
  frontmatter: c.frontmatter,
  ...(c.slug ? { slug: c.slug } : {}),
  ...(c.aliases?.length ? { aliases: c.aliases } : {}),
  versionToken: c.versionToken,
})

export const searchResultToWire = (
  r: SearchResult,
): Omit<WireSearchResult, 'id'> & { id?: string } => ({
  id: r.id,
  title: r.title,
  filePath: r.filePath,
  modifiedAt: r.modifiedAt ?? null,
  createdAt: r.createdAt ?? null,
  noteType: r.noteType,
  score: r.score,
  snippet: r.snippet,
  type: r.type,
  class: r.class,
})

export const graphToWire = (g: Graph): { nodes: WireGraphNode[]; links: WireGraphLink[] } => ({
  nodes: g.nodes.map((n) =>
    n.ghost
      ? {
          id: n.id,
          title: n.title,
          ghost: true as const,
          folder: '' as const,
          degree: n.degree,
          target: n.target,
          prefillTitle: n.prefillTitle,
          sources: n.sources?.map((s) => ({ id: s.id, title: s.title, folder: s.folder })),
          x: n.x,
          y: n.y,
        }
      : {
          id: n.id,
          title: n.title,
          filePath: n.filePath,
          folder: n.folder,
          ghost: false as const,
          degree: n.degree,
          class: n.class,
          tags: n.tags,
          community: n.community,
          x: n.x,
          y: n.y,
        },
  ),
  links: g.links,
})

/** Grooming health → wire. The edge list is capped (headline counts still reflect
 *  the full graph); former-name edges sort ahead of slug alternates before the cap
 *  so a slug-heavy base can't starve real content out of the budget. */
const HEALTH_EDGE_CAP = 100
const staleRank = (via: GraphHealth['edges'][number]['via']): number =>
  via === RESOLVED_VIA.slug ? 1 : 0
export const graphHealthToWire = (h: GraphHealth): WireGraphHealth => ({
  totalLinks: h.totalLinks,
  staleNamed: h.staleNamed,
  via: h.via,
  edges: [...h.edges]
    .sort((a, b) => staleRank(a.via) - staleRank(b.via))
    .slice(0, HEALTH_EDGE_CAP)
    .map((e) => ({ source: e.source, target: e.target, via: e.via })),
  ghosts: h.ghosts.map((g) => ({
    id: g.id,
    title: g.title,
    target: g.target,
    refCount: g.refCount,
    sources: g.sources.map((s) => ({ id: s.id, title: s.title, folder: s.folder })),
  })),
})

// `author` is resolved at the route (needs the viewer + pat registry for privacy
// filtering), so the pure mapper omits it.
export const revisionToWire = (r: Revision): Omit<WireRevision, 'author'> => ({
  revisionId: r.id,
  noteId: r.noteId,
  kind: r.kind,
  principal: r.principal,
  createdAt: r.createdAt,
  contentHash: r.contentHash,
  baseRev: r.baseRevisionId,
  theirRev: r.theirRevisionId,
  sourceRev: r.sourceRevisionId,
  title: r.title,
  charsAdded: r.charsAdded,
  charsRemoved: r.charsRemoved,
})

export const revisionDetailToWire = (r: RevisionDetail): Omit<WireRevisionDetail, 'author'> => ({
  ...revisionToWire(r),
  content: r.content,
  tags: r.tags,
})

/** The dashboard "what changed" display kind derived from a journal revision.
 *  canon: docs/dashboard.md#activity-source-the-revision-journal-12 */
const activityEventKindOf = (r: Revision): ActivityEventKind =>
  r.kind === REVISION_KIND.delete
    ? ACTIVITY_EVENT_KIND.deleted
    : r.kind === REVISION_KIND.restore
      ? ACTIVITY_EVENT_KIND.restored
      : r.baseRevisionId == null
        ? ACTIVITY_EVENT_KIND.created
        : ACTIVITY_EVENT_KIND.edited

/** One activity event, minus `author` (filled at the route, redacting a foreign
 *  agent's key id) and `path` (journal rows carry no filePath — the route joins
 *  it from the read-model). */
export const activityEventToWire = (r: Revision): Omit<WireActivityEvent, 'author' | 'path'> => ({
  revisionId: r.id,
  noteId: r.noteId,
  kind: activityEventKindOf(r),
  title: r.title,
  at: r.createdAt,
  principal: r.principal,
  charsAdded: r.charsAdded,
  charsRemoved: r.charsRemoved,
})

/** One trash row. `external` is computed from the RAW principal (before redaction),
 *  so only a principal-LESS delete reads external — a foreign agent's delete stays
 *  attributed via deletedBy. */
export const trashItemToWire = (e: TrashEntry, author: Author | null): WireTrashItem => ({
  noteId: e.noteId,
  title: e.title,
  filePath: e.filePath,
  class: e.class,
  deletedAt: e.deletedAt,
  deletedBy: author,
  external: e.principal === null,
  // Recoverable iff a body blob exists; an external delete we never read shows in
  // the trash but can't be resurrected (P5).
  restorable: e.contentHash != null,
  revisionId: e.revisionId,
})

// ── wire → domain ───────────────────────────────────────────────────────────

/** Wire create → domain write (no id yet — the domain assigns it). `principal` is
 *  injected by the host, never carried on the wire: every /api writer is the UI
 *  today; the gateway stamps agents at its own boundary. */
export const createToDomain = (body: CreateNoteRequest, principal: string): WriteInput => ({
  // '' = "no explicit title" — the write chokepoint derives it from content;
  // a present value is honoured verbatim.
  title: body.title ?? '',
  content: body.content,
  directory: body.directory,
  noteType: body.noteType,
  tags: body.tags,
  slug: body.slug,
  // Absent stays absent — a normal save never touches `created`.
  createdAt: isoOrUndefined(body.createdAt),
  principal,
})

/** Wire update → domain write (id-addressed, CAS-proven). */
export const updateToDomain = (body: UpdateNoteRequest, principal: string): WriteInput => ({
  // '' = no explicit title, re-derived from content (see createToDomain).
  title: body.title ?? '',
  content: body.content,
  directory: body.directory,
  noteType: body.noteType,
  tags: body.tags,
  slug: body.slug,
  createdAt: isoOrUndefined(body.createdAt),
  originalId: body.originalId,
  versionToken: body.versionToken,
  principal,
})

export const moveToDomain = (body: MoveRequest): MoveInput => ({
  id: body.id,
  destinationPath: body.destinationPath,
})

/** Folder move — a folder has no identity beyond its tree position, so the domain
 *  addresses it by path (id = path). */
export const moveFolderToDomain = (path: string, destinationPath: string): MoveInput => ({
  id: path,
  destinationPath,
  isDirectory: true,
})
