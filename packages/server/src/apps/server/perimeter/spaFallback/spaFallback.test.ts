import { describe, expect, it } from 'vitest'

import { spaFallbackDecision, spaRequestDecision } from './spaFallback'

describe('spaFallbackDecision', () => {
  it.each([
    '/api',
    '/api/missing',
    '/api%2Fmissing',
    '/api%252Fmissing',
    '//api//missing',
    '/browser/../api/missing',
    '/browser/%2e%2e/api/missing',
    String.raw`/browser\..\api\missing`,
    '/mcp/missing',
    '/oauth/missing',
    '/.well-known/missing',
  ])('keeps canonical server namespace %s out of the SPA fallback', (url) => {
    expect(spaFallbackDecision(url)).toBe('not-found')
  })

  it.each(['/', '/n/note-id/slug', '/apiary', '/projects/api', '/?next=/api/missing'])(
    'allows ordinary browser route %s',
    (url) => {
      expect(spaFallbackDecision(url)).toBe('serve-spa')
    },
  )

  it.each([
    '/broken/%',
    '/broken/%zz',
    '/%25252525252525252fapi',
    '/bad%00path',
    '/browser#x/../api/missing',
    '/#/../api',
  ])('rejects path %s when layers cannot canonicalise it consistently', (url) => {
    expect(spaFallbackDecision(url)).toBe('bad-request')
  })

  it.each([
    '/api/health',
    '/mcp',
    '/oauth/authorize',
    '/.well-known/oauth-protected-resource',
    '/n/note-id/slug',
  ])('lets the direct route %s reach the application router', (url) => {
    expect(spaRequestDecision(url)).toBe('continue')
  })

  it.each([
    '/api%2Fmissing',
    '/api%252Fmissing',
    '//api//missing',
    '/browser/../api/missing',
    '/browser/%2e%2e/api/missing',
    String.raw`/browser\..\api\missing`,
  ])('blocks disguised server namespace %s before static handling', (url) => {
    expect(spaRequestDecision(url)).toBe('not-found')
  })

  it.each([
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/browser/./note',
    '/broken/%',
    '/browser#x/../api/missing',
    '/#/../api',
    '/api#/../n',
  ])('blocks ambiguous static path %s before static handling', (url) => {
    expect(spaRequestDecision(url)).toBe('bad-request')
  })
})
