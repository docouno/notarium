// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAttachmentListItem, ProviderAttachmentView } from '@notarium/contract'

import type * as ApiModule from '../../services/api'
import type * as WidgetModule from '../../widgets/ProviderManagement'

const harness = vi.hoisted(() => ({
  api: {
    providerAttachmentsGet: vi.fn(),
    providerAttachmentDetail: vi.fn(),
    providerAttachmentAccept: vi.fn(),
    providerAttachmentDetach: vi.fn(),
  },
  props: null as WidgetModule.ProviderAttachmentsProps | null,
}))

vi.mock('../SpaceProvider', () => ({ useSpace: () => ({ space: 'main' }) }))
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: harness.api,
}))
vi.mock('../../widgets/ProviderManagement', async (importOriginal) => ({
  ...(await importOriginal<typeof WidgetModule>()),
  ProviderAttachments: (props: WidgetModule.ProviderAttachmentsProps) => {
    harness.props = props
    return null
  },
}))

import { ApiError } from '../../services/api'
import { ProviderAttachments } from './ProviderAttachments'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const view = (resourceEpoch: number, credentialEpoch: number | null): ProviderAttachmentView => ({
  attachment: {
    id: 'attachment-1',
    resourceId: 'resource-1',
    targetKind: 'space',
    targetId: 'space-main',
    targetSpace: 'space-main',
    state: 'pending',
    resourceEpoch: null,
    credentialEpoch: null,
    disclosure: null,
    createdAt: '2026-08-25T00:00:00.000Z',
    expiresAt: '2026-09-08T00:00:00.000Z',
  },
  resource: {
    id: 'resource-1',
    name: 'Main',
    wire: 'openai-compatible',
    owner: { kind: 'user', name: 'alice', mine: false },
    addressIsPrivate: false,
    capabilities: ['completion'],
    modelCount: 1,
    hasCredentials: true,
    disabledAt: null,
  },
  currentEpochs: { resourceEpoch, credentialEpoch },
  currentDisclosure: {
    targetSpace: 'space-main',
    resourceOwner: 'alice',
    baseUrl: 'https://provider.example/v1',
    models: [{ name: 'model-a', capabilities: ['completion'] }],
    allowPrivateNetwork: false,
    headerNames: ['authorization'],
  },
  diff: {
    before: null,
    after: {
      targetSpace: 'space-main',
      resourceOwner: 'alice',
      baseUrl: 'https://provider.example/v1',
      models: [{ name: 'model-a', capabilities: ['completion'] }],
      allowPrivateNetwork: false,
      headerNames: ['authorization'],
    },
    changed: true,
  },
})

const listItem = (value: ProviderAttachmentView): ProviderAttachmentListItem => ({
  attachment: {
    id: value.attachment.id,
    resourceId: value.attachment.resourceId,
    targetKind: value.attachment.targetKind,
    targetId: value.attachment.targetId,
    targetSpace: value.attachment.targetSpace,
    state: value.attachment.state,
    createdAt: value.attachment.createdAt,
    expiresAt: value.attachment.expiresAt,
  },
  resource: { ...value.resource, capabilities: [...value.resource.capabilities] },
})

describe('ProviderAttachments composer', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    harness.props = null
    harness.api.providerAttachmentsGet.mockReset().mockResolvedValue({
      items: [listItem(view(7, 9))],
      total: 1,
      nextCursor: null,
    })
    harness.api.providerAttachmentAccept.mockReset()
    harness.api.providerAttachmentDetail.mockReset()
    harness.api.providerAttachmentDetach.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const mount = async (count = 1) => {
    await act(async () => root.render(createElement(ProviderAttachments)))
    await vi.waitFor(() => expect(harness.props?.items).toHaveLength(count))
  }

  it('leaves disclosure detail unloaded until the decision is opened', async () => {
    await mount()

    expect(harness.api.providerAttachmentDetail).not.toHaveBeenCalled()
    expect(harness.props?.selected).toBeNull()
  })

  it('accepts the current pair from the view, never the stored null pair', async () => {
    const accepted = view(7, 9)
    accepted.attachment.state = 'active'
    accepted.attachment.resourceEpoch = 7
    accepted.attachment.credentialEpoch = 9
    harness.api.providerAttachmentAccept.mockResolvedValue({ outcome: 'accepted', view: accepted })
    harness.api.providerAttachmentDetail.mockResolvedValue({ view: view(7, 9) })
    await mount()

    await act(async () => harness.props!.onSelect('attachment-1'))
    await act(async () => {
      await harness.props!.onAccept(harness.props!.selected!)
    })

    expect(harness.api.providerAttachmentAccept).toHaveBeenCalledWith('attachment-1', {
      resourceEpoch: 7,
      credentialEpoch: 9,
    })
  })

  it('replaces a stale row with the conflict view and asks for one new click', async () => {
    const fresh = view(8, 10)
    const conflict = new ApiError('epoch-conflict')
    conflict.reason = 'epoch-conflict'
    conflict.providerView = fresh
    harness.api.providerAttachmentAccept.mockRejectedValue(conflict)
    harness.api.providerAttachmentDetail.mockResolvedValue({ view: view(7, 9) })
    await mount()

    let outcome = ''
    await act(async () => harness.props!.onSelect('attachment-1'))
    await act(async () => {
      outcome = await harness.props!.onAccept(harness.props!.selected!)
    })

    expect(outcome).toBe('refreshed')
    expect(harness.props?.selected?.currentEpochs).toEqual({
      resourceEpoch: 8,
      credentialEpoch: 10,
    })
    expect(harness.api.providerAttachmentAccept).toHaveBeenCalledOnce()
  })

  it('appends one explicit cursor page and keeps the continuation bounded', async () => {
    const first = view(7, 9)
    const second = view(8, 10)
    second.attachment.id = 'attachment-2'
    second.attachment.resourceId = 'resource-2'
    second.resource.id = 'resource-2'
    second.resource.name = 'Secondary'
    harness.api.providerAttachmentsGet
      .mockReset()
      .mockResolvedValueOnce({
        items: [listItem(first)],
        total: 2,
        nextCursor: 'attachment-next',
      })
      .mockResolvedValueOnce({ items: [listItem(second)], total: 2, nextCursor: null })
    await mount()

    await act(async () => {
      await harness.props!.onLoadMore()
    })

    expect(harness.api.providerAttachmentsGet).toHaveBeenNthCalledWith(2, 'main', {
      cursor: 'attachment-next',
    })
    expect(harness.props?.items?.map(({ attachment }) => attachment.id)).toEqual([
      'attachment-1',
      'attachment-2',
    ])
    expect(harness.props?.nextCursor).toBeNull()
  })

  it('keeps only the latest lazy detail and reports a current detail failure', async () => {
    const first = view(7, 9)
    const second = view(8, 10)
    second.attachment.id = 'attachment-2'
    second.attachment.resourceId = 'resource-2'
    second.resource.id = 'resource-2'
    const stale = deferred<{ view: ProviderAttachmentView }>()
    const latest = deferred<{ view: ProviderAttachmentView }>()
    harness.api.providerAttachmentsGet.mockResolvedValue({
      items: [listItem(first), listItem(second)],
      total: 2,
      nextCursor: null,
    })
    harness.api.providerAttachmentDetail
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise)
    await mount(2)

    let staleCall!: Promise<void>
    let latestCall!: Promise<void>
    await act(async () => {
      staleCall = harness.props!.onSelect('attachment-1')
      latestCall = harness.props!.onSelect('attachment-2')
    })
    await act(async () => latest.resolve({ view: second }))
    await latestCall
    await act(async () => stale.reject(new Error('stale detail failed')))
    await staleCall

    expect(harness.props?.selected?.attachment.id).toBe('attachment-2')
    expect(harness.props?.detailError).toBeNull()

    harness.api.providerAttachmentDetail.mockRejectedValueOnce(new Error('detail unavailable'))
    await act(async () => harness.props!.onSelect('attachment-1'))
    expect(harness.props?.detailError).toBe('detail unavailable')
    expect(harness.props?.selected).toBeNull()
  })
})
