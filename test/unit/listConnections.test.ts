// listConnections last-used recovery (#158): a connection's "Last used" must
// reflect the real last use even after its short-lived (~1h) access token has
// expired and the app is represented by its 60-day refresh token. The signal is
// written on every authenticated request onto the access row (authenticate →
// updateAccess); the refresh row carries none. The fix sources last-used from the
// MAX lastUsedAt across ALL the app's non-revoked access rows (expired included),
// decoupled from which row established presence — so ChatGPT (whose access always
// expires within the hour) stops showing a permanent "—".

import { describe, expect, it } from 'vitest'

import { createAuthService } from '../../packages/server/src/services/auth'
import type {
  OAuthAccessRecord,
  OAuthClientRecord,
  OAuthRefreshRecord,
} from '../../packages/server/src/services/metaDb'
import { InMemoryAuthPersistence } from '../fake-server/authPersistence'
import { InMemoryOAuthPersistence } from '../fake-server/oauthPersistence'

// Fixed wall clock for the service: anything with expiresAt at/under 12:00 is
// expired, anything after is live.
const NOW = new Date('2026-06-20T12:00:00.000Z')
const CREATED = '2026-06-20T10:00:00.000Z'
const EXPIRED_AT = '2026-06-20T11:00:00.000Z' // 1h ago — access lifetime elapsed
const LIVE_AT = '2026-08-19T10:00:00.000Z' // 60d out — a live refresh / fresh access

const access = (
  over: Partial<OAuthAccessRecord> & Pick<OAuthAccessRecord, 'id'>,
): OAuthAccessRecord => ({
  tokenHash: 'h',
  username: 'alice',
  clientId: 'chatgpt',
  scope: 'write',
  spaces: null,
  expiresAt: EXPIRED_AT,
  refreshId: null,
  revokedAt: null,
  createdAt: CREATED,
  lastUsedAt: null,
  ...over,
})

const refresh = (
  over: Partial<OAuthRefreshRecord> & Pick<OAuthRefreshRecord, 'id'>,
): OAuthRefreshRecord => ({
  tokenHash: 'h',
  username: 'alice',
  clientId: 'chatgpt',
  scope: 'write',
  spaces: null,
  expiresAt: LIVE_AT,
  rotatedTo: null,
  revokedAt: null,
  createdAt: CREATED,
  ...over,
})

const client = (
  over: Partial<OAuthClientRecord> & Pick<OAuthClientRecord, 'clientId'>,
): OAuthClientRecord => ({
  kind: 'cimd',
  redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  clientName: 'ChatGPT',
  createdAt: CREATED,
  lastSeen: CREATED,
  activatedAt: CREATED,
  ...over,
})

const setup = async (seed: (oauth: InMemoryOAuthPersistence) => Promise<void>) => {
  const db = new InMemoryAuthPersistence()
  await db.createUser({
    username: 'alice',
    displayName: 'alice',
    passwordHash: 'x',
    admin: false,
    disabledAt: null,
    createdAt: CREATED,
    personalSpace: null,
  })
  const oauth = new InMemoryOAuthPersistence()
  await oauth.upsertClient(client({ clientId: 'chatgpt' }))
  await seed(oauth)
  return createAuthService({ mode: 'password', persistence: db, oauth, now: () => NOW })
}

describe('listConnections — last-used recovery (#158)', () => {
  it('expired access (used) + live refresh → shows the real last-used, not "—"', async () => {
    const auth = await setup(async (oauth) => {
      await oauth.insertAccess(access({ id: 'a1', lastUsedAt: '2026-06-20T11:30:00.000Z' }))
      await oauth.insertRefresh(refresh({ id: 'r1' }))
    })
    const conns = await auth.listConnections('alice')
    expect(conns).toEqual([
      {
        id: 'chatgpt',
        appName: 'ChatGPT',
        scope: 'write',
        spaces: null,
        createdAt: CREATED,
        lastUsedAt: '2026-06-20T11:30:00.000Z',
      },
    ])
  })

  it('connected but never used → last-used stays null ("—")', async () => {
    const auth = await setup(async (oauth) => {
      await oauth.insertAccess(access({ id: 'a1', lastUsedAt: null }))
      await oauth.insertRefresh(refresh({ id: 'r1' }))
    })
    const [conn] = await auth.listConnections('alice')
    expect(conn.lastUsedAt).toBeNull()
  })

  it('recovers the MAX last-used across the app access rows — expired ones included', async () => {
    // ChatGPT steady state: no live access left (all rotated out / expired within the
    // hour), only a live refresh. Last-used must be the latest across the EXPIRED
    // access rows. Pre-fix showed null (refresh-fallback); the fix recovers 10:45 —
    // and because the winning value sits on an expired row, this case actually fails
    // on pre-fix code (unlike a value that happens to sit on a still-live row).
    const auth = await setup(async (oauth) => {
      await oauth.insertAccess(
        access({
          id: 'a1',
          expiresAt: '2026-06-20T10:00:00.000Z',
          lastUsedAt: '2026-06-20T09:30:00.000Z',
        }),
      )
      await oauth.insertAccess(
        access({
          id: 'a2',
          expiresAt: '2026-06-20T11:00:00.000Z',
          lastUsedAt: '2026-06-20T10:45:00.000Z',
        }),
      )
      await oauth.insertRefresh(refresh({ id: 'r1' }))
    })
    const [conn] = await auth.listConnections('alice')
    expect(conn.lastUsedAt).toBe('2026-06-20T10:45:00.000Z')
  })

  it('one row per app, newest connection first, each carrying its own last-used (no cross-client bleed)', async () => {
    const auth = await setup(async (oauth) => {
      // chatgpt: older connection, access expired → last-used recovered from the expired row.
      await oauth.insertAccess(
        access({
          id: 'g1',
          clientId: 'chatgpt',
          createdAt: '2026-06-18T00:00:00.000Z',
          lastUsedAt: '2026-06-20T11:00:00.000Z',
        }),
      )
      await oauth.insertRefresh(
        refresh({ id: 'gr', clientId: 'chatgpt', createdAt: '2026-06-18T00:00:00.000Z' }),
      )
      // claude: newer connection, LIVE access, distinct last-used.
      await oauth.upsertClient(client({ clientId: 'claude', clientName: 'Claude' }))
      await oauth.insertAccess(
        access({
          id: 'c1',
          clientId: 'claude',
          createdAt: '2026-06-19T00:00:00.000Z',
          expiresAt: '2026-06-20T12:30:00.000Z',
          lastUsedAt: '2026-06-20T11:55:00.000Z',
        }),
      )
      await oauth.insertRefresh(
        refresh({ id: 'cr', clientId: 'claude', createdAt: '2026-06-19T00:00:00.000Z' }),
      )
    })
    const conns = await auth.listConnections('alice')
    expect(conns.map((c) => [c.id, c.appName, c.lastUsedAt])).toEqual([
      ['claude', 'Claude', '2026-06-20T11:55:00.000Z'], // newest createdAt sorts first
      ['chatgpt', 'ChatGPT', '2026-06-20T11:00:00.000Z'], // its own last-used, not claude's
    ])
  })

  it('a REVOKED access row is ignored — its last-used does not leak into the projection', async () => {
    const auth = await setup(async (oauth) => {
      // A revoked row with a NEWER last-used must not win; the surfaced value comes
      // from the (expired but non-revoked) access row, the app kept alive by its refresh.
      await oauth.insertAccess(
        access({
          id: 'revoked',
          revokedAt: '2026-06-20T11:45:00.000Z',
          lastUsedAt: '2026-06-20T11:40:00.000Z',
        }),
      )
      await oauth.insertAccess(access({ id: 'a1', lastUsedAt: '2026-06-20T11:00:00.000Z' }))
      await oauth.insertRefresh(refresh({ id: 'r1' }))
    })
    const [conn] = await auth.listConnections('alice')
    expect(conn.lastUsedAt).toBe('2026-06-20T11:00:00.000Z')
  })

  it('a DEAD app (expired access, no live refresh) is not listed even if it has a last-used', async () => {
    const auth = await setup(async (oauth) => {
      await oauth.insertAccess(access({ id: 'a1', lastUsedAt: '2026-06-20T11:30:00.000Z' }))
      // Refresh expired too → nothing live → the connection is gone.
      await oauth.insertRefresh(refresh({ id: 'r1', expiresAt: EXPIRED_AT }))
    })
    expect(await auth.listConnections('alice')).toEqual([])
  })
})

// The SSE belt of updateConnection (#181): a real rights change (scope/spaces) drops the
// connector's live socket so it reconnects under the new ceiling — but an EMPTY patch (now
// valid, since scope became optional) must be a pure no-op that tears down NOTHING. Asserting
// this at the service level (a request/response test can't observe the socket) makes FIX-2
// load-bearing: the persistence layer already no-ops an empty dbPatch, so only the dropSse
// suppression is what the early-return actually protects.
describe('updateConnection — SSE belt (#181)', () => {
  it('drops the connector socket for a real patch, never for an empty no-op', async () => {
    const auth = await setup(async (oauth) => {
      await oauth.insertAccess(access({ id: 'a1' }))
      await oauth.insertRefresh(refresh({ id: 'r1' }))
    })
    let closed = 0
    auth.registerSse({
      principalId: 'oauth:alice:a1',
      username: 'alice',
      space: 's',
      close: () => {
        closed++
      },
      notify: () => {},
      notifyMembers: () => {},
      notifyRename: () => {},
      notifyAgentSessions: () => {},
      notifyJob: () => {},
    })
    // Empty patch = no-op: it must NOT tear down the live stream (the FIX-2 early-return).
    await auth.updateConnection('alice', 'chatgpt', {})
    expect(closed).toBe(0)
    // A real patch (scope) = rights change: drops the socket so it reconnects under the new ceiling.
    await auth.updateConnection('alice', 'chatgpt', { scope: 'read' })
    expect(closed).toBe(1)
  })
})
