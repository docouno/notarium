import { describe, expect, it } from 'vitest'
import type { NoteRevision } from '@notarium/contract'
import { revisionDetailView, revisionView } from './revisions'

const wire = (over: Partial<NoteRevision> = {}): NoteRevision => ({
  revisionId: '7',
  noteId: 'note-1',
  kind: 'external',
  principal: null,
  author: null,
  createdAt: '2026-08-11T10:00:00.000Z',
  contentHash: null,
  baseRev: null,
  theirRev: null,
  sourceRev: null,
  title: 'Unavailable revision',
  charsAdded: null,
  charsRemoved: null,
  ...over,
})

describe('revisionView', () => {
  it('carries the withheld marker so the UI can tell a gap from an unsigned edit', () => {
    // Both rows arrive with `author: null`. Only one of them was withheld (#327);
    // dropping the marker here is what let the timeline word both as "outside
    // Notarium". canon: docs/note-history.md#model
    expect(revisionView(wire({ unavailableReason: 'identity-conflict' }))).toMatchObject({
      unavailableReason: 'identity-conflict',
    })
    expect(revisionView(wire())).toMatchObject({ unavailableReason: null })
  })

  it('keeps the detail view a superset of the row', () => {
    const detail = revisionDetailView({
      ...wire({ unavailableReason: 'identity-conflict' }),
      content: null,
      tags: [],
    })

    expect(detail).toMatchObject({ unavailableReason: 'identity-conflict', content: null })
  })
})
