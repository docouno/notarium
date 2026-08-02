import type { IncomingHttpHeaders } from 'node:http'
// The auth domain service: credentials in, Principal out, plus the user/invite/PAT/
// membership management the /api routes are thin shells over.
// canon: docs/auth.md#model · docs/auth.md#modes

import { AUTH_MODE, SPACE_ROLE, TOKEN_PURPOSE } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import {
  DUMMY_HASH_PROMISE,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from '../../libs/passwords'
import {
  isOneTimeToken,
  isSessionToken,
  mintOneTimeToken,
  mintSessionToken,
  parseOAuthAccessToken,
  parsePatToken,
  sha256,
  timingSafeEqualHex,
} from '../../libs/tokens'
import type { Principal, SpaceRole } from '../authz'
import type {
  AuthPersistence,
  OAuthAccessRecord,
  OAuthPersistence,
  OneTimeTokenRecord,
  PatRecord,
  SpacesPersistence,
  UserRecord,
} from '../metaDb'
import { createCredentials } from './credentials'
import { createInvites } from './invites'
import { createMemberships } from './memberships'
import { createMeViews } from './meViews'
import { createOAuthConnections } from './oauthConnections'
import { createPats } from './pats'
import { createPersonalSpace } from './personalSpace'
import { createSse } from './sse'
import { createUsers } from './users'

export type AuthMode = 'none' | 'password'

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
const SESSION_TOUCH_MS = 3600 * 1000
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000
const RESET_TTL_MS = 24 * 3600 * 1000
// Two-tier login rate limit; both gates close before scrypt.
// canon: docs/auth.md#credentials
const LOGIN_MAX_FAILS = 10
const LOGIN_MAX_FAILS_PER_IP = 20
const LOGIN_WINDOW_MS = 15 * 60 * 1000
// One scrypt verify uses ~128 MiB at the configured N/r. The rate counters bound
// attempts over time; this process-global belt bounds RAM at an instant and is
// shared by every login transport because both call this service method.
const LOGIN_MAX_IN_FLIGHT = 2

export const SESSION_COOKIE = 'nt_session'

/** A wire-visible auth failure the routes map onto an HTTP envelope. */
export class AuthError extends Error {
  status: number
  reason?: string
  constructor(status: number, message: string, reason?: string) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

export type Authenticated = {
  principal: Principal
  /** Cookie-borne (CSRF checks apply) vs bearer (agents). */
  viaCookie: boolean
  sessionToken?: string
}

/** A live SSE socket registered per (principal, user, space): `close` disconnects,
 *  the notify* methods push named re-sync nudges. canon: docs/auth.md#sse-revoke-disconnect */
export type SseHandle = {
  principalId: string
  username: string | null
  space: string
  close: () => void
  notify: () => void
  notifyMembers: () => void
  notifyRename: () => void
  notifyJob: (payload: unknown) => void
}

/** The `/api/me` wire view; grants + personal pointer resolved to slugs, each grant
 *  carrying past slugs (`aliases`) so a rename of the active space isn't read as
 *  space-lost. canon: docs/auth.md#wire · docs/auth.md#loss-of-access-at-runtime-explicit-takeover-111 */
export type MeView = {
  username: string
  displayName: string
  admin: boolean
  spaces: Array<{ slug: string; role: SpaceRole; aliases?: string[] }>
  personalSpace: string | null
}

export type CreateAuthServiceOptions = {
  mode: AuthMode
  /** Optional in the type, MANDATORY in 'password' mode (boot-asserted). */
  persistence?: AuthPersistence
  /** Absent ⇒ OAuth tokens don't validate (PATs and sessions still do). */
  oauth?: OAuthPersistence
  /** id↔slug translation for the wire. Absent (none-mode) ⇒ id≡slug. */
  spaces?: SpacesPersistence
  now?: () => Date
  /** Test seam for the expensive verifier; production always uses scrypt. */
  passwordVerifier?: (password: string, encoded: string) => Promise<boolean>
  /** Tracks read-side credential usage writes in the online-backup mutation gate
   *  without adding their latency to the request. */
  runMutation?: <T>(task: () => Promise<T>) => Promise<T>
}

export type AuthService = ReturnType<typeof createAuthService>

/** Shared long-lived state + helpers, built ONCE in createAuthService and threaded into
 *  every concern factory — the single owner of the SSE set, rate-limit counters, client-name
 *  cache and id↔slug maps, so those are never re-created per concern. */
export type AuthCtx = {
  mode: AuthMode
  persistence: AuthPersistence | undefined
  db: AuthPersistence
  oauthStore: OAuthPersistence | null
  spacesStore: SpacesPersistence | null
  clock: () => Date
  nowIso: () => string
  slugById: () => Promise<Map<string, string> | null>
  idBySlug: () => Promise<Map<string, string> | null>
  slugsToIds: (slugs: string[]) => Promise<string[]>
  sseHandles: Set<SseHandle>
  fails: Map<string, { count: number; resetAt: number }>
  clientNames: Map<string, { name: string | null; at: number }>
  dropSse: (match: (h: SseHandle) => boolean) => void
  notifySse: (match: (h: SseHandle) => boolean) => void
  notifyMembersOf: (space: string) => void
  notifyRenameOf: (space: string) => void
  notifyJobOf: (space: string, ownerPrincipalId: string, payload: unknown) => void
  registerFail: (key: string) => void
  failKey: (username: string, ip: string) => string
  ipKey: (ip: string) => string
  limited: (key: string, max: number) => boolean
  clientNameOf: (clientId: string) => Promise<string | null>
  principalOf: (
    user: UserRecord,
    cred:
      | { kind: 'session' }
      | { kind: 'pat'; pat: PatRecord }
      | { kind: 'oauth'; token: OAuthAccessRecord },
  ) => Promise<Principal>
  createSession: (username: string) => Promise<string>
  activeUser: (username: string) => Promise<UserRecord | null>
  mintLink: (
    username: string,
    purpose: OneTimeTokenRecord['purpose'],
  ) => Promise<{ token: string; path: string }>
  liveOneTime: (token: string) => Promise<OneTimeTokenRecord | null>
  me: (username: string) => Promise<MeView>
}

export function createAuthService({
  mode,
  persistence,
  oauth,
  spaces,
  now,
  passwordVerifier,
  runMutation,
}: CreateAuthServiceOptions) {
  if (mode === AUTH_MODE.password && !persistence) {
    throw new Error(
      'AUTH_MODE=password needs a durable meta-DB (set META_DB_URL) — or opt out explicitly with AUTH_MODE=none',
    )
  }
  const db = persistence as AuthPersistence
  const oauthStore = oauth ?? null
  const spacesStore = spaces ?? null
  const backgroundMutation = runMutation ?? (<T>(task: () => Promise<T>) => task())
  // id↔slug maps rebuilt per call (me/PAT lists aren't hot). A null map ⇒ no registry
  // ⇒ id≡slug (identity); with a registry, a since-dropped id/slug resolves to undefined.
  const slugById = async (): Promise<Map<string, string> | null> =>
    spacesStore ? new Map((await spacesStore.list()).map((s) => [s.id, s.slug])) : null
  const idBySlug = async (): Promise<Map<string, string> | null> =>
    spacesStore ? new Map((await spacesStore.list()).map((s) => [s.slug, s.id])) : null

  /** Wire slugs → stored space ids, DROPPING any slug the registry no longer lists
   *  (fail-closed: a narrowing to a nonexistent space is meaningless). No registry ⇒ id≡slug. */
  const slugsToIds = async (slugs: string[]): Promise<string[]> => {
    const ids = await idBySlug()
    const toId = (slug: string): string | undefined => (ids ? ids.get(slug) : slug)
    return slugs.flatMap((sl) => (toId(sl) ? [toId(sl) as string] : []))
  }
  const clock = now ?? (() => new Date())
  const checkPassword = passwordVerifier ?? verifyPassword
  const nowIso = () => clock().toISOString()
  let passwordVerifiesInFlight = 0

  // ── live SSE sockets: revoke = disconnect, not silent starvation ──────────
  const sseHandles = new Set<SseHandle>()

  const dropSse = (match: (h: SseHandle) => boolean) => {
    for (const h of [...sseHandles]) {
      if (!match(h)) {
        continue
      }
      sseHandles.delete(h)
      try {
        h.close()
      } catch {
        // a socket mid-teardown is fine
      }
    }
  }

  // Grant-side twin of dropSse: poke matching sockets to re-sync their grants WITHOUT
  // disconnecting them.
  const notifySse = (match: (h: SseHandle) => boolean) => {
    for (const h of sseHandles) {
      if (!match(h)) {
        continue
      }
      try {
        h.notify()
      } catch {
        // a socket mid-teardown is fine
      }
    }
  }

  // Space-level broadcast: poke every live viewer of `space` (not just the subject, unlike
  // notifySse) so an open members list re-fetches.
  const notifyMembersOf = (space: string) => {
    for (const h of sseHandles) {
      if (h.space !== space) {
        continue
      }
      try {
        h.notifyMembers()
      } catch {
        // a socket mid-teardown is fine
      }
    }
  }

  // Space rename broadcast to live viewers of `space`, matched by stable id (a rename never
  // touches it). A viewer currently in ANOTHER space relabels on their next reload/switch —
  // a cosmetic lag, not a correctness gap.
  const notifyRenameOf = (space: string) => {
    for (const h of sseHandles) {
      if (h.space !== space) {
        continue
      }
      try {
        h.notifyRename()
      } catch {
        // a socket mid-teardown is fine
      }
    }
  }

  // Job-progress push ONLY to the job's OWNER (enqueuing principal): the payload carries data
  // GET /jobs/:id gates by ownership, so unlike the empty rename/members pokes it must not
  // fan out to every space viewer.
  const notifyJobOf = (space: string, ownerPrincipalId: string, payload: unknown) => {
    for (const h of sseHandles) {
      if (h.space !== space || h.principalId !== ownerPrincipalId) {
        continue
      }
      try {
        h.notifyJob(payload)
      } catch {
        // a socket mid-teardown is fine
      }
    }
  }

  // ── login rate limit (in-memory, per process — single-instance invariant) ──
  // canon: docs/auth.md#deployment-the-single-instance-invariant
  const fails = new Map<string, { count: number; resetAt: number }>()
  const failKey = (username: string, ip: string) => `u:${username}|${ip}`
  const ipKey = (ip: string) => `ip:${ip}`

  const registerFail = (key: string) => {
    const t = clock().getTime()
    const cur = fails.get(key)

    if (!cur || cur.resetAt <= t) {
      fails.set(key, { count: 1, resetAt: t + LOGIN_WINDOW_MS })
    } else {
      cur.count++
    }
  }

  const limited = (key: string, max: number) => {
    const cur = fails.get(key)
    return Boolean(cur && cur.resetAt > clock().getTime() && cur.count >= max)
  }

  // Cache clientId → app name so principalOf skips the oauth store on every oauth request.
  // The name is a display-only label, so a briefly-stale value across the TTL is harmless.
  const CLIENT_NAME_TTL_MS = 60_000
  const clientNames = new Map<string, { name: string | null; at: number }>()

  const clientNameOf = async (clientId: string): Promise<string | null> => {
    if (!oauthStore) {
      return null
    }
    const t = clock().getTime()
    const hit = clientNames.get(clientId)

    if (hit && hit.at + CLIENT_NAME_TTL_MS > t) {
      return hit.name
    }
    const name = (await oauthStore.getClient(clientId))?.clientName ?? null
    clientNames.set(clientId, { name, at: t })
    return name
  }

  const principalOf = async (
    user: UserRecord,
    cred:
      | { kind: 'session' }
      | { kind: 'pat'; pat: PatRecord }
      | { kind: 'oauth'; token: OAuthAccessRecord },
  ): Promise<Principal> => {
    const grants = new Map((await db.grantsFor(user.username)).map((g) => [g.space, g.role]))

    if (cred.kind === 'session') {
      return {
        id: `user:${user.username}`,
        username: user.username,
        admin: user.admin,
        scope: 'manage',
        grants,
        spaces: null,
        system: false,
        label: null, // a human session, not an agent
      }
    }
    if (cred.kind === 'oauth') {
      // An OAuth connector is an agent like a PAT: its ceiling is the consented read|write,
      // never 'manage'.
      return {
        id: `oauth:${user.username}:${cred.token.id}`,
        username: user.username,
        admin: user.admin,
        scope: cred.token.scope,
        grants,
        spaces: cred.token.spaces ? new Set(cred.token.spaces) : null,
        system: false,
        label: await clientNameOf(cred.token.clientId),
      }
    }

    return {
      id: `pat:${user.username}:${cred.pat.id}`,
      username: user.username,
      admin: user.admin,
      scope: cred.pat.scope,
      grants,
      spaces: cred.pat.spaces ? new Set(cred.pat.spaces) : null,
      system: false,
      label: cred.pat.name,
    }
  }

  const createSession = async (username: string): Promise<string> => {
    const token = mintSessionToken()
    const t = clock()
    await db.insertSession({
      idHash: sha256(token),
      username,
      createdAt: t.toISOString(),
      lastUsedAt: null,
      expiresAt: new Date(t.getTime() + SESSION_TTL_MS).toISOString(),
    })
    return token
  }

  const activeUser = async (username: string): Promise<UserRecord | null> => {
    const user = await db.getUser(username)
    return user && user.disabledAt == null ? user : null
  }

  const mintLink = async (
    username: string,
    purpose: OneTimeTokenRecord['purpose'],
  ): Promise<{ token: string; path: string }> => {
    // One outstanding link per user: minting invalidates older ones.
    await db.deleteOneTimesFor(username)
    const token = mintOneTimeToken()
    const t = clock()
    await db.insertOneTime({
      idHash: sha256(token),
      username,
      purpose,
      expiresAt: new Date(
        t.getTime() + (purpose === TOKEN_PURPOSE.invite ? INVITE_TTL_MS : RESET_TTL_MS),
      ).toISOString(),
      usedAt: null,
      createdAt: t.toISOString(),
    })
    // The token rides the FRAGMENT — it never reaches access logs.
    return { token, path: `/invite#${token}` }
  }

  const liveOneTime = async (token: string): Promise<OneTimeTokenRecord | null> => {
    if (!isOneTimeToken(token)) {
      return null
    }
    const rec = await db.getOneTime(sha256(token))

    if (!rec || rec.usedAt || rec.expiresAt <= nowIso()) {
      return null
    }

    return rec
  }

  const me = async (username: string): Promise<MeView> => {
    const user = await db.getUser(username)

    if (!user) {
      throw new AuthError(HTTP_STATUS.UNAUTHORIZED, 'unauthorized')
    }
    // The wire speaks slugs: translate the id-keyed grants + personal pointer, dropping any
    // grant whose space the registry no longer lists.
    const recs = spacesStore ? new Map((await spacesStore.list()).map((s) => [s.id, s])) : null
    const toSlug = (id: string): string | undefined => (recs ? recs.get(id)?.slug : id)
    const grants = await db.grantsFor(user.username)
    return {
      username: user.username,
      displayName: user.displayName,
      admin: user.admin,
      spaces: grants.flatMap((g) => {
        const rec = recs?.get(g.space)
        const slug = toSlug(g.space)

        // Drop a grant whose space is unlisted (stale membership) OR ARCHIVED: an archived
        // space isn't served, so its absence here is what drives the client takeover. The
        // grant stays in the DB, so a restore brings the space straight back.
        if (!slug || rec?.archivedAt) {
          return []
        }
        const aliases = rec?.aliases ?? []
        return [{ slug, role: g.role, ...(aliases.length ? { aliases } : {}) }]
      }),
      personalSpace: user.personalSpace ? (toSlug(user.personalSpace) ?? null) : null,
    }
  }

  const ctx: AuthCtx = {
    mode,
    persistence,
    db,
    oauthStore,
    spacesStore,
    clock,
    nowIso,
    slugById,
    idBySlug,
    slugsToIds,
    sseHandles,
    fails,
    clientNames,
    dropSse,
    notifySse,
    notifyMembersOf,
    notifyRenameOf,
    notifyJobOf,
    registerFail,
    failKey,
    ipKey,
    limited,
    clientNameOf,
    principalOf,
    createSession,
    activeUser,
    mintLink,
    liveOneTime,
    me,
  }

  return {
    mode,

    /** Zero users ⇒ first-run setup is open. One cheap COUNT, deliberately UNCACHED: the e2e
     *  fake re-seeds worlds at runtime, so correctness beats caching the anonymous path. */
    setupOpen: async (): Promise<boolean> => {
      if (mode !== AUTH_MODE.password) {
        return false
      }

      return (await db.userCount()) === 0
    },

    /** Request credentials → Principal. Null = nothing valid presented. */
    authenticate: async (headers: IncomingHttpHeaders): Promise<Authenticated | null> => {
      if (mode !== AUTH_MODE.password) {
        return null
      }
      const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1]

      if (bearer) {
        const raw = bearer.trim()
        const parsed = parsePatToken(raw)

        if (parsed) {
          const pat = await db.getPat(parsed.id)

          if (!pat || pat.revokedAt || !timingSafeEqualHex(sha256(parsed.secret), pat.secretHash)) {
            return null
          }
          if (pat.expiresAt && pat.expiresAt <= nowIso()) {
            return null
          }
          const user = await activeUser(pat.username)

          if (!user) {
            return null
          }
          void backgroundMutation(() => db.updatePat(pat.id, { lastUsedAt: nowIso() })).catch(
            () => {},
          )
          return { principal: await principalOf(user, { kind: 'pat', pat }), viaCookie: false }
        }
        // An OAuth access token: same shape as a PAT (id + hashed secret), validated through
        // the same chokepoint — only the store and the principal scheme differ.
        const oa = parseOAuthAccessToken(raw)

        if (oa && oauthStore) {
          const tok = await oauthStore.getAccess(oa.id)

          if (!tok || tok.revokedAt || !timingSafeEqualHex(sha256(oa.secret), tok.tokenHash)) {
            return null
          }
          if (tok.expiresAt <= nowIso()) {
            return null
          }
          const user = await activeUser(tok.username)

          if (!user) {
            return null
          }
          void backgroundMutation(() =>
            oauthStore.updateAccess(tok.id, { lastUsedAt: nowIso() }),
          ).catch(() => {})
          return {
            principal: await principalOf(user, { kind: 'oauth', token: tok }),
            viaCookie: false,
          }
        }

        return null
      }
      const cookies = headers.cookie ?? ''
      const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookies)
      const token = m?.[1]

      if (!token || !isSessionToken(token)) {
        return null
      }
      const idHash = sha256(token)
      const session = await db.getSession(idHash)

      if (!session || session.expiresAt <= nowIso()) {
        return null
      }
      const user = await activeUser(session.username)

      if (!user) {
        return null
      }
      const t = clock()
      const lastUsed = session.lastUsedAt ? Date.parse(session.lastUsedAt) : 0

      if (t.getTime() - lastUsed > SESSION_TOUCH_MS) {
        void backgroundMutation(() =>
          db.touchSession(
            idHash,
            t.toISOString(),
            new Date(t.getTime() + SESSION_TTL_MS).toISOString(),
          ),
        ).catch(() => {})
      }

      return { principal: await principalOf(user, { kind: 'session' }), viaCookie: true }
    },

    /** First-run: mint the host owner as owner of every configured space (`spaceSlugs`). */
    setup: async (
      input: { username: string; displayName?: string; password: string },
      spaceSlugs: string[],
    ): Promise<{ me: MeView; sessionToken: string }> => {
      const t = nowIso()
      // The claim IS the guard: createFirstUser inserts only while the users table is empty
      // and reports whether it won, so two concurrent setups can't both mint an admin. The
      // loser gets the same 404 as the closed-setup path.
      const won = await db.createFirstUser({
        username: input.username,
        displayName: input.displayName?.trim() || input.username,
        passwordHash: await hashPassword(input.password),
        admin: true,
        disabledAt: null,
        createdAt: t,
        personalSpace: null,
      })

      if (!won) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      for (const slug of spaceSlugs) {
        await db.upsertMember(slug, input.username, SPACE_ROLE.owner, t)
      }

      return { me: await me(input.username), sessionToken: await createSession(input.username) }
    },

    login: async (input: {
      username: string
      password: string
      ip: string
    }): Promise<{ me: MeView; sessionToken: string }> => {
      const key = failKey(input.username, input.ip)
      const ipk = ipKey(input.ip)

      // Both gates close BEFORE any scrypt runs — a rate-limited caller costs
      // nothing to reject.
      if (limited(key, LOGIN_MAX_FAILS) || limited(ipk, LOGIN_MAX_FAILS_PER_IP)) {
        throw new AuthError(
          HTTP_STATUS.TOO_MANY_REQUESTS,
          'too many attempts, try later',
          'rate_limited',
        )
      }

      const user = await db.getUser(input.username)
      // Unknown user and wrong password take the same path and the same time.
      const hash = user?.passwordHash ?? (await DUMMY_HASH_PROMISE)

      if (passwordVerifiesInFlight >= LOGIN_MAX_IN_FLIGHT) {
        throw new AuthError(
          HTTP_STATUS.TOO_MANY_REQUESTS,
          'too many login attempts in progress, try later',
          'rate_limited',
        )
      }
      passwordVerifiesInFlight++
      let ok: boolean

      try {
        ok = await checkPassword(input.password, hash)
      } finally {
        passwordVerifiesInFlight--
      }

      if (!ok || !user || user.disabledAt != null || user.passwordHash == null) {
        registerFail(key)
        registerFail(ipk)
        throw new AuthError(HTTP_STATUS.UNAUTHORIZED, 'invalid credentials')
      }
      fails.delete(key)
      if (passwordNeedsRehash(user.passwordHash)) {
        void hashPassword(input.password)
          .then((h) => db.updateUser(user.username, { passwordHash: h }))
          .catch(() => {})
      }

      return { me: await me(user.username), sessionToken: await createSession(user.username) }
    },

    logout: async (cookieToken: string | undefined): Promise<void> => {
      if (cookieToken && isSessionToken(cookieToken)) {
        await db.deleteSession(sha256(cookieToken)).catch(() => {})
      }
    },

    me,

    ...createMeViews(ctx),
    ...createPersonalSpace(ctx),
    ...createCredentials(ctx),
    ...createInvites(ctx),
    ...createPats(ctx),
    ...createOAuthConnections(ctx),
    ...createUsers(ctx),
    ...createMemberships(ctx),
    ...createSse(ctx),
  }
}
