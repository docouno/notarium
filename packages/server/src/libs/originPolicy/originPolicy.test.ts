import { describe, expect, it } from 'vitest'

import { ADDRESS_CLASS } from './consts'
import {
  canonicalOriginOf,
  classifyIpAddress,
  isAlwaysDeniedAddress,
  isPrivateAddress,
  literalAddressClassOf,
  normalizeIpAddress,
} from './originPolicy'

describe('origin policy', () => {
  it('canonicalizes exact origins without prefix or default-port ambiguity', () => {
    expect(canonicalOriginOf('https://API.Vendor.COM:443')).toBe('https://api.vendor.com')
    expect(canonicalOriginOf('https://api.vendor.com.')).toBe('https://api.vendor.com')
    expect(canonicalOriginOf('https://пример.рф')).toBe('https://xn--e1afmkfd.xn--p1ai')
    expect(canonicalOriginOf('http://[2001:0DB8:0:0:0:0:0:1]:80')).toBe('http://[2001:db8::1]')
    expect(canonicalOriginOf('https://api.vendor.com')).not.toBe(
      canonicalOriginOf('https://api.vendor.com.evil.tld'),
    )
  })

  it.each([
    'https://vendor.example/',
    'https://vendor.example/v1',
    'https://user@vendor.example',
    'https://vendor.example?q=1',
    'https://vendor.example#fragment',
    'ftp://vendor.example',
    'https://vendor.exa\tmple',
  ])('rejects non-origin syntax: %s', (value) => {
    expect(() => canonicalOriginOf(value)).toThrow(/exact HTTP\(S\) origin/)
  })

  it.each([
    ['::ffff:168.63.129.16', '168.63.129.16'],
    ['::168.63.129.16', '168.63.129.16'],
    ['64:ff9b::168.63.129.16', '168.63.129.16'],
    ['FE80:0000:0000:0000:0000:0000:0000:0001', 'fe80::1'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
  ])('normalizes semantic address spellings before policy: %s', (value, expected) => {
    expect(normalizeIpAddress(value)).toBe(expected)
  })

  it.each([
    '::ffff:169.254.1.1',
    '::169.254.169.254',
    '64:ff9b::169.254.169.254',
    'FE80:0000:0000:0000:0000:0000:0000:0001',
    'FD00:0EC2:0000:0000:0000:0000:0000:0254',
    '::ffff:168.63.129.16',
    '64:ff9b::100.100.100.200',
  ])('always denies metadata/link-local addresses after normalization: %s', (value) => {
    expect(isAlwaysDeniedAddress(value)).toBe(true)
    expect(classifyIpAddress(value)).toBe(ADDRESS_CLASS.alwaysDenied)
  })

  it('keeps unparseable input fail-closed without misclassifying it as private', () => {
    expect(isAlwaysDeniedAddress('')).toBe(true)
    expect(isAlwaysDeniedAddress('not-an-address')).toBe(true)
    expect(isPrivateAddress('not-an-address')).toBe(false)
  })

  it('classifies public, private and loopback addresses independently', () => {
    expect(classifyIpAddress('203.0.113.10')).toBe(ADDRESS_CLASS.public)
    expect(classifyIpAddress('10.1.2.3')).toBe(ADDRESS_CLASS.private)
    expect(classifyIpAddress('::1')).toBe(ADDRESS_CLASS.loopback)
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
  })

  it.each([
    ['198.18.0.1', ADDRESS_CLASS.private],
    ['::ffff:198.18.0.1', ADDRESS_CLASS.private],
    ['::198.18.0.1', ADDRESS_CLASS.private],
    ['64:ff9b::198.18.0.1', ADDRESS_CLASS.private],
    ['fec0::1', ADDRESS_CLASS.private],
    ['0.0.0.0', ADDRESS_CLASS.alwaysDenied],
    ['::', ADDRESS_CLASS.alwaysDenied],
    ['224.0.0.1', ADDRESS_CLASS.alwaysDenied],
    ['::ffff:224.0.0.1', ADDRESS_CLASS.alwaysDenied],
    ['64:ff9b::224.0.0.1', ADDRESS_CLASS.alwaysDenied],
    ['ff02::1', ADDRESS_CLASS.alwaysDenied],
  ])('fails closed for special-use and non-unicast address %s', (address, expected) => {
    expect(classifyIpAddress(address)).toBe(expected)
  })

  it('decides only literals and localhost without DNS', () => {
    expect(literalAddressClassOf('localhost')).toBe(ADDRESS_CLASS.loopback)
    expect(literalAddressClassOf('[::1]')).toBe(ADDRESS_CLASS.loopback)
    expect(literalAddressClassOf('api.vendor.com')).toBeNull()
  })
})
