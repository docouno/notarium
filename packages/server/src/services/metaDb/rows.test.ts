import { describe, expect, it } from 'vitest'

import { providerResourceOfRow, type ProviderResourceRow } from './rows'

const row = (): ProviderResourceRow => ({
  id: 'resource-1',
  owner: 'user-1',
  name: 'Primary',
  wire: 'openai-compatible',
  base_url: 'https://provider.example/v1',
  headers: '{}',
  allow_private_network: false,
  models: JSON.stringify([
    {
      name: 'model',
      capabilities: ['completion'],
      dimensions: null,
      statusByCapability: { completion: 'available' },
    },
  ]),
  default_model: 'model',
  credential_id: null,
  consent_epoch: 0,
  runtime_epoch: 0,
  disabled_at: null,
  last_check: '{}',
  first_byte_timeout_ms: null,
  call_timeout_ms: null,
})

describe('provider persistence row codec', () => {
  it('decodes a canonical provider resource', () => {
    expect(providerResourceOfRow(row())).toMatchObject({
      id: 'resource-1',
      defaultModel: 'model',
      models: [{ name: 'model', statusByCapability: { completion: 'available' } }],
    })
  })

  it('refuses malformed model capability state and dangling defaults', () => {
    expect(() =>
      providerResourceOfRow({
        ...row(),
        models: JSON.stringify([
          {
            name: 'model',
            capabilities: ['completion', 'embedding'],
            dimensions: null,
            statusByCapability: { completion: 'available' },
          },
        ]),
      }),
    ).toThrow()
    expect(() => providerResourceOfRow({ ...row(), default_model: 'missing' })).toThrow(
      'provider default model must name one exact stored model',
    )
    expect(() =>
      providerResourceOfRow({
        ...row(),
        last_check: JSON.stringify({
          embedding: {
            status: 'ready',
            checkedAt: '2026-08-31T00:00:00.000Z',
            diagnostic: null,
            credentialProven: true,
          },
        }),
      }),
    ).toThrow('provider last check requires a configured model capability')
  })
})
