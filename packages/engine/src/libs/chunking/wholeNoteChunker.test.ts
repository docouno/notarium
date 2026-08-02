import { describe, expect, it } from 'vitest'

import { CHUNK_CHAR_BUDGET, createWholeNoteChunker } from './index'

describe('wholeNoteChunker', () => {
  const chunker = createWholeNoteChunker()

  it('carries a stable version (part of the embedding key, P13)', () => {
    expect(chunker.version).toBe('whole-v1')
  })

  it('produces exactly one chunk with the title leading the body', () => {
    const chunks = chunker.chunk({ title: 'Borscht', body: 'A beet soup.' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].index).toBe(0)
    expect(chunks[0].text).toBe('Borscht\n\nA beet soup.')
  })

  it('emits nothing for an empty note (nothing to embed)', () => {
    expect(chunker.chunk({ title: '', body: '' })).toEqual([])
    expect(chunker.chunk({ title: '  ', body: '\n\t' })).toEqual([])
  })

  it('folds in just the title or just the body when the other is empty', () => {
    expect(chunker.chunk({ title: 'Solo', body: '' })[0].text).toBe('Solo')
    expect(chunker.chunk({ title: '', body: 'just prose' })[0].text).toBe('just prose')
  })

  it('truncates an over-budget note to the model window', () => {
    const body = 'x'.repeat(CHUNK_CHAR_BUDGET * 2)
    const chunks = chunker.chunk({ title: 'T', body })
    expect(chunks[0].text.length).toBe(CHUNK_CHAR_BUDGET)
  })

  it('is deterministic — same input, same chunks (content_hash relies on it)', () => {
    const input = { title: 'A', body: 'B' }
    expect(chunker.chunk(input)).toEqual(chunker.chunk(input))
  })
})
