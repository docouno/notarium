import { describe, expect, it } from 'vitest'

import {
  isDurableScalar,
  isDurableText,
  isGeneratedNoteId,
  isValidNoteId,
  isWellFormedUnicode,
} from './id'

describe('durable string guards', () => {
  it('rejects isolated surrogates but accepts complete pairs', () => {
    expect(isWellFormedUnicode(String.fromCharCode(0xd800))).toBe(false)
    expect(isWellFormedUnicode(String.fromCharCode(0xdc00))).toBe(false)
    expect(isWellFormedUnicode('a😀z')).toBe(true)
  })

  it('separates multiline Markdown from durable single-line scalars', () => {
    expect(isDurableText('line one\n\tline two')).toBe(true)
    expect(isDurableScalar('line one\nline two')).toBe(false)
    expect(isDurableScalar(`left${String.fromCharCode(0x2028)}right`)).toBe(false)
    expect(isDurableText(`left\0right`)).toBe(false)
    expect(isValidNoteId('opaque.id-1')).toBe(true)
    expect(isValidNoteId('notarium-id:foo')).toBe(true)
    expect(isValidNoteId('notarium-id:%zz')).toBe(true)
    expect(isValidNoteId('')).toBe(false)
  })

  it('separates generated storage ids from the wider opaque id domain', () => {
    expect(isGeneratedNoteId('AbCdefGhij_1')).toBe(true)
    expect(isGeneratedNoteId('A__________-')).toBe(true)
    expect(isGeneratedNoteId('opaque.id-1')).toBe(false)
    expect(isGeneratedNoteId('notarium-id:foo')).toBe(false)
    expect(isGeneratedNoteId('_projects')).toBe(false)
  })
})
