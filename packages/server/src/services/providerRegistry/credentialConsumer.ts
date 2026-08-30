import {
  CREDENTIAL_REFERENCE_KIND,
  type CredentialReference,
  DEFAULT_CREDENTIAL_HEADER,
} from '@notarium/contract'

import type {
  CredentialDeleteResult,
  CredentialMutationInput,
  CredentialMutationResult,
  CredentialRecord,
  CredentialsPersistence,
  ProviderResourceRecord,
} from '../metaDb'

export type CredentialConsumer = {
  references(credentialId: string): Promise<CredentialReference[]>
  mutate(
    input: Omit<CredentialMutationInput, 'validateReferences'>,
  ): Promise<CredentialMutationResult>
  deleteIfUnreferenced(credentialId: string): Promise<CredentialDeleteResult>
}

const referenceOf = (resource: ProviderResourceRecord): CredentialReference => ({
  kind: CREDENTIAL_REFERENCE_KIND.providerResource,
  id: resource.id,
  name: resource.name,
})

const invalidReferenceIds = (
  credential: CredentialRecord,
  references: readonly ProviderResourceRecord[],
): string[] =>
  references
    .filter((resource) => {
      const injectionHeader =
        credential.injection.header || DEFAULT_CREDENTIAL_HEADER[credential.kind][resource.wire]
      return (
        new URL(resource.baseUrl).origin !== credential.origin ||
        Object.hasOwn(resource.headers, injectionHeader)
      )
    })
    .map((resource) => resource.id)

export const providerResourceCredentialConsumer = (
  credentials: CredentialsPersistence,
): CredentialConsumer => ({
  references: async (credentialId) => (await credentials.references(credentialId)).map(referenceOf),
  mutate: (input) => credentials.mutate({ ...input, validateReferences: invalidReferenceIds }),
  deleteIfUnreferenced: (credentialId) => credentials.deleteIfUnreferenced(credentialId),
})

export const credentialReferencesOf = (
  records: readonly ProviderResourceRecord[],
): CredentialReference[] => records.map(referenceOf)
