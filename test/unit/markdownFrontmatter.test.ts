// frontmatterValue / upsertFrontmatterKey (#51): the channel the internal
// note-id travels through — read a file's `notarium-id` claim, materialize one
// into a body on save. Deliberately NOT a YAML parser: top-level scalar keys
// in the leading block only, honest null for anything fancier.

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  FrontmatterGeometryError,
  frontmatterValue,
  NOTE_ID_FRONTMATTER_KEY,
  parseFrontmatterBlock,
  stripFrontmatter,
  upsertFrontmatterKey,
} from '@notarium/core'
import { parseNoteFile } from '@notarium/engine'

describe('frontmatterValue', () => {
  it('reads a scalar key from the leading frontmatter block', () => {
    const doc = '---\ntitle: Hello\nnotarium-id: abc123XYZ_-9\n---\n# Hello\n\nbody'
    expect(frontmatterValue(doc, 'title')).toBe('Hello')
    expect(frontmatterValue(doc, NOTE_ID_FRONTMATTER_KEY)).toBe('abc123XYZ_-9')
  })

  it('returns null when the document has no frontmatter block', () => {
    expect(
      frontmatterValue('# Hello\n\nnotarium-id: not-frontmatter', NOTE_ID_FRONTMATTER_KEY),
    ).toBeNull()
    expect(frontmatterValue('', NOTE_ID_FRONTMATTER_KEY)).toBeNull()
  })

  it('returns null for a missing key and for an empty value', () => {
    const doc = '---\ntitle: Hello\nempty:\n---\nbody'
    expect(frontmatterValue(doc, 'notarium-id')).toBeNull()
    expect(frontmatterValue(doc, 'empty')).toBeNull()
  })

  it('trims surrounding quotes (both kinds)', () => {
    expect(frontmatterValue("---\nnotarium-id: 'q-single-001'\n---\n", 'notarium-id')).toBe(
      'q-single-001',
    )
    expect(frontmatterValue('---\nnotarium-id: "q-double-001"\n---\n', 'notarium-id')).toBe(
      'q-double-001',
    )
  })

  it('the dashed key is matched literally — `notarium-id` is not a regex range', () => {
    // a doc whose OTHER keys could match a naive `notarium.id`-style pattern
    const doc = '---\nnotariumXid: wrong\nnotarium-id: right-one-001\n---\nbody'
    expect(frontmatterValue(doc, 'notarium-id')).toBe('right-one-001')
  })

  it('does not read past the closing fence', () => {
    const doc = '---\ntitle: T\n---\nnotarium-id: in-the-body\n'
    expect(frontmatterValue(doc, 'notarium-id')).toBeNull()
  })
})

describe('upsertFrontmatterKey', () => {
  it('creates a frontmatter block when the document has none, body untouched', () => {
    const out = upsertFrontmatterKey('# Hello\n\nbody', 'notarium-id', 'fresh-id-0001')
    expect(out).toBe('---\nnotarium-id: fresh-id-0001\n---\n# Hello\n\nbody')
    expect(frontmatterValue(out, 'notarium-id')).toBe('fresh-id-0001')
  })

  it('appends the key to an existing block, keeping the other keys and the body', () => {
    const doc = '---\ntitle: Hello\ntags:\n  - a\n---\n# Hello\n\nbody text'
    const out = upsertFrontmatterKey(doc, 'notarium-id', 'fresh-id-0001')
    expect(frontmatterValue(out, 'notarium-id')).toBe('fresh-id-0001')
    expect(frontmatterValue(out, 'title')).toBe('Hello')
    expect(out.endsWith('# Hello\n\nbody text')).toBe(true)
  })

  it('replaces the value when the key already exists (no duplicate lines)', () => {
    const doc = '---\nnotarium-id: old-id-000001\ntitle: T\n---\nbody'
    const out = upsertFrontmatterKey(doc, 'notarium-id', 'new-id-000001')
    expect(frontmatterValue(out, 'notarium-id')).toBe('new-id-000001')
    expect(out.match(/notarium-id/g)).toHaveLength(1)
    expect(out.endsWith('body')).toBe(true)
  })

  it('does not damage a body that itself contains a --- ruler', () => {
    const doc = '---\ntitle: T\n---\nintro\n\n---\n\noutro'
    const out = upsertFrontmatterKey(doc, 'notarium-id', 'fresh-id-0001')
    expect(out.endsWith('intro\n\n---\n\noutro')).toBe(true)
    expect(frontmatterValue(out, 'notarium-id')).toBe('fresh-id-0001')
  })

  it('round-trips with frontmatterValue on an empty document', () => {
    const out = upsertFrontmatterKey('', 'notarium-id', 'fresh-id-0001')
    expect(frontmatterValue(out, 'notarium-id')).toBe('fresh-id-0001')
  })
})

// The writer and the reader answer ONE question about where frontmatter is, and the
// writer changes only the bytes of its own entry. Every row below used to fail.
describe('upsertFrontmatterKey — only its own entry moves', () => {
  const ID = 'AbCdEfGhIjKl'
  const write = (doc: string) => upsertFrontmatterKey(doc, NOTE_ID_FRONTMATTER_KEY, ID)

  it('prefixes a real block instead of writing into prose the domain does not read', () => {
    const doc = '\n---\nA thought I wrote between two rules.\n---\nAnd the rest.\n'
    const out = write(doc)

    expect(parseFrontmatterBlock(doc)).toBeNull()
    expect(out).toBe(`---\n${NOTE_ID_FRONTMATTER_KEY}: ${ID}\n---\n${doc}`)
    expect(out.endsWith(doc)).toBe(true)
    expect(parseNoteFile(out, 'a/x.md').idClaim).toBe(ID)
  })

  it('treats an indented opening fence as the prose the parser says it is', () => {
    const doc = '   ---\ntitle: x\n---\nbody\n'
    const out = write(doc)

    expect(out).toBe(`---\n${NOTE_ID_FRONTMATTER_KEY}: ${ID}\n---\n${doc}`)
    expect(parseNoteFile(out, 'a/x.md').idClaim).toBe(ID)
  })

  it('replaces a multi-line node whole, keeping the neighbours byte-for-byte', () => {
    const out = write('---\nnotarium-id:\n  - foreign\ntitle: x\n---\nbody\n')

    expect(out).toBe(`---\n${NOTE_ID_FRONTMATTER_KEY}: ${ID}\ntitle: x\n---\nbody\n`)
    expect(parseNoteFile(out, 'a/x.md').idClaim).toBe(ID)
  })

  it('replaces a block scalar whole — its continuation lines do not survive as YAML', () => {
    const out = write('---\nnotarium-id: |\n  weird\ntitle: x\n---\nbody\n')

    expect(out).toBe(`---\n${NOTE_ID_FRONTMATTER_KEY}: ${ID}\ntitle: x\n---\nbody\n`)
    expect(parseNoteFile(out, 'a/x.md').idClaim).toBe(ID)
  })

  it('collapses duplicates onto the first slot, so reader and writer name the same entry', () => {
    const doc = '---\ntitle: X\nnotarium-id: AAAAAAAAAAAA\nnotarium-id: BBBBBBBBBBBB\n---\nbody\n'
    const out = write(doc)

    expect(out).toBe(`---\ntitle: X\n${NOTE_ID_FRONTMATTER_KEY}: ${ID}\n---\nbody\n`)
    expect(parseNoteFile(out, 'a/x.md').idClaim).toBe(ID)
    expect(write(out)).toBe(out) // idempotent: the second pass moves no byte
  })

  it('keeps the mark leading the file, and the note keeps its own heading title', () => {
    const out = write('\uFEFF# Hi\n\nbody\n')

    expect(out).toBe(`\uFEFF---\n${NOTE_ID_FRONTMATTER_KEY}: ${ID}\n---\n# Hi\n\nbody\n`)
    expect(parseNoteFile(out, 'a/x.md').title).toBe('Hi')
  })

  it('writes the line ending of the block it joins, not of some other part of the file', () => {
    // No block: the document's own ending is the only one there is.
    expect(write('# Hi\r\n\r\nbody\r\n')).toBe(
      `---\r\n${NOTE_ID_FRONTMATTER_KEY}: ${ID}\r\n---\r\n# Hi\r\n\r\nbody\r\n`,
    )
    expect(write('---\r\ntitle: X\r\n---\r\nbody\r\n')).toBe(
      `---\r\ntitle: X\r\n${NOTE_ID_FRONTMATTER_KEY}: ${ID}\r\n---\r\nbody\r\n`,
    )
    // An LF block under a CRLF body — a shape this project's own serializer writes.
    // A lone CRLF entry among LF ones is an ending nobody in that block chose.
    expect(write('---\ntitle: X\n---\nbody\r\nmore\r\n')).toBe(
      `---\ntitle: X\n${NOTE_ID_FRONTMATTER_KEY}: ${ID}\n---\nbody\r\nmore\r\n`,
    )
    // Whatever the line endings, the reader has to find the claim the writer just wrote.
    for (const doc of [
      '# Hi\r\n\r\nbody\r\n',
      '---\r\ntitle: X\r\n---\r\nbody\r\n',
      '---\ntitle: X\n---\nbody\r\nmore\r\n',
    ]) {
      expect(parseNoteFile(write(doc), 'a/x.md').idClaim).toBe(ID)
    }
  })

  it("does not read the key out of somebody else's block scalar", () => {
    const out = write('---\nsummary: |\n  notarium-id: fake\ntitle: x\n---\nbody\n')

    expect(out).toBe(
      `---\nsummary: |\n  notarium-id: fake\ntitle: x\n${NOTE_ID_FRONTMATTER_KEY}: ${ID}\n---\nbody\n`,
    )
    expect(parseNoteFile(out, 'a/x.md').idClaim).toBe(ID)
  })

  it('refuses rather than orphan a neighbour aliasing the anchor on its own entry', () => {
    const payload = 'title: A\nnotarium-id: &i AbCdEfGhIjKl\nmirror: *i\n'
    const doc = `---\n${payload}---\nbody\n`

    expect(() => parseYaml(payload)).not.toThrow()
    // What a value-blind rewrite leaves behind: the anchor gone, the alias dangling.
    expect(() => parseYaml(payload.replace('&i AbCdEfGhIjKl', ID))).toThrow(/alias/i)
    expect(() => write(doc)).toThrow(FrontmatterGeometryError)
    expect(() => write(doc)).toThrow(/anchored/)
  })

  it('writes past an anchor that belongs to another entry', () => {
    const out = write('---\ntitle: &t A\nnotarium-id: OldIdentity01\n---\nbody\n')

    expect(out).toBe(`---\ntitle: &t A\n${NOTE_ID_FRONTMATTER_KEY}: ${ID}\n---\nbody\n`)
    expect(parseNoteFile(out, 'a/x.md').idClaim).toBe(ID)
  })

  it('answers the same question stripFrontmatter and the parser do', () => {
    const doc = '\n---\nA thought I wrote between two rules.\n---\nAnd the rest.\n'

    expect(parseFrontmatterBlock(doc)).toBeNull()
    expect(stripFrontmatter(doc)).toBe(doc)
    expect(write(doc).endsWith(doc)).toBe(true)
  })
})
