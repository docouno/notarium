import { describe, expect, it } from 'vitest'

import { markdownFileToNote } from './markdown'

// The dropped-file parser: a plain text / markdown file → one note. Pins
// the title precedence (leading H1 > filename), frontmatter stripping, the
// deterministic per-basename filename, and the '' directory (the host nests it
// under the drop-target folder).
describe('markdownFileToNote (#223)', () => {
  it('lifts the leading H1 as the title and drops it from the body', () => {
    const n = markdownFileToNote('# My Note\n\nBody paragraph.\n', 'notes.md')
    expect(n.title).toBe('My Note')
    expect(n.body).toBe('Body paragraph.')
    expect(n.source).toBe('file')
    expect(n.directory).toBe('')
  })

  it('falls back to the filename (sans extension) when there is no H1', () => {
    const n = markdownFileToNote('buy milk\ncall Sam', 'todo list.txt')
    expect(n.title).toBe('todo list')
    expect(n.body).toBe('buy milk\ncall Sam')
  })

  it('derives a deterministic storage filename from the basename, not the title', () => {
    const n = markdownFileToNote('# Different Title\n\nx', 'weekly-notes.md')
    expect(n.title).toBe('Different Title')
    expect(n.fileName).toBe('weekly-notes') // slug of the source basename → idempotent per file
  })

  it('strips a leading YAML frontmatter block (v1 does not merge it)', () => {
    const n = markdownFileToNote(
      '---\ntitle: Ignored\ntags: [a, b]\n---\n# Real\n\nContent.',
      'x.md',
    )
    expect(n.title).toBe('Real')
    expect(n.body).toBe('Content.')
    expect(n.body).not.toContain('title: Ignored')
  })

  it('a leading frontmatter block with no following H1 still leaves clean body', () => {
    const n = markdownFileToNote('---\nkey: v\n---\nJust text.', 'my file.md')
    expect(n.title).toBe('my file') // filename fallback
    expect(n.body).toBe('Just text.')
  })

  it('does not mistake a lone --- thematic break for frontmatter', () => {
    const n = markdownFileToNote('First line\n\n---\n\nSecond.', 'doc.txt')
    expect(n.title).toBe('doc')
    expect(n.body).toBe('First line\n\n---\n\nSecond.')
  })

  it('strips a UTF-8 BOM before parsing', () => {
    const n = markdownFileToNote('\uFEFF# Title\n\nBody', 'b.md')
    expect(n.title).toBe('Title')
    expect(n.body).toBe('Body')
  })

  it('keeps the legacy hashed storage key for a non-romanisable basename', () => {
    // Import storage identity must not change across a slug-alphabet upgrade:
    // re-importing the same source has to overwrite/skip its old path, not duplicate it.
    const a = markdownFileToNote('content a', '笔记.md')
    const b = markdownFileToNote('content b', '日记.md')
    expect(a.fileName).toBe('note-01qpbapg')
    expect(b.fileName).toBe('note-00qyrh1f')
    expect(a.title).toBe('笔记')
  })

  it('a basename with no letters at all still gets a DISTINCT, stable filename', () => {
    // The hash fallback survives for the case that really has nothing to name a file
    // with — two emoji-named drops must not land on one path.
    const a = markdownFileToNote('content a', '🎉.md')
    const b = markdownFileToNote('content b', '🚀.md')
    expect(a.fileName).toMatch(/^note-[a-z0-9]{8}$/)
    expect(b.fileName).toMatch(/^note-[a-z0-9]{8}$/)
    expect(a.fileName).not.toBe(b.fileName)
  })

  it('a long H1 line with trailing spaces titles cleanly (greedy capture + trim, no ReDoS)', () => {
    // The ReDoS shape was `#␠<long>␠␠…` — the greedy capture + `.trim()` handles it
    // linearly and still yields the right title.
    const n = markdownFileToNote('# ' + 'a'.repeat(5000) + '   ', 'x.md')
    expect(n.title).toBe('a'.repeat(5000))
    expect(n.body).toBe('')
  })

  it('is pure — same input yields the same note twice', () => {
    const a = markdownFileToNote('# T\n\nb', 'f.md')
    const b = markdownFileToNote('# T\n\nb', 'f.md')
    expect(a).toEqual(b)
  })
})
