import type {
  CredentialCreateRequest,
  CredentialPatchRequest,
  CredentialResponse,
  CredentialsResponse,
  ProviderInventoryQueryInput,
  ProviderRetargetRequest,
  ProviderRetargetResponse,
} from '@notarium/contract'
import { req } from './client'
import { providerInventoryQuery } from './providerPagination'

const credentialPath = (id: string) => `/api/providers/credentials/${encodeURIComponent(id)}`

export const credentialsApi = {
  credentialsGet: (query: ProviderInventoryQueryInput = {}) =>
    req<CredentialsResponse>(`/api/providers/credentials${providerInventoryQuery(query)}`),
  credentialGet: (id: string) => req<CredentialResponse>(credentialPath(id)),
  credentialCreate: (input: CredentialCreateRequest) =>
    req<CredentialResponse>('/api/providers/credentials', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  credentialPatch: (id: string, input: CredentialPatchRequest) =>
    req<CredentialResponse>(credentialPath(id), {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  credentialDelete: (id: string) => req<{ ok: true }>(credentialPath(id), { method: 'DELETE' }),
  credentialRetarget: (id: string, input: ProviderRetargetRequest) =>
    req<ProviderRetargetResponse>(`${credentialPath(id)}/retarget`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
}
