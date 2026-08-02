import { HTTP_STATUS } from '@notarium/contract/http'
// OAuth 2.1 authorization server facade — mints MCP connector tokens over the
// existing principal (Notarium is its own AS; a self-host owns its users).
// Spec baseline 2025-11-25: RFC 9728 + RFC 8414 metadata, PKCE S256. Client
// registration is CIMD-first with a DCR (RFC 7591) fallback.
// canon: docs/mcp-oauth.md#why · docs/mcp-oauth.md#mode-fork

import {
  mintOAuthAccessToken,
  mintOAuthCode,
  mintOAuthRefreshToken,
  parseOAuthAccessToken,
  parseOAuthRefreshToken,
  pkceS256,
  sha256,
  timingSafeEqualHex,
} from '../../libs/tokens'
import type { OAuthClientRecord, OAuthCodeRecord, OAuthPersistence, OAuthScope } from '../metaDb'

const ACCESS_TTL_MS = 60 * 60 * 1000 // 1h
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000 // 60d
const CODE_TTL_MS = 60 * 1000 // 60s — exchanged immediately
/** CIMD metadata cache TTL — bounds staleness of a client's rotated redirect_uris
 *  against re-fetching its metadata URL on every request. */
const CIMD_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const PENDING_CLIENT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_PENDING_CLIENTS = 100
const REGISTRATION_WINDOW_MS = 15 * 60 * 1000
const REGISTRATION_MAX_PER_IP = 10
const REGISTRATION_MAX_IN_FLIGHT = 2
const REGISTRATION_MAX_RATE_KEYS = 10_000
const ACTIVE_CIMD_MAX_IN_FLIGHT = 2
const ACTIVE_CIMD_MAX_WAITERS = 16
const MAX_CLIENT_REDIRECT_URIS = 32
const MAX_REDIRECT_URI_CHARS = 4096
const DCR_REDIRECT_LIMITS = {
  maxUris: MAX_CLIENT_REDIRECT_URIS,
  maxUriChars: MAX_REDIRECT_URI_CHARS,
} as const

/** An OAuth error mapped onto the spec's error JSON (RFC 6749 §5.2). */
export class OAuthError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status: number = HTTP_STATUS.BAD_REQUEST) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Pending-authorization params carried from GET /authorize (validated) to
 *  POST /authorize (consumed) via the consent form's hidden fields. */
export type AuthorizeParams = {
  clientId: string
  redirectUri: string
  scope: string
  state?: string
  codeChallenge: string
  codeChallengeMethod: string
}

export type IssuedTokens = {
  accessToken: string
  refreshToken?: string
  scope: OAuthScope
  /** Scope string ECHOED to the client (RFC 6749 §3.3) — must be what the client
   *  requested and we granted, NOT the collapsed internal `scope`, or ChatGPT reads
   *  a partial grant and loops re-authorization forever. */
  grantedScopes: string
  expiresInSec: number
}

export type CreateOAuthServiceOptions = {
  store: OAuthPersistence
  now?: () => Date
  /** CIMD fetcher, injected. Production MUST wire an SSRF-guarded https fetch
   *  (routes/index); tests pass a stub. */
  fetchClientMetadata?: (url: string) => Promise<unknown>
}

export type OAuthService = ReturnType<typeof createOAuthService>

/** Supported scope ceiling. A connector token never reaches management actions
 *  (that ceiling sits above 'write' — same belt as a PAT).
 *  canon: docs/mcp-oauth.md#security */
const SUPPORTED_SCOPES = ['read', 'write', 'offline_access'] as const

/** Resolve a requested scope string to the internal ceiling, an offline flag, and
 *  the granted-scope echo string. */
const resolveScope = (
  requested: string | undefined,
): {
  scope: OAuthScope
  offline: boolean
  granted: string
} => {
  const parts = (requested ?? '').split(/\s+/).filter(Boolean)
  const scope: OAuthScope = parts.includes('write') || parts.length === 0 ? 'write' : 'read'
  // Default to a refresh (Claude/ChatGPT expect long-lived connectors); honour explicit offline_access.
  const offline = parts.length === 0 || parts.includes('offline_access')
  const supported = SUPPORTED_SCOPES as readonly string[]
  const seen = new Set<string>()
  const granted: string[] = []

  for (const p of parts) {
    if (supported.includes(p) && !seen.has(p)) {
      seen.add(p)
      granted.push(p)
    }
  }
  if (!granted.length) {
    granted.push(
      ...(scope === 'write' ? ['read', 'write'] : ['read']),
      ...(offline ? ['offline_access'] : []),
    )
  }

  return { scope, offline, granted: granted.join(' ') }
}

/** Rebuild the granted echo on refresh — the original request string isn't stored,
 *  only the ceiling; a refresh implies offline_access. */
const grantedFromScope = (scope: OAuthScope): string =>
  `${scope === 'write' ? 'read write' : 'read'} offline_access`

export function createOAuthService({ store, now, fetchClientMetadata }: CreateOAuthServiceOptions) {
  const clock = now ?? (() => new Date())
  const nowMs = () => clock().getTime()
  const iso = (ms: number) => new Date(ms).toISOString()
  const nowIso = () => clock().toISOString()
  const pendingBeforeIso = () => iso(nowMs() - PENDING_CLIENT_TTL_MS)
  const registrationByIp = new Map<string, { count: number; resetAt: number }>()
  const cimdInFlight = new Map<string, Promise<OAuthClientRecord>>()
  const activeCimdWaiters: Array<() => void> = []
  let registrationsInFlight = 0
  let activeCimdInFlight = 0
  let registrationSweepAt = 0

  /** Best-effort, fire-and-forget prune of expired rows. */
  const prune = () => {
    void store.pruneExpired(nowIso(), pendingBeforeIso()).catch(() => {})
  }

  /** One pre-auth admission belt for work that can grow the registry. DCR and
   *  new/pending CIMD enter both its IP rate budget and global concurrency cap;
   *  activated CIMD cannot grow it and uses the separate bounded refresh lane. */
  const withRegistrationAdmission = async <T>(ip: string, work: () => Promise<T>): Promise<T> => {
    const t = nowMs()

    if (t >= registrationSweepAt) {
      for (const [key, bucket] of registrationByIp) {
        if (bucket.resetAt <= t) {
          registrationByIp.delete(key)
        }
      }
      registrationSweepAt = t + REGISTRATION_WINDOW_MS
    }
    const bucket = registrationByIp.get(ip)

    if (bucket?.resetAt && bucket.resetAt > t && bucket.count >= REGISTRATION_MAX_PER_IP) {
      throw registrationBusy('too many client registrations, try later')
    }
    if (!bucket && registrationByIp.size >= REGISTRATION_MAX_RATE_KEYS) {
      throw registrationBusy('client registration is temporarily busy')
    }
    if (!bucket || bucket.resetAt <= t) {
      registrationByIp.set(ip, { count: 1, resetAt: t + REGISTRATION_WINDOW_MS })
    } else {
      bucket.count++
    }
    if (registrationsInFlight >= REGISTRATION_MAX_IN_FLIGHT) {
      throw registrationBusy('too many client registrations in progress, try later')
    }
    registrationsInFlight++

    try {
      return await work()
    } finally {
      registrationsInFlight--
    }
  }

  /** Activated CIMD refreshes use a separate bounded queue: ordinary overlap
   *  waits instead of gaining a new registration-policy error, while an attack
   *  cannot build an unbounded backlog. Never fall back to stale redirect_uris. */
  const refreshActivatedCimd = async (
    work: () => Promise<OAuthClientRecord>,
  ): Promise<OAuthClientRecord> => {
    if (activeCimdInFlight >= ACTIVE_CIMD_MAX_IN_FLIGHT) {
      if (activeCimdWaiters.length >= ACTIVE_CIMD_MAX_WAITERS) {
        throw new OAuthError(
          'temporarily_unavailable',
          'client metadata refresh is temporarily busy',
          HTTP_STATUS.SERVICE_UNAVAILABLE,
        )
      }
      await new Promise<void>((resolve) => activeCimdWaiters.push(resolve))
    } else {
      activeCimdInFlight++
    }

    try {
      return await work()
    } finally {
      const next = activeCimdWaiters.shift()

      if (next) {
        next()
      } else {
        activeCimdInFlight--
      }
    }
  }

  // ── discovery documents ────────────────────────────────────────────────────

  const protectedResourceMetadata = (base: string) => ({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: `${base}/`,
  })

  const authorizationServerMetadata = (base: string) => ({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    // Advertised for clients that implement the newer metadata-document flow;
    // DCR remains advertised alongside it for deployed connector compatibility.
    client_id_metadata_document_supported: true,
  })

  // ── client registration / resolution ───────────────────────────────────────

  /** DCR (RFC 7591): mint and store a client from its redirect_uris. */
  const registerClient = async (input: {
    redirectUris: string[]
    clientName?: string
    ip: string
  }): Promise<OAuthClientRecord> => {
    return withRegistrationAdmission(input.ip, async () => {
      assertClientRedirects(input.redirectUris, 'invalid_client_metadata', DCR_REDIRECT_LIMITS)
      const clientId = `ntcli_${mintOAuthCode().slice('ntac_'.length)}`
      const createdAt = nowIso()
      const rec: OAuthClientRecord = {
        clientId,
        kind: 'dcr',
        redirectUris: input.redirectUris,
        clientName: input.clientName?.slice(0, 200) ?? null,
        createdAt,
        lastSeen: createdAt,
        activatedAt: null,
      }
      const accepted = await store.upsertPendingClient(rec, MAX_PENDING_CLIENTS, pendingBeforeIso())

      if (!accepted) {
        throw registrationBusy('client registration capacity reached, try later')
      }

      return rec
    })
  }

  /** Resolve a presented client_id: an https URL → CIMD (fetch/validate/cache),
   *  else a DCR-registered id. canon: docs/mcp-oauth.md#client-registration-cimd-first-dcr */
  const resolveClient = async (clientId: string, ip = 'unknown'): Promise<OAuthClientRecord> => {
    if (/^https:\/\//i.test(clientId)) {
      const cached = await store.getClient(clientId)
      const expiredPending =
        cached != null && cached.activatedAt == null && cached.createdAt < pendingBeforeIso()

      if (cached && !expiredPending && nowMs() - Date.parse(cached.lastSeen) < CIMD_CACHE_TTL_MS) {
        return cached
      }
      if (!fetchClientMetadata) {
        if (cached && !expiredPending) {
          return cached
        } // no fetcher — a non-expired stale cache beats nothing
        throw new OAuthError(
          'invalid_client',
          'client metadata documents are not supported here',
          HTTP_STATUS.BAD_REQUEST,
        )
      }
      const inFlight = cimdInFlight.get(clientId)

      if (inFlight) {
        return inFlight
      }
      const fetchAndPersist = async (): Promise<OAuthClientRecord> => {
        const doc = (await fetchClientMetadata(clientId).catch(() => {
          throw new OAuthError(
            'invalid_client',
            'could not fetch client metadata document',
            HTTP_STATUS.BAD_REQUEST,
          )
        })) as { client_id?: string; redirect_uris?: unknown; client_name?: unknown }

        // The doc MUST self-reference (client_id == the URL it was fetched from) —
        // else any URL could impersonate any client.
        if (doc.client_id && doc.client_id !== clientId) {
          throw new OAuthError(
            'invalid_client',
            'client metadata client_id mismatch',
            HTTP_STATUS.BAD_REQUEST,
          )
        }
        const redirectUris = Array.isArray(doc.redirect_uris)
          ? doc.redirect_uris.filter((u): u is string => typeof u === 'string')
          : []

        // CIMD retains its previous validation envelope for activated-client
        // compatibility; its fetcher already caps the whole document at 64 KiB.
        assertClientRedirects(redirectUris, 'invalid_client')
        const rec: OAuthClientRecord = {
          clientId,
          kind: 'cimd',
          redirectUris,
          clientName: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 200) : null,
          createdAt: nowIso(),
          lastSeen: nowIso(),
          activatedAt: cached?.activatedAt ?? null,
        }
        const accepted = await store.upsertPendingClient(
          rec,
          MAX_PENDING_CLIENTS,
          pendingBeforeIso(),
        )

        if (!accepted) {
          throw registrationBusy('client registration capacity reached, try later')
        }

        return rec
      }
      // An activated client's periodic refresh cannot grow the registry and
      // keeps its normal released behavior. Its separate bounded wait lane,
      // per-client single-flight and timeout bound expensive work fail-closed.
      const operation =
        cached?.activatedAt != null
          ? refreshActivatedCimd(fetchAndPersist)
          : withRegistrationAdmission(ip, fetchAndPersist)
      cimdInFlight.set(clientId, operation)

      try {
        return await operation
      } finally {
        if (cimdInFlight.get(clientId) === operation) {
          cimdInFlight.delete(clientId)
        }
      }
    }
    const rec = await store.getClient(clientId)

    if (!rec || (rec.activatedAt == null && rec.createdAt < pendingBeforeIso())) {
      throw new OAuthError('invalid_client', 'unknown client', HTTP_STATUS.BAD_REQUEST)
    }

    return rec
  }

  // ── authorization code issue / exchange ─────────────────────────────────────

  /** Mint an authorization code for an approved consent (caller has already
   *  authenticated the user and validated client + redirect_uri). The code is the
   *  only carrier of the consent narrowing (`spaces`, null = all grants) from
   *  approve to the /token exchange. Returns the plaintext code for the redirect. */
  const issueCode = async (
    params: AuthorizeParams,
    username: string,
    spaces: string[] | null,
  ): Promise<string> => {
    if (!(await store.activateClient(params.clientId, nowIso(), pendingBeforeIso()))) {
      throw new OAuthError('invalid_client', 'unknown or expired client')
    }
    const code = mintOAuthCode()
    const rec: OAuthCodeRecord = {
      codeHash: sha256(code),
      clientId: params.clientId,
      username,
      redirectUri: params.redirectUri,
      scope: params.scope,
      spaces,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      expiresAt: iso(nowMs() + CODE_TTL_MS),
      usedAt: null,
      createdAt: nowIso(),
    }
    await store.insertCode(rec)
    prune()
    return code
  }

  /** Mint and persist an access (+ optional refresh) token. `spaces` narrowing is
   *  written to BOTH rows so it survives rotation — the next family is minted from
   *  the refresh row. */
  const mintTokens = async (
    username: string,
    clientId: string,
    scope: OAuthScope,
    offline: boolean,
    grantedScopes: string,
    spaces: string[] | null,
  ): Promise<IssuedTokens> => {
    const access = mintOAuthAccessToken()
    let refreshId: string | null = null
    let refreshToken: string | undefined

    if (offline) {
      const refresh = mintOAuthRefreshToken()
      refreshId = refresh.id
      refreshToken = refresh.token
      await store.insertRefresh({
        id: refresh.id,
        tokenHash: sha256(refresh.secret),
        username,
        clientId,
        scope,
        spaces,
        expiresAt: iso(nowMs() + REFRESH_TTL_MS),
        rotatedTo: null,
        revokedAt: null,
        createdAt: nowIso(),
      })
    }
    await store.insertAccess({
      id: access.id,
      tokenHash: sha256(access.secret),
      username,
      clientId,
      scope,
      spaces,
      expiresAt: iso(nowMs() + ACCESS_TTL_MS),
      refreshId,
      revokedAt: null,
      createdAt: nowIso(),
      lastUsedAt: null,
    })
    return {
      accessToken: access.token,
      refreshToken,
      scope,
      grantedScopes,
      expiresInSec: Math.floor(ACCESS_TTL_MS / 1000),
    }
  }

  /** authorization_code grant: verify the code + PKCE and mint tokens. */
  const exchangeCode = async (input: {
    code: string
    redirectUri: string
    clientId: string
    codeVerifier: string
  }): Promise<IssuedTokens> => {
    const rec = await store.getCode(sha256(input.code))

    if (!rec || rec.expiresAt <= nowIso()) {
      throw new OAuthError('invalid_grant', 'authorization code is invalid or expired')
    }
    // Validate bindings BEFORE consuming the code: a malformed exchange must NOT
    // burn the code, so an honest retry still works. Safe to defer — PKCE guards an
    // unconsumed code (no verifier → no token) and the 60s TTL bounds it.
    if (rec.clientId !== input.clientId) {
      throw new OAuthError('invalid_grant', 'client mismatch')
    }
    if (rec.redirectUri !== input.redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri mismatch')
    }
    // PKCE S256 (RFC 7636): the only method we accept.
    if (rec.codeChallengeMethod !== 'S256') {
      throw new OAuthError('invalid_grant', 'unsupported code_challenge_method')
    }
    // timingSafeEqualHex length-guards before the constant-time compare; both
    // sides are fixed-length base64url SHA-256 digests, so this never leaks.
    if (
      !input.codeVerifier ||
      !timingSafeEqualHex(pkceS256(input.codeVerifier), rec.codeChallenge)
    ) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed')
    }
    // Single-use: the atomic claim is the guard against a replayed code AND against
    // two concurrent valid exchanges (only one wins the claim).
    if (!(await store.useCode(rec.codeHash, nowIso()))) {
      throw new OAuthError('invalid_grant', 'authorization code already used')
    }
    const { scope, offline, granted } = resolveScope(rec.scope)
    return mintTokens(rec.username, rec.clientId, scope, offline, granted, rec.spaces)
  }

  /** refresh_token grant: verify + rotate. */
  const refresh = async (input: {
    refreshToken: string
    clientId?: string
  }): Promise<IssuedTokens> => {
    const parsed = parseOAuthRefreshToken(input.refreshToken)

    if (!parsed) {
      throw new OAuthError('invalid_grant', 'malformed refresh token')
    }
    const rec = await store.getRefresh(parsed.id)

    if (
      !rec ||
      rec.revokedAt ||
      rec.rotatedTo ||
      rec.expiresAt <= nowIso() ||
      !timingSafeEqualHex(sha256(parsed.secret), rec.tokenHash)
    ) {
      throw new OAuthError('invalid_grant', 'refresh token is invalid, expired, or already used')
    }
    if (input.clientId && rec.clientId !== input.clientId) {
      throw new OAuthError('invalid_grant', 'client mismatch')
    }
    // Atomically CLAIM rotation BEFORE minting — a read-check-write would let two
    // concurrent refreshes each mint a token family (double-spend). The claim sets
    // rotated_to only while null, so exactly one wins; the loser gets invalid_grant.
    if (!(await store.claimRefreshRotation(rec.id, nowIso()))) {
      throw new OAuthError('invalid_grant', 'refresh token is invalid, expired, or already used')
    }

    // Inherit the narrowing from THIS refresh row — a rotation must not widen
    // the connector back to all spaces (the same rule as scope).
    return mintTokens(
      rec.username,
      rec.clientId,
      rec.scope,
      true,
      grantedFromScope(rec.scope),
      rec.spaces,
    )
  }

  // ── revocation (RFC 7009) ──────────────────────────────────────────────────

  /** Revoke a token and EVERY sibling it implies; returns principal ids to
   *  disconnect over SSE. A refresh revokes all access tokens minted under it
   *  (RFC 7009: else a "disconnect" leaves a ≤1h-live access token); an unknown
   *  token still returns 200 (RFC 7009). canon: docs/auth.md#sse-revoke-disconnect */
  const revoke = async (token: string): Promise<string[]> => {
    const t = nowIso()
    const asAccess = parseOAuthAccessToken(token)

    if (asAccess) {
      const rec = await store.getAccess(asAccess.id)

      if (rec && timingSafeEqualHex(sha256(asAccess.secret), rec.tokenHash)) {
        if (!rec.revokedAt) {
          await store.updateAccess(rec.id, { revokedAt: t })
        }
        if (rec.refreshId) {
          await store.updateRefresh(rec.refreshId, { revokedAt: t }).catch(() => {})
        }

        return [`oauth:${rec.username}:${rec.id}`]
      }

      return []
    }
    const asRefresh = parseOAuthRefreshToken(token)

    if (asRefresh) {
      const rec = await store.getRefresh(asRefresh.id)

      if (rec && timingSafeEqualHex(sha256(asRefresh.secret), rec.tokenHash)) {
        if (!rec.revokedAt) {
          await store.updateRefresh(rec.id, { revokedAt: t })
        }
        const siblings = (await store.listAccessForUser(rec.username)).filter(
          (a) => a.refreshId === rec.id,
        )
        const ids: string[] = []

        for (const a of siblings) {
          if (!a.revokedAt) {
            await store.updateAccess(a.id, { revokedAt: t })
          }
          ids.push(`oauth:${rec.username}:${a.id}`)
        }

        return ids
      }
    }

    return []
  }

  return {
    protectedResourceMetadata,
    authorizationServerMetadata,
    registerClient,
    resolveClient,
    assertRedirectAllowed,
    issueCode,
    exchangeCode,
    refresh,
    revoke,
  }
}

/** Allow a redirect_uri iff it EXACTLY matches a registered one — no prefix/substring
 *  match (open-redirect footgun). Throws on miss. */
export const assertRedirectAllowed = (client: OAuthClientRecord, redirectUri: string): void => {
  if (!client.redirectUris.includes(redirectUri)) {
    throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client')
  }
}

/** A registrable redirect must be an absolute https URL (or a loopback http for
 *  native clients per RFC 8252) with no fragment. */
const assertValidRedirect = (uri: string, maxChars?: number): void => {
  if (maxChars != null && uri.length > maxChars) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uri is too long')
  }
  let u: URL

  try {
    u = new URL(uri)
  } catch {
    throw new OAuthError('invalid_redirect_uri', `not a valid URL: ${uri}`)
  }
  if (u.hash) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uri must not contain a fragment')
  }
  // A bracketed IPv6 literal arrives as `[::1]` — strip the brackets so the
  // loopback exemption (RFC 8252 native clients) matches.
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const loopback =
    u.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1')

  if (u.protocol !== 'https:' && !loopback) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uri must be https (or loopback http)')
  }
}

const assertClientRedirects = (
  redirectUris: string[],
  missingCode = 'invalid_client_metadata',
  limits?: { maxUris: number; maxUriChars: number },
): void => {
  if (!redirectUris.length) {
    throw new OAuthError(missingCode, 'redirect_uris is required')
  }
  if (limits && redirectUris.length > limits.maxUris) {
    throw new OAuthError(missingCode, `at most ${limits.maxUris} redirect_uris are allowed`)
  }
  for (const uri of redirectUris) {
    assertValidRedirect(uri, limits?.maxUriChars)
  }
}

const registrationBusy = (message: string): OAuthError =>
  new OAuthError('temporarily_unavailable', message, HTTP_STATUS.TOO_MANY_REQUESTS)
