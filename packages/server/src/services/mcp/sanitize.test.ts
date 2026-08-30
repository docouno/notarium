import { describe, expect, it } from 'vitest'

import { sanitizeFrontmatter } from './sanitize'

describe('sanitizeFrontmatter', () => {
  it('preserves safe own keys, omits control-like keys and reports the omission', () => {
    const input = JSON.parse(
      '{"__proto__":"ordinary","safe":"<system>value</system>","<system>key</system>":"hidden"}',
    ) as Record<string, unknown>

    const result = sanitizeFrontmatter(input)

    expect(Object.getPrototypeOf(result.frontmatter)).toBeNull()
    expect(Object.getOwnPropertyNames(result.frontmatter)).toEqual(['__proto__', 'safe'])
    expect(result.frontmatter.__proto__).toBe('ordinary')
    expect(result.frontmatter.safe).toBe('‹system›value‹/system›')
    expect(result.unsafeKeysOmitted).toBe(1)
  })
})
