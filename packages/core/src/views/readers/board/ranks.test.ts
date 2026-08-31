import { describe, expect, it } from 'vitest'

import {
  BOARD_RANK_JITTER_STEPS,
  compareBoardRank,
  isValidBoardRank,
  jitteredBoardRank,
  orderByBoardRanks,
  parseBoardRanks,
  rankNeedsRebalance,
  rebalanceBoardRanks,
} from './ranks'

describe('board fractional ranks', () => {
  it('performs exactly 32 injected jitter choices inside the legal interval', () => {
    let calls = 0
    const rank = jitteredBoardRank('a0', 'a1', () => {
      calls++
      return calls % 2 === 0 ? 1 : 0
    })

    expect(calls).toBe(BOARD_RANK_JITTER_STEPS)
    expect(rank > 'a0' && rank < 'a1').toBe(true)
  })

  it('keeps collisions total by note id and rebalances without jitter', () => {
    expect(compareBoardRank({ noteId: 'a', rank: 'a0' }, { noteId: 'b', rank: 'a0' })).toBe(-1)
    const balanced = rebalanceBoardRanks(['c', 'a', 'b'])
    const values = [...balanced.values()]

    expect(values).toEqual([...values].sort())
    expect(new Set(values).size).toBe(3)
  })

  it('sorts ranked rows first and keeps a deterministic rankless tail', () => {
    const rows = [
      { id: 'c', title: 'Zulu' },
      { id: 'b', title: 'Alpha' },
      { id: 'a', title: 'Beta' },
    ]
    const ordered = orderByBoardRanks(rows, new Map([['a', 'a0']]), {
      id: (row) => row.id,
      fallback: (left, right) =>
        left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
    })

    expect(ordered.map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })

  it('parses hostile JSONL fail-closed and names duplicate/invalid lines', () => {
    const parsed = parseBoardRanks(
      ['["a","a0"]', '["a","a1"]', 'not-json', '["b","bad-rank"]'].join('\n'),
    )

    expect(parsed.entries.get('a')).toBe('a0')
    expect(parsed.writable).toBe(false)
    expect(parsed.diagnostics.join(' ')).toMatch(/duplicates note a/u)
    expect(parsed.diagnostics.join(' ')).toMatch(/not valid JSON/u)
    expect(parsed.diagnostics.join(' ')).toMatch(/invalid rank/u)
  })

  it('recognises the 64-byte rebalance threshold', () => {
    expect(rankNeedsRebalance('a'.repeat(64))).toBe(false)
    expect(rankNeedsRebalance('a'.repeat(65))).toBe(true)
  })

  it('keeps a long concurrent insertion sequence strictly ordered', () => {
    const keys: string[] = []

    for (let index = 0; index < 10_000; index++) {
      const next = keys[0] ?? null
      keys.unshift(jitteredBoardRank(null, next, () => (index % 2) as 0 | 1))
    }

    expect(keys.every((key, index) => index === 0 || keys[index - 1]! < key)).toBe(true)
  })

  it('keeps 100k deterministic random-gap insertion candidates inside their bounds', () => {
    const keys = [
      ...rebalanceBoardRanks(Array.from({ length: 1024 }, (_, index) => `n-${index}`)).values(),
    ]
    let random = 0x385

    const next = (): number => {
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0
      return random
    }

    for (let insertion = 0; insertion < 100_000; insertion++) {
      const at = next() % (keys.length + 1)
      const previous = keys[at - 1] ?? null
      const following = keys[at] ?? null
      const rank = jitteredBoardRank(previous, following, () => (next() & 1) as 0 | 1)

      if (
        (previous !== null && previous >= rank) ||
        (following !== null && rank >= following) ||
        !isValidBoardRank(rank)
      ) {
        throw new Error(`invalid insertion candidate at ${insertion}`)
      }
    }
    expect(random).not.toBe(0x385)
  }, 20_000)
})
