import { describe, expect, it } from 'vitest'

import { trustProxyFromEnv } from './trustProxy'

describe('trustProxyFromEnv', () => {
  it('keeps forwarded headers untrusted when unset', () => {
    expect(trustProxyFromEnv(undefined)).toBe(false)
    expect(trustProxyFromEnv('  ')).toBe(false)
  })

  it('accepts only an explicit comma-separated IP/CIDR allowlist', () => {
    expect(trustProxyFromEnv('127.0.0.1, 172.18.0.0/16, 2001:db8::/32')).toEqual([
      '127.0.0.1',
      '172.18.0.0/16',
      '2001:db8::/32',
    ])
  })

  it.each(['true', '1', 'loopback', '10.0.0.0/0', '10.0.0.0/33', '127.0.0.1,'])(
    'rejects an unsafe or malformed allowlist: %s',
    (raw) => {
      expect(() => trustProxyFromEnv(raw)).toThrow(/TRUST_PROXY/)
    },
  )
})
