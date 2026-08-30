import type {
  BucketsResponse,
  FavoriteEntityKind,
  FavoriteMutationResponse,
  FavoritePutRequest,
  FavoritesResponse,
  MoveResponse,
  NoteRevisionDetail,
  NoteRevisionsResponse,
  NoteSort,
  PreviewsResponse,
  RemoveResponse,
  SaveResponse,
  SetNoteFieldsRequest,
  SetNoteFieldsResponse,
  SortDir,
  TagsResponse,
  Tree,
  NoteDetail as WireNoteDetail,
  NotesResponse as WireNotesPage,
  TreeChildren as WireTreeChildren,
} from '@notarium/contract'
import { QUERY_KEY } from '@notarium/contract/query'
import { revisionDetailView, revisionView } from '../../libs/revisions'
import {
  createInputToWire,
  noteDetailView,
  notesPageView,
  type SaveInput,
  saveResultView,
  treeChildrenView,
  updateInputToWire,
} from '../../libs/wire'
import { req, sp } from './client'
import { notesQs } from './query'
import { strictRestore } from './restore'
import type { BucketsQueryParams, NotesQueryParams } from './types'

export const notesApi = {
  // ── space-scoped family ─────────────────────────────────────────────────────
  // The windowed list (#64): filter+sort+slice are server-side, `total` is the
  // filtered population — the client never holds the whole base again.
  notesGet: (space: string, params: NotesQueryParams = {}) =>
    req<WireNotesPage>(`${sp(space)}/notes${notesQs(params)}`).then(notesPageView),
  // The date histogram of a notes query (#64): grouped Feed sections are laid
  // out from these counts before any item is fetched.
  bucketsGet: (space: string, params: BucketsQueryParams) => {
    const q = new URLSearchParams()

    if (params.sort) {
      q.set(QUERY_KEY.sort, params.sort)
    }
    q.set(QUERY_KEY.group, params.group)
    if (params.folder !== undefined) {
      q.set(QUERY_KEY.folder, params.folder)
    }
    if (params.depth) {
      q.set(QUERY_KEY.depth, params.depth)
    }
    for (const f of params.folders || []) {
      q.append(QUERY_KEY.folders, f)
    }
    for (const t of params.tags || []) {
      q.append(QUERY_KEY.tags, t)
    }
    for (const field of params.field || []) {
      q.append(QUERY_KEY.field, field)
    }
    for (const field of params.fieldDay || []) {
      q.append(QUERY_KEY.fieldDay, field)
    }
    for (const field of params.fieldAny || []) {
      q.append(QUERY_KEY.fieldAny, field)
    }
    for (const field of params.fieldBad || []) {
      q.append(QUERY_KEY.fieldBad, field)
    }
    if (params.q) {
      q.set(QUERY_KEY.q, params.q)
    }
    if (params.from) {
      q.set(QUERY_KEY.from, params.from)
    }
    if (params.to) {
      q.set(QUERY_KEY.to, params.to)
    }
    if (params.dateField) {
      q.set(QUERY_KEY.dateField, params.dateField)
    }
    if (params.favorite) {
      q.set(QUERY_KEY.favorite, '1')
    }
    q.set(QUERY_KEY.tz, String(-new Date().getTimezoneOffset()))
    return req<BucketsResponse>(`${sp(space)}/notes/buckets?${q.toString()}`)
  },
  favoritesGet: (space: string) => req<FavoritesResponse>(`${sp(space)}/favorites`),
  favoritePut: (space: string, body: FavoritePutRequest) =>
    req<FavoriteMutationResponse>(`${sp(space)}/favorites`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  favoriteDelete: (space: string, kind: FavoriteEntityKind, id: string) =>
    req<FavoriteMutationResponse>(
      `${sp(space)}/favorites/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  // The tag facet (#109): every tag in the space as a folder-like tree with note
  // counts — what the Feed aside's tag filter boots from. `q` searches, `limit`
  // caps to top-N (both headroom; v1 fetches the whole facet).
  tagsGet: (space: string, params: { q?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()

    if (params.q) {
      q.set(QUERY_KEY.q, params.q)
    }
    if (params.limit !== undefined) {
      q.set(QUERY_KEY.limit, String(params.limit))
    }
    const s = q.toString()
    return req<TagsResponse>(`${sp(space)}/tags${s ? `?${s}` : ''}`)
  },
  // The structure endpoint (#64): folder skeleton + counts + stats.
  treeGet: (space: string) => req<Tree>(`${sp(space)}/tree`),
  // One lazy-tree expand step (#64): direct subfolders + direct notes
  // (request-ordered; offset/limit for huge folders).
  treeChildrenGet: (
    space: string,
    path: string,
    opts: {
      offset?: number
      limit?: number
      sort?: NoteSort
      dir?: SortDir
      signal?: AbortSignal
    } = {},
  ) => {
    const q = new URLSearchParams({ path })

    if (opts.offset) {
      q.set(QUERY_KEY.offset, String(opts.offset))
    }
    if (opts.limit !== undefined) {
      q.set(QUERY_KEY.limit, String(opts.limit))
    }
    if (opts.sort) {
      q.set(QUERY_KEY.sort, opts.sort)
    }
    if (opts.dir) {
      q.set(QUERY_KEY.dir, opts.dir)
    }

    return req<WireTreeChildren>(`${sp(space)}/tree/children?${q.toString()}`, {
      signal: opts.signal,
    }).then(treeChildrenView)
  },
  // ── id-addressed family (global — the registry is the space arbiter) ────────
  // The optional signal lets a superseded open abort its in-flight load (#68):
  // a fast burst of file switches stops paying for the answers it threw away.
  noteGet: (id: string, signal?: AbortSignal) =>
    req<WireNoteDetail>(`/api/note?id=${encodeURIComponent(id)}`, { signal }).then(noteDetailView),
  // Batched preview resolution (#64): one POST per viewport, abortable — the
  // server stops deriving when the viewport scrolls away (see services/previews).
  previewsPost: (ids: readonly string[], signal?: AbortSignal) =>
    req<PreviewsResponse>('/api/previews', {
      method: 'POST',
      body: JSON.stringify({ ids }),
      signal,
    }),
  // Mutations need no snippet-cache tap anymore: the server invalidates its
  // cache write-through, and the SSE `changed` event drops the client's
  // in-memory copies (SyncProvider → dropPreviews). The #16 split lives here,
  // not in the form: a draft with originalId updates in place (global,
  // id-addressed, CAS-proven), a fresh one posts to the space's collection.
  noteSave: (space: string, input: SaveInput) =>
    input.originalId
      ? req<SaveResponse>('/api/note', {
          method: 'POST',
          body: JSON.stringify(updateInputToWire(input)),
        }).then(saveResultView)
      : req<SaveResponse>(`${sp(space)}/notes`, {
          method: 'POST',
          body: JSON.stringify(createInputToWire(input)),
        }).then(saveResultView),
  noteFieldsPut: (body: SetNoteFieldsRequest) =>
    req<SetNoteFieldsResponse>('/api/note/fields', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // The note's timeline window (#12), newest first, with the honest total.
  revisionsGet: (id: string, opts: { offset?: number; limit?: number } = {}) => {
    const q = new URLSearchParams({ id })

    if (opts.offset) {
      q.set(QUERY_KEY.offset, String(opts.offset))
    }
    if (opts.limit !== undefined) {
      q.set(QUERY_KEY.limit, String(opts.limit))
    }

    return req<NoteRevisionsResponse>(`/api/note/revisions?${q.toString()}`).then((d) => ({
      revisions: d.revisions.map(revisionView),
      total: d.total,
    }))
  },
  revisionGet: (id: string, revisionId: string) =>
    req<NoteRevisionDetail>(
      `/api/note/revision?id=${encodeURIComponent(id)}&revisionId=${encodeURIComponent(revisionId)}`,
    ).then(revisionDetailView),
  // Restore = a save sourced from the journal (#12): the server takes the body
  // from the revision; the versionToken is the same CAS proof a save carries,
  // so a stale one 409s with `current` exactly like noteSave.
  noteRestore: (id: string, revisionId: string, versionToken: string) =>
    strictRestore('/api/note/restore', `history:${id}:${revisionId}`, {
      id,
      revisionId,
      versionToken,
    }).then(saveResultView),
  noteRemove: (id: string) =>
    req<RemoveResponse>(`/api/note?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Move a note (id-addressed; the registry decides the space). */
  moveNote: (id: string, destinationPath: string) =>
    req<MoveResponse>('/api/move', {
      method: 'POST',
      body: JSON.stringify({ id, destinationPath }),
    }),
}
