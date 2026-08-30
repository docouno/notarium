import { describe, expect, it } from 'vitest'
import { carriesWholeSecret, detectSecretWarnings, looksLikeSecret } from '@notarium/contract'

describe('provider secret-pattern roles', () => {
  it('preserves the deliberately narrow MCP nudge', () => {
    expect(detectSecretWarnings('ordinary note body')).toEqual([])
    expect(detectSecretWarnings('token = "sk-abcdefghijklmnopqrstuvwxyz"')).toEqual([
      'possible-secret',
    ])
  })

  it.each([
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
    'gsk_abcdefghijklmnopqrstuvwxyz',
    'hf_abcdefghijklmnopqrstuvwxyz',
    '0123456789abcdef0123456789abcdef',
    'AbCdEf0123456789AbCdEf0123456789',
    'Basic dXNlcjpwYXNzd29yZA==',
  ])('warns on provider secret %s', (value) => {
    expect(looksLikeSecret(value)).toBe(true)
  })

  it.each(['anthropic-version', 'HTTP-Referer', 'X-Title', 'Accept', 'Content-Type', 'User-Agent'])(
    'stays quiet on ordinary header text %s',
    (value) => expect(looksLikeSecret(value)).toBe(false),
  )

  it('blocks a complete secret in injection.prefix but accepts legal prefixes', () => {
    expect(carriesWholeSecret('Bearer sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true)
    expect(carriesWholeSecret('Bearer ')).toBe(false)
    expect(carriesWholeSecret('Basic ')).toBe(false)
    expect(carriesWholeSecret('Token ')).toBe(false)
    expect(carriesWholeSecret('ApiKey ')).toBe(false)
  })
})
