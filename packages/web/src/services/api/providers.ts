import type {
  ProviderEffectiveEntry,
  ProviderEffectiveResponse,
  ProviderInventoryQueryInput,
  ProviderResourceCreateRequest,
  ProviderResourcePatchRequest,
  ProviderResourceResponse,
  ProviderResourcesResponse,
  ProviderResourceStatusesResponse,
  ProviderValidateRequest,
  ProviderValidateResponse,
} from '@notarium/contract'
import { req } from './client'
import { providerInventoryQuery } from './providerPagination'

const resourcePath = (id: string) => `/api/providers/resources/${encodeURIComponent(id)}`

const effectivePage = (query: ProviderInventoryQueryInput = {}) =>
  req<ProviderEffectiveResponse>(`/api/providers/effective${providerInventoryQuery(query)}`)

/** One exact post-mutation usability read. The server applies the same principal
 * effective-list semantics and anti-enumeration as the inventory without walking
 * cursor pages or resetting the page the user already loaded. */
const providerEffectiveDetail = (id: string): Promise<ProviderEffectiveEntry> =>
  req<ProviderEffectiveEntry>(`/api/providers/effective/${encodeURIComponent(id)}`)

export const providersApi = {
  providerResourcesGet: (query: ProviderInventoryQueryInput = {}) =>
    req<ProviderResourcesResponse>(`/api/providers/resources${providerInventoryQuery(query)}`),
  providerEffectiveGet: effectivePage,
  providerEffectiveDetail,
  providerResourceStatuses: (ids: readonly string[]) =>
    req<ProviderResourceStatusesResponse>('/api/providers/resources/statuses', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  providerResourceGet: (id: string) => req<ProviderResourceResponse>(resourcePath(id)),
  providerResourceCreate: (input: ProviderResourceCreateRequest) =>
    req<ProviderResourceResponse>('/api/providers/resources', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  providerResourcePatch: (id: string, input: ProviderResourcePatchRequest) =>
    req<ProviderResourceResponse>(resourcePath(id), {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  providerResourceDelete: (id: string) => req<{ ok: true }>(resourcePath(id), { method: 'DELETE' }),
  providerValidate: (id: string, input: ProviderValidateRequest, signal?: AbortSignal) =>
    req<ProviderValidateResponse>(`${resourcePath(id)}/validate`, {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    }),
}
