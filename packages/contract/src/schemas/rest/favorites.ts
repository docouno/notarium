import { z } from 'zod'
import { FAVORITE_ENTITY_KIND } from '../../consts/favorites'
import { enumValues } from '../../libs/enumValues'
import { IsoTimestampSchema } from '../primitives'
import { NoteListItemSchema } from './notes'
import { ProjectRowSchema } from './projects'
import { TreeFolderSchema } from './tree'

export const FavoriteEntityKindSchema = z.enum(enumValues(FAVORITE_ENTITY_KIND))

export const FavoriteFolderSchema = TreeFolderSchema.extend({
  id: z.string(),
})

export const FavoriteItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(FAVORITE_ENTITY_KIND.note),
    id: z.string(),
    favoritedAt: IsoTimestampSchema,
    note: NoteListItemSchema,
  }),
  z.object({
    kind: z.literal(FAVORITE_ENTITY_KIND.folder),
    id: z.string(),
    favoritedAt: IsoTimestampSchema,
    folder: FavoriteFolderSchema,
  }),
  z.object({
    kind: z.literal(FAVORITE_ENTITY_KIND.project),
    id: z.string(),
    favoritedAt: IsoTimestampSchema,
    project: ProjectRowSchema,
  }),
])

export const FavoritesResponseSchema = z.object({
  items: z.array(FavoriteItemSchema),
  total: z.number(),
})

export const FavoritePutRequestSchema = z
  .object({
    kind: FavoriteEntityKindSchema,
    /** Stable id for notes/projects and already-identified folders. */
    id: z.string().optional(),
    /** Folder path fallback: the server lazy-mints a folder id before storing. */
    path: z.string().optional(),
  })
  .refine(
    (v) => (v.kind !== FAVORITE_ENTITY_KIND.folder ? Boolean(v.id) : Boolean(v.id || v.path)),
    {
      message: 'favorite target id or path is required',
    },
  )

export const FavoriteMutationResponseSchema = z.object({
  ok: z.literal(true),
  item: FavoriteItemSchema.optional(),
})
export type FavoriteFolder = z.infer<typeof FavoriteFolderSchema>

export type FavoriteItem = z.infer<typeof FavoriteItemSchema>

export type FavoritesResponse = z.infer<typeof FavoritesResponseSchema>

export type FavoritePutRequest = z.infer<typeof FavoritePutRequestSchema>

export type FavoriteMutationResponse = z.infer<typeof FavoriteMutationResponseSchema>
