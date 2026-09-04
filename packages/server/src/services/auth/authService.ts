import type { IncomingHttpHeaders } from 'node:http'
// The auth domain service: credentials in, Principal out, plus the user/invite/PAT/
// membership management the /api routes are thin shells over.
// canon: docs/auth.md#model · docs/auth.md#modes

import { AUTH_MODE, SPACE_ROLE, TOKEN_PURPOSE } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { defineClientFailure } from '../../libs/clientFailure'
import {
  DUMMY_HASH_PROMISE,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from '../../libs/passwords'
import { oauthPrincipalId, patPrincipalId, userPrincipalId } from '../../libs/principalId'
import {
  isOneTimeToken,
  isSessionToken,
  mintOneTimeToken,
  mintSessionToken,
  mintUserId,
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
import { createIdentity } from './identity'
import { createInvites } from './invites'
import { loginLookupOf } from './loginIdentifier'
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
// Two-tier login rate limit. The ip gate closes before scrypt; the account gate does
// NOT — a spent account budget is carried through the verification so that its refusal
// costs what a wrong pair costs. Refusing it early would answer instantly and without
// an ip counter entry, which tells an attacker that a handle and an address are one
// account without a body to read.
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
    if (status === HTTP_STATUS.NOT_FOUND) {
      defineClientFailure(this, { kind: 'not-found' })
    } else if (status === HTTP_STATUS.BAD_REQUEST) {
      defineClientFailure(this, { kind: 'actionable', message })
    }
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
  /** The socket's owner by stable id: a rename never detaches a live socket from
   *  the disable/revoke/nudge matches, and a disabled user's sockets are found by
   *  the key that outlives the handle. */
  userId: string | null
  space: string
  /** Active space plus every supplemental store bus owned by this socket. */
  spaces?: ReadonlySet<string>
  close: () => void
  notify: () => void
  notifyMembers: () => void
  notifyRename: () => void
  notifyAgentSessions: () => void
  notifyJob: (payload: unknown) => void
}

/** The `/api/me` wire view; grants + personal pointer resolved to slugs, each grant
 *  carrying past slugs (`aliases`) so a rename of the active space isn't read as
 *  space-lost. canon: docs/auth.md#wire · docs/auth.md#loss-of-access-at-runtime-explicit-takeover-111 */
export type MeView = {
  /** The stable account id — opaque to the client, its key for local per-user state. */
  id: string
  username: string
  email: string | null
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
  /** Registry-owned filter for retired handles that still resolve uniquely.
   *  Omit only when no registry is present; a missing capability exposes no
   *  aliases rather than widening client-side resolution. */
  aliasesForSpace?: (id: string) => readonly string[]
  now?: () => Date
  /** Test seam for the expensive verifier; production always uses scrypt. */
  passwordVerifier?: (password: string, encoded: string) => Promise<boolean>
  /** Tracks read-side credential usage writes in the online-backup mutation gate
   *  without adding their latency to the request. */
  runMutation?: <T>(task: () => Promise<T>) => Promise<T>
  /** One durable transition: provider rows owned by the departing member leave
   * before the membership row, under the same Space fence. */
  removeMemberAndProviderAttachments: (space: string, userId: string) => Promise<void>
  /** Runs AFTER a rename is durable, for what follows a handle outside the auth
   *  facet — the personal space whose slug was derived from it. Never rolls the
   *  rename back: its failure is the composition root's to log. */
  onUsernameChanged?: (change: { user: UserRecord; previousUsername: string }) => Promise<void>
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
  notifyAgentSessionsOf: (owner: string) => void
  notifyJobOf: (space: string, ownerPrincipalId: string, payload: unknown) => void
  removeMemberAndProviderAttachments: (space: string, userId: string) => Promise<void>
  onUsernameChanged?: CreateAuthServiceOptions['onUsernameChanged']
  registerFail: (key: string) => void
  failKey: (userId: string, ip: string) => string
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
  createSession: (userId: string) => Promise<string>
  activeUserById: (userId: string) => Promise<UserRecord | null>
  mintLink: (
    userId: string,
    purpose: OneTimeTokenRecord['purpose'],
  ) => Promise<{ token: string; path: string }>
  liveOneTime: (token: string) => Promise<OneTimeTokenRecord | null>
  me: (userId: string, principal?: Principal) => Promise<MeView>
}

export function createAuthService({
  mode,
  persistence,
  oauth,
  spaces,
  aliasesForSpace,
  now,
  passwordVerifier,
  runMutation,
  removeMemberAndProviderAttachments,
  onUsernameChanged,
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

  // Agent episodes are owner-global rather than space-scoped. Every live tab of
  // that owner receives the nudge and refetches from the owner-gated REST route.
  const notifyAgentSessionsOf = (owner: string) => {
    for (const h of sseHandles) {
      const matches = owner === '@system' ? h.userId === null : h.userId === owner

      if (!matches) {
        continue
      }
      try {
        h.notifyAgentSessions()
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
  // The account gate keys by the RESOLVED account, so alternating the handle and the
  // address is one budget, not two. An input that resolves to nobody keys by what was
  // typed, exactly as an unknown handle always did — rotating those is what the ip
  // gate bounds.
  const failKey = (userId: string, ip: string) => `u:${userId}|${ip}`
  const unknownKey = (typed: string, ip: string) => `x:${typed}|${ip}`
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
    const grants = new Map((await db.grantsFor(user.id)).map((g) => [g.space, g.role]))

    if (cred.kind === 'session') {
      return {
        id: userPrincipalId(user.id),
        userId: user.id,
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
        id: oauthPrincipalId(user.id, cred.token.id),
        userId: user.id,
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
      id: patPrincipalId(user.id, cred.pat.id),
      userId: user.id,
      username: user.username,
      admin: user.admin,
      scope: cred.pat.scope,
      grants,
      spaces: cred.pat.spaces ? new Set(cred.pat.spaces) : null,
      system: false,
      label: cred.pat.name,
    }
  }

  const createSession = async (userId: string): Promise<string> => {
    const token = mintSessionToken()
    const t = clock()
    await db.insertSession({
      idHash: sha256(token),
      userId,
      createdAt: t.toISOString(),
      lastUsedAt: null,
      expiresAt: new Date(t.getTime() + SESSION_TTL_MS).toISOString(),
    })
    return token
  }

  const activeUserById = async (userId: string): Promise<UserRecord | null> => {
    const user = await db.getUserById(userId)
    return user && user.disabledAt == null ? user : null
  }

  const mintLink = async (
    userId: string,
    purpose: OneTimeTokenRecord['purpose'],
  ): Promise<{ token: string; path: string }> => {
    // One outstanding link per user: minting invalidates older ones.
    await db.deleteOneTimesFor(userId)
    const token = mintOneTimeToken()
    const t = clock()
    await db.insertOneTime({
      idHash: sha256(token),
      userId,
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

  const me = async (userId: string, principal?: Principal): Promise<MeView> => {
    const user = await db.getUserById(userId)

    if (!user) {
      throw new AuthError(HTTP_STATUS.UNAUTHORIZED, 'unauthorized')
    }
    // The wire speaks slugs: translate the id-keyed grants + personal pointer, dropping any
    // grant whose space the registry no longer lists.
    const records = spacesStore ? await spacesStore.list() : null
    const recs = records ? new Map(records.map((s) => [s.id, s])) : null
    const toSlug = (id: string): string | undefined => (recs ? recs.get(id)?.slug : id)
    const grants = await db.grantsFor(user.id)
    // A space-narrowed credential (PAT/OAuth) projects the owner's membership through its
    // own narrowing — the same `can(space:read)` filter /api/spaces already applies, here
    // expressed on the narrowing directly since the owner grant exists by construction. A
    // cookie session carries `spaces: null`, so the filter is inert and its view unchanged.
    const narrowedOut = (spaceId: string): boolean =>
      Boolean(principal?.spaces) && !principal!.spaces!.has(spaceId)
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      admin: user.admin,
      spaces: grants.flatMap((g) => {
        const rec = recs?.get(g.space)
        const slug = toSlug(g.space)

        // Drop a grant whose space is unlisted (stale membership) OR ARCHIVED: an archived
        // space isn't served, so its absence here is what drives the client takeover. The
        // grant stays in the DB, so a restore brings the space straight back.
        if (!slug || rec?.archivedAt || narrowedOut(g.space)) {
          return []
        }
        const aliases = rec ? [...(aliasesForSpace?.(rec.id) ?? [])] : []
        return [{ slug, role: g.role, ...(aliases.length ? { aliases } : {}) }]
      }),
      personalSpace:
        user.personalSpace && !narrowedOut(user.personalSpace)
          ? (toSlug(user.personalSpace) ?? null)
          : null,
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
    notifyAgentSessionsOf,
    notifyJobOf,
    removeMemberAndProviderAttachments,
    onUsernameChanged,
    registerFail,
    failKey,
    ipKey,
    limited,
    clientNameOf,
    principalOf,
    createSession,
    activeUserById,
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
          const user = await activeUserById(pat.userId)

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
          const user = await activeUserById(tok.userId)

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
      const user = await activeUserById(session.userId)

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
      const id = mintUserId()
      // The claim IS the guard: createFirstUser inserts only while the users table is empty
      // and reports whether it won, so two concurrent setups can't both mint an admin. The
      // loser gets the same 404 as the closed-setup path.
      const won = await db.createFirstUser({
        id,
        username: input.username,
        email: null,
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
        await db.upsertMember(slug, id, SPACE_ROLE.owner, t)
      }

      return { me: await me(id), sessionToken: await createSession(id) }
    },

    login: async (input: {
      identifier: string
      password: string
      ip: string
    }): Promise<{ me: MeView; sessionToken: string }> => {
      const invalidCredentials = () =>
        new AuthError(HTTP_STATUS.UNAUTHORIZED, 'invalid credentials')
      // 0. The shape filter is free: an input that is neither a handle nor an address
      //    names no account, so it is refused before any read, hash or counter entry.
      const lookup = loginLookupOf(input.identifier)

      if (!lookup) {
        throw invalidCredentials()
      }
      const ipk = ipKey(input.ip)

      // 1. The ip gate closes before the directory is read — a flood is refused at
      //    the price of one in-memory counter. It is the ONE gate that answers 429:
      //    it is not tied to an account, so it tells nothing about one.
      if (limited(ipk, LOGIN_MAX_FAILS_PER_IP)) {
        throw new AuthError(
          HTTP_STATUS.TOO_MANY_REQUESTS,
          'too many attempts, try later',
          'rate_limited',
        )
      }
      // 2. One indexed read resolves the handle or the address.
      const user = await db.getUserByLogin(lookup)
      // 3. An exhausted ACCOUNT budget answers like a wrong pair: the same code, the
      //    same body, the same time and the same counter entry. A distinct code would
      //    reveal that a handle and an address are one account — the linking oracle a
      //    shared budget would otherwise create — and so would refusing it HERE, before
      //    the verification: the probe would come back instantly and without touching
      //    the ip counter, which tells the same thing without reading a body. So the
      //    spent budget is carried through the verification below instead of skipping
      //    it. The cost is bounded by the same two ceilings as any wrong pair: the ip
      //    gate above and LOGIN_MAX_IN_FLIGHT below.
      const key = user ? failKey(user.id, input.ip) : unknownKey(lookup.key, input.ip)
      const spent = limited(key, LOGIN_MAX_FAILS)
      // 4. An unknown account, a wrong password and a spent budget take the same path
      //    and the same time.
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

      if (spent || !ok || !user || user.disabledAt != null || user.passwordHash == null) {
        registerFail(key)
        registerFail(ipk)
        throw invalidCredentials()
      }
      fails.delete(key)
      if (passwordNeedsRehash(user.passwordHash)) {
        void hashPassword(input.password)
          .then((h) => db.updateUser(user.id, { passwordHash: h }))
          .catch(() => {})
      }

      return { me: await me(user.id), sessionToken: await createSession(user.id) }
    },

    logout: async (cookieToken: string | undefined): Promise<void> => {
      if (cookieToken && isSessionToken(cookieToken)) {
        await db.deleteSession(sha256(cookieToken)).catch(() => {})
      }
    },

    me,

    ...createMeViews(ctx),
    ...createPersonalSpace(ctx),
    ...createIdentity(ctx),
    ...createCredentials(ctx),
    ...createInvites(ctx),
    ...createPats(ctx),
    ...createOAuthConnections(ctx),
    ...createUsers(ctx),
    ...createMemberships(ctx),
    ...createSse(ctx),
  }
}
