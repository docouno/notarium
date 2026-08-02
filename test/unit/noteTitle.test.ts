// promoteBodyTitle / deriveNoteTitle (#156): a note's title is a PROJECTION of its
// body. This is the ONE rule the write chokepoint (CachedStore.write) and the web
// editor's save-gate both compute from, so it must be pinned precisely: explicit
// title wins, else the leading `# H1`, else the first non-blank line; and the
// returned body has the title line peeled off iff it equals the resulting title
// (the dedup that closes the duplicate-h1 bug).

import { describe, expect, it } from 'vitest'
import { deriveNoteTitle, promoteBodyTitle } from '@notarium/core'

describe('promoteBodyTitle — title derivation', () => {
  it('takes the leading # H1 as the title and strips it from the body (body-first)', () => {
    expect(promoteBodyTitle('# My Note\n\ntext')).toEqual({ title: 'My Note', body: 'text' })
  })

  it('an explicit title wins and de-dups a matching leading # H1 (the #156 bug)', () => {
    // title field AND `# My Note` at the top of body → one title, clean body.
    expect(promoteBodyTitle('# My Note\n\ntext', 'My Note')).toEqual({
      title: 'My Note',
      body: 'text',
    })
  })

  it('an explicit title KEEPS a leading heading that does not match (a real section)', () => {
    // Note titled "A" whose body legitimately opens with `# B` — B is content.
    expect(promoteBodyTitle('# B\n\ntext', 'A')).toEqual({ title: 'A', body: '# B\n\ntext' })
  })

  it('promotes the first non-blank line when there is no heading (Bear-style)', () => {
    expect(promoteBodyTitle('Buy milk\nand eggs')).toEqual({ title: 'Buy milk', body: 'and eggs' })
  })

  it('skips leading blank lines before the title', () => {
    expect(promoteBodyTitle('\n\n# Title\n\nx')).toEqual({ title: 'Title', body: 'x' })
  })

  it('preserves leading inline frontmatter and never reads it as the title', () => {
    expect(promoteBodyTitle('---\ntype: note\n---\n# Title\n\nx')).toEqual({
      title: 'Title',
      body: '---\ntype: note\n---\nx',
    })
  })

  it('an empty document (or a bare "# ") yields no title and leaves the body alone', () => {
    expect(promoteBodyTitle('')).toEqual({ title: '', body: '' })
    expect(promoteBodyTitle('# ')).toEqual({ title: '', body: '# ' })
  })

  it('trims an explicit title and matches a heading ignoring surrounding space', () => {
    expect(promoteBodyTitle('#   My Note  \n\ntext', '  My Note ')).toEqual({
      title: 'My Note',
      body: 'text',
    })
  })

  it('is idempotent — promoting an already-promoted body is a no-op', () => {
    const once = promoteBodyTitle('# Note\n\nbody')
    const twice = promoteBodyTitle(once.body, once.title)
    expect(twice).toEqual({ title: 'Note', body: 'body' })
  })

  it('CRLF: strips the H1 title line, preserves the body line endings', () => {
    expect(promoteBodyTitle('# Title\r\n\r\na\r\nb')).toEqual({ title: 'Title', body: 'a\r\nb' })
  })

  it('a BOM before the H1 still derives the title', () => {
    expect(promoteBodyTitle('\uFEFF# Title\n\nx')).toEqual({ title: 'Title', body: 'x' })
  })
})

// The #156 review found the original peeled ANY first line whose text equalled the
// title — corrupting a structural opening block (an unclosed code fence, a dropped
// list item, a demoted h2) and losing a plain line that merely coincided with an
// EXPLICIT title (the editNote carry-forward). These pin the fix: only a real `# H1`
// (matching the title) or a no-explicit Bear promotion is ever stripped.
describe('promoteBodyTitle — never corrupts a structural / coinciding first line', () => {
  it('an explicit title does NOT strip a plain first line that merely equals it', () => {
    // editNote carries the note's existing title forward; a body whose first line is
    // a paragraph equal to the title must survive (it is content, not the title).
    expect(promoteBodyTitle('Status\n\nongoing', 'Status')).toEqual({
      title: 'Status',
      body: 'Status\n\nongoing',
    })
  })

  it('a body-first note opening with a code fence is NOT titled by the fence', () => {
    const body = '```js\nconst x = 1\n```'
    expect(promoteBodyTitle(body)).toEqual({ title: '', body }) // no title → caller refuses to store
  })

  it('a body-first note opening with a list keeps its first item', () => {
    expect(promoteBodyTitle('- first\n- second')).toEqual({ title: '', body: '- first\n- second' })
    expect(promoteBodyTitle('1. one\n2. two')).toEqual({ title: '', body: '1. one\n2. two' })
  })

  it('a leading blockquote / table / thematic break is structure, not a title', () => {
    expect(promoteBodyTitle('> quote\nmore')).toEqual({ title: '', body: '> quote\nmore' })
    expect(promoteBodyTitle('| a | b |\n|---|---|')).toEqual({
      title: '',
      body: '| a | b |\n|---|---|',
    })
    expect(promoteBodyTitle('---\nnot frontmatter')).toEqual({
      title: '',
      body: '---\nnot frontmatter',
    })
  })

  it('an h2–h6 first line is not the title (H1-only titles; the heading is kept)', () => {
    expect(promoteBodyTitle('## Section\n\ntext')).toEqual({
      title: '',
      body: '## Section\n\ntext',
    })
    expect(promoteBodyTitle('## Section\n\ntext', 'Doc')).toEqual({
      title: 'Doc',
      body: '## Section\n\ntext',
    })
  })

  it('a structural first line WITH an explicit title keeps the structure', () => {
    expect(promoteBodyTitle('```\ncode\n```', 'Snippet')).toEqual({
      title: 'Snippet',
      body: '```\ncode\n```',
    })
  })

  it('a setext heading IS the title — peeled WITH its underline, no orphan (round-2)', () => {
    expect(promoteBodyTitle('My Title\n========\n\nbody')).toEqual({
      title: 'My Title',
      body: 'body',
    })
    expect(promoteBodyTitle('My Title\n----\n\nbody')).toEqual({ title: 'My Title', body: 'body' })
    // an explicit title that differs keeps the setext heading as content
    expect(promoteBodyTitle('Sub\n===\n\nx', 'Doc')).toEqual({
      title: 'Doc',
      body: 'Sub\n===\n\nx',
    })
  })

  it('an indented code block opening the body is NOT promoted (round-2)', () => {
    expect(promoteBodyTitle('    const x = 1\nmore')).toEqual({
      title: '',
      body: '    const x = 1\nmore',
    })
    expect(promoteBodyTitle('\tconst x = 1\nmore')).toEqual({
      title: '',
      body: '\tconst x = 1\nmore',
    })
  })

  it('a link / footnote reference definition is not a title (round-2)', () => {
    expect(promoteBodyTitle('[^1]: a footnote\nbody')).toEqual({
      title: '',
      body: '[^1]: a footnote\nbody',
    })
    expect(promoteBodyTitle('[id]: https://x\nbody')).toEqual({
      title: '',
      body: '[id]: https://x\nbody',
    })
  })

  it('a headerless table header is not a title (its delimiter row would be orphaned) (round-2)', () => {
    const body = 'a | b | c\n-- | -- | --\n1 | 2 | 3'
    expect(promoteBodyTitle(body)).toEqual({ title: '', body })
  })

  it('a `===`/`---` under a STRUCTURAL line is NOT setext — the structural line is kept (round-3)', () => {
    // CommonMark: a setext underline only follows a paragraph. Under a list item /
    // blockquote / fence it is ordinary text, so the opening line must survive.
    expect(promoteBodyTitle('- item\n===\nrest')).toEqual({ title: '', body: '- item\n===\nrest' })
    expect(promoteBodyTitle('> quote\n---\nrest')).toEqual({
      title: '',
      body: '> quote\n---\nrest',
    })
  })

  it('an ATX closing `#` sequence is dropped from the title (round-3)', () => {
    expect(promoteBodyTitle('# Title #\n\nbody')).toEqual({ title: 'Title', body: 'body' })
    expect(promoteBodyTitle('# Title ###\n\nbody')).toEqual({ title: 'Title', body: 'body' })
    // dedup still fires for the closing-sequence form against an explicit title
    expect(promoteBodyTitle('# Title #\n\nbody', 'Title')).toEqual({ title: 'Title', body: 'body' })
  })
})

describe('deriveNoteTitle — the read-only title the editor gates on', () => {
  it('mirrors promoteBodyTitle.title', () => {
    expect(deriveNoteTitle('# H\n\nx')).toBe('H')
    expect(deriveNoteTitle('plain first line\nrest')).toBe('plain first line')
    expect(deriveNoteTitle('', 'Explicit')).toBe('Explicit')
    expect(deriveNoteTitle('# ')).toBe('')
    expect(deriveNoteTitle('')).toBe('')
  })
})
