import type { CredentialKeyringStatus } from '@notarium/contract'

export type CredentialKeyringDiagnostic = {
  status: CredentialKeyringStatus
}

export type UnreadableSecretImpact = {
  kind: 'credential' | 'header'
  owner: string
  recordId: string
  disabledResourceIds: string[]
}

export type UnreadableSecretPlan = {
  affected: UnreadableSecretImpact[]
}
