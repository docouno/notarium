// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderResourcesProps } from './types'

vi.mock('../../core/Dialog', () => ({
  useDialog: () => ({ confirm: vi.fn() }),
}))

import { ProviderResources } from './ProviderResources'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const props = (
  statusState: 'ready' | 'checking' | 'error',
  statusError: string | null,
): ProviderResourcesProps => ({
  entries: [
    {
      resource: {
        id: 'resource-1',
        name: 'Primary',
        wire: 'openai-compatible',
        owner: { kind: 'user', name: 'alice', mine: true },
        baseUrl: 'https://provider.example/v1',
        addressIsPrivate: false,
        capabilities: ['completion'],
        modelCount: 1,
        hasCredentials: true,
        disabledAt: null,
      },
      owned: true,
      unusableBecause: null,
      statusState,
    },
  ],
  hasMore: false,
  credentials: [],
  credentialsNextCursor: null,
  spaces: [],
  selected: null,
  loading: false,
  loadingMore: false,
  loadingMoreCredentials: false,
  error: null,
  continuationError: null,
  credentialContinuationError: null,
  statusError,
  detailError: null,
  selectingId: null,
  onSelect: vi.fn(),
  onLoadMore: vi.fn(),
  onLoadMoreCredentials: vi.fn(),
  onCreate: vi.fn(),
  onPatch: vi.fn(),
  onDelete: vi.fn(),
  onValidate: vi.fn(),
  onOffer: vi.fn(),
  onClose: vi.fn(),
})

describe('ProviderResources status projection', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('never calls a pending projection available', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => root.render(createElement(ProviderResources, props('checking', null))))
    expect(container.querySelector('tbody tr td:nth-child(5)')?.textContent).toBe('Checking…')
    await act(async () => root.unmount())
  })

  it('shows an unavailable status together with the refresh failure Notice', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () =>
      root.render(createElement(ProviderResources, props('error', 'status refresh unavailable'))),
    )
    expect(container.querySelector('tbody tr td:nth-child(5)')?.textContent).toBe(
      'Status unavailable',
    )
    expect(container.textContent).toContain('status refresh unavailable')
    await act(async () => root.unmount())
  })
})
