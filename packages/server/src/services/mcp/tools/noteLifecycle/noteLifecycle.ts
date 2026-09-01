// Note lifecycle MCP tools: edit_note / delete_note / move_note / rename_note.
// canon: docs/mcp-gateway.md#tools
import { NOTE_CLASS } from '@notarium/contract'
import {
  type DeleteNoteInput,
  type EditNoteInput,
  type MoveNoteInput,
  type RenameNoteInput,
} from '@notarium/contract/tools'
import {
  applyEdit,
  directoryOf,
  editNote,
  isFolderPageOf,
  parseViewDocument,
  patchViewConfig,
  sameViewCarriers,
} from '@notarium/core'

import { safeRelAddress } from '../../../../libs/relPath'
import { prepareFieldWrite } from '../../../fields'
import { claimFolderIdentity, folderPageNoteOf, rehomeFolderPagePin } from '../../../projects'
import { type Handler, ToolFailure } from '../../gateway'
import { dedupedWrite, wireSpace, writeEcho, type WriteRun } from '../../helpers/dedup'
import { reservedFolderPageError, resolvesToFolderPage } from '../../helpers/folderPage'
import { mcpNoteMutationOptions, openMcpNoteDoor } from '../../helpers/noteDoor'
import { notePath, projectLabelForNote } from '../../helpers/projectAddressing'
import { writeAttributionOf } from '../../helpers/writeAttribution'
import { isUnsafeMcpFieldKey, sanitizeText } from '../../sanitize'

export const handleEditNote: Handler = async (ctx, rawArgs) => {
  const { ref, operation, content, fields, view, section, find, versionToken, idempotencyKey } =
    rawArgs as EditNoteInput
  const hasOperation = operation !== undefined
  const hasContent = content !== undefined
  const fieldKeys = Object.getOwnPropertyNames(fields ?? {})
  const fieldPatch = fieldKeys.length ? fields : undefined

  if (fieldKeys.some(isUnsafeMcpFieldKey)) {
    throw new ToolFailure('field key is not available through the agent interface')
  }

  if (hasOperation !== hasContent) {
    throw new ToolFailure('`operation` and `content` must be provided together')
  }
  if (view && (hasOperation || fieldKeys.length > 0)) {
    throw new ToolFailure('a structural view patch cannot be combined with body or field edits')
  }
  if (!hasOperation && fieldKeys.length === 0 && !view) {
    throw new ToolFailure('provide an operation/content pair, at least one field, or a view patch')
  }
  // Set inside the run; stays undefined on an idempotency replay (run skipped) —
  // writeEcho omits path/space on a skip anyway.
  let editSpace: string | undefined
  // Idempotency-key only, no content-hash window (edit_note is not a create): a
  // keyless retry of an additive append DUPLICATES. The key returns the original
  // edit's {noteId, versionToken}.
  const preflight = idempotencyKey ? await openMcpNoteDoor(ctx, ref, 'note:write') : null

  if (idempotencyKey && !preflight) {
    throw new ToolFailure('no such note, or you do not have access to it')
  }
  const { result, wasHit } = await dedupedWrite<WriteRun>(
    ctx,
    { toolName: 'edit_note', idempotencyKey, scopeKey: ref },
    async () => {
      // Resolve on note:write — unknown id, foreign space and tombstone all
      // collapse to one 404 (storeAccess) — anti-enumeration.
      const hit = await openMcpNoteDoor(ctx, ref, 'note:write')

      if (!hit) {
        throw new ToolFailure('no such note, or you do not have access to it')
      }
      editSpace = hit.space
      const fieldsUnquoted = fieldPatch
        ? await prepareFieldWrite(ctx.fieldSchemaStore, hit.space, fieldPatch)
        : undefined

      if (view) {
        const currentToken = hit.note.versionToken

        if (!currentToken) {
          throw new ToolFailure('this view document has no writable version token')
        }
        const parsed = parseViewDocument(hit.note.content, {
          documentId: hit.noteId,
          versionToken: currentToken,
        })
        let patched: ReturnType<typeof patchViewConfig>

        try {
          patched = patchViewConfig(hit.note.content, parsed, view.viewRef, view)
        } catch (error) {
          throw new ToolFailure((error as Error).message || 'view patch failed')
        }
        const r = await hit.store.write(
          {
            originalId: hit.noteId,
            title: hit.note.title ?? '',
            content: patched.content,
            versionToken: versionToken ?? currentToken,
            ...(patched.viewType !== undefined ? { viewType: patched.viewType } : {}),
            derivedContentUnchanged: true,
            ...writeAttributionOf(ctx),
          },
          mcpNoteMutationOptions,
        )

        return {
          noteId: r.id ?? hit.noteId,
          versionToken: r.versionToken ?? '',
          filePath: r.filePath,
        }
      }
      if (hasOperation) {
        const next = applyEdit(hit.note.content, {
          noteId: hit.noteId,
          operation,
          content,
          section,
          find,
        })

        if (!sameViewCarriers(hit.note.content, next)) {
          throw new ToolFailure(
            'generic text editing cannot structurally change `nota` view blocks; use `edit_note.view` with a fresh `viewRef`',
          )
        }
      }
      // canon: docs/contract.md#cas
      const r = await editNote(
        hit.store,
        {
          noteId: ref,
          current: hit.note,
          operation,
          content,
          section,
          find,
          fields: fieldPatch,
          fieldsUnquoted,
          versionToken,
          ...writeAttributionOf(ctx),
        },
        mcpNoteMutationOptions,
      )
      return {
        noteId: r.id ?? '',
        versionToken: r.versionToken ?? '',
        filePath: r.filePath,
        bodyBytes: r.bodyBytes,
        bodyHash: r.bodyHash,
      }
    },
  )
  const structured = writeEcho(result, wasHit, {
    space: wireSpace(ctx, editSpace, await ctx.personalSpace()),
  })
  const changes = [
    ...(operation ? [operation] : []),
    ...(fieldKeys.length ? [`fields: ${fieldKeys.map(sanitizeText).join(', ')}`] : []),
    ...(view ? ['view'] : []),
  ].join('; ')
  const markdown = `Edited note \`${result.noteId}\` (${changes})${wasHit ? ' — idempotent replay, no change' : ''}.`
  return { markdown, structured }
}

export const handleDeleteNote: Handler = async (ctx, rawArgs) => {
  const { ref } = rawArgs as DeleteNoteInput
  // Resolve on note:delete — unknown id, foreign space and an already-deleted
  // tombstone all collapse to one 404 (storeAccess + the read below) — anti-enumeration.
  const hit = await openMcpNoteDoor(ctx, ref, 'note:delete')

  if (!hit) {
    throw new ToolFailure('no such note, or you do not have access to it')
  }
  // Read BEFORE remove: echoes what was trashed and 404s honestly on a note
  // already in the trash (read throws not-found for a tombstone without deletedView).
  const note = hit.note
  const noteId = hit.noteId
  const personal = await ctx.personalSpace()
  // hit.space is the opaque id (compare on it); the wire `space` label and the
  // project labeller take the slug.
  const spaceSlug = ctx.spaces.slugOf(hit.space) ?? hit.space
  const projectHandle = projectLabelForNote(
    spaceSlug,
    note.filePath,
    note.class,
    await ctx.projectsInSpace(hit.space),
  )
  const path = notePath(note.filePath)
  // Soft-delete → the space trash (reversible). canon: docs/trash.md#model
  await hit.store.remove(noteId, { ...writeAttributionOf(ctx), ...mcpNoteMutationOptions })
  const structured: Record<string, unknown> = {
    noteId,
    title: sanitizeText(note.title ?? '(untitled)'),
    ...(hit.space === personal ? {} : { space: spaceSlug }),
    ...(projectHandle ? { project: projectHandle } : {}),
    ...(path ? { path } : {}),
    ...(note.class ? { class: note.class } : {}),
  }
  const what = note.class === NOTE_CLASS.agentMemory ? 'memory note' : 'note'
  const markdown =
    `Moved ${what} **${structured.title}** to the trash \`${noteId}\`. ` +
    'The user can restore it from the trash; you cannot undo this (restore and permanent delete are human actions).'
  return { markdown, structured }
}

export const handleMoveNote: Handler = async (ctx, rawArgs) => {
  const { ref, toFolder } = rawArgs as MoveNoteInput
  // Resolve on note:write — unknown id, foreign space and tombstone collapse to
  // one 404 (storeAccess) — anti-enumeration. Move is id-addressed: destination
  // folder is always WITHIN the note's own space (no cross-space moves).
  const hit = await openMcpNoteDoor(ctx, ref, 'note:write')

  if (!hit) {
    throw new ToolFailure('no such note, or you do not have access to it')
  }
  const note = hit.note
  const noteId = hit.noteId
  const current = note.filePath

  if (!current) {
    throw new ToolFailure('this note has no storage location to move')
  }
  // Strip a leading slash so `''`, `'/'` and `/docs` all read as space-relative
  // (else safeRelPath's absolute-path guard trips). safeRelPath then fails closed
  // on traversal / the `.notarium` dot-namespace — a user note can't reach the
  // agent-memory mount.
  const folder = safeRelAddress(toFolder.replace(/^\/+/, ''))

  if (folder === null) {
    throw new ToolFailure('bad destination folder')
  }
  const base = current.includes('/') ? current.slice(current.lastIndexOf('/') + 1) : current
  const dest = folder ? `${folder}/${base}` : base
  // Moving a page re-homes a folder's cover, so this is the LAST door to the reserved
  // basename: the file keeps its name, which is what makes the destination's page out
  // of it. The move itself stays legal — a plain `mv` on disk does the same thing and
  // the read surface reports the result honestly. What the pre-check buys is the ANSWER
  // on a collision: the store refuses a taken destination with a bare
  // `# Move Failed: a note already lives at the destination`, which names neither the
  // page nor a way forward. This is the same refusal the create door gives, before any
  // mutation. A racing create between here and the move still gets the store's raw
  // refusal — honest, just terser — and nothing is written either way: the id is minted
  // in the move's `finalize`, which a refused move never reaches.
  const isPage = isFolderPageOf(current, note.class)
  const rehomed = isPage && folder !== directoryOf(current)

  if (rehomed && (await folderPageNoteOf(hit.store, folder))) {
    throw new ToolFailure(
      `\`${folder || '(root)'}\` already has a Folder page — read it with get_note and change ` +
        'it with edit_note, or move this page somewhere without one.',
    )
  }
  // Renames the file + UPDATEs the row in place; a no-op move (already at dest)
  // is a silent success. canon: docs/core.md#identity
  // The destination folder now has an authored cover, which is the condition that mints
  // its id and pins it into an active project — so the move ADOPTS it, exactly as a
  // create would. Only on a REAL re-homing: a move to where the page already sits must
  // stay the no-op the tool promises, or repeating it would quietly undo a deliberate
  // manual unpin.
  const adopt =
    rehomed && ctx.projects && ctx.folders
      ? {
          store: hit.store,
          projects: ctx.projects,
          folders: ctx.folders,
          markerStore: ctx.markerStore,
          now: ctx.now,
          attribution: writeAttributionOf(ctx),
          onPostPrimaryError: (error: unknown) =>
            console.error('[mcp] folder page adoption failed ->', (error as Error)?.message),
        }
      : undefined
  const moved = await hit.store.move(
    { id: noteId, destinationPath: dest },
    {
      ...mcpNoteMutationOptions,
      // The id is minted inside the move's own claim, but AFTER the move: `finalize` is
      // the only hook where both halves of the precondition hold. A marker write is
      // metadata for a folder that already exists — it never provisions one — and the
      // destination folder may not exist until this very move creates it. `prepare`
      // would therefore mint nothing for a new folder, and would leave a row behind for
      // one that never received the note if anything later in the move refused.
      ...(adopt
        ? { finalize: () => claimFolderIdentity(adopt, { space: hit.space, folderPath: folder }) }
        : {}),
    },
  )
  const landed = moved.filePath ?? dest

  if (adopt) {
    // One decision for both ends: the tag says "this note is that project's overview", and
    // a move can make that false as easily as true. It rewrites the moved note's OWN tags,
    // so it cannot nest inside that note's mutation claim — post-primary and best-effort,
    // the same boundary the create door draws around its auto-pin.
    await rehomeFolderPagePin(adopt, {
      space: hit.space,
      from: directoryOf(current),
      to: folder,
      noteId,
    })
  }
  const personal = await ctx.personalSpace()
  // hit.space is the opaque id; wire label + project labeller take the slug. The path
  // comes from the store's own answer — it is the authority on where the note ended up;
  // `dest` is only the fallback for a store that does not report one.
  const spaceSlug = ctx.spaces.slugOf(hit.space) ?? hit.space
  const projectHandle = projectLabelForNote(
    spaceSlug,
    landed,
    note.class,
    await ctx.projectsInSpace(hit.space),
  )
  const path = notePath(landed)
  const structured: Record<string, unknown> = {
    noteId,
    ...(hit.space === personal ? {} : { space: spaceSlug }),
    ...(projectHandle ? { project: projectHandle } : {}),
    ...(path ? { path } : {}),
  }
  const markdown = `Moved note \`${noteId}\` to \`${path ?? '(root)'}\`.`
  return { markdown, structured }
}

export const handleRenameNote: Handler = async (ctx, rawArgs) => {
  const { ref, title } = rawArgs as RenameNoteInput
  const hit = await openMcpNoteDoor(ctx, ref, 'note:write')

  if (!hit) {
    throw new ToolFailure('no such note, or you do not have access to it')
  }
  const personal = await ctx.personalSpace()
  const spaceSlug = ctx.spaces.slugOf(hit.space) ?? hit.space
  // Read for the live body + fresh versionToken: rename does a full write, so the
  // body MUST be carried forward or the write would BLANK it. CAS makes a concurrent
  // edit conflict rather than clobber.
  const note = hit.note
  const noteId = hit.noteId
  const projectsHere = await ctx.projectsInSpace(hit.space)
  const labelFor = (filePath: string | null | undefined) =>
    projectLabelForNote(spaceSlug, filePath, note.class, projectsHere)

  // A rename recomputes the storage path from the new title, so it is a door to a
  // folder page: an ordinary note retitled `Index` would BECOME its folder's cover,
  // with no folder identity minted and no active-project pin. A note that is already a
  // page keeps renaming freely — the engine pins its basename. Asked of user-docs only:
  // a hidden-class note lives in a dot-namespaced mount, where `index.md` is somebody's
  // memory category and no folder's cover.
  if (
    !isFolderPageOf(note.filePath, note.class) &&
    (note.class ?? NOTE_CLASS.userDoc) === NOTE_CLASS.userDoc &&
    resolvesToFolderPage(title)
  ) {
    throw reservedFolderPageError('rename')
  }

  // No-op: title unchanged. Skip the write to avoid an empty alias / needless revision.
  if (note.title === title) {
    const path = notePath(note.filePath)
    const projectHandle = labelFor(note.filePath)
    const structured: Record<string, unknown> = {
      noteId,
      title,
      versionToken: note.versionToken ?? '',
      ...(hit.space === personal ? {} : { space: spaceSlug }),
      ...(projectHandle ? { project: projectHandle } : {}),
      ...(path ? { path } : {}),
    }
    return {
      markdown: `Note \`${noteId}\` is already named **${sanitizeText(title)}**.`,
      structured,
    }
  }
  // Full write with the new title; the old title lands in alias-history so inbound
  // [[Old Title]] keep resolving.
  const r = await hit.store.write(
    {
      originalId: noteId,
      title,
      content: note.content,
      versionToken: note.versionToken,
      ...writeAttributionOf(ctx),
    },
    mcpNoteMutationOptions,
  )
  const newPath = notePath(r.filePath)
  const projectHandle = labelFor(r.filePath)
  const structured: Record<string, unknown> = {
    noteId: r.id ?? noteId,
    title,
    versionToken: r.versionToken ?? '',
    ...(hit.space === personal ? {} : { space: spaceSlug }),
    ...(projectHandle ? { project: projectHandle } : {}),
    ...(newPath ? { path: newPath } : {}),
  }
  const markdown =
    `Renamed note \`${noteId}\` to **${sanitizeText(title)}**` +
    `${newPath ? ` (now at \`${newPath}\`)` : ''}. The old title still resolves as an alias.`
  return { markdown, structured }
}
