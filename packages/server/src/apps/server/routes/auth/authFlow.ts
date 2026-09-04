// The anonymous auth flow (/api/auth/*): every route is public. Handlers just
// throw AuthError — the wire-envelope mapping is centralized in the app root
// error handler (apps/server/app).
// canon: docs/auth.md#wire
import type { FastifyInstance } from 'fastify'

import {
  AcceptInviteRequestSchema,
  AuthSessionResponseSchema,
  InviteInfoRequestSchema,
  InviteInfoResponseSchema,
  LoginRequestSchema,
  MeSchema,
  OkResponseSchema,
  SetupRequestSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import { AuthError, type AuthService } from '../../../../services/auth'
import { ensurePersonalSpaceFor, type SpaceManager } from '../../../../services/spaces'
import { clearSessionCookie, cookieToken, PUBLIC, setSessionCookie } from './_helpers'

export const authFlowRoutes = async (
  app: FastifyInstance,
  { spaces, auth }: { spaces: SpaceManager; auth: AuthService },
) => {
  // ── the anonymous flow ───────────────────────────────────────────────────

  // Boot endpoint. canon: docs/auth.md#modes
  app.get('/api/auth/session', PUBLIC, async (req) =>
    AuthSessionResponseSchema.parse({
      mode: auth.mode,
      setup: await auth.setupOpen(),
      me: req.principal.userId ? await auth.me(req.principal.userId, req.principal) : null,
    }),
  )

  // First-run: mint the host owner (one-shot).
  app.post('/api/auth/setup', PUBLIC, async (req, reply) => {
    if (auth.mode === 'none') {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const body = SetupRequestSchema.parse(req.body ?? {})
    const { me, sessionToken } = await auth.setup(
      body,
      spaces.list().map((s) => s.id),
    )
    // Cookie first: setup is one-shot (it 404s once a user exists), so the
    // session must survive even if the personal-domain mint below hiccups.
    setSessionCookie(req, reply, sessionToken)
    // Eager personal-space provision (invariant 1); the catch degrades to the
    // lazy first-touch path.
    // canon: docs/projects.md#personal-domain-as-a-working-space-13-2026-06-20
    await ensurePersonalSpaceFor({ auth, spaces }, me).catch((err) => {
      req.log.error({ err }, 'personal-space provision (setup) failed; will retry lazily')
    })
    return MeSchema.parse(await auth.me(me.id))
  })

  app.post('/api/auth/login', PUBLIC, async (req, reply) => {
    if (auth.mode === 'none') {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const body = LoginRequestSchema.safeParse(req.body ?? {})

    // A malformed login is the same generic 401 as a wrong one — the error
    // never narrows the guess.
    if (!body.success) {
      throw new AuthError(HTTP_STATUS.UNAUTHORIZED, 'invalid credentials')
    }
    const { me, sessionToken } = await auth.login({ ...body.data, ip: req.ip })
    setSessionCookie(req, reply, sessionToken)
    return MeSchema.parse(me)
  })

  // Public on purpose: logging out with an already-dead session must still
  // clear the cookie instead of bouncing through a 401.
  app.post('/api/auth/logout', PUBLIC, async (req, reply) => {
    if (auth.mode !== 'none') {
      await auth.logout(cookieToken(req))
    }
    clearSessionCookie(reply)
    return OkResponseSchema.parse({ ok: true })
  })

  // Invite/reset links: token in the body, never a query string (and in
  // the URL fragment client-side — out of access logs at both ends).
  app.post('/api/auth/invite-info', PUBLIC, async (req) => {
    const body = InviteInfoRequestSchema.parse(req.body ?? {})
    return InviteInfoResponseSchema.parse(await auth.inviteInfo(body.token))
  })

  app.post('/api/auth/accept-invite', PUBLIC, async (req, reply) => {
    const body = AcceptInviteRequestSchema.parse(req.body ?? {})
    const { me, sessionToken } = await auth.acceptInvite(body.token, body.password)
    // Cookie first: accept-invite already burned the single-use token, so the
    // session must survive a personal-domain mint hiccup (no retry of accept).
    setSessionCookie(req, reply, sessionToken)
    // Eager personal-space provision (invariant 1); the catch degrades to the
    // lazy first-touch path.
    await ensurePersonalSpaceFor({ auth, spaces }, me).catch((err) => {
      req.log.error({ err }, 'personal-space provision (accept-invite) failed; will retry lazily')
    })
    return MeSchema.parse(await auth.me(me.id))
  })
}
