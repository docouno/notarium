import { describe, expect, it } from 'vitest'

import { createHeadingChunker, MAX_CHUNK_CHARS, TARGET_CHUNK_CHARS } from './index'

describe('headingChunker', () => {
  const chunker = createHeadingChunker()

  it('carries a stable version (part of the embedding key, P13)', () => {
    expect(chunker.version).toBe('heading-v1')
  })

  it('is a strict superset of whole-note for a note WITHOUT headings', () => {
    // The common short note: exactly one chunk, `title\n\nbody` — byte-identical to
    // what the whole-note chunker produced, so existing vectors/keys stay valid.
    const chunks = chunker.chunk({ title: 'Borscht', body: 'A beet soup.' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].index).toBe(0)
    expect(chunks[0].text).toBe('Borscht\n\nA beet soup.')
  })

  it('folds in just the title or just the body when the other is empty', () => {
    expect(chunker.chunk({ title: 'Solo', body: '' })[0].text).toBe('Solo')
    expect(chunker.chunk({ title: '', body: 'just prose' })[0].text).toBe('just prose')
  })

  it('emits nothing for an empty note (nothing to embed)', () => {
    expect(chunker.chunk({ title: '', body: '' })).toEqual([])
    expect(chunker.chunk({ title: '  ', body: '\n\t' })).toEqual([])
  })

  it('prefixes each section with its breadcrumb (title › h2 › h3)', () => {
    const body = '## Setup\n\nInstall deps.\n\n### Linux\n\napt install foo'
    const chunks = chunker.chunk({ title: 'Guide', body })
    const text = chunks.map((c) => c.text).join('\n')
    expect(text).toContain('Guide › Setup')
    expect(text).toContain('Guide › Setup › Linux')
    expect(text).toContain('Install deps.')
    expect(text).toContain('apt install foo')
  })

  it('keeps lead prose (before the first heading) under the title-only breadcrumb', () => {
    const chunks = chunker.chunk({ title: 'Note', body: 'intro line\n\n## Section\n\nbody' })
    // The lead is the FIRST section, with no heading in its crumb (just the title);
    // small sections then pack after it, so it leads chunk 0.
    expect(chunks[0].text.startsWith('Note\n\nintro line')).toBe(true)
    expect(chunks[0].text).toContain('Note › Section')
  })

  it('packs small adjacent sections into one chunk (under the target)', () => {
    const body = '## A\n\nshort a\n\n## B\n\nshort b'
    const chunks = chunker.chunk({ title: 'T', body })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('T › A')
    expect(chunks[0].text).toContain('T › B')
  })

  it('keeps large sections in separate chunks (over the target when combined)', () => {
    const big = 'x '.repeat(600) // ~1200 chars each → two of them exceed TARGET combined
    const body = `## One\n\n${big}\n\n## Two\n\n${big}`
    const chunks = chunker.chunk({ title: 'T', body })
    expect(chunks.length).toBe(2)
    expect(chunks[0].text).toContain('T › One')
    expect(chunks[1].text).toContain('T › Two')
  })

  it('windows an oversized single section with overlap, each piece within the cap', () => {
    const huge = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(' ') // ~24k chars
    const chunks = chunker.chunk({ title: 'T', body: `## Big\n\n${huge}` })
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
    }
    // Overlap: a token near a boundary appears in two consecutive chunks.
    const joined = chunks.map((c) => c.text)
    let sawOverlap = false

    for (let i = 1; i < joined.length; i++) {
      const tail = joined[i - 1].slice(-100).split(' ').filter(Boolean)

      if (tail.some((w) => joined[i].includes(w))) {
        sawOverlap = true
      }
    }
    expect(sawOverlap).toBe(true)
  })

  it('does NOT split on a `#` inside a fenced code block', () => {
    const body = '```\n## NotAHeading\nshell stuff\n```\n\nreal prose'
    const chunks = chunker.chunk({ title: 'Code', body })
    // The whole thing is one lead section (no real heading) → one chunk.
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('## NotAHeading')
    expect(chunks[0].text).not.toContain('Code › NotAHeading')
  })

  it('keeps an empty PARENT heading via its child breadcrumb (no redundant chunk)', () => {
    // "Parent" has no prose of its own and a child carries it — no separate chunk
    // for it, but it must still appear as an ancestor of "Child".
    const chunks = chunker.chunk({ title: 'T', body: '## Parent\n\n### Child\n\nchild body' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('T › Parent › Child')
    expect(chunks[0].text).toContain('child body')
  })

  it('EMBEDS a leaf heading that has no prose of its own (#81 Stage-3 review — no data loss)', () => {
    // A meeting/MOC/outline note where headings ARE the content (questions, TBD
    // sections, index entries). Every heading's words must reach a chunk, else the
    // note becomes un-findable semantically — a recall regression vs whole-note.
    const body =
      '## What did we decide about pricing?\n\n## Action items for Alex\n\n## Follow up with the vector search team'
    const text = chunker
      .chunk({ title: 'Meeting', body })
      .map((c) => c.text)
      .join('\n')
    expect(text).toContain('pricing')
    expect(text).toContain('Action items for Alex')
    expect(text).toContain('vector search team')
  })

  it('embeds every heading of an all-headings outline (no prose anywhere)', () => {
    const text = chunker
      .chunk({ title: 'Recipes', body: '## Beef Stroganoff\n\n## Borscht\n\n## Okroshka' })
      .map((c) => c.text)
      .join('\n')

    for (const dish of ['Beef Stroganoff', 'Borscht', 'Okroshka']) {
      expect(text).toContain(dish)
    }
  })

  it('embeds a bare leaf heading even in a note that also has prose sections', () => {
    const body = '## Notes\n\nsome real prose here\n\n## TODO follow up with the vendor'
    const text = chunker
      .chunk({ title: 'Mixed', body })
      .map((c) => c.text)
      .join('\n')
    expect(text).toContain('some real prose here')
    expect(text).toContain('TODO follow up with the vendor') // the bare leaf heading
  })

  it('does NOT explode on a pathologically long heading/crumb (#81 Stage-3 review)', () => {
    // A multi-kB single line pasted as a heading (crumb >> MAX) over an oversized
    // section must still yield a BOUNDED number of chunks, each within the cap —
    // not ~one chunk per character.
    const longHeading = 'x'.repeat(7800)
    const hugeBody = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ') // ~21k chars
    const chunks = chunker.chunk({ title: 'T', body: `## ${longHeading}\n\n${hugeBody}` })
    expect(chunks.length).toBeLessThan(20) // bounded, not tens of thousands
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
    }
  })

  it('is deterministic — same input, same chunks (content_hash relies on it)', () => {
    const input = { title: 'A', body: '## H\n\nbody\n\n### H2\n\nmore' }
    expect(chunker.chunk(input)).toEqual(chunker.chunk(input))
  })

  it('respects the size constants (sanity)', () => {
    expect(TARGET_CHUNK_CHARS).toBeLessThan(MAX_CHUNK_CHARS)
  })
})
