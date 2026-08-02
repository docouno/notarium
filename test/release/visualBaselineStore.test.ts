import { describe, expect, it } from 'vitest'

import { encodeKey, presignGet } from '../../scripts/visualBaselineStore.mjs'

const credentials = {
  endpoint: 'https://s3.example.com',
  region: 'test-region-1',
  keyId: 'EXAMPLEKEYID',
  secret: 'EXAMPLESECRET',
}

describe('object key encoding', () => {
  it('keeps separators and escapes each segment', () => {
    expect(encodeKey('v1/blobs/sha256/abc')).toBe('v1/blobs/sha256/abc')
  })

  it('escapes the characters encodeURIComponent leaves behind', () => {
    // The whole reason this is not encodeURIComponent: S3 escapes these and a key
    // signed one way and sent another fails as an unexplained 403.
    expect(encodeKey("!'()*")).toBe('%21%27%28%29%2A')
  })

  it('escapes spaces and the query/auth delimiters a cell name can contain', () => {
    // Visual cells are named from human-readable state ("rail open · aside closed"),
    // so these are ordinary keys here, not exotic ones.
    expect(encodeKey('reviews/1/odd (name)+&=@.png')).toBe(
      'reviews/1/odd%20%28name%29%2B%26%3D%40.png',
    )
  })
})

describe('presigned GET', () => {
  it('carries every parameter the verifier needs, and a signature', () => {
    const url = new URL(presignGet(credentials, 'bucket', 'v1/blobs/sha256/abc', 900))

    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('X-Amz-Credential')).toContain('test-region-1/s3/aws4_request')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('addresses the bucket path-style, so a dotted bucket name cannot break TLS', () => {
    const url = new URL(presignGet(credentials, 'bucket', 'v1/blobs/sha256/abc'))

    expect(url.host).toBe('s3.example.com')
    expect(url.pathname).toBe('/bucket/v1/blobs/sha256/abc')
  })

  it('refuses an expiry SigV4 cannot express', () => {
    // Seven days is the protocol ceiling. Silently clamping would hand out links that
    // die earlier than the caller was told.
    expect(() => presignGet(credentials, 'bucket', 'key', 604801)).toThrow(/7 days/)
  })

  it('signs differently for different keys, so a link cannot be repointed', () => {
    const a = new URL(presignGet(credentials, 'bucket', 'v1/blobs/sha256/aaa'))
    const b = new URL(presignGet(credentials, 'bucket', 'v1/blobs/sha256/bbb'))

    expect(a.searchParams.get('X-Amz-Signature')).not.toBe(b.searchParams.get('X-Amz-Signature'))
  })
})
