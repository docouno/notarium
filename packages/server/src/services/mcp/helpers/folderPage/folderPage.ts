// The folder-page projection shared by the read and write tools: a folder's
// registry identity and the structural marker a page note carries.
// canon: docs/folder-page.md#model
import { type FolderPageMarker } from '@notarium/contract/tools'
import { FOLDER_PAGE_BASENAME, noteFileBase } from '@notarium/core'

import { type Ctx, ToolFailure } from '../../gateway'

/** A folder's id, when it HAS one. A folder is identified lazily — by a page, a move, a
 *  favorite or a project mark — so absence is the ordinary case, not a failure: an exact marked project on that
 *  path owns the id, else the plain folder-identity row. The id is durable ACROSS RENAME
 *  AND MOVE, which is what it is for — not unconditionally: unmarking a project drops its
 *  row without leaving a plain folder identity behind, so a page can lose the id it once
 *  reported, and marking that folder again mints a DIFFERENT one. Never derived from
 *  anything the model sent. */
const folderIdOf = async (
  ctx: Pick<Ctx, 'projectsInSpace' | 'folders'>,
  space: string,
  folderPath: string,
): Promise<string | undefined> => {
  const project = (await ctx.projectsInSpace(space)).find((r) => r.path === folderPath)

  if (project) {
    return project.id
  }
  const folder = await ctx.folders?.byPath(space, folderPath)

  return folder?.id
}

/** The marker a folder page carries wherever it is read back or echoed. */
export const folderPageMarker = async (
  ctx: Pick<Ctx, 'projectsInSpace' | 'folders'>,
  space: string,
  folderPath: string,
): Promise<FolderPageMarker> => {
  const folderId = await folderIdOf(ctx, space, folderPath)

  return { folderPath, ...(folderId ? { folderId } : {}) }
}

/** The reserved-name refusal, raised ONLY by an attempt that would land on a folder
 *  page. Keeping it off successful responses is deliberate: a permanent warning in
 *  every write echo would train agents to skim past it. The wording follows the DOOR:
 *  telling a caller who asked to rename a note to go call create_note reads as an
 *  instruction to author a page nobody asked for — the one thing the rest of this
 *  contract spends its words preventing. The door is required rather than defaulted: a
 *  third one should have to say which advice fits it, not inherit create's. */
export const reservedFolderPageError = (door: 'create' | 'rename'): ToolFailure =>
  new ToolFailure(
    door === 'rename'
      ? `\`${FOLDER_PAGE_BASENAME}\` is reserved for the Folder page, so this title would turn an ` +
          'ordinary note into one. Pick another title. If a Folder page is what you actually want, ' +
          'leave this note alone and author one deliberately with create_note.'
      : `\`${FOLDER_PAGE_BASENAME}\` is reserved for the Folder page. List the folder and call ` +
          'create_note with its `folderPage.createWith` arguments plus a body.',
  )

/** Would this title/fileName pair resolve to a folder's reserved page basename?
 *  Asked of the RESOLVED basename, not of the raw input: `title:"Index"` with no
 *  `fileName` at all already lands on `<folder>/index.md`, so a guard that only
 *  watched `fileName` would leave the whole lifecycle (identity minting, the active
 *  project's auto-pin) bypassable through the title. */
export const resolvesToFolderPage = (title: string, fileName?: string): boolean =>
  noteFileBase(title, fileName) === FOLDER_PAGE_BASENAME
