// Note lifecycle MCP tools: edit_note / delete_note / move_note / rename_note.
// canon: docs/mcp-gateway.md#tools
import { NOTE_CLASS } from '@notarium/contract'
import {
  type DeleteNoteInput,
  type EditNoteInput,
  type MoveNoteInput,
  type RenameNoteInput,
} from '@notarium/contract/tools'
import { editNote } from '@notarium/core'

import { safeRelAddress } from '../../../../libs/relPath'
import { prepareFieldWrite } from '../../../fields'
import { type Handler, ToolFailure } from '../../gateway'
import { dedupedWrite, wireSpace, writeEcho, type WriteRun } from '../../helpers/dedup'
import { mcpNoteMutationOptions, openMcpNoteDoor } from '../../helpers/noteDoor'
import { notePath, projectLabelForNote } from '../../helpers/projectAddressing'
import { writeAttributionOf } from '../../helpers/writeAttribution'
import { isUnsafeMcpFieldKey, sanitizeText } from '../../sanitize'

export const handleEditNote: Handler = async (ctx, rawArgs) => {
  const { ref, operation, content, fields, section, find, versionToken, idempotencyKey } =
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
  if (!hasOperation && fieldKeys.length === 0) {
    throw new ToolFailure('provide an operation/content pair, at least one field, or both')
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
  // Renames the file + UPDATEs the row in place; a no-op move (already at dest)
  // is a silent success. canon: docs/core.md#identity
  await hit.store.move({ id: noteId, destinationPath: dest }, mcpNoteMutationOptions)
  const personal = await ctx.personalSpace()
  // hit.space is the opaque id; wire label + project labeller take the slug.
  // `dest` is the authoritative new path (no re-read needed).
  const spaceSlug = ctx.spaces.slugOf(hit.space) ?? hit.space
  const projectHandle = projectLabelForNote(
    spaceSlug,
    dest,
    note.class,
    await ctx.projectsInSpace(hit.space),
  )
  const path = notePath(dest)
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
