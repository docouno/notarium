export const AUTH_MODE = {
  none: 'none',
  password: 'password',
} as const

/** The handle alphabet and its ceiling, kept here — beside the enums, away from zod —
 *  so a browser surface can refuse exactly what the route refuses without pulling the
 *  schema barrel (and zod with it) into its chunk. `UsernameSchema` is built from these,
 *  so there is one alphabet, not a copy: lowercase alphanumerics, with dots, underscores
 *  and dashes allowed only inside. */
export const USERNAME_MAX = 32
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/
export const USERNAME_RULE = 'lowercase alphanumeric with inner dots, underscores and dashes'

export const isUsername = (value: string): boolean =>
  value.length > 0 && value.length <= USERNAME_MAX && USERNAME_PATTERN.test(value)

export const SPACE_ROLE = {
  owner: 'owner',
  writer: 'writer',
  reader: 'reader',
} as const

export const TOKEN_PURPOSE = {
  invite: 'invite',
  reset: 'reset',
} as const

export type AuthMode = (typeof AUTH_MODE)[keyof typeof AUTH_MODE]
export type SpaceRole = (typeof SPACE_ROLE)[keyof typeof SPACE_ROLE]
export type TokenPurpose = (typeof TOKEN_PURPOSE)[keyof typeof TOKEN_PURPOSE]
