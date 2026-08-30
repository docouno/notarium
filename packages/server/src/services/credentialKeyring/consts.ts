export const CREDENTIAL_KEY_STATE = {
  active: 'active',
  readable: 'readable',
} as const

export type CredentialKeyState = (typeof CREDENTIAL_KEY_STATE)[keyof typeof CREDENTIAL_KEY_STATE]

export const SECRET_FACET = {
  credential: 'credential',
  resource: 'resource',
  keyring: 'keyring',
} as const

export type SecretFacet = (typeof SECRET_FACET)[keyof typeof SECRET_FACET]
