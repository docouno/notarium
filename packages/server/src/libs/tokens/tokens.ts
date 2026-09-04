// Credential token formats: high-entropy random secrets with a greppable prefix,
// stored as sha-256 hashes at rest — a meta-DB leak never leaks a live credential,
// and a 256-bit-entropy secret needs no slow hash.
// canon: docs/auth.md#credentials

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Constant-time compare of two hex digests. Both sides are fixed-length sha-256
 *  hex, so the length guard never branches on a secret. */
export const timingSafeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false
  }

  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/** The stable user id: 16 hex characters, minted once per account and never changed.
 *  Hex on purpose — the id travels inside the principal id, which the journal filters
 *  by `LIKE '<prefix>%'` without an ESCAPE clause, so the alphabet must carry no `_`
 *  or `%`; a username (which now admits `_`) never enters such a pattern. The carrier
 *  that backfilled existing accounts mints the same shape in SQL.
 *  canon: docs/auth.md#model */
export const mintUserId = (): string => randomBytes(8).toString('hex')

export const mintSessionToken = (): string => `nts_${randomBytes(32).toString('hex')}`

export const mintOneTimeToken = (): string => `nti_${randomBytes(24).toString('hex')}`

export const mintPatToken = (): { id: string; secret: string; token: string } => {
  const id = randomBytes(6).toString('hex')
  const secret = randomBytes(24).toString('hex')
  return { id, secret, token: `ntp_${id}_${secret}` }
}

export const parsePatToken = (raw: string): { id: string; secret: string } | null => {
  const m = /^ntp_([0-9a-f]{12})_([0-9a-f]{48})$/.exec(raw)
  return m ? { id: m[1], secret: m[2] } : null
}

export const isSessionToken = (raw: string): boolean => /^nts_[0-9a-f]{64}$/.test(raw)

export const isOneTimeToken = (raw: string): boolean => /^nti_[0-9a-f]{48}$/.test(raw)

// ── OAuth tokens ───────────────────────────────────────────────────────
// Access/refresh tokens reuse the PAT id+secret shape, so the same constant-time
// hash-compare lookup validates all three; the prefix only routes to the right
// store. canon: docs/mcp-oauth.md#token-identity

export const mintOAuthAccessToken = (): { id: string; secret: string; token: string } => {
  const id = randomBytes(6).toString('hex')
  const secret = randomBytes(24).toString('hex')
  return { id, secret, token: `nto_${id}_${secret}` }
}

export const mintOAuthRefreshToken = (): { id: string; secret: string; token: string } => {
  const id = randomBytes(6).toString('hex')
  const secret = randomBytes(24).toString('hex')
  return { id, secret, token: `ntr_${id}_${secret}` }
}

export const mintOAuthCode = (): string => `ntac_${randomBytes(24).toString('hex')}`

export const parseOAuthAccessToken = (raw: string): { id: string; secret: string } | null => {
  const m = /^nto_([0-9a-f]{12})_([0-9a-f]{48})$/.exec(raw)
  return m ? { id: m[1], secret: m[2] } : null
}

export const parseOAuthRefreshToken = (raw: string): { id: string; secret: string } | null => {
  const m = /^ntr_([0-9a-f]{12})_([0-9a-f]{48})$/.exec(raw)
  return m ? { id: m[1], secret: m[2] } : null
}

export const isOAuthCode = (raw: string): boolean => /^ntac_[0-9a-f]{48}$/.test(raw)

/** PKCE S256 verification (RFC 7636): base64url(SHA256(verifier)), no padding.
 *  We implement S256 only — Claude/ChatGPT always send `code_challenge_method=S256`. */
export const pkceS256 = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url')
