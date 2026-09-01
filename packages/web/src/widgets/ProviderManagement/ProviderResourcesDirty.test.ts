// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderResourceResponse } from '@notarium/contract'

const dialog = vi.hoisted(() => ({ confirm: vi.fn() }))

vi.mock('../../core/Dialog', () => ({
  useDialog: () => dialog,
}))

import { ProviderResources } from './ProviderResources'
import type { ProviderResourcesProps } from './types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const detail = (runtimeEpoch = 0, modelName = ' exact model '): ProviderResourceResponse => ({
  resource: {
    id: 'resource-1',
    name: 'Primary',
    wire: 'openai-compatible',
    owner: { kind: 'user', name: 'alice', mine: true },
    baseUrl: 'https://provider.example/v1',
    addressIsPrivate: false,
    allowPrivateNetwork: false,
    models: [
      {
        name: modelName,
        capabilities: ['completion'],
        dimensions: null,
        statusByCapability: { completion: 'available' },
      },
    ],
    defaultModel: modelName,
    credentialId: null,
    hasCredentials: false,
    consentEpoch: 0,
    runtimeEpoch,
    disabledAt: null,
    lastCheck: {},
    firstByteTimeoutMs: null,
    callTimeoutMs: null,
  },
  warnings: [],
})

const props = (selected = detail()): ProviderResourcesProps => ({
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
        hasCredentials: false,
        disabledAt: null,
      },
      owned: true,
      unusableBecause: null,
      statusState: 'ready',
    },
    {
      resource: {
        id: 'resource-2',
        name: 'Secondary',
        wire: 'openai-compatible',
        owner: { kind: 'user', name: 'alice', mine: true },
        baseUrl: 'https://provider.example/v2',
        addressIsPrivate: false,
        capabilities: ['embedding'],
        modelCount: 1,
        hasCredentials: false,
        disabledAt: null,
      },
      owned: true,
      unusableBecause: null,
      statusState: 'ready',
    },
  ],
  hasMore: false,
  credentials: [],
  credentialsNextCursor: null,
  spaces: [],
  selected,
  loading: false,
  loadingMore: false,
  loadingMoreCredentials: false,
  error: null,
  continuationError: null,
  credentialContinuationError: null,
  statusError: null,
  detailError: null,
  selectingId: null,
  onSelect: vi.fn(async () => {}),
  onLoadMore: vi.fn(async () => {}),
  onLoadMoreCredentials: vi.fn(async () => {}),
  onCreate: vi.fn(async () => {}),
  onPatch: vi.fn(async () => {}),
  onDelete: vi.fn(async () => {}),
  onValidate: vi.fn(async (_id: string, capability: 'completion' | 'embedding') => ({
    capability,
    result: {
      status: 'ready' as const,
      checkedAt: '2026-08-31T00:00:00.000Z',
      diagnostic: null,
      credentialProven: true,
    },
    saved: true,
    resource: selected.resource,
  })),
  onOffer: vi.fn(async () => {}),
  onClose: vi.fn(),
})

const setInput = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  )!

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe('ProviderResources local dirty policy', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    dialog.confirm.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('blocks Validate while authored changes need an explicit Save', async () => {
    const input = () => container.querySelector('[aria-label="Model 1 name"]') as HTMLInputElement
    await act(async () => root.render(createElement(ProviderResources, props())))
    await setInput(input(), ' exact model changed ')
    await act(async () => button(container, 'Connection checks').click())

    expect(container.textContent).toContain('Save changes first to Validate or Share.')
    expect(button(container, 'Validate').disabled).toBe(true)
    expect(button(container, 'Save').disabled).toBe(false)
  })

  it('keeps the draft when Close or row switch discard is rejected', async () => {
    const value = () =>
      (container.querySelector('[aria-label="Model 1 name"]') as HTMLInputElement).value
    const current = props()
    await act(async () => root.render(createElement(ProviderResources, current)))
    await setInput(
      container.querySelector('[aria-label="Model 1 name"]') as HTMLInputElement,
      'dirty exact model',
    )
    dialog.confirm.mockResolvedValue(false)

    await act(async () => button(container, 'Close').click())
    await act(async () =>
      (container.querySelector('[title="Edit Secondary"]') as HTMLButtonElement).click(),
    )

    expect(dialog.confirm).toHaveBeenCalledTimes(2)
    expect(current.onClose).not.toHaveBeenCalled()
    expect(current.onSelect).not.toHaveBeenCalled()
    expect(value()).toBe('dirty exact model')
  })

  it('preserves a dirty authored draft across a same-id system refresh', async () => {
    const current = props()
    await act(async () => root.render(createElement(ProviderResources, current)))
    const input = container.querySelector('[aria-label="Model 1 name"]') as HTMLInputElement
    await setInput(input, 'dirty exact model')

    await act(async () =>
      root.render(createElement(ProviderResources, { ...current, selected: detail(1) })),
    )

    expect((container.querySelector('[aria-label="Model 1 name"]') as HTMLInputElement).value).toBe(
      'dirty exact model',
    )
  })

  it('rehydrates an untouched draft from a same-id authored refresh', async () => {
    const current = props()
    await act(async () => root.render(createElement(ProviderResources, current)))

    await act(async () =>
      root.render(
        createElement(ProviderResources, {
          ...current,
          selected: detail(1, 'concurrently changed model'),
        }),
      ),
    )

    expect((container.querySelector('[aria-label="Model 1 name"]') as HTMLInputElement).value).toBe(
      'concurrently changed model',
    )
    expect(container.textContent).not.toContain('Save changes first to Validate or Share.')
  })

  it('keeps default selection on its stable row through temporary duplicate names', async () => {
    await act(async () => root.render(createElement(ProviderResources, props())))
    await act(async () => button(container, 'Add model').click())
    const names = () => [
      ...container.querySelectorAll<HTMLInputElement>(
        '[aria-label^="Model "][aria-label$=" name"]',
      ),
    ]
    const defaults = () => [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid="provider-model-default"]'),
    ]

    await setInput(names()[1], ' exact model ')
    expect(defaults().map((candidate) => candidate.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
    ])

    await setInput(names()[1], 'second exact model')
    expect(defaults().map((candidate) => candidate.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
    ])
  })

  it('serializes draft, Close and inventory actions while Validate is pending', async () => {
    const result = deferred<Awaited<ReturnType<ProviderResourcesProps['onValidate']>>>()
    const current = props()
    current.onValidate = vi.fn(() => result.promise)
    await act(async () => root.render(createElement(ProviderResources, current)))
    await act(async () => button(container, 'Connection checks').click())

    await act(async () => {
      button(container, 'Validate').click()
      await Promise.resolve()
    })

    expect(
      (container.querySelector('[data-testid="provider-name"]') as HTMLInputElement).disabled,
    ).toBe(true)
    expect(button(container, 'Close').disabled).toBe(true)
    expect(
      (container.querySelector('[title="Edit Secondary"]') as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (container.querySelector('[title="Delete Secondary"]') as HTMLButtonElement).disabled,
    ).toBe(true)

    await act(async () => {
      result.resolve({
        capability: 'completion',
        result: {
          status: 'ready',
          checkedAt: '2026-08-31T00:00:00.000Z',
          diagnostic: null,
          credentialProven: true,
        },
        saved: true,
        resource: current.selected!.resource,
      })
      await result.promise
    })
  })

  it('serializes the form after a selected Delete is confirmed', async () => {
    const removed = deferred<void>()
    const current = props()
    current.onDelete = vi.fn(() => removed.promise)
    dialog.confirm.mockResolvedValue(true)
    await act(async () => root.render(createElement(ProviderResources, current)))

    await act(async () => {
      ;(container.querySelector('[title="Delete Primary"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(
      (container.querySelector('[data-testid="provider-name"]') as HTMLInputElement).disabled,
    ).toBe(true)
    expect(button(container, 'Close').disabled).toBe(true)
    expect(
      (container.querySelector('[title="Edit Secondary"]') as HTMLButtonElement).disabled,
    ).toBe(true)

    await act(async () => {
      removed.resolve()
      await removed.promise
    })
  })

  it('serializes the old form while a new provider detail is loading', async () => {
    const selected = deferred<void>()
    const current = props()
    current.onSelect = vi.fn(() => selected.promise)
    await act(async () => root.render(createElement(ProviderResources, current)))

    await act(async () => {
      ;(container.querySelector('[title="Edit Secondary"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(
      (container.querySelector('[data-testid="provider-name"]') as HTMLInputElement).disabled,
    ).toBe(true)
    expect(button(container, 'Close').disabled).toBe(true)
    expect(
      (container.querySelector('[title="Delete Primary"]') as HTMLButtonElement).disabled,
    ).toBe(true)

    await act(async () => {
      selected.resolve()
      await selected.promise
    })
  })
})
