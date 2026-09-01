// create_note / create_notes: the knowledge-write path.
// canon: docs/mcp-gateway.md#tools
import { detectSecretWarnings, NOTE_CLASS } from '@notarium/contract'
import {
  type BatchCreateResult,
  type CreateNoteInput,
  type CreateNoteItem,
  type CreateNotesInput,
  type InlineLink,
  type ToolName,
} from '@notarium/contract/tools'
import {
  applyLinks,
  deriveNoteTitle,
  FOLDER_PAGE_BASENAME,
  folderPageFilePath,
  type LinkSpec,
  sha256Hex,
} from '@notarium/core'

import { safeRelAddress } from '../../../../libs/relPath'
import { can } from '../../../authz'
import { type ProjectRecord } from '../../../metaDb'
import { folderPageNoteOf, materializeFolderPage } from '../../../projects'
import { type Ctx, type Handler, toolErrorMessage, ToolFailure } from '../../gateway'
import { dedupedWrite, wireSpace, writeEcho, type WriteRun } from '../../helpers/dedup'
import {
  folderPageMarker,
  reservedFolderPageError,
  resolvesToFolderPage,
} from '../../helpers/folderPage'
import { handleOf } from '../../helpers/projectAddressing'
import { writeAttributionOf } from '../../helpers/writeAttribution'
import { sanitizeText } from '../../sanitize'
import { resolveLinkTitle } from '../links'

type ProjectPrefixCache = Map<string, string | null>

const invalidFolder = (path: string | undefined): ToolFailure =>
  new ToolFailure(`"${path}" is not a valid folder path inside the project`)

/** Resolve create_note's two public folder forms without accepting a project handle
 * as a third form. Prefix classification delegates alias/shadowing to resolveProject. */
export const resolveCreateFolder = async (
  ctx: Pick<Ctx, 'resolveProject'>,
  rec: ProjectRecord,
  projectHandle: string,
  path: string | undefined,
  prefixCache: ProjectPrefixCache,
): Promise<string | undefined> => {
  const rel = path ? safeRelAddress(path.replace(/^\/+/, '')) : ''

  if (rel === null) {
    throw invalidFolder(path)
  }
  const underProject = rec.path !== '' && (rel === rec.path || rel.startsWith(`${rec.path}/`))

  if (underProject) {
    return rel || undefined
  }
  // Root projects collapse project-relative and space-relative grammar. A prefix
  // that resembles the root handle is therefore still an ordinary folder path.
  if (rec.path === '') {
    return rel || undefined
  }

  const segments = rel.split('/')

  if (segments.length >= 2) {
    const fullPrefix = segments.slice(0, 2).join('/')
    let prefixedProjectId = prefixCache.get(fullPrefix)

    if (!prefixCache.has(fullPrefix)) {
      try {
        prefixedProjectId = (await ctx.resolveProject(fullPrefix)).id
      } catch (err) {
        if (!(err instanceof ToolFailure)) {
          throw err
        }
        prefixedProjectId = null
      }
      prefixCache.set(fullPrefix, prefixedProjectId ?? null)
    }

    if (prefixedProjectId === rec.id) {
      const suffix = segments.slice(2).join('/')
      const relativeAdvice = suffix
        ? `Use the project-relative folder \`${suffix}\``
        : 'Omit `path` to use the project root'
      const spaceRelative = [rec.path, suffix].filter(Boolean).join('/')
      const exactHandleLike = [rec.path, rel].filter(Boolean).join('/')

      throw new ToolFailure(
        `Invalid path for project \`${projectHandle}\`: \`${path}\` starts with project handle ` +
          `\`${fullPrefix}\`, but \`path\` is a folder, not a project handle. ${relativeAdvice}, ` +
          `or use the exact space-relative folder \`${spaceRelative}\` from list_notes. ` +
          `If \`${fullPrefix}\` is a real subfolder name, use its exact space-relative path ` +
          `\`${exactHandleLike}\` from list_notes.`,
      )
    }
  }

  // Re-vet the composed path against a corrupt registry placement as well as input.
  const joined = [rec.path, rel].filter(Boolean).join('/')
  const safe = safeRelAddress(joined)

  if (safe === null) {
    throw invalidFolder(path)
  }

  return safe || undefined
}

/** Resolve inline `links` to LinkSpecs. Throws on the first invalid link —
 *  a created note's edges are all-or-error, never silently partial. */
const resolveInlineLinks = async (
  ctx: Ctx,
  fromSpace: string,
  links: InlineLink[] | undefined,
): Promise<LinkSpec[]> => {
  if (!links?.length) {
    return []
  }
  const specs: LinkSpec[] = []

  for (const l of links) {
    const title = await resolveLinkTitle(ctx, {
      fromSpace,
      relation: l.relation,
      to: l.to,
      toTitle: l.toTitle,
    })
    specs.push({ toTitle: title, relation: l.relation })
  }

  return specs
}

/** Shared write path behind create_note and each create_notes item.
 *  Caller MUST have already resolved + write-authorised the project. */
const createOneNote = async (
  ctx: Ctx,
  rec: ProjectRecord,
  projectHandle: string,
  toolName: ToolName,
  item: CreateNoteItem,
  personal: string | null,
  prefixCache: ProjectPrefixCache,
): Promise<Record<string, unknown>> => {
  const { title, body, path, type, tags, links, createdAt, fileName, idempotencyKey } = item
  const dir = await resolveCreateFolder(ctx, rec, projectHandle, path, prefixCache)
  // Body-first title: explicit `title` wins, else the body's leading `# H1`/first line.
  // A note we cannot title is refused with guidance, not stored as "(untitled)".
  const resolvedTitle = deriveNoteTitle(body, title)

  if (!resolvedTitle) {
    throw new ToolFailure(
      'A note needs a title — pass `title`, or start `body` with a `# Heading`.',
    )
  }
  // Refused BEFORE the write: an ordinary create must not become a folder page by
  // name alone, skipping the identity and pin lifecycle the semantic create owns.
  if (resolvesToFolderPage(resolvedTitle, fileName)) {
    throw reservedFolderPageError('create')
  }
  const { result, wasHit } = await dedupedWrite<WriteRun>(
    ctx,
    { toolName, idempotencyKey, scopeKey: rec.id },
    async () => {
      const spaceStore = await ctx.spaces.store(rec.space)
      // Fold inline links into the body in the SAME write (forward-refs accepted). The
      // integrity echo below still hashes the body the agent SENT, not this augmented
      // content — the relation lines are gateway-materialized, not transported bytes.
      const specs = await resolveInlineLinks(ctx, rec.space, links)
      const content = specs.length ? applyLinks(body, specs) : body
      const r = await spaceStore.write({
        title: resolvedTitle,
        content,
        directory: dir,
        noteType: type,
        tags,
        // Date-as-data (canon: docs/import.md#dates-as-data). No modifiedAt channel by
        // design — `modified` tracks real mtime. Wire date is nullable: null → omit.
        createdAt: createdAt ?? undefined,
        fileName,
        // Class is HARD-WIRED (poka-yoke): shared knowledge → user-doc, never agent-set.
        // canon: docs/note-model.md#note-classes
        targetClass: NOTE_CLASS.userDoc,
        ...writeAttributionOf(ctx),
      })
      // Integrity echo hashes the body the agent SENT (a transport check, NOT a
      // read-back — stored bytes differ: title stripped, links folded). A create
      // never clobbers, so the outcome is always 'created' on the live path.
      return {
        noteId: r.id ?? '',
        versionToken: r.versionToken ?? '',
        filePath: r.filePath,
        outcome: 'created' as const,
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        bodyHash: await sha256Hex(body),
      }
    },
  )
  const structured = writeEcho(result, wasHit, { space: wireSpace(ctx, rec.space, personal) })
  // Set unconditionally so a body-first create (and a replay) reports the title it got.
  structured.title = resolvedTitle
  // Secret advisory is a property of the body sent, not the write — computed even on replay.
  const warnings = detectSecretWarnings(body)

  if (warnings.length) {
    structured.warnings = warnings
  }

  return structured
}

/** The agent's ONE door to a folder page. `createWith` from list_notes saves the
 *  model a guess, but authorises nothing: project, folder path, write access and the
 *  folder's real existence are all re-resolved here, on every call. */
const createFolderPage = async (
  ctx: Ctx,
  rec: ProjectRecord,
  args: CreateNoteInput,
  personal: string | null,
): Promise<{ markdown: string; structured: Record<string, unknown> }> => {
  if (args.fileName !== undefined) {
    throw new ToolFailure(
      '`fileName` cannot be combined with `folderPage: true` — a folder page always ' +
        `stores as \`${FOLDER_PAGE_BASENAME}.md\`. Drop \`fileName\`.`,
    )
  }
  // No registry (meta-DB-less host) → no folder identity, so no pages. Honest
  // degradation, the same answer the REST route gives.
  if (!ctx.projects || !ctx.folders) {
    throw new ToolFailure('folder pages are not available on this host')
  }
  const projects = ctx.projects
  const folders = ctx.folders
  const folderPath = (await resolveCreateFolder(ctx, rec, args.project, args.path, new Map())) ?? ''
  const resolvedTitle = deriveNoteTitle(args.body, args.title)

  if (!resolvedTitle) {
    throw new ToolFailure(
      'A folder page needs a title — pass `title`, or start `body` with a `# Heading`.',
    )
  }
  const { result, wasHit } = await dedupedWrite<WriteRun>(
    ctx,
    { toolName: 'create_note', idempotencyKey: args.idempotencyKey, scopeKey: rec.id },
    async () => {
      const store = await ctx.spaces.store(rec.space)
      // Inline links are folded into the body in the SAME write, exactly as for an
      // ordinary create — a page is an ordinary note in every channel but its name.
      const specs = await resolveInlineLinks(ctx, rec.space, args.links)
      const content = specs.length ? applyLinks(args.body, specs) : args.body
      const materialized = await materializeFolderPage(
        {
          store,
          projects,
          folders,
          markerStore: ctx.markerStore,
          now: ctx.now,
          attribution: writeAttributionOf(ctx),
          onPostPrimaryError: (error) =>
            console.error('[mcp] folder page auto-pin failed ->', (error as Error)?.message),
        },
        {
          space: rec.space,
          folderPath,
          note: {
            title: resolvedTitle,
            content,
            noteType: args.type,
            tags: args.tags,
            createdAt: args.createdAt ?? undefined,
          },
        },
      )

      if (!materialized.ok) {
        throw new ToolFailure(
          materialized.reason === 'no-such-folder'
            ? `no such folder: \`${folderPath}\` — list_notes it first, and pass its ` +
                '`folderPage.createWith` unchanged.'
            : 'this folder already has a page — read it with get_note and change it with edit_note.',
        )
      }

      return {
        noteId: materialized.noteId,
        versionToken: materialized.versionToken,
        filePath: materialized.filePath,
        outcome: 'created' as const,
        bodyBytes: Buffer.byteLength(args.body, 'utf8'),
        bodyHash: await sha256Hex(args.body),
      }
    },
  )
  const structured = writeEcho(result, wasHit, { space: wireSpace(ctx, rec.space, personal) })
  // The dedup key is scoped by tool + project, NOT by what was asked, so a replay can
  // hand back the echo of an ordinary note an earlier call created — with no page
  // written anywhere. Claim the folder role only for a note that IS this folder's page,
  // read back from the store rather than assumed from the request.
  // On a real write the answer is usually already in hand — the run reports where it
  // landed, so the success path spends no third full snapshot scan. No class question
  // arises on that branch: this is the echo of a write THIS call just made, and the
  // lifecycle hard-wires `targetClass: user-doc` with the reserved file name, so the role
  // follows from the write rather than from inspecting an unknown note. A store that
  // reports no path, and every replay, does inspect one — and asks through the shared
  // predicate, because there the note could be anybody's.
  const landedAt = (result as WriteRun).filePath
  const page =
    !wasHit && landedAt
      ? undefined
      : await folderPageNoteOf(await ctx.spaces.store(rec.space), folderPath)
  const isThisPage =
    !wasHit && landedAt
      ? landedAt === folderPageFilePath(folderPath)
      : page?.id === structured.noteId

  // The title describes the note the echo NAMES, which on a replay is the note that was
  // STORED — not the title this call happened to ask for. A stranger's replay gets no
  // title at all rather than one belonging to a page that was never written.
  if (!wasHit) {
    structured.title = resolvedTitle
  } else if (isThisPage && page?.title) {
    structured.title = page.title
  }

  if (isThisPage) {
    // The marker itself comes from the registry: folder identity is the durable truth,
    // and a replay did not re-mint it.
    structured.folderPage = await folderPageMarker(ctx, rec.space, folderPath)
  }
  const warnings = detectSecretWarnings(args.body)

  if (warnings.length) {
    structured.warnings = warnings
  }
  const where = folderPath ? `\`${folderPath}\`` : 'the project root'
  const handleLabel = handleOf(rec, ctx.spaces.slugOf(rec.space) ?? rec.space)
  const markdown = !wasHit
    ? `Created the Folder page **${resolvedTitle}** for ${where} in project ` +
      `\`${handleLabel}\`. Note id \`${structured.noteId}\`.`
    : isThisPage
      ? `Idempotency key already used: nothing was written. The Folder page for ${where} ` +
        `is note \`${structured.noteId}\`.`
      : `Idempotency key already used by an earlier create_note in \`${handleLabel}\`: nothing ` +
        `was written and no Folder page was created for ${where}. The echo names that ` +
        `earlier note. Use a fresh idempotencyKey.`

  return { markdown, structured }
}

export const handleCreateNote: Handler = async (ctx, rawArgs) => {
  const args = rawArgs as CreateNoteInput
  // Resolve the project handle (404-semantic on miss/ambiguity). The personal domain
  // can hold projects; the write-access check below is the real barrier.
  const rec = await ctx.resolveProject(args.project)

  // No-write reads as "no such project" — 404-semantics deliberately covers both the
  // missing and the unauthorised case (anti-enumeration).
  if (!can(ctx.principal, 'space:write', { space: rec.space })) {
    throw new ToolFailure(`no such project: ${args.project}`)
  }

  if (args.folderPage) {
    return await createFolderPage(ctx, rec, args, await ctx.personalSpace())
  }
  const structured = await createOneNote(
    ctx,
    rec,
    args.project,
    'create_note',
    args,
    await ctx.personalSpace(),
    new Map(),
  )
  // Show the folder the note ACTUALLY landed in (derived from the result path — the
  // tolerant resolution may differ from the raw input), matching list_notes' namespace.
  const landed = typeof structured.path === 'string' ? structured.path : undefined
  const shownFolder =
    landed && landed.includes('/') ? landed.slice(0, landed.lastIndexOf('/')) : undefined
  const markdown =
    `Created **${structured.title}** in project \`${handleOf(rec, ctx.spaces.slugOf(rec.space) ?? rec.space)}\`` +
    `${shownFolder ? ` (folder \`${shownFolder}\`)` : ''}. Note id \`${structured.noteId}\`.`
  return { markdown, structured }
}

export const handleCreateNotes: Handler = async (ctx, rawArgs) => {
  const { project, notes } = rawArgs as CreateNotesInput
  // Resolve + write-authorise the project ONCE — every item lands in it.
  const rec = await ctx.resolveProject(project)

  if (!can(ctx.principal, 'space:write', { space: rec.space })) {
    throw new ToolFailure(`no such project: ${project}`)
  }
  const personal = await ctx.personalSpace()
  const prefixCache: ProjectPrefixCache = new Map()
  // Best-effort, NON-transactional: each item succeeds or fails on its own — one bad
  // item never rolls back the others. Per-item errors are sanitized (a collision
  // message can echo an untrusted title — threat-model).
  const results: BatchCreateResult[] = []

  for (let i = 0; i < notes.length; i++) {
    const item = notes[i]

    try {
      const echo = await createOneNote(
        ctx,
        rec,
        project,
        'create_notes',
        item,
        personal,
        prefixCache,
      )
      results.push({ ...echo, index: i, title: String(echo.title ?? ''), ok: true })
    } catch (err) {
      results.push({
        index: i,
        // Even on failure, echo the title the item WOULD have got, so a partial-batch
        // retry can correlate by title.
        title: deriveNoteTitle(item.body, item.title),
        ok: false,
        error: sanitizeText(toolErrorMessage(err, 'create_notes')),
      })
    }
  }
  const ok = results.filter((r) => r.ok).length
  const failed = results.length - ok
  const markdown =
    `Created ${ok} of ${notes.length} note${notes.length === 1 ? '' : 's'} in project ` +
    `\`${handleOf(rec, ctx.spaces.slugOf(rec.space) ?? rec.space)}\`${failed ? ` — ${failed} failed (see results)` : ''}.`
  return { markdown, structured: { results } }
}
