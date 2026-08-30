import type {
  CredentialCreateRequest,
  CredentialListItem,
  CredentialPatchRequest,
  CredentialResponse,
  ProviderAttachmentListItem,
  ProviderAttachmentView,
  ProviderResourceCreateRequest,
  ProviderResourceListItem,
  ProviderResourcePatchRequest,
  ProviderResourceResponse,
  ProviderRetargetRequest,
  ProviderStatus,
  ProviderValidateResponse,
  Purpose,
  Space,
} from '@notarium/contract'

export type ProviderCredentialsProps = {
  credentials: CredentialListItem[] | null
  total: number
  nextCursor: string | null
  selected: CredentialResponse | null
  referencedResources: ProviderResourceListItem[]
  loading: boolean
  loadingMore: boolean
  error: string | null
  continuationError: string | null
  detailError: string | null
  selectingId: string | null
  onSelect: (id: string) => Promise<void>
  onLoadMore: () => Promise<void>
  onCreate: (input: CredentialCreateRequest) => Promise<void>
  onPatch: (id: string, input: CredentialPatchRequest) => Promise<void>
  onPrepareRetarget: () => Promise<void>
  onRetarget: (id: string, input: ProviderRetargetRequest) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}

export type ProviderAttachmentAcceptUiOutcome = 'accepted' | 'already-active' | 'refreshed'

export type ProviderAttachmentsProps = {
  items: ProviderAttachmentListItem[] | null
  total: number
  nextCursor: string | null
  selected: ProviderAttachmentView | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  continuationError: string | null
  detailError: string | null
  selectingId: string | null
  onSelect: (id: string) => Promise<void>
  onClose: () => void
  onLoadMore: () => Promise<void>
  onAccept: (view: ProviderAttachmentView) => Promise<ProviderAttachmentAcceptUiOutcome>
  onDetach: (id: string) => Promise<void>
}

export type ProviderResourceListEntry = {
  resource: ProviderResourceListItem
  owned: boolean
  unusableBecause: ProviderStatus | null
  statusState: 'ready' | 'checking' | 'error'
}

export type ProviderResourcesProps = {
  entries: ProviderResourceListEntry[] | null
  hasMore: boolean
  credentials: CredentialListItem[]
  credentialsNextCursor: string | null
  spaces: Space[]
  selected: ProviderResourceResponse | null
  loading: boolean
  loadingMore: boolean
  loadingMoreCredentials: boolean
  error: string | null
  continuationError: string | null
  credentialContinuationError: string | null
  statusError: string | null
  detailError: string | null
  selectingId: string | null
  onSelect: (id: string) => Promise<void>
  onLoadMore: () => Promise<void>
  onLoadMoreCredentials: () => Promise<void>
  onCreate: (input: ProviderResourceCreateRequest) => Promise<void>
  onPatch: (id: string, input: ProviderResourcePatchRequest) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onValidate: (id: string, purpose: Purpose) => Promise<ProviderValidateResponse>
  onOffer: (resourceId: string, targetId: string) => Promise<void>
  onClose: () => void
}
