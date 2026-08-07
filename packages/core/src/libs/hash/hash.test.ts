import { describe, expect, it } from 'vitest'

import { pathHash, sha256Hex } from './hash'

describe('pathHash', () => {
  it('is the first 96 bits of SHA-256 for ASCII and Unicode input', async () => {
    for (const value of ['', 'abc', '第三季度规划', '🎉'.repeat(100)]) {
      expect(pathHash(value)).toBe((await sha256Hex(value)).slice(0, 24))
    }
  })
})
