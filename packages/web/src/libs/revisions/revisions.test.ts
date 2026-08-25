import { describe, expect, it } from 'vitest'
import type { NoteRevision } from '@notarium/contract'
import { recoveryPresentation, revisionDetailView, revisionView } from './revisions'

describe('recoveryPresentation', () => {
  it.each([
    ['full', 'complete', 'Ready to restore'],
    ['partial', 'partial', 'Partial restore'],
    ['opaque', 'source-only', 'Source only'],
    ['blocked', 'source-only', 'Source only'],
    ['unknown', 'source-only', 'Source only'],
    ['gap', 'record-only', 'No copy'],
    ['unreadable', 'record-only', 'Unreadable copy'],
    ['capability-unavailable', 'host-unavailable', 'Restore unavailable'],
  ] as Array<[NoteRevision['restoreAvailability'], string, string]>)(
    '%s is a user outcome, not an internal enum',
    (availability, kind, label) => {
      expect(recoveryPresentation(availability)).toMatchObject({ kind, label })
      expect(recoveryPresentation(availability).reason.length).toBeGreaterThan(20)
    },
  )

  it('does not tell a person their copy is gone when it is merely unreadable here', () => {
    expect(recoveryPresentation('unreadable').reason).not.toBe(recoveryPresentation('gap').reason)
    expect(recoveryPresentation('unreadable').reason).toMatch(/saved/i)
  })
})

const wire = (over: Partial<NoteRevision> = {}): NoteRevision => ({
  revisionId: '7',
  noteId: 'note-1',
  kind: 'external',
  principal: null,
  author: null,
  createdAt: '2026-08-11T10:00:00.000Z',
  contentHash: null,
  stateFormat: null,
  restoreAvailability: 'gap',
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
      contentMode: 'gap',
      content: null,
      snapshot: null,
      tags: [],
    })

    expect(detail).toMatchObject({ unavailableReason: 'identity-conflict', content: null })
  })
})
