import type { UnreadableSecretPlan } from '../credentialKeyring'
import type {
  CredentialRecord,
  ProviderCiphertextCarrier,
  ProviderCiphertextCounts,
  ProviderResourceRecord,
} from './types'

export type ProviderCredentialCiphertexts = Pick<CredentialRecord, 'id' | 'owner' | 'secret'>
export type ProviderResourceCiphertexts = Pick<
  ProviderResourceRecord,
  'id' | 'owner' | 'credentialId' | 'headers'
>

export const providerCiphertextKeyId = (ciphertext: string): string | null =>
  /^v1\.(ck_[0-9a-f]{24})\./.exec(ciphertext)?.[1] ?? null

export const providerUnreadablePlan = (
  credentials: readonly ProviderCredentialCiphertexts[],
  resources: readonly ProviderResourceCiphertexts[],
  readableKeyIds: ReadonlySet<string>,
): UnreadableSecretPlan => {
  const affected: UnreadableSecretPlan['affected'] = []
  const resourceIdsByCredential = new Map<string, string[]>()

  for (const resource of resources) {
    const credentialId = resource.credentialId

    if (credentialId === null) {
      continue
    }
    const ids = resourceIdsByCredential.get(credentialId)

    if (ids) {
      ids.push(resource.id)
    } else {
      resourceIdsByCredential.set(credentialId, [resource.id])
    }
  }

  for (const credential of credentials) {
    const keyId = providerCiphertextKeyId(credential.secret)

    if (!keyId || !readableKeyIds.has(keyId)) {
      affected.push({
        kind: 'credential',
        owner: credential.owner,
        recordId: credential.id,
        disabledResourceIds: [...(resourceIdsByCredential.get(credential.id) ?? [])],
      })
    }
  }
  for (const resource of resources) {
    if (
      Object.values(resource.headers).some((value) => {
        const keyId = providerCiphertextKeyId(value)
        return !keyId || !readableKeyIds.has(keyId)
      })
    ) {
      affected.push({
        kind: 'header',
        owner: resource.owner,
        recordId: resource.id,
        disabledResourceIds: [resource.id],
      })
    }
  }

  return { affected }
}

export const readableProviderHeaders = (
  resource: ProviderResourceCiphertexts,
  readableKeyIds: ReadonlySet<string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(resource.headers).filter(([, value]) => {
      const keyId = providerCiphertextKeyId(value)
      return keyId != null && readableKeyIds.has(keyId)
    }),
  )

export const providerCiphertextCounts = (
  credentials: readonly ProviderCredentialCiphertexts[],
  resources: readonly ProviderResourceCiphertexts[],
  keyIds: ReadonlySet<string>,
): ProviderCiphertextCounts => ({
  credentials: credentials.filter((credential) =>
    keyIds.has(providerCiphertextKeyId(credential.secret) ?? ''),
  ).length,
  headers: resources.reduce(
    (count, resource) =>
      count +
      Object.values(resource.headers).filter((value) =>
        keyIds.has(providerCiphertextKeyId(value) ?? ''),
      ).length,
    0,
  ),
})

export const providerCiphertextBatch = (
  credentials: readonly ProviderCredentialCiphertexts[],
  resources: readonly ProviderResourceCiphertexts[],
  sourceKeyIds: ReadonlySet<string>,
  limit: number,
): ProviderCiphertextCarrier[] => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('provider ciphertext batch limit must be a positive safe integer')
  }
  const carriers: ProviderCiphertextCarrier[] = []

  for (const credential of credentials) {
    if (sourceKeyIds.has(providerCiphertextKeyId(credential.secret) ?? '')) {
      carriers.push({
        kind: 'credential',
        recordId: credential.id,
        field: 'secret',
        ciphertext: credential.secret,
      })
    }
    if (carriers.length === limit) {
      return carriers
    }
  }
  for (const resource of resources) {
    for (const [field, ciphertext] of Object.entries(resource.headers).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (sourceKeyIds.has(providerCiphertextKeyId(ciphertext) ?? '')) {
        carriers.push({ kind: 'header', recordId: resource.id, field, ciphertext })
      }
      if (carriers.length === limit) {
        return carriers
      }
    }
  }

  return carriers
}
