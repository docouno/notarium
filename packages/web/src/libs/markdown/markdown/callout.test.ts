import { Marked } from 'marked'
import { describe, expect, it } from 'vitest'

import { calloutExtension, calloutLook } from './callout'

// Render through a fresh Marked with ONLY the callout extension, so the assertions
// are about our tokenizer/renderer alone (the real pipeline adds footnotes +
// highlight + DOMPurify on top; those are independent).
const md = new Marked({ gfm: true, breaks: true })
md.use({ extensions: [calloutExtension] })
const render = (src: string) => md.parse(src) as string

describe('calloutLook', () => {
  it('passes a canonical type through', () => {
    expect(calloutLook('note')).toBe('note')
    expect(calloutLook('warning')).toBe('warning')
  })
  it('is case-insensitive (GitHub UPPERCASE is a subset)', () => {
    expect(calloutLook('NOTE')).toBe('note')
    expect(calloutLook('Warning')).toBe('warning')
  })
  it('resolves aliases to their look', () => {
    expect(calloutLook('caution')).toBe('danger')
    expect(calloutLook('tldr')).toBe('abstract')
    expect(calloutLook('check')).toBe('success')
  })
  it('falls back to the note look for an unknown type', () => {
    expect(calloutLook('xyz')).toBe('note')
  })
})

describe('callout extension', () => {
  it('renders `> [!note]` as a callout box with a default title', () => {
    const html = render('> [!note]\n> Body text.')
    expect(html).toContain('<div class="callout callout-note">')
    expect(html).toContain('<div class="callout-title">Note</div>')
    expect(html).toContain('<div class="callout-body">')
    expect(html).toContain('Body text.')
  })

  it('uses a custom title from the type line', () => {
    const html = render('> [!warning] Be very careful\n> Watch out.')
    expect(html).toContain('callout-warning')
    expect(html).toContain('<div class="callout-title">Be very careful</div>')
    expect(html).not.toContain('>Warning</div>') // the default title is overridden
  })

  it('renders inline markdown in body AND title', () => {
    const html = render('> [!tip] A **bold** title\n> A [link](http://x) inside.')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<a href="http://x">link</a>')
  })

  it('maps an UPPERCASE alias to its look but keeps the typed word as the title', () => {
    const html = render('> [!CAUTION]\n> Danger ahead.')
    expect(html).toContain('callout-danger') // caution → danger look
    expect(html).toContain('<div class="callout-title">Caution</div>') // title from the word
  })

  it('falls back to the note look for an unknown type, titled by the word', () => {
    const html = render('> [!whatever]\n> Body.')
    expect(html).toContain('callout-note')
    expect(html).toContain('<div class="callout-title">Whatever</div>')
  })

  it('renders a `-` foldable as a collapsed <details>', () => {
    const html = render('> [!info]- Hidden\n> Secret body.')
    expect(html).toContain('<details class="callout callout-info callout-foldable">')
    expect(html).not.toContain(' open>') // collapsed
    expect(html).toContain('<summary class="callout-title">Hidden</summary>')
  })

  it('renders a `+` foldable as an OPEN <details>', () => {
    const html = render('> [!abstract]+ Shown\n> Visible body.')
    expect(html).toContain('<details class="callout callout-abstract callout-foldable" open>')
    expect(html).toContain('<summary class="callout-title">Shown</summary>')
  })

  it('leaves a normal blockquote untouched (no [!type] head)', () => {
    const html = render('> Just a quote.\n> Second line.')
    expect(html).toContain('<blockquote>')
    expect(html).not.toContain('callout')
  })

  it('renders a title-only callout with no body div', () => {
    const html = render('> [!note]')
    expect(html).toContain('<div class="callout callout-note">')
    expect(html).toContain('<div class="callout-title">Note</div>')
    expect(html).not.toContain('callout-body')
  })

  it('parses block markdown (a list) inside the body', () => {
    const html = render('> [!example]\n> - one\n> - two')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<li>two</li>')
  })

  it('does not bleed past the blockquote into following text', () => {
    const html = render('> [!note]\n> In the box.\n\nOutside the box.')
    expect(html).toContain('Outside the box.')
    // the trailing paragraph must be its OWN <p>, not inside the callout body
    expect(html).toMatch(/<\/div>\s*<\/div>\s*<p>Outside the box\.<\/p>/)
  })

  it('consumes exactly its source at EOF with no trailing newline (no loop, no drop)', () => {
    // Guards token.raw correctness — if raw didn't equal the consumed text, marked
    // would loop or drop characters. A title-only callout at the very end of the doc.
    const html = render('text before\n\n> [!note]')
    expect(html).toContain('<p>text before</p>')
    expect(html).toContain('<div class="callout callout-note">')
    expect(html).toContain('<div class="callout-title">Note</div>')
  })

  it('merges tight back-to-back callouts into one (Obsidian parity — needs a blank line)', () => {
    // CONSCIOUS LIMITATION: a `>`-run is one callout; only its FIRST line is a head.
    // Two callouts with no blank line between collapse into one, the 2nd `[!tip]`
    // rendering as literal body text — same as Obsidian (which requires a blank line
    // to separate callouts). Pinned so the behaviour can't change silently.
    const html = render('> [!note]\n> one\n> [!tip]\n> two')
    expect((html.match(/class="callout /g) || []).length).toBe(1) // ONE box, not two
    expect(html).toContain('[!tip]') // the 2nd head leaks as text inside the note
  })
})
