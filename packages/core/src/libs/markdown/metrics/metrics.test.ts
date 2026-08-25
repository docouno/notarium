import { describe, expect, it } from 'vitest'

import { TOKEN_ESTIMATE } from './consts'
import { countWords, curateBudget, estimateTokens, tokenBudgetLoadedCount } from './metrics'

describe('countWords', () => {
  it('counts words ignoring code and tags', () => {
    const body = 'One two `skip me` three\n```\nnope\n```\n<b>four</b>'
    expect(countWords(body)).toBe(4)
  })

  // These take a BODY. Re-deciding where metadata ends is what let one document get two
  // answers — a preview whose snippet held a paragraph its own word count had thrown away
  // because a normalisation step in between had turned that prose into a leading block.
  it('counts what it is given, without hunting for a leading block', () => {
    expect(countWords('---\ntitle: x\n---\nOne two')).toBe(countWords('title x One two'))
  })
})

describe('estimateTokens', () => {
  it('splits ASCII from non-ASCII and divides each by its coefficient', () => {
    // 8 ASCII chars → 8/4 = 2; 6 Cyrillic chars → 6/2 = 3; rounded sum = 5.
    expect(estimateTokens('abcdefghПривет')).toBe(Math.round(8 / 4 + 6 / 2))
  })
  it('weighs what it is given — the caller decides what the body is', () => {
    const withFm = '---\ntitle: Some Long Title Here\n---\nabcd'
    expect(estimateTokens(withFm)).toBeGreaterThan(estimateTokens('abcd'))
  })
  it('counts code as real content (unlike countWords)', () => {
    expect(estimateTokens('```\nconst x = 1\n```')).toBeGreaterThan(0)
  })
  it('charges Cyrillic more tokens per char than Latin of the same length', () => {
    const latin = 'abcdefghij'
    const cyr = 'абвгдежзий'
    expect(estimateTokens(cyr)).toBeGreaterThan(estimateTokens(latin))
  })
  it('honours override coefficients', () => {
    expect(estimateTokens('abcd', { asciiCharsPerToken: 2, nonAsciiCharsPerToken: 2 })).toBe(2)
    expect(TOKEN_ESTIMATE.asciiCharsPerToken).toBe(4)
  })
})

describe('tokenBudgetLoadedCount', () => {
  it('loads the longest strict prefix within the budget', () => {
    // 5 + 5 + 5 = 15 ≤ 16; a 4th would overflow → 3 loaded.
    expect(tokenBudgetLoadedCount([5, 5, 5, 5], 16, 50)).toBe(3)
  })
  it('is a STRICT prefix — stops at the first overflow even if a later item would fit', () => {
    // The 10 overflows the remaining 4; the trailing 3 is NOT back-filled.
    expect(tokenBudgetLoadedCount([5, 10, 3], 14, 50)).toBe(1)
  })
  it('the count cap is the backstop when tokens stay under budget', () => {
    expect(tokenBudgetLoadedCount([1, 1, 1, 1, 1], 100, 3)).toBe(3)
  })
})

describe('curateBudget (#208 one budget per scope)', () => {
  it('returns a loaded flag per item + the loaded/total token sums', () => {
    // pins [4,4] then memory [4,4] against a 10 budget: 4+4+4 = 12 > 10, so the third
    // (a memory item) overflows → first two loaded, the rest trimmed.
    const { loaded, loadedTokens, totalTokens } = curateBudget([4, 4, 4, 4], 10, 50)
    expect(loaded).toEqual([true, true, false, false])
    expect(loadedTokens).toBe(8)
    expect(totalTokens).toBe(16)
  })
  it('everything loads when the whole list fits (headroom, nothing trimmed)', () => {
    const { loaded, loadedTokens, totalTokens } = curateBudget([2, 3], 100, 50)
    expect(loaded).toEqual([true, true])
    expect(loadedTokens).toBe(5)
    expect(totalTokens).toBe(5)
  })
  it('an empty scope is a no-op', () => {
    expect(curateBudget([], 100, 50)).toEqual({ loaded: [], loadedTokens: 0, totalTokens: 0 })
  })
})
