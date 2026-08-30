import type {
  ProviderAttachmentAcceptRequest,
  ProviderAttachmentAcceptResponse,
  ProviderAttachmentDetailResponse,
  ProviderAttachmentOfferRequest,
  ProviderAttachmentOfferResponse,
  ProviderAttachmentsResponse,
  ProviderInventoryQueryInput,
} from '@notarium/contract'
import { req, sp } from './client'
import { providerInventoryQuery } from './providerPagination'

const attachmentPath = (id: string) => `/api/providers/attachments/${encodeURIComponent(id)}`

export const providerAttachmentsApi = {
  providerAttachmentsGet: (space: string, query: ProviderInventoryQueryInput = {}) =>
    req<ProviderAttachmentsResponse>(
      `${sp(space)}/providers/attachments${providerInventoryQuery(query)}`,
    ),
  providerAttachmentOffer: (input: ProviderAttachmentOfferRequest) =>
    req<ProviderAttachmentOfferResponse>('/api/providers/attachments', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  providerAttachmentDetail: (id: string) =>
    req<ProviderAttachmentDetailResponse>(attachmentPath(id)),
  providerAttachmentAccept: (id: string, input: ProviderAttachmentAcceptRequest) =>
    req<ProviderAttachmentAcceptResponse>(`${attachmentPath(id)}/accept`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  providerAttachmentDetach: (id: string) =>
    req<{ ok: true }>(attachmentPath(id), { method: 'DELETE' }),
}
