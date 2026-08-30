import { describe, expect, it } from 'vitest'
import type { Credential, ProviderResource } from '@notarium/contract'

import { providerDisclosureLabel } from './ProviderAttachments'
import { credentialPatchOf } from './ProviderCredentials'
import { providerHeaderPatchOf, providerResourcePatchOf } from './ProviderResources'

const credential: Credential = {
  id: 'credential-1',
  name: 'OpenRouter',
  kind: 'bearer',
  origin: 'https://openrouter.ai',
  injection: { header: '', prefix: 'Bearer ' },
  disabledAt: null,
  rpm: null,
  tpm: 10_000,
  consentEpoch: 2,
  runtimeEpoch: 3,
}

const resource: ProviderResource = {
  id: 'resource-1',
  name: 'Primary',
  wire: 'openai-compatible',
  owner: { kind: 'user', name: 'alice', mine: true },
  baseUrl: 'https://openrouter.ai/api/v1',
  headerNames: ['x-change', 'x-keep', 'x-remove'],
  addressIsPrivate: false,
  allowPrivateNetwork: false,
  purposes: ['chat'],
  models: [{ name: 'openai/gpt-5', dimensions: null, status: 'available' }],
  defaultModel: 'openai/gpt-5',
  credentialId: credential.id,
  hasCredentials: true,
  vendor: 'openrouter',
  consentEpoch: 1,
  runtimeEpoch: 1,
  disabledAt: null,
  lastCheck: {},
  firstByteTimeoutMs: null,
  callTimeoutMs: null,
}

describe('provider management form projections', () => {
  it('keeps a blank replacement secret out of a credential patch', () => {
    expect(
      credentialPatchOf(credential, {
        name: 'OpenRouter renamed',
        kind: 'bearer',
        secret: '',
        origin: credential.origin,
        header: '',
        prefix: 'Bearer ',
        rpm: '',
        tpm: '10000',
        disabled: false,
      }),
    ).toEqual({ name: 'OpenRouter renamed' })
  })

  it('builds a header patch whose blank existing values retain their ciphertexts', () => {
    const headers = [
      { key: '1', originalName: 'x-keep', name: 'x-keep', value: '', remove: false },
      { key: '2', originalName: 'x-change', name: 'x-change', value: 'new', remove: false },
      { key: '3', originalName: 'x-remove', name: 'x-remove', value: '', remove: true },
      { key: '4', originalName: null, name: 'X-New', value: 'added', remove: false },
    ]

    expect(providerHeaderPatchOf(headers)).toEqual({
      'x-change': 'new',
      'x-remove': null,
      'X-New': 'added',
    })
    expect(
      providerResourcePatchOf(resource, {
        name: resource.name,
        wire: resource.wire,
        baseUrl: resource.baseUrl!,
        allowPrivateNetwork: false,
        purposes: ['chat'],
        modelNames: 'openai/gpt-5',
        defaultModel: 'openai/gpt-5',
        credentialId: credential.id,
        firstByteTimeoutMs: '',
        callTimeoutMs: '',
        disabled: false,
        headers,
      }),
    ).toEqual({ headers: { 'x-change': 'new', 'x-remove': null, 'X-New': 'added' } })
  })

  it('bounds and flattens provider-controlled names before consent rendering', () => {
    const hostile = `<strong>trusted</strong>\n${'x'.repeat(160)}`
    const label = providerDisclosureLabel(hostile)

    expect(label).not.toContain('\n')
    expect(label.length).toBeLessThanOrEqual(120)
    expect(label.endsWith('…')).toBe(true)
  })
})
