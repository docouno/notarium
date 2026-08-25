import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import {
  FRONTMATTER_BYTE_CAP,
  frontmatterEntryDefinesYamlAnchor,
  frontmatterEntryOf,
  frontmatterEntrySpans,
  frontmatterEntryValue,
  frontmatterEntryValueOf,
  frontmatterHasYamlNodeReferences,
  FrontmatterLimitError,
  frontmatterListEntry,
  frontmatterPayloadBounds,
  frontmatterScalar,
  frontmatterScalarEntry,
  frontmatterTags,
  frontmatterValue,
  isDurableFrontmatter,
  isWithinFrontmatterByteCap,
  parseFrontmatterBlock,
  stripFrontmatter,
  unquoteScalar,
} from './frontmatter'
import { FrontmatterGeometryError } from './frontmatterGeometryError'

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

  it('reads the last duplicate tags entry, like an ordinary YAML mapping', () => {
    expect(frontmatterTags('---\ntags: [old]\ntags: [new, final]\n---\n')).toEqual(['new', 'final'])
  })
})

// The line-based block parser — ONE reader shared by the engine's file
// parse/serialize and the importer (#280). Its contract: model what we model,
// carry the rest VERBATIM, never silently drop a line of the author's file.
describe('parseFrontmatterBlock', () => {
  it('splits entries and points bodyStart past the closing delimiter', () => {
    const raw = '---\ntitle: X\ntags:\n- a\n- b\n---\n\n# X\n\nbody'
    const block = parseFrontmatterBlock(raw)!
    expect(block.entries.map((e) => e.key)).toEqual(['title', 'tags'])
    expect(raw.slice(block.bodyStart)).toBe('\n# X\n\nbody')
  })

  it('keeps a nested map as its key’s continuation lines — unmodelled, not lost', () => {
    const block = parseFrontmatterBlock('---\nmeta:\n  a: 1\n  b: 2\nafter: x\n---\nbody')!
    expect(block.entries.map((e) => e.key)).toEqual(['meta', 'after'])
    expect(block.entries[0].lines).toEqual(['meta:', '  a: 1', '  b: 2'])
    // Honest null: we carry the lines but claim no parsed value for them.
    expect(frontmatterEntryValue(block.entries[0])).toBeNull()
  })

  it('recognises ordinary Unicode, spaced and colon-bearing plain mapping keys', () => {
    const block = parseFrontmatterBlock(
      '---\nавтор: Сергей\nreview owner: Ada\nsource:url: archive\n---\nbody',
    )!

    expect(block.entries).toEqual([
      { key: 'автор', lines: ['автор: Сергей'] },
      { key: 'review owner', lines: ['review owner: Ada'] },
      { key: 'source:url', lines: ['source:url: archive'] },
    ])
    expect(block.entries.map(frontmatterEntryValue)).toEqual(['Сергей', 'Ada', 'archive'])
    expect(isDurableFrontmatter(block.entries)).toBe(true)
  })

  it('treats non-ASCII whitespace as YAML key content, never structural indentation', () => {
    for (const prefix of ['\u00a0', '\u2003']) {
      const yaml = [
        `plain: ${prefix}|`,
        'description: |',
        '  safe scalar text',
        `${prefix}base: &shared value`,
        `${prefix}copy: *shared`,
        `ending${prefix}: kept`,
        'next: x',
      ].join('\n')
      const parsed = parseYaml(yaml) as Record<string, unknown>
      const entries = parseFrontmatterBlock(`---\n${yaml}\n---\n`)!.entries

      expect(parsed[`${prefix}base`]).toBe('value')
      expect(parsed[`${prefix}copy`]).toBe('value')
      expect(parsed[`ending${prefix}`]).toBe('kept')
      expect(entries).toEqual([
        { key: 'plain', lines: [`plain: ${prefix}|`] },
        { key: 'description', lines: ['description: |', '  safe scalar text'] },
        { key: `${prefix}base`, lines: [`${prefix}base: &shared value`] },
        { key: `${prefix}copy`, lines: [`${prefix}copy: *shared`] },
        { key: `ending${prefix}`, lines: [`ending${prefix}: kept`] },
        { key: 'next', lines: ['next: x'] },
      ])
      expect(frontmatterHasYamlNodeReferences(entries)).toBe(true)
      expect(isDurableFrontmatter(entries)).toBe(true)

      const scalarYaml = `description: |\n  ${prefix}&not syntax\n  ${prefix}*still text`
      const scalarEntries = parseFrontmatterBlock(`---\n${scalarYaml}\n---\n`)!.entries

      expect(() => parseYaml(scalarYaml)).not.toThrow()
      expect(frontmatterHasYamlNodeReferences(scalarEntries)).toBe(false)
      expect(isDurableFrontmatter(scalarEntries)).toBe(true)
    }
  })

  it('keeps a dedented matching flow closer with its keyed entry', () => {
    for (const yaml of [
      'flow: [\n  one,\n  two\n]\nnext: x',
      'flow: {\n  one: 1,\n  two: 2\n}\nnext: x',
      'flow: {\n  nested: [\n    one,\n    two\n  ]\n}\nnext: x',
    ]) {
      const entries = parseFrontmatterBlock(`---\n${yaml}\n---\n`)!.entries

      expect(() => parseYaml(yaml)).not.toThrow()
      expect(entries).toEqual([
        { key: 'flow', lines: yaml.split('\n').slice(0, -1) },
        { key: 'next', lines: ['next: x'] },
      ])
      expect(isDurableFrontmatter(entries)).toBe(true)
      expect(frontmatterHasYamlNodeReferences(entries)).toBe(false)
    }
  })

  it('keeps merge/document/directive shapes structural instead of blessing them as keys', () => {
    for (const line of [
      '<<: *base',
      '---: value',
      '...: value',
      '--- foo: bar',
      '--- {title: foreign}',
      '... foo: bar',
      'prefix[flow]: value',
      'comma,key: value',
      '%YAML: 1.2',
      '? explicit: x',
    ]) {
      const entries = parseFrontmatterBlock(`---\n${line}\n---\n`)!.entries

      expect(entries).toEqual([{ key: null, lines: [line] }])
      expect(isDurableFrontmatter(entries)).toBe(false)
    }
  })

  it('keeps an unmodelled line (a comment) as a keyless passthrough entry', () => {
    const block = parseFrontmatterBlock('---\n# a comment\ntitle: X\n---\nbody')!
    expect(block.entries[0]).toEqual({ key: null, lines: ['# a comment'] })
  })

  it('keeps column-zero comments inside a continued map/list only when continuation resumes', () => {
    const raw = [
      '---',
      'meta:',
      '  a: 1',
      '# map comment',
      '  b: 2',
      'tags:',
      '- old',
      '# list comment one',
      '# list comment two',
      '- new',
      '# standalone',
      'after: x',
      '---',
      '',
    ].join('\n')
    const block = parseFrontmatterBlock(raw)!

    expect(block.entries).toEqual([
      { key: 'meta', lines: ['meta:', '  a: 1', '# map comment', '  b: 2'] },
      {
        key: 'tags',
        lines: ['tags:', '- old', '# list comment one', '# list comment two', '- new'],
      },
      { key: null, lines: ['# standalone'] },
      { key: 'after', lines: ['after: x'] },
    ])
    expect(frontmatterEntryValue(block.entries[0])).toBeNull()
    expect(frontmatterEntryValue(block.entries[1])).toBeNull()
    expect(isDurableFrontmatter(block.entries)).toBe(true)
  })

  it('keeps a dedented block-scalar comment keyless even if an indented line follows', () => {
    const block = parseFrontmatterBlock('---\nd: |\n  value\n# outside\n  orphan\n---\n')!

    expect(block.entries).toEqual([
      { key: 'd', lines: ['d: |', '  value'] },
      { key: null, lines: ['# outside', '  orphan'] },
    ])
    // The parser preserves the source shape exactly, but a multi-line keyless
    // entry is not safe to relocate through the durable carried channel.
    expect(isDurableFrontmatter(block.entries)).toBe(false)
  })

  it('preserves every blank line in blank-only and annotated block scalars', () => {
    const blankOnly = parseFrontmatterBlock('---\nd: |+\n\n\n---\n')!
    const annotated = parseFrontmatterBlock(
      '---\nd: |+ # authored comment\n  first\n\n  second\n\n---\n',
    )!

    expect(blankOnly.entries).toEqual([{ key: 'd', lines: ['d: |+', '', ''] }])
    expect(annotated.entries).toEqual([
      {
        key: 'd',
        lines: ['d: |+ # authored comment', '  first', '', '  second', ''],
      },
    ])
    // The annotated header remains conservatively unprojected, but its exact raw
    // shape is safe to carry through the write boundary.
    expect(frontmatterEntryValue(blankOnly.entries[0])).toBeNull()
    expect(frontmatterEntryValue(annotated.entries[0])).toBeNull()
    expect(isDurableFrontmatter(blankOnly.entries)).toBe(true)
    expect(isDurableFrontmatter(annotated.entries)).toBe(true)
  })

  it('preserves semantic blanks in nested block and multiline scalar shapes', () => {
    const shapes = [
      'description:\n  |+\n    first\n\n    second\n\nnext: x',
      'meta:\n  text: |+\n    first\n\n    second\n  sibling: kept',
      'items:\n- |+\n  first\n\n  second\n- tail',
      'description: "first\n\n  second"\nnext: x',
      'description: first\n\n  second\nnext: x',
    ]

    for (const yaml of shapes) {
      const entries = parseFrontmatterBlock(`---\n${yaml}\n---\n`)!.entries
      const carried = entries.flatMap((entry) => entry.lines).join('\n')

      expect(carried).toBe(yaml)
      expect(isDurableFrontmatter(entries)).toBe(true)
      expect(parseYaml(carried)).toEqual(parseYaml(yaml))
    }
  })

  it('keeps blanks when a valid block-scalar owner has trailing space or node properties', () => {
    const raw = [
      '---',
      'spaced: |+   ',
      '  first',
      '',
      '  second',
      '',
      'anchored: &copy !!str >2- # authored',
      '  third',
      '',
      '  fourth',
      '---',
      '',
    ].join('\n')
    const block = parseFrontmatterBlock(raw)!

    expect(block.entries).toEqual([
      { key: 'spaced', lines: ['spaced: |+   ', '  first', '', '  second', ''] },
      {
        key: 'anchored',
        lines: ['anchored: &copy !!str >2- # authored', '  third', '', '  fourth'],
      },
    ])
    // Both extended headers remain unprojected; preservation must still be exact.
    expect(block.entries.map(frontmatterEntryValue)).toEqual([null, null])
    expect(isDurableFrontmatter(block.entries)).toBe(true)
  })

  it('does not attach a flush-left root sequence to an inline scalar owner', () => {
    const unsafe = parseFrontmatterBlock('---\nauthor: Ada\n- root item\n---\n')!
    const nestedBeforeList = parseFrontmatterBlock(
      '---\nmeta:\n  source: archive\n- root item\n---\n',
    )!
    const validList = parseFrontmatterBlock('---\ntags:\n- one\n- two\n---\n')!
    const commentedList = parseFrontmatterBlock('---\ntags: # authored\n- one\n- two\n---\n')!

    expect(unsafe.entries).toEqual([
      { key: 'author', lines: ['author: Ada'] },
      { key: null, lines: ['- root item'] },
    ])
    expect(nestedBeforeList.entries).toEqual([
      { key: 'meta', lines: ['meta:', '  source: archive'] },
      { key: null, lines: ['- root item'] },
    ])
    expect(isDurableFrontmatter(unsafe.entries)).toBe(false)
    expect(isDurableFrontmatter(nestedBeforeList.entries)).toBe(false)
    expect(frontmatterEntryValue(validList.entries[0])).toEqual(['one', 'two'])
    expect(isDurableFrontmatter(validList.entries)).toBe(true)
    expect(commentedList.entries).toEqual([
      { key: 'tags', lines: ['tags: # authored', '- one', '- two'] },
    ])
    expect(frontmatterEntryValue(commentedList.entries[0])).toBeNull()
    expect(isDurableFrontmatter(commentedList.entries)).toBe(true)
  })

  it('attaches an indentless sequence to a standalone anchor/tag property owner only', () => {
    const valid = parseFrontmatterBlock(
      [
        '---',
        'anchored: &common # authored',
        '- one',
        '- two',
        'tagged: !!seq',
        '- three',
        'both: !archive &saved',
        '- four',
        '---',
        '',
      ].join('\n'),
    )!

    expect(valid.entries).toEqual([
      { key: 'anchored', lines: ['anchored: &common # authored', '- one', '- two'] },
      { key: 'tagged', lines: ['tagged: !!seq', '- three'] },
      { key: 'both', lines: ['both: !archive &saved', '- four'] },
    ])
    expect(valid.entries.map(frontmatterEntryValue)).toEqual([null, null, null])
    expect(isDurableFrontmatter(valid.entries)).toBe(true)

    for (const owner of ['*common', '&common scalar', '!!seq scalar', '&a &b']) {
      const entries = parseFrontmatterBlock(`---\nx: ${owner}\n- root\n---\n`)!.entries

      expect(entries).toEqual([
        { key: 'x', lines: [`x: ${owner}`] },
        { key: null, lines: ['- root'] },
      ])
      expect(isDurableFrontmatter(entries)).toBe(false)
    }
  })

  it('uses the last duplicate entry in every shared raw-value helper', () => {
    const raw = '---\nx: old\nx: [new, final]\n---\n'
    const entries = parseFrontmatterBlock(raw)!.entries

    expect(frontmatterEntryOf(entries, 'x')).toBe(entries[1])
    expect(frontmatterEntryValueOf(raw, 'x')).toEqual(['new', 'final'])
    expect(frontmatterValue('---\nx: old\nx: final\n---\n', 'x')).toBe('final')
  })

  it('detects structural YAML anchors/aliases without matching authored text', () => {
    const references = [
      'top: &top value',
      'copy: *top',
      'meta:\n  child: &nested value',
      'meta:\n  copy: *nested',
      'meta:\n  - &nested value',
      'flow: [plain, &flow another]',
      'flow: [plain, *flow]',
      'flow: {source: &flow value, copy: *flow}',
      'flow: {"source":&flow value,"copy":*flow}',
      "flow: {'source':&flow value,'copy':*flow}",
    ].map((yaml) => parseFrontmatterBlock(`---\n${yaml}\n---\n`)!.entries)
    const plainText = parseFrontmatterBlock(
      [
        '---',
        'plain: A&B and fish &chips plus literal *alias',
        'quoted: "&anchor and *alias"',
        "single: '*alias &anchor'",
        'comment: value # &comment *comment',
        'code: |',
        '  &anchor-looking text',
        '  *alias-looking text',
        'nested:',
        '  sample: |',
        '    &nested-block-text',
        '---',
        '',
      ].join('\n'),
    )!.entries

    for (const entries of references) {
      expect(frontmatterHasYamlNodeReferences(entries)).toBe(true)
    }
    expect(frontmatterEntryDefinesYamlAnchor(references[0][0])).toBe(true)
    expect(frontmatterEntryDefinesYamlAnchor({ key: 'copy', lines: ['copy: *top'] })).toBe(false)
    expect(frontmatterHasYamlNodeReferences(plainText)).toBe(false)
    expect(frontmatterHasYamlNodeReferences(undefined)).toBe(false)
  })

  it('distinguishes JSON-style flow separators from colon text in plain flow nodes', () => {
    const referenced = [
      'flow: {"source":&flow value,"copy":*flow}',
      "flow: {'source':&flow value,'copy':*flow}",
      'flow: {\n  "source":&flow value,\n  "copy":*flow\n}',
    ]

    for (const yaml of referenced) {
      expect(() => parseYaml(yaml)).not.toThrow()
      expect(
        frontmatterHasYamlNodeReferences(parseFrontmatterBlock(`---\n${yaml}\n---\n`)!.entries),
      ).toBe(true)
    }

    // Without a non-plain key before the colon these are whole plain flow keys,
    // not YAML node properties. Their indicator-looking text must stay importable.
    const plain = 'flow: {source:&literal, copy:*literal}'

    expect(() => parseYaml(plain)).not.toThrow()
    expect(
      frontmatterHasYamlNodeReferences(parseFrontmatterBlock(`---\n${plain}\n---\n`)!.entries),
    ).toBe(false)
  })

  it('tracks YAML node references and scalar text across physical lines', () => {
    const anchored = [
      'flow: [\n  plain, &flow value\n  ]\ncopy: *flow',
      'flow: [\n  plain, &flow value,\n  *flow\n]',
      'flow: ["wrapped\n  text", &flow value]\ncopy: *flow',
      'tags: [\n  plain, &common value\n  ]\ncopies: [\n  plain, *common\n  ]',
    ]
    const scalarText = [
      'description: first\n  &not an anchor',
      'description: "first\n  &not an anchor"',
      "description: 'first\n  *not an alias'",
      'description:\n  |+\n    &not an anchor\n    *not an alias',
    ]

    for (const yaml of anchored) {
      const entries = parseFrontmatterBlock(`---\n${yaml}\n---\n`)!.entries

      expect(() => parseYaml(yaml)).not.toThrow()
      expect(frontmatterHasYamlNodeReferences(entries)).toBe(true)
      expect(frontmatterEntryDefinesYamlAnchor(entries[0])).toBe(true)
    }
    for (const yaml of scalarText) {
      const entries = parseFrontmatterBlock(`---\n${yaml}\n---\n`)!.entries

      expect(() => parseYaml(yaml)).not.toThrow()
      expect(frontmatterHasYamlNodeReferences(entries)).toBe(false)
      expect(frontmatterEntryDefinesYamlAnchor(entries[0])).toBe(false)
    }
  })

  it('requires the delimiters at the very start and a closing fence', () => {
    expect(parseFrontmatterBlock('body\n---\nnot: frontmatter\n---\n')).toBeNull()
    expect(parseFrontmatterBlock('---\nunterminated: yes\n')).toBeNull()
    // Crossing the metadata budget cannot turn a thematic break into frontmatter:
    // without a closing fence this whole input is ordinary markdown body.
    expect(parseFrontmatterBlock(`---\n${'body\n'.repeat(20_000)}`)).toBeNull()
    expect(parseFrontmatterBlock('\uFEFF---\ntitle: X\n---\n')).not.toBeNull() // a BOM is tolerated
  })

  it('rejects frontmatter just over 64 KiB before materialising its line array', () => {
    const atCap = `---\nx: ${'a'.repeat(FRONTMATTER_BYTE_CAP - 4)}\n---\nbody`
    const overCap = `---\nx: ${'a'.repeat(FRONTMATTER_BYTE_CAP - 3)}\n---\nbody`

    expect(parseFrontmatterBlock(atCap)?.entries).toHaveLength(1)
    expect(() => parseFrontmatterBlock(overCap)).toThrow(FrontmatterLimitError)
    expect(() => parseFrontmatterBlock(overCap)).toThrow('frontmatter exceeds the 64 KiB limit')
    // UTF-8 bytes, not JS code units: Cyrillic occupies two bytes per character.
    expect(() =>
      parseFrontmatterBlock(`---\nx: ${'я'.repeat(FRONTMATTER_BYTE_CAP / 2)}\n---\n`),
    ).toThrow('frontmatter exceeds the 64 KiB limit')
  })

  it('checks the same UTF-8 cap for bare snapshot frontmatter', () => {
    expect(isWithinFrontmatterByteCap('a'.repeat(FRONTMATTER_BYTE_CAP))).toBe(true)
    expect(isWithinFrontmatterByteCap('é'.repeat(FRONTMATTER_BYTE_CAP / 2))).toBe(true)
    expect(isWithinFrontmatterByteCap(`${'a'.repeat(FRONTMATTER_BYTE_CAP)}é`)).toBe(false)
  })

  it('does not apply the metadata cap to a large markdown body', () => {
    const body = 'b'.repeat(FRONTMATTER_BYTE_CAP * 4)
    const raw = `---\ntitle: Small metadata\n---\n${body}`
    const block = parseFrontmatterBlock(raw)!

    expect(raw.slice(block.bodyStart)).toBe(body)
  })

  it('reads the three value shapes and unquotes them', () => {
    const of = (raw: string) => frontmatterEntryValue(parseFrontmatterBlock(raw)!.entries[0])
    expect(of('---\ntags: [a, "b"]\n---\n')).toEqual(['a', 'b'])
    expect(of('---\ntags:\n- a\n-  b\n---\n')).toEqual(['a', 'b'])
    expect(of("---\ntitle: 'X'\n---\n")).toBe('X')
    expect(of('---\nempty:\n---\n')).toBeNull()
  })

  it('splits a simple flow list quote-aware, without treating quoted commas as separators', () => {
    const of = (raw: string) => frontmatterEntryValue(parseFrontmatterBlock(raw)!.entries[0])
    expect(of("---\ntags: [\"alpha,beta\", gamma, 'it''s fine']\n---\n")).toEqual([
      'alpha,beta',
      'gamma',
      "it's fine",
    ])
    expect(
      of(String.raw`---
tags: ["a\\b", "a\"b"]
---
`),
    ).toEqual(['a\\b', 'a"b'])
  })

  it('keeps flow-list scanning linear when a long plain token contains quotes', () => {
    // Re-slicing the whole token at every quote is quadratic. Quotes inside a
    // YAML plain scalar are ordinary characters, so this hostile shape is valid.
    const value = `a${'"'.repeat(40_000)}z`
    const raw = `---\ntags: [${value}]\n---\n`
    const t0 = Date.now()
    const parsed = frontmatterEntryValue(parseFrontmatterBlock(raw)!.entries[0])

    expect(parsed).toEqual([value])
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('does not guess at unsupported inline YAML — null keeps the raw entry carried', () => {
    const of = (line: string) =>
      frontmatterEntryValue(parseFrontmatterBlock(`---\nx: ${line}\n---\n`)!.entries[0])

    expect(of('{ work: true }')).toBeNull() // flow map
    expect(of('[a, { nested: true }]')).toBeNull() // nested collection
    expect(of('&common [a, b]')).toBeNull() // anchor
    expect(of('*common')).toBeNull() // alias
    expect(of('person # ontology comment')).toBeNull()
    expect(of('[a, b # comment]')).toBeNull()
    expect(of('"yaml\\n-escape"')).toBeNull() // unsupported quoted escape
  })

  it('reads a block list only when every line is an item at the same indentation', () => {
    const of = (raw: string) => frontmatterEntryValue(parseFrontmatterBlock(raw)!.entries[0])

    expect(of('---\ntags:\n  - a\n  - "b,c"\n---\n')).toEqual(['a', 'b,c'])
    expect(of('---\ntags:\n- a\n  - nested\n---\n')).toBeNull()
    expect(of('---\ntags:\n - a\n  - b\n---\n')).toBeNull()
    expect(of('---\ntags:\n- a\n  detail: b\n---\n')).toBeNull()
  })

  it('emitted entries round-trip back through the parser', () => {
    const raw = `---\n${[
      ...frontmatterScalarEntry('title', 'A: B').lines,
      ...frontmatterListEntry('tags', ['x', '[y]']).lines,
    ].join('\n')}\n---\nbody`
    const block = parseFrontmatterBlock(raw)!
    expect(frontmatterEntryValue(block.entries[0])).toBe('A: B')
    expect(frontmatterEntryValue(block.entries[1])).toEqual(['x', '[y]'])
  })

  it('frontmatterScalar quotes what a YAML reader would otherwise mis-parse', () => {
    expect(frontmatterScalar('plain')).toBe('plain')
    expect(frontmatterScalar('[[wiki]]')).toBe('"[[wiki]]"')
    expect(frontmatterScalar('A: B')).toBe('"A: B"')
    expect(frontmatterScalar('')).toBe('""')
    for (const resolved of [
      'true',
      'FALSE',
      'null',
      '~',
      '2025',
      '-12',
      '01',
      '1.25',
      '1e9',
      '0xFF',
      '.inf',
      '-.NaN',
    ]) {
      expect(frontmatterScalar(resolved)).toBe(`"${resolved}"`)
    }
    expect(frontmatterScalar('2025-03-14')).toBe('2025-03-14')
    expect(frontmatterScalar('123abc')).toBe('123abc')
  })

  // Found in review: reading a shape the EMITTER cannot express is worse than not
  // reading it. Every entry here is one `key: value` line, so a newline in a value
  // escapes the entry and the `---` block stops parsing there — taking our
  // notarium-id and created: with it, into the body.
  it('reads a block scalar as ONE line — the only shape a scalar channel can hold', () => {
    const of = (raw: string) => frontmatterEntryValue(parseFrontmatterBlock(raw)!.entries[0])
    // A Jekyll/Hugo folded title — the motivating real-world shape.
    expect(of('---\ntitle: >\n  Welcome to Jekyll: the guide\n---\n')).toBe(
      'Welcome to Jekyll: the guide',
    )
    expect(of('---\ntitle: >-\n  wrapped\n  over lines\n---\n')).toBe('wrapped over lines')
    // A literal block folds too: a multi-line TITLE has no meaning in this product,
    // and a value we cannot write back is a corrupted file.
    expect(of('---\ntitle: |\n  Two\n  Lines\n---\n')).toBe('Two Lines')
    expect(of('---\ntitle: |\n\n\n---\n')).toBeNull() // nothing but blanks → no value
    // Deeper indentation is measured, not assumed, and blank lines do not break it.
    expect(of('---\nd: |\n    a\n\n    b\n---\n')).toBe('a b')
  })

  it('preserves blank block-scalar lines verbatim and accepts both indicator orders', () => {
    const raw = '---\ndescription: |2-\n  first\n\n  second\n \nnext: x\n---\nbody'
    const block = parseFrontmatterBlock(raw)!

    expect(block.entries[0]).toEqual({
      key: 'description',
      lines: ['description: |2-', '  first', '', '  second', ' '],
    })
    expect(frontmatterEntryValue(block.entries[0])).toBe('first second')
    expect(
      frontmatterEntryValue(parseFrontmatterBlock('---\nd: >2+\n  a\n  b\n---\n')!.entries[0]),
    ).toBe('a b')
    // Invalid/multi-digit indicator: preserve rather than falsely capture.
    expect(
      frontmatterEntryValue(parseFrontmatterBlock('---\nd: |22\n  a\n---\n')!.entries[0]),
    ).toBeNull()
  })

  it('validates carried entries as durable, structurally consistent raw lines', () => {
    const parsed = parseFrontmatterBlock(
      '---\n# comment\nmeta:\n  source: obsidian\nd: |\n  a\n\n  b\n---\n',
    )!.entries

    expect(isDurableFrontmatter(undefined)).toBe(true)
    expect(isDurableFrontmatter([])).toBe(true)
    expect(isDurableFrontmatter(parsed)).toBe(true)
    expect(isDurableFrontmatter([{ key: null, lines: ['# standalone'] }])).toBe(true)
    expect(isDurableFrontmatter([{ key: 'author', lines: ['author: a\u0000b'] }])).toBe(false)
    expect(isDurableFrontmatter([{ key: 'author', lines: ['author: a\rb'] }])).toBe(false)
    expect(isDurableFrontmatter([{ key: 'wrong', lines: ['author: a'] }])).toBe(false)
    expect(isDurableFrontmatter([{ key: 'author', lines: ['author: a', 'other: hidden'] }])).toBe(
      false,
    )
    expect(isDurableFrontmatter([{ key: null, lines: ['title: hidden'] }])).toBe(false)
    expect(isDurableFrontmatter([{ key: null, lines: ['plain scalar'] }])).toBe(false)
    expect(isDurableFrontmatter([{ key: null, lines: ['- structural list item'] }])).toBe(false)
    expect(isDurableFrontmatter([{ key: null, lines: ['# comment', '  continuation'] }])).toBe(
      false,
    )
    expect(isDurableFrontmatter([{ key: null, lines: ['---'] }])).toBe(false)
    for (const marker of [
      '...',
      '... # document end',
      '--- # document start',
      '--- [second document]',
      '--- {title: foreign}',
      '... trailing',
      '%YAML 1.2',
      '%TAG ! tag:',
    ]) {
      expect(isDurableFrontmatter([{ key: null, lines: [marker] }])).toBe(false)
    }
    expect(isDurableFrontmatter([{ key: 'author', lines: [] }])).toBe(false)
    expect(isDurableFrontmatter([{ key: 'title', lines: ['title: T', ''] }])).toBe(false)
    expect(isDurableFrontmatter([{ key: 'title', lines: ['title: T', ' '] }])).toBe(false)
    expect(isDurableFrontmatter([{ key: 'd', lines: ['d: |2-', '', ' ', '  value'] }])).toBe(true)
    expect(
      isDurableFrontmatter([
        {
          key: 'tags',
          lines: ['tags:', '- a', '# comment', '- b'],
        },
      ]),
    ).toBe(true)
    expect(
      isDurableFrontmatter([{ key: 'tags', lines: ['tags:', '- a', '# trailing comment'] }]),
    ).toBe(false)
    expect(isDurableFrontmatter([{ key: 'author', lines: ['author: Ada', '- root'] }])).toBe(false)
    expect(
      isDurableFrontmatter([{ key: 'meta', lines: ['meta:', '  source: archive', '- root'] }]),
    ).toBe(false)
    expect(
      isDurableFrontmatter([{ key: 'd', lines: ['d: |', '  value', '# outside', '  orphan'] }]),
    ).toBe(false)
    expect(isDurableFrontmatter([{ key: 'review owner', lines: ['review owner: Ada'] }])).toBe(true)
    expect(isDurableFrontmatter([{ key: 'review owner', lines: ['review-owner: Ada'] }])).toBe(
      false,
    )
    expect(isDurableFrontmatter([{ key: '<<', lines: ['<<: *base'] }])).toBe(false)
    expect(isDurableFrontmatter('not entries')).toBe(false)
    expect(
      isDurableFrontmatter([{ key: 'x', lines: [`x: ${'a'.repeat(FRONTMATTER_BYTE_CAP)}`] }]),
    ).toBe(false)
  })

  it('validates a long owned comment run in one pass', () => {
    const entry = { key: 'x', lines: ['x:', ...Array(20_000).fill('#'), '  value'] }
    const t0 = Date.now()

    expect(isDurableFrontmatter([entry])).toBe(true)
    // The former suffix scan restarted from every comment and took several
    // seconds for this sub-64-KiB shape. This bound is deliberately generous.
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('never emits a value that escapes its entry — the invariant lives on the emitter', () => {
    expect(frontmatterScalar('Two\nLines')).toBe('Two Lines')
    expect(frontmatterScalar('a\r\n  b')).toBe('a b')
    // The nastiest shape: a value carrying the closing fence would end the block.
    const emitted = frontmatterScalarEntry('title', 'My Post\n---\nsecret')
    expect(emitted.lines).toHaveLength(1)
    const round = parseFrontmatterBlock(`---\n${emitted.lines[0]}\nid: keep\n---\nbody`)!
    expect(round.entries.map((e) => e.key)).toEqual(['title', 'id'])
    expect(frontmatterEntryValue(round.entries[1])).toBe('keep') // nothing was orphaned
  })

  it('tolerates trailing whitespace on the closing fence — real files carry it', () => {
    // Refusing it means the block is not frontmatter at all, so its raw YAML lands
    // in the note body as text. The importer allowed this before the parser was
    // shared; keeping the tolerant reading is what makes the consolidation safe.
    const block = parseFrontmatterBlock('---\ntitle: Post\ntags: [a]\n--- \n# Heading\n')!
    expect(block.entries.map((e) => e.key)).toEqual(['title', 'tags'])
    expect(parseFrontmatterBlock('---\ntitle: P\n---\t\nbody')).not.toBeNull()
  })

  it('collapses a newline LINEARLY — the obvious regex was a ReDoS on every save', () => {
    // `replace(/\s*\r?\n\s*/g, ' ')` backtracks over a long space run that holds no
    // newline: a title of 120k spaces cost 14 s of event loop per save (measured).
    const spaces = `a${' '.repeat(200_000)}b`
    const t0 = Date.now()
    const out = frontmatterScalar(spaces)
    const elapsed = Date.now() - t0
    expect(out.length).toBe(spaces.length) // untouched: no line break, nothing to collapse
    expect(out === spaces).toBe(true)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('a BARE carriage return is a line terminator too — the invariant covers it', () => {
    // The emitter detected /[\r\n]/ but split on /\r?\n/, so a lone CR passed
    // through. YAML and this module's mapping-line reader both treat it as a terminator,
    // so the `title:` line was re-read as a KEYLESS entry: the key vanished and the
    // next save appended a second copy instead of replacing it.
    expect(frontmatterScalar('a\rb')).toBe('a b')
    expect(frontmatterScalar('a\r\nb')).toBe('a b')
    expect(frontmatterScalar('a\nb')).toBe('a b')
    const round = parseFrontmatterBlock(
      `---\n${frontmatterScalarEntry('title', 'Quarterly\rreview').lines[0]}\nid: keep\n---\nbody`,
    )!
    expect(round.entries.map((e) => e.key)).toEqual(['title', 'id'])
    expect(frontmatterEntryValue(round.entries[0])).toBe('Quarterly review')
  })

  it('a line of only whitespace is blank, not a continuation — it cannot erase a key', () => {
    // The parser judged "blank" by `line === ''` but "continuation" by /^\s/, so a
    // line holding ONE SPACE attached to the key above it — and a reader that judges
    // an entry by its line count then reported that key as valueless. One invisible
    // character silently erased a note's title / created: / notarium-id:.
    const raw = '---\nnotarium-id: n7Kq2\ntitle: Договор аренды\n \ncreated: 2019-04-01\n---\nbody'
    const block = parseFrontmatterBlock(raw)!
    expect(block.entries.map((e) => e.key)).toEqual(['notarium-id', 'title', 'created'])
    expect(block.entries.every((e) => e.lines.length === 1)).toBe(true)
    expect(frontmatterValue(raw, 'title')).toBe('Договор аренды')
    expect(frontmatterValue(raw, 'created')).toBe('2019-04-01')
    expect(frontmatterValue(raw, 'notarium-id')).toBe('n7Kq2')
    // A tab-only line is the same case.
    expect(frontmatterValue('---\ntitle: T\n\t\nid: keep\n---\n', 'title')).toBe('T')
  })

  it('a value with UNREAD continuation lines is honestly null, never truncated', () => {
    const of = (raw: string) => frontmatterEntryValue(parseFrontmatterBlock(raw)!.entries[0])
    // A wrapped plain scalar, a wrapped quoted scalar and a flow list broken across
    // lines: reading line 0 alone would hand back a fragment, and a caller that
    // treats a value as "captured" would then delete the author's remainder.
    expect(
      of('---\ntitle: Welcome to Jekyll, a guide\n  for the impatient reader\n---\n'),
    ).toBeNull()
    expect(of("---\ntitle: 'Welcome to Jekyll,\n  a guide'\n---\n")).toBeNull()
    expect(of('---\ntags: [work, 2025,\n  personal]\n---\n')).toBeNull()
    // …while the single-line forms still read exactly as before.
    expect(of('---\ntitle: Welcome\n---\n')).toBe('Welcome')
    expect(of('---\ntags: [work, 2025]\n---\n')).toEqual(['work', '2025'])
  })

  it('handles many block-scalar lines below the metadata cap without argument spreads', () => {
    // The parser used to spread every indentation into Math.min. Keep this input
    // dense enough to exercise the loop while staying under the explicit 64 KiB cap.
    const many = `---\nd: |\n${'  x\n'.repeat(10_000)}---\nbody`
    expect(frontmatterEntryValue(parseFrontmatterBlock(many)!.entries[0])).toContain('x')
    const leadingBlanks = `---\nd: |\n${'\n'.repeat(20_000)}  x\n---\nbody`
    expect(frontmatterEntryValue(parseFrontmatterBlock(leadingBlanks)!.entries[0])).toBe('x')
  })

  it('stays linear on an all-blank block scalar (the guard used to be quadratic)', () => {
    // Rescanning the whole block per blank line cost ~4 s for this input on the
    // request path. The bound is 100x the current cost, so it fails on a regression
    // to O(n²) without being a wall-clock race on a loaded machine.
    const blanks = `---\nd: |\n${' \n'.repeat(25_000)}---\nbody`
    const t0 = Date.now()
    expect(frontmatterEntryValue(parseFrontmatterBlock(blanks)!.entries[0])).toBeNull()
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('does not rescan a huge non-block scalar for every following blank line', () => {
    const raw = `---\ntitle: ${'a'.repeat(30_000)}\n${'\n'.repeat(15_000)}next: x\n---\nbody`
    const t0 = Date.now()
    const block = parseFrontmatterBlock(raw)!

    expect(block.entries.map((entry) => entry.key)).toEqual(['title', 'next'])
    expect(Date.now() - t0).toBeLessThan(1_000)
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

// The geometry of a parsed block: where each entry physically sits. It is what lets a
// writer change one entry and leave every other byte alone, so it has to agree with the
// parser exactly or fail rather than guess.
describe('frontmatterEntrySpans', () => {
  const spansOf = (raw: string) => {
    const block = parseFrontmatterBlock(raw)

    if (!block) {
      throw new Error('fixture has no frontmatter block')
    }

    return { block, spans: frontmatterEntrySpans(raw, block) }
  }

  it('gives every entry back its own bytes, in order and without overlap', () => {
    const raw = '---\ntitle: A\ntags:\n  - x\n  - y\n# note\nslug: s\n---\nbody\n'
    const { block, spans } = spansOf(raw)

    expect(spans.map((span) => span.key)).toEqual(block.entries.map((entry) => entry.key))
    spans.forEach((span, index) => {
      expect(raw.slice(span.start, span.end)).toBe(`${block.entries[index].lines.join('\n')}\n`)
      if (index) {
        expect(span.start).toBeGreaterThanOrEqual(spans[index - 1].end)
      }
    })
  })

  it('covers the payload with no holes when nothing separates the entries', () => {
    const raw = '---\ntitle: A\nslug: s\n---\nbody\n'
    const { payloadStart, payloadEnd } = frontmatterPayloadBounds(raw, spansOf(raw).block.bodyStart)
    const { spans } = spansOf(raw)

    expect(spans[0].start).toBe(payloadStart)
    expect(spans[spans.length - 1].end).toBe(payloadEnd)
    expect(raw.slice(payloadEnd)).toBe('---\nbody\n')
  })

  it("steps over a separator blank the parser drops, and keeps a scalar's own blanks", () => {
    const raw = '---\ntitle: A\n\nnotes: |+\n  first\n\n\nslug: s\n---\nbody\n'
    const { spans } = spansOf(raw)

    expect(spans.map((span) => span.key)).toEqual(['title', 'notes', 'slug'])
    expect(raw.slice(spans[1].start, spans[1].end)).toBe('notes: |+\n  first\n\n\n')
    expect(raw.slice(spans[2].start, spans[2].end)).toBe('slug: s\n')
  })

  it('carries CRLF terminators inside the spans it reports', () => {
    const raw = '---\r\ntitle: A\r\nslug: s\r\n---\r\nbody\r\n'
    const { spans } = spansOf(raw)

    expect(raw.slice(spans[0].start, spans[0].end)).toBe('title: A\r\n')
    expect(raw.slice(spans[1].start, spans[1].end)).toBe('slug: s\r\n')
  })

  // The parser drops a blank that follows a KEYLESS entry outright — only a keyed entry
  // can adopt one later — and still appends the continuation after it to that same entry.
  // Its lines are then non-consecutive in the source, and a walk that insists on
  // consecutiveness refuses documents the parser describes perfectly, which silently
  // narrows what the identity channel may write to.
  it.each([
    ['a keyless list entry split by a blank', '---\n- name: a\n\n  role: b\n---\nbody\n'],
    ['a comment entry split by a blank', '---\n# notes\n\n  more\n---\nbody\n'],
    ['several blanks inside one keyless entry', '---\n- one\n\n  two\n\n  three\n---\nbody\n'],
  ])('reconstructs %s from its span', (_name, raw) => {
    const { block, spans } = spansOf(raw)

    expect(spans).toHaveLength(block.entries.length)
    expect(raw.slice(spans[0].start, spans[0].end)).toBe(
      raw.slice(raw.indexOf('\n') + 1, raw.lastIndexOf('\n---') + 1),
    )
  })

  it('still fails closed when a blank cannot explain the divergence', () => {
    const raw = '---\n- one\n\n  two\n---\nbody\n'
    const block = parseFrontmatterBlock(raw)!

    // A keyless entry whose lines simply are not in the source: the blank-skip must not
    // launder that into a match.
    expect(() =>
      frontmatterEntrySpans(raw, {
        ...block,
        entries: [{ key: null, lines: ['- one', '  three'] }],
      }),
    ).toThrow(FrontmatterGeometryError)
  })

  it('fails closed when the entries handed in do not describe the source', () => {
    const raw = '---\ntitle: A\n---\nbody\n'
    const block = parseFrontmatterBlock(raw)!

    expect(() =>
      frontmatterEntrySpans(raw, { ...block, entries: [{ key: 'title', lines: ['title: B'] }] }),
    ).toThrow(FrontmatterGeometryError)
  })
})

describe('stripFrontmatter degradation', () => {
  // Every caller here presents text and has no failure branch to take, so an oversized
  // block must read as "no block" rather than throw. Declared as a constraint by the
  // design and, until this test, provable only by reading the code.
  it('returns an oversized document whole instead of throwing', () => {
    const huge = `---\n${'x'.repeat(FRONTMATTER_BYTE_CAP + 1)}\n---\nBody.\n`

    expect(() => parseFrontmatterBlock(huge)).toThrow(FrontmatterLimitError)
    expect(stripFrontmatter(huge)).toBe(huge)
  })
})
