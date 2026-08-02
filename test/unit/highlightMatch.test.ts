import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { highlightMatch } from '../../packages/web/src/libs/highlight/highlightMatch'

// Client-side match highlight for the Spotlight (#31): the hybrid backend returns
// plain-text snippets with no offsets (docs/search.md), so matches are recomputed
// here. These pin the segmentation contract — which spans become <mark> — without
// a DOM (the nodes are inspected structurally, never rendered).

type Seg = { text: string; mark: boolean }

const segs = (node: ReactNode): Seg[] => {
  const arr = Array.isArray(node) ? node : [node]
  return arr.map((p) =>
    typeof p === 'string'
      ? { text: p, mark: false }
      : { text: (p as { props: { children: string } }).props.children, mark: true },
  )
}

const marked = (node: ReactNode): string[] =>
  segs(node)
    .filter((s) => s.mark)
    .map((s) => s.text)

describe('highlightMatch', () => {
  it('returns the bare text when the query is empty', () => {
    expect(highlightMatch('hello world', '')).toBe('hello world')
    expect(highlightMatch('hello world', '   ')).toBe('hello world')
  })

  it('returns the bare text when nothing matches', () => {
    expect(highlightMatch('hello world', 'xyz')).toBe('hello world')
  })

  it('wraps a single match and preserves the surrounding text', () => {
    expect(segs(highlightMatch('Vector Search Design', 'search'))).toEqual([
      { text: 'Vector ', mark: false },
      { text: 'Search', mark: true },
      { text: ' Design', mark: false },
    ])
  })

  it('matches case-insensitively but keeps the original casing in the mark', () => {
    expect(marked(highlightMatch('Search the SEARCH', 'search'))).toEqual(['Search', 'SEARCH'])
  })

  it('highlights every token of a multi-word query', () => {
    expect(marked(highlightMatch('search the graph channel', 'graph search'))).toEqual([
      'search',
      'graph',
    ])
  })

  it('treats query tokens literally (no regex injection)', () => {
    // A parenthesis in the query must not blow up the RegExp nor match greedily.
    expect(marked(highlightMatch('a (b) c', '(b)'))).toEqual(['(b)'])
    expect(() => highlightMatch('a.b.c', '.')).not.toThrow()
  })
})
