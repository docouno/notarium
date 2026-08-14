import { describe, expect, it } from 'vitest'

import { lexerSource, locateWikilinks, WIKILINK_TOKEN } from './tokenOffsets'

const wikilink = (target: string) => ({ type: WIKILINK_TOKEN, raw: `[[${target}]]`, target })

// The walker reads a token tree, so it is fed one here directly: what it does with
// a shape it has never seen is the whole contract, and no document can produce a
// shape the lexer does not have.
describe('locateWikilinks', () => {
  it('places a link at the offset its construct occupies', () => {
    const source = 'see [[Target]] end'

    expect(
      locateWikilinks(
        [
          {
            type: 'paragraph',
            raw: source,
            text: source,
            tokens: [{ type: 'text', raw: 'see ', text: 'see ' }, wikilink('Target')],
          },
        ],
        source,
      ),
    ).toEqual([{ target: 'Target', start: 4 }])
  })

  it('reports a link inside an unmodelled shape, and gives it no offset', () => {
    const source = 'see [[Target]] end'

    // Reported, because a link the extractor drops is a graph edge the note loses.
    // Unplaced, because the only offset available would be a guess — and the caller
    // that edits bytes refuses on `null` rather than take one.
    expect(
      locateWikilinks(
        [{ type: 'somethingNew', raw: source, tokens: [wikilink('Target')] }],
        source,
      ),
    ).toEqual([{ target: 'Target', start: null }])
  })

  it('gives no offset to a token whose raw is not in the string it was lexed from', () => {
    expect(
      locateWikilinks(
        [
          {
            type: 'paragraph',
            raw: 'not from here [[Target]]',
            text: 'not from here [[Target]]',
            tokens: [wikilink('Target')],
          },
        ],
        'a different document',
      ),
    ).toEqual([{ target: 'Target', start: null }])
  })

  // The one raw the walker accepts as longer than the string it came from: marked
  // closes a blockquote that swallowed a lazy continuation with a `\n`, and the
  // string it read may not have one — the document ended without it, or the list
  // tokenizer trimmed the item text afterwards.
  it('places a container whose raw closes with a newline the string does not have', () => {
    const source = '> see [[Target]]'

    expect(
      locateWikilinks(
        [
          {
            type: 'blockquote',
            raw: `${source}\n`,
            text: 'see [[Target]]\n',
            tokens: [
              {
                type: 'paragraph',
                raw: 'see [[Target]]',
                text: 'see [[Target]]',
                tokens: [{ type: 'text', raw: 'see ', text: 'see ' }, wikilink('Target')],
              },
            ],
          },
        ],
        source,
      ),
    ).toEqual([{ target: 'Target', start: 6 }])
  })

  // And it is that newline at THAT place — where the raw would run from the cursor
  // to the end of the string — not wherever the shortened raw happens to fit. A
  // re-joined paragraph carries a line break the string never had; taking the end
  // of the string for it walks the cursor past the link that follows.
  it('does not take the end of the string for a break the raw only claims', () => {
    const source = 'a\nsee [[Target]]'
    const rejoined = 'a\n\nsee [[Target]]'

    expect(
      locateWikilinks(
        [
          {
            type: 'text',
            raw: rejoined,
            text: rejoined,
            tokens: [
              { type: 'text', raw: 'a', text: 'a' },
              { type: 'br', raw: '\n' },
              { type: 'br', raw: '\n' },
              { type: 'text', raw: 'see ', text: 'see ' },
              wikilink('Target'),
            ],
          },
        ],
        source,
      ),
    ).toEqual([{ target: 'Target', start: 6 }])
  })
})

describe('lexerSource', () => {
  it('hands back the document itself when the lexer would not touch it', () => {
    const source = 'plain [[Note]] body'
    const { text, toSource } = lexerSource(source)

    expect(text).toBe(source)
    expect(toSource(6)).toBe(6)
  })

  it('maps an offset in the normalized copy back onto the author bytes', () => {
    const source = 'a [[One]]\r\n\r\n\tb [[Two]]\r\n'
    const { text, toSource } = lexerSource(source)

    expect(text).toBe('a [[One]]\n\n    b [[Two]]\n')
    for (const construct of ['[[One]]', '[[Two]]']) {
      expect(toSource(text.indexOf(construct))).toBe(source.indexOf(construct))
    }
  })
})
