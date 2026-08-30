// The list-layer derivations: filter+sort+slice for GET /api/notes, the
// folder skeleton for GET /api/tree, one lazy-tree expand step for GET
// /api/tree/children and the date histogram for GET /api/notes/buckets — all
// pure functions over the store's note inventory, so every host serves identical
// windows whatever engine sits behind it.
// canon: docs/core.md#list-layer

import type {
  BucketsQuery,
  NoteMeta,
  NoteSort,
  NotesQuery,
  SortDir,
  TreeChildrenQuery,
} from '../knowledgeStore'
import { BUCKET_GRAN, DATE_FIELD, DEPTH, NOTE_SORT, SORT_DIR } from '../knowledgeStore'
import { compileFieldFilter } from '../libs/fields'
import { directoryOf, isFolderPageNote } from '../libs/path'
import { buildTagFacet, matchesTags } from '../libs/tags'
import type {
  BucketCounts,
  NotesWindow,
  TagFacet,
  TreeChildrenWindow,
  TreeFolder,
  TreeSummary,
} from './types'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/** One reusable collator: per-call `localeCompare(..., {sensitivity})` re-derives
 *  collation state every comparison and made a 100k-note sort cost ~2s — the
 *  collator brings the same ordering down to ~75ms (26×). */
const byTitleCollator = new Intl.Collator('en-US', { sensitivity: 'base' })

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export type SortFields<T> = {
  title: (item: T) => string
  stableKey: (item: T) => string
  createdAt: (item: T) => string | null
  modifiedAt: (item: T) => string | null
}

type NoteLike = Pick<NoteMeta, 'title' | 'filePath' | 'createdAt' | 'modifiedAt'>

const NOTE_FIELDS: SortFields<NoteLike> = {
  title: (item) => item.title,
  stableKey: (item) => item.filePath,
  createdAt: (item) => item.createdAt,
  modifiedAt: (item) => item.modifiedAt,
}

export function comparatorFor<T extends NoteLike>(
  sort: NoteSort,
  dir?: SortDir,
): (a: T, b: T) => number
export function comparatorFor<T>(
  sort: NoteSort,
  dir: SortDir | undefined,
  fields: SortFields<T>,
): (a: T, b: T) => number
/** The one total ordering rule shared by server windows and optimistic browser
 *  projections. Unknown dates are structural unknowns, so they stay last in
 *  both directions; title + a stable key make every tie deterministic. */
export function comparatorFor<T>(
  sort: NoteSort,
  dir?: SortDir,
  fields: SortFields<T> = NOTE_FIELDS as SortFields<T>,
): (a: T, b: T) => number {
  const direction = dir ?? (sort === NOTE_SORT.title ? SORT_DIR.asc : SORT_DIR.desc)
  const factor = direction === SORT_DIR.asc ? 1 : -1
  const byTitle = (a: T, b: T) =>
    byTitleCollator.compare(fields.title(a), fields.title(b)) ||
    cmp(fields.stableKey(a), fields.stableKey(b))

  if (sort === NOTE_SORT.title) {
    return (a, b) => factor * byTitle(a, b)
  }
  const dateOf = sort === NOTE_SORT.created ? fields.createdAt : fields.modifiedAt

  return (a, b) => {
    const aDate = dateOf(a)
    const bDate = dateOf(b)

    if (!aDate || !bDate) {
      if (!aDate && !bDate) {
        return byTitle(a, b)
      }

      return aDate ? -1 : 1
    }

    return factor * cmp(aDate, bDate) || byTitle(a, b)
  }
}

const dateKeyOf = (field: 'created' | 'modified'): 'createdAt' | 'modifiedAt' =>
  field === DATE_FIELD.created ? 'createdAt' : 'modifiedAt'

const filterDateKeyOf = (q: NotesQuery): 'createdAt' | 'modifiedAt' =>
  dateKeyOf(
    q.dateField ?? (q.sort === NOTE_SORT.created ? DATE_FIELD.created : DATE_FIELD.modified),
  )

const isLocalDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

const localDayOf = (value: string | null, tzMin: number): string => {
  if (!value) {
    return ''
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return isLocalDate(value) ? value : ''
  }
  const t = Date.parse(value)

  if (Number.isNaN(t)) {
    return ''
  }
  const shifted = t + tzMin * 60_000
  const dayUtc = Math.floor(shifted / DAY_MS) * DAY_MS
  return new Date(dayUtc).toISOString().slice(0, 10)
}

const inDateRange = (note: NoteMeta, q: NotesQuery): boolean => {
  if (!q.from && !q.to) {
    return true
  }
  const day = localDayOf(note[filterDateKeyOf(q)], q.tz ?? 0)

  if (!day) {
    return false
  }
  if (q.from && day < q.from) {
    return false
  }
  if (q.to && day > q.to) {
    return false
  }

  return true
}

const inFolder = (note: NoteMeta, folder: string, depth: NotesQuery['depth']): boolean => {
  const dir = directoryOf(note.filePath)

  if (depth === DEPTH.direct) {
    return dir === folder
  }
  if (folder === '') {
    return true
  } // the root's subtree is the whole base

  return dir === folder || dir.startsWith(folder + '/')
}

/** Is `dir` under any selected subtree (inclusion)? A path-prefix walk:
 *  `dir` matches when itself or any ancestor is in the set, so selecting a parent
 *  pulls its whole subtree. A root-level note (`dir === ''`) is never under a
 *  folder — it shows only when the set is empty (no filter). Built into a Set once
 *  per query — the per-note cost is O(path depth), not O(set). */
const inAnyFolder = (dir: string, set: ReadonlySet<string>): boolean => {
  if (!dir) {
    return false
  }
  let acc = ''

  for (const part of dir.split('/')) {
    acc = acc ? `${acc}/${part}` : part
    if (set.has(acc)) {
      return true
    }
  }

  return false
}

/** One /api/notes window: scope to a folder (if asked), order, count, slice.
 *  `total` is the population AFTER filtering but BEFORE the slice — the honest
 *  scrollbar number. In `created` order, notes the engine can't date are not a
 *  "somewhere at the bottom" surprise — they're excluded, exactly like the
 *  Feed has always treated them. */
export const queryNotes = (notes: readonly NoteMeta[], q: NotesQuery): NotesWindow => {
  let list =
    q.folder === undefined ? [...notes] : notes.filter((n) => inFolder(n, q.folder!, q.depth))

  // Stable-id membership (favorites): applied before sort/slice and shared
  // with bucketCounts, so the window total and histogram describe the same set.
  if (q.ids) {
    const ids = new Set(q.ids)
    list = list.filter((n) => n.id != null && ids.has(n.id))
  }
  // Folder facet (inclusion): keep notes under ANY selected subtree (OR);
  // empty = no constraint. "Show only this folder" is just a one-element set.
  if (q.folders && q.folders.length) {
    const picked = new Set(q.folders)
    list = list.filter((n) => inAnyFolder(directoryOf(n.filePath), picked))
  }
  // Tag filter: OR/union across the set, each matched case-insensitively and
  // hierarchically (`ml` also matches `ml/nlp`) — see matchesTags. Composes after
  // the folder facet (folder ∧ tag), so `total`/window/histogram all describe the
  // same population.
  if (q.tags && q.tags.length) {
    list = list.filter((n) => matchesTags(n.tags, q.tags))
  }
  if (q.fields) {
    const matchesFields = compileFieldFilter(q.fields)
    list = list.filter((n) => matchesFields(n.fields))
  }
  // Date range: inclusive local calendar days on the selected date axis.
  // Applied before sort/slice so `total`, the window and buckets all agree.
  if (q.from || q.to) {
    list = list.filter((n) => inDateRange(n, q))
  }
  if (q.sort === NOTE_SORT.created && !q.includeUndated) {
    list = list.filter((n) => n.createdAt)
  }
  list.sort(comparatorFor(q.sort, q.dir))
  const total = list.length
  return {
    notes: q.limit === undefined ? list.slice(q.offset) : list.slice(q.offset, q.offset + q.limit),
    total,
  }
}

/** The /api/tree payload: every folder (including intermediate ancestors) with
 *  subtree + direct note counts, plus the base-wide stats the UI's aside shows.
 *  `now` is injected so deterministic hosts (the e2e fake) stay deterministic.
 *  `dirs` (directory channel) is the set of folders that exist on disk beyond
 *  the ones notes live in — empty projects, "New folder"s, emptied folders
 *  (never-prune). They (and their ancestors) join the tree with count/direct = 0
 *  so a folder is shown even when it holds no notes; a note-backed dir keeps its
 *  real counts. This is what makes the tree SERVER-AUTHORITATIVE — the client no
 *  longer synthesises empty project folders (withProjectFolders is retired). */
export const treeSummary = (
  notes: readonly NoteMeta[],
  dirs: readonly string[],
  now: number,
  /** Identified folders/projects: id attaches to the matching
   *  node; pathAliases, when present, let the client redirect an old path. */
  folderIdentities?: ReadonlyArray<{ id: string; path: string; pathAliases: string[] }>,
): TreeSummary => {
  const direct = new Map<string, number>()
  const subtree = new Map<string, number>()
  let week = 0

  // A folder PAGE note is the folder's body, NOT one of its children: it is
  // hidden from every tree count and listing (the cover, counted nowhere), staying
  // visible only to the graph/search (a different code path). `pageOf` maps a folder
  // to its page note's id, so each node can carry `pageNoteId`.
  const pageOf = new Map<string, string>()
  let pages = 0

  for (const n of notes) {
    if (isFolderPageNote(n.filePath)) {
      if (n.id) {
        pageOf.set(directoryOf(n.filePath), n.id)
      }
      pages++
      continue
    }
    const dir = directoryOf(n.filePath)
    direct.set(dir, (direct.get(dir) || 0) + 1)
    let acc = ''

    for (const part of dir ? dir.split('/') : []) {
      acc = acc ? `${acc}/${part}` : part
      subtree.set(acc, (subtree.get(acc) || 0) + 1)
    }
    const created = n.createdAt ? Date.parse(n.createdAt) : NaN

    if (!Number.isNaN(created) && created >= now - WEEK_MS) {
      week++
    }
  }

  // Seed empty folders (and their ancestors) with a 0 count, never clobbering a
  // note-derived count. Root ('') is not a folder node. A folder that holds ONLY a
  // page note (no children) still exists on disk → it's in `dirs`; seed pageFolders
  // too so a fake without the directory channel still surfaces a page-only folder.
  for (const d of [...dirs, ...pageOf.keys()]) {
    let acc = ''

    for (const part of d ? d.split('/') : []) {
      acc = acc ? `${acc}/${part}` : part
      if (!subtree.has(acc)) {
        subtree.set(acc, 0)
      }
    }
  }

  // Index identities by current path so a matching folder node carries its id;
  // past paths ride alongside only for moved folders/projects.
  const idByPath = new Map(folderIdentities?.map((f) => [f.path, f]) ?? [])

  const folders: TreeFolder[] = [...subtree.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const ident = idByPath.get(path)
      return {
        path,
        name: path.split('/').pop()!,
        count: subtree.get(path)!,
        direct: direct.get(path) || 0,
        // An identified folder carries its id (for `/folder/<id>`); past paths ride
        // only when it has actually moved (the redirect needs them — an empty array
        // would just be wire noise on every page-bearing/project folder).
        ...(ident
          ? { id: ident.id, ...(ident.pathAliases.length ? { aliases: ident.pathAliases } : {}) }
          : {}),
        ...(pageOf.has(path) ? { pageNoteId: pageOf.get(path)! } : {}),
      }
    })

  return {
    folders,
    // `total` is content notes — folder pages are covers, counted nowhere in the tree.
    stats: { total: notes.length - pages, root: direct.get('') || 0, week },
  }
}

/** One lazy-tree expand step: the folder's direct subfolders (with the
 *  same subtree/direct counts the skeleton carries) and its direct notes,
 *  ordered by the request (`title` by default). offset/limit window the notes only;
 *  `total` is the direct-note population before the slice. */
export const treeChildren = (
  notes: readonly NoteMeta[],
  dirs: readonly string[],
  q: TreeChildrenQuery,
  /** Identified folders with a path-history — same wire contract as the
   *  tree skeleton, so a lazy child step can link durable `/folder/<id>` URLs too. */
  folderIdentities?: ReadonlyArray<{ id: string; path: string; pathAliases: string[] }>,
): TreeChildrenWindow => {
  const prefix = q.path === '' ? '' : q.path + '/'
  // Folder pages are covers, never listed as children — drop them from BOTH
  // the subtree counts and the direct-note window, mirroring treeSummary. One pass
  // splits the content notes out and maps each page-bearing folder to its page id.
  const contentNotes: NoteMeta[] = []
  const pageOf = new Map<string, string>()

  for (const n of notes) {
    if (isFolderPageNote(n.filePath)) {
      if (n.id) {
        pageOf.set(directoryOf(n.filePath), n.id)
      }
    } else {
      contentNotes.push(n)
    }
  }
  const direct = new Map<string, number>()
  const subtree = new Map<string, number>()

  for (const n of contentNotes) {
    const dir = directoryOf(n.filePath)

    if (!dir.startsWith(prefix) || dir === q.path) {
      continue
    }
    const child = prefix + dir.slice(prefix.length).split('/')[0]
    subtree.set(child, (subtree.get(child) || 0) + 1)
    if (dir === child) {
      direct.set(child, (direct.get(child) || 0) + 1)
    }
  }
  // Empty child folders (directory channel): a folder under q.path with no
  // notes — surface its direct-child segment with a 0 count if nothing seeded it.
  // A page-only child folder appears here too (its dir exists on disk / pageFolders).
  for (const d of [...dirs, ...pageOf.keys()]) {
    if (!d.startsWith(prefix) || d === q.path) {
      continue
    }
    const child = prefix + d.slice(prefix.length).split('/')[0]

    if (!subtree.has(child)) {
      subtree.set(child, 0)
    }
  }
  const idByPath = new Map(folderIdentities?.map((f) => [f.path, f]) ?? [])
  const folders: TreeFolder[] = [...subtree.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const ident = idByPath.get(path)
      return {
        path,
        name: path.split('/').pop()!,
        count: subtree.get(path)!,
        direct: direct.get(path) || 0,
        ...(ident
          ? { id: ident.id, ...(ident.pathAliases.length ? { aliases: ident.pathAliases } : {}) }
          : {}),
        ...(pageOf.has(path) ? { pageNoteId: pageOf.get(path)! } : {}),
      }
    })
  const page = queryNotes(contentNotes, {
    sort: q.sort ?? NOTE_SORT.title,
    dir: q.dir,
    offset: q.offset,
    limit: q.limit,
    folder: q.path,
    depth: DEPTH.direct,
    includeUndated: true,
  })
  return { folders, notes: page.notes, total: page.total }
}

// ── Date buckets (grouped Feed sections without fetching items) ─────────

/** A note's bucket-start key for the granularity, as a local YYYY-MM-DD in the
 *  client's timezone (`tzMin` = minutes east of UTC). Dates are ISO instants
 *  — shift, then take the date. '' = no usable date (the trailing
 *  "undated" bucket). */
export const bucketKeyOf = (
  value: string | null,
  gran: BucketsQuery['group'],
  tzMin: number,
): string => {
  const day = localDayOf(value, tzMin)

  if (!day) {
    return ''
  }
  let dayUtc = Date.parse(`${day}T00:00:00.000Z`)

  if (gran === BUCKET_GRAN.week) {
    const dow = (new Date(dayUtc).getUTCDay() + 6) % 7 // Monday-based
    dayUtc -= dow * DAY_MS
  } else if (gran === BUCKET_GRAN.month) {
    const d = new Date(dayUtc)
    dayUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  }

  return new Date(dayUtc).toISOString().slice(0, 10)
}

/** The /api/notes/buckets payload: the same filter+sort as the matching
 *  /api/notes query, reduced to consecutive (bucket key, count) runs in list
 *  order. Counts sum to `total` — the invariant that lets a client lay out
 *  grouped sections (headers, sizes, honest scrollbar) without fetching a
 *  single item. Runs, not a map: position in the sorted list IS the section
 *  assignment, so a key that recurs non-consecutively (possible only at mixed
 *  date-format edges) stays two sections rather than corrupting the layout. */
export const bucketCounts = (notes: readonly NoteMeta[], q: BucketsQuery): BucketCounts => {
  const page = queryNotes(notes, {
    sort: q.sort,
    offset: 0,
    folder: q.folder,
    depth: q.depth,
    folders: q.folders,
    tags: q.tags,
    fields: q.fields,
    from: q.from,
    to: q.to,
    tz: q.tz,
    dateField: q.dateField,
    ids: q.ids,
  })
  const dateKey = q.sort === NOTE_SORT.created ? 'createdAt' : 'modifiedAt'
  const buckets: BucketCounts['buckets'] = []

  for (const n of page.notes) {
    const key = bucketKeyOf(n[dateKey], q.group, q.tz)
    const last = buckets[buckets.length - 1]

    if (last && last.key === key) {
      last.count++
    } else {
      buckets.push({ key, count: 1 })
    }
  }

  return { buckets, total: page.total }
}

// ── Tag facet (the tag axis as a folder-like tree) ─────────────────────

/** The /api/s/:space/tags payload: every tag in the population as a node, with
 *  subtree + direct counts, shaped like the folder skeleton so the client nests
 *  hierarchical tags (`a/b`) in one pass — the SAME algebra as treeSummary, over
 *  the tag dimension instead of the path. Tags fold for matching (case-insensitive,
 *  `/`-hierarchical) but a node's `label` keeps the author's casing for display.
 *  Per-note dedupe: a note tagged both `ml` and `ml/nlp` counts ONCE for the `ml`
 *  subtree. `q` substring-filters the folded path ("search tags"); `limit` caps to
 *  the top-N by count (a big base's truncation — the client nests by `tag` path
 *  regardless of list order, so frequency ordering doesn't fight the tree). `total`
 *  is the distinct-node count before the limit cut, so the UI can show "+N more".
 *  Visibility is the caller's job: pass the already class-scoped list. */
export const tagFacet = (
  notes: readonly NoteMeta[],
  opts?: { q?: string; limit?: number },
): TagFacet => {
  // The shaping (fold, per-note dedupe, subtree/direct counts, label casing, q/
  // limit) lives in libs/tags `buildTagFacet`, shared with the client graph so the
  // two surfaces agree by construction. Here it's just fed the snapshot's tags.
  return buildTagFacet(
    notes.map((n) => n.tags),
    opts,
  )
}
