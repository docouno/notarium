import { describe, expect, it } from 'vitest'

import { parseNoteFile, serializeNoteFile } from './noteFile'

const BM_FILE = `---
title: Engine Live Probe
type: note
permalink: main/inbox/engine-live-probe
tags:
- probe
- engine
notarium-id: BfinKTnjxP1w
---

# Engine Live Probe

тело заметки со [[Ссылкой]]
`

describe('parseNoteFile', () => {
  it('reads the canonical file shape: title, flush-left tags, id claim, normalised body', () => {
    const p = parseNoteFile(BM_FILE, 'inbox/engine-live-probe.md')
    expect(p.title).toBe('Engine Live Probe')
    expect(p.tags).toEqual(['probe', 'engine'])
    expect(p.idClaim).toBe('BfinKTnjxP1w')
    expect(p.body).toBe('тело заметки со [[Ссылкой]]\n')
    expect(p.frontmatter.permalink).toBe('main/inbox/engine-live-probe')
  })

  it('falls back: H1 title, then the filename; no frontmatter is fine', () => {
    expect(parseNoteFile('# From Heading\n\nbody', 'dir/x.md').title).toBe('From Heading')
    expect(parseNoteFile('just prose', 'dir/some-note.md').title).toBe('some-note')
  })

  it('ignores a non-durable identity but preserves a fully opaque prefix-shaped one', () => {
    const lone = String.fromCharCode(0xd800)
    const parsed = parseNoteFile(`---\nnotarium-id: bad${lone}\n---\n\nbody`, 'bad.md')

    expect(parsed.idClaim).toBeNull()
    expect(
      parseNoteFile('---\nnotarium-id: notarium-id:foo\n---\n\nbody', 'reserved.md').idClaim,
    ).toBe('notarium-id:foo')
  })
})

describe('serializeNoteFile', () => {
  it('merges into the existing frontmatter — foreign keys (a permalink) survive an overwrite', () => {
    const out = serializeNoteFile({
      title: 'Engine Live Probe Two',
      tags: ['probe'],
      body: 'новое тело',
      existingRaw: BM_FILE,
    })
    expect(out).toContain('permalink: main/inbox/engine-live-probe')
    expect(out).toContain('notarium-id: BfinKTnjxP1w')
    expect(out).toContain('title: Engine Live Probe Two')
    expect(out).toContain('tags:\n- probe')
    expect(out).not.toContain('- engine')
  })

  it('round-trips: what write serializes, read parses back byte-for-byte', () => {
    const body = 'первая строка\n\nвторая [[Ссылка]]\n'
    const out = serializeNoteFile({ title: 'Раунд Трип', tags: ['a'], id: 'id-1', body })
    const p = parseNoteFile(out, 'raund-trip.md')
    expect(p.body).toBe(body)
    expect(p.title).toBe('Раунд Трип')
    expect(p.tags).toEqual(['a'])
    expect(p.idClaim).toBe('id-1')
  })

  it('quotes scalars YAML would misread (colon-space in a title)', () => {
    const out = serializeNoteFile({ title: 'A: B', body: '' })
    expect(out).toContain('title: "A: B"')
  })

  // #113 symptom B: the serializer escapes `"`/`\` inside a quoted scalar, so the
  // parser MUST un-escape them — else a title/tag with a leading quote round-trips
  // to `\"Gameverse\"`. parse∘serialize must be identity for quotes and backslashes.
  it('round-trips quotes and backslashes in title and tags (escaping is symmetric)', () => {
    for (const value of [
      '"Gameverse"',
      'Создание изображения "Куб 3D"',
      'a\\b path',
      'Re: "quoted" thing',
      'mix "q" and \\ slash',
    ]) {
      const out = serializeNoteFile({ title: value, tags: [value], id: 'id-q', body: 'b' })
      const p = parseNoteFile(out, 'q.md')
      expect(p.title).toBe(value)
      expect(p.tags).toEqual([value])
    }
  })

  it('a leading-quote title is YAML-quoted on write and verbatim on read', () => {
    const out = serializeNoteFile({ title: '"Gameverse"', body: '' })
    // Written as a valid double-quoted YAML scalar with the inner quotes escaped…
    expect(out).toContain('title: "\\"Gameverse\\""')
    // …and read back without the backslashes.
    expect(parseNoteFile(out, 'g.md').title).toBe('"Gameverse"')
  })

  // We never EMIT single-quoted scalars, but an externally-authored file can; the
  // shared unquoteScalar must un-escape YAML's `''`→`'` (guards that branch, #113).
  it("reads an externally-authored single-quoted scalar (YAML `''`→`'`)", () => {
    const raw = "---\ntitle: 'it''s a test'\n---\n\n# it's a test\n\nbody\n"
    expect(parseNoteFile(raw, 'x.md').title).toBe("it's a test")
  })

  it('writes the alias-history block and round-trips it (#100)', () => {
    // A rename: the new title plus the old one recorded as an alias.
    const out = serializeNoteFile({
      title: 'Гагарин',
      aliases: ['Королёв', 'BookStack'],
      id: 'id-2',
      body: 'тело',
    })
    expect(out).toContain('aliases:\n- Королёв\n- BookStack')
    const p = parseNoteFile(out, 'gagarin.md')
    expect(p.aliases).toEqual(['Королёв', 'BookStack'])
    expect(p.title).toBe('Гагарин')
  })

  it('aliases channel: undefined leaves an existing block untouched, [] drops it (tags-parity)', () => {
    const withAlias = serializeNoteFile({ title: 'T', aliases: ['Old'], body: '' })
    // undefined → the existing `aliases:` block is preserved as a passthrough.
    const kept = serializeNoteFile({ title: 'T', body: 'b', existingRaw: withAlias })
    expect(parseNoteFile(kept, 't.md').aliases).toEqual(['Old'])
    // [] → an explicit clear.
    const cleared = serializeNoteFile({
      title: 'T',
      aliases: [],
      body: 'b',
      existingRaw: withAlias,
    })
    expect(parseNoteFile(cleared, 't.md').aliases).toEqual([])
  })

  it('writes the slug scalar and round-trips it (#100 phase 1)', () => {
    const out = serializeNoteFile({ title: 'Quarterly Report', slug: 'q3', id: 'id-3', body: 'b' })
    expect(out).toContain('slug: q3')
    expect(parseNoteFile(out, 'quarterly-report.md').slug).toBe('q3')
  })

  it('slug channel: undefined leaves an existing `slug:` untouched, "" drops it (tags-parity)', () => {
    const withSlug = serializeNoteFile({ title: 'T', slug: 'custom', body: '' })
    // undefined → the existing `slug:` is preserved as a passthrough.
    const kept = serializeNoteFile({ title: 'T', body: 'b', existingRaw: withSlug })
    expect(parseNoteFile(kept, 't.md').slug).toBe('custom')
    // '' → an explicit clear back to the implicit default.
    const cleared = serializeNoteFile({ title: 'T', slug: '', body: 'b', existingRaw: withSlug })
    expect(parseNoteFile(cleared, 't.md').slug).toBeNull()
  })
})
