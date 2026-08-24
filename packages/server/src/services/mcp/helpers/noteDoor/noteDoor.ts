import { NOTE_CLASS } from '@notarium/contract'
import type { MutationOptions, NoteClass, NoteContent, RemoveOptions } from '@notarium/core'

import type { Action } from '../../../authz'
import type { LiveNoteAccess } from '../../../storeAccess'
import { type Ctx, ToolFailure } from '../../gateway'

export const isMcpNoteClassAllowed = (noteClass: NoteClass | undefined): boolean =>
  noteClass !== NOTE_CLASS.skill

export const assertMcpNoteClassAllowed = (note: Pick<NoteContent, 'class'>): void => {
  if (!isMcpNoteClassAllowed(note.class)) {
    throw new ToolFailure(
      'this note id addresses an ability package; use get_ability to read it, edit_ability to change it, or delete_ability to remove it',
    )
  }
}

export const mcpNoteMutationOptions = {
  assertCurrent: assertMcpNoteClassAllowed,
} satisfies Pick<MutationOptions & RemoveOptions, 'assertCurrent'>

/** Resolve access before applying the MCP-only class policy. A denied caller still
 * gets the ordinary anti-enumeration miss; an accessible ability package gets the
 * typed ability-door guidance. */
export const openMcpNoteDoor = async (
  ctx: Ctx,
  noteId: string,
  action: Action,
): Promise<LiveNoteAccess | null> => {
  const access = await ctx.store.noteStore(ctx.principal, noteId, action)

  if (!access) {
    return null
  }
  let note: Awaited<ReturnType<typeof access.store.read>>

  try {
    note = await access.store.read(noteId)
  } catch (error) {
    if ((error as { isNotFound?: boolean }).isNotFound) {
      return null
    }
    throw error
  }
  if (note.deleted) {
    return null
  }
  assertMcpNoteClassAllowed(note)

  return { ...access, noteId: note.id ?? noteId, note }
}
