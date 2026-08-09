import { describe, expect, it } from 'vitest'

import { FRONTMATTER_BYTE_CAP } from '../../libs/markdown'
import { ImportError } from '../errors'
import { markdownFileToNote } from './markdown'

// The dropped-file parser: a plain text / markdown file → one note. Pins the title
// precedence (frontmatter `title:` > leading heading > filename), the frontmatter
// LIFT (#280 — tags/created/type into typed channels, everything else carried
// verbatim), the deterministic per-basename filename, and the '' directory (the
// host nests it under the drop-target folder).
describe('markdownFileToNote (#223)', () => {
  it('lifts the leading H1 as the title and drops it from the body', () => {
    const n = markdownFileToNote('# My Note\n\nBody paragraph.\n', 'notes.md')
    expect(n.title).toBe('My Note')
    expect(n.body).toBe('Body paragraph.')
    expect(n.source).toBe('file')
    expect(n.directory).toBe('')
  })

  it.each(['\r', '\u2028', '\u2029'])(
    'keeps title and body separate in a %j-delimited file',
    (sep) => {
      const n = markdownFileToNote(`# My Note${sep}${sep}Body paragraph.${sep}`, 'notes.md')

      expect(n.title).toBe('My Note')
      expect(n.body).toBe('Body paragraph.')
    },
  )

  it('accepts a CommonMark H1 indented by up to three spaces', () => {
    for (const indent of ['', ' ', '  ', '   ']) {
      const n = markdownFileToNote(`${indent}# Real\n\nBody`, 'fallback.md')

      expect(n.title).toBe('Real')
      expect(n.body).toBe('Body')
    }
    const code = markdownFileToNote('    # code\n\nBody', 'fallback.md')
    expect(code.title).toBe('fallback')
    expect(code.body).toContain('# code')
  })

  it('falls back to the filename (sans extension) when there is no H1', () => {
    const n = markdownFileToNote('buy milk\ncall Sam', 'todo list.txt')
    expect(n.title).toBe('todo list')
    expect(n.body).toBe('buy milk\ncall Sam')
  })

  it('derives a deterministic storage filename from the basename, not the title', () => {
    const n = markdownFileToNote('# Different Title\n\nx', 'weekly-notes.md')
    expect(n.title).toBe('Different Title')
    expect(n.fileName).toBe('weekly-notes') // slug of the source basename → idempotent per file
  })

  it('a setext heading titles the note and is peeled with its underline', () => {
    const n = markdownFileToNote('My Note\n=======\n\nBody.', 'x.md')
    expect(n.title).toBe('My Note')
    expect(n.body).toBe('Body.')
  })

  it('does not mistake a lone --- thematic break for frontmatter', () => {
    const n = markdownFileToNote('First line\n\n---\n\nSecond.', 'doc.txt')
    expect(n.title).toBe('doc')
    expect(n.body).toBe('First line\n\n---\n\nSecond.')
  })

  it('keeps a large thematic-break document body when no closing fence exists', () => {
    const raw = `---\n${'body line\n'.repeat(8_000)}`
    const n = markdownFileToNote(raw, 'large-body.md')

    expect(n.title).toBe('large-body')
    expect(n.body.startsWith('---\nbody line')).toBe(true)
    expect(n.body.length).toBe(raw.trimEnd().length)
  })

  it('classifies confirmed oversized frontmatter as a deterministic import error', () => {
    const raw = `---\nx: ${'a'.repeat(FRONTMATTER_BYTE_CAP)}\n---\nbody`

    expect(() => markdownFileToNote(raw, 'oversized.md')).toThrow(ImportError)
    expect(() => markdownFileToNote(raw, 'oversized.md')).toThrow(
      'oversized.md: frontmatter exceeds the 64 KiB limit',
    )
  })

  it('strips a UTF-8 BOM before parsing', () => {
    const n = markdownFileToNote('\uFEFF# Title\n\nBody', 'b.md')
    expect(n.title).toBe('Title')
    expect(n.body).toBe('Body')
  })

  it('keeps the legacy hashed storage key for a non-romanisable basename', () => {
    // Import storage identity must not change across a slug-alphabet upgrade:
    // re-importing the same source has to overwrite/skip its old path, not duplicate it.
    const a = markdownFileToNote('content a', '笔记.md')
    const b = markdownFileToNote('content b', '日记.md')
    expect(a.fileName).toBe('note-01qpbapg')
    expect(b.fileName).toBe('note-00qyrh1f')
    expect(a.title).toBe('笔记')
  })

  it('a basename with no letters at all still gets a DISTINCT, stable filename', () => {
    // The hash fallback survives for the case that really has nothing to name a file
    // with — two emoji-named drops must not land on one path.
    const a = markdownFileToNote('content a', '🎉.md')
    const b = markdownFileToNote('content b', '🚀.md')
    expect(a.fileName).toMatch(/^note-[a-z0-9]{8}$/)
    expect(b.fileName).toMatch(/^note-[a-z0-9]{8}$/)
    expect(a.fileName).not.toBe(b.fileName)
  })

  it('a long H1 line with trailing spaces titles cleanly (greedy capture + trim, no ReDoS)', () => {
    // The ReDoS shape was `#␠<long>␠␠…` — the greedy capture + `.trim()` handles it
    // linearly and still yields the right title.
    const n = markdownFileToNote('# ' + 'a'.repeat(5000) + '   ', 'x.md')
    expect(n.title).toBe('a'.repeat(5000))
    expect(n.body).toBe('')
  })

  it('is pure — same input yields the same note twice', () => {
    const a = markdownFileToNote('# T\n\nb', 'f.md')
    const b = markdownFileToNote('# T\n\nb', 'f.md')
    expect(a).toEqual(b)
  })
})

// The whole point of #280: a user's frontmatter is the user's DATA, not service
// noise. What we understand is lifted into typed channels; the rest survives.
describe('markdownFileToNote — frontmatter is lifted, not stripped (#280)', () => {
  it('lifts title, tags and the creation date — the issue’s own example', () => {
    const n = markdownFileToNote(
      '---\ntitle: Договор\ntags: [работа, 2025]\ncreated: 2025-03-14\n---\n\nТело договора.',
      'dogovor.md',
    )
    expect(n.title).toBe('Договор')
    expect(n.tags).toEqual(['работа', '2025'])
    expect(n.createdAt).toBe('2025-03-14T00:00:00.000Z')
    expect(n.body).toBe('Тело договора.')
  })

  it('reads tags as a block list, a flow list or a comma scalar, and peels a hand-written #', () => {
    const block = markdownFileToNote('---\ntags:\n- work\n- 2025\n---\nx', 'a.md')
    const flow = markdownFileToNote('---\ntags: [work, 2025]\n---\nx', 'a.md')
    const scalar = markdownFileToNote('---\ntags: work, 2025\n---\nx', 'a.md')
    const hashed = markdownFileToNote('---\ntags:\n- "#work"\n---\nx', 'a.md')
    expect(block.tags).toEqual(['work', '2025'])
    expect(flow.tags).toEqual(['work', '2025'])
    expect(scalar.tags).toEqual(['work', '2025'])
    expect(hashed.tags).toEqual(['work'])
    // Hierarchy and case are NOT normalised here — foldTag does that at read time.
    expect(markdownFileToNote('---\ntags: [Work/2025]\n---\nx', 'a.md').tags).toEqual(['Work/2025'])
  })

  it('does not split a quoted comma inside a flow-list tag', () => {
    const n = markdownFileToNote('---\ntags: ["Smith, John", work]\n---\nx', 'a.md')

    expect(n.tags).toEqual(['Smith, John', 'work'])
    expect(n.frontmatter).toBeUndefined()
  })

  it('uses the last duplicate value before collapsing a lifted key', () => {
    const n = markdownFileToNote(
      '---\ntitle: Old\ntitle: New\ntags: [old]\ntags: [new, final]\ntype: old\ntype: final\n---\nx',
      'a.md',
    )

    expect(n.title).toBe('New')
    expect(n.tags).toEqual(['new', 'final'])
    expect(n.noteType).toBe('final')
    expect(n.frontmatter).toBeUndefined()
  })

  it('carries unsupported inline and nested tag shapes instead of corrupting them', () => {
    for (const raw of [
      'tags: [a, b] # curated',
      'tags: {work: true}',
      'tags:\n  categories:\n    - work\n    - personal',
    ]) {
      const n = markdownFileToNote(`---\n${raw}\n---\nx`, 'a.md')

      expect(n.tags).toBeUndefined()
      expect((n.frontmatter ?? []).flatMap((e) => e.lines)).toEqual(raw.split('\n'))
    }
  })

  it('preserves every referenced entry so the store can apply collision policy before refusal', () => {
    const cases = [
      'title: &authored Original\ncopy: *authored',
      'foreign: &foreign value\ncopy: *foreign',
      'created: &date 2020-01-01\ncopy: *date',
      'tags: &common [old]\ntags: [new]\ncopy: *common',
      'flow: [\n  plain, &flow value\n  ]\ncopy: *flow',
      'flow: [\n  plain, &flow value,\n  *flow\n]',
      'foreign: &foreign value\naliases: [*foreign]',
      'title: {"base":&flow Original}\ncopy: {"value":*flow}',
      [
        'title: &authored Original',
        'notarium-id: foreign-id',
        'notarium-created: 2019-05-05T10:00:00.000Z',
        'tags: [*authored]',
        'created: 2020-01-01',
        'type: note',
      ].join('\n'),
    ]

    for (const yaml of cases) {
      const note = markdownFileToNote(`---\n${yaml}\n---\nbody`, 'anchored.md')

      expect((note.frontmatter ?? []).flatMap((entry) => entry.lines)).toEqual(yaml.split('\n'))
    }
  })

  it('does not mistake multiline plain, quoted or block-scalar text for YAML references', () => {
    expect(markdownFileToNote('---\ntitle: A&B\n---\nbody', 'a.md').title).toBe('A&B')
    expect(markdownFileToNote('---\ntitle: "A&B"\n---\nbody', 'a.md').title).toBe('A&B')
    expect(markdownFileToNote('---\ntitle: |\n  A&B documentation\n---\nbody', 'a.md').title).toBe(
      'A&B documentation',
    )
    for (const yaml of [
      'description: first\n  &not an anchor',
      'description: "first\n  &not an anchor"',
      'description:\n  |+\n    &not an anchor\n    *not an alias',
    ]) {
      expect(() => markdownFileToNote(`---\n${yaml}\n---\nbody`, 'a.md')).not.toThrow()
    }
  })

  it('rejects a second confirmed leading frontmatter block but keeps a lone thematic break', () => {
    const doubled = '---\ntitle: First\n---\n\n---\nforeign: value\n---\nbody'

    expect(() => markdownFileToNote(doubled, 'double.md')).toThrow(ImportError)
    expect(() => markdownFileToNote(doubled, 'double.md')).toThrow(
      'double.md: a second leading frontmatter block is unsupported',
    )
    expect(markdownFileToNote('---\ntitle: First\n---\n\n---\nordinary body', 'one.md').body).toBe(
      '---\nordinary body',
    )
  })

  it('carries an entire commented block list/map instead of lifting only their prefix', () => {
    const raw = [
      'tags:',
      '- old',
      '# keep the next authored item',
      '- new',
      'meta:',
      '  a: 1',
      '# keep the next authored field',
      '  b: 2',
    ].join('\n')
    const note = markdownFileToNote(`---\n${raw}\n---\nbody`, 'a.md')

    expect(note.tags).toBeUndefined()
    expect((note.frontmatter ?? []).flatMap((entry) => entry.lines)).toEqual(raw.split('\n'))
  })

  it('has no tags when the frontmatter names none (undefined, not an empty list)', () => {
    // [] would CLEAR tags through the write channel; undefined leaves them alone.
    expect(markdownFileToNote('---\nauthor: S\n---\nx', 'a.md').tags).toBeUndefined()
    expect(markdownFileToNote('plain body', 'a.md').tags).toBeUndefined()
  })

  it('reads the date from created > date > created_at > createdAt, first one that parses', () => {
    const ours = markdownFileToNote('---\ncreated: 2020-01-02\ndate: 2021-01-02\n---\nx', 'a.md')
    const jekyll = markdownFileToNote('---\ndate: 2021-01-02\n---\nx', 'a.md')
    const snake = markdownFileToNote('---\ncreated_at: 2022-01-02\n---\nx', 'a.md')
    const camel = markdownFileToNote('---\ncreatedAt: 2023-01-02\n---\nx', 'a.md')
    const resolvedFallback = markdownFileToNote(
      '---\ncreated: someday\nnotarium-created: 2019-05-05T10:00:00.000Z\n---\nx',
      'a.md',
    )
    expect(ours.createdAt).toBe('2020-01-02T00:00:00.000Z')
    expect(jekyll.createdAt).toBe('2021-01-02T00:00:00.000Z')
    expect(snake.createdAt).toBe('2022-01-02T00:00:00.000Z')
    expect(camel.createdAt).toBe('2023-01-02T00:00:00.000Z')
    expect(resolvedFallback.createdAt).toBe('2019-05-05T10:00:00.000Z')
    expect((resolvedFallback.frontmatter ?? []).flatMap((entry) => entry.lines)).toEqual([
      'created: someday',
    ])
  })

  it('falls back to the source file mtime, and an unparseable date does not shadow it', () => {
    const mtime = '2019-05-05T10:00:00.000Z'
    expect(markdownFileToNote('---\nauthor: S\n---\nx', 'a.md', mtime).createdAt).toBe(mtime)
    expect(markdownFileToNote('plain body', 'a.md', mtime).createdAt).toBe(mtime)
    // A garbage `created:` must not win — it parses to nothing, so the mtime stands.
    expect(markdownFileToNote('---\ncreated: someday\n---\nx', 'a.md', mtime).createdAt).toBe(mtime)
    // …and an authored date beats the file's mtime.
    expect(markdownFileToNote('---\ncreated: 2011-02-03\n---\nx', 'a.md', mtime).createdAt).toBe(
      '2011-02-03T00:00:00.000Z',
    )
  })

  it('with no date anywhere, claims none — the engine then dates it by birthtime', () => {
    expect(markdownFileToNote('# T\n\nx', 'a.md').createdAt).toBeUndefined()
  })

  it('lifts the frontmatter `type:` into the note type', () => {
    expect(markdownFileToNote('---\ntype: person\n---\nx', 'a.md').noteType).toBe('person')
    expect(markdownFileToNote('# T\n\nx', 'a.md').noteType).toBeUndefined()
  })

  it('carries an annotated type scalar whose comment it cannot preserve when lifted', () => {
    const n = markdownFileToNote('---\ntype: person # ontology\n---\nx', 'a.md')

    expect(n.noteType).toBeUndefined()
    expect((n.frontmatter ?? []).flatMap((e) => e.lines)).toEqual(['type: person # ontology'])
  })

  it('carries every key it did NOT lift, verbatim — including a nested map', () => {
    const n = markdownFileToNote(
      '---\ntitle: T\ntags: [a]\ntype: note\nauthor: Sergey\naliases: [Old Name]\nmeta:\n  source: obsidian\n  rating: 5\n---\nx',
      'a.md',
    )
    const lines = (n.frontmatter ?? []).flatMap((e) => e.lines)
    expect(lines).toEqual([
      'author: Sergey',
      'aliases: [Old Name]',
      'meta:',
      '  source: obsidian',
      '  rating: 5',
    ])
    // The lifted keys ride the typed channels instead — carrying them too would
    // make the file assert them twice.
    expect(lines.some((l) => /^(title|tags|type):/.test(l))).toBe(false)
  })

  it('carries ordinary Unicode and spaced mapping keys as keyed entries', () => {
    const n = markdownFileToNote(
      '---\nавтор: Сергей\nreview owner: Ada\nsource:url: archive\n---\nbody',
      'note.md',
    )

    expect(n.frontmatter).toEqual([
      { key: 'автор', lines: ['автор: Сергей'] },
      { key: 'review owner', lines: ['review owner: Ada'] },
      { key: 'source:url', lines: ['source:url: archive'] },
    ])
  })

  // Found in review: "the key is one we lift" and "we actually read its value" are
  // different facts, and conflating them DELETED data — a shape the lift cannot read
  // was dropped from the carry anyway, so nobody asserted it.
  it('reads a Jekyll/Hugo folded or literal block scalar as the title, not the indicator', () => {
    const folded = markdownFileToNote(
      '---\nlayout: post\ntitle: >\n  Welcome to Jekyll: the guide\ndate: 2016-11-17\n---\nThe post body.',
      'welcome-to-jekyll.md',
    )
    expect(folded.title).toBe('Welcome to Jekyll: the guide')
    expect(folded.createdAt).toBe('2016-11-17T00:00:00.000Z')
    expect(folded.body).toBe('The post body.')

    // A literal block folds onto ONE line: a value carrying a newline could not be
    // written back into a `key: value` entry without breaking the block.
    const literal = markdownFileToNote('---\ntitle: |\n  Two\n  Lines\n---\nx', 'a.md')
    expect(literal.title).toBe('Two Lines')
    // Folding joins wrapped lines and keeps a blank line as the paragraph break.
    expect(
      markdownFileToNote('---\ntitle: >-\n  wrapped\n  over lines\n---\nx', 'a.md').title,
    ).toBe('wrapped over lines')
    expect(markdownFileToNote('---\ntitle: |2-\n  Kept title\n---\nx', 'a.md').title).toBe(
      'Kept title',
    )
    expect(markdownFileToNote('---\ntitle: >2+\n  Kept too\n---\nx', 'a.md').title).toBe('Kept too')
  })

  it('keeps blank physical lines inside an unmodelled block scalar', () => {
    const n = markdownFileToNote(
      '---\ntitle: T\ndescription: |\n  first\n\n  second\n---\nx',
      'a.md',
    )

    expect((n.frontmatter ?? []).flatMap((e) => e.lines)).toEqual([
      'description: |',
      '  first',
      '',
      '  second',
    ])
  })

  it('keeps semantic blanks in nested block and multiline scalar carry', () => {
    for (const yaml of [
      'description:\n  |+\n    first\n\n    second\n\nnext: x',
      'meta:\n  text: |+\n    first\n\n    second\n  sibling: kept',
      'items:\n- |+\n  first\n\n  second\n- tail',
      'description: "first\n\n  second"\nnext: x',
      'description: first\n\n  second\nnext: x',
    ]) {
      const note = markdownFileToNote(`---\n${yaml}\n---\nbody`, 'nested.md')

      expect((note.frontmatter ?? []).flatMap((entry) => entry.lines)).toEqual(yaml.split('\n'))
    }
  })

  it('keeps blank-only and inline-comment block scalar bytes in the import carry', () => {
    const blankOnly = markdownFileToNote('---\ndescription: |+\n\n\n---\nx', 'a.md')
    const annotated = markdownFileToNote(
      '---\ndescription: |+ # keep\n  first\n\n  second\n\n---\nx',
      'a.md',
    )

    expect(blankOnly.frontmatter).toEqual([
      { key: 'description', lines: ['description: |+', '', ''] },
    ])
    expect(annotated.frontmatter).toEqual([
      {
        key: 'description',
        lines: ['description: |+ # keep', '  first', '', '  second', ''],
      },
    ])
  })

  it('carries extended block-scalar headers and property-owned lists without losing lines', () => {
    const raw = [
      'description: |+   ',
      '  first',
      '',
      '  second',
      '',
      'tags: !!seq # authored',
      '- one',
      '- two',
    ].join('\n')
    const note = markdownFileToNote(`---\n${raw}\n---\nbody`, 'extended.md')

    expect(note.tags).toBeUndefined()
    expect((note.frontmatter ?? []).flatMap((entry) => entry.lines)).toEqual(raw.split('\n'))
  })

  it('carries a lifted key whose SHAPE the lift cannot read — uncaptured is not deletable', () => {
    // `type:` as a block list and `tags:` as a nested map yield no typed value, so
    // nothing would re-assert them; they must ride along like any unmodelled key.
    const listType = markdownFileToNote('---\ntype:\n- person\n- author\nname: Ada\n---\nx', 'a.md')
    expect(listType.noteType).toBeUndefined()
    expect((listType.frontmatter ?? []).flatMap((e) => e.lines)).toEqual([
      'type:',
      '- person',
      '- author',
      'name: Ada',
    ])

    const mapTags = markdownFileToNote('---\ntags:\n  a: 1\n  b: 2\n---\nx', 'a.md')
    expect(mapTags.tags).toBeUndefined()
    expect((mapTags.frontmatter ?? []).flatMap((e) => e.lines)).toEqual([
      'tags:',
      '  a: 1',
      '  b: 2',
    ])
  })

  it('still drops a lifted key once its value IS captured — never asserted twice', () => {
    const n = markdownFileToNote('---\ntags: [a]\ntype: person\n---\nx', 'a.md')
    expect(n.tags).toEqual(['a'])
    expect(n.noteType).toBe('person')
    expect(n.frontmatter).toBeUndefined()
  })

  it('an unreadable title shape degrades to the fallback instead of titling the note "|"', () => {
    // A nested-map title is the one shape that cannot survive under its own key —
    // the write path asserts our `title:` unconditionally. It must at least not
    // produce a garbage title.
    const n = markdownFileToNote(
      '---\ntitle:\n  en: Contract\n  ru: Договор\n---\n# Real\n\nx',
      'a.md',
    )
    expect(n.title).toBe('Real')
  })

  it('a blank upload name never eats a body line (a blank title is not an explicit one)', () => {
    // Found in review: a name of only spaces is truthy but blank, and
    // promoteBodyTitle gates Bear promotion on explicit?.trim() — so the first body
    // line was peeled while the blank title was kept, and the line existed nowhere.
    const n = markdownFileToNote('Buy milk\nand eggs\nthird\n', '   ')
    expect(n.title).toBe('Untitled')
    expect(n.body).toBe('Buy milk\nand eggs\nthird')
  })

  it('never carries a foreign notarium-id — an identity is not the author’s to donate', () => {
    const n = markdownFileToNote('---\nnotarium-id: someoneElse\nauthor: S\n---\nx', 'a.md')
    expect((n.frontmatter ?? []).flatMap((e) => e.lines)).toEqual(['author: S'])
  })

  it('carries nothing when the file has no frontmatter (or only lifted keys)', () => {
    expect(markdownFileToNote('# T\n\nx', 'a.md').frontmatter).toBeUndefined()
    expect(markdownFileToNote('---\ntitle: T\n---\nx', 'a.md').frontmatter).toBeUndefined()
  })
})

// The precedence question the issue left open, answered by the code that already
// existed: parseNoteFile (any .md on disk) and the MCP create_note both let the
// explicit metadata title win over the body's heading, peeling the heading only
// when it duplicates. Import composes the same way.
describe('markdownFileToNote — title precedence against a body heading (#156/#280)', () => {
  it('the frontmatter title wins over a DIFFERENT H1, which stays in the body', () => {
    const n = markdownFileToNote('---\ntitle: Договор\n---\n# Черновик\n\nТело.', 'f.md')
    expect(n.title).toBe('Договор')
    expect(n.body).toBe('# Черновик\n\nТело.') // nothing is dropped
  })

  it('an H1 that MATCHES the frontmatter title is peeled — our own export round-trips', () => {
    const n = markdownFileToNote('---\ntitle: Договор\n---\n# Договор\n\nТело.', 'f.md')
    expect(n.title).toBe('Договор')
    expect(n.body).toBe('Тело.') // no duplicate heading
  })

  it('a title ending in a # run still round-trips our own export (no stacking heading)', () => {
    // The h1 capture drops a CommonMark closing `#` run, so the parsed heading and
    // the frontmatter title differed and the heading was never peeled — each
    // export→import cycle then stacked another copy of it into the body.
    const n = markdownFileToNote(
      '---\ntitle: "Sprint review #"\nnotarium-id: abc\n---\n\n# Sprint review #\n\nBody line.',
      'sprint-review.md',
    )
    expect(n.title).toBe('Sprint review #')
    expect(n.body).toBe('Body line.')
    // …and the mirror case still works: a closing run the AUTHOR wrote is stripped.
    const authored = markdownFileToNote('---\ntitle: Intro\n---\n# Intro #\n\nx', 'a.md')
    expect(authored.title).toBe('Intro')
    expect(authored.body).toBe('x')
  })

  it('with no frontmatter title the leading H1 titles the note, as before', () => {
    const n = markdownFileToNote('---\nauthor: S\n---\n# Real\n\nContent.', 'x.md')
    expect(n.title).toBe('Real')
    expect(n.body).toBe('Content.')
  })

  it('the filename — NOT the first prose line — is the last resort', () => {
    // Bear-style prose promotion is right for the editor and wrong here: for an
    // Obsidian note the FILE NAME is the title.
    const n = markdownFileToNote('---\nkey: v\n---\nJust text.', 'my file.md')
    expect(n.title).toBe('my file')
    expect(n.body).toBe('Just text.')
  })

  it('a frontmatter title is used even when the body opens with prose', () => {
    const n = markdownFileToNote('---\ntitle: Meeting notes\n---\nWe agreed to ship.', 'raw.md')
    expect(n.title).toBe('Meeting notes')
    expect(n.body).toBe('We agreed to ship.')
  })
})
