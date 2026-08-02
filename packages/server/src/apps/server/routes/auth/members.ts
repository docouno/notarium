// Space membership routes: /api/s/:space/members*.
// canon: docs/auth.md#model
import type { FastifyInstance } from 'fastify'

import { MemberPutRequestSchema, MembersResponseSchema, UsernameSchema } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import { type AuthService } from '../../../../services/auth'
import { authz } from './_helpers'

export const membersRoutes = async (app: FastifyInstance, { auth }: { auth: AuthService }) => {
  app.get('/api/s/:space/members', { config: authz('members:read', 'space') }, async (req) =>
    MembersResponseSchema.parse({
      members: await auth.membersOf(req.spaceId),
    }),
  )

  app.put(
    '/api/s/:space/members/:username',
    { config: authz('members:manage', 'space') },
    async (req, reply) => {
      const space = req.spaceId

      // Personal space must NEVER gain a second member: a second principal with
      // space:read would leak the owner's private about-user memory (backend-enforced,
      // not just UI-hidden). canon: docs/projects.md#personal-domain-as-a-working-space-13-2026-06-20
      if (await auth.isPersonalSpace(space)) {
        return reply
          .code(HTTP_STATUS.FORBIDDEN)
          .send({ error: 'a personal space cannot have additional members' })
      }
      const username = UsernameSchema.parse((req.params as { username: string }).username)
      const body = MemberPutRequestSchema.parse(req.body ?? {})
      return MembersResponseSchema.parse({
        members: await auth.putMember(space, username, body.role),
      })
    },
  )

  app.delete(
    '/api/s/:space/members/:username',
    { config: authz('members:manage', 'space') },
    async (req) => {
      const space = req.spaceId
      const username = UsernameSchema.parse((req.params as { username: string }).username)
      return MembersResponseSchema.parse({ members: await auth.removeMember(space, username) })
    },
  )
}
