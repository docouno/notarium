import { describe, expect, it } from 'vitest'

import { frontmatterTags, frontmatterValue, unquoteScalar } from './frontmatter'

describe('frontmatterTags', () => {
  it('reads a block list', () => {
    expect(frontmatterTags('---\ntitle: X\ntags:\n  - alpha\n  - "beta"\n---\nbody')).toEqual([
      'alpha',
      'beta',
    ])
  })

  it('reads the flush-left block list the engine actually writes (caught live, #69)', () => {
    expect(frontmatterTags('---\ntitle: X\ntags:\n- probe\n- engine\n---\nbody')).toEqual([
      'probe',
      'engine',
    ])
  })

  it('reads a flow list and a scalar (comma-split, like normTags over a string)', () => {
    expect(frontmatterTags('---\ntags: [a, b]\n---\n')).toEqual(['a', 'b'])
    expect(frontmatterTags("---\ntags: 'one, two'\n---\n")).toEqual(['one', 'two'])
    expect(frontmatterTags('---\ntags: solo\n---\n')).toEqual(['solo'])
  })

  it('no frontmatter / no tags key / empty list → []', () => {
    expect(frontmatterTags('plain body')).toEqual([])
    expect(frontmatterTags('---\ntitle: X\n---\nbody')).toEqual([])
    expect(frontmatterTags('---\ntags:\nother: y\n---\n')).toEqual([])
  })
})

// the read-model snippet path must un-escape SYMMETRICALLY with the engine's
// serializer — the old asymmetric unquote left a `title: "\"Gameverse\""` as
// `\"Gameverse\"` in Feed/preview tags. unquoteScalar is the shared inverse.
describe('unquoteScalar (symmetric with the engine serializer, #113)', () => {
  it('un-escapes a double-quoted scalar (\\" → ", \\\\ → \\)', () => {
    expect(unquoteScalar('"\\"Gameverse\\""')).toBe('"Gameverse"')
    expect(unquoteScalar('"a\\\\b"')).toBe('a\\b')
  })
  it("un-escapes a single-quoted scalar ('' → ')", () => {
    expect(unquoteScalar("'it''s'")).toBe("it's")
  })
  it('leaves a plain scalar and inner whitespace alone', () => {
    expect(unquoteScalar('plain')).toBe('plain')
    expect(unquoteScalar('"  spaced  "')).toBe('  spaced  ')
  })
  it('frontmatterValue/frontmatterTags read a quoted title/tag without backslashes', () => {
    expect(frontmatterValue('---\ntitle: "\\"Gameverse\\""\n---\n', 'title')).toBe('"Gameverse"')
    expect(frontmatterTags('---\ntags:\n- "Re: \\"quoted\\""\n---\n')).toEqual(['Re: "quoted"'])
  })
})
