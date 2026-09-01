// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAttachmentListItem, ProviderAttachmentView } from '@notarium/contract'

vi.mock('../../core/Dialog', () => ({
  useDialog: () => ({ confirm: vi.fn() }),
}))

import { ProviderAttachments } from './ProviderAttachments'
import type { ProviderAttachmentsProps } from './types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const summary = (index: number): ProviderAttachmentListItem => ({
  attachment: {
    id: `attachment-${index}`,
    resourceId: `resource-${index}`,
    targetKind: 'space',
    targetId: 'space-main',
    targetSpace: 'space-main',
    state: 'pending',
    createdAt: `2026-08-30T00:00:${String(index).padStart(2, '0')}.000Z`,
    expiresAt: '2026-09-13T00:00:00.000Z',
  },
  resource: {
    id: `resource-${index}`,
    name: `Resource ${index}`,
    wire: 'openai-compatible',
    owner: { kind: 'user', name: 'alice', mine: false },
    addressIsPrivate: false,
    capabilities: ['completion'],
    modelCount: 1,
    hasCredentials: false,
    disabledAt: null,
  },
})

const detail = (item: ProviderAttachmentListItem): ProviderAttachmentView => ({
  attachment: {
    ...item.attachment,
    resourceEpoch: null,
    credentialEpoch: null,
    disclosure: null,
  },
  resource: {
    ...item.resource,
  },
  currentEpochs: { resourceEpoch: 1, credentialEpoch: null },
  currentDisclosure: {
    targetSpace: 'space-main',
    resourceOwner: 'alice',
    baseUrl: 'https://provider.example/v1',
    models: [{ name: 'model', capabilities: ['completion'] }],
    allowPrivateNetwork: false,
    headerNames: [],
  },
  diff: {
    before: null,
    after: {
      targetSpace: 'space-main',
      resourceOwner: 'alice',
      baseUrl: 'https://provider.example/v1',
      models: [{ name: 'model', capabilities: ['completion'] }],
      allowPrivateNetwork: false,
      headerNames: [],
    },
    changed: true,
  },
})

describe('ProviderAttachments inline disclosure', () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    scrollIntoView.mockReset()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('anchors and focuses the selected detail beside its summary in a 100-row page', async () => {
    const items = Array.from({ length: 100 }, (_, index) => summary(index))
    const props: ProviderAttachmentsProps = {
      items,
      total: 100,
      nextCursor: null,
      selected: detail(items[0]),
      loading: false,
      loadingMore: false,
      error: null,
      continuationError: null,
      detailError: null,
      selectingId: null,
      onSelect: vi.fn(),
      onClose: vi.fn(),
      onLoadMore: vi.fn(),
      onAccept: vi.fn(),
      onDetach: vi.fn(),
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => root.render(createElement(ProviderAttachments, props)))
    const cards = container.querySelectorAll('[data-testid="provider-attachment"]')
    const renderedDetail = container.querySelector<HTMLElement>(
      '[data-testid="provider-attachment-detail"]',
    )

    expect(cards).toHaveLength(100)
    expect(cards[0].nextElementSibling).toBe(renderedDetail)
    expect(cards[0].contains(renderedDetail)).toBe(false)
    expect(document.activeElement).toBe(renderedDetail)
    expect(renderedDetail?.getAttribute('role')).toBe('region')
    expect(renderedDetail?.getAttribute('aria-live')).toBe('polite')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(
      renderedDetail?.querySelector('[data-testid="provider-attachment-accept"]'),
    ).not.toBeNull()
    await act(async () => {
      renderedDetail?.querySelector<HTMLButtonElement>('button')?.click()
      await Promise.resolve()
    })
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(
      cards[0].querySelector('[data-testid="provider-attachment-review"]'),
    )
    await act(async () => root.unmount())
  })
})
