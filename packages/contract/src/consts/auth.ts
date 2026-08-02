export const AUTH_MODE = {
  none: 'none',
  password: 'password',
} as const

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
