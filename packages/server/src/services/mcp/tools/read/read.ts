// Read tools: search / get_note / recall / list_notes / recent_activity — the agent's retrieval surface.
// canon: docs/mcp-gateway.md#tools
import { NOTE_CLASS, NOTE_SORT } from '@notarium/contract'
import {
  type FolderEntry,
  type GetNoteInput,
  type ListNotesInput,
  type ListNotesItem,
  type NoteLink,
  type RecallInput,
  type RecentActivityInput,
  type RecentActivityItem,
  RESPONSE_FORMAT,
  type SearchHit,
  type SearchInput,
} from '@notarium/contract/tools'
import {
  type Graph,
  isPathUnder,
  listHeadings,
  memoryDirOf,
  type NoteClass,
  queryNotes,
  READ_SCOPE,
  recall,
  type RecallTarget,
  stripFrontmatter,
  treeChildren,
} from '@notarium/core'

import { safeRelAddress } from '../../../../libs/relPath'
import { type ProjectRecord } from '../../../metaDb'
import { type SpaceStore } from '../../../spaces'
import { type Handler, ToolFailure } from '../../gateway'
import { handleOf, notePath, projectLabelForNote } from '../../helpers/projectAddressing'
import { projectProvenance } from '../../helpers/provenance'
import {
  renderListNotes,
  renderNote,
  renderRecentActivity,
  renderSearch,
} from '../../helpers/render'
import { sanitizeFrontmatter, sanitizeText } from '../../sanitize'

const LIST_FOLDERS_LIMIT = 200
/** recent_activity project filter is a post-filter (journal isn't path-indexed):
 *  over-fetch a deep window then filter. Multiplier + hard cap. */
const RECENT_PROJECT_OVERFETCH = 5
const RECENT_OVERFETCH_CAP = 200

export const handleSearch: Handler = async (ctx, rawArgs) => {
  const { query, project, class: classFilter, responseFormat, limit } = rawArgs as SearchInput
  const personal = await ctx.personalSpace()

  let targets: string[]
  // Project narrow runs gateway-side (matchesNarrow), NOT as an in-query pathPrefix:
  // search now spans agent-memory (a separate mount) and a pathPrefix would drop it in-query.
  // canon: docs/projects.md#memory-two-axes
  let narrow: ProjectRecord | undefined

  if (project) {
    const rec = await ctx.resolveProject(project)
    targets = [rec.space]
    narrow = rec
  } else {
    targets = await ctx.readableSpaces()
  }
  const matchesNarrow = (filePath: string | undefined, cls: NoteClass | undefined): boolean => {
    if (!narrow) {
      return true
    }
    if (!filePath) {
      return false
    }
    if (cls === NOTE_CLASS.agentMemory) {
      return memoryDirOf(filePath) === narrow.id
    }

    return narrow.path === '' || isPathUnder(filePath, narrow.path)
  }

  const scored: Array<{ hit: SearchHit; score: number }> = []

  for (const spaceId of targets) {
    // Seam: space ids are opaque; slugOf() → the wire slug.
    const spaceSlug = ctx.spaces.slugOf(spaceId) ?? spaceId
    const spaceStore = await ctx.spaces.store(spaceId)
    // scope agentRecall spans the agent's knowledge AND its agent-memory, so "search before write" dedup reaches memory.
    // canon: docs/note-model.md#agent-memory
    const results = await spaceStore.search(query, { scope: READ_SCOPE.agentRecall })

    if (!results.length) {
      continue
    }
    // Search port carries no date/path — enrich from the note list. Same agentRecall scope so memory ids line up.
    const modifiedById = new Map<string, string | null>()
    const filePathById = new Map<string, string>()

    for (const n of await spaceStore.list({ scope: READ_SCOPE.agentRecall })) {
      if (!n.id) {
        continue
      }
      modifiedById.set(n.id, n.modifiedAt)
      filePathById.set(n.id, n.filePath)
    }
    // Fetch projects even for the personal/default space: in none-mode the default space holds projects (empty registry → no label).
    const projectsHere = await ctx.projectsInSpace(spaceId)

    for (const r of results) {
      if (!r.id) {
        continue
      }
      const filePath = filePathById.get(r.id)

      if (!matchesNarrow(filePath, r.class)) {
        continue
      }
      if (classFilter && r.class !== classFilter) {
        continue
      }
      const projectHandle = projectLabelForNote(spaceSlug, filePath, r.class, projectsHere)
      const path = notePath(filePath)
      const hit: SearchHit = {
        noteId: r.id,
        title: sanitizeText(r.title ?? '(untitled)'),
        snippet: sanitizeText(r.snippet),
        // Three-state wire shape: `space` omitted = personal domain. Compare by id, emit the slug.
        // canon: docs/projects.md#addressing
        ...(spaceId === personal ? {} : { space: spaceSlug }),
        ...(projectHandle ? { project: projectHandle } : {}),
        ...(path ? { path } : {}),
        ...(r.class ? { class: r.class } : {}),
        ...(r.score != null ? { score: r.score } : {}),
        modifiedAt: modifiedById.get(r.id) ?? null,
      }
      scored.push({ hit, score: r.score ?? 0 })
    }
  }
  // Global ranking across fanned-out spaces is best-effort but valid: one engine kind per host → scores comparable.
  scored.sort((a, b) => b.score - a.score)
  const results = scored.slice(0, limit).map((s) => s.hit)

  const structured = { results }
  const markdown = renderSearch(results, responseFormat)
  return { markdown, structured }
}

export const handleGetNote: Handler = async (ctx, rawArgs) => {
  const { ref, responseFormat } = rawArgs as GetNoteInput
  // Unknown id, foreign space and tombstone all collapse to one 404 (anti-enum).
  const hit = await ctx.store.noteStore(ctx.principal, ref, 'note:read')

  if (!hit) {
    throw new ToolFailure('no such note, or you do not have access to it')
  }
  const note = await hit.store.read(ref)
  const personal = await ctx.personalSpace()
  const noteId = note.id ?? ref
  // Provenance keyed by the RESOLVED id (a wiki-ref is not the journal key); absent on a non-journalling host.
  // canon: docs/note-history.md#model
  const provenance = await projectProvenance(hit.store, noteId)
  // Agent speaks slugs: emit slugOf(id); internal lookups stay on the id.
  const spaceSlug = ctx.spaces.slugOf(hit.space) ?? hit.space
  // `space` field suppressed for the personal domain, but the project label is derived regardless:
  // in none-mode the default space is personal AND holds projects, so a project must still surface.
  const projectHandle = projectLabelForNote(
    spaceSlug,
    note.filePath,
    note.class,
    await ctx.projectsInSpace(hit.space),
  )
  const path = notePath(note.filePath)
  // detailed also surfaces the heading outline (valid replaceSection targets, same extractor edit_note matches)
  // and graph edges. agent-memory notes aren't graph nodes → empty links, honest.
  const detailed = responseFormat === RESPONSE_FORMAT.detailed
  const outline = detailed
    ? listHeadings(stripFrontmatter(note.content)).map((h) => ({
        level: h.level,
        title: sanitizeText(h.text),
      }))
    : undefined
  const links = detailed ? await noteLinks(hit.store, noteId) : undefined
  const structured = {
    noteId,
    title: sanitizeText(note.title ?? '(untitled)'),
    content: sanitizeText(note.content),
    frontmatter: sanitizeFrontmatter(note.frontmatter),
    ...(hit.space === personal ? {} : { space: spaceSlug }),
    ...(projectHandle ? { project: projectHandle } : {}),
    ...(path ? { path } : {}),
    ...(note.class ? { class: note.class } : {}),
    // CachedStore is CAS-capable and always answers a token; '' only on a bare
    // engine that would not be on this surface.
    versionToken: note.versionToken ?? '',
    ...(provenance ? { provenance } : {}),
    ...(outline ? { outline } : {}),
    ...(links ? { links } : {}),
  }
  const markdown = renderNote(structured, responseFormat)
  return { markdown, structured }
}

/** A note's outgoing/incoming typed graph edges (cached space graph, user scope).
 *  `noteId` absent for an outgoing edge to an unresolved ghost target; degrades to empty on a graph-less engine. */
const noteLinks = async (
  store: SpaceStore,
  noteId: string,
): Promise<{ outgoing: NoteLink[]; incoming: NoteLink[] }> => {
  let g: Graph

  try {
    g = await store.graph({ scope: READ_SCOPE.user })
  } catch {
    return { outgoing: [], incoming: [] }
  }
  const nodeById = new Map<string, { title: string; ghost: boolean }>()

  for (const n of g.nodes) {
    nodeById.set(n.id, { title: n.title, ghost: n.ghost })
  }
  const outgoing: NoteLink[] = []
  const incoming: NoteLink[] = []

  for (const l of g.links) {
    if (l.source === noteId) {
      const tgt = nodeById.get(l.target)
      outgoing.push({
        ...(tgt && !tgt.ghost ? { noteId: l.target } : {}),
        title: sanitizeText(tgt?.title ?? l.target),
        relation: sanitizeText(l.type),
      })
    }
    if (l.target === noteId) {
      const src = nodeById.get(l.source)
      incoming.push({
        ...(src ? { noteId: l.source } : {}),
        title: sanitizeText(src?.title ?? l.source),
        relation: sanitizeText(l.type),
      })
    }
  }

  return { outgoing, incoming }
}

export const handleRecall: Handler = async (ctx, rawArgs) => {
  const { query, project, budgetTokens, depth, maxPerSource } = rawArgs as RecallInput
  const personal = await ctx.personalSpace()

  // A project handle narrows recall to a PURE project lens: the project's subtree +
  // its own `.notarium/memory/<id>/` only — nothing from the personal domain or sibling projects.
  const targets: RecallTarget[] = []

  if (project) {
    // Resolve the handle (existence + reachability collapse to one 404, anti-enum).
    const rec = await ctx.resolveProject(project)
    const projectsHere = await ctx.projectsInSpace(rec.space)
    // Emit the slug; store + isPersonal compare on the id.
    const spaceSlug = ctx.spaces.slugOf(rec.space) ?? rec.space
    targets.push({
      slug: spaceSlug,
      isPersonal: rec.space === personal,
      store: await ctx.spaces.store(rec.space),
      narrow: { pathPrefix: rec.path, memorySubdir: rec.id },
      projectOf: (fp, cls) => projectLabelForNote(spaceSlug, fp, cls, projectsHere),
    })
  } else {
    // Full fan-out across every reachable space (incl. the personal domain), un-narrowed.
    for (const id of await ctx.readableSpaces()) {
      // Fetch projects even for the personal/default space: none-mode's default space holds projects.
      const projectsHere = await ctx.projectsInSpace(id)
      const spaceSlug = ctx.spaces.slugOf(id) ?? id
      targets.push({
        slug: spaceSlug,
        isPersonal: id === personal,
        store: await ctx.spaces.store(id),
        projectOf: (fp, cls) => projectLabelForNote(spaceSlug, fp, cls, projectsHere),
      })
    }
  }

  const res = await recall(targets, { query, budgetTokens, depth, maxPerSource })
  // Defang untrusted title/context on the way out; sanitizeText is length-preserving, so the op's token budget stays honest.
  const sources = res.sources.map((s) => {
    const path = notePath(s.filePath)
    return {
      noteId: s.noteId,
      title: sanitizeText(s.title),
      ...(s.space ? { space: s.space } : {}),
      ...(s.project ? { project: s.project } : {}),
      ...(path ? { path } : {}),
      ...(s.class ? { class: s.class } : {}),
    }
  })
  const context = sanitizeText(res.context)
  const structured = {
    context,
    sources,
    ...(res.truncated ? { truncated: true } : {}),
  }
  const markdown = sources.length
    ? context
    : `No relevant notes found for “${sanitizeText(query)}”.`
  return { markdown, structured }
}

/** Is folder `f` inside `base`? (segment-boundary check; base '' = the whole space) */
const folderInSubtree = (f: string, base: string): boolean =>
  base === '' || f === base || f.startsWith(`${base}/`)

export const handleListNotes: Handler = async (ctx, rawArgs) => {
  const { project, path, tag, limit, cursor } = rawArgs as ListNotesInput

  let space: string
  let base = '' // project root (space-relative); '' = personal domain / root project
  let handle: string | undefined

  if (project) {
    const rec = await ctx.resolveProject(project)
    space = rec.space
    base = rec.path
    handle = handleOf(rec, ctx.spaces.slugOf(rec.space) ?? rec.space)
  } else {
    const personal = await ctx.personalSpace()

    if (!personal) {
      return {
        markdown: 'You have no personal notes yet.',
        structured: { items: [], folders: [], total: 0 },
      }
    }
    space = personal
  }

  // A given path must stay inside the project subtree (poka-yoke: feed back a folder's `path`, don't construct one).
  let folder = base

  if (path !== undefined) {
    const safe = safeRelAddress(path)

    if (safe === null) {
      throw new ToolFailure(`"${path}" is not a valid folder path`)
    }
    folder = safe
    if (handle && !folderInSubtree(folder, base)) {
      throw new ToolFailure(`"${path}" is not inside project \`${handle}\`.`)
    }
  }

  const store = await ctx.spaces.store(space)
  const spaceNotes = (await store.list({ scope: READ_SCOPE.user })).filter((m) => m.id != null)
  const dirs = store.listDirs ? await store.listDirs() : []

  // Direct notes only — one ls level, not the subtree. Tag filter is case-insensitive and hierarchical (`ml` also lists `ml/nlp`).
  // canon: docs/note-model.md#tags-as-a-navigation-axis-109
  const direct = queryNotes(spaceNotes, {
    sort: NOTE_SORT.title,
    offset: 0,
    folder,
    depth: 'direct',
    ...(tag ? { tags: [tag] } : {}),
  }).notes

  const total = direct.length
  const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0
  const pageMetas = direct.slice(offset, offset + limit)

  const items: ListNotesItem[] = pageMetas.map((m) => {
    const tags = m.tags
    return {
      noteId: m.id as string,
      title: sanitizeText(m.title),
      path: notePath(m.filePath) ?? m.filePath,
      ...(tags && tags.length ? { tags: tags.map(sanitizeText) } : {}),
      modifiedAt: m.modifiedAt,
    }
  })

  // Direct subfolders with SUBTREE counts (not direct); pass a `path` back to drill in.
  const folders: FolderEntry[] = treeChildren(spaceNotes, dirs, {
    path: folder,
    offset: 0,
    limit: 0,
  })
    .folders.slice(0, LIST_FOLDERS_LIMIT)
    .map((f) => ({ path: f.path, name: sanitizeText(f.name), count: f.count }))

  const nextCursor = offset + limit < total ? String(offset + limit) : undefined
  const structured = { items, folders, total, ...(nextCursor ? { nextCursor } : {}) }
  const markdown = renderListNotes(items, folders, total, folder)
  return { markdown, structured }
}

export const handleRecentActivity: Handler = async (ctx, rawArgs) => {
  const { project, limit } = rawArgs as RecentActivityInput
  const personal = await ctx.personalSpace()

  type Row = { sortKey: string; item: RecentActivityItem }
  const rows: Row[] = []
  let truncated = false

  // Journal isn't path-indexed → a project filter over-fetches a deep window then filters (honest `truncated`).
  // revisionsSince already excludes agent-memory, so the user-doc labeller applies (cls undefined).
  const collectSpace = async (spaceId: string, narrow?: ProjectRecord): Promise<void> => {
    const store = await ctx.spaces.store(spaceId)

    if (!store.revisionsSince) {
      return
    } // bare engine — honest empty
    // Seam: spaceId is the opaque id; the wire label + labeller take the slug.
    const spaceSlug = ctx.spaces.slugOf(spaceId) ?? spaceId
    const fetch = narrow ? Math.min(limit * RECENT_PROJECT_OVERFETCH, RECENT_OVERFETCH_CAP) : limit
    const res = await store.revisionsSince(null, fetch)

    if (res.total > res.items.length) {
      truncated = true
    }
    const fileById = new Map<string, string>()

    for (const m of await store.list({ scope: READ_SCOPE.user })) {
      if (m.id) {
        fileById.set(m.id, m.filePath)
      }
    }
    const projectsHere = await ctx.projectsInSpace(spaceId)

    for (const r of res.items) {
      const filePath = fileById.get(r.noteId)

      // Project narrow: keep only notes under the subtree (root '' = all).
      if (narrow && !(filePath ? isPathUnder(filePath, narrow.path) : narrow.path === '')) {
        continue
      }
      const projectHandle = filePath
        ? projectLabelForNote(spaceSlug, filePath, undefined, projectsHere)
        : undefined
      const p = notePath(filePath)
      rows.push({
        sortKey: r.createdAt,
        item: {
          noteId: r.noteId,
          title: sanitizeText(r.title),
          ...(spaceId === personal ? {} : { space: spaceSlug }),
          ...(projectHandle ? { project: projectHandle } : {}),
          ...(p ? { path: p } : {}),
          kind: r.kind,
          principal: r.principal,
          ...(r.unavailableReason ? { unavailableReason: r.unavailableReason } : {}),
          modifiedAt: r.createdAt,
        },
      })
    }
  }

  if (project) {
    const rec = await ctx.resolveProject(project)
    await collectSpace(rec.space, rec)
  } else {
    for (const slug of await ctx.readableSpaces()) {
      await collectSpace(slug)
    }
  }

  // Merge fanned-out spaces newest-first; tie-break on note-id so equal timestamps sort deterministically.
  rows.sort((a, b) => {
    if (a.sortKey !== b.sortKey) {
      return a.sortKey < b.sortKey ? 1 : -1
    }

    return a.item.noteId < b.item.noteId ? -1 : a.item.noteId > b.item.noteId ? 1 : 0
  })
  if (rows.length > limit) {
    truncated = true
  }
  const items = rows.slice(0, limit).map((r) => r.item)
  const structured = { items, ...(truncated ? { truncated: true } : {}) }
  const markdown = renderRecentActivity(items)
  return { markdown, structured }
}
