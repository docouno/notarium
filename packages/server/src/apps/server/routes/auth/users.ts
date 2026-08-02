// User management (admin): /api/users* — gated by users:manage. Split out
// of the former authApi.ts VERBATIM; AuthError → wire envelope mapping
// lives in the app's root error handler — handlers here just throw.
import type { FastifyInstance } from 'fastify'

import {
  InviteLinkResponseSchema,
  UserCreateRequestSchema,
  UsernameSchema,
  UserPatchRequestSchema,
  UserSchema,
  UsersResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import { type AuthService } from '../../../../services/auth'
import { authz } from './_helpers'

export const usersRoutes = async (app: FastifyInstance, { auth }: { auth: AuthService }) => {
  // ── user management (admin) ──────────────────────────────────────────────

  app.get('/api/users', { config: authz('users:manage', 'host') }, async () =>
    UsersResponseSchema.parse({ users: await auth.listUsers() }),
  )

  app.post('/api/users', { config: authz('users:manage', 'host') }, async (req, reply) => {
    const body = UserCreateRequestSchema.parse(req.body ?? {})
    return reply
      .code(HTTP_STATUS.CREATED)
      .send(InviteLinkResponseSchema.parse(await auth.createUser(body)))
  })

  app.post('/api/users/:username/invite', { config: authz('users:manage', 'host') }, async (req) =>
    InviteLinkResponseSchema.parse(
      await auth.inviteUser(UsernameSchema.parse((req.params as { username: string }).username)),
    ),
  )

  app.patch('/api/users/:username', { config: authz('users:manage', 'host') }, async (req) => {
    const body = UserPatchRequestSchema.parse(req.body ?? {})
    const username = UsernameSchema.parse((req.params as { username: string }).username)
    // patchUser owns the lockout guards (self-disable, last admin).
    return UserSchema.parse(await auth.patchUser(req.principal.username ?? '', username, body))
  })
}
