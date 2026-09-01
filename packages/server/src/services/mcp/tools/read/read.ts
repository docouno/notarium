// Read tools: search / get_note / recall / list_notes / recent_activity — the agent's retrieval surface.
// canon: docs/mcp-gateway.md#tools
import { NOTE_CLASS, NOTE_SORT, parseFieldFilter, VIEW_AGENT_ROW_MAX } from '@notarium/contract'
import {
  type FolderEntry,
  type FolderPageSlot,
  type GetNoteInput,
  type GetNoteView,
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
  createReaderRegistry,
  directoryOf,
  folderPageFilePath,
  FrontmatterLimitError,
  type Graph,
  isFolderPageNote,
  isFolderPageOf,
  isPathUnder,
  listHeadings,
  memoryDirOf,
  type NoteClass,
  type NoteMeta,
  parseBodyFrontmatterBlock,
  parseViewDocument,
  queryNotes,
  READ_SCOPE,
  recall,
  type RecallTarget,
  replaceViewCarriers,
  treeChildren,
} from '@notarium/core'

import { safeRelAddress } from '../../../../libs/relPath'
import { can } from '../../../authz'
import { fieldDayFilterError } from '../../../fields'
import { type ProjectRecord } from '../../../metaDb'
import { folderExists } from '../../../projects'
import { type SpaceStore } from '../../../spaces'
import { ViewExecutionService } from '../../../views/execution'
import { VIEW_SOURCE_REGISTRY } from '../../../views/registry'
import { viewCacheScope } from '../../../views/sourceRegistry'
import { projectReaderView } from '../../../views/viewProjection'
import { type Handler, ToolFailure } from '../../gateway'
import { folderPageMarker } from '../../helpers/folderPage'
import { openMcpNoteDoor } from '../../helpers/noteDoor'
import { handleOf, notePath, projectLabelForNote } from '../../helpers/projectAddressing'
import { projectProvenance } from '../../helpers/provenance'
import {
  type CreateUnavailable,
  renderListNotes,
  renderNote,
  renderRecentActivity,
  renderSearch,
} from '../../helpers/render'
import { isUnsafeMcpFieldKey, sanitizeFrontmatter, sanitizeText } from '../../sanitize'

const LIST_FOLDERS_LIMIT = 200
/** recent_activity project filter is a post-filter (journal isn't path-indexed):
 *  over-fetch a deep window then filter. Multiplier + hard cap. */
const RECENT_PROJECT_OVERFETCH = 5
const RECENT_OVERFETCH_CAP = 200

const bodyWithoutMetadata = (body: string): string => {
  try {
    const block = parseBodyFrontmatterBlock(body)
    return block ? body.slice(block.bodyStart) : body
  } catch (error) {
    if (error instanceof FrontmatterLimitError) {
      return body
    }
    throw error
  }
}

const sanitizeViewValue = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return sanitizeText(value)
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeViewValue)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        sanitizeText(key),
        sanitizeViewValue(entry),
      ]),
    )
  }

  return value
}

const detailedViewProjection = async (
  ctx: Parameters<Handler>[0],
  hit: NonNullable<Awaited<ReturnType<typeof openMcpNoteDoor>>>,
  noteId: string,
): Promise<{
  content: string
  views?: GetNoteView[]
  viewRowsTruncated?: true
}> => {
  if (!hit) {
    return { content: '' }
  }
  const registry = ctx.viewReaders ?? createReaderRegistry([])
  const execution = new ViewExecutionService(registry, ctx.viewSources ?? VIEW_SOURCE_REGISTRY)
  const schema = await ctx.fieldSchemaStore?.read(hit.space)
  const saved = await execution.saved({
    store: hit.store,
    noteId,
    note: hit.note,
    projects: await ctx.projectsInSpace(hit.space),
    schema,
    cacheScope: viewCacheScope(hit.space, ctx.principal.id),
  })
  const views: GetNoteView[] = []
  const proseByBlock = new Map<number, string[]>()
  let remaining = VIEW_AGENT_ROW_MAX
  let anyTruncated = false

  for (const view of saved.parsed.views) {
    const prepared = view.viewRef ? saved.prepared.get(view.viewRef) : undefined
    const rows: unknown[] = []

    if (prepared?.rows && prepared.dataNeeds && remaining > 0) {
      if (prepared.groups?.length) {
        for (const group of prepared.groups) {
          if (remaining <= 0) {
            break
          }
          const window = execution.window(
            prepared,
            { group: group.key, offset: 0, limit: Math.min(remaining, VIEW_AGENT_ROW_MAX) },
            schema,
          )

          for (const row of window.rows) {
            rows.push(row)
          }
          remaining -= window.rows.length
        }
      } else {
        const window = execution.window(
          prepared,
          { offset: 0, limit: Math.min(remaining, VIEW_AGENT_ROW_MAX) },
          schema,
        )

        for (const row of window.rows) {
          rows.push(row)
        }
        remaining -= window.rows.length
      }
    }
    const rowsTruncated = (prepared?.total ?? 0) > rows.length

    anyTruncated ||= rowsTruncated
    views.push(
      sanitizeViewValue({
        viewRef: view.viewRef,
        block: view.block,
        occurrence: view.occurrence,
        name: view.name,
        type: view.type,
        status: prepared?.status ?? 'invalid',
        total: prepared?.total,
        groups: prepared?.groups,
        totalGroups: prepared?.totalGroups,
        groupsTruncated: prepared?.groupsTruncated,
        diagnostics: prepared?.diagnostics,
        execution: prepared?.execution,
        capabilities: prepared?.capabilities,
        snapshotGeneration: prepared?.snapshotGeneration,
        schemaVersionToken: prepared?.schemaVersionToken,
        ...(rows.length ? { rows } : {}),
        ...(rowsTruncated ? { rowsTruncated: true } : {}),
      }) as GetNoteView,
    )
    let prose: string

    if (
      prepared &&
      (prepared.status === 'ready' || prepared.status === 'incomplete') &&
      ctx.viewProjectionAdapters
    ) {
      const projected = projectReaderView(registry, ctx.viewProjectionAdapters, view.definition, {
        rows,
        groups: prepared.groups,
        total: prepared.total,
      })

      prose =
        projected.status === 'ready'
          ? projected.prose
          : projected.status === 'unsupported'
            ? `View “${view.name}” uses unavailable reader “${view.type}”.`
            : (projected.diagnostics[0] ?? `View “${view.name}” is invalid.`)
    } else {
      prose =
        prepared?.status === 'unsupported'
          ? `View “${view.name}” uses unavailable reader “${view.type}”.`
          : prepared?.status === 'invalid'
            ? (prepared.diagnostics?.[0] ?? `View “${view.name}” is invalid.`)
            : `View “${view.name}” · ${prepared?.total ?? 0} rows${prepared?.status === 'incomplete' ? ' · incomplete' : ''}.`
    }
    const blockProse = proseByBlock.get(view.block) ?? []

    blockProse.push(sanitizeText(prose))
    proseByBlock.set(view.block, blockProse)
  }
  const blocks = new Map(saved.parsed.blocks.map((block) => [block.occurrence, block]))
  const content = replaceViewCarriers(saved.note.content, (occurrence) => {
    const block = blocks.get(occurrence)

    if (!block) {
      return '\n\n'
    }
    const prose = proseByBlock.get(occurrence)
    const fallback = block.diagnostics.map((diagnostic) => sanitizeText(diagnostic.message))

    return `\n\n${(prose?.length ? prose : fallback).join('\n\n')}\n\n`
  })

  return {
    content,
    ...(views.length ? { views } : {}),
    ...(anyTruncated ? { viewRowsTruncated: true } : {}),
  }
}

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
    const viewTypeById = new Map<string, string>()

    for (const n of await spaceStore.list({ scope: READ_SCOPE.agentRecall })) {
      if (!n.id) {
        continue
      }
      modifiedById.set(n.id, n.modifiedAt)
      filePathById.set(n.id, n.filePath)
      if (n.viewType) {
        viewTypeById.set(n.id, n.viewType)
      }
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
        ...(viewTypeById.get(r.id) ? { viewType: sanitizeText(viewTypeById.get(r.id)!) } : {}),
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
  const hit = await openMcpNoteDoor(ctx, ref, 'note:read')

  if (!hit) {
    throw new ToolFailure('no such note, or you do not have access to it')
  }
  const note = hit.note
  const personal = await ctx.personalSpace()
  const noteId = hit.noteId
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
  // A page is an ordinary note everywhere except in what it MEANS: `class`/`path`
  // cannot say "this note is the body of its folder", so the role rides explicitly.
  const folderPage = isFolderPageOf(note.filePath, note.class)
    ? await folderPageMarker(ctx, hit.space, directoryOf(note.filePath as string))
    : undefined
  // Detailed also surfaces the heading outline (valid replaceSection targets); the shared
  // body-frontmatter reader keeps rule-fenced prose visible to both operations.
  // and graph edges. agent-memory notes aren't graph nodes → empty links, honest.
  const detailed = responseFormat === RESPONSE_FORMAT.detailed
  const carrier = parseViewDocument(note.content)
  const semanticContent = carrier.semanticContent
  const viewProjection =
    detailed && carrier.blocks.length > 0
      ? await detailedViewProjection(ctx, hit, noteId)
      : { content: semanticContent }
  const outline = detailed
    ? listHeadings(bodyWithoutMetadata(semanticContent)).map((h) => ({
        level: h.level,
        title: sanitizeText(h.text),
      }))
    : undefined
  const links = detailed ? await noteLinks(hit.store, noteId) : undefined
  const sanitizedFrontmatter = sanitizeFrontmatter(note.frontmatter)
  const structured = {
    noteId,
    title: sanitizeText(note.title ?? '(untitled)'),
    content: sanitizeText(note.content),
    frontmatter: sanitizedFrontmatter.frontmatter,
    ...(sanitizedFrontmatter.unsafeKeysOmitted
      ? { unsafeFrontmatterKeysOmitted: sanitizedFrontmatter.unsafeKeysOmitted }
      : {}),
    ...(hit.space === personal ? {} : { space: spaceSlug }),
    ...(projectHandle ? { project: projectHandle } : {}),
    ...(path ? { path } : {}),
    ...(note.class ? { class: note.class } : {}),
    ...(folderPage ? { folderPage } : {}),
    // CachedStore is CAS-capable and always answers a token; '' only on a bare
    // engine that would not be on this surface.
    versionToken: note.versionToken ?? '',
    ...(provenance ? { provenance } : {}),
    ...(outline ? { outline } : {}),
    ...(links ? { links } : {}),
    ...(viewProjection.views ? { views: viewProjection.views } : {}),
    ...(viewProjection.viewRowsTruncated ? { viewRowsTruncated: true as const } : {}),
  }
  const markdown = renderNote(
    { ...structured, content: sanitizeText(viewProjection.content) },
    responseFormat,
  )
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
  const { project, path, tag, field, fieldDay, fieldAny, fieldBad, limit, cursor } =
    rawArgs as ListNotesInput

  let space: string
  let base = '' // project root (space-relative); '' = personal domain / root project
  let handle: string | undefined
  let rec: ProjectRecord | undefined

  if (project) {
    rec = await ctx.resolveProject(project)
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

  // Direct notes only — one ls level, not the subtree. Tag filter is case-insensitive and hierarchical (`ml` also lists `ml/nlp`).
  // canon: docs/note-model.md#tags-as-a-navigation-axis-109
  const fieldFilter = parseFieldFilter({ field, fieldDay, fieldAny, fieldBad })

  if (fieldFilter?.nodes.some((node) => isUnsafeMcpFieldKey(node.key))) {
    throw new ToolFailure('field key is not available through the agent interface')
  }
  const fieldError = fieldDayFilterError(
    fieldFilter,
    fieldDay?.length ? await ctx.fieldSchemaStore?.read(space) : undefined,
  )

  if (fieldError) {
    throw new ToolFailure(fieldError)
  }
  const store = await ctx.spaces.store(space)
  const spaceNotes = (await store.list({ scope: READ_SCOPE.user })).filter((m) => m.id != null)
  const dirs = store.listDirs ? await store.listDirs() : []
  // The folder's PAGE is its cover, not one of its children: it is lifted out of the
  // population BEFORE any tag/field filter, cursor or `total`, so the slot below reads
  // the same on every page of a filtered listing — and never doubles as an item.
  // canon: docs/folder-page.md#model
  const pageNote = spaceNotes.find(
    (m) => m.filePath === folderPageFilePath(folder) && isFolderPageOf(m.filePath, m.class),
  )
  const contentNotes = spaceNotes.filter((m) => !isFolderPageNote(m.filePath))
  const direct = queryNotes(contentNotes, {
    sort: NOTE_SORT.title,
    offset: 0,
    folder,
    depth: 'direct',
    ...(tag ? { tags: [tag] } : {}),
    fields: fieldFilter,
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
      ...(m.viewType ? { viewType: sanitizeText(m.viewType) } : {}),
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
  const folderPage = await folderPageSlot(ctx, {
    space,
    store,
    folder,
    base,
    handle,
    rec,
    pageNote,
    seen: { notes: spaceNotes, dirs },
  })
  const structured = {
    items,
    folders,
    total,
    ...(folderPage ? { folderPage } : {}),
    ...(nextCursor ? { nextCursor } : {}),
  }
  // Why the slot carries no action, when it carries none: prose must not tell an owner
  // browsing their own personal domain that creating a page is beyond them.
  const unavailable: CreateUnavailable | undefined =
    folderPage?.status === 'missing' && !folderPage.createWith
      ? can(ctx.principal, 'space:write', { space })
        ? 'unaddressed'
        : 'no-write'
      : undefined
  const markdown = renderListNotes(items, folders, total, folder, folderPage, unavailable)
  return { markdown, structured }
}

/** The listed folder's page slot — present, missing, or ABSENT when no such folder
 *  exists. A path nobody ever created must not read as "a folder still lacking its
 *  page": that would invent a folder to author into. The listing itself keeps its
 *  existing behaviour on a ghost path (an empty listing, not a new error) — the slot
 *  is simply not published. */
const folderPageSlot = async (
  ctx: Parameters<Handler>[0],
  input: {
    space: string
    store: SpaceStore
    folder: string
    base: string
    handle?: string
    rec?: ProjectRecord
    pageNote?: { id?: string | null; title: string }
    /** What this listing already read, so the common case costs no second scan. */
    seen: { notes: readonly NoteMeta[]; dirs: readonly string[] }
  },
): Promise<FolderPageSlot | undefined> => {
  const { space, store, folder, base, handle, rec, pageNote, seen } = input

  // The resolved base (project root / personal domain root) exists by construction.
  // Below it, answer from the snapshot this call already loaded whenever that is
  // enough: its user-scope notes are a SUBSET of the shared predicate's population and
  // `dirs` is the same list, so a hit here is a hit there — it can only save the second
  // full read, never disagree with it. A miss falls through to the shared helper, the
  // only one that also sees a folder carrying nothing but hidden-class content.
  const seenHere =
    folder === base ||
    seen.dirs.includes(folder) ||
    seen.notes.some((note) => isPathUnder(note.filePath, folder))

  if (!seenHere && !(await folderExists(store, folder))) {
    return undefined
  }
  const marker = await folderPageMarker(ctx, space, folder)

  if (pageNote?.id) {
    return {
      status: 'present',
      ...marker,
      noteId: pageNote.id,
      title: sanitizeText(pageNote.title),
    }
  }
  // The create action is offered only where it is actually expressible: this listing
  // was addressed through a project handle AND the credential may write there. It is
  // a convenience, never authority — create re-resolves all of it.
  const writable = Boolean(rec && handle) && can(ctx.principal, 'space:write', { space })
  const createWith = writable
    ? {
        project: handle!,
        ...(folder === rec!.path ? {} : { path: folder }),
        folderPage: true as const,
      }
    : undefined

  return { status: 'missing', ...marker, ...(createWith ? { createWith } : {}) }
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
