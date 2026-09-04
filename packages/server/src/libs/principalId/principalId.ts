// The one producer and the one parser of the journal attribution string — the
// principal id: `user:<id>` for a human session, `pat:<id>:<patId>` for a personal
// access token, `oauth:<id>:<tokenId>` for a connected app. `<id>` is the stable user
// id (16 hex characters), never the username: a rename must not change how history,
// favorites, jobs and live-socket matching address the same person. The `ui` literal
// of AUTH_MODE=none is a constant the callers own, not a form built here.
//
// Nothing else concatenates a scheme with an owner. Every place that compares a
// principal id for equality (revoke = disconnect, favorites, job ownership) goes
// through these builders, so one drift here would break them all together instead of
// silently only some.
// canon: docs/auth.md#model

export const PRINCIPAL_SCHEME = {
  user: 'user',
  pat: 'pat',
  oauth: 'oauth',
} as const

export type PrincipalScheme = (typeof PRINCIPAL_SCHEME)[keyof typeof PRINCIPAL_SCHEME]

/** A parsed principal id. `keyId` is the credential id of an agent scheme and null for
 *  a human session; the user id is whatever sits in the second segment, resolved by
 *  the caller — an unknown id renders as an anonymous author, never as an error. */
export type ParsedPrincipal = {
  scheme: PrincipalScheme
  userId: string
  keyId: string | null
}

export const userPrincipalId = (userId: string): string => `${PRINCIPAL_SCHEME.user}:${userId}`

export const patPrincipalId = (userId: string, patId: string): string =>
  `${PRINCIPAL_SCHEME.pat}:${userId}:${patId}`

export const oauthPrincipalId = (userId: string, tokenId: string): string =>
  `${PRINCIPAL_SCHEME.oauth}:${userId}:${tokenId}`

/** The `principal LIKE '<prefix>%'` prefixes that select every agent credential of one
 *  owner, revoked ones included. The id alphabet is hex, so a prefix never carries a
 *  LIKE metacharacter and the drivers need no ESCAPE clause. */
export const agentPrincipalPrefixes = (userId: string): string[] => [
  `${PRINCIPAL_SCHEME.pat}:${userId}:`,
  `${PRINCIPAL_SCHEME.oauth}:${userId}:`,
]

/** Split a principal id into scheme, user id and credential id. Null for the `ui`
 *  literal, an unknown scheme, or a malformed agent id — the callers treat every one
 *  of those as "not a person we can name". The credential id is everything after the
 *  second colon, so a key id may itself contain colons. */
export const parsePrincipalId = (principal: string): ParsedPrincipal | null => {
  const first = principal.indexOf(':')

  if (first === -1) {
    return null
  }
  const scheme = principal.slice(0, first)
  const rest = principal.slice(first + 1)

  if (scheme === PRINCIPAL_SCHEME.user) {
    return rest ? { scheme, userId: rest, keyId: null } : null
  }
  if (scheme !== PRINCIPAL_SCHEME.pat && scheme !== PRINCIPAL_SCHEME.oauth) {
    return null
  }
  const second = rest.indexOf(':')

  if (second === -1) {
    return null
  }
  const userId = rest.slice(0, second)
  const keyId = rest.slice(second + 1)

  return userId && keyId ? { scheme, userId, keyId } : null
}
