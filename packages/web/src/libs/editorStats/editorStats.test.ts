import { describe, expect, it } from 'vitest'

import { textStats } from './editorStats'

describe('textStats', () => {
  it('counts words and raw characters', () => {
    const s = textStats('Hello world')
    expect(s.words).toBe(2)
    expect(s.chars).toBe(11)
  })

  it('chars is the raw body length — markdown syntax included', () => {
    expect(textStats('**bold**').chars).toBe(8)
  })

  it('reuses core countWords: fenced/inline code is out of the WORD count', () => {
    const body = 'prose words here\n```js\nconst hidden = true\n```\nand `inline` too'
    // "prose words here ... and too" → 5 prose words, code stripped
    expect(textStats(body).words).toBe(5)
  })

  it('reading time rounds up; empty is 0, any prose is at least 1 min', () => {
    expect(textStats('').minutes).toBe(0)
    expect(textStats('one two three').minutes).toBe(1)
    const longText = Array.from({ length: 450 }, (_, i) => `word${i}`).join(' ')
    expect(textStats(longText).minutes).toBe(3) // ceil(450 / 200)
  })
})
