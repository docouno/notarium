// The OAuth 2.1 connector facade (#96), end to end over the PRODUCTION buildApp
// (#18): discovery → register → authorize (consent) → token → use the token on
// /mcp and the REST chokepoint → refresh → revoke. Pins the load-bearing
// security properties: PKCE S256 is verified, a code is single-use, an
// unregistered redirect_uri is refused, and an OAuth access token resolves to
// the SAME principal a session/PAT would — through the one chokepoint.

import type { FastifyInstance } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OAuthError } from '@notarium/server'

import { createApp, type Fixture } from './app.js'
import { InMemoryOAuthPersistence } from './oauthPersistence.js'

const fixture = (): Fixture => ({
  now: '2026-06-20T12:00:00.000Z',
  capabilities: { providers: true },
  spaces: [
    {
      slug: 'alpha',
      displayName: 'Alpha',
      notes: [
        {
          title: 'Alpha Note',
          filePath: 'alpha-note.md',
          modifiedAt: '2026-06-10T00:00:00.000Z',
          createdAt: '2026-06-01T00:00:00.000Z',
          tags: [],
          content: '# Alpha Note\n\nbody.',
        },
      ],
    },
    // A SECOND space (#181) alice also owns — lets the narrowing tests prove a
    // connection scoped to alpha cannot reach beta. Existing tests only touch alpha.
    {
      slug: 'beta',
      displayName: 'Beta',
      notes: [
        {
          title: 'Beta Note',
          filePath: 'beta-note.md',
          modifiedAt: '2026-06-10T00:00:00.000Z',
          createdAt: '2026-06-01T00:00:00.000Z',
          tags: [],
          content: '# Beta Note\n\nbody.',
        },
      ],
    },
  ],
  auth: {
    // `bob` (non-admin, NO memberships) is the zero-grant owner for the #181 dead-end
    // regression test — a signed-in user whose me().spaces is empty must still be able
    // to authorize (fail-open to all grants), not get stuck on the "pick a space" guard.
    users: [
      { username: 'alice', password: 'alice-password-1', admin: true },
      { username: 'bob', password: 'bob-password-1', admin: false },
    ],
    members: [
      { space: 'alpha', username: 'alice', role: 'owner' },
      { space: 'beta', username: 'alice', role: 'owner' },
    ],
  },
})

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

let app: FastifyInstance

beforeEach(async () => {
  app = await createApp(fixture())
})
afterEach(async () => {
  await app.close()
})

// ── PKCE helpers ──────────────────────────────────────────────────────────────
const b64url = (b: Buffer) => b.toString('base64url')

const makePkce = () => {
  const verifier = b64url(randomBytes(32))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

const login = async (username: string, password: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: username, password },
  })
  expect(res.statusCode).toBe(200)
  return (res.headers['set-cookie'] as string).split(';')[0]
}

const form = (obj: Record<string, string>) => new URLSearchParams(obj).toString()
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }

/** DCR-register a client and return its id. */
const registerClient = async (): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { redirect_uris: [REDIRECT], client_name: 'Claude' },
  })
  expect(res.statusCode).toBe(201)
  return res.json().client_id as string
}

/** Run the consent → code → token exchange; returns the token response JSON.
 *  With a cookie: the signed-in one-step approve. Without: the inline login →
 *  re-rendered consent → approve two-step (#181 phase 4 — the consent page now carries a
 *  space picker, so a fresh login lands on it before the code is minted). */
const fullFlow = async (cookie: string): Promise<Record<string, unknown>> => {
  const clientId = await registerClient()
  const { verifier, challenge } = makePkce()
  const base = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'read write offline_access',
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }
  let sessionCookie = cookie

  if (!cookie) {
    // Step 1 — inline login: credentials on the consent form sign the user in and the
    // server RE-RENDERS consent with the picker (200 HTML, not a redirect yet).
    const loginRes = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: FORM,
      payload: form({
        ...base,
        decision: 'approve',
        identifier: 'alice',
        password: 'alice-password-1',
      }),
    })
    expect(loginRes.statusCode).toBe(200)
    sessionCookie = (loginRes.headers['set-cookie'] as string).split(';')[0]
  }
  // Step 2 — approve with the picker's default (All spaces) → the code is minted.
  const authzRes = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { ...FORM, cookie: sessionCookie },
    payload: form({ ...base, decision: 'approve', all_spaces: 'on' }),
  })
  expect(authzRes.statusCode).toBe(302)
  const loc = new URL(authzRes.headers.location as string)
  expect(loc.searchParams.get('state')).toBe('xyz')
  const code = loc.searchParams.get('code') as string
  expect(code).toMatch(/^ntac_/)
  const tokenRes = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: FORM,
    payload: form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }),
  })
  expect(tokenRes.statusCode).toBe(200)
  return tokenRes.json()
}

describe('discovery (RFC 9728 / RFC 8414)', () => {
  it('serves protected-resource metadata pointing at the auth server', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })
    expect(res.statusCode).toBe(200)
    const doc = res.json()
    expect(doc.resource).toMatch(/\/mcp$/)
    expect(doc.authorization_servers).toHaveLength(1)
    expect(doc.scopes_supported).toContain('write')
  })

  it('serves authorization-server metadata: S256-only, CIMD advertised, public client', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
    expect(res.statusCode).toBe(200)
    const doc = res.json()
    expect(doc.code_challenge_methods_supported).toEqual(['S256'])
    expect(doc.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(doc.client_id_metadata_document_supported).toBe(true)
    // Compatibility guard: DCR remains available to integrations that do not
    // implement CIMD. The abuse bounds do not turn the capability off.
    expect(doc.registration_endpoint).toMatch(/\/oauth\/register$/)
    expect(doc.authorization_endpoint).toMatch(/\/oauth\/authorize$/)
    expect(doc.token_endpoint).toMatch(/\/oauth\/token$/)
  })
})

describe('public OAuth perimeter limits', () => {
  const authorizePayload = (clientId: string) =>
    form({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: 'A'.repeat(43),
      code_challenge_method: 'S256',
      decision: 'approve',
      identifier: 'alice',
      password: 'wrong-password',
    })

  it('keeps the existing DCR wire contract for a normal integration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: [REDIRECT], client_name: 'Claude' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      client_id: expect.stringMatching(/^ntcli_/),
      client_name: 'Claude',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    })
  })

  it('rejects oversized registration bodies and redirect lists before persistence', async () => {
    const oversized = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: [REDIRECT], client_name: 'x'.repeat(70 * 1024) },
    })
    expect(oversized.statusCode).toBe(413)
    expect(oversized.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'registration request body too large',
    })

    const tooMany = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: {
        redirect_uris: Array.from({ length: 33 }, (_, i) => `https://client.example/cb/${i}`),
      },
    })
    expect(tooMany.statusCode).toBe(400)
    expect(tooMany.json().error).toBe('invalid_client_metadata')
  })

  it('rate-limits DCR without removing it from discovery', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/oauth/register',
        payload: { redirect_uris: [`https://client.example/cb/${i}`] },
      })
      expect(res.statusCode).toBe(201)
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: ['https://client.example/cb/limited'] },
    })
    expect(limited.statusCode).toBe(429)
    expect(limited.json().error).toBe('temporarily_unavailable')
  })

  it('ignores spoofed XFF for limits while preserving the existing proxy-origin contract', async () => {
    const metadata = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
      headers: {
        host: 'notarium.local',
        'x-forwarded-host': 'notes.example.com',
        'x-forwarded-proto': 'https',
      },
    })
    // Host/proto forwarding is an existing integration contract and is deliberately
    // unchanged by the narrower client-IP fix.
    expect(metadata.json().issuer).toBe('https://notes.example.com')

    let verifies = 0
    await app.close()
    app = await createApp(fixture(), {
      passwordVerifier: async () => {
        verifies++
        return false
      },
    })
    const clientId = await registerClient()

    // Five failures through each login surface are one shared ten-attempt budget.
    // A different forged XFF on every request must not manufacture new clients.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
        payload: { identifier: 'alice', password: 'wrong-password' },
      })
      expect(res.statusCode).toBe(401)
    }
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/oauth/authorize',
        headers: {
          ...FORM,
          'x-forwarded-for': `203.0.113.${i + 1}`,
        },
        payload: authorizePayload(clientId),
      })
      expect(res.statusCode).toBe(200)
    }
    expect(verifies).toBe(10)
    // The eleventh attempt is refused by the ACCOUNT gate, and the form answers exactly
    // as it would to a wrong pair — same body, and the same WORK: the verification runs
    // anyway. Refusing it early would be the linking oracle in another shape, an
    // instant answer that never touches the ip counter. No 429 here: that is the ip
    // gate's alone, and it has counted eleven of its twenty.
    const limited = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, 'x-forwarded-for': '192.0.2.99' },
      payload: authorizePayload(clientId),
    })
    expect(limited.statusCode).toBe(200)
    expect(limited.body).toContain('Invalid username, email or password.')
    expect(verifies).toBe(11)
  })

  it('uses distinct forwarded client IPs only behind an explicitly trusted proxy', async () => {
    await app.close()
    app = await createApp(fixture(), {
      trustProxy: ['127.0.0.1'],
      passwordVerifier: async () => false,
    })
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
        payload: { identifier: 'alice', password: 'wrong-password' },
      })
      expect(res.statusCode).toBe(401)
    }
  })

  it('shares the two-verification memory ceiling across both login surfaces', async () => {
    let entered = 0
    let signalEntered!: () => void
    let release!: () => void
    const bothEntered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    await app.close()
    app = await createApp(fixture(), {
      passwordVerifier: async () => {
        entered++
        if (entered === 2) {
          signalEntered()
        }
        await gate
        return false
      },
    })
    const clientId = await registerClient()
    const apiAttempt = app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'alice', password: 'wrong-password' },
    })
    const oauthAttempt = app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: FORM,
      payload: authorizePayload(clientId),
    })
    await bothEntered

    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'alice', password: 'wrong-password' },
    })
    expect(limited.statusCode).toBe(429)
    release()
    expect((await apiAttempt).statusCode).toBe(401)
    expect((await oauthAttempt).statusCode).toBe(200)
  })

  it('returns HTML 400 without redirect when a pending client expires before activation', async () => {
    class ExpiringActivationPersistence extends InMemoryOAuthPersistence {
      override async activateClient(): Promise<boolean> {
        return false
      }
    }

    await app.close()
    app = await createApp(fixture(), {
      oauthPersistence: new ExpiringActivationPersistence(),
    })
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { challenge } = makePkce()
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'approve',
        all_spaces: 'on',
      }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.headers.location).toBeUndefined()
    expect(res.body).toContain('unknown or expired client')
    expect(res.body).not.toContain('ntac_')
  })

  it('preserves retryable status for CIMD admission errors before any redirect', async () => {
    const persistence = new InMemoryOAuthPersistence()
    const getClient = persistence.getClient.bind(persistence)

    persistence.getClient = async (clientId: string) => {
      if (clientId.startsWith('https://')) {
        throw new OAuthError(
          'temporarily_unavailable',
          'client registration capacity reached, try later',
          429,
        )
      }

      return getClient(clientId)
    }

    await app.close()
    app = await createApp(fixture(), {
      oauthPersistence: persistence,
    })
    const res = await app.inject({
      method: 'GET',
      url: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: 'https://client.example/metadata.json',
        redirect_uri: REDIRECT,
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'S256',
      },
    })

    expect(res.statusCode).toBe(429)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.headers.location).toBeUndefined()
    expect(res.body).toContain('client registration capacity reached')
  })
})

describe('the 401 challenge on /mcp', () => {
  it('an unauthenticated /mcp answers 401 with a WWW-Authenticate pointing at discovery', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toContain('resource_metadata=')
    expect(res.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource')
  })
})

describe('the full authorization-code + PKCE flow', () => {
  it('register → consent (session) → code → token mints an access + refresh token', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const tok = await fullFlow(cookie)
    expect(tok.token_type).toBe('Bearer')
    expect(tok.access_token).toMatch(/^nto_/)
    expect(tok.refresh_token).toMatch(/^ntr_/)
    expect(tok.expires_in).toBeGreaterThan(0)
    // The granted scope MUST echo what was requested (RFC 6749 §3.3) — a collapsed
    // echo ("write") reads to ChatGPT as a partial grant and loops re-auth (#96).
    expect(tok.scope).toBe('read write offline_access')
  })

  it('the issued token resolves to the owner principal at the REST chokepoint', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const tok = await fullFlow(cookie)
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${tok.access_token as string}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().username).toBe('alice')
  })

  it('the inline login path works (no prior session — username/password on the consent form)', async () => {
    const tok = await fullFlow('')
    expect(tok.access_token).toMatch(/^nto_/)
  })

  it('the inline login takes the e-mail as well as the handle', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const addressed = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { cookie },
      payload: { email: 'alice@example.com' },
    })
    expect(addressed.statusCode).toBe(200)
    const clientId = await registerClient()
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: FORM,
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'S256',
        decision: 'approve',
        identifier: ' Alice@Example.com ',
        password: 'alice-password-1',
      }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Signed in as <span class="client">alice</span>')
  })
})

describe('consent is session-only (#395)', () => {
  /** Mint alice's PAT the way the Settings UI does — the cred whose leak the invariant guards. */
  const mintPat = async (cookie: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie },
      payload: { name: 'leaked', scope: 'read' },
    })
    expect(res.statusCode).toBe(201)
    return res.json().token as string
  }

  /** The slice a leaked-cred holder can observe. `date` is excluded because inject
   *  stamps it from the wall clock at second granularity and the valid-cred side is
   *  slower (it hits the DB); `connection` is transport noise. Everything else —
   *  status, every remaining header, the exact payload — must not depend on whether
   *  the presented bearer is alive. */
  const comparable = (res: { statusCode: number; rawPayload: Buffer; headers: object }) => {
    const headers: Record<string, unknown> = { ...res.headers }
    delete headers.date
    delete headers.connection
    return { statusCode: res.statusCode, headers, payload: res.rawPayload.toString('utf8') }
  }

  it('a bearer cred cannot approve consent, and its validity is invisible (POST)', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const pat = await mintPat(cookie)
    const oauthTok = (await fullFlow(cookie)).access_token as string

    // Positive control: both creds ARE live at the REST chokepoint. Without this,
    // every expectation below stays green with the vertical unimplemented — a dead
    // cred cannot mint a code either.
    for (const bearer of [pat, oauthTok]) {
      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${bearer}` },
      })
      expect(me.statusCode).toBe(200)
    }

    const clientId = await registerClient()
    const { challenge } = makePkce()
    const attempt = (bearer: string) =>
      app.inject({
        method: 'POST',
        url: '/oauth/authorize',
        headers: { ...FORM, authorization: `Bearer ${bearer}` },
        payload: form({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT,
          scope: 'read write offline_access',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          all_spaces: 'on',
          decision: 'approve',
        }),
      })
    const viaPat = await attempt(pat)
    const viaOauth = await attempt(oauthTok)
    const viaGarbage = await attempt('ntp_deadbeef_nope')

    for (const res of [viaPat, viaOauth, viaGarbage]) {
      expect(res.statusCode).not.toBe(302)
      expect(res.headers.location).toBeUndefined()
      expect(res.headers['set-cookie']).toBeUndefined()
    }
    expect(comparable(viaPat)).toEqual(comparable(viaGarbage))
    expect(comparable(viaOauth)).toEqual(comparable(viaGarbage))
  })

  it('a bearer cred does not unlock the consent page — no owner name, no space list (GET)', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const pat = await mintPat(cookie)
    // Positive control (see the POST twin).
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { authorization: `Bearer ${pat}` },
        })
      ).statusCode,
    ).toBe(200)

    const clientId = await registerClient()
    const { challenge } = makePkce()
    const page = (bearer: string) =>
      app.inject({
        method: 'GET',
        url: `/oauth/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT,
          scope: 'read write offline_access',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString()}`,
        headers: { authorization: `Bearer ${bearer}` },
      })
    const viaPat = await page(pat)
    const viaGarbage = await page('ntp_deadbeef_nope')

    expect(viaPat.statusCode).toBe(200)
    expect(viaPat.body).not.toContain('Signed in as')
    expect(viaPat.body).not.toContain('name="space:')
    expect(comparable(viaPat)).toEqual(comparable(viaGarbage))
  })

  it('the inline two-step still narrows: the second POST picks alpha, the token cannot reach beta', async () => {
    const clientId = await registerClient()
    const { verifier, challenge } = makePkce()
    const base = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: 'read write offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      decision: 'approve',
    }
    const loginRes = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: FORM,
      payload: form({ ...base, identifier: 'alice', password: 'alice-password-1' }),
    })
    expect(loginRes.statusCode).toBe(200)
    expect(loginRes.body).toContain('name="space:alpha"') // consent re-rendered WITH the picker
    const cookie = (loginRes.headers['set-cookie'] as string).split(';')[0]

    const approve = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({ ...base, 'space:alpha': 'on' }),
    })
    expect(approve.statusCode).toBe(302)
    const code = new URL(approve.headers.location as string).searchParams.get('code') as string
    const tok = (
      await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: FORM,
        payload: form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }),
      })
    ).json()
    const auth = { authorization: `Bearer ${tok.access_token as string}` }
    expect(
      (await app.inject({ method: 'GET', url: '/api/s/alpha/notes', headers: auth })).statusCode,
    ).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: '/api/s/beta/notes', headers: auth })).statusCode,
    ).toBe(404)
  })

  it('a cross-origin cookie approve is rejected — the consent form shares the one CSRF guard', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { challenge } = makePkce()
    const approve = (extraHeaders: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/oauth/authorize',
        headers: { ...FORM, cookie, ...extraHeaders },
        payload: form({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          all_spaces: 'on',
          decision: 'approve',
        }),
      })
    // Foreign Origin → 403 HTML, no code minted (the second CSRF line on consent).
    const cross = await approve({ origin: 'https://evil.example' })
    expect(cross.statusCode).toBe(403)
    expect(cross.body).toContain('cross-origin request rejected')
    expect(cross.headers.location).toBeUndefined()
    // Control: the identical approve WITHOUT a foreign Origin still mints a code — the
    // guard blocks cross-site, not the normal flow.
    const ok = await approve({})
    expect(ok.statusCode).toBe(302)
    expect(new URL(ok.headers.location as string).searchParams.get('code')).toMatch(/^ntac_/)
  })
})

describe('PKCE + code safety', () => {
  it('a wrong code_verifier is rejected (invalid_grant)', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { challenge } = makePkce()
    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'approve',
        all_spaces: 'on',
      }),
    })
    const code = new URL(authz.headers.location as string).searchParams.get('code') as string
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: 'not-the-right-verifier',
      }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_grant')
  })

  it('a wrong verifier does NOT burn the code — a retry with the correct verifier succeeds', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { verifier, challenge } = makePkce()
    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'approve',
        all_spaces: 'on',
      }),
    })
    const code = new URL(authz.headers.location as string).searchParams.get('code') as string
    const bad = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: 'wrong',
      }),
    })
    expect(bad.statusCode).toBe(400)
    // The code survived the failed PKCE check — the correct verifier still works.
    const good = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }),
    })
    expect(good.statusCode).toBe(200)
    expect(good.json().access_token).toMatch(/^nto_/)
  })

  it('a code is single-use — the second exchange fails', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { verifier, challenge } = makePkce()
    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'approve',
        all_spaces: 'on',
      }),
    })
    const code = new URL(authz.headers.location as string).searchParams.get('code') as string
    const body = form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    })
    expect(
      (await app.inject({ method: 'POST', url: '/oauth/token', headers: FORM, payload: body }))
        .statusCode,
    ).toBe(200)
    const again = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: body,
    })
    expect(again.statusCode).toBe(400)
    expect(again.json().error).toBe('invalid_grant')
  })

  it('an unregistered redirect_uri is refused at /authorize (no redirect to it)', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { challenge } = makePkce()
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://evil.example.com/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'approve',
        all_spaces: 'on',
      }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('deny redirects back with error=access_denied (not a code)', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { challenge } = makePkce()
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'st',
        decision: 'deny',
      }),
    })
    expect(res.statusCode).toBe(302)
    const loc = new URL(res.headers.location as string)
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('code')).toBeNull()
    expect(loc.searchParams.get('state')).toBe('st')
  })
})

describe('refresh + revoke', () => {
  it('a refresh token mints a fresh access token; the old refresh cannot be replayed', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { verifier, challenge } = makePkce()
    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: 'read write offline_access',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'approve',
        all_spaces: 'on',
      }),
    })
    const code = new URL(authz.headers.location as string).searchParams.get('code') as string
    const first = (
      await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: FORM,
        payload: form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }),
      })
    ).json()
    const refresh = first.refresh_token as string
    const refreshed = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json().access_token).toMatch(/^nto_/)
    // The old refresh is now rotated — a replay fails.
    const replay = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
    })
    expect(replay.statusCode).toBe(400)
  })

  it('revoking an access token disconnects it from the chokepoint', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const tok = await fullFlow(cookie)
    const bearer = tok.access_token as string
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { authorization: `Bearer ${bearer}` },
        })
      ).statusCode,
    ).toBe(200)
    const revoke = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: FORM,
      payload: form({ token: bearer }),
    })
    expect(revoke.statusCode).toBe(200)
    const after = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(after.statusCode).toBe(401)
  })
})

describe('connected apps (#96)', () => {
  /** Run a flow and return the client id + the access + refresh tokens + cookie.
   *  `scope` defaults to a full write grant; pass 'read offline_access' for a
   *  read-only connection (the #162 raise test). */
  const connect = async (
    scope = 'read write offline_access',
  ): Promise<{ clientId: string; access: string; refresh: string; cookie: string }> => {
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { verifier, challenge } = makePkce()
    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'approve',
        all_spaces: 'on',
      }),
    })
    const code = new URL(authz.headers.location as string).searchParams.get('code') as string
    const tok = (
      await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: FORM,
        payload: form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }),
      })
    ).json()
    return {
      clientId,
      access: tok.access_token as string,
      refresh: tok.refresh_token as string,
      cookie,
    }
  }

  /** A write through the OAuth bearer — 200 with a write ceiling, 404 with read. */
  const writeAlpha = (bearer: string) =>
    app.inject({
      method: 'POST',
      url: '/api/s/alpha/notes',
      headers: { authorization: `Bearer ${bearer}` },
      payload: { title: 'Via OAuth', content: 'x' },
    })
  const setScope = (clientId: string, cookie: string, scope: 'read' | 'write') =>
    app.inject({
      method: 'PATCH',
      url: `/api/me/connections/${encodeURIComponent(clientId)}`,
      headers: { cookie },
      payload: { scope }, // object payload → inject sends application/json
    })

  it('lists a connected app (one row per app) the session owner can see', async () => {
    const { clientId, cookie } = await connect()
    const res = await app.inject({ method: 'GET', url: '/api/me/connections', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const conns = res.json().connections as Array<{ id: string; appName: string; scope: string }>
    expect(conns).toHaveLength(1)
    expect(conns[0]).toMatchObject({ id: clientId, appName: 'Claude', scope: 'write' })
  })

  it('revoking a connection kills its token and clears it from the list', async () => {
    const { clientId, access, cookie } = await connect()
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { authorization: `Bearer ${access}` },
        })
      ).statusCode,
    ).toBe(200)
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/me/connections/${encodeURIComponent(clientId)}`,
      headers: { cookie },
    })
    expect(del.statusCode).toBe(200)
    // The token no longer authenticates, and the app is gone from the list.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { authorization: `Bearer ${access}` },
        })
      ).statusCode,
    ).toBe(401)
    const after = await app.inject({
      method: 'GET',
      url: '/api/me/connections',
      headers: { cookie },
    })
    expect(after.json().connections).toHaveLength(0)
  })

  it('a connector token (bearer, scope write) cannot manage connections — 404 (session-only)', async () => {
    const { access } = await connect()
    // self:manage sits above write — the OAuth token gets the anti-enumeration 404.
    const res = await app.inject({
      method: 'GET',
      url: '/api/me/connections',
      headers: { authorization: `Bearer ${access}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('keeps provider credential inventory session-only for an OAuth connector', async () => {
    const { access, cookie } = await connect()
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers/credentials',
      headers: { cookie },
      payload: {
        name: 'OAuth-hidden',
        kind: 'bearer',
        secret: 'oauth-hidden-secret',
        origin: 'https://provider.example',
      },
    })
    expect(created.statusCode).toBe(200)
    const id = created.json().credential.id as string

    const listed = await app.inject({
      method: 'GET',
      url: '/api/providers/credentials',
      headers: { authorization: `Bearer ${access}` },
    })
    const detail = await app.inject({
      method: 'GET',
      url: `/api/providers/credentials/${id}`,
      headers: { authorization: `Bearer ${access}` },
    })
    expect(listed.statusCode).toBe(404)
    expect(detail.statusCode).toBe(404)
  })

  it('Disconnect revokes the REFRESH token too — the app cannot mint a fresh access token', async () => {
    const { clientId, refresh, cookie } = await connect()
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/me/connections/${encodeURIComponent(clientId)}`,
      headers: { cookie },
    })
    expect(del.statusCode).toBe(200)
    // The refresh grant must now fail — otherwise "Disconnect" leaves the app able to reconnect.
    const refreshed = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
    })
    expect(refreshed.statusCode).toBe(400)
    expect(refreshed.json().error).toBe('invalid_grant')
  })

  it('lowering a connection write→read closes its live token immediately (no re-consent)', async () => {
    const { clientId, access, cookie } = await connect()
    expect((await writeAlpha(access)).statusCode).toBe(200) // write grant works
    expect((await setScope(clientId, cookie, 'read')).statusCode).toBe(200)
    // SAME access token, now read-only — the change is live (principal re-derived per request).
    expect((await writeAlpha(access)).statusCode).toBe(404)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { authorization: `Bearer ${access}` },
        })
      ).statusCode,
    ).toBe(200)
    // …and the listing reflects the new level.
    const conns = (
      await app.inject({ method: 'GET', url: '/api/me/connections', headers: { cookie } })
    ).json().connections
    expect(conns[0].scope).toBe('read')
  })

  it('raising a connection read→write grants write to the live token without re-consent', async () => {
    const { clientId, access, cookie } = await connect('read offline_access')
    expect((await writeAlpha(access)).statusCode).toBe(404) // read grant can't write
    expect((await setScope(clientId, cookie, 'write')).statusCode).toBe(200)
    expect((await writeAlpha(access)).statusCode).toBe(200) // same token, now writes
  })

  it('the level change survives the hourly refresh rotation (patched on access AND refresh)', async () => {
    const { clientId, refresh, cookie } = await connect()
    expect((await setScope(clientId, cookie, 'read')).statusCode).toBe(200)
    // Rotate: a refresh mints the next family from the refresh row's scope — if only
    // access were patched, the new token would revert to write within the hour.
    const refreshed = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json().scope).toBe('read offline_access')
    const fresh = refreshed.json().access_token as string
    expect((await writeAlpha(fresh)).statusCode).toBe(404) // the rotated token is read-only too
  })

  it('only the session owner can change a connection — a connector token cannot (404)', async () => {
    const { clientId, access } = await connect()
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/me/connections/${encodeURIComponent(clientId)}`,
      headers: { authorization: `Bearer ${access}` },
      payload: { scope: 'read' },
    })
    expect(res.statusCode).toBe(404) // self:manage is session-only
  })
})

describe('per-space narrowing (#181)', () => {
  /** Consent → code → token with arbitrary extra form fields (the space picker:
   *  `all_spaces` and/or `space:<slug>` checkboxes). Signed-in (one-step). */
  const connectWith = async (
    extra: Record<string, string>,
  ): Promise<{ clientId: string; access: string; refresh: string; cookie: string }> => {
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { verifier, challenge } = makePkce()
    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: 'read write offline_access',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'approve',
        ...extra,
      }),
    })
    const code = new URL(authz.headers.location as string).searchParams.get('code') as string
    const tok = (
      await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: FORM,
        payload: form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }),
      })
    ).json()
    return {
      clientId,
      access: tok.access_token as string,
      refresh: tok.refresh_token as string,
      cookie,
    }
  }

  /** A write through the OAuth bearer to a space — 200 when the space is in reach,
   *  404 (anti-enumeration) when the narrowing excludes it. Each probe writes its OWN
   *  note: this asks whether the token reaches the space, and a repeat title would
   *  answer 409 (the create-collision refusal) about something else entirely. */
  let probe = 0
  const writeSpace = (bearer: string, slug: string) =>
    app.inject({
      method: 'POST',
      url: `/api/s/${slug}/notes`,
      headers: { authorization: `Bearer ${bearer}` },
      payload: { title: `Via OAuth ${++probe}`, content: 'x' },
    })

  const patchConn = (clientId: string, cookie: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/me/connections/${encodeURIComponent(clientId)}`,
      headers: { cookie },
      payload: body, // object → application/json
    })

  const connsOf = async (cookie: string) =>
    (await app.inject({ method: 'GET', url: '/api/me/connections', headers: { cookie } })).json()
      .connections as Array<{ id: string; scope: string; spaces: string[] | null }>

  it('a consent narrowed to alpha cannot reach beta — the token is scoped at issue', async () => {
    const { access } = await connectWith({ 'space:alpha': 'on' })
    expect((await writeSpace(access, 'alpha')).statusCode).toBe(200)
    expect((await writeSpace(access, 'beta')).statusCode).toBe(404) // narrowed out
  })

  it('the default consent (All spaces) reaches every grant', async () => {
    const { access } = await connectWith({ all_spaces: 'on' })
    expect((await writeSpace(access, 'alpha')).statusCode).toBe(200)
    expect((await writeSpace(access, 'beta')).statusCode).toBe(200)
  })

  it('the narrowing is listed as slugs (All spaces → null)', async () => {
    const narrowed = await connectWith({ 'space:alpha': 'on' })
    expect((await connsOf(narrowed.cookie))[0].spaces).toEqual(['alpha'])
    const all = await connectWith({ all_spaces: 'on' })
    // A second client → its own row; find it by id (newest first ordering aside).
    expect((await connsOf(all.cookie)).find((c) => c.id === all.clientId)?.spaces).toBeNull()
  })

  it('the narrowing survives the hourly refresh rotation (stored on the refresh row)', async () => {
    const { clientId, refresh } = await connectWith({ 'space:alpha': 'on' })
    const refreshed = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
    })
    expect(refreshed.statusCode).toBe(200)
    const fresh = refreshed.json().access_token as string
    expect((await writeSpace(fresh, 'alpha')).statusCode).toBe(200)
    expect((await writeSpace(fresh, 'beta')).statusCode).toBe(404) // still narrowed after rotation
  })

  it('narrowing a live all-spaces connection to alpha takes effect immediately, and widening restores beta', async () => {
    const { clientId, access, cookie } = await connectWith({ all_spaces: 'on' })
    expect((await writeSpace(access, 'beta')).statusCode).toBe(200) // reaches beta at first
    // Narrow via Settings (PATCH) — same token, effective next request.
    expect((await patchConn(clientId, cookie, { spaces: ['alpha'] })).statusCode).toBe(200)
    expect((await writeSpace(access, 'beta')).statusCode).toBe(404)
    expect((await writeSpace(access, 'alpha')).statusCode).toBe(200)
    expect((await connsOf(cookie))[0].spaces).toEqual(['alpha'])
    // Widen back to all — beta is reachable again.
    expect((await patchConn(clientId, cookie, { spaces: null })).statusCode).toBe(200)
    expect((await writeSpace(access, 'beta')).statusCode).toBe(200)
    expect((await connsOf(cookie))[0].spaces).toBeNull()
  })

  it('a Settings PATCH narrowing persists onto the refresh row — the rotation does not widen back', async () => {
    // Start all-spaces, narrow via Settings, THEN rotate: the new family is minted from
    // the refresh row, so the PATCH must have narrowed THAT too (a regression dropping
    // spaces from the refresh loop would let beta back in after the hourly rotation).
    const { clientId, refresh, cookie } = await connectWith({ all_spaces: 'on' })
    expect((await patchConn(clientId, cookie, { spaces: ['alpha'] })).statusCode).toBe(200)
    const refreshed = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
    })
    expect(refreshed.statusCode).toBe(200)
    const fresh = refreshed.json().access_token as string
    expect((await writeSpace(fresh, 'alpha')).statusCode).toBe(200)
    expect((await writeSpace(fresh, 'beta')).statusCode).toBe(404) // the PATCH-narrowing rode the rotation
  })

  it('a PATCH narrowing to a space the owner is not a member of is refused (400)', async () => {
    const { clientId, cookie } = await connectWith({ all_spaces: 'on' })
    const res = await patchConn(clientId, cookie, { spaces: ['ghost'] })
    expect(res.statusCode).toBe(400) // bad_space — never a member
  })

  it('an empty PATCH {} is a 200 no-op — leaves the narrowing untouched', async () => {
    const { clientId, cookie } = await connectWith({ 'space:alpha': 'on' })
    const res = await patchConn(clientId, cookie, {})
    expect(res.statusCode).toBe(200)
    expect((await connsOf(cookie))[0].spaces).toEqual(['alpha']) // unchanged, no widen/reset
  })

  it('unticking All without picking any space is refused at consent (no dead-zero connector)', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { challenge } = makePkce()
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'approve',
        // neither all_spaces nor any space:<slug>
      }),
    })
    // Re-rendered consent (200 HTML) with the guard message — NOT a redirect/code.
    expect(res.statusCode).toBe(200)
    expect(res.headers.location).toBeUndefined()
    expect(res.body).toContain('at least one space')
  })

  it('a signed-in owner with NO space grants still completes consent (fail-open to all, no dead-end)', async () => {
    // bob has no memberships → the consent page renders no picker; approve must still
    // mint a code (spaces=null=all grants, the pre-#181 behaviour), never trap them.
    const cookie = await login('bob', 'bob-password-1')
    const clientId = await registerClient()
    const { verifier, challenge } = makePkce()
    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'approve',
        // no all_spaces, no space:* — bob's rendered form carried no picker to submit
      }),
    })
    expect(authz.statusCode).toBe(302) // a code, not a re-rendered "pick a space" error
    const code = new URL(authz.headers.location as string).searchParams.get('code') as string
    expect(code).toMatch(/^ntac_/)
    const tok = (
      await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: FORM,
        payload: form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }),
      })
    ).json()
    expect(tok.access_token).toMatch(/^nto_/)
    const conns = (
      await app.inject({ method: 'GET', url: '/api/me/connections', headers: { cookie } })
    ).json().connections
    expect(conns[0].spaces).toBeNull() // all grants (currently none), not a narrowing
  })

  it('a narrowed token echoes only the OAuth scope — spaces stay orthogonal (RFC 6749 §3.3)', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const clientId = await registerClient()
    const { verifier, challenge } = makePkce()
    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...FORM, cookie },
      payload: form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: 'read offline_access',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'approve',
        'space:alpha': 'on', // narrowed to alpha, NOT all
      }),
    })
    const code = new URL(authz.headers.location as string).searchParams.get('code') as string
    const tok = (
      await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: FORM,
        payload: form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }),
      })
    ).json()
    // The granted-scope echo carries the OAuth scope ONLY — the space narrowing is our
    // axis, never leaked into the RFC 6749 §3.3 scope string (a leak would make ChatGPT
    // misread the grant). Same on the refresh rotation's echo.
    expect(tok.scope).toBe('read offline_access')
    expect(tok.scope).not.toMatch(/alpha|space/)
    const refreshed = (
      await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: FORM,
        payload: form({
          grant_type: 'refresh_token',
          refresh_token: tok.refresh_token as string,
          client_id: clientId,
        }),
      })
    ).json()
    expect(refreshed.scope).toBe('read offline_access')
  })
})

describe('none-mode: no facade', () => {
  it('a none-mode host (no auth fixture) does not serve discovery', async () => {
    const noneApp = await createApp({
      now: '2026-06-20T12:00:00.000Z',
      spaces: [{ slug: 'main', notes: [] }],
    })
    const res = await noneApp.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    })
    // No facade wired → the route doesn't exist (SPA fallback / 404), never a doc.
    expect(res.statusCode).not.toBe(200)
    await noneApp.close()
  })
})
