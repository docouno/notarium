import type { FastifyInstance } from 'fastify'

import { AUTH_MODE, ConfigSchema, HostAboutResponseSchema } from '@notarium/contract'

import { buildInfo } from '../../../../libs/buildInfo'
import { hostInfoFrom } from '../../../../libs/hostInfo'
import { type ApiRouteCtx, authz } from '../_shared'

export const hostRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaces, about, build } = ctx
  // The bundle's inlined identity unless the composition root overrides it.
  const buildIdentity = build ?? buildInfo

  // Absent on a bare buildApp → synthesize an FTS/none default so the wire shape still answers.
  const hostInfo = about ?? hostInfoFrom({ authMode: AUTH_MODE.none, spaces: spaces.list() })
  // Engine labels come from the boot snapshot; runtime-minted spaces aren't in it → default 'notarium'.
  const engineBySlug = new Map(hostInfo.deployment.engines.map((e) => [e.slug, e.engine]))

  // Liveness probe; the ONLY public route (explicit authz opt-out).
  app.get('/api/health', { config: { authz: { public: true } } }, async () => ({ ok: true }))

  app.get('/api/config', { config: authz('config:read', 'host') }, async () =>
    // canon: docs/auth.md#model
    ConfigSchema.parse({ capabilities: spaces.capabilities }),
  )

  // Admin-only block gates runtime/embedder/deployment shape — don't leak infrastructure to non-admins.
  app.get('/api/about', { config: authz('config:read', 'host') }, async (req) =>
    HostAboutResponseSchema.parse({
      build: buildIdentity,
      search: {
        mode: hostInfo.search.vector ? 'hybrid' : 'fts',
        vector: hostInfo.search.vector,
        graphBoost: hostInfo.search.graphBoost,
      },
      admin: req.principal.admin
        ? {
            runtime: { node: process.version, platform: process.platform, arch: process.arch },
            embedder:
              hostInfo.search.vector && hostInfo.search.embedderId
                ? { id: hostInfo.search.embedderId, dimensions: hostInfo.search.embedderDims ?? 0 }
                : null,
            authMode: hostInfo.deployment.authMode,
            spaceCreate: spaces.capabilities.spaceCreate,
            metaDb: hostInfo.deployment.metaDb,
            uptimeSeconds: Math.round(process.uptime()),
            spaces: spaces
              .list()
              .map((s) => ({ slug: s.slug, engine: engineBySlug.get(s.slug) ?? 'notarium' })),
          }
        : null,
    }),
  )
}
