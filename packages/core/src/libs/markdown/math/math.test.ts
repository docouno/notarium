import { describe, expect, it } from 'vitest'

import { hasDollarMathPair, mathBlockStart, mathInlineStart } from './math'

const previousMathBlockStart = (source: string): number | undefined => {
  const match = /\n {0,3}(?:\$\$|\\\[)/.exec(source)
  return match ? match.index + 1 : undefined
}

describe('math start hooks', () => {
  it('keeps only the dollar opener on the inline path', () => {
    expect(mathInlineStart('a$b')).toBe(1)
    expect(mathInlineStart('$')).toBe(0)
    expect(mathInlineStart('abc')).toBeUndefined()
    expect(mathInlineStart('a\\(b\\) c\\[d\\]')).toBeUndefined()
  })

  it('opens the expensive inline start hint only when dollar math can close', () => {
    expect(hasDollarMathPair('$ price')).toBe(false)
    expect(hasDollarMathPair('$x$')).toBe(true)
    expect(hasDollarMathPair('$$')).toBe(true)
    expect(hasDollarMathPair('plain')).toBe(false)
  })

  it('matches the previous display-math scan on an exhaustive short corpus', () => {
    const alphabet = ['\n', ' ', '$', '\\', '[', ']', 'x']
    let inputs = ['']

    for (let length = 0; length <= 7; length++) {
      for (const input of inputs) {
        expect(mathBlockStart(input)).toBe(previousMathBlockStart(input))
      }
      inputs = inputs.flatMap((prefix) => alphabet.map((char) => prefix + char))
    }
  })

  it('finds the earliest valid opener and rejects four-space indentation', () => {
    expect(mathBlockStart('a\n   \\[x\n $$y')).toBe(2)
    expect(mathBlockStart('a\n    $$x')).toBeUndefined()
    expect(mathBlockStart('a\r\n$$x')).toBe(3)
  })
})
