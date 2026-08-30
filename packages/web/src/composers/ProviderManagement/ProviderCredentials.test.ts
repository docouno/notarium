// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CredentialListItem,
  CredentialResponse,
  ProviderResourceListItem,
} from '@notarium/contract'

import type * as ApiModule from '../../services/api'
import type * as WidgetModule from '../../widgets/ProviderManagement'

const harness = vi.hoisted(() => ({
  api: {
    credentialsGet: vi.fn(),
    credentialGet: vi.fn(),
    credentialCreate: vi.fn(),
    credentialPatch: vi.fn(),
    credentialRetarget: vi.fn(),
    credentialDelete: vi.fn(),
    providerResourcesGet: vi.fn(),
  },
  props: null as WidgetModule.ProviderCredentialsProps | null,
}))

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: harness.api,
}))
vi.mock('../../widgets/ProviderManagement', async (importOriginal) => ({
  ...(await importOriginal<typeof WidgetModule>()),
  ProviderCredentials: (props: WidgetModule.ProviderCredentialsProps) => {
    harness.props = props
    return null
  },
}))

import { ProviderCredentials } from './ProviderCredentials'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item = (id: string): CredentialListItem => ({
  id,
  name: `Credential ${id}`,
  kind: 'bearer',
  origin: 'https://provider.example',
  disabledAt: null,
  rpm: null,
  tpm: null,
})

const detail = (id: string): CredentialResponse => ({
  credential: {
    ...item(id),
    injection: { header: '', prefix: 'Bearer ' },
    consentEpoch: 1,
    runtimeEpoch: 1,
  },
  references: [],
})

const resource = (id: string): ProviderResourceListItem => ({
  id,
  name: `Resource ${id}`,
  wire: 'openai-compatible',
  owner: { kind: 'user', name: 'alice', mine: true },
  baseUrl: `https://provider.example/${id}`,
  addressIsPrivate: false,
  purposes: ['chat'],
  modelCount: 1,
  hasCredentials: true,
  disabledAt: null,
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

describe('ProviderCredentials composer', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    harness.props = null
    harness.api.credentialsGet.mockReset().mockResolvedValue({
      items: [item('1')],
      total: 2,
      nextCursor: 'credential-next',
    })
    harness.api.credentialGet.mockReset()
    harness.api.credentialCreate.mockReset()
    harness.api.credentialPatch.mockReset()
    harness.api.credentialRetarget.mockReset()
    harness.api.credentialDelete.mockReset()
    harness.api.providerResourcesGet.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const mount = async () => {
    await act(async () => root.render(createElement(ProviderCredentials)))
    await vi.waitFor(() => expect(harness.props?.credentials).toHaveLength(1))
  }

  it('loads another page only after the explicit continuation action', async () => {
    harness.api.credentialsGet
      .mockResolvedValueOnce({ items: [item('1')], total: 2, nextCursor: 'credential-next' })
      .mockResolvedValueOnce({ items: [item('2')], total: 2, nextCursor: null })
    await mount()

    expect(harness.api.credentialsGet).toHaveBeenCalledOnce()
    await act(async () => {
      await harness.props!.onLoadMore()
    })

    expect(harness.api.credentialsGet).toHaveBeenNthCalledWith(2, {
      cursor: 'credential-next',
    })
    expect(harness.props?.credentials?.map(({ id }) => id)).toEqual(['1', '2'])
    expect(harness.props?.nextCursor).toBeNull()
  })

  it('keeps the latest detail request and ignores a late older response', async () => {
    const older = deferred<CredentialResponse>()
    const newer = deferred<CredentialResponse>()
    harness.api.credentialGet.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
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

    expect(harness.props?.selected?.credential.id).toBe('2')
    expect(harness.props?.selectingId).toBeNull()
  })

  it('projects a rejected detail read into visible state without rejecting the click', async () => {
    harness.api.credentialGet.mockRejectedValue(new Error('detail unavailable'))
    await mount()

    await act(async () => {
      await expect(harness.props!.onSelect('1')).resolves.toBeUndefined()
    })

    expect(harness.props?.selected).toBeNull()
    expect(harness.props?.detailError).toBe('detail unavailable')
  })

  it('keeps a created row visible without resetting the loaded page', async () => {
    harness.api.credentialCreate.mockResolvedValue(detail('created'))
    await mount()

    await act(async () => {
      await harness.props!.onCreate({
        name: 'Created',
        kind: 'bearer',
        secret: 'secret',
        origin: 'https://provider.example',
        injection: { header: '', prefix: 'Bearer ' },
        rpm: null,
        tpm: null,
      })
    })

    expect(harness.api.credentialsGet).toHaveBeenCalledOnce()
    expect(harness.props?.credentials?.map(({ id }) => id)).toEqual(['created', '1'])
    expect(harness.props?.nextCursor).toBe('credential-next')
  })

  it('drains the complete resource cursor before exposing the atomic Retarget form', async () => {
    const selected = detail('1')
    selected.references = [
      { kind: 'provider-resource', id: 'resource-1', name: 'Resource resource-1' },
      { kind: 'provider-resource', id: 'resource-2', name: 'Resource resource-2' },
    ]
    harness.api.credentialGet.mockResolvedValue(selected)
    harness.api.providerResourcesGet
      .mockResolvedValueOnce({
        items: [resource('resource-1')],
        total: 2,
        nextCursor: 'resource-next',
      })
      .mockResolvedValueOnce({
        items: [resource('resource-2')],
        total: 2,
        nextCursor: null,
      })
    await mount()
    await act(async () => {
      await harness.props!.onSelect('1')
    })
    await act(async () => {
      await harness.props!.onPrepareRetarget()
    })

    expect(harness.api.providerResourcesGet).toHaveBeenNthCalledWith(2, {
      cursor: 'resource-next',
    })
    expect(harness.props?.referencedResources.map(({ id }) => id)).toEqual([
      'resource-1',
      'resource-2',
    ])
  })
})
