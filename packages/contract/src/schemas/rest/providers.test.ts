import { describe, expect, it } from 'vitest'

import { PROVIDER_LIMIT, PROVIDER_LIST_PAGE_SIZE } from '../../consts/providers'
import { CredentialsResponseSchema } from './credentials'
import {
  ProviderAttachmentDetailResponseSchema,
  ProviderAttachmentsResponseSchema,
} from './providerAttachments'
import {
  ProviderEffectiveResponseSchema,
  ProviderInventoryQuerySchema,
  ProviderResourcePatchRequestSchema,
  ProviderResourcesResponseSchema,
  ProviderResourceStatusesRequestSchema,
  ProviderResourceStatusesResponseSchema,
} from './providers'

describe('provider resource patch contract', () => {
  it('keeps the header operation map non-empty and within the contour cap', () => {
    expect(ProviderResourcePatchRequestSchema.safeParse({ headers: {} }).success).toBe(false)
    expect(
      ProviderResourcePatchRequestSchema.safeParse({
        headers: Object.fromEntries(
          Array.from({ length: PROVIDER_LIMIT.headers + 1 }, (_, index) => [`x-${index}`, null]),
        ),
      }).success,
    ).toBe(false)
    expect(
      ProviderResourcePatchRequestSchema.safeParse({ headers: { 'x-one': null } }).success,
    ).toBe(true)
  })
})

describe('provider inventory pages', () => {
  const owner = { kind: 'user' as const, name: 'alice', mine: true }

  it('has one fixed page size and accepts only an opaque cursor query', () => {
    expect(PROVIDER_LIST_PAGE_SIZE).toBe(100)
    expect(ProviderInventoryQuerySchema.parse({ cursor: 'opaque-next' })).toEqual({
      cursor: 'opaque-next',
    })
    expect(ProviderInventoryQuerySchema.safeParse({ limit: 500 }).success).toBe(false)
    expect(ProviderInventoryQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
  })

  it('keeps credential inventory compact and cursor-paged', () => {
    const page = CredentialsResponseSchema.parse({
      items: [
        {
          id: 'credential-1',
          name: 'Primary',
          kind: 'bearer',
          origin: 'https://provider.example',
          disabledAt: null,
          rpm: 60,
          tpm: null,
        },
      ],
      total: 101,
      nextCursor: 'opaque-next',
    })

    expect(page.items[0]).not.toHaveProperty('injection')
    expect(page.nextCursor).toBe('opaque-next')
  })

  it('keeps resource inventories compact while effective rows retain invalidity', () => {
    const resource = {
      id: 'resource-1',
      name: 'Primary',
      wire: 'openai-compatible' as const,
      owner,
      baseUrl: 'https://provider.example/v1',
      addressIsPrivate: false,
      purposes: ['chat' as const],
      modelCount: 512,
      hasCredentials: true,
      disabledAt: null,
    }
    const owned = ProviderResourcesResponseSchema.parse({
      items: [resource],
      total: 101,
      nextCursor: 'owned-next',
    })
    const effective = ProviderEffectiveResponseSchema.parse({
      items: [{ resource, unusableBecause: 'credential-disabled' }],
      total: 1,
      nextCursor: null,
    })

    expect(owned.items[0]).not.toHaveProperty('models')
    expect(owned.items[0].modelCount).toBe(512)
    expect(effective.items[0].unusableBecause).toBe('credential-disabled')
  })

  it('bounds a unique status batch and keeps its response address-free', () => {
    const ids = Array.from({ length: PROVIDER_LIST_PAGE_SIZE }, (_, index) => `resource-${index}`)

    expect(ProviderResourceStatusesRequestSchema.parse({ ids })).toEqual({ ids })
    expect(ProviderResourceStatusesRequestSchema.safeParse({ ids: [] }).success).toBe(false)
    expect(
      ProviderResourceStatusesRequestSchema.safeParse({ ids: [...ids, 'overflow'] }).success,
    ).toBe(false)
    expect(
      ProviderResourceStatusesRequestSchema.safeParse({ ids: ['resource-1', 'resource-1'] })
        .success,
    ).toBe(false)

    const response = ProviderResourceStatusesResponseSchema.parse({
      items: [{ id: 'resource-1', unusableBecause: 'credential-disabled' }],
    })
    expect(response).toEqual({
      items: [{ id: 'resource-1', unusableBecause: 'credential-disabled' }],
    })
    expect(
      ProviderResourceStatusesResponseSchema.safeParse({
        items: [
          {
            id: 'resource-1',
            unusableBecause: null,
            baseUrl: 'https://private-provider.example/v1',
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('keeps consent pages compact and carries the full decision in exact detail', () => {
    const disclosure = {
      targetSpace: 'space-main',
      resourceOwner: 'alice',
      baseUrl: 'https://provider.example/v1',
      purposes: ['chat' as const],
      models: [],
      allowPrivateNetwork: false,
      headerNames: [],
    }
    const attachment = {
      id: 'attachment-1',
      resourceId: 'resource-1',
      targetKind: 'space' as const,
      targetId: 'space-main',
      targetSpace: 'space-main',
      state: 'pending' as const,
      createdAt: '2026-08-30T00:00:00.000Z',
      expiresAt: '2026-09-13T00:00:00.000Z',
    }
    const resource = {
      id: 'resource-1',
      name: 'Primary',
      wire: 'openai-compatible' as const,
      owner,
      addressIsPrivate: false,
      purposes: ['chat' as const],
      modelCount: 0,
      hasCredentials: false,
      disabledAt: null,
    }
    const page = ProviderAttachmentsResponseSchema.parse({
      items: [{ attachment, resource }],
      total: 101,
      nextCursor: 'attachment-next',
    })
    const detail = ProviderAttachmentDetailResponseSchema.parse({
      view: {
        attachment: {
          ...attachment,
          resourceEpoch: null,
          credentialEpoch: null,
          disclosure: null,
        },
        resource: {
          ...resource,
          models: [],
          defaultModel: null,
          consentEpoch: 1,
          runtimeEpoch: 1,
          lastCheck: {},
        },
        currentEpochs: { resourceEpoch: 1, credentialEpoch: null },
        currentDisclosure: disclosure,
        diff: { before: null, after: disclosure, changed: true },
      },
    })

    expect(page.items[0]).not.toHaveProperty('currentDisclosure')
    expect(detail.view.currentDisclosure.baseUrl).toBe('https://provider.example/v1')
    expect(page.nextCursor).toBe('attachment-next')
  })
})
