import { describe, expect, it, vi } from 'vitest'

import {
  analyzeDocumentState,
  DOCUMENT_ROLE,
  type DocumentRole,
  frontmatterEntryValue,
  parseFrontmatterLines,
} from '../markdown'
import { FIELD_WRITE_ERROR_REASON } from './consts'
import {
  applyFieldPatchEntries,
  assertFieldPatchWritable,
  fieldPatchChangesEntries,
  fieldPatchEmissions,
} from './write'

const state = (yaml: string, role: DocumentRole = DOCUMENT_ROLE.generic) =>
  analyzeDocumentState({
    source: new TextEncoder().encode(`---\n${yaml}\n---\n\n# Note\n`),
    role,
    pathFallbackTitle: 'Note',
    ...(role === DOCUMENT_ROLE.skillRoot ? { skillDirectoryName: 'note' } : {}),
  })

describe('field write contract', () => {
  it('emits patch values without coercion and honours only safe unquoted scalars', () => {
    const fields = Object.create(null) as Record<string, string | string[] | null>
    fields.priority = '3'
    fields.bad = 'a: b'
    fields.reviewers = ['a', 'b']
    fields.empty = []
    fields.remove = null
    fields.__proto__ = '7'

    expect(fieldPatchEmissions(fields, ['priority', 'bad', '__proto__'])).toEqual([
      { key: 'priority', entry: { key: 'priority', lines: ['priority: 3'] } },
      { key: 'bad', entry: { key: 'bad', lines: ['bad: "a: b"'] } },
      { key: 'reviewers', entry: { key: 'reviewers', lines: ['reviewers:', '- a', '- b'] } },
      { key: 'empty', entry: { key: 'empty', lines: ['empty: []'] } },
      { key: 'remove' },
      { key: '__proto__', entry: { key: '__proto__', lines: ['__proto__: 7'] } },
    ])
  })

  it('patches in place, removes all duplicates and appends only new keys', () => {
    const before = parseFrontmatterLines('a: old\nb: keep\na: duplicate')
    const after = applyFieldPatchEntries(before, fieldPatchEmissions({ a: 'new', b: null, c: '' }))

    expect(after.map((entry) => entry.lines)).toEqual([['a: new'], ['c: ""']])
  })

  it('applies a large patch without a nested full-array scan', () => {
    const before = parseFrontmatterLines(
      Array.from({ length: 200 }, (_, index) => `k${index}: old`).join('\n'),
    )
    const patch = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`k${index}`, `new-${index}`]),
    )
    const flatMap = vi.spyOn(Array.prototype, 'flatMap')

    const after = applyFieldPatchEntries(before, fieldPatchEmissions(patch))
    const nestedScans = flatMap.mock.calls.length
    flatMap.mockRestore()

    expect(after).toHaveLength(200)
    expect(after[199].lines).toEqual(['k199: new-199'])
    expect(nestedScans).toBe(0)
  })

  it('rejects protected, unreadable, duplicate and unsafe targets with typed reasons', () => {
    expect(() => assertFieldPatchWritable({ tags: 'x' }, state('title: Note\ntags: old'))).toThrow(
      expect.objectContaining({ reason: FIELD_WRITE_ERROR_REASON.protectedFieldKey }),
    )
    expect(() => assertFieldPatchWritable({ k: 'x' }, state('title: Note\nk: {a: 1}'))).toThrow(
      expect.objectContaining({ reason: FIELD_WRITE_ERROR_REASON.unreadableFieldValue }),
    )
    expect(() => assertFieldPatchWritable({ k: 'x' }, state('title: Note\nk: a\nk: b'))).toThrow(
      expect.objectContaining({ reason: FIELD_WRITE_ERROR_REASON.duplicateFieldKey }),
    )
    expect(() => assertFieldPatchWritable({ k: 'x' }, state('title: [broken'))).toThrow(
      expect.objectContaining({
        reason: `${FIELD_WRITE_ERROR_REASON.unsafeDocument}:invalid-yaml`,
      }),
    )
  })

  it('refuses even an equal patch when frontmatter contains YAML node references', () => {
    expect(() =>
      assertFieldPatchWritable({ status: 'doing' }, state('base: &base x\nstatus: doing')),
    ).toThrow(expect.objectContaining({ reason: FIELD_WRITE_ERROR_REASON.yamlNodeReference }))
  })

  it('validates a large patch without rescanning the entry array for every key', () => {
    const current = state(Array.from({ length: 1_000 }, (_, index) => `k${index}: old`).join('\n'))
    const patch = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`k${index}`, `new-${index}`]),
    )
    const filter = vi.spyOn(Array.prototype, 'filter')
    const find = vi.spyOn(Array.prototype, 'find')

    assertFieldPatchWritable(patch, current)
    const filterCalls = filter.mock.calls.length
    const findCalls = find.mock.calls.length
    filter.mockRestore()
    find.mockRestore()

    expect(filterCalls).toBe(0)
    expect(findCalls).toBe(0)
  })

  it('detects large-patch changes from one entry index instead of per-key searches', () => {
    const entries = parseFrontmatterLines(
      Array.from({ length: 1_000 }, (_, index) => `k${index}: old`).join('\n'),
    )
    const patch = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`k${index}`, index === 999 ? 'new' : 'old']),
    )
    const find = vi.spyOn(Array.prototype, 'find')

    expect(fieldPatchChangesEntries(patch, entries)).toBe(true)
    const findCalls = find.mock.calls.length
    find.mockRestore()
    expect(findCalls).toBe(0)
  })

  it('protects skill manifest identity without reserving those keys globally', () => {
    const skill = state(
      'name: note\ndescription: Original\nmetadata:\n  notarium:\n    kind: skill',
      DOCUMENT_ROLE.skillRoot,
    )

    expect(() => assertFieldPatchWritable({ name: 'other' }, skill)).toThrow(
      expect.objectContaining({ reason: FIELD_WRITE_ERROR_REASON.protectedFieldKey }),
    )
    expect(() => assertFieldPatchWritable({ description: 'other' }, skill)).toThrow(
      expect.objectContaining({ reason: FIELD_WRITE_ERROR_REASON.protectedFieldKey }),
    )
    expect(() =>
      assertFieldPatchWritable({ description: 'ordinary' }, state('title: Note')),
    ).not.toThrow()
  })

  it('keeps a readable complex neighbour byte-shaped while patching another key', () => {
    const current = state('title: Note\nk: {a: 1}\nb: old')
    assertFieldPatchWritable({ b: 'new' }, current)
    const k = current.projection?.frontmatterEntries.find((entry) => entry.key === 'k')

    expect(k && frontmatterEntryValue(k)).toBeNull()
    expect(k?.lines).toEqual(['k: {a: 1}'])
  })
})
