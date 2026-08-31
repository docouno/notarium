import type { FastifyInstance } from 'fastify'
// The auth surface: anonymous flow (/api/auth/*), the principal (/api/me*),
// admin user management (/api/users*), space membership (/api/s/:space/members*).
// canon: docs/auth.md#wire · docs/auth.md#model
//
// Registered as ONE Fastify plugin (own hook/encapsulation scope); the 4 families
// run via plain `await <family>Routes(app, deps)`, NOT nested app.register, so they
// SHARE that one scope (hooks, content-type parsers).

import type { AbilitiesService } from '../../../../services/abilities'
import type { AuthService } from '../../../../services/auth'
import type {
  AgentCallTracePersistence,
  AgentSessionAuditPersistence,
  ContextOrderPersistence,
  ContextSetsPersistence,
  RetrievalLogPersistence,
  ScopePinsPersistence,
} from '../../../../services/metaDb'
import type { SpaceManager } from '../../../../services/spaces'
import type { StoreAccess } from '../../../../services/storeAccess'
import { authFlowRoutes } from './authFlow'
import { meRoutes } from './me'
import { membersRoutes } from './members'
import { usersRoutes } from './users'

export const authRoutes = async (
  app: FastifyInstance,
  deps: {
    spaces: SpaceManager
    auth: AuthService
    storeAccess: StoreAccess
    contextSets?: ContextSetsPersistence
    scopePins?: ScopePinsPersistence
    contextOrder?: ContextOrderPersistence
    retrievalLog?: RetrievalLogPersistence
    agentCalls?: AgentCallTracePersistence
    sessionAudit?: AgentSessionAuditPersistence
    abilities?: AbilitiesService
  },
) => {
  // Family handlers just throw; AuthError → wire envelope mapping is centralized
  // in the app's root error handler (apps/server/app).

  // Registration order is behaviour-load-bearing: anon flow → me → users → members.
  await authFlowRoutes(app, deps)
  await meRoutes(app, deps)
  await usersRoutes(app, deps)
  await membersRoutes(app, deps)
}
