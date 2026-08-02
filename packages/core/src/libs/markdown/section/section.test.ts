import { describe, expect, it } from 'vitest'

import { listHeadings, replaceMarkdownSection } from './section'

describe('listHeadings', () => {
  it('lists ATX headings with level, text and line, in order', () => {
    const body = '# Title\n\nintro\n\n## A\nbody a\n\n### A.1\ndeep\n\n## B\nbody b'
    expect(listHeadings(body)).toEqual([
      { level: 1, text: 'Title', line: 0 },
      { level: 2, text: 'A', line: 4 },
      { level: 3, text: 'A.1', line: 7 },
      { level: 2, text: 'B', line: 10 },
    ])
  })

  it('strips a closing #-run and surrounding whitespace from the text', () => {
    expect(listHeadings('##   Spaced Heading   ##')).toEqual([
      { level: 2, text: 'Spaced Heading', line: 0 },
    ])
  })

  it('ignores a # inside a fenced code block', () => {
    const body = '## Real\n\n```\n# not a heading\n## also not\n```\n\n## Also Real'
    expect(listHeadings(body).map((h) => h.text)).toEqual(['Real', 'Also Real'])
  })

  it('handles tilde fences and a fence that never closes', () => {
    const body = '## Real\n~~~\n# masked\n'
    expect(listHeadings(body).map((h) => h.text)).toEqual(['Real'])
  })

  it('is empty for a body with no headings', () => {
    expect(listHeadings('just prose\nand more')).toEqual([])
    expect(listHeadings('')).toEqual([])
  })
})

describe('replaceMarkdownSection', () => {
  it('replaces the body under a heading, keeping the heading and the rest', () => {
    const body = '# Title\n\n## A\nold a\n\n## B\nkeep b'
    const res = replaceMarkdownSection(body, 'A', 'new a')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.body).toBe('# Title\n\n## A\n\nnew a\n\n## B\nkeep b')
    }
  })

  it('matches the heading text case-insensitively after trimming', () => {
    const res = replaceMarkdownSection('## Notes\nx', '  notes  ', 'y')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.body).toBe('## Notes\n\ny')
    }
  })

  it('a section absorbs its deeper sub-sections (ends at the next same/higher level)', () => {
    const body = '## A\na body\n\n### A.1\nsub\n\n## B\nb body'
    const res = replaceMarkdownSection(body, 'A', 'replaced')
    expect(res.ok).toBe(true)
    // A.1 was nested under A → replaced with it; B (a sibling) is untouched.
    if (res.ok) {
      expect(res.body).toBe('## A\n\nreplaced\n\n## B\nb body')
    }
  })

  it('replaces a trailing section that runs to end of document', () => {
    const res = replaceMarkdownSection('# T\n\n## Last\nold', 'Last', 'fresh')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.body).toBe('# T\n\n## Last\n\nfresh')
    }
  })

  it('an empty replacement clears the section to a single blank, no pile-up', () => {
    const res = replaceMarkdownSection('## A\nold\n\n## B\nkeep', 'A', '')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.body).toBe('## A\n\n## B\nkeep')
    }
  })

  it('an empty replacement on a trailing section leaves just the heading', () => {
    const res = replaceMarkdownSection('## A\nold', 'A', '')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.body).toBe('## A')
    }
  })

  it('reports the headings present when no section matches', () => {
    const res = replaceMarkdownSection('## A\nx\n\n## B\ny', 'C', 'z')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.headings).toEqual(['A', 'B'])
    }
  })

  it('reports an empty heading list for a body with no headings', () => {
    const res = replaceMarkdownSection('just prose', 'Anything', 'z')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.headings).toEqual([])
    }
  })
})
