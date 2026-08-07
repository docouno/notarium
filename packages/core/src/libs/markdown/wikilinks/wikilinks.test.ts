import { describe, expect, it } from 'vitest'

import {
  decodeWikilinkIdentity,
  encodeWikilinkIdentity,
  isCreatableWikilinkTarget,
  isWikilinkIdentityTarget,
  normalizeWikilinkTarget,
  parseWikilinks,
} from './wikilinks'

describe('parseWikilinks', () => {
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
})
