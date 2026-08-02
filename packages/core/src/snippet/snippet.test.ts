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

  it('drops a leading frontmatter block', () => {
    expect(makeSnippet('---\ntags: [x]\n---\nBody text')).toBe('Body text')
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
})
