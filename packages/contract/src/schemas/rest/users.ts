import { z } from 'zod'
import { SpaceRoleSchema, UsernameSchema } from './auth'

export const UserSchema = z.object({
  username: UsernameSchema,
  displayName: z.string().min(1),
  admin: z.boolean(),
  disabled: z.boolean(),
  /** False until an invite is accepted — the admin UI shows "invited, not
   *  activated" honestly. */
  hasPassword: z.boolean(),
  createdAt: z.string(),
})

export const UsersResponseSchema = z.object({ users: z.array(UserSchema) })

export const UserCreateRequestSchema = z.object({
  username: UsernameSchema,
  displayName: z.string().min(1).optional(),
  admin: z.boolean().optional(),
})

/** Creating a user (and POST /api/users/:username/invite for an existing one)
 *  answers with the one-time link the admin hands over. `path` is the SPA
 *  route with the token in the fragment — the client prefixes its origin. */
export const InviteLinkResponseSchema = z.object({
  user: UserSchema,
  token: z.string(),
  path: z.string(),
})

export const UserPatchRequestSchema = z.object({
  displayName: z.string().min(1).optional(),
  admin: z.boolean().optional(),
  /** Disabling kills the user's sessions and SSE channels immediately; their
   *  PATs stop validating. Re-enabling restores grants untouched. */
  disabled: z.boolean().optional(),
})

export const MemberSchema = z.object({
  username: UsernameSchema,
  displayName: z.string().min(1),
  role: SpaceRoleSchema,
})

/** Any member can see who else is in the space (collaboration transparency);
 *  managing rows takes the owner role (or host admin — the recovery path for
 *  config-born spaces). */
export const MembersResponseSchema = z.object({ members: z.array(MemberSchema) })

/** PUT /api/s/<slug>/members/:username — add or re-role in one idempotent
 *  shape. Removing the last owner is rejected (a space must stay manageable). */
export const MemberPutRequestSchema = z.object({ role: SpaceRoleSchema })

export type User = z.infer<typeof UserSchema>

export type UsersResponse = z.infer<typeof UsersResponseSchema>

export type UserCreateRequest = z.infer<typeof UserCreateRequestSchema>

export type InviteLink = z.infer<typeof InviteLinkResponseSchema>

export type UserPatchRequest = z.infer<typeof UserPatchRequestSchema>

export type Member = z.infer<typeof MemberSchema>

export type MembersResponse = z.infer<typeof MembersResponseSchema>

export type MemberPutRequest = z.infer<typeof MemberPutRequestSchema>
