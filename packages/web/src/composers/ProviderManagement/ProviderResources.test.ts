// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CredentialListItem,
  ProviderResourceListItem,
  ProviderResourceResponse,
} from '@notarium/contract'

import type * as ApiModule from '../../services/api'
import { ApiError } from '../../services/api'
import type * as WidgetModule from '../../widgets/ProviderManagement'

const harness = vi.hoisted(() => ({
  api: {
    providerResourcesGet: vi.fn(),
    providerEffectiveGet: vi.fn(),
    providerEffectiveDetail: vi.fn(),
    providerResourceStatuses: vi.fn(),
    credentialsGet: vi.fn(),
    providerResourceGet: vi.fn(),
    providerResourceCreate: vi.fn(),
    providerResourcePatch: vi.fn(),
    providerResourceDelete: vi.fn(),
    providerValidate: vi.fn(),
    providerAttachmentOffer: vi.fn(),
  },
  props: null as WidgetModule.ProviderResourcesProps | null,
}))

vi.mock('../SpaceProvider', () => ({ useSpace: () => ({ spaces: [] }) }))
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: harness.api,
}))
vi.mock('../../widgets/ProviderManagement', async (importOriginal) => ({
  ...(await importOriginal<typeof WidgetModule>()),
  ProviderResources: (props: WidgetModule.ProviderResourcesProps) => {
    harness.props = props
    return null
  },
}))

import { ProviderResources } from './ProviderResources'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const resource = (id: string): ProviderResourceListItem => ({
  id,
  name: `Resource ${id}`,
  wire: 'openai-compatible',
  owner: { kind: 'user', name: 'alice', mine: true },
  baseUrl: 'https://provider.example/v1',
  addressIsPrivate: false,
  capabilities: ['completion'],
  modelCount: 1,
  hasCredentials: true,
  disabledAt: null,
})

const foreignResource = (id: string): ProviderResourceListItem => {
  const item = resource(id)

  return {
    ...item,
    owner: { kind: 'user', name: 'foreign-owner', mine: false },
    baseUrl: undefined,
  }
}

const detail = (id: string): ProviderResourceResponse => ({
  resource: {
    ...resource(id),
    models: [
      {
        name: 'model',
        capabilities: ['completion'],
        dimensions: null,
        statusByCapability: { completion: 'available' },
      },
    ],
    defaultModel: 'model',
    credentialId: 'credential-1',
    consentEpoch: 1,
    runtimeEpoch: 1,
    lastCheck: {},
  },
  warnings: [],
})

const credential = (id: string): CredentialListItem => ({
  id,
  name: `Credential ${id}`,
  kind: 'bearer',
  origin: 'https://provider.example',
  disabledAt: null,
  rpm: null,
  tpm: null,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('ProviderResources composer', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    harness.props = null
    harness.api.providerResourcesGet.mockReset().mockResolvedValue({
      items: [resource('1')],
      total: 2,
      nextCursor: 'owned-next',
    })
    harness.api.providerEffectiveGet.mockReset().mockResolvedValue({
      items: [{ resource: resource('1'), unusableBecause: null }],
      total: 2,
      nextCursor: 'effective-next',
    })
    harness.api.providerEffectiveDetail.mockReset().mockImplementation(async (id: string) => ({
      resource: resource(id),
      unusableBecause: null,
    }))
    harness.api.providerResourceStatuses.mockReset().mockResolvedValue({ items: [] })
    harness.api.credentialsGet.mockReset().mockResolvedValue({
      items: [credential('1')],
      total: 2,
      nextCursor: 'credential-next',
    })
    harness.api.providerResourceGet.mockReset()
    harness.api.providerResourceCreate.mockReset()
    harness.api.providerResourcePatch.mockReset()
    harness.api.providerResourceDelete.mockReset()
    harness.api.providerValidate.mockReset()
    harness.api.providerAttachmentOffer.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const mount = async (expectedEntries = 1) => {
    await act(async () => root.render(createElement(ProviderResources)))
    await vi.waitFor(() => expect(harness.props?.entries).toHaveLength(expectedEntries))
  }

  it('batches an owned row displaced by 100 foreign effective rows and never calls it available', async () => {
    const status = deferred<{
      items: Array<{ id: string; unusableBecause: 'credential-disabled' }>
    }>()
    const foreign = Array.from({ length: 100 }, (_, index) => ({
      resource: foreignResource(`A-${String(index).padStart(3, '0')}`),
      unusableBecause: null,
    }))
    harness.api.providerResourcesGet.mockResolvedValue({
      items: [resource('Z-disabled')],
      total: 1,
      nextCursor: null,
    })
    harness.api.providerEffectiveGet.mockResolvedValue({
      items: foreign,
      total: 101,
      nextCursor: 'effective-next',
    })
    harness.api.providerResourceStatuses.mockReturnValue(status.promise)

    await mount(101)
    expect(
      harness.props?.entries?.find(({ resource: item }) => item.id === 'Z-disabled'),
    ).toMatchObject({ statusState: 'checking', unusableBecause: null })
    expect(harness.api.providerResourceStatuses).toHaveBeenCalledOnce()
    expect(harness.api.providerResourceStatuses).toHaveBeenCalledWith(['Z-disabled'])
    expect(harness.api.providerEffectiveDetail).not.toHaveBeenCalled()

    await act(async () => {
      status.resolve({
        items: [{ id: 'Z-disabled', unusableBecause: 'credential-disabled' }],
      })
      await status.promise
    })
    expect(
      harness.props?.entries?.find(({ resource: item }) => item.id === 'Z-disabled'),
    ).toMatchObject({ statusState: 'ready', unusableBecause: 'credential-disabled' })
  })

  it.each([
    {
      label: 'omits the row',
      response: { items: [] },
      error: null,
      message: 'Some provider statuses are unavailable.',
    },
    {
      label: 'rejects the batch',
      response: null,
      error: new Error('status batch unavailable'),
      message: 'status batch unavailable',
    },
  ])('keeps a missing owned status unavailable when the server $label', async (scenario) => {
    harness.api.providerResourcesGet.mockResolvedValue({
      items: [resource('Z-unknown')],
      total: 1,
      nextCursor: null,
    })
    harness.api.providerEffectiveGet.mockResolvedValue({
      items: [{ resource: foreignResource('A-foreign'), unusableBecause: null }],
      total: 2,
      nextCursor: null,
    })
    if (scenario.error) {
      harness.api.providerResourceStatuses.mockRejectedValue(scenario.error)
    } else {
      harness.api.providerResourceStatuses.mockResolvedValue(scenario.response)
    }

    await mount(2)
    await vi.waitFor(() =>
      expect(
        harness.props?.entries?.find(({ resource: item }) => item.id === 'Z-unknown'),
      ).toMatchObject({ statusState: 'error' }),
    )
    expect(harness.props?.statusError).toBe(scenario.message)
  })

  it('does not let an initial status batch overwrite a newer exact Patch refresh', async () => {
    const batch = deferred<{ items: Array<{ id: string; unusableBecause: null }> }>()
    harness.api.providerResourcesGet.mockResolvedValue({
      items: [resource('Z')],
      total: 1,
      nextCursor: null,
    })
    harness.api.providerEffectiveGet.mockResolvedValue({
      items: [{ resource: foreignResource('A'), unusableBecause: null }],
      total: 2,
      nextCursor: null,
    })
    harness.api.providerResourceStatuses.mockReturnValue(batch.promise)
    harness.api.providerResourcePatch.mockResolvedValue(detail('Z'))
    harness.api.providerEffectiveDetail.mockResolvedValue({
      resource: resource('Z'),
      unusableBecause: 'credential-disabled',
    })
    await mount(2)

    await act(async () => harness.props!.onPatch('Z', { name: 'Fresh Z' }))
    await act(async () => {
      batch.resolve({ items: [{ id: 'Z', unusableBecause: null }] })
      await batch.promise
    })

    expect(harness.props?.entries?.find(({ resource: item }) => item.id === 'Z')).toMatchObject({
      statusState: 'ready',
      unusableBecause: 'credential-disabled',
    })
  })

  it('continues owned, effective and selector inventories only on explicit actions', async () => {
    harness.api.providerResourcesGet.mockResolvedValueOnce({
      items: [resource('1')],
      total: 2,
      nextCursor: 'owned-next',
    })
    harness.api.providerEffectiveGet.mockResolvedValueOnce({
      items: [{ resource: resource('1'), unusableBecause: null }],
      total: 2,
      nextCursor: 'effective-next',
    })
    harness.api.credentialsGet.mockResolvedValueOnce({
      items: [credential('1')],
      total: 2,
      nextCursor: 'credential-next',
    })
    await mount()

    harness.api.providerResourcesGet.mockResolvedValueOnce({
      items: [resource('2')],
      total: 2,
      nextCursor: null,
    })
    harness.api.providerEffectiveGet.mockResolvedValueOnce({
      items: [{ resource: resource('2'), unusableBecause: 'credential-disabled' }],
      total: 2,
      nextCursor: null,
    })
    await act(async () => {
      await harness.props!.onLoadMore()
    })

    expect(harness.api.providerResourcesGet).toHaveBeenNthCalledWith(2, {
      cursor: 'owned-next',
    })
    expect(harness.api.providerEffectiveGet).toHaveBeenNthCalledWith(2, {
      cursor: 'effective-next',
    })
    expect(harness.props?.entries?.map(({ resource: item }) => item.id)).toEqual(['1', '2'])
    expect(harness.props?.entries?.[1].unusableBecause).toBe('credential-disabled')

    harness.api.credentialsGet.mockResolvedValueOnce({
      items: [credential('2')],
      total: 2,
      nextCursor: null,
    })
    await act(async () => {
      await harness.props!.onLoadMoreCredentials()
    })

    expect(harness.api.credentialsGet).toHaveBeenNthCalledWith(2, {
      cursor: 'credential-next',
    })
    expect(harness.props?.credentials.map(({ id }) => id)).toEqual(['1', '2'])
  })

  it('batches only an owned row missing from the newly loaded effective page', async () => {
    await mount()
    harness.api.providerResourcesGet.mockResolvedValueOnce({
      items: [resource('2')],
      total: 2,
      nextCursor: null,
    })
    harness.api.providerEffectiveGet.mockResolvedValueOnce({
      items: [{ resource: foreignResource('A-later'), unusableBecause: null }],
      total: 3,
      nextCursor: null,
    })
    harness.api.providerResourceStatuses.mockResolvedValueOnce({
      items: [{ id: '2', unusableBecause: 'credential-disabled' }],
    })

    await act(async () => harness.props!.onLoadMore())
    await vi.waitFor(() =>
      expect(harness.props?.entries?.find(({ resource: item }) => item.id === '2')).toMatchObject({
        statusState: 'ready',
        unusableBecause: 'credential-disabled',
      }),
    )
    expect(harness.api.providerResourceStatuses).toHaveBeenCalledOnce()
    expect(harness.api.providerResourceStatuses).toHaveBeenCalledWith(['2'])
  })

  it('does not let a stale effective page overwrite a newer exact Patch status', async () => {
    const stalePage = deferred<{
      items: Array<{ resource: ProviderResourceListItem; unusableBecause: null }>
      total: number
      nextCursor: null
    }>()
    harness.api.providerResourcesGet.mockResolvedValueOnce({
      items: [resource('Z')],
      total: 1,
      nextCursor: null,
    })
    harness.api.providerEffectiveGet.mockResolvedValueOnce({
      items: [{ resource: resource('Z'), unusableBecause: null }],
      total: 1,
      nextCursor: 'effective-next',
    })
    harness.api.providerEffectiveGet.mockReturnValueOnce(stalePage.promise)
    harness.api.providerResourcePatch.mockResolvedValue(detail('Z'))
    harness.api.providerEffectiveDetail.mockResolvedValue({
      resource: resource('Z'),
      unusableBecause: 'credential-disabled',
    })
    await mount()

    let loadMore!: Promise<void>
    await act(async () => {
      loadMore = harness.props!.onLoadMore()
      await Promise.resolve()
    })
    expect(harness.api.providerEffectiveGet).toHaveBeenNthCalledWith(2, {
      cursor: 'effective-next',
    })

    await act(async () => harness.props!.onPatch('Z', { name: 'Fresh Z' }))
    expect(harness.props?.entries?.[0]).toMatchObject({
      statusState: 'ready',
      unusableBecause: 'credential-disabled',
    })

    await act(async () => {
      stalePage.resolve({
        items: [{ resource: resource('Z'), unusableBecause: null }],
        total: 1,
        nextCursor: null,
      })
      await loadMore
    })

    expect(harness.props?.entries?.[0]).toMatchObject({
      statusState: 'ready',
      unusableBecause: 'credential-disabled',
    })
    expect(harness.api.providerEffectiveDetail).toHaveBeenCalledOnce()
    expect(harness.api.providerEffectiveDetail).toHaveBeenCalledWith('Z')
  })

  it('does not let a stale owned page overwrite a resource changed by Patch', async () => {
    const stalePage = deferred<{
      items: ProviderResourceListItem[]
      total: number
      nextCursor: null
    }>()
    harness.api.providerResourcesGet
      .mockResolvedValueOnce({
        items: [resource('Z')],
        total: 2,
        nextCursor: 'owned-next',
      })
      .mockReturnValueOnce(stalePage.promise)
    harness.api.providerEffectiveGet.mockResolvedValueOnce({
      items: [{ resource: resource('Z'), unusableBecause: null }],
      total: 1,
      nextCursor: null,
    })
    const patched = detail('Z')
    patched.resource.name = 'Fresh Z'
    harness.api.providerResourcePatch.mockResolvedValue(patched)
    harness.api.providerEffectiveDetail.mockResolvedValue({
      resource: { ...resource('Z'), name: 'Fresh Z' },
      unusableBecause: null,
    })
    await mount()

    let loadMore!: Promise<void>
    await act(async () => {
      loadMore = harness.props!.onLoadMore()
      await Promise.resolve()
    })
    await act(async () => harness.props!.onPatch('Z', { name: 'Fresh Z' }))
    await act(async () => {
      stalePage.resolve({
        items: [{ ...resource('Z'), name: 'Stale Z' }],
        total: 2,
        nextCursor: null,
      })
      await loadMore
    })

    expect(
      harness.props?.entries?.find(({ resource: item }) => item.id === 'Z')?.resource.name,
    ).toBe('Fresh Z')
  })

  it('does not let a stale owned page resurrect a resource removed by Delete', async () => {
    const stalePage = deferred<{
      items: ProviderResourceListItem[]
      total: number
      nextCursor: null
    }>()
    harness.api.providerResourcesGet
      .mockResolvedValueOnce({
        items: [resource('Z')],
        total: 2,
        nextCursor: 'owned-next',
      })
      .mockReturnValueOnce(stalePage.promise)
    harness.api.providerEffectiveGet.mockResolvedValueOnce({
      items: [{ resource: resource('Z'), unusableBecause: null }],
      total: 1,
      nextCursor: null,
    })
    harness.api.providerResourceDelete.mockResolvedValue(undefined)
    await mount()

    let loadMore!: Promise<void>
    await act(async () => {
      loadMore = harness.props!.onLoadMore()
      await Promise.resolve()
    })
    await act(async () => harness.props!.onDelete('Z'))
    await act(async () => {
      stalePage.resolve({ items: [resource('Z')], total: 2, nextCursor: null })
      await loadMore
    })

    expect(harness.props?.entries?.some(({ resource: item }) => item.id === 'Z')).toBe(false)
  })

  it('lets a page started after an older exact request supersede that request', async () => {
    const olderExact = deferred<{
      resource: ProviderResourceListItem
      unusableBecause: null
    }>()
    harness.api.providerResourcesGet.mockResolvedValueOnce({
      items: [resource('Z')],
      total: 1,
      nextCursor: null,
    })
    harness.api.providerEffectiveGet.mockResolvedValueOnce({
      items: [{ resource: resource('Z'), unusableBecause: null }],
      total: 1,
      nextCursor: 'effective-next',
    })
    harness.api.providerEffectiveGet.mockResolvedValueOnce({
      items: [{ resource: resource('Z'), unusableBecause: 'credential-disabled' }],
      total: 1,
      nextCursor: null,
    })
    harness.api.providerResourcePatch.mockResolvedValue(detail('Z'))
    harness.api.providerEffectiveDetail.mockReturnValue(olderExact.promise)
    await mount()

    let patch!: Promise<void>
    await act(async () => {
      patch = harness.props!.onPatch('Z', { name: 'Older exact' })
      await Promise.resolve()
    })
    expect(harness.api.providerEffectiveDetail).toHaveBeenCalledWith('Z')

    await act(async () => harness.props!.onLoadMore())
    expect(harness.props?.entries?.[0]).toMatchObject({
      statusState: 'ready',
      unusableBecause: 'credential-disabled',
    })

    await act(async () => {
      olderExact.resolve({ resource: resource('Z'), unusableBecause: null })
      await patch
    })
    expect(harness.props?.entries?.[0]).toMatchObject({
      statusState: 'ready',
      unusableBecause: 'credential-disabled',
    })
  })

  it('ignores an old status batch after the inventory component reloads', async () => {
    const stale = deferred<{ items: Array<{ id: string; unusableBecause: null }> }>()
    harness.api.providerResourcesGet.mockResolvedValue({
      items: [resource('Z')],
      total: 1,
      nextCursor: null,
    })
    harness.api.providerEffectiveGet.mockResolvedValue({
      items: [{ resource: foreignResource('A'), unusableBecause: null }],
      total: 2,
      nextCursor: null,
    })
    harness.api.providerResourceStatuses.mockReturnValue(stale.promise)
    await mount(2)

    await act(async () => root.unmount())
    harness.api.providerEffectiveGet.mockResolvedValue({
      items: [{ resource: resource('Z'), unusableBecause: 'credential-disabled' }],
      total: 1,
      nextCursor: null,
    })
    harness.api.providerResourceStatuses.mockResolvedValue({ items: [] })
    root = createRoot(container)
    await mount()

    await act(async () => {
      stale.resolve({ items: [{ id: 'Z', unusableBecause: null }] })
      await stale.promise
    })
    expect(harness.props?.entries?.[0]).toMatchObject({
      statusState: 'ready',
      unusableBecause: 'credential-disabled',
    })
  })

  it('keeps a rejected lazy detail read visible and settled', async () => {
    harness.api.providerResourceGet.mockRejectedValue(new Error('resource detail unavailable'))
    await mount()

    await act(async () => {
      await expect(harness.props!.onSelect('1')).resolves.toBeUndefined()
    })

    expect(harness.props?.selected).toBeNull()
    expect(harness.props?.selectingId).toBeNull()
    expect(harness.props?.detailError).toBe('resource detail unavailable')
  })

  it('does not let an older resource detail replace the latest selection', async () => {
    const older = deferred<ProviderResourceResponse>()
    const newer = deferred<ProviderResourceResponse>()
    harness.api.providerResourceGet
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    await mount()

    let olderTask!: Promise<void>
    let newerTask!: Promise<void>
    await act(async () => {
      olderTask = harness.props!.onSelect('1')
      newerTask = harness.props!.onSelect('2')
    })
    await act(async () => {
      newer.resolve(detail('2'))
      await newerTask
    })
    await act(async () => {
      older.resolve(detail('1'))
      await olderTask
    })

    expect(harness.props?.selected?.resource.id).toBe('2')
  })

  it('keeps a created resource in the loaded inventory without a first-page reset', async () => {
    harness.api.providerResourceCreate.mockResolvedValue(detail('created'))
    await mount()

    await act(async () => {
      await harness.props!.onCreate({
        name: 'Created',
        wire: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        headers: {},
        allowPrivateNetwork: false,
        models: [],
        defaultModel: null,
        credentialId: null,
        firstByteTimeoutMs: null,
        callTimeoutMs: null,
      })
    })

    expect(harness.api.providerResourcesGet).toHaveBeenCalledOnce()
    expect(harness.props?.entries?.map(({ resource: item }) => item.id)).toEqual(['1', 'created'])
    expect(harness.props?.hasMore).toBe(true)
  })

  it('shows Checking until Create receives the fresh disabled-credential projection', async () => {
    const status = deferred<{
      resource: ProviderResourceListItem
      unusableBecause: 'credential-disabled'
    }>()
    harness.api.providerResourceCreate.mockResolvedValue(detail('created'))
    harness.api.providerEffectiveDetail.mockReturnValue(status.promise)
    await mount()

    let task!: Promise<void>
    await act(async () => {
      task = harness.props!.onCreate({
        name: 'Created',
        wire: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        headers: {},
        allowPrivateNetwork: false,
        models: [],
        defaultModel: null,
        credentialId: 'credential-disabled',
        firstByteTimeoutMs: null,
        callTimeoutMs: null,
      })
      await Promise.resolve()
    })
    const pending = harness.props?.entries?.find(({ resource: item }) => item.id === 'created')
    expect(pending).toMatchObject({ statusState: 'checking' })

    await act(async () => {
      status.resolve({
        resource: resource('created'),
        unusableBecause: 'credential-disabled',
      })
      await task
    })
    const settled = harness.props?.entries?.find(({ resource: item }) => item.id === 'created')
    expect(settled).toMatchObject({
      statusState: 'ready',
      unusableBecause: 'credential-disabled',
    })
    expect(harness.api.providerEffectiveDetail).toHaveBeenCalledOnce()
    expect(harness.api.providerEffectiveDetail).toHaveBeenCalledWith('created')
    expect(harness.api.providerResourcesGet).toHaveBeenCalledOnce()
  })

  it('refreshes effective status after Patch without resetting pagination', async () => {
    harness.api.providerResourcePatch.mockResolvedValue(detail('1'))
    harness.api.providerEffectiveDetail.mockResolvedValue({
      resource: resource('1'),
      unusableBecause: 'credential-disabled',
    })
    await mount()

    await act(async () => {
      await harness.props!.onPatch('1', { credentialId: 'credential-disabled' })
    })

    expect(harness.props?.entries?.[0]).toMatchObject({
      statusState: 'ready',
      unusableBecause: 'credential-disabled',
    })
    expect(harness.props?.hasMore).toBe(true)
    expect(harness.api.providerEffectiveDetail).toHaveBeenCalledOnce()
    expect(harness.api.providerEffectiveDetail).toHaveBeenCalledWith('1')
    expect(harness.api.providerResourcesGet).toHaveBeenCalledOnce()
  })

  it('closes and removes a selected resource when Patch reports it disappeared', async () => {
    const missing = new ApiError('missing')
    missing.status = 404
    harness.api.providerResourceGet.mockResolvedValue(detail('1'))
    harness.api.providerResourcePatch.mockRejectedValue(missing)
    await mount()
    await act(async () => harness.props!.onSelect('1'))

    await act(async () => harness.props!.onPatch('1', { name: 'Too late' }))

    expect(harness.props?.selected).toBeNull()
    expect(harness.props?.entries?.some(({ resource: item }) => item.id === '1')).toBe(false)
    expect(harness.props?.detailError).toBe('This provider resource no longer exists.')
  })

  it('treats Delete not-found as an honest disappearance', async () => {
    const missing = new ApiError('missing')
    missing.status = 404
    harness.api.providerResourceGet.mockResolvedValue(detail('1'))
    harness.api.providerResourceDelete.mockRejectedValue(missing)
    await mount()
    await act(async () => harness.props!.onSelect('1'))

    await act(async () => harness.props!.onDelete('1'))

    expect(harness.props?.selected).toBeNull()
    expect(harness.props?.entries?.some(({ resource: item }) => item.id === '1')).toBe(false)
    expect(harness.props?.detailError).toBe('This provider resource no longer exists.')
  })

  it('refreshes effective status after Validate without closing detail', async () => {
    const validated = detail('1')
    harness.api.providerValidate.mockResolvedValue({
      capability: 'completion',
      result: {
        status: 'not-configured',
        checkedAt: '2026-08-30T00:00:00.000Z',
        diagnostic: null,
        credentialProven: false,
      },
      saved: true,
      resource: validated.resource,
    })
    harness.api.providerEffectiveDetail.mockResolvedValue({
      resource: resource('1'),
      unusableBecause: 'not-configured',
    })
    await mount()

    await act(async () => {
      await harness.props!.onValidate('1', 'completion')
    })

    expect(harness.props?.selected?.resource.id).toBe('1')
    expect(harness.props?.entries?.[0]).toMatchObject({
      statusState: 'ready',
      unusableBecause: 'not-configured',
    })
    expect(harness.api.providerEffectiveDetail).toHaveBeenCalledOnce()
    expect(harness.api.providerEffectiveDetail).toHaveBeenCalledWith('1')
  })

  it('keeps a failed status refresh non-available and exposes a Notice message', async () => {
    harness.api.providerResourcePatch.mockResolvedValue(detail('1'))
    harness.api.providerEffectiveDetail.mockRejectedValue(new Error('status refresh unavailable'))
    await mount()

    await act(async () => {
      await expect(harness.props!.onPatch('1', { name: 'Renamed' })).resolves.toBeUndefined()
    })

    expect(harness.props?.entries?.[0]).toMatchObject({ statusState: 'error' })
    expect(harness.props?.statusError).toBe('status refresh unavailable')
  })

  it('keeps the latest effective refresh when mutation responses arrive out of order', async () => {
    const older = deferred<{
      resource: ProviderResourceListItem
      unusableBecause: null
    }>()
    const newer = deferred<{
      resource: ProviderResourceListItem
      unusableBecause: 'credential-disabled'
    }>()
    harness.api.providerResourcePatch.mockResolvedValue(detail('1'))
    harness.api.providerEffectiveDetail
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    await mount()

    let olderTask!: Promise<void>
    let newerTask!: Promise<void>
    await act(async () => {
      olderTask = harness.props!.onPatch('1', { name: 'Older' })
      newerTask = harness.props!.onPatch('1', { name: 'Newer' })
      await Promise.resolve()
    })
    await act(async () => {
      newer.resolve({
        resource: resource('1'),
        unusableBecause: 'credential-disabled',
      })
      await newerTask
    })
    await act(async () => {
      older.resolve({ resource: resource('1'), unusableBecause: null })
      await olderTask
    })

    expect(harness.props?.entries?.[0]).toMatchObject({
      statusState: 'ready',
      unusableBecause: 'credential-disabled',
    })
    expect(harness.api.providerEffectiveDetail).toHaveBeenCalledTimes(2)
  })
})
