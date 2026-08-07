// Thin /api/* handlers: parse → map in → KnowledgeStore → map out → validate
// against @notarium/contract before the response leaves the process (P9).
// Domain↔wire shaping lives in ./wire.
// canon: docs/contract.md#routing · docs/architecture.md#p9
//
// Security contracts a caller MUST know:
//   - Every route MUST declare config.authz — a route without one fails boot.
//   - /api/s/:space/… is fail-closed: no space in the path → no route to hit;
//     authz validates the :space param in the global preHandler.
//   - id-addressed routes (/api/note*, /api/previews, /api/move) get their store
//     via noteStore(), which resolves AND authz-checks: unknown id, foreign
//     space and tombstone all answer the same 404 (anti-enumeration).
import type { FastifyInstance } from 'fastify'

import { buildApiRouteCtx } from './_shared'
import { activityRoutes } from './activity'
import { authRoutes } from './auth'
import { contextSetsRoutes } from './contextSets'
import { eventsRoutes } from './events'
import { exportRoutes } from './export'
import { favoritesRoutes } from './favorites'
import { foldersRoutes } from './folders'
import { graphRoutes } from './graph'
import { hostRoutes } from './host'
import { jobsRoutes } from './jobs'
import { noteRoutes } from './note'
import { notesRoutes } from './notes'
import { projectsRoutes } from './projects'
import { searchRoutes } from './search'
import { spacesRoutes } from './spaces'
import { trashRoutes } from './trash'
import { treeRoutes } from './tree'
import type { ApiRoutesOptions } from './types'

export const apiRoutes = async (app: FastifyInstance, opts: ApiRoutesOptions) => {
  const {
    spaces,
    auth,
    contextSets,
    scopePins,
    contextOrder,
    retrievalLog,
    sessionAudit,
    roles,
    sessions,
  } = opts
  const ctx = buildApiRouteCtx(opts)

  await app.register(authRoutes, {
    spaces,
    auth,
    storeAccess: ctx.storeAccess,
    contextSets,
    scopePins,
    contextOrder,
    retrievalLog,
    sessionAudit,
    projects: opts.projects,
    roles,
    sessions,
  })

  // Plain calls, NOT app.register: keeps every family in one plugin scope
  // (shared hooks/encapsulation). Order is behaviour-neutral (distinct /api/…
  // paths under one radix router).
  await hostRoutes(app, ctx)
  await spacesRoutes(app, ctx)
  await eventsRoutes(app, ctx)
  await notesRoutes(app, ctx)
  await favoritesRoutes(app, ctx)
  await treeRoutes(app, ctx)
  await graphRoutes(app, ctx)
  await activityRoutes(app, ctx)
  await searchRoutes(app, ctx)
  await exportRoutes(app, ctx)
  await jobsRoutes(app, ctx)
  await noteRoutes(app, ctx)
  await foldersRoutes(app, ctx)
  await projectsRoutes(app, ctx)
  await contextSetsRoutes(app, ctx)
  await trashRoutes(app, ctx)
}
