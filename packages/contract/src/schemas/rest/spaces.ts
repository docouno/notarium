import { z } from 'zod'
import { AuthorSchema, SpaceSlugSchema } from '../primitives'

export const SpaceSchema = z.object({
  /** Stable opaque identity — the client's rename-proof key. URLs use the
   *  slug; the id lets the client follow a space across a slug rename. */
  id: z.string().min(1),
  slug: SpaceSlugSchema,
  displayName: z.string().min(1),
  /** Past slugs so the client can canonicalise an old `/s/<old-slug>` URL to
   *  the current one; omitted when the space was never renamed. */
  aliases: z.array(SpaceSlugSchema).optional(),
  /** ISO timestamp the space was ARCHIVED (soft-delete). Absent on an active
   *  space — carried only by the archived-spaces listing (GET /api/spaces/archived),
   *  where it drives the "deleted N days ago" label. */
  archivedAt: z.string().nullable().optional(),
  /** Who archived it: the resolved, privacy-filtered Author — same shape
   *  a deleted note's `deletedBy` carries. Carried only by the archived-spaces listing. */
  archivedBy: AuthorSchema.nullable().optional(),
})

/** The spaces THIS PRINCIPAL can see — filtered to memberships, in the host's
 *  configured order. May be empty: a freshly invited user can hold no grants yet, and
 *  the client renders that honestly. Reused for the archived-spaces listing.
 *  canon: docs/architecture.md#p14 */
export const SpacesResponseSchema = z.object({
  spaces: z.array(SpaceSchema),
})

/** DELETE /api/spaces/:id — permanently purge an archived space: irreversible
 *  erasure of its notes, journal, blobs, index and memberships. `confirm` must equal
 *  the space's CURRENT slug — a server-side belt against a fat-fingered id. Only an
 *  already-archived space can be purged (archive is the mandatory safety stop). */
export const PurgeSpaceRequestSchema = z.object({
  confirm: z.string().min(1),
})

/** PATCH /api/s/:space — rename a space: a new slug and/or display name. An
 *  owner-level management act (admin recovery-override). Both optional; an empty body
 *  is a no-op.
 *  canon: docs/architecture.md#p14 */
export const PatchSpaceRequestSchema = z.object({
  slug: SpaceSlugSchema.optional(),
  displayName: z.string().min(1).max(200).optional(),
})

export type Space = z.infer<typeof SpaceSchema>

export type SpacesResponse = z.infer<typeof SpacesResponseSchema>

export type PatchSpaceRequest = z.infer<typeof PatchSpaceRequestSchema>

export type PurgeSpaceRequest = z.infer<typeof PurgeSpaceRequestSchema>
