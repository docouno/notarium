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
import { applyLinks, deriveNoteTitle, type LinkSpec, sha256Hex } from '@notarium/core'

import { safeRelAddress } from '../../../../libs/relPath'
import { can } from '../../../authz'
import { type ProjectRecord } from '../../../metaDb'
import { type Ctx, type Handler, toolErrorMessage, ToolFailure } from '../../gateway'
import { dedupedWrite, wireSpace, writeEcho, type WriteRun } from '../../helpers/dedup'
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
