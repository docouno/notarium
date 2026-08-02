// Shared local helpers for the auth surface. Session cookie set/cleared here by
// hand — no cookie plugin: one credential cookie needs no dependency.
// canon: docs/auth.md#credentials
import type { FastifyReply, FastifyRequest } from 'fastify'

import { SESSION_COOKIE } from '../../../../services/auth'
import { type Action, type AuthzConfig } from '../../../../services/authz'

export const authz = (
  action: Action,
  resource: 'space' | 'note' | 'host',
): { authz: AuthzConfig } => ({
  authz: { action, resource },
})

export const PUBLIC = { config: { authz: { public: true as const } } }

/** Cookie max-age; must mirror the service's session TTL. */
export const COOKIE_MAX_AGE_S = 30 * 24 * 3600

export const setSessionCookie = (req: FastifyRequest, reply: FastifyReply, token: string) => {
  const secure =
    req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https' ? '; Secure' : ''
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure}`,
  )
}

export const clearSessionCookie = (reply: FastifyReply) => {
  reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

export const cookieToken = (req: FastifyRequest): string | undefined =>
  new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1]
