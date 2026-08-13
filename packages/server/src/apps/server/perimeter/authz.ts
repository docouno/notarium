// The authz perimeter: Fastify wiring that binds the pure policy (services/authz)
// to the HTTP boundary — a fail-closed boot-assert plus a global preHandler chokepoint.
// canon: docs/auth.md#model
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AUTH_MODE } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import type { AuthService } from '../../../services/auth'
import { type AuthzConfig, can, type Principal, SYSTEM_PRINCIPAL } from '../../../services/authz'

declare module 'fastify' {
  // Module augmentation requires an interface, hence the lint exemption.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface FastifyRequest {
    principal: Principal
    /** Stable space id the preHandler resolves from the `:space` slug; '' on
     *  non-space routes or an unknown slug (already 404'd by can()).
     *  canon: docs/core.md#identity */
    spaceId: string
  }
}

/** Same-origin guard for cookie-auth mutations (the second line after SameSite=Lax).
 *  canon: docs/auth.md#csrf-and-proxy */
const crossOrigin = (req: FastifyRequest): boolean => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return false
  }
  const origin = req.headers.origin

  if (!origin) {
    return false
  }
  const forwarded = req.headers['x-forwarded-host']
  const host =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim() || req.headers.host

  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

/** Wire the authz chokepoint into a Fastify app: a fail-closed boot-assert
 *  (every /api route must declare config.authz) plus the request-time preHandler.
 */
export const installAuthz = (
  app: FastifyInstance,
  auth: AuthService,
  resolveSpaceId: (slug: string) => string | null,
  resolveRetainedSpaceId: (slug: string) => string | null = resolveSpaceId,
): void => {
  app.decorateRequest('principal', null as unknown as Principal)
  app.decorateRequest('spaceId', '')

  app.addHook('onRoute', (route) => {
    if (!route.path.startsWith('/api/')) {
      return
    }
    if (route.method === 'HEAD' || route.method === 'OPTIONS') {
      return
    }
    const authz = (route.config as { authz?: AuthzConfig } | undefined)?.authz

    if (!authz) {
      throw new Error(
        `route ${String(route.method)} ${route.path} has no authz declaration — ` +
          `every /api route must declare config.authz (or an explicit { public: true })`,
      )
    }
  })

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) {
      return
    }
    const authz = (req.routeOptions.config as { authz?: AuthzConfig } | undefined)?.authz

    if (!authz) {
      return
    } // HEAD/OPTIONS of a declared route (onRoute skips those)

    // Assign principal BEFORE the public early-returns below: public routes (e.g. GET
    // /api/auth/session) still read req.principal to build `me`.
    const authed = await auth.authenticate(req.headers)
    req.principal = authed?.principal ?? SYSTEM_PRINCIPAL

    if (auth.mode !== AUTH_MODE.none) {
      if (!authed) {
        req.principal = ANONYMOUS
        if ('public' in authz) {
          return
        }
        const setup = await auth.setupOpen()
        return reply
          .code(HTTP_STATUS.UNAUTHORIZED)
          .send({ error: 'unauthorized', reason: setup ? 'setup_required' : 'unauthorized' })
      }
      if (authed.viaCookie && crossOrigin(req)) {
        return reply.code(HTTP_STATUS.FORBIDDEN).send({ error: 'cross-origin request rejected' })
      }
    }
    if ('public' in authz) {
      return
    }

    // 'note' routes defer can() to the shared note-resolver — their space comes
    // from the identity registry, not the URL; authentication above still applies.
    if (authz.resource === 'note' || authz.resource === 'note-replay') {
      return
    }
    // Resolve slug → stable id once; downstream handlers address the space by it.
    // Unknown slug → can() denies → 404 (anti-enumeration: "no such thing").
    let space: string | undefined

    if (authz.resource === 'space' || authz.resource === 'space-replay') {
      const slug = (req.params as { space?: string }).space
      space =
        (slug &&
          (authz.resource === 'space-replay'
            ? resolveRetainedSpaceId(slug)
            : resolveSpaceId(slug))) ||
        undefined
      req.spaceId = space ?? ''
      // Hard 404 here for an unknown/archived slug is load-bearing: it stops routes
      // that bypass spaces.store() (rename, projects CRUD) from mutating a non-served
      // space even for a principal whose grants pass can() (e.g. none-mode system principal).
      if (slug && !space) {
        return reply.code(HTTP_STATUS.NOT_FOUND).send({ error: 'not found' })
      }
    }
    if (!can(req.principal, authz.action, { space })) {
      return reply.code(HTTP_STATUS.NOT_FOUND).send({ error: 'not found' })
    }
  })
}

/** The principal for an anonymous request on PUBLIC routes (password mode):
 *  no grants → can() denies everything. */
const ANONYMOUS: Principal = {
  id: 'anonymous',
  username: null,
  admin: false,
  scope: 'read',
  grants: new Map(),
  spaces: null,
  system: false,
}
