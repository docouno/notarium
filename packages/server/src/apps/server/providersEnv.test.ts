import { describe, expect, it } from 'vitest'

import {
  providerCallLogRetentionFromEnv,
  providersEnabledFromEnv,
  providersPrivateOriginsFromEnv,
} from './providersEnv'

describe('providersEnabledFromEnv', () => {
  it('ships disabled and accepts only the two declared values', () => {
    expect(providersEnabledFromEnv(undefined)).toBe(false)
    expect(providersEnabledFromEnv('false')).toBe(false)
    expect(providersEnabledFromEnv('true')).toBe(true)
    expect(() => providersEnabledFromEnv('on')).toThrow(/PROVIDERS_ENABLED.*true.*false/)
  })
})

describe('providersPrivateOriginsFromEnv', () => {
  it('ships empty and canonicalizes plus deduplicates exact origins', () => {
    expect([...providersPrivateOriginsFromEnv(undefined)]).toEqual([])
    expect([...providersPrivateOriginsFromEnv('  ')]).toEqual([])
    expect([
      ...providersPrivateOriginsFromEnv(
        'https://API.Vendor.COM:443, https://api.vendor.com, https://пример.рф',
      ),
    ]).toEqual(['https://api.vendor.com', 'https://xn--e1afmkfd.xn--p1ai'])
  })

  it('keeps operator admission exact across hosts and ports', () => {
    const origins = providersPrivateOriginsFromEnv('http://host.docker.internal:11434')

    expect(origins.has('http://host.docker.internal:11434')).toBe(true)
    expect(origins.has('http://host.docker.internal:11435')).toBe(false)
    expect(origins.has('http://other.internal:11434')).toBe(false)
  })

  it.each([
    '',
    'http://[:::]',
    'https://vendor.exa\tmple',
    'https://vendor.example\n.evil',
    'https://vendor.example\r.evil',
    'https://vendor.example/',
    'https://vendor.example/v1',
    'https://*.example.com',
    'https://10.0.0.0/8',
    'https://user@example.com',
    'https://vendor.example?q=1',
    'https://vendor.example#fragment',
    'ftp://vendor.example',
  ])('rejects non-origin syntax without echoing the value: %s', (invalid) => {
    const raw = `https://allowed.example,${invalid}`

    expect(() => providersPrivateOriginsFromEnv(raw)).toThrow(/PROVIDERS_PRIVATE_ORIGINS.*item 2/)
    try {
      providersPrivateOriginsFromEnv(raw)
    } catch (error) {
      expect((error as Error).message).not.toContain('allowed.example')
      if (invalid) {
        expect((error as Error).message).not.toContain(invalid)
      }
    }
  })
})

describe('providerCallLogRetentionFromEnv', () => {
  it('defaults to 90 days and keeps a closed operator vocabulary', () => {
    expect(providerCallLogRetentionFromEnv(undefined)).toBe(90)
    expect(providerCallLogRetentionFromEnv('30')).toBe(30)
    expect(providerCallLogRetentionFromEnv('365')).toBe(365)
    expect(providerCallLogRetentionFromEnv('forever')).toBeNull()
    expect(() => providerCallLogRetentionFromEnv('0')).toThrow(/30, 90, 365, or forever/)
  })
})
