import { describe, expect, it } from 'vitest'
import type { RevisionView } from '../../libs/revisions'
import { canRestoreRevision, historyRowLabels } from './helpers'

const row = (over: Partial<RevisionView> = {}): RevisionView => ({
  revisionId: '7',
  noteId: 'note-1',
  kind: 'write',
  principal: 'ui',
  author: { kind: 'user', mine: true, name: 'me' },
  createdAt: '2026-08-11T10:00:00.000Z',
  contentHash: 'abc',
  stateFormat: 'markdown-v2',
  restoreAvailability: 'full',
  baseRevisionId: '6',
  sourceRevisionId: null,
  title: 'Carbon',
  charsAdded: 3,
  charsRemoved: 1,
  unavailableReason: null,
  ...over,
})

describe('historyRowLabels', () => {
  it('names neither the action nor the writer of a withheld row', () => {
    // The server WITHHELD this row rather than failing to capture it (#327), so
    // its null author must not be worded — "outside Notarium" is what a genuine
    // unsigned external edit earns, and it is the same sentence a real one gets.
    // canon: docs/note-history.md#model
    expect(
      historyRowLabels(
        row({
          kind: 'external',
          author: null,
          contentHash: null,
          unavailableReason: 'identity-conflict',
        }),
        undefined,
        'outside Notarium',
      ),
    ).toEqual({ kind: 'Unavailable', who: '', gap: true })
  })

  it('still words a real unsigned external edit as one', () => {
    expect(
      historyRowLabels(row({ kind: 'external', author: null }), undefined, 'outside Notarium'),
    ).toEqual({ kind: 'External change', who: 'outside Notarium', gap: false })
  })

  it('says the body is unknown only where a body was expected', () => {
    expect(historyRowLabels(row({ contentHash: null }), undefined, 'you').who).toBe(
      'you · body unknown',
    )
    // A delete has no body by construction — saying so would read as damage.
    expect(historyRowLabels(row({ kind: 'delete', contentHash: null }), undefined, 'you').who).toBe(
      'you',
    )
  })

  it('names a restore source only while it is in the loaded window', () => {
    expect(historyRowLabels(row({ kind: 'restore', sourceRevisionId: '3' }), 3, 'you').kind).toBe(
      'Restored from v3',
    )
    expect(
      historyRowLabels(row({ kind: 'restore', sourceRevisionId: '3' }), undefined, 'you').kind,
    ).toBe('Restored')
  })
})

describe('canRestoreRevision', () => {
  const ask = (over: Partial<Parameters<typeof canRestoreRevision>[0]> = {}) =>
    canRestoreRevision({
      revision: row({ restoreAvailability: 'full' }),
      restorable: true,
      bodyUnrestorable: false,
      isLatest: false,
      restoring: false,
      ...over,
    })

  it('offers restore for a complete copy this screen could read', () => {
    expect(ask()).toBe(true)
  })

  // The row says `full` because the journal's columns say so; only this screen has
  // asked for the body and been told the stored copy cannot be opened here.
  it('withdraws it when the body came back unreadable, despite a restorable row', () => {
    expect(ask({ bodyUnrestorable: true })).toBe(false)
  })

  it.each([
    ['gap', { revision: row({ restoreAvailability: 'gap' }) }],
    ['unreadable', { revision: row({ restoreAvailability: 'unreadable' }) }],
    ['the latest revision', { isLatest: true }],
    ['a host that cannot restore', { restorable: false }],
    ['a restore already in flight', { restoring: true }],
  ] as Array<[string, Partial<Parameters<typeof canRestoreRevision>[0]>]>)(
    'keeps it off for %s',
    (_name, over) => {
      expect(ask(over)).toBe(false)
    },
  )
})
