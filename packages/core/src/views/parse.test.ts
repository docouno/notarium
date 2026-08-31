import { describe, expect, it } from 'vitest'
import { isScalar } from 'yaml'

import { parseViewDocument, sameViewCarriers, semanticViewContent, viewTypeForBody } from './parse'
import { VIEW_BLOCK_STATUS, VIEW_DOCUMENT_LIMIT } from './types'
import { decodeViewRef } from './viewRef'

const board = (extra = '') =>
  [
    'version: 1',
    'source:',
    '  kind: notes',
    '  scope: project',
    'views:',
    '  - name: Board',
    '    type: board',
    '    options:',
    '      groupBy: note.status',
    extra,
  ]
    .filter(Boolean)
    .join('\n')

describe('parseViewDocument', () => {
  it('parses an inline carrier and removes only its config from semantic content', () => {
    const raw = `Before.\n\n\`\`\`nota\n${board()}\n\`\`\`\n\nAfter.`
    const parsed = parseViewDocument(raw, { documentId: 'note-1', versionToken: 'v1:test' })

    expect(parsed.blocks).toHaveLength(1)
    expect(parsed.blocks[0]).toMatchObject({ complete: true, status: VIEW_BLOCK_STATUS.ready })
    expect(parsed.primaryReader).toEqual({ kind: 'value', value: 'board' })
    expect(parsed.views[0]).toMatchObject({ name: 'Board', type: 'board' })
    expect(decodeViewRef(parsed.views[0]!.viewRef!)).toEqual({
      documentId: 'note-1',
      versionToken: 'v1:test',
      block: 0,
      view: 0,
    })
    expect(parsed.semanticContent).toContain('Before.')
    expect(parsed.semanticContent).toContain('After.')
    expect(parsed.semanticContent).not.toContain('note.status')
  })

  it('accepts CommonMark fence variants without mistaking a short closer for the end', () => {
    const raw = `~~~NoTa\r\n${board('      note: "```"')}\r\n~~~\r\n`
    const parsed = parseViewDocument(raw)

    expect(parsed.blocks[0]).toMatchObject({ complete: true, eol: '\r\n' })
    expect(parsed.blocks[0]?.payloadRange.end).toBe(raw.lastIndexOf('~~~'))
    expect(parsed.semanticContent).not.toContain('note.status')
  })

  it('does not execute a nota-looking fence nested inside another code fence', () => {
    const raw = ['````markdown', '```nota', board(), '```', '````', '', 'prose'].join('\n')
    const parsed = parseViewDocument(raw)

    expect(parsed.blocks).toEqual([])
    expect(parsed.primaryReader).toEqual({ kind: 'absent' })
    expect(parsed.semanticContent).toBe(raw)
  })

  it('leaves ordinary markdown untouched on both the confirmed-absence and false-hint paths', () => {
    const withoutHint = 'Ordinary prose without a carrier.\n'.repeat(4_000)
    const falseHint = [
      'The word nota in prose is not a carrier.',
      '',
      '```markdown',
      'nota is ordinary code here',
      '```',
    ].join('\n')

    for (const raw of [withoutHint, falseHint]) {
      const parsed = parseViewDocument(raw)

      expect(parsed.blocks).toEqual([])
      expect(parsed.semanticContent).toBe(raw)
      expect(parsed.primaryReader).toEqual({ kind: 'absent' })
    }
  })

  it('keeps reader names display-only and reports duplicate names without dropping views', () => {
    const raw = [
      '```nota',
      'version: 1',
      'source: { kind: notes }',
      'views:',
      '  - { name: Same, type: board }',
      '  - { name: Same, type: future-reader }',
      '```',
    ].join('\n')
    const parsed = parseViewDocument(raw)

    expect(parsed.blocks[0]?.status).toBe(VIEW_BLOCK_STATUS.ready)
    expect(parsed.views.map((view) => view.type)).toEqual(['board', 'future-reader'])
    expect(parsed.diagnostics.filter((d) => d.code === 'duplicate-view-name')).toHaveLength(2)
  })

  it('contains malformed, future and incomplete failures to their blocks', () => {
    const raw = [
      '```nota',
      'version: 2',
      'source: { kind: notes }',
      'views: [{ name: Later, type: later }]',
      '```',
      '',
      '```nota',
      'version: [',
      '```',
      '',
      '```nota',
      board(),
    ].join('\n')
    const parsed = parseViewDocument(raw)

    expect(parsed.blocks.map((block) => block.status)).toEqual([
      VIEW_BLOCK_STATUS.future,
      VIEW_BLOCK_STATUS.malformed,
      VIEW_BLOCK_STATUS.malformed,
    ])
    expect(parsed.primaryReader).toEqual({ kind: 'unproven' })
    expect(parsed.semanticContent).not.toContain('source:')
  })

  it('keeps 10k JSONL ranks in one YAML scalar node', () => {
    const ranks = Array.from(
      { length: 10_000 },
      (_, index) => `          ["n-${index}","a0"]`,
    ).join('\n')
    const raw = `\`\`\`nota\n${board(`      order:\n        kind: manual\n        ranks: |-\n${ranks}`)}\n\`\`\``
    const parsed = parseViewDocument(raw)
    const node = parsed.blocks[0]?.yamlDocument?.getIn(
      ['views', 0, 'options', 'order', 'ranks'],
      true,
    )

    expect(parsed.blocks[0]?.status).toBe(VIEW_BLOCK_STATUS.ready)
    expect(isScalar(node)).toBe(true)
    expect(
      isScalar(node) && typeof node.value === 'string' ? node.value.split('\n') : [],
    ).toHaveLength(10_000)
  })

  it('rejects excessive block and payload work before constructing YAML documents', () => {
    const one = `\`\`\`nota\n${board()}\n\`\`\``
    const tooManyBlocks = parseViewDocument(
      Array(VIEW_DOCUMENT_LIMIT.blocks + 1)
        .fill(one)
        .join('\n'),
    )
    const tooManyBytes = parseViewDocument(
      `\`\`\`nota\n${'x'.repeat(VIEW_DOCUMENT_LIMIT.payloadBytes + 1)}\n\`\`\``,
    )
    const tooManyUnicodeBytes = parseViewDocument(
      `\`\`\`nota\n${'🙂'.repeat(Math.floor(VIEW_DOCUMENT_LIMIT.payloadBytes / 4) + 1)}\n\`\`\``,
    )

    expect(tooManyBlocks.blocks).toHaveLength(VIEW_DOCUMENT_LIMIT.blocks)
    expect(tooManyBlocks.blocks.every((block) => block.status === 'resource-limit')).toBe(true)
    expect(tooManyBlocks.blocks.every((block) => block.yamlDocument === undefined)).toBe(true)
    expect(tooManyBytes.blocks[0]).toMatchObject({
      status: VIEW_BLOCK_STATUS.resourceLimit,
    })
    expect(tooManyBytes.blocks[0]?.yamlDocument).toBeUndefined()
    expect(tooManyUnicodeBytes.blocks[0]?.status).toBe(VIEW_BLOCK_STATUS.resourceLimit)
  })

  it('keeps block-limit output bounded while stripping every overflow carrier', () => {
    const carriers = 100_000
    const raw = '```nota\n\n```\n'.repeat(carriers)
    const result = parseViewDocument(raw)

    expect(result.blocks).toHaveLength(VIEW_DOCUMENT_LIMIT.blocks)
    expect(result.diagnostics).toHaveLength(VIEW_DOCUMENT_LIMIT.blocks)
    expect(result.blocks.every((block) => block.status === VIEW_BLOCK_STATUS.resourceLimit)).toBe(
      true,
    )
    expect(result.semanticContent).not.toContain('```nota')
    expect(result.semanticContent).toHaveLength(carriers * 2)
    expect(result.views).toEqual([])
  })

  it('compares overflow carriers without exposing an unbounded block array', () => {
    const carriers = Array.from(
      { length: VIEW_DOCUMENT_LIMIT.blocks + 1 },
      (_, index) => `\`\`\`nota\nvalue: ${index}\n\`\`\``,
    )
    const before = carriers.join('\n')
    const proseOnly = `Prose before.\n${before}\nProse after.`
    const changed = [...carriers]

    changed[VIEW_DOCUMENT_LIMIT.blocks] = `\`\`\`nota\nvalue: changed\n\`\`\``
    expect(sameViewCarriers(before, before)).toBe(true)
    expect(sameViewCarriers(before, proseOnly)).toBe(true)
    expect(sameViewCarriers(before, changed.join('\n'))).toBe(false)
    expect(parseViewDocument(before).blocks).toHaveLength(VIEW_DOCUMENT_LIMIT.blocks)
  })

  it('bounds cumulative YAML nodes and nesting before semantic composition', () => {
    const manyPairs = Array.from(
      { length: Math.floor(VIEW_DOCUMENT_LIMIT.yamlNodes / 2) + 32 },
      (_, index) => `key-${index}: value-${index}`,
    ).join('\n')
    const manyQuotedPairs = Array.from(
      { length: Math.floor(VIEW_DOCUMENT_LIMIT.yamlNodes / 2) + 32 },
      (_, index) => `"key-${index}": "value-${index}"`,
    ).join('\n')
    const manyComments = [
      board(),
      ...Array.from(
        { length: Math.floor(VIEW_DOCUMENT_LIMIT.yamlTokens / 2) + 32 },
        (_, index) => `# comment ${index}`,
      ),
    ].join('\n')
    const nested = [
      'version: 1',
      'source: { kind: notes }',
      'views: [{ name: Board, type: board }]',
      'extra:',
      ...Array.from(
        { length: VIEW_DOCUMENT_LIMIT.yamlDepth + 1 },
        (_, index) => `${'  '.repeat(index + 1)}level-${index}:`,
      ),
      `${'  '.repeat(VIEW_DOCUMENT_LIMIT.yamlDepth + 2)}value: true`,
    ].join('\n')

    for (const payload of [manyPairs, manyQuotedPairs, manyComments, nested]) {
      const parsed = parseViewDocument(`\`\`\`nota\n${payload}\n\`\`\``)

      expect(parsed.blocks[0]).toMatchObject({
        status: VIEW_BLOCK_STATUS.resourceLimit,
        views: [],
      })
      expect(parsed.blocks[0]?.yamlDocument).toBeUndefined()
      expect(parsed.primaryReader).toEqual({ kind: 'unproven' })
      expect(parsed.semanticContent).not.toContain(payload)
    }
  })

  it('stops later YAML work and clears all executable views at a cumulative reader limit', () => {
    const payload = (prefix: string, count: number) =>
      [
        'version: 1',
        'source: { kind: notes }',
        'views:',
        ...Array.from(
          { length: count },
          (_, index) => `  - { name: ${prefix}-${index}, type: board }`,
        ),
      ].join('\n')
    const carrier = (value: string) => `\`\`\`nota\n${value}\n\`\`\``
    const parsed = parseViewDocument(
      [
        carrier(payload('first', VIEW_DOCUMENT_LIMIT.views)),
        carrier(payload('overflow', 1)),
        carrier('version: ['),
      ].join('\n'),
    )

    expect(parsed.views).toEqual([])
    expect(parsed.blocks.map((block) => block.status)).toEqual([
      VIEW_BLOCK_STATUS.resourceLimit,
      VIEW_BLOCK_STATUS.resourceLimit,
      VIEW_BLOCK_STATUS.resourceLimit,
    ])
    expect(parsed.blocks.every((block) => block.yamlDocument === undefined)).toBe(true)
  })

  it('keeps YAML node references and duplicate semantic keys raw-readable but non-executable', () => {
    const raw = [
      '```nota',
      'version: 1',
      'source: &source',
      '  kind: notes',
      'views:',
      '  - name: Board',
      '    name: Duplicate',
      '    type: board',
      '```',
    ].join('\n')
    const parsed = parseViewDocument(raw)

    expect(parsed.blocks[0]?.status).toBe(VIEW_BLOCK_STATUS.readOnly)
    expect(parsed.blocks[0]?.views).toEqual([])
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['yaml-node-reference', 'duplicate-semantic-key']),
    )
    expect(raw).toContain('&source')
  })

  it('proves marker absence only when there is no nota fence', () => {
    expect(parseViewDocument('ordinary prose').primaryReader).toEqual({ kind: 'absent' })
    expect(parseViewDocument('```nota\nversion: [\n```').primaryReader).toEqual({
      kind: 'unproven',
    })
  })
})

describe('semanticViewContent', () => {
  it('is stable for config-only changes', () => {
    const first = `Prose\n\n\`\`\`nota\n${board()}\n\`\`\``
    const second = `Prose\n\n\`\`\`nota\n${board('      unknown: changed')}\n\`\`\``

    expect(semanticViewContent(first)).toBe(semanticViewContent(second))
  })

  it('derives the marker write channel without healing an unproven body', () => {
    expect(viewTypeForBody(`\`\`\`nota\n${board()}\n\`\`\``)).toBe('board')
    expect(viewTypeForBody('plain prose')).toBe('')
    expect(viewTypeForBody('```nota\nversion: [\n```')).toBeUndefined()
  })
})
