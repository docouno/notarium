// Unit pack for #96's pure pieces: the PKCE S256 transform (against the RFC 7636
// test vector), the OAuth token formats (mint/parse round-trips + rejection of
// foreign shapes), and the CIMD fetcher's SSRF guard (http / loopback / private
// targets are refused BEFORE any network call). The full flow (discovery →
// authorize → token → refresh → revoke) is the fake-server contract test.

import { describe, expect, it } from 'vitest'

import {
  fetchClientMetadataDocument,
  isOAuthCode,
  mintOAuthAccessToken,
  mintOAuthCode,
  mintOAuthRefreshToken,
  parseOAuthAccessToken,
  parseOAuthRefreshToken,
  pkceS256,
} from '@notarium/server'

describe('PKCE S256 (RFC 7636)', () => {
  it('matches the RFC 7636 Appendix B test vector', () => {
    // verifier → base64url(SHA-256(verifier)), no padding.
    expect(pkceS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })
  it('is deterministic and padding-free (base64url)', () => {
    const c = pkceS256('a-random-verifier-string-1234567890')
    expect(c).toBe(pkceS256('a-random-verifier-string-1234567890'))
    expect(c).not.toContain('=')
    expect(c).not.toContain('+')
    expect(c).not.toContain('/')
  })
})

describe('OAuth token formats (#96)', () => {
  it('access token round-trips id+secret and is distinguishable from a PAT', () => {
    const { id, secret, token } = mintOAuthAccessToken()
    expect(token).toBe(`nto_${id}_${secret}`)
    expect(parseOAuthAccessToken(token)).toEqual({ id, secret })
    // A PAT (ntp_) or refresh (ntr_) is not an access token.
    expect(parseOAuthAccessToken(`ntp_${id}_${secret}`)).toBeNull()
    expect(parseOAuthAccessToken('garbage')).toBeNull()
  })
  it('refresh token round-trips and rejects foreign shapes', () => {
    const { id, secret, token } = mintOAuthRefreshToken()
    expect(token).toBe(`ntr_${id}_${secret}`)
    expect(parseOAuthRefreshToken(token)).toEqual({ id, secret })
    expect(parseOAuthRefreshToken(`nto_${id}_${secret}`)).toBeNull()
  })
  it('authorization code is recognisable and high-entropy', () => {
    const code = mintOAuthCode()
    expect(isOAuthCode(code)).toBe(true)
    expect(code).toMatch(/^ntac_[0-9a-f]{48}$/)
    expect(isOAuthCode('ntac_short')).toBe(false)
    expect(isOAuthCode(mintOAuthAccessToken().token)).toBe(false)
  })
})

describe('CIMD fetcher SSRF guard (#96)', () => {
  it('refuses a non-https client metadata URL', async () => {
    await expect(fetchClientMetadataDocument('http://example.com/client.json')).rejects.toThrow(
      /https/,
    )
  })
  it('refuses localhost and loopback/private literal targets', async () => {
    for (const url of [
      'https://localhost/client.json',
      'https://127.0.0.1/client.json',
      'https://10.0.0.5/client.json',
      'https://192.168.1.1/client.json',
      'https://169.254.169.254/client.json', // cloud metadata
      'https://[::1]/client.json',
    ]) {
      await expect(fetchClientMetadataDocument(url), url).rejects.toThrow(/not allowed/)
    }
  })
  it('refuses IPv6-smuggled private v4 (mapped hex, IPv4-compatible, NAT64)', async () => {
    for (const url of [
      'https://[::ffff:7f00:1]/c.json', // ::ffff:127.0.0.1 in hex form
      'https://[::ffff:a9fe:a9fe]/c.json', // ::ffff:169.254.169.254 (metadata)
      'https://[::ffff:127.0.0.1]/c.json', // dotted mapped form
      'https://[::127.0.0.1]/c.json', // IPv4-compatible
      'https://[64:ff9b::7f00:1]/c.json', // NAT64 of 127.0.0.1
    ]) {
      await expect(fetchClientMetadataDocument(url), url).rejects.toThrow(/not allowed/)
    }
  })
  it('refuses a non-URL client_id', async () => {
    await expect(fetchClientMetadataDocument('not a url')).rejects.toThrow()
  })
})
