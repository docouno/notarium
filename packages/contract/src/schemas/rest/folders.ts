import { z } from 'zod'
import {
  DurableAddressPathSchema,
  DurableNonEmptyAddressPathSchema,
  DurableNonEmptyPathSchema,
  SpaceSlugSchema,
} from '../primitives'
import { noteWriteFields } from './_fields'

// Plain (unmarked) folders are first-class: an empty folder is durable on-disk
// (never auto-pruned). POST creates one; DELETE removes a whole subtree (its
// notes, any markers, nested dirs). A folder carries no identity until it gets a
// `.notariummeta` marker (distinct from marking a project).
// Security: the path is untrusted — normalised + traversal-rejected server-side
// before it reaches the engine.
// canon: docs/note-model.md#note-ontology
export const CreateFolderRequestSchema = z.object({
  /** Relative folder path within the space; slashes nest (the last segment is
   *  the new folder's name). Must not be empty (the root always exists) and must
   *  not already exist (409). */
  path: DurableNonEmptyPathSchema,
})

/** POST /api/s/:space/folders/page — create a folder's page. Mints the
 *  folder's lazy identity if it has none, then writes `index.md` (user-doc) in it.
 *  `folderPath` is space-relative ('' = the space root). Optional note-write fields
 *  let the UI materialise a virtual folder page on first Save with the user's body
 *  in a single revision. 409 if a page already exists. */
export const CreateFolderPageRequestSchema = z.object({
  folderPath: DurableAddressPathSchema,
  title: noteWriteFields.title,
  content: noteWriteFields.content,
  noteType: noteWriteFields.noteType,
  tags: noteWriteFields.tags,
  slug: noteWriteFields.slug,
  createdAt: noteWriteFields.createdAt,
})

/** The page-create result: the folder's durable id + the new page note's id. */
export const CreateFolderPageResponseSchema = z.object({
  folderId: z.string(),
  pageNoteId: z.string(),
  path: z.string(),
})

/** GET /api/folder/:id — resolve a folder by its durable id, space-free
 *  like /api/note: the registry arbitrates the space, not a query param. Carries
 *  what the folder page needs before it fetches anything else: the space slug +
 *  path, the display name, and the page note's id when one exists (else the
 *  surface renders a virtual page).
 *  @see docs/contract.md#routing */
export const FolderResponseSchema = z.object({
  folderId: z.string(),
  space: SpaceSlugSchema,
  path: z.string(),
  name: z.string(),
  pageNoteId: z.string().optional(),
})

/** POST /api/folder/move — relocate a whole folder subtree: `path` is the source
 *  folder, `destinationPath` its new parent. Distinct from a single-note move. */
export const MoveFolderRequestSchema = z.object({
  path: DurableNonEmptyAddressPathSchema,
  destinationPath: DurableAddressPathSchema,
})

export type CreateFolderRequest = z.infer<typeof CreateFolderRequestSchema>

export type CreateFolderPageRequest = z.infer<typeof CreateFolderPageRequestSchema>

export type CreateFolderPageResponse = z.infer<typeof CreateFolderPageResponseSchema>

export type FolderResponse = z.infer<typeof FolderResponseSchema>

export type MoveFolderRequest = z.infer<typeof MoveFolderRequestSchema>
