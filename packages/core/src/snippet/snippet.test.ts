import { describe, expect, it } from 'vitest'

import { derivePreview, derivePreviewFromFile, firstImage, makeSnippet } from './snippet'

describe('makeSnippet', () => {
  it('flattens markdown to plain prose', () => {
    const body = [
      'Intro **bold** and `code`.',
      '',
      '```js',
      'const hidden = true',
      '```',
      '- item one',
      '- item two',
      '| a | b |',
      '|---|---|',
      '[link](https://x.test) and [[Wiki Target|alias]] and [[Plain]]',
    ].join('\n')
    const s = makeSnippet(body)
    expect(s).toBe('Intro bold and code. item one item two link and alias and Plain')
  })

  it('clamps at a word boundary with an ellipsis', () => {
    const s = makeSnippet('alpha bravo charlie delta echo', 14)
    expect(s).toBe('alpha bravo…')
  })
})

describe('firstImage', () => {
  it('returns the first absolute markdown image url', () => {
    expect(firstImage('text ![alt](https://img.test/a.png) more')).toBe('https://img.test/a.png')
  })

  it('falls back to an <img src> and skips non-http urls', () => {
    expect(firstImage('<img src="https://img.test/b.png">')).toBe('https://img.test/b.png')
    expect(firstImage('![local](attachments/pic.png)')).toBeNull()
    expect(firstImage('no images here')).toBeNull()
  })
})

describe('derivePreview', () => {
  // It takes a BODY and asks nothing about a leading block. A caller holding unparsed
  // text strips it visibly at the call site instead — that is what keeps one file from
  // growing two previews once normalisation leaves bytes that merely READ like a block.
  it('does not re-decide what a body is', () => {
    const looksLikeABlock = '---\ntags: [x]\n---\nBody text'

    expect(derivePreview(looksLikeABlock).snippet).toContain('Body text')
    expect(derivePreview(looksLikeABlock).snippet).toContain('tags')
  })

  it('agrees with the file-shaped derivation on one and the same note', () => {
    const raw = '\n---\nA thought I wrote between two rules.\n---\nAnd the rest.\n'
    // What the file parse hands a store as this note's body: the leading blank is gone,
    // so these bytes now read like a block — and must still preview as the prose they are.
    const body = '---\nA thought I wrote between two rules.\n---\nAnd the rest.\n'
    const fromFile = derivePreviewFromFile(raw, 'rule-led-prose')
    const fromBody = derivePreview(body)

    expect(fromBody.snippet).toBe(fromFile.snippet)
    expect(fromBody.words).toBe(fromFile.words)
    expect(fromBody.words).toBe(10)
  })
})

describe('derivePreviewFromFile', () => {
  it('produces the same preview the engine-normalised path would: frontmatter tags, no title heading', () => {
    const raw = [
      '---',
      'title: My Note',
      'tags:',
      '  - alpha',
      '  - beta',
      '---',
      '# My Note',
      '',
      'Body prose with ![img](https://img.test/x.png) inline.',
    ].join('\n')
    const p = derivePreviewFromFile(raw, 'My Note')
    // THE invariant: byte-identical to what the engine-normalised path yields.
    expect(p).toEqual(
      derivePreview('Body prose with ![img](https://img.test/x.png) inline.', ['alpha', 'beta']),
    )
    expect(p.snippet).toBe('Body prose with inline.')
    expect(p.tags).toEqual(['alpha', 'beta'])
    expect(p.image).toBe('https://img.test/x.png')
  })

  it('keeps a first heading that is NOT the title', () => {
    const p = derivePreviewFromFile('# Different Heading\n\ntext', 'My Note')
    expect(p.snippet).toBe('Different Heading text')
  })

  it('keeps prose that opens with a rule — the preview strips a block, not a paragraph', () => {
    const raw = '\n---\nA thought I wrote between two rules.\n---\nAnd the rest.\n'
    const p = derivePreviewFromFile(raw, 'My Note')

    expect(p.snippet).toContain('A thought I wrote between two rules.')
    expect(p.snippet).toContain('And the rest.')
    // Every FIELD of one preview answers over the same text. The counts used to be
    // computed after a second, independent guess at where metadata ended, so a card
    // showed a snippet of ten words beside a count of three.
    expect(p.words).toBe(10)
  })
})
