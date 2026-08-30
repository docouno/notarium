import { afterEach, describe, expect, it, vi } from 'vitest'

import { providerAttachmentsApi } from './providerAttachments'
import { providerInventoryQuery } from './providerPagination'
import { providersApi } from './providers'

const resource = (id: string) => ({
  id,
  name: `Resource ${id}`,
  wire: 'openai-compatible',
  owner: { kind: 'user', name: 'alice', mine: true },
  baseUrl: 'https://provider.example/v1',
  addressIsPrivate: false,
  purposes: ['chat'],
  modelCount: 1,
  hasCredentials: true,
  disabledAt: null,
})

afterEach(() => vi.unstubAllGlobals())

describe('provider inventory query', () => {
  it('sends only the opaque continuation cursor', () => {
    expect(providerInventoryQuery()).toBe('')
    expect(providerInventoryQuery({ cursor: 'next/+ page' })).toBe('?cursor=next%2F%2B+page')
  })

  it('reads one fresh effective row through one exact request', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        calls.push(url)
        const next = {
          resource: resource('target'),
          unusableBecause: 'credential-disabled',
        }

        return new Response(JSON.stringify(next), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    await expect(providersApi.providerEffectiveDetail('target')).resolves.toMatchObject({
      resource: { id: 'target' },
      unusableBecause: 'credential-disabled',
    })
    expect(calls).toEqual(['/api/providers/effective/target'])
  })

  it('reads owned statuses through one address-free batch request', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ id: 'resource-1', unusableBecause: 'credential-disabled' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetch)

    await expect(providersApi.providerResourceStatuses(['resource-1'])).resolves.toEqual({
      items: [{ id: 'resource-1', unusableBecause: 'credential-disabled' }],
    })
    expect(fetch).toHaveBeenCalledWith('/api/providers/resources/statuses', {
      method: 'POST',
      body: JSON.stringify({ ids: ['resource-1'] }),
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('addresses one attachment detail without replaying its space page', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ view: { attachment: { id: 'offer/one' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetch)

    await expect(providerAttachmentsApi.providerAttachmentDetail('offer/one')).resolves.toEqual({
      view: { attachment: { id: 'offer/one' } },
    })
    expect(fetch).toHaveBeenCalledWith('/api/providers/attachments/offer%2Fone', expect.anything())
  })
})
