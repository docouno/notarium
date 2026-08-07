import { z } from 'zod'
import {
  DurableDisplayNameSchema,
  DurableNonEmptyScalarSchema,
  NoteClassSchema,
  SpaceSlugSchema,
} from '../primitives'
import { locationFields, sessionField } from './_fields'
import { ProjectHandleSchema, ProjectIdSchema, RefSchema } from './primitives'

const FolderLeafSchema = DurableNonEmptyScalarSchema.refine(
  (value) => !value.includes('/') && !value.includes('\\'),
  {
    message: '`name` is a folder name, not a path — use move_folder to change its location',
  },
)

/** Tool `delete_note`: move a note to the trash — the agent's one destructive tool,
 *  reversible by construction (only the USER restores/purges).
 *  canon: docs/mcp-gateway.md#tools */
export const DeleteNoteInputSchema = z.object({
  ...sessionField,
  ref: RefSchema,
})

/** Confirms what was trashed: id, title, location + `class` (memory vs knowledge). */
export const DeleteNoteOutputSchema = z.object({
  noteId: z.string(),
  title: z.string(),
  ...locationFields,
  class: NoteClassSchema.optional(),
})

/** Tool `move_note`: move a note to another folder, KEEPING its name (id, URL and
 *  inbound links survive). `toFolder` is a SPACE-relative `folders` path — feed one
 *  back, never hand-built. canon: docs/architecture.md#p7 */
export const MoveNoteInputSchema = z.object({
  ...sessionField,
  ref: RefSchema,
  toFolder: DurableNonEmptyScalarSchema.or(z.literal('')),
})

/** Confirms the move: id (unchanged) + the new location; `project` can change when
 *  the move crosses a project's folder boundary. */
export const MoveNoteOutputSchema = z.object({
  noteId: z.string(),
  ...locationFields,
})

/** Tool `rename_note`: change a note's TITLE (drives the filename); id and URL
 *  survive, LINK-SAFE (the old title becomes a resolving alias). No `versionToken`
 *  needed — a concurrent edit is still caught. canon: docs/architecture.md#p7 */
export const RenameNoteInputSchema = z.object({
  ...sessionField,
  ref: RefSchema,
  title: DurableNonEmptyScalarSchema,
})

/** Confirms the rename: id, new `title`, a fresh `versionToken` and the new location
 *  (`path` followed the title). */
export const RenameNoteOutputSchema = z.object({
  noteId: z.string(),
  title: z.string(),
  versionToken: z.string(),
  ...locationFields,
})

/** Tool `move_folder`: reparent a folder with all its contents, KEEPING its name;
 *  every note inside keeps its id, URL and inbound links. `folder`/`toFolder` are
 *  SPACE-relative `folders` paths; `project?` selects the space.
 *  canon: docs/architecture.md#p7 */
export const MoveFolderInputSchema = z.object({
  ...sessionField,
  folder: DurableNonEmptyScalarSchema,
  toFolder: DurableNonEmptyScalarSchema.or(z.literal('')),
  project: ProjectHandleSchema.optional(),
})

/** Tool `rename_folder`: rename a folder in place (contents move with it). If the
 *  folder is a marked PROJECT, its files move but the HANDLE does not (use
 *  rename_project). canon: docs/architecture.md#p7 */
export const RenameFolderInputSchema = z.object({
  ...sessionField,
  folder: DurableNonEmptyScalarSchema,
  name: FolderLeafSchema,
  project: ProjectHandleSchema.optional(),
})

/** Confirms a folder move/rename: the folder's new `path` + `space?`. Folders have
 *  no wire id — addressed by path. canon: docs/contract.md#wire-v2 */
export const FolderReorgOutputSchema = z.object({
  path: z.string(),
  space: SpaceSlugSchema.optional(),
})

/** Tool `rename_project`: change a project's HANDLE and/or display name (at least
 *  one), LINK-SAFE (the old handle stays a resolving alias). A ROOT project's handle
 *  is its space name and can't be changed here. canon: docs/architecture.md#p7 */
export const RenameProjectInputSchema = z.object({
  ...sessionField,
  project: ProjectHandleSchema,
  slug: z.string().min(1).optional(),
  displayName: DurableDisplayNameSchema.optional(),
})

/** Confirms a project rename: id (unchanged), new `handle`/`displayName`, and
 *  past-handle `aliases` that still resolve. */
export const RenameProjectOutputSchema = z.object({
  id: ProjectIdSchema,
  handle: ProjectHandleSchema,
  displayName: z.string(),
  aliases: z.array(z.string()).optional(),
})

export type DeleteNoteInput = z.infer<typeof DeleteNoteInputSchema>

export type DeleteNoteOutput = z.infer<typeof DeleteNoteOutputSchema>

export type MoveNoteInput = z.infer<typeof MoveNoteInputSchema>

export type MoveNoteOutput = z.infer<typeof MoveNoteOutputSchema>

export type RenameNoteInput = z.infer<typeof RenameNoteInputSchema>

export type RenameNoteOutput = z.infer<typeof RenameNoteOutputSchema>

export type MoveFolderInput = z.infer<typeof MoveFolderInputSchema>

export type RenameFolderInput = z.infer<typeof RenameFolderInputSchema>

export type FolderReorgOutput = z.infer<typeof FolderReorgOutputSchema>

export type RenameProjectInput = z.infer<typeof RenameProjectInputSchema>

export type RenameProjectOutput = z.infer<typeof RenameProjectOutputSchema>
