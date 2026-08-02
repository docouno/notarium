import { z } from 'zod'
import { PAT_SCOPE } from '../../consts/pats'
import { enumValues } from '../../libs/enumValues'
import { IsoTimestampSchema, SpaceSlugSchema } from '../primitives'

/** A token's scope — the ACTION ceiling it can reach. Management surfaces
 *  (members, users, PAT minting) sit above 'write' and are session-only — a
 *  leaked PAT can never mint tokens or grant access. Granularity beyond
 *  read/write is deferred research.
 *  canon: docs/architecture.md#p14 */
export const PatScopeSchema = z.enum(enumValues(PAT_SCOPE))

/** One PAT as the management UI lists it. The secret appears EXACTLY once, in
 *  PatCreateResponse — the server stores a hash and honestly can't repeat it. */
export const PatSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: PatScopeSchema,
  /** Spaces this token is narrowed to; null = all the owner's grants (the
   *  restriction intersects with live membership at every check). */
  spaces: z.array(SpaceSlugSchema).nullable(),
  createdAt: z.string(),
  expiresAt: IsoTimestampSchema,
  lastUsedAt: IsoTimestampSchema,
})

export const PatsResponseSchema = z.object({ tokens: z.array(PatSchema) })

export const PatCreateRequestSchema = z.object({
  name: z.string().min(1).max(64),
  scope: PatScopeSchema,
  spaces: z.array(SpaceSlugSchema).min(1).nullable().optional(),
  /** Full ISO expiry, null/absent = non-expiring (the UI offers presets). */
  expiresAt: z.string().nullable().optional(),
})

export const PatCreateResponseSchema = z.object({
  /** The bearer secret (`ntp_<id>_<secret>`) — shown once, stored hashed. */
  token: z.string(),
  pat: PatSchema,
})

/** Change a live PAT's rights: raise/lower the scope and/or re-narrow the
 *  spaces WITHOUT re-minting the secret. Both fields optional (patch semantics);
 *  scope/spaces follow the same ceiling + narrowing rules as create (see PatScope
 *  and PatSchema.spaces). Takes effect on the token's NEXT request — the principal
 *  is re-derived per request, so no re-login. */
export const PatPatchRequestSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  scope: PatScopeSchema.optional(),
  spaces: z.array(SpaceSlugSchema).min(1).nullable().optional(),
})

export const ConnectionSchema = z.object({
  /** The connecting app's OAuth client id — the revoke/patch key (one row per app,
   *  grouped from all its tokens). Never a token secret, never an access-token id. */
  id: z.string(),
  /** The connecting app's name (the OAuth client's `client_name`, e.g. "Claude"
   *  / "ChatGPT"); null when the client supplied none. */
  appName: z.string().nullable(),
  /** The action ceiling the user consented to (read|write — never manage). */
  scope: PatScopeSchema,
  /** Spaces this connection is narrowed to; null = all grants — same
   *  narrowing semantics as PatSchema.spaces above. */
  spaces: z.array(SpaceSlugSchema).nullable(),
  createdAt: z.string(),
  lastUsedAt: IsoTimestampSchema,
})

export const ConnectionsResponseSchema = z.object({ connections: z.array(ConnectionSchema) })

/** Change a connected app's access level and/or per-space narrowing
 *  WITHOUT re-consenting. Applied to every live token of the app (access + refresh)
 *  so the change survives the hourly refresh rotation; takes effect on the next
 *  call. Both fields optional (patch semantics); scope/spaces follow the same
 *  rules as PatPatchRequest. */
export const ConnectionPatchRequestSchema = z.object({
  scope: PatScopeSchema.optional(),
  spaces: z.array(SpaceSlugSchema).min(1).nullable().optional(),
})
export type Pat = z.infer<typeof PatSchema>

export type PatsResponse = z.infer<typeof PatsResponseSchema>

export type PatCreateRequest = z.infer<typeof PatCreateRequestSchema>

export type PatCreateResponse = z.infer<typeof PatCreateResponseSchema>

export type PatPatchRequest = z.infer<typeof PatPatchRequestSchema>

export type Connection = z.infer<typeof ConnectionSchema>

export type ConnectionsResponse = z.infer<typeof ConnectionsResponseSchema>

export type ConnectionPatchRequest = z.infer<typeof ConnectionPatchRequestSchema>
