import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
// OAuth facade HTTP surface. Mounted OUTSIDE /api and BEFORE the SPA fallback (like
// /mcp), so these discovery + flow endpoints must authenticate themselves — installAuthz
// guards only /api.
// canon: docs/mcp-oauth.md#surfaces · docs/mcp-oauth.md#token-identity

import { HTTP_STATUS } from '@notarium/contract/http'

import type { AuthService } from '../../../../services/auth'
import { AuthError, SESSION_COOKIE } from '../../../../services/auth'
import type { OAuthClientRecord, OAuthPersistence } from '../../../../services/metaDb'
import { fetchClientMetadataDocument } from '../../../../services/oauth/cimd'
import {
  type AuthorizeParams,
  createOAuthService,
  OAuthError,
  type OAuthService,
} from '../../../../services/oauth/oauthService'
import { readConsentSpaces, renderConsentPage, renderErrorPage } from './consent'

export type OAuthRoutesOptions = {
  store: OAuthPersistence
  auth: AuthService
  /** Canonical issuer origin; wins when set — for a stable issuer behind a proxy. */
  publicBaseUrl?: string
  now?: () => Date
}

// A registration document is tiny in every supported connector. Keep a generous
// compatibility envelope while cutting the host-global 4 MiB amplification by 64×.
const DCR_BODY_LIMIT = 64 * 1024

/** WWW-Authenticate value the /mcp 401 returns, per RFC 9728. */
export const wwwAuthenticateChallenge = (base: string): string =>
  `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="read write"`

/** Canonical external origin of THIS request (the host the browser addressed).
 *  Keep in sync with the host derivation in authz.ts. canon: docs/auth.md#csrf-and-proxy */
export const baseUrlOf = (req: FastifyRequest, configured?: string): string => {
  if (configured) {
    return configured.replace(/\/+$/, '')
  }
  const proto =
    pickHeader(req.headers['x-forwarded-proto']) ||
    (req.headers['x-forwarded-ssl'] === 'on' ? 'https' : undefined) ||
    req.protocol ||
    'https'
  const host = pickHeader(req.headers['x-forwarded-host']) || req.headers.host || 'localhost'
  return `${proto.split(',')[0].trim()}://${host}`
}

const pickHeader = (v: string | string[] | undefined): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v
  return s ? s.split(',')[0].trim() : undefined
}

/** Reject cross-site POSTs to the consent form (belt over SameSite=Lax): these routes
 *  live outside /api, so the installAuthz crossOrigin hook doesn't cover them. */
const crossSite = (req: FastifyRequest): boolean => {
  const origin = req.headers.origin

  if (!origin) {
    return false
  }
  const host = pickHeader(req.headers['x-forwarded-host']) || req.headers.host

  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

/** Sets the session cookie after an inline /authorize login, so the user stays signed in. */
const setSessionCookie = (reply: FastifyReply, req: FastifyRequest, token: string): void => {
  const secure = baseUrlOf(req).startsWith('https://')
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secure ? '; Secure' : ''}`,
  )
}

export const registerOAuthRoutes = async (
  app: FastifyInstance,
  opts: OAuthRoutesOptions,
): Promise<void> => {
  // Encapsulate in a plugin so the urlencoded content-type parser the token/consent
  // POSTs need stays LOCAL to these routes (the rest of the app is JSON-only).
  await app.register(async (scope) => {
    // Body-limit errors happen before a route handler runs. Keep this mapping
    // encapsulated with OAuth so this limit cannot change unrelated API errors.
    scope.setErrorHandler((err, req, reply) => {
      if (
        (err as Error & { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE' &&
        req.url.split('?', 1)[0] === '/oauth/register'
      ) {
        return reply.code(HTTP_STATUS.PAYLOAD_TOO_LARGE).send({
          error: 'invalid_client_metadata',
          error_description: 'registration request body too large',
        })
      }
      throw err
    })
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)))
        } catch (err) {
          done(err as Error)
        }
      },
    )

    const oauth: OAuthService = createOAuthService({
      store: opts.store,
      now: opts.now,
      fetchClientMetadata: fetchClientMetadataDocument,
    })

    const discoveryHeaders = (reply: FastifyReply) =>
      reply.header('cache-control', 'no-store').header('access-control-allow-origin', '*')

    // ── discovery ────────────────────────────────────────────────────────────
    scope.get('/.well-known/oauth-protected-resource', async (req, reply) => {
      const base = baseUrlOf(req, opts.publicBaseUrl)
      return discoveryHeaders(reply).send(oauth.protectedResourceMetadata(base))
    })
    // Some clients append the resource path; serve the same doc for both shapes.
    scope.get('/.well-known/oauth-protected-resource/mcp', async (req, reply) => {
      const base = baseUrlOf(req, opts.publicBaseUrl)
      return discoveryHeaders(reply).send(oauth.protectedResourceMetadata(base))
    })
    scope.get('/.well-known/oauth-authorization-server', async (req, reply) => {
      const base = baseUrlOf(req, opts.publicBaseUrl)
      return discoveryHeaders(reply).send(oauth.authorizationServerMetadata(base))
    })

    // ── DCR (RFC 7591) fallback ────────────────────────────────────────────────
    scope.post('/oauth/register', { bodyLimit: DCR_BODY_LIMIT }, async (req, reply) => {
      try {
        const body = (req.body ?? {}) as {
          redirect_uris?: unknown
          client_name?: unknown
        }
        const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []

        if (redirectUris.some((uri) => typeof uri !== 'string')) {
          throw new OAuthError('invalid_client_metadata', 'redirect_uris must contain URLs')
        }
        const client = await oauth.registerClient({
          redirectUris: redirectUris as string[],
          clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
          ip: req.ip,
        })
        return reply.code(HTTP_STATUS.CREATED).send({
          client_id: client.clientId,
          redirect_uris: client.redirectUris,
          client_name: client.clientName ?? undefined,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        })
      } catch (err) {
        return oauthErr(reply, err)
      }
    })

    // ── authorize ──────────────────────────────────────────────────────────────
    const parseAuthorize = (q: Record<string, string | undefined>): AuthorizeParams => {
      if (q.response_type !== 'code') {
        throw new OAuthError('unsupported_response_type', 'only response_type=code is supported')
      }
      if (!q.client_id) {
        throw new OAuthError('invalid_request', 'client_id is required')
      }
      if (!q.redirect_uri) {
        throw new OAuthError('invalid_request', 'redirect_uri is required')
      }
      if (!q.code_challenge) {
        throw new OAuthError('invalid_request', 'PKCE code_challenge is required')
      }
      const method = q.code_challenge_method ?? 'plain'

      if (method !== 'S256') {
        throw new OAuthError('invalid_request', 'only code_challenge_method=S256 is supported')
      }

      return {
        clientId: q.client_id,
        redirectUri: q.redirect_uri,
        scope: q.scope ?? 'read write offline_access',
        state: q.state,
        codeChallenge: q.code_challenge,
        codeChallengeMethod: method,
      }
    }

    // Resolve client + validate redirect BEFORE trusting redirect_uri for any
    // error redirect (an unvalidated redirect_uri must never receive a redirect).
    const validateClient = async (params: AuthorizeParams, ip: string) => {
      const client = await oauth.resolveClient(params.clientId, ip)
      oauth.assertRedirectAllowed(client, params.redirectUri)
      return client
    }

    // Signed-in user's space slugs for the consent picker; null = unknown user
    // (awaiting inline login) → consent renders the login form without a picker.
    const userSpaceSlugs = async (username: string | null): Promise<string[] | null> =>
      username ? (await opts.auth.me(username)).spaces.map((s) => s.slug) : null

    scope.get('/oauth/authorize', async (req, reply) => {
      let params: AuthorizeParams
      let client: OAuthClientRecord

      try {
        params = parseAuthorize(req.query as Record<string, string | undefined>)
        client = await validateClient(params, req.ip)
      } catch (err) {
        const msg = err instanceof OAuthError ? err.message : 'invalid authorization request'
        const status = err instanceof OAuthError ? err.status : HTTP_STATUS.BAD_REQUEST
        return reply.code(status).type('text/html').send(renderErrorPage(msg))
      }
      const authed = await opts.auth.authenticate(req.headers)
      const username = authed?.principal.username ?? null
      return reply.type('text/html').send(
        renderConsentPage({
          params,
          clientName: client.clientName,
          username,
          spaces: await userSpaceSlugs(username),
          error: null,
        }),
      )
    })

    scope.post('/oauth/authorize', async (req, reply) => {
      if (crossSite(req)) {
        return reply
          .code(HTTP_STATUS.FORBIDDEN)
          .type('text/html')
          .send(renderErrorPage('cross-origin request rejected'))
      }
      const body = (req.body ?? {}) as Record<string, string | undefined>
      let params: AuthorizeParams
      let client: OAuthClientRecord

      try {
        params = parseAuthorize(body)
        client = await validateClient(params, req.ip)
      } catch (err) {
        const msg = err instanceof OAuthError ? err.message : 'invalid authorization request'
        const status = err instanceof OAuthError ? err.status : HTTP_STATUS.BAD_REQUEST
        return reply.code(status).type('text/html').send(renderErrorPage(msg))
      }

      if (body.decision === 'deny') {
        return reply.redirect(
          redirectBack(params.redirectUri, { error: 'access_denied', state: params.state }),
        )
      }

      // A session BEFORE this POST distinguishes approve-with-picker (issue now) from
      // inline login (no picker seen yet → re-render consent WITH the picker, issue only
      // on the next approve).
      const preAuthed = (await opts.auth.authenticate(req.headers))?.principal.username ?? null

      if (!preAuthed) {
        const u = body.username?.trim()
        const p = body.password

        if (!u || !p) {
          return reply.type('text/html').send(
            renderConsentPage({
              params,
              clientName: client.clientName,
              username: null,
              spaces: null,
              error: 'Enter your username and password.',
            }),
          )
        }
        try {
          const { me, sessionToken } = await opts.auth.login({
            username: u,
            password: p,
            ip: req.ip,
          })
          setSessionCookie(reply, req, sessionToken)
          return reply.type('text/html').send(
            renderConsentPage({
              params,
              clientName: client.clientName,
              username: me.username,
              spaces: await userSpaceSlugs(me.username),
              error: null,
            }),
          )
        } catch (err) {
          if (err instanceof AuthError && err.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
            return reply
              .code(err.status)
              .type('text/html')
              .send(
                renderConsentPage({
                  params,
                  clientName: client.clientName,
                  username: null,
                  spaces: null,
                  error: err.message,
                }),
              )
          }

          return reply.type('text/html').send(
            renderConsentPage({
              params,
              clientName: client.clientName,
              username: null,
              spaces: null,
              error: 'Invalid username or password.',
            }),
          )
        }
      }

      const available = (await userSpaceSlugs(preAuthed)) ?? []
      const selection = readConsentSpaces(body, available)

      if (selection.error) {
        return reply.type('text/html').send(
          renderConsentPage({
            params,
            clientName: client.clientName,
            username: preAuthed,
            spaces: available,
            error: selection.error,
          }),
        )
      }
      // Persist selection as stable ids (not slugs) on the code; the token mint copies them on.
      const spaceIds =
        selection.spaces === null ? null : await opts.auth.spacesToIds(selection.spaces)

      try {
        const code = await oauth.issueCode(params, preAuthed, spaceIds)
        return reply.redirect(redirectBack(params.redirectUri, { code, state: params.state }))
      } catch (err) {
        if (err instanceof OAuthError) {
          // The pending lease can expire after validateClient but before the
          // atomic activation. Do not redirect to a client whose trust row vanished.
          return reply.code(err.status).type('text/html').send(renderErrorPage(err.message))
        }
        throw err
      }
    })

    // ── token ────────────────────────────────────────────────────────────────
    scope.post('/oauth/token', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, string | undefined>

      try {
        if (body.grant_type === 'authorization_code') {
          if (!body.code || !body.redirect_uri || !body.client_id || !body.code_verifier) {
            throw new OAuthError(
              'invalid_request',
              'code, redirect_uri, client_id and code_verifier are required',
            )
          }
          const issued = await oauth.exchangeCode({
            code: body.code,
            redirectUri: body.redirect_uri,
            clientId: body.client_id,
            codeVerifier: body.code_verifier,
          })
          return tokenResponse(reply, issued)
        }
        if (body.grant_type === 'refresh_token') {
          if (!body.refresh_token) {
            throw new OAuthError('invalid_request', 'refresh_token is required')
          }
          const issued = await oauth.refresh({
            refreshToken: body.refresh_token,
            clientId: body.client_id,
          })
          return tokenResponse(reply, issued)
        }
        throw new OAuthError(
          'unsupported_grant_type',
          `unsupported grant_type: ${body.grant_type ?? '(none)'}`,
        )
      } catch (err) {
        return oauthErr(reply, err)
      }
    })

    // ── revoke (RFC 7009) ──────────────────────────────────────────────────────
    scope.post('/oauth/revoke', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, string | undefined>

      if (body.token) {
        // Revoke = disconnect: a refresh-token revoke cascades to ALL its access
        // principals' live SSE. canon: docs/auth.md#sse-revoke-disconnect
        for (const principalId of await oauth.revoke(body.token)) {
          opts.auth.disconnectPrincipal(principalId)
        }
      }

      // RFC 7009: the endpoint responds 200 regardless (an unknown token is a no-op).
      return reply.code(HTTP_STATUS.OK).header('cache-control', 'no-store').send({})
    })
  })
}

// ── helpers ────────────────────────────────────────────────────────────────

const redirectBack = (redirectUri: string, params: Record<string, string | undefined>): string => {
  const u = new URL(redirectUri)

  for (const [k, v] of Object.entries(params)) {
    if (v != null) {
      u.searchParams.set(k, v)
    }
  }

  return u.toString()
}

const tokenResponse = (
  reply: FastifyReply,
  issued: {
    accessToken: string
    refreshToken?: string
    grantedScopes: string
    expiresInSec: number
  },
) =>
  reply.header('cache-control', 'no-store').send({
    access_token: issued.accessToken,
    token_type: 'Bearer',
    expires_in: issued.expiresInSec,
    // Echo the GRANTED scopes (RFC 6749 §3.3) — must match the client's request or
    // ChatGPT reports a partial grant and loops re-authorization (live finding).
    scope: issued.grantedScopes,
    ...(issued.refreshToken ? { refresh_token: issued.refreshToken } : {}),
  })

const oauthErr = (reply: FastifyReply, err: unknown) => {
  if (err instanceof OAuthError) {
    return reply
      .code(err.status)
      .header('cache-control', 'no-store')
      .send({ error: err.code, error_description: err.message })
  }
  console.error('[oauth] ->', (err as Error)?.message)
  return reply
    .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
    .send({ error: 'server_error', error_description: 'internal error' })
}
