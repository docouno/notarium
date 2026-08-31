import { describe, expect, it } from 'vitest'

import {
  claudeConversationSourceLocator,
  DEFAULT_NOTE_TYPE,
  FRONTMATTER_BYTE_CAP,
  frontmatterEntryValue,
  FrontmatterLimitError,
  frontmatterPayloadBounds,
  frontmatterScalarEntry,
  IMPORT_SOURCE_FRONTMATTER_KEY,
  markdownFileToNote,
  parseFrontmatterBlock,
  parseNoteFields,
  promoteBodyTitle,
  PROTECTED_FIELD_KEYS,
} from '@notarium/core'

import { assembleNoteFile, parseNoteFile, serializeNoteFile } from './noteFile'

const YAML_NODE_REFERENCE_WRITE_ERROR =
  'frontmatter with YAML anchors or aliases is not supported by writes'

const physicalLines = (raw: string): string[] => raw.match(/[^\n]*\n|[^\n]+$/g) ?? []

const changedPhysicalLines = (before: string, after: string): number => {
  const left = physicalLines(before)
  const right = physicalLines(after)

  expect(right).toHaveLength(left.length)
  return left.filter((line, index) => line !== right[index]).length
}

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
  it('projects the view marker separately and keeps nota config out of semantic body', () => {
    const raw = [
      '---',
      'title: Sprint',
      'view: board',
      '---',
      '',
      '# Sprint',
      '',
      'Visible prose.',
      '',
      '```nota',
      'version: 1',
      'source: { kind: notes }',
      'views: [{ name: Board, type: board, options: { groupBy: note.status } }]',
      '```',
    ].join('\n')
    const parsed = parseNoteFile(raw, 'sprint.md')

    expect(parsed.viewType).toBe('board')
    expect(parsed.body).toContain('note.status')
    expect(parsed.semanticBody).toContain('Visible prose.')
    expect(parsed.semanticBody).not.toContain('note.status')
  })

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

  it('steps over the encoding prologue on a frontmatter-less file, as the frontmatter branch does', () => {
    const marked = parseNoteFile('\uFEFF# From Heading\n\nbody\n', 'dir/x.md')

    expect(marked.title).toBe('From Heading')
    expect(marked.body).toBe('body\n')
    expect(parseNoteFile('\uFEFF---\ntitle: Front\n---\n\nbody\n', 'dir/x.md').title).toBe('Front')
    // Exactly one mark leads a file; a second one is ordinary content, which is
    // also how the frontmatter reader and documentState read it.
    expect(parseNoteFile('\uFEFF\uFEFF# From Heading\n\nbody\n', 'dir/x.md').title).toBe('x')
  })

  it('keeps the deliberate legacy column-zero/anywhere H1 fallback exactly', () => {
    const raw = 'lead paragraph\n\n# Legacy Title ###\n\nbody'
    const parsed = parseNoteFile(raw, 'dir/fallback.md')

    expect(parsed.title).toBe('Legacy Title ###')
    // Title discovery is deliberately anywhere; body stripping is deliberately
    // opening-only, so the later heading remains authored content.
    expect(parsed.body).toBe(raw)
  })

  it('keeps the old JavaScript-whitespace capture around a legacy H1 title', () => {
    expect(parseNoteFile('#\u00a0\u2003Unicode title\u2003\u00a0', 'fallback.md').title).toBe(
      'Unicode title',
    )
    expect(parseNoteFile('# Unicode title\u00a0\u2003', 'fallback.md').title).toBe('Unicode title')
    // The old greedy `\s+` + non-empty capture left the final whitespace as the
    // title when at least two dot-compatible whitespace characters followed `#`.
    expect(parseNoteFile('# \u00a0', 'fallback.md').title).toBe('\u00a0')
  })

  it('finds the legacy anywhere H1 across CR-only physical lines without rewriting bytes', () => {
    const raw = 'lead paragraph\r# CR title\rbody'
    const parsed = parseNoteFile(raw, 'dir/fallback.md')

    expect(parsed.title).toBe('CR title')
    expect(parsed.body).toBe(raw)
  })

  it('finds the legacy anywhere H1 across Unicode line separators without rewriting bytes', () => {
    for (const separator of ['\u2028', '\u2029']) {
      const raw = `lead paragraph${separator}# Unicode title${separator}body`
      const parsed = parseNoteFile(raw, 'dir/fallback.md')

      expect(parsed.title).toBe('Unicode title')
      expect(parsed.body).toBe(raw)
    }
  })

  it('keeps the legacy cross-line bare-H1 fallback', () => {
    expect(parseNoteFile('#\nReal title\nbody', 'fallback.md').title).toBe('Real title')
  })

  it('does not read indented code or a leading-tab line as the legacy H1 fallback', () => {
    expect(parseNoteFile('   # heading\nbody', 'dir/three-spaces.md').title).toBe('three-spaces')
    expect(parseNoteFile('    # code\nbody', 'dir/four-spaces.md').title).toBe('four-spaces')
    expect(parseNoteFile('\t# code\nbody', 'dir/tab.md').title).toBe('tab')
  })

  it('scales across many physical-line near misses before the anywhere H1', () => {
    const raw = `${'    # indented code\n'.repeat(20_000)}# Actual ###\nbody`
    const started = Date.now()
    const parsed = parseNoteFile(raw, 'dir/fallback.md')

    expect(parsed.title).toBe('Actual ###')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('ignores a non-durable identity but preserves a fully opaque prefix-shaped one', () => {
    const lone = String.fromCharCode(0xd800)
    const parsed = parseNoteFile(`---\nnotarium-id: bad${lone}\n---\n\nbody`, 'bad.md')

    expect(parsed.idClaim).toBeNull()
    expect(
      parseNoteFile('---\nnotarium-id: notarium-id:foo\n---\n\nbody', 'reserved.md').idClaim,
    ).toBe('notarium-id:foo')
  })

  it('lets an unreadable last duplicate clear every earlier readable projection', () => {
    const raw = [
      '---',
      'title: Stale title',
      'title:',
      '  locale: New title',
      'type: person',
      'type:',
      '  kind: event',
      'tags: [stale]',
      'tags:',
      '  source: nested',
      'aliases: [Old Name]',
      'aliases:',
      '  locale: en',
      'slug: stale-slug',
      'slug:',
      '  generated: false',
      'created: 1999-01-01',
      'created:',
      '  source: legacy',
      'notarium-id: AAAAAAAAAAAA',
      'notarium-id:',
      '  source: legacy',
      '---',
      '# Live heading',
      '',
      'body',
    ].join('\n')
    const parsed = parseNoteFile(raw, 'fallback.md')

    expect(parsed.title).toBe('Live heading')
    expect(parsed.noteType).toBeNull()
    expect(parsed.tags).toEqual([])
    expect(parsed.aliases).toEqual([])
    expect(parsed.slug).toBeNull()
    expect(parsed.createdAt).toBeNull()
    expect(parsed.idClaim).toBeNull()
    expect(parsed.frontmatter).not.toHaveProperty('title')
    expect(parsed.frontmatter).not.toHaveProperty('type')
    expect(parsed.frontmatter).not.toHaveProperty('tags')
    expect(parsed.frontmatter).not.toHaveProperty('aliases')
    expect(parsed.frontmatter).not.toHaveProperty('slug')
    expect(parsed.frontmatter).not.toHaveProperty('created')
    expect(parsed.frontmatter).not.toHaveProperty('notarium-id')
  })
})

describe('notarium-source file truth', () => {
  const locator = claudeConversationSourceLocator('conversation-一')!
  const carried = (value: string) => [
    { key: IMPORT_SOURCE_FRONTMATTER_KEY, lines: [`${IMPORT_SOURCE_FRONTMATTER_KEY}: ${value}`] },
  ]

  it('projects only a canonical direct-file claim and hides the raw key', () => {
    const parsed = parseNoteFile(
      `---\n${IMPORT_SOURCE_FRONTMATTER_KEY}: ${locator}\nauthor: S\n---\n\n# T\n\nbody`,
      't.md',
    )

    expect(parsed.sourceLocator).toBe(locator)
    expect(parsed.frontmatter).toEqual({ author: 'S' })
    expect(
      parseNoteFile(`---\n${IMPORT_SOURCE_FRONTMATTER_KEY}: authored\n---\n\n# T`, 't.md')
        .sourceLocator,
    ).toBeNull()
  })

  it('strips fresh raw/inline spoofing, preserves a live claim and materializes typed provenance', () => {
    const spoofed = serializeNoteFile({
      title: 'T',
      body: `---\n${IMPORT_SOURCE_FRONTMATTER_KEY}: ${locator}\n---\n\nbody`,
      frontmatter: carried(locator),
    })
    expect(spoofed).not.toContain(IMPORT_SOURCE_FRONTMATTER_KEY)

    const tagged = serializeNoteFile({ title: 'T', body: 'body', sourceLocator: locator })
    expect(parseNoteFile(tagged, 't.md').sourceLocator).toBe(locator)

    const edited = serializeNoteFile({ title: 'T2', body: 'new', existingRaw: tagged })
    expect(parseNoteFile(edited, 't.md').sourceLocator).toBe(locator)
  })

  it('restores the historical locator through full-state replace', () => {
    const historical = serializeNoteFile({ title: 'Old', body: 'old', sourceLocator: locator })
    const state = parseNoteFile(historical, 'old.md')
    const restored = serializeNoteFile({
      title: state.title,
      body: state.body,
      frontmatter: state.frontmatterEntries,
      frontmatterMode: 'replace',
      existingRaw: serializeNoteFile({ title: 'Now', body: 'now' }),
    })

    expect(parseNoteFile(restored, 'old.md').sourceLocator).toBe(locator)
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

describe('serializeNoteFile — unchanged typed channels', () => {
  const storageFile = (overrides: string[] = []): string =>
    [
      '---',
      'title: "My note"',
      'tags:',
      '  - Work/Projects',
      '  - ml',
      'notarium-id: idAAAAAAAAAA',
      ...overrides,
      '---',
      '',
      '# My note',
      '',
      'Body line one.',
      'Body line two.',
      '',
    ].join('\n')

  it('changes only the authored body line and preserves quoting plus list indentation', () => {
    const existingRaw = storageFile()
    const out = serializeNoteFile({
      title: 'My note',
      tags: ['Work/Projects', 'ml'],
      id: 'idAAAAAAAAAA',
      body: 'Body line one.\nBody line TWO.\n',
      existingRaw,
    })

    expect(changedPhysicalLines(existingRaw, out)).toBe(1)
    expect(out).toContain('title: "My note"\n')
    expect(out).toContain('tags:\n  - Work/Projects\n  - ml\n')
  })

  it.each(["title: 'Hello: world'", "title: ' padded '", "title: 'a #b'"])(
    'keeps a safe single-quoted scalar: %s',
    (titleLine) => {
      const title = titleLine.slice(titleLine.indexOf("'") + 1, -1)
      const existingRaw = `---\n${titleLine}\n---\n\n# ${title}\n\nbody\n`
      const out = serializeNoteFile({ title, body: 'body\n', existingRaw })

      expect(out).toBe(existingRaw)
    },
  )

  it('keeps a flow list but canonicalises a scalar list channel', () => {
    const flow = '---\ntitle: T\ntags: [a, b]\n---\n\n# T\n\nbody\n'
    const scalar = flow.replace('tags: [a, b]', 'tags: a, b')

    expect(
      serializeNoteFile({ title: 'T', tags: ['a', 'b'], body: 'body\n', existingRaw: flow }),
    ).toBe(flow)
    expect(
      serializeNoteFile({ title: 'T', tags: ['a', 'b'], body: 'body\n', existingRaw: scalar }),
    ).toContain('tags:\n- a\n- b\n')
  })

  it.each([
    ['title: 2024', 'title: "2024"'],
    ['title: null', 'title: "null"'],
  ])('canonicalises a scalar whose YAML type would differ: %s', (authored, expected) => {
    const title = authored.slice('title: '.length)
    const existingRaw = `---\n${authored}\n---\n\n# ${title}\n\nbody\n`
    const out = serializeNoteFile({ title, body: 'body\n', existingRaw })

    expect(out).toContain(`${expected}\n`)
  })

  it('canonicalises block scalars, under-quoted list elements and dropped empty elements', () => {
    const owner = '---\ntitle: T\nnotarium-id: |\n  idAAAAAAAAAA\n---\n\n# T\n\nbody\n'
    const numeric = '---\ntitle: T\ntags:\n  - 2024\n  - ml\n---\n\n# T\n\nbody\n'
    const empty = '---\ntitle: T\ntags: [ml, ""]\n---\n\n# T\n\nbody\n'

    expect(
      serializeNoteFile({ title: 'T', id: 'idAAAAAAAAAA', body: 'body\n', existingRaw: owner }),
    ).toContain('notarium-id: idAAAAAAAAAA\n')
    expect(
      serializeNoteFile({ title: 'T', tags: ['2024', 'ml'], body: 'body\n', existingRaw: numeric }),
    ).toContain('tags:\n- "2024"\n- ml\n')
    expect(
      serializeNoteFile({ title: 'T', tags: ['ml'], body: 'body\n', existingRaw: empty }),
    ).toContain('tags:\n- ml\n')
  })

  it('canonicalises muted once and then reaches a byte fixpoint', () => {
    const existingRaw = '---\ntitle: T\nmuted: true\n---\n\n# T\n\nbody\n'
    const first = serializeNoteFile({ title: 'T', muted: true, body: 'body\n', existingRaw })
    const second = serializeNoteFile({
      title: 'T',
      muted: true,
      body: 'body\n',
      existingRaw: first,
    })

    expect(first).toContain('muted: "true"\n')
    expect(second).toBe(first)
  })

  it('still collapses duplicates when the first value already matches', () => {
    const existingRaw =
      '---\ntitle: T\nnotarium-id: idAAAAAAAAAA\nnotarium-id: staleBBBBBB\n---\n\n# T\n\nbody\n'
    const out = serializeNoteFile({
      title: 'T',
      id: 'idAAAAAAAAAA',
      body: 'body\n',
      existingRaw,
    })

    expect(out.match(/^notarium-id:/gm)).toHaveLength(1)
    expect(out).toContain('notarium-id: idAAAAAAAAAA\n')
  })

  it('does not turn an unchanged typed field into a repair heuristic for invalid neighbours', () => {
    const existingRaw = '---\ntitle: T\ntags: [a, b]\n- authored root item\n---\n\n# T\n\nbody\n'
    const out = serializeNoteFile({
      title: 'T',
      tags: ['a', 'b'],
      body: 'body\n',
      existingRaw,
    })

    expect(out).toBe(existingRaw)
  })
})

describe('serializeNoteFile — lossless frontmatter splice', () => {
  it('changes one physical line in a full CRLF storage file', () => {
    const existingRaw = [
      '---',
      'title: "My note"',
      'tags:',
      '  - Work/Projects',
      '  - ml',
      'notarium-id: idAAAAAAAAAA',
      '---',
      '',
      '# My note',
      '',
      'Body line one.',
      'Body line two.',
      '',
    ].join('\r\n')
    const out = serializeNoteFile({
      title: 'My note',
      tags: ['Work/Projects', 'ml'],
      id: 'idAAAAAAAAAA',
      body: 'Body line one.\r\nBody line TWO.\r\n',
      existingRaw,
    })

    expect(changedPhysicalLines(existingRaw, out)).toBe(1)
  })

  it('preserves separator blanks and trailing closing-fence bytes', () => {
    const existingRaw = '---\ntitle: T\n\ntags: [a, b]\n---   \n\n# T\n\nBody one.\nBody two.\n'
    const out = serializeNoteFile({
      title: 'T',
      tags: ['a', 'b'],
      body: 'Body one.\nBody TWO.\n',
      existingRaw,
    })

    expect(out).toContain('title: T\n\ntags: [a, b]\n---   \n')
    expect(changedPhysicalLines(existingRaw, out)).toBe(1)
  })

  it('drops only a tombstoned entry span and keeps both authored separators', () => {
    const existingRaw = '---\ntitle: T\n\nslug: custom\n\nauthor: Ada\n---\n\n# T\n\nbody\n'
    const expected = '---\ntitle: T\n\n\nauthor: Ada\n---\n\n# T\n\nbody\n'
    const out = serializeNoteFile({
      title: 'T',
      slug: '',
      body: 'body\n',
      existingRaw,
    })

    expect(out).toBe(expected)
    expect(serializeNoteFile({ title: 'T', slug: '', body: 'body\n', existingRaw: out })).toBe(out)
  })

  it('uses payload majority and opening-fence tie-break for appended entries', () => {
    const crlfMajority = '---\r\ntitle: T\na: one\r\nb: two\r\n---\r\n\r\n# T\r\n\r\nbody\r\n'
    const lfTie = '---\ntitle: T\r\na: one\n---\n\n# T\n\nbody\n'
    const crlfOut = serializeNoteFile({
      title: 'T',
      id: 'idAAAAAAAAAA',
      body: 'body\r\n',
      existingRaw: crlfMajority,
    })
    const lfOut = serializeNoteFile({
      title: 'T',
      id: 'idAAAAAAAAAA',
      body: 'body\n',
      existingRaw: lfTie,
    })

    expect(crlfOut).toContain('notarium-id: idAAAAAAAAAA\r\n---\r\n')
    expect(lfOut).toContain('notarium-id: idAAAAAAAAAA\n---\n')
  })

  it('uses the first physical line when creating a block', () => {
    const crlf = '# T\r\n\r\nbody\r\n'
    const lfWithLaterCrlf = '# T\n```\r\ncode\r\n```\n'

    expect(serializeNoteFile({ title: 'T', body: 'body\r\n', existingRaw: crlf })).toContain(
      '---\r\ntitle: T\r\n---\r\n',
    )
    expect(
      serializeNoteFile({ title: 'T', body: '```\r\ncode\r\n```\n', existingRaw: lfWithLaterCrlf }),
    ).toContain('---\ntitle: T\n---\n')
  })

  it.each([
    ['without a terminator', '---\ntitle: T\n---'],
    ['with a terminator', '---\ntitle: T\n---\n'],
  ])('makes a closing fence at EOF a byte fixpoint: %s', (_name, prefix) => {
    const first = serializeNoteFile({ title: 'T', body: '', existingRaw: prefix })
    const second = serializeNoteFile({ title: 'T', body: '', existingRaw: first })

    expect(second).toBe(first)
    expect(first).not.toContain('---\n\n\n# T')
  })

  it('falls back to a canonical rebuild when supplied geometry is inconsistent', () => {
    const raw = '---\ntitle: Old\n---\n\n# Old\n\nbody\n'
    const block = parseFrontmatterBlock(raw)!
    const bounds = frontmatterPayloadBounds(raw, block.bodyStart)
    const out = assembleNoteFile({
      title: 'New',
      cleanBody: 'body\n',
      keyless: [],
      entries: [frontmatterScalarEntry('title', 'New')],
      live: [true],
      touched: [true],
      replacing: false,
      source: {
        raw,
        block,
        bounds,
        spans: [{ key: 'title', start: bounds.payloadEnd + 1, end: bounds.payloadEnd + 2 }],
      },
    })

    expect(out).toBe('---\ntitle: New\n---\n\n# New\n\nbody\n')
  })

  it('keeps an authored empty body empty', () => {
    const existingRaw = '---\ntitle: T\n---\n\n# T\n'
    expect(serializeNoteFile({ title: 'T', body: '', existingRaw })).toBe(existingRaw)
  })
})

describe('serializeNoteFile — leading body block matrix', () => {
  const cases = [
    {
      name: 'keyed metadata',
      body: '---\ntype: note\n---\n# T\n\nx\n',
      expectedBody: 'x\n',
      metadata: true,
    },
    {
      name: 'a comment plus keyed metadata',
      body: '---\n# note\ntype: x\n---\n# T\n\ny\n',
      expectedBody: 'y\n',
      metadata: true,
    },
    {
      name: 'rule-fenced prose',
      body: '---\nA thought I wrote between two rules.\n---\nAnd the rest.\n',
      expectedBody: '---\nA thought I wrote between two rules.\n---\nAnd the rest.\n',
      metadata: false,
    },
    {
      name: 'a comment-only block',
      body: '---\n# just a comment\n---\nrest\n',
      expectedBody: '---\n# just a comment\n---\nrest\n',
      metadata: false,
    },
    {
      name: 'a keyed record plus loose prose',
      body: '---\nauthor: Ada\nA loose thought.\n---\nrest\n',
      expectedBody: '---\nauthor: Ada\nA loose thought.\n---\nrest\n',
      metadata: false,
    },
    {
      name: 'an empty block',
      body: '---\n---\nBody.\n',
      expectedBody: '---\n---\nBody.\n',
      metadata: false,
    },
    {
      name: 'a block behind a body mark',
      body: '\uFEFF---\ntitle: X\n---\nFirst.\n',
      expectedBody: '\uFEFF---\ntitle: X\n---\nFirst.\n',
      metadata: false,
    },
    {
      name: 'a keyed block with trailing closing-fence bytes',
      body: '---\ntitle: X\n---   \nFirst.\n',
      expectedBody: 'First.\n',
      metadata: true,
    },
    {
      name: 'prose that parses as a key',
      body: '---\nA thought: I wrote it.\n---\nrest\n',
      expectedBody: 'rest\n',
      metadata: true,
    },
    {
      name: 'ordinary structural prose',
      body: '- one\n- two\n',
      expectedBody: '- one\n- two\n',
      metadata: false,
    },
    {
      name: 'a multiline keyless entry',
      body: '---\n# section: notes\n  still mine\ntype: note\n---\nrest\n',
      expectedBody: '---\n# section: notes\n  still mine\ntype: note\n---\nrest\n',
      metadata: false,
    },
  ] as const

  it.each(cases)('preserves the specified bytes for $name', ({ body, expectedBody, metadata }) => {
    const promoted = promoteBodyTitle(body, 'T')
    const out = serializeNoteFile({ title: promoted.title, body: promoted.body })
    const parsed = parseNoteFile(out, 't.md')

    expect(parsed.body).toBe(expectedBody)
    const header = out.slice(0, parseFrontmatterBlock(out)!.bodyStart)

    if (!metadata) {
      expect(header).not.toContain('A loose thought.')
      expect(header).not.toContain('still mine')
    }

    const again = serializeNoteFile({
      title: parsed.title,
      body: parsed.body,
      existingRaw: out,
    })
    expect(again).toBe(out)
  })

  it('moves a qualifying body comment once, without deduplicating against the file header', () => {
    const existingRaw = '---\n# note\ntitle: T\n---\n\n# T\n\nold\n'
    const body = '---\n# note\ntype: x\n---\nnew\n'
    const out = serializeNoteFile({ title: 'T', body, existingRaw })

    expect(out.match(/^# note$/gm)).toHaveLength(2)
    expect(parseNoteFile(out, 't.md').body).toBe('new\n')
  })

  it('keeps every byte of the bug-report body through repeated saves', () => {
    const body = '---\nA thought I wrote between two rules.\n---\nAnd the rest.\n'
    const first = serializeNoteFile({ title: 'T', body })
    const parsed = parseNoteFile(first, 't.md')
    const second = serializeNoteFile({ title: parsed.title, body: parsed.body, existingRaw: first })

    expect(parsed.body).toBe(body)
    expect(second).toBe(first)
  })
})

// The frontmatter an IMPORTED file arrives with (#280): merged under our typed
// fields, over the file's existing block. The file stays the author's.
describe('serializeNoteFile — carried frontmatter', () => {
  const carried = (raw: string) => parseFrontmatterBlock(raw)!.entries

  it('writes the author’s keys into the file and reads them back', () => {
    const out = serializeNoteFile({
      title: 'Vault Note',
      id: 'id-9',
      frontmatter: carried('---\nauthor: Sergey\nrating: 5\n---\n'),
      body: 'b',
    })
    const p = parseNoteFile(out, 'vault-note.md')
    expect(p.frontmatter.author).toBe('Sergey')
    expect(p.frontmatter.rating).toBe('5')
    expect(p.title).toBe('Vault Note')
  })

  it('keeps a nested map and a comment verbatim — unmodelled is not deletable', () => {
    const out = serializeNoteFile({
      title: 'T',
      frontmatter: carried('---\n# a comment\nmeta:\n  source: obsidian\n  rating: 5\n---\n'),
      body: 'b',
    })
    expect(out).toContain('# a comment')
    expect(out).toContain('meta:\n  source: obsidian\n  rating: 5')
  })

  it('keeps comments between continuation lines inside their authored entry', () => {
    const source = [
      '---',
      'tags:',
      '- one',
      '# keep the next list item',
      '- two',
      'meta:',
      '  a: 1',
      '# keep the next mapping field',
      '  b: 2',
      '---',
      'body',
    ].join('\n')
    const note = markdownFileToNote(source, 'commented.md')
    const out = serializeNoteFile({
      title: note.title,
      tags: note.tags,
      frontmatter: note.frontmatter,
      body: note.body,
    })
    const entries = parseFrontmatterBlock(out)!.entries

    expect(entries.find((entry) => entry.key === 'tags')?.lines).toEqual([
      'tags:',
      '- one',
      '# keep the next list item',
      '- two',
    ])
    expect(entries.find((entry) => entry.key === 'meta')?.lines).toEqual([
      'meta:',
      '  a: 1',
      '# keep the next mapping field',
      '  b: 2',
    ])
  })

  it('a keyless carried line goes to the FRONT — it must not swallow the key above it', () => {
    // An indented or `- ` keyless line re-reads as a CONTINUATION of whatever key
    // precedes it. Appended after ours, it turned `created:`/`notarium-id:` into
    // multi-line entries and their values were lost on the next read.
    const first = serializeNoteFile({
      title: 'T',
      id: 'id-1',
      createdAt: '2020-01-02T00:00:00.000Z',
      body: 'b',
    })
    const out = serializeNoteFile({
      title: 'T',
      id: 'id-1',
      createdAt: '2020-01-02T00:00:00.000Z',
      frontmatter: carried('---\n  indented: 1\n---\n'),
      body: 'b',
      existingRaw: first,
    })
    const p = parseNoteFile(out, 't.md')
    expect(p.idClaim).toBe('id-1')
    expect(p.createdAt).toBe('2020-01-02T00:00:00.000Z')
    expect(out).toContain('  indented: 1') // …and the author's line is still there
  })

  it('our typed fields WIN over a carried key of the same name', () => {
    const out = serializeNoteFile({
      title: 'Ours',
      tags: ['ours'],
      createdAt: '2020-01-01T00:00:00.000Z',
      frontmatter: carried('---\ntitle: Theirs\ntags: [theirs]\ncreated: 1999-01-01\n---\n'),
      body: 'b',
    })
    const p = parseNoteFile(out, 't.md')
    expect(p.title).toBe('Ours')
    expect(p.tags).toEqual(['ours'])
    expect(p.createdAt).toBe('2020-01-01T00:00:00.000Z')
    expect(out.match(/^title:/gm)).toHaveLength(1) // not asserted twice
  })

  it('an `aliases:`/`slug:` the author wrote becomes live metadata (#100 keys, carried)', () => {
    const out = serializeNoteFile({
      title: 'Vault Note',
      frontmatter: carried('---\naliases: [Old Name]\nslug: my-slug\n---\n'),
      body: 'b',
    })
    const p = parseNoteFile(out, 'vault-note.md')
    expect(p.aliases).toEqual(['Old Name'])
    expect(p.slug).toBe('my-slug')
  })

  it('refreshes a carried key over the occupied file, keeping the file’s other keys', () => {
    // A re-import of an edited source: the author's key updates, ours stay ours.
    const first = serializeNoteFile({
      title: 'T',
      id: 'id-1',
      frontmatter: carried('---\nauthor: Old\nkept: yes\n---\n'),
      body: 'b',
    })
    const second = serializeNoteFile({
      title: 'T',
      id: 'id-1',
      frontmatter: carried('---\nauthor: New\n---\n'),
      body: 'b2',
      existingRaw: first,
    })
    const p = parseNoteFile(second, 't.md')
    expect(p.frontmatter.author).toBe('New')
    expect(p.frontmatter.kept).toBe('yes') // untouched by this write
    expect(p.idClaim).toBe('id-1')
  })

  it.each([
    ['anchor definition', 'anchorKey: &x value'],
    ['alias node', 'copy: *x'],
    ['foreign duplicate', 'author: &x old\ncopy: *x\nauthor: new'],
    ['lifted duplicate', 'tags: &x [old]\ncopy: *x\ntags: [new]'],
    ['date duplicate', 'created: &x old\ncopy: *x\ncreated: 2020-01-01'],
  ])('rejects YAML node references on a fresh file (%s)', (_label, yaml) => {
    expect(() =>
      serializeNoteFile({
        title: 'T',
        frontmatter: carried(`---\n${yaml}\n---\n`),
        body: 'body',
      }),
    ).toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))
  })

  it('rejects leading inline-frontmatter references on fresh and existing writes', () => {
    const inline = '---\nanchorKey: &x value\ncopy: *x\n---\nnew body'
    const existingRaw = serializeNoteFile({ title: 'T', body: 'old body' })

    expect(() => serializeNoteFile({ title: 'T', body: inline })).toThrowError(
      new Error(YAML_NODE_REFERENCE_WRITE_ERROR),
    )
    expect(() => serializeNoteFile({ title: 'T', body: inline, existingRaw })).toThrowError(
      new Error(YAML_NODE_REFERENCE_WRITE_ERROR),
    )
    expect(parseNoteFile(existingRaw, 't.md').body).toBe('old body')
  })

  it('allows plain, quoted and block-scalar ampersands that are not YAML node references', () => {
    const source = carried(
      '---\nplain: A&B and literal *alias\nquoted: "&anchor and *alias"\ncode: |\n  &anchor-looking text\n  *alias-looking text\n---\n',
    )
    const first = serializeNoteFile({ title: 'T', frontmatter: source, body: 'old body' })

    expect(() =>
      serializeNoteFile({ title: 'T', body: 'new body', existingRaw: first }),
    ).not.toThrow()
    expect(first).toContain('plain: A&B and literal *alias')
    expect(first).toContain('quoted: "&anchor and *alias"')
    expect(first).toContain('code: |\n  &anchor-looking text\n  *alias-looking text')
  })

  it('rejects anchor/alias carry on overwrite without changing the old file', () => {
    const existingRaw = serializeNoteFile({
      title: 'T',
      frontmatter: carried('---\ncopy: old\nanchorKey: old\n---\n'),
      body: 'old body',
    })
    const incoming = carried('---\nanchorKey: &x new\ncopy: *x\n---\n')

    expect(() =>
      serializeNoteFile({
        title: 'T',
        frontmatter: incoming,
        body: 'new body',
        existingRaw,
      }),
    ).toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))
    const old = parseNoteFile(existingRaw, 't.md')

    expect(old.frontmatter.copy).toBe('old')
    expect(old.frontmatter.anchorKey).toBe('old')
    expect(old.body).toBe('old body')
  })

  it('rejects an ordinary write when the existing file contains anchor dependencies', () => {
    const existingRaw = '---\ntitle: T\ntags: &x [a]\ncopy: *x\n---\n\n# T\n\nold body'

    expect(() =>
      serializeNoteFile({
        title: 'T',
        tags: ['new'],
        body: 'new body',
        existingRaw,
      }),
    ).toThrowError(new Error(YAML_NODE_REFERENCE_WRITE_ERROR))
    expect(existingRaw).toContain('tags: &x [a]\ncopy: *x')
    expect(parseNoteFile(existingRaw, 't.md').body).toBe('old body')
  })

  it('full-state replace restores an authored anchor graph and drops live-only metadata', () => {
    const existingRaw = [
      '---',
      'title: Live',
      'live-only: remove-me',
      '---',
      '',
      '# Live',
      '',
      'live body',
    ].join('\n')
    const restored = carried(
      ['---', 'anchorKey: &shared value', 'copy: *shared', '# exact comment', '---', ''].join('\n'),
    )
    const out = serializeNoteFile({
      title: 'Historical',
      id: 'note-restore-1',
      frontmatter: restored,
      frontmatterMode: 'replace',
      body: 'historical body',
      existingRaw,
    })

    expect(out).toContain('anchorKey: &shared value\ncopy: *shared\n# exact comment')
    expect(out).not.toContain('live-only:')
    expect(out).toContain('title: Historical')
    expect(out).toContain('notarium-id: note-restore-1')
  })

  it('full-state replace keeps a leading frontmatter-like body block in the body', () => {
    const body = ['---', 'body-key: body-value', '---', 'actual body'].join('\n')
    const out = serializeNoteFile({
      title: 'Historical',
      id: 'note-restore-body',
      frontmatter: carried('---\ncustom: kept\n---\n'),
      frontmatterMode: 'replace',
      body,
      existingRaw: '---\ntitle: Live\n---\n\n# Live\n\nlive body',
    })
    const parsed = parseNoteFile(out, 'historical.md')

    expect(parsed.body).toBe(body)
    expect(parsed.frontmatter).toMatchObject({ custom: 'kept' })
    expect(parsed.frontmatter).not.toHaveProperty('body-key')
  })

  it('collapses every occupied duplicate when a key is set or cleared', () => {
    const existingRaw = [
      '---',
      'title: Old first',
      'title: Old LAST',
      'author: Old first',
      'author: Old LAST',
      'tags: [old-first]',
      'tags: [old-last]',
      'slug: first',
      'slug: last',
      '---',
      '',
      '# Old LAST',
      '',
      'body',
    ].join('\n')
    const out = serializeNoteFile({
      title: 'New Title',
      tags: ['new'],
      slug: '',
      frontmatter: carried('---\nauthor: New\n---\n'),
      body: 'body',
      existingRaw,
    })
    const parsed = parseNoteFile(out, 'note.md')

    expect(parsed.title).toBe('New Title')
    expect(parsed.tags).toEqual(['new'])
    expect(parsed.slug).toBeNull()
    expect(parsed.frontmatter.author).toBe('New')
    expect(out.match(/^title:/gm)).toHaveLength(1)
    expect(out.match(/^tags:/gm)).toHaveLength(1)
    expect(out.match(/^author:/gm)).toHaveLength(1)
    expect(out.match(/^slug:/gm)).toBeNull()
  })

  it('replaces a key at its first occupied anchor while tombstoning later duplicates', () => {
    const existingRaw = [
      '---',
      'alpha: first',
      'author: Old first',
      'between: stays between',
      'author: Old last',
      'omega: last',
      '---',
      '',
      '# T',
      '',
      'body',
    ].join('\n')
    const out = serializeNoteFile({
      title: 'T',
      frontmatter: carried('---\nauthor: New\n---\n'),
      body: 'body',
      existingRaw,
    })
    const keys = parseFrontmatterBlock(out)!
      .entries.map((entry) => entry.key)
      .filter((key): key is string => key != null)

    expect(keys).toEqual(['alpha', 'author', 'between', 'omega', 'title'])
    expect(out.match(/^author:/gm)).toEqual(['author:'])
    expect(parseNoteFile(out, 't.md').frontmatter.author).toBe('New')
  })

  it('keeps __proto__ as own frontmatter data without changing the projection prototype', () => {
    const scalar = parseNoteFile('---\n__proto__: secret\nnormal: value\n---\nbody', 'a.md')
    const list = parseNoteFile('---\n__proto__:\n- attacker\nnormal: value\n---\nbody', 'b.md')

    expect(Object.getPrototypeOf(scalar.frontmatter)).toBeNull()
    expect(Object.getOwnPropertyNames(scalar.frontmatter)).toEqual(['__proto__', 'normal'])
    expect(scalar.frontmatter.__proto__).toBe('secret')
    expect(Object.getPrototypeOf(list.frontmatter)).toBeNull()
    expect(Object.getOwnPropertyNames(list.frontmatter)).toEqual(['__proto__', 'normal'])
    expect(list.frontmatter.__proto__).toEqual(['attacker'])
  })

  it('rejects the final emitted payload when typed fields push it over the metadata cap', () => {
    const existingRaw = `---\npad: ${'a'.repeat(FRONTMATTER_BYTE_CAP - 8)}\n---\n\n# T\n`

    expect(parseFrontmatterBlock(existingRaw)).not.toBeNull()
    expect(() => serializeNoteFile({ title: 'T', body: 'body', existingRaw })).toThrow(
      FrontmatterLimitError,
    )
  })

  it('merges a large carried block in linear time', () => {
    // Stay below the product's 64 KiB metadata ceiling while retaining enough
    // distinct keys to expose a per-key full-array scan.
    const frontmatter = Array.from({ length: 2_500 }, (_, i) => ({
      key: `foreign-${i}`,
      lines: [`foreign-${i}: value`],
    }))
    const started = Date.now()
    const out = serializeNoteFile({ title: 'T', frontmatter, body: 'b' })

    expect(out).toContain('foreign-2499: value')
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('preserves an unreadable authored created while keeping the resolved mtime', () => {
    const mtime = '2019-05-05T10:00:00.000Z'
    const note = markdownFileToNote('---\ncreated: someday\nauthor: S\n---\nbody', 'a.md', mtime)
    const out = serializeNoteFile({
      title: note.title,
      body: note.body,
      frontmatter: note.frontmatter,
      createdAt: note.createdAt,
    })

    expect(out).toContain('created: someday')
    expect(out).toContain(`notarium-created: ${mtime}`)
    expect(parseNoteFile(out, 'a.md').createdAt).toBe(mtime)

    const explicitlyCorrected = serializeNoteFile({
      title: note.title,
      body: note.body,
      createdAt: '2020-01-02T00:00:00.000Z',
      existingRaw: out,
    })
    expect(explicitlyCorrected).not.toContain('created: someday')
    expect(explicitlyCorrected).not.toContain('notarium-created:')
    expect(parseNoteFile(explicitlyCorrected, 'a.md').createdAt).toBe('2020-01-02T00:00:00.000Z')
  })
})

// A PROPERTY test over the whole file round-trip, added after review rounds kept
// finding one more hand-crafted frontmatter shape that broke it (a lone CR, a
// whitespace-only line, an indented keyless line, a closing `#` run, a block
// scalar…). Enumerating cases by hand is the wrong shape of work for a parser:
// what actually has to hold is an INVARIANT, so this asserts the invariant over a
// generated corpus of nasty shapes instead.
//
//   1. what we write, we read back — for every field we model;
//   2. blank raw lines are never invented; when continuation ownership proves they
//      belong to an authored entry, that entry survives byte-for-byte. Our own
//      scalar fields remain single-line and cannot escape their key or the `---`
//      block;
//   3. serialize∘parse is a FIXPOINT — a file must not keep changing on re-saves.
//
// Deterministic (a seeded LCG, no Math.random) so a failure is reproducible, and
// small enough not to starve a parallel worker.
describe('serializeNoteFile ∘ parseNoteFile — round-trip invariants (property)', () => {
  const LINES = [
    'author: Sergey',
    'layout: post',
    '# a comment',
    '  indented: 1',
    '- stray item',
    ' ',
    '\t',
    'meta:',
    '  source: obsidian',
    'empty:',
    'flow: [a, b]',
    'block: |',
    '  one',
    '  two',
    'folded: >',
    '  wrapped here',
    'date: 2016-11-17',
    'cssclasses: [wide]',
  ]
  const TITLES = [
    'Plain',
    'A: B',
    'Sprint review #',
    'Title ##',
    '"Gameverse"',
    'Договор',
    '[[wiki]]',
    'Two\nLines',
    'a\rb',
    '  padded  ',
    '#',
    'C#',
  ]
  const TAGS = [[], ['a'], ['работа', '2025'], ['#hash'], ['a: b']]
  const BODIES = [
    { input: 'Body line.', expected: 'Body line.' },
    {
      input: '---\nA thought I wrote between two rules.\n---\nAnd the rest.\n',
      expected: '---\nA thought I wrote between two rules.\n---\nAnd the rest.\n',
    },
    { input: '---\ntype: note\n---\nBody line.\n', expected: 'Body line.\n' },
  ]

  it('holds over a generated corpus of hostile frontmatter shapes', () => {
    let seed = 0x2802_2026

    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed % n
    }

    for (let i = 0; i < 3000; i++) {
      const block = Array.from({ length: rnd(5) + 1 }, () => LINES[rnd(LINES.length)]).join('\n')
      const carriedEntries = parseFrontmatterBlock(`---\n${block}\n---\n`)?.entries ?? []
      const title = TITLES[rnd(TITLES.length)]
      const tags = TAGS[rnd(TAGS.length)]
      const body = BODIES[rnd(BODIES.length)]
      const input = {
        title,
        tags,
        id: 'idAAAAAAAAAA',
        createdAt: '2019-04-01T00:00:00.000Z',
        frontmatter: carriedEntries,
        body: body.input,
      }
      const file = serializeNoteFile(input)
      const parsed = parseNoteFile(file, 'note.md')
      const where = `case ${i} · title=${JSON.stringify(title)} · block=${JSON.stringify(block)}`

      // (1) every modelled field survives. The ONE thing a scalar cannot store is a
      // line break, so the title is compared against the emitter's own collapse —
      // edge whitespace is preserved (by quoting), only terminators fold.
      const expectedTitle = /[\r\n]/.test(title)
        ? title
            .split(/\r\n|[\r\n]/)
            .map((l) => l.trim())
            .filter(Boolean)
            .join(' ')
        : title
      expect([where, parsed.title]).toEqual([where, expectedTitle])
      expect([where, parsed.tags]).toEqual([where, tags])
      expect([where, parsed.idClaim]).toEqual([where, 'idAAAAAAAAAA'])
      expect([where, parsed.createdAt]).toEqual([where, '2019-04-01T00:00:00.000Z'])
      expect([where, parsed.body]).toEqual([where, body.expected])

      const emitted = parseFrontmatterBlock(file)!

      // (2a) A blank line can be semantic block-scalar content, or preserved raw
      // spacing inside a multiline entry once a later continuation proves its
      // ownership. It must always come from one exact authored entry; the serializer
      // must neither invent it nor splice it into another key.
      for (const e of emitted.entries) {
        if (e.lines.some((line) => line.trim() === '')) {
          const hasExactSource = carriedEntries.some(
            (source) => source.key === e.key && source.lines.join('\n') === e.lines.join('\n'),
          )

          expect([where, e.key, hasExactSource]).toEqual([where, e.key, true])
        }
      }

      // (2) Every scalar field WE emit stays on one line, so nothing can escape its
      // key and terminate the block early. Author-owned multiline entries are carry.
      for (const key of ['title', 'notarium-id', 'created', 'tags']) {
        const e = emitted.entries.find((x) => x.key === key)

        if (e && key !== 'tags') {
          expect([where, key, e.lines.length]).toEqual([where, key, 1])
        }
      }

      // (3) every AUTHOR key we could read before the write is still readable after
      // it, with the same value. This is the one that catches a silent deletion —
      // whatever we do to our own fields, the author's data may not change meaning.
      // Keyed by the LAST occurrence: the merge is last-wins (so is YAML's), so a
      // source that states a key twice is judged by the copy that survives.
      const OURS = new Set(['title', 'tags', 'notarium-id', 'created'])
      const lastOf = new Map<string, (typeof carriedEntries)[number]>()

      for (const e of carriedEntries) {
        if (e.key && !OURS.has(e.key)) {
          lastOf.set(e.key, e)
        }
      }
      for (const [key, e] of lastOf) {
        const before = frontmatterEntryValue(e)

        if (before != null) {
          expect([where, key, parsed.frontmatter[key]]).toEqual([where, key, before])
        }
      }

      // (4) a re-save is a fixpoint — the file must stop changing.
      const again = serializeNoteFile({
        ...input,
        body: parsed.body,
        frontmatter: undefined,
        existingRaw: file,
      })
      expect([where, again]).toEqual([where, file])
      expect([where, parseNoteFile(again, 'note.md').title]).toEqual([where, parsed.title])

      // The same fixed point over a CRLF storage form exercises the span writer's
      // second axis: existing raw geometry and physical terminators, not just body shape.
      if (i % 3 === 0) {
        const crlfFile = file.replace(/\n/g, '\r\n')
        const crlfParsed = parseNoteFile(crlfFile, 'note.md')
        const crlfAgain = serializeNoteFile({
          ...input,
          body: crlfParsed.body,
          frontmatter: undefined,
          existingRaw: crlfFile,
        })

        expect([where, crlfAgain]).toEqual([where, crlfFile])
      }

      // (5) the IMPORT leg: dropping our own exported file back in must reproduce the
      // same note and must not stack another copy of the storage heading.
      // (`.trim()` because the write chokepoint trims every title, so edge
      // whitespace is not a state a note can actually be in — the importer agreeing
      // with promoteBodyTitle here is the correct reading, not a divergence.)
      const reimported = markdownFileToNote(file, 'note.md')
      expect([where, reimported.title]).toEqual([where, parsed.title.trim()])
      expect([where, reimported.body.startsWith('# ')]).toEqual([where, false])
    }
  })
})

describe('the protected field keys cover every key this serializer owns', () => {
  it('leaves no typed channel addressable through the field axis', () => {
    // Drive every typed channel at once and read back the keys the serializer put.
    // A channel added later without joining the protected list would become writable
    // through the field channel and silently overwritten by the next typed write.
    const out = serializeNoteFile({
      title: 'Owned',
      noteType: 'task',
      tags: ['a'],
      aliases: ['old'],
      slug: 'owned',
      summary: 'digest',
      muted: true,
      id: 'AbCdefGhij_1',
      createdAt: '2026-08-20T00:00:00.000Z',
      body: 'body',
    })
    const written = (parseFrontmatterBlock(out)?.entries ?? [])
      .map((entry) => entry.key)
      .filter((key): key is string => Boolean(key))

    expect(written.length).toBeGreaterThan(0)
    for (const key of written) {
      expect(PROTECTED_FIELD_KEYS as readonly string[]).toContain(key)
    }
    // And none of them reaches the index column, so a field predicate can never
    // answer for a key the note projects onto metadata of its own.
    expect(parseNoteFields(parseNoteFile(out, 'owned.md').fields).keys).toEqual({
      type: 'task',
      summary: 'digest',
      muted: 'true',
    })
  })
})

describe('serializeNoteFile — point field patch', () => {
  it('updates an existing key in place, appends new keys and removes only nulls', () => {
    const before = serializeNoteFile({
      title: 'Fields',
      id: 'field-note',
      frontmatter: parseFrontmatterBlock(
        '---\nstatus: backlog\nkeep: untouched\nremoved: old\n---\n',
      )!.entries,
      body: 'body',
    })
    const after = serializeNoteFile({
      title: 'Fields',
      id: 'field-note',
      body: 'body',
      existingRaw: before,
      fields: {
        status: 'doing',
        removed: null,
        blank: '',
        reviewers: ['ann', 'bo'],
        priority: '3',
      },
      fieldsUnquoted: ['priority'],
    })
    const changed = before
      .split('\n')
      .map((line, index) => [line, after.split('\n')[index]] as const)
      .filter(([left, right]) => left !== right)

    expect(after).toContain('status: doing\nkeep: untouched')
    expect(after).not.toContain('removed:')
    expect(after).toContain('blank: ""')
    expect(after).toContain('reviewers:\n- ann\n- bo')
    expect(after).toContain('priority: 3')
    // Replacing an existing scalar is the narrow painful scenario: one line.
    const statusOnly = serializeNoteFile({
      title: 'Fields',
      id: 'field-note',
      body: 'body',
      existingRaw: before,
      fields: { status: 'doing' },
    })
    expect(
      before.split('\n').filter((line, index) => line !== statusOnly.split('\n')[index]),
    ).toEqual(['status: backlog'])
    expect(changed.length).toBeGreaterThan(1)
  })

  it('normalises a frontmatter-less imported file on its first field write', () => {
    const imported = 'intro\n\n# Real Title\n\nauthor body'
    const written = serializeNoteFile({
      title: 'Real Title',
      body: imported,
      existingRaw: imported,
      fields: { status: 'doing' },
    })

    expect(written).toMatch(/^---\nstatus: doing\ntitle: Real Title\n---\n\n# Real Title\n/)
    expect(written.match(/^# Real Title$/gm)).toHaveLength(2)
    const second = serializeNoteFile({
      title: 'Real Title',
      body: parseNoteFile(written, 'real-title.md').body,
      existingRaw: written,
      fields: { status: 'done' },
    })
    expect(written.split('\n').filter((line, index) => line !== second.split('\n')[index])).toEqual(
      ['status: doing'],
    )
  })
})

describe('serializeNoteFile — the typed keys that only the frontmatter carries', () => {
  it('sets, preserves and clears the dedicated view marker', () => {
    const body =
      '```nota\nversion: 1\nsource: { kind: notes }\nviews: [{ name: B, type: board }]\n```'
    const marked = serializeNoteFile({ title: 'T', viewType: 'board', body })

    expect(parseNoteFile(marked, 't.md').viewType).toBe('board')
    expect(
      parseNoteFile(serializeNoteFile({ title: 'T', body, existingRaw: marked }), 't.md').viewType,
    ).toBe('board')
    expect(
      parseNoteFile(
        serializeNoteFile({ title: 'T', viewType: '', body: 'plain', existingRaw: marked }),
        't.md',
      ).viewType,
    ).toBeNull()
  })

  const existing = serializeNoteFile({
    title: 'T',
    noteType: 'task',
    summary: 'old digest',
    muted: true,
    body: 'body',
  })

  it('writes each of the three, in the block position it already occupies', () => {
    expect(existing).toContain('type: task')
    expect(existing).toContain('summary: old digest')
    expect(existing).toContain('muted: "true"')

    const again = serializeNoteFile({
      title: 'T',
      noteType: 'idea',
      summary: 'new digest',
      body: 'body',
      existingRaw: existing,
    })

    expect(parseFrontmatterBlock(again)!.entries.map((e) => e.key)).toEqual([
      'title',
      'type',
      'summary',
      'muted',
    ])
    expect(parseNoteFile(again, 't.md').frontmatter).toMatchObject({
      type: 'idea',
      summary: 'new digest',
      muted: 'true',
    })
  })

  it('takes the key out of the file when the channel clears it', () => {
    // The implicit type is never spelled; an empty digest and a false opt-out are
    // explicit clears. All three leave the block rather than standing there empty.
    const cleared = serializeNoteFile({
      title: 'T',
      noteType: DEFAULT_NOTE_TYPE,
      summary: '',
      muted: false,
      body: 'body',
      existingRaw: existing,
    })

    expect(parseFrontmatterBlock(cleared)!.entries.map((e) => e.key)).toEqual(['title'])
    expect(parseNoteFields(parseNoteFile(cleared, 't.md').fields).keys).toEqual({})
  })

  it('leaves all three alone when no channel speaks', () => {
    const untouched = serializeNoteFile({ title: 'T', body: 'other body', existingRaw: existing })

    expect(parseNoteFields(parseNoteFile(untouched, 't.md').fields).keys).toEqual({
      type: 'task',
      summary: 'old digest',
      muted: 'true',
    })
  })
})
