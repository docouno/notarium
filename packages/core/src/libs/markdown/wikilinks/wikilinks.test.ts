import { describe, expect, it, vi } from 'vitest'

import type * as tokenOffsets from './tokenOffsets'
import { locateWikilinks as actualLocateWikilinks } from './tokenOffsets'
import {
  decodeWikilinkIdentity,
  encodeWikilinkAlias,
  encodeWikilinkIdentity,
  isCreatableWikilinkTarget,
  isWikilinkIdentityTarget,
  normalizeWikilinkTarget,
  parseWikilinks,
  rewriteWikilinkIdentities,
  scanWikilinksFallback,
  wikilinkPrefix,
  WikilinkRewriteError,
} from './wikilinks'

type TokenOffsets = typeof tokenOffsets

describe('parseWikilinks', () => {
  it('encodes alias metacharacters without changing safe labels or the stable target', () => {
    expect(encodeWikilinkAlias('Safe title / #1 | ok')).toBe('Safe title / #1 | ok')
    expect(encodeWikilinkAlias('&[MCP] <Review>')).toBe('&amp;&#91;MCP&#93; &lt;Review&gt;')

    const target = encodeWikilinkIdentity('target-id')
    const source = `[[${target}|${encodeWikilinkAlias('[MCP] Review')}]]`

    expect(parseWikilinks(source)).toEqual([target])
    expect(wikilinkPrefix(source)).toMatchObject({
      target,
      label: '&#91;MCP&#93; Review',
    })
  })

  it('extracts targets in order, keeping duplicates', () => {
    expect(parseWikilinks('a [[One]] b [[Two]] c [[One]]')).toEqual(['One', 'Two', 'One'])
  })

  it('takes the target side of [[target|alias]]', () => {
    expect(parseWikilinks('[[Real Note|shown as this]]')).toEqual(['Real Note'])
  })

  it('consumes the escaped alias separator required inside GFM tables', () => {
    expect(parseWikilinks('| [[Target\\|Label]] |')).toEqual(['Target'])
    expect(normalizeWikilinkTarget('Target\\|Label')).toBe('Target')
  })

  it('drops #fragments — links resolve to whole notes', () => {
    expect(parseWikilinks('[[Note#section]]')).toEqual(['Note'])
  })

  it('drops a storage extension from the target', () => {
    expect(parseWikilinks('[[Note.md]]')).toEqual(['Note'])
  })

  it('is a fixed point for repeated storage suffixes', () => {
    expect(normalizeWikilinkTarget('Foo.md.md')).toBe('Foo')
    expect(normalizeWikilinkTarget(normalizeWikilinkTarget('Foo.md.md'))).toBe('Foo')
    expect(parseWikilinks('[[Foo.md.md]]')).toEqual(['Foo'])
  })

  it('canonicalizes harmless directory separators as a fixed point', () => {
    for (const target of ['a/./Foo', 'a//Foo', 'a\\Foo']) {
      expect(normalizeWikilinkTarget(target)).toBe('a/Foo')
      expect(normalizeWikilinkTarget(normalizeWikilinkTarget(target))).toBe('a/Foo')
    }
    // Unsafe intent stays visible for the create guard; it is never resolved away.
    expect(normalizeWikilinkTarget('../Foo')).toBe('../Foo')
    expect(normalizeWikilinkTarget('/Foo')).toBe('/Foo')
  })

  it('round-trips opaque ids without confusing an id suffix for storage syntax', () => {
    const target = encodeWikilinkIdentity('foo.md#with|syntax]')
    expect(parseWikilinks(`[[${target}|alias]]`)).toEqual([target])
    expect(decodeWikilinkIdentity(target)).toBe('foo.md#with|syntax]')
    expect(isCreatableWikilinkTarget(target)).toBe(false)
    expect(isCreatableWikilinkTarget('Missing Note')).toBe(true)
    expect(isWikilinkIdentityTarget('notarium-id:%zz')).toBe(true)
    expect(decodeWikilinkIdentity('notarium-id:%zz')).toBeNull()
    expect(decodeWikilinkIdentity('notarium-id:%0A')).toBeNull()
    expect(isCreatableWikilinkTarget('notarium-id:%zz')).toBe(false)
  })

  it('keeps a literal `.md` inside a noncanonical identity payload opaque', () => {
    expect(normalizeWikilinkTarget('notarium-id:foo.md')).toBe('notarium-id:foo.md')
    expect(parseWikilinks('[[notarium-id:foo.md|dotted id]]')).toEqual(['notarium-id:foo.md'])
    expect(normalizeWikilinkTarget('notarium-id:foo#bar')).toBe('notarium-id:foo#bar')
    expect(decodeWikilinkIdentity(normalizeWikilinkTarget('notarium-id:foo#bar'))).toBe('foo#bar')
  })

  it('ignores empty and whitespace-only targets', () => {
    expect(parseWikilinks('[[ ]] [[|alias]] [[#only-fragment]]')).toEqual([])
  })

  it('handles paths and an empty body', () => {
    expect(parseWikilinks('see [[dir/Sub Note]]')).toEqual(['dir/Sub Note'])
    expect(parseWikilinks('')).toEqual([])
  })

  it('never spans physical or Unicode line separators', () => {
    for (const separator of ['\n', '\r', String.fromCharCode(0x85), String.fromCharCode(0x2028)]) {
      expect(parseWikilinks(`[[Foo${separator}Bar]]`)).toEqual([])
      expect(parseWikilinks(`[[dir${separator}/Note]]`)).toEqual([])
    }
  })

  it('ignores escaped links and every Markdown code context', () => {
    expect(
      parseWikilinks(
        [
          '\\[[Escaped]] and `[[Inline]]` and [[Real]]',
          '',
          '    [[Indented]]',
          '```md',
          '[[Fenced]]',
          '```',
          '~~~',
          '[[Tilde fenced]]',
          '~~~',
        ].join('\n'),
      ),
    ).toEqual(['Real'])
  })

  it('tracks inline code spans across soft line breaks', () => {
    expect(parseWikilinks('`code\n[[Hidden]]\n` and [[Real]]')).toEqual(['Real'])
    expect(parseWikilinks('``code\n[[Hidden too]]\n``')).toEqual([])
  })

  it('does not mistake indented paragraph or list continuation for a code block', () => {
    expect(parseWikilinks('- item\n    [[List target]]')).toEqual(['List target'])
    expect(parseWikilinks('paragraph\n    [[Paragraph target]]')).toEqual(['Paragraph target'])
    expect(parseWikilinks('    [[Actual code]]')).toEqual([])
  })

  it('follows CommonMark block boundaries when deciding whether indented text is code', () => {
    expect(parseWikilinks('# heading\n    [[Heading code]]')).toEqual([])
    expect(parseWikilinks('---\n    [[Thematic code]]')).toEqual([])
    expect(parseWikilinks('>    [[Quoted prose]]')).toEqual(['Quoted prose'])
    expect(parseWikilinks('>     [[Quoted code]]')).toEqual([])
    expect(parseWikilinks('<pre>\n[[Raw html]]\n</pre>')).toEqual([])
  })

  it('ignores wikilink-shaped text inside every rendered math delimiter', () => {
    expect(parseWikilinks('$[[Inline dollar]]$')).toEqual([])
    expect(parseWikilinks('\\([[Inline paren]]\\)')).toEqual([])
    expect(parseWikilinks('$$\n[[Block dollar]]\n$$')).toEqual([])
    expect(parseWikilinks('\\[\n[[Block bracket]]\n\\]')).toEqual([])
  })

  // What the BLOCK math tokenizer does that the inline one cannot: swallow a line
  // the block grammar would otherwise open a new block on. The inline reading only
  // ever sees the text of one block, so it stops at the list marker and the two
  // delimiters never pair up — which is why the renderer registers both, and why
  // the extractor has to register both to agree with it.
  it('ignores a display block that swallows a line the inline reading cannot', () => {
    expect(parseWikilinks('$$\n- [[Block dollar]]\n$$')).toEqual([])
    expect(parseWikilinks('\\[\n- [[Block bracket]]\n\\]')).toEqual([])
  })

  // The renderer sees these, so the graph must too. Each one was lost when a
  // hand-written scanner applied a math or raw-HTML barrier the lexer does not:
  // `$$`/`\[`/`\(` never span a blank line, a cell is not a document, and an HTML
  // block inside a list item ends where the item does.
  it('keeps the links an opener only looks like it hides', () => {
    expect(parseWikilinks('$$ not math\n\npara [[Real]]\n\n$$ end')).toEqual(['Real'])
    expect(parseWikilinks('\\[ not math\n\npara [[Real]]\n\n\\] end')).toEqual(['Real'])
    expect(parseWikilinks('\\( not math\n\npara [[Real]]\n\n\\) end')).toEqual(['Real'])
    expect(parseWikilinks('| $x | [[Real]] | y$ |\n| --- | --- | --- |\n| a | b | c |')).toEqual([
      'Real',
    ])
    expect(parseWikilinks('- item\n  <div>\n  x\n  </div>\n- [[Real]]')).toEqual(['Real'])
  })
})

// The degraded reading, reachable only if the lexer itself throws. It feeds the
// graph and nothing else — no rewrite consumes it — so its imprecision costs an
// edge the renderer would not draw, never a byte of a note. That is the whole
// reason it is allowed to be a second, simpler grammar at all.
describe('scanWikilinksFallback', () => {
  it('hides what a code context hides', () => {
    expect(
      scanWikilinksFallback(
        [
          '\\[[Escaped]] and `[[Inline]]` and [[Real]]',
          '',
          '    [[Indented]]',
          '```md',
          '[[Fenced]]',
          '```',
        ].join('\n'),
      ),
    ).toEqual(['Real'])
  })

  it('reports what the renderer swallows in math and raw HTML — and stays wrong there', () => {
    expect(scanWikilinksFallback('<div>\n[[Hidden]]\n</div>')).toEqual(['Hidden'])
    expect(scanWikilinksFallback('$$\n[[Hidden]]\n$$')).toEqual(['Hidden'])
    // Teaching it those barriers is what cost the links below, which the renderer
    // does draw. An over-reported edge is recoverable; a link the graph never saw
    // is not, and this reading exists to lose as little as possible.
    expect(scanWikilinksFallback('$$ not math\n\npara [[Real]]\n\n$$ end')).toEqual(['Real'])
    expect(scanWikilinksFallback('| $x | [[Real]] | y$ |')).toEqual(['Real'])
    expect(scanWikilinksFallback('- item\n  <div>\n  x\n  </div>\n- [[Real]]')).toEqual(['Real'])
  })
})

// Answer with `reading` the first time the rewrite locates its links, then hand
// the real extractor back — so a test can put a link where it is not without also
// blinding the check that reads the result.
const once = (reading: { target: string; start: number | null }[]) => {
  let spent = false

  return (tokens: readonly unknown[], lexed: string) => {
    if (spent) {
      return actualLocateWikilinks(tokens, lexed)
    }
    spent = true

    return reading
  }
}

const refused = (rewriting: () => string): unknown => {
  try {
    rewriting()
  } catch (error) {
    return error
  }

  return undefined
}

describe('rewriteWikilinkIdentities', () => {
  const map = new Map([
    ['src-1', 'tgt-1'],
    ['src-2', 'tgt-2'],
  ])
  const rewrite = (markdown: string) => rewriteWikilinkIdentities(markdown, map)

  it('repoints an exact identity link and keeps its alias', () => {
    expect(rewrite('see [[notarium-id:src-1]] and [[notarium-id:src-2|Human label]]')).toBe(
      'see [[notarium-id:tgt-1]] and [[notarium-id:tgt-2|Human label]]',
    )
  })

  it('resolves forward, backward and cyclic references alike', () => {
    expect(
      rewrite('[[notarium-id:src-2]] then [[notarium-id:src-1]] then [[notarium-id:src-2]]'),
    ).toBe('[[notarium-id:tgt-2]] then [[notarium-id:tgt-1]] then [[notarium-id:tgt-2]]')
  })

  it('leaves an identity outside the map exactly as authored', () => {
    expect(rewrite('[[notarium-id:elsewhere]]')).toBe('[[notarium-id:elsewhere]]')
  })

  it('leaves a malformed reserved target alone', () => {
    expect(rewrite('[[notarium-id:%ZZ]]')).toBe('[[notarium-id:%ZZ]]')
  })

  it('never touches ordinary human links', () => {
    const source = '[[Title]] and [[folder/note.md]] and [x](a.md) and [[src-1]]'

    expect(rewrite(source)).toBe(source)
  })

  it('leaves every non-rendering context byte-identical', () => {
    for (const source of [
      '`[[notarium-id:src-1]]`',
      '```\n[[notarium-id:src-1]]\n```',
      '    [[notarium-id:src-1]]',
      '$$\n[[notarium-id:src-1]]\n$$',
      '$[[notarium-id:src-1]]$',
      '<pre>\n[[notarium-id:src-1]]\n</pre>',
      '\\[[notarium-id:src-1]]',
    ]) {
      expect(rewrite(source)).toBe(source)
    }
  })

  // The failure this exists to prevent, in the shape it actually takes: a vault
  // note that keeps its old link in an HTML comment. The comment is not a link and
  // must not move; the two real links must.
  it('rewrites the real links of a note whose comment repeats one of their ids', () => {
    const source = [
      '<!--',
      'old: [[notarium-id:src-2]]',
      '-->',
      '',
      'See [[notarium-id:src-1]] and [[notarium-id:src-2]].',
    ].join('\n')

    expect(rewrite(source)).toBe(
      [
        '<!--',
        'old: [[notarium-id:src-2]]',
        '-->',
        '',
        'See [[notarium-id:tgt-1]] and [[notarium-id:tgt-2]].',
      ].join('\n'),
    )
  })

  // The same note with the comment INLINE, which is the shape a hand-written
  // scanner cannot see: it anchors an HTML block on a line start, and the code span
  // opened in the heading below closes only on the next line, hiding the live link
  // from it. Both constructs are the lexer's ordinary business, so the comment is
  // not a candidate and the link is.
  it('repoints the live link of a note whose comment quotes the same id mid-line', () => {
    const source = [
      'Draft <!-- old: [[notarium-id:src-1]] --> note.',
      '',
      '# Heading with a ` tick',
      'See [[notarium-id:src-1]] and a ` tick.',
    ].join('\n')

    expect(rewrite(source)).toBe(
      [
        'Draft <!-- old: [[notarium-id:src-1]] --> note.',
        '',
        '# Heading with a ` tick',
        'See [[notarium-id:tgt-1]] and a ` tick.',
      ].join('\n'),
    )
  })

  // Openers that open nothing. The renderer links every one of these, so the copy
  // has to repoint them; each was left addressing the source corpus while a barrier
  // that the lexer does not have decided the link was inside math or raw HTML.
  it('repoints the links the renderer sees past a false math or html opener', () => {
    for (const shape of [
      '$$ not math\n\npara [[ID]]\n\n$$ end',
      '\\[ not math\n\npara [[ID]]\n\n\\] end',
      '\\( not math\n\npara [[ID]]\n\n\\) end',
      '| $x | [[ID]] | y$ |\n| --- | --- | --- |\n| a | b | c |',
      '- item\n  <div>\n  x\n  </div>\n- [[ID]]',
    ]) {
      expect(rewrite(shape.replaceAll('[[ID]]', '[[notarium-id:src-1]]'))).toBe(
        shape.replaceAll('[[ID]]', '[[notarium-id:tgt-1]]'),
      )
    }
  })

  // Every place where the lexer reads a link out of something other than a verbatim
  // slice of the document: a marker stripped off each line, an indent expanded, a
  // cell trimmed and unescaped, a definition kept out of the tree, a paragraph
  // re-joined around a block opener. An offset is reconstructed for each, or the
  // rewrite refuses — it never edits a byte it cannot place.
  it('places a link inside every shape the lexer does not hand back verbatim', () => {
    for (const shape of [
      '> quoted [[ID]]\n> more',
      '> > deep [[ID]]',
      '- item [[ID]]\n  - nested',
      '- para one\n\n  para two [[ID]]',
      '- [x] done [[ID]]',
      '-\t[[ID]]',
      '## Head [[ID]] ##',
      'Head [[ID]]\n=====',
      '**bold [[ID]]** and *em*',
      '| a | [[ID]] |\n| --- | --- |\n| b | c |',
      '| [[ID\\|Label]] | x |',
      // A link further along the same cell sits one byte further along than the
      // cell text says, for every separator the cell had to escape before it.
      '| [[notarium-id:elsewhere\\|Label]] and [[ID]] |\n| --- |\n| x |',
      '| a |\n| --- |\n| [[notarium-id:elsewhere\\|Label]] and [[ID]] |',
      'para [[ID]]\n[ref]: http://example.test',
      '[ref]: http://example.test\n\npara [[ID]]',
      '> [[ID]]\n[ref]: http://example.test\nmore',
      // The definition inside a list item leaves a gap the walker steps over, and
      // the token after it must be found by where it is rather than by what is
      // left of the string — the two look the same until the last token of a
      // container is the one being placed.
      '* first [[notarium-id:elsewhere]]\n    [ref]: http://example.test\n    para [[ID]]\n',
      '- [ ] task [[notarium-id:elsewhere]]\n\t[ref]: http://example.test\n\tpara [[ID]]\n',
      'para [[ID]]\n\\[ x \\]',
      'para [[ID]]\n\\[',
      '> [[ID]]\n> ===',
    ]) {
      expect(rewrite(shape.replaceAll('[[ID', '[[notarium-id:src-1'))).toBe(
        shape.replaceAll('[[ID', '[[notarium-id:tgt-1'),
      )
    }
  })

  // The lexer reads a normalized copy — CRLF collapsed, a leading tab run expanded
  // — and reports offsets into THAT. The document that goes back to disk is the
  // author's, so an offset has to be carried back to it: a line ending the copy
  // rewrote is a line ending the author keeps.
  it('edits the bytes the author wrote, not the copy the lexer read', () => {
    for (const shape of [
      'a [[ID]]\r\n\r\npara [[notarium-id:src-2]]\r\n',
      '> [[ID]]\r\n> more [[notarium-id:src-2]]',
      '- [[ID]]\r\n- [[notarium-id:src-2]]',
      '| a | b |\r\n| --- | --- |\r\n| [[ID]] | [[notarium-id:src-2]] |',
      '- item\n\t[[ID]] and [[notarium-id:src-2]]',
    ]) {
      expect(rewrite(shape.replaceAll('[[ID]]', '[[notarium-id:src-1]]'))).toBe(
        shape.replaceAll('[[ID]]', '[[notarium-id:tgt-1]]').replaceAll('src-2', 'tgt-2'),
      )
    }
    // The tabbed line is indented code, so it is not a link and does not move —
    // and the four spaces it becomes must not shift the link that follows either.
    expect(rewrite('para\n\n\t[[notarium-id:src-1]]\n\nafter [[notarium-id:src-2]]')).toBe(
      'para\n\n\t[[notarium-id:src-1]]\n\nafter [[notarium-id:tgt-2]]',
    )
  })

  // The tab expansion is not one pass over the document: the lexer re-runs it on the
  // content of every container, so a tab that becomes leading only once `> ` or a
  // list marker comes off is expanded THERE. Obsidian writes exactly this by
  // default — a nested list item is indented with a tab, and `> [!note]` with a
  // nested list is the canonical callout — so getting it wrong refuses the whole
  // note, not one link, and leaves every other link of that note addressing the
  // source corpus.
  it('follows the tab expansion into every container the lexer recurses into', () => {
    for (const shape of [
      '> - a\n> \t- b [[ID]]\n',
      '> - a\n> \t- b [[ID]]',
      '> [!note] Title\n> - a\n> \t- b [[ID]]\n',
      '> > - a\n> > \t- b [[ID]]\n',
      '- x\n  > - a\n  > \t- b [[ID]]\n',
      '> - a\n> \tcont [[ID]]\n',
      '- [ ] task\n\t- nested [[ID]]\n',
      '> - [ ] task\n> \t- nested [[ID]]\n',
      // The same bytes spelled with spaces, which never needed the expansion.
      '> - a\n>     - b [[ID]]\n',
    ]) {
      expect(rewrite(shape.replaceAll('[[ID]]', '[[notarium-id:src-1]]'))).toBe(
        shape.replaceAll('[[ID]]', '[[notarium-id:tgt-1]]'),
      )
    }
  })

  // A blockquote that swallowed a lazy continuation is handed back with a trailing
  // `\n` the string it was read from does not have — the document ended without
  // one, or the list tokenizer trimmed the item text after the quote inside it was
  // built. Both are plain Obsidian: a note saved without a final newline, and a
  // checklist item holding a quoted sub-list.
  it('places a container whose raw closes with a newline the document lacks', () => {
    for (const shape of [
      '> - x\n[[ID]]',
      '> quoted [[ID]]\nlazy tail',
      '- [ ] > - item\n      >   lazy [[ID]]\n',
      '- > - item\nlazy [[ID]]\n',
      '- > - item\nlazy [[ID]]',
    ]) {
      expect(rewrite(shape.replaceAll('[[ID]]', '[[notarium-id:src-1]]'))).toBe(
        shape.replaceAll('[[ID]]', '[[notarium-id:tgt-1]]'),
      )
    }
  })

  // The check that depends on no reconstruction of ours: read the result back with
  // the extractor and require the links of the copy to be the links of the original
  // under the map. It catches a corrupted construct and a lost one alike, which is
  // why the rewrite runs it before returning anything.
  it('reads the result back and requires the copy to hold the original links', () => {
    const corpus = [
      'See [[notarium-id:src-1]] and [[notarium-id:src-2|Human label]] and [[Plain Note]].',
      '',
      '<!-- old: [[notarium-id:src-1]] -->',
      '',
      '> quoted [[notarium-id:src-2]]',
      '> - listed [[notarium-id:src-1]]',
      '',
      '| a | [[notarium-id:src-1\\|Label]] |',
      '| --- | --- |',
      '| `[[notarium-id:src-2]]` | [[notarium-id:src-2]] |',
      '',
      '```md',
      '[[notarium-id:src-1]]',
      '```',
      '',
      '    [[notarium-id:src-2]]',
      '',
      '$$',
      '[[notarium-id:src-1]]',
      '$$',
      '',
      '[ref]: http://example.test',
      'tail [[notarium-id:src-2]]',
    ].join('\n')
    const rewritten = rewrite(corpus)

    expect(parseWikilinks(rewritten)).toEqual(
      parseWikilinks(corpus).map((target) => target.replace('src-', 'tgt-')),
    )
    expect(parseWikilinks(corpus).length).toBe(8)
    // A map that renames nothing must not move one byte: the same offsets, the
    // same encoding, the same document.
    expect(
      rewriteWikilinkIdentities(
        corpus,
        new Map([
          ['src-1', 'src-1'],
          ['src-2', 'src-2'],
        ]),
      ),
    ).toBe(corpus)
  })

  // Ordinary Markdown DOES reach the refusal — the test below this one names the
  // shapes — so it is not a hypothetical seam. It is mocked here only to pin the
  // message: the reading is replaced to produce an unplaced link on demand, which
  // no particular document is needed for and no document is guaranteed to keep
  // producing.
  it('refuses the note when a link it must repoint cannot be placed', async () => {
    vi.resetModules()
    vi.doMock('./tokenOffsets', async () => {
      const found = await vi.importActual<TokenOffsets>('./tokenOffsets')

      // Only the reading that drives the rewrite is replaced; the read-back that
      // checks the result stays the real one.
      return { ...found, locateWikilinks: once([{ target: 'notarium-id:src-1', start: null }]) }
    })

    const unplaceable = await import('./wikilinks')
    const refusal = refused(() =>
      unplaceable.rewriteWikilinkIdentities('see [[notarium-id:src-1]]', map),
    )

    expect(refusal).toBeInstanceOf(unplaceable.WikilinkRewriteError)
    // The message names what it could not do: this refusal and the one below are
    // different failures, and a run that lost a repoint has to say which.
    expect((refusal as Error).message).toMatch(/cannot place \[\[notarium-id:src-1\]\]/)
    vi.doUnmock('./tokenOffsets')
    vi.resetModules()
  })

  // The shapes ordinary Markdown still refuses, pinned so the boundary is visible
  // instead of rediscovered. In each one marked hands back a `raw` that is not a
  // slice of the string it read — a nested blockquote spliced by length after a
  // lazy continuation comes back as `> > > a`, an item whose definition was lifted
  // out comes back re-joined around blank lines that were never typed. There is no
  // offset to recover from those without asking a second grammar where the link
  // is, which is the failure this module exists to prevent, so it refuses instead.
  // A refusal is loud and per-note; the graph still gets every link.
  it('refuses, rather than guesses, where the lexer disowns its own raw', () => {
    for (const shape of [
      // A nested blockquote of two or more lines, closed by a lazy continuation.
      '> > quoted [[ID]]\n> > more\nlazy tail',
      // A link reference definition inside a list item, with content after it.
      '- item\n[ref]: http://example.test\n[[ID]]\ntail',
      // A list item indented by a tab run the list tokenizer re-spaces in place.
      '1. item\n\t \t[[ID]]',
    ]) {
      const source = shape.replaceAll('[[ID]]', '[[notarium-id:src-1]]')

      expect(refused(() => rewrite(source))).toBeInstanceOf(WikilinkRewriteError)
      // Refused for the rewrite, never dropped from the graph.
      expect(parseWikilinks(source)).toEqual(['notarium-id:src-1'])
    }
  })

  // A misplaced offset is the failure no per-edit check can see: the bytes there
  // ARE a `[[…]]` with that very address, so re-reading the construct agrees.
  // Only reading the whole result back catches it — here the construct sits in a
  // code span, so the copy would hold no link where the original held none.
  it('refuses a repoint that lands on a construct the renderer does not link', async () => {
    vi.resetModules()
    vi.doMock('./tokenOffsets', async () => {
      const found = await vi.importActual<TokenOffsets>('./tokenOffsets')

      return { ...found, locateWikilinks: once([{ target: 'notarium-id:src-1', start: 1 }]) }
    })

    const misplaced = await import('./wikilinks')
    const refusal = refused(() =>
      misplaced.rewriteWikilinkIdentities('`[[notarium-id:src-1]]` and text', map),
    )

    expect(refusal).toBeInstanceOf(misplaced.WikilinkRewriteError)
    expect((refusal as Error).message).toMatch(/are not/)
    vi.doUnmock('./tokenOffsets')
    vi.resetModules()
  })

  it('preserves the escaped table separator and the surrounding markdown', () => {
    expect(rewrite('| [[notarium-id:src-1\\|Label]] | x |')).toBe(
      '| [[notarium-id:tgt-1\\|Label]] | x |',
    )
  })

  it('preserves whitespace around the address instead of re-serializing it', () => {
    expect(rewrite('[[  notarium-id:src-1  |  Label  ]]')).toBe(
      '[[  notarium-id:tgt-1  |  Label  ]]',
    )
  })

  it('percent-encodes an id whose spelling would look like storage syntax', () => {
    const rewritten = rewriteWikilinkIdentities(
      '[[notarium-id:src-1]]',
      new Map([['src-1', 'weird.md']]),
    )

    expect(rewritten).toBe(`[[${encodeWikilinkIdentity('weird.md')}]]`)
    expect(parseWikilinks(rewritten).map(decodeWikilinkIdentity)).toEqual(['weird.md'])
  })

  it('returns the very same string when nothing maps', () => {
    const source = 'plain [[Note]] body'

    expect(rewriteWikilinkIdentities(source, new Map())).toBe(source)
    expect(rewrite(source)).toBe(source)
  })
})

/** Seeded, so the corpus is the same corpus everywhere and a failure names the one
 *  seed that produced it instead of "sometimes". */
const rolls = (seed: number) => {
  let state = seed >>> 0

  return (bound: number) => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) % bound
  }
}

type Roll = (bound: number) => number

const some = <T>(roll: Roll, options: readonly T[]): T => options[roll(options.length)]

/** One document per seed, each construct carrying an address no other construct in
 *  that document has — so the oracle can say WHICH construct was mis-placed, and a
 *  link that moved onto its neighbour's bytes is a different failure than a link
 *  that did not move. */
const generated = (seed: number): string => {
  const roll = rolls(seed)
  let minted = 0
  const link = () => `[[notarium-id:s${String(++minted).padStart(3, '0')}]]`
  const prose = () => some(roll, ['alpha', 'beta gamma', 'x', 'delta'])

  const leaves: (() => string[])[] = [
    () => [`${prose()} ${link()} ${prose()}`],
    () => [`${prose()} ${link()}`, `soft ${link()} break`],
    () => [`## Head ${link()} ##`],
    () => [`Head ${link()}`, some(roll, ['=====', '-----'])],
    () => [`**bold ${link()}** and *em ${link()}*`],
    () => ['```md', link(), '```'],
    () => [`a \`${link()}\` b ${link()}`],
    () => ['$$', link(), '$$'],
    () => [`inline $${link()}$ and ${link()}`],
    () => [`<!-- old: ${link()} -->`, `live ${link()}`],
    () => ['<div>', `raw ${link()}`, '</div>'],
    () => [`| a | ${link()} |`, '| --- | --- |', `| ${link()} | \`${link()}\` |`],
    () => [`| ${link().slice(0, -2)}\\|Label]] and ${link()} |`, '| --- |', `| ${prose()} |`],
    () => [`- [x] done ${link()}`, `- plain ${link()}`],
  ]

  const under = (lines: readonly string[], marker: string) => lines.map((line) => marker + line)

  const block = (depth: number): string[] => {
    if (depth === 0) {
      return some(roll, leaves)()
    }

    return some(roll, [
      () => under(block(depth - 1), '> '),
      () => ['> [!note] Title', ...under(block(depth - 1), '> ')],
      () => under(block(depth - 1), '> > '),
      () => {
        const bullet = some(roll, ['- ', '* ', '+ ', '1. '])

        return [
          `${bullet}first ${link()}`,
          ...under(block(depth - 1), some(roll, ['  ', '\t', '    '])),
          `${bullet}second ${link()}`,
        ]
      },
      () => [`- [ ] task ${link()}`, ...under(block(depth - 1), some(roll, ['  ', '\t']))],
    ])()
  }

  const parts: string[][] = []

  for (let at = roll(3); at >= 0; at--) {
    parts.push(block(roll(3)))
  }
  // The line after a blockquote, at the depth the quote is not: where marked hands
  // back a raw one `\n` longer than the string it read it out of.
  if (roll(3) === 0) {
    parts.push([`> quoted ${link()}`, `lazy ${link()}`])
  }
  if (roll(3) === 0) {
    parts.push([`> - listed ${link()}`, `lazy ${link()}`])
  }
  if (roll(3) === 0) {
    parts.push(['[ref]: http://example.test', `para ${link()}`])
  }
  const body = parts.map((lines) => lines.join('\n')).join(some(roll, ['\n\n', '\n\n\n']))
  // A note saved without a final newline, and one whose line endings are CRLF: both
  // are strings the lexer normalizes before it reports a single offset.
  const ended = roll(3) === 0 ? body : `${body}\n`

  return roll(5) === 0 ? ended.replaceAll('\n', '\r\n') : ended
}

/** What must hold for EVERY document, said in bytes rather than in shapes: the
 *  links `parseWikilinks` sees are exactly the links that move, and nothing else
 *  moves. Source and target ids are the same length, so the copy has to be the
 *  original with one `s` turned into a `t` per live link — one changed byte
 *  anywhere else is a document the author would not recognize. */
const misrewritten = (doc: string): string | null => {
  const ids = new Set<string>()

  for (const [, id] of doc.matchAll(/notarium-id:(s\d{3})/g)) {
    ids.add(id)
  }
  const live = parseWikilinks(doc)
  let out: string

  try {
    out = rewriteWikilinkIdentities(doc, new Map([...ids].map((id) => [id, `t${id.slice(1)}`])))
  } catch (error) {
    return `refused: ${(error as Error).message}`
  }
  const expected = live.map((target) => target.replace('notarium-id:s', 'notarium-id:t'))
  const actual = parseWikilinks(out)

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return `links ${JSON.stringify(actual)} are not ${JSON.stringify(expected)}`
  }
  if (out.length !== doc.length) {
    return `length ${out.length} is not ${doc.length}`
  }
  let moved = 0

  for (let at = 0; at < doc.length; at++) {
    if (doc[at] === out[at]) {
      continue
    }
    if (doc[at] !== 's' || out[at] !== 't' || !doc.startsWith('notarium-id:', at - 12)) {
      return `byte ${at} moved: ${JSON.stringify(doc.slice(at - 24, at + 24))}`
    }
    moved++
  }

  return moved === new Set(live).size
    ? null
    : `${moved} bytes moved for ${new Set(live).size} links`
}

// A generated corpus rather than a list: the failures this rewrite exists to
// prevent all came from a construct nobody thought to write down — a tab that only
// becomes leading one level in, a quote that closes a document without a final
// newline. Each document is checked against the extractor that decides what a link
// is, so the corpus needs no expected output of its own.
describe('rewriteWikilinkIdentities over a generated corpus', () => {
  it('repoints every live link and moves no other byte, across 400 documents', () => {
    const failures: string[] = []

    for (let seed = 1; seed <= 400; seed++) {
      const doc = generated(seed)
      const verdict = misrewritten(doc)

      if (verdict !== null) {
        failures.push(`seed ${seed} — ${verdict}\n${JSON.stringify(doc)}`)
      }
    }

    expect(failures).toEqual([])
  })

  // The corpus is only worth its runtime if it holds the constructs that broke the
  // reconstruction before: containers within containers, tabs under a marker, GFM
  // tables, Obsidian callouts, lazy continuations, CRLF and a missing final newline.
  it('draws all of those constructs', () => {
    const corpus = Array.from({ length: 400 }, (_, at) => generated(at + 1))
    const holds = (pattern: RegExp) => corpus.filter((doc) => pattern.test(doc)).length

    expect(holds(/^> \[!note]/m)).toBeGreaterThan(20)
    expect(holds(/^> > /m)).toBeGreaterThan(20)
    expect(holds(/^(?:> )*(?:[-*+]|\d+\.) .*\n(?:> )*\t/m)).toBeGreaterThan(20)
    expect(holds(/^\|.*\|$/m)).toBeGreaterThan(20)
    expect(holds(/^> .*\nlazy /m)).toBeGreaterThan(20)
    expect(holds(/\r\n/)).toBeGreaterThan(20)
    expect(corpus.filter((doc) => !doc.endsWith('\n')).length).toBeGreaterThan(20)
  })
})
