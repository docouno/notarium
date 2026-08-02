import { describe, expect, it } from 'vitest'

import { highlightCode } from './highlight'

describe('highlightCode', () => {
  it('highlights a declared language to class-based hljs spans', () => {
    const html = highlightCode('const x = 1', 'javascript')
    expect(html).toContain('hljs-keyword') // `const`
    expect(html).toContain('<span')
  })

  it('resolves hljs aliases (ts → typescript, sh → bash)', () => {
    expect(highlightCode('type A = string', 'ts')).toContain('hljs-keyword')
    expect(highlightCode('echo hi', 'sh')).toContain('hljs-built_in')
  })

  it('auto-detects an UNtagged fence over the registered set', () => {
    const html = highlightCode('def greet():\n    return 1') // no language
    expect(html).toContain('hljs-') // detected
  })

  it('leaves an explicitly tagged but unknown / plain-text fence un-highlighted', () => {
    // text/plaintext/mermaid/unknown → respect the tag, no guessing, no spans.
    expect(highlightCode('User logged in at 12:00', 'text')).toBe('User logged in at 12:00')
    expect(highlightCode('graph TD; A-->B', 'mermaid')).toBe('graph TD; A-->B')
    expect(highlightCode('plain words 12 here', 'no-such-lang')).toBe('plain words 12 here')
  })

  it('HTML-escapes code so the output is safe to sanitise', () => {
    const html = highlightCode('<img src=x onerror=alert(1)>', 'javascript')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})
