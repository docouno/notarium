// frontmatterValue / upsertFrontmatterKey (#51): the channel the internal
// note-id travels through — read a file's `notarium-id` claim, materialize one
// into a body on save. Deliberately NOT a YAML parser: top-level scalar keys
// in the leading block only, honest null for anything fancier.

import { describe, expect, it } from 'vitest'
import { frontmatterValue, NOTE_ID_FRONTMATTER_KEY, upsertFrontmatterKey } from '@notarium/core'

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
