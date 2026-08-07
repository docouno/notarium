import { describe, expect, it } from 'vitest'

import type { NoteDetailView } from '../../../../libs/wire'
import { rekeyedNoteRoute } from './useNotesState'

const note = (id: string): NoteDetailView => ({
  id,
  title: 'Durable Target',
  filePath: 'target.md',
  content: 'target',
  frontmatter: {},
  versionToken: 'v1',
})

describe('rekeyedNoteRoute', () => {
  it('replaces a cold provisional URL with the durable id returned for that request', () => {
    expect(rekeyedNoteRoute('/n/provisional', 'provisional', note('durable-id'))).toBe(
      '/n/durable-id/durable-target',
    )
  })

  it('never rewrites an unrelated route after navigation moved on', () => {
    expect(rekeyedNoteRoute('/n/next', 'provisional', note('durable-id'))).toBeNull()
  })

  it('leaves an already-stable identity to NotePage slug canonicalization', () => {
    expect(rekeyedNoteRoute('/n/durable-id', 'durable-id', note('durable-id'))).toBeNull()
  })
})
