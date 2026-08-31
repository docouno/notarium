// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { loadRecentNotes, pushRecentNote, recentNotesBucket } from './recentNotes'

const spaces = [
  { id: 'space-1', slug: 'team' },
  { id: 'space-2', slug: 'lab' },
  { id: 'personal-1', slug: 'ada' },
]

describe('recent notes bucket', () => {
  it('keys a document by the space it lives in, not by the one being browsed', () => {
    expect(recentNotesBucket('space-2', spaces, 'team')).toBe('lab')
  })

  it('falls back to the active space when the home is unknown', () => {
    expect(recentNotesBucket('space-9', spaces, 'team')).toBe('team')
    expect(recentNotesBucket(null, spaces, 'team')).toBe('team')
    expect(recentNotesBucket(undefined, spaces, 'team')).toBe('team')
  })

  it('reaches the personal domain like any other space', () => {
    expect(recentNotesBucket('personal-1', spaces, 'team')).toBe('ada')
  })
})

// One slot, two writers. An Owned Ability's document is an ordinary note as well:
// the reader's open chokepoint (NotesProvider) records every note it shows as a
// plain `note` row, with no route beyond `/n/<id>` — it holds no locator and cannot
// mint one. The MRU dedupes by id, so that second writer lands on the SAME slot the
// ability page wrote, and the exact route is not recoverable from anything left in
// it. Only this module sees both writes, so only here can the more specific address
// outlive the less specific one.
describe('recent notes keep the most specific address known for a document', () => {
  const abilityHref = '/agents/abilities/roles/owned/eyJhIjoxfQ'

  beforeEach(() => localStorage.clear())

  const visitAbility = () =>
    pushRecentNote('team', {
      kind: 'owned-ability',
      id: 'note-1',
      title: 'Reviewer',
      noteType: 'Role',
      href: abilityHref,
      modifiedAt: null,
      createdAt: null,
    })

  const openInReader = (over: Partial<Parameters<typeof pushRecentNote>[1]> = {}) =>
    pushRecentNote('team', {
      kind: 'note',
      id: 'note-1',
      title: 'Reviewer',
      slug: 'reviewer',
      filePath: 'agents/roles/reviewer.md',
      viewType: 'board',
      modifiedAt: '2026-08-18T10:00:00.000Z',
      createdAt: null,
      ...over,
    })

  it('does not let the generic reader downgrade an ability row to /n/<id>', () => {
    visitAbility()
    openInReader()

    const [row, ...rest] = loadRecentNotes('team')

    expect(rest).toHaveLength(0)
    expect(row.href).toBe(abilityHref)
    expect(row.kind).toBe('owned-ability')
    // Everything the newer visit actually knows better still wins.
    expect(row).toMatchObject({
      filePath: 'agents/roles/reviewer.md',
      slug: 'reviewer',
      modifiedAt: '2026-08-18T10:00:00.000Z',
      viewType: 'board',
    })
  })

  it('lets a newer exact route replace an older one for the same document', () => {
    visitAbility()
    pushRecentNote('team', {
      kind: 'owned-ability',
      id: 'note-1',
      title: 'Reviewer',
      href: '/agents/abilities/roles/owned/moved',
      modifiedAt: null,
      createdAt: null,
    })

    expect(loadRecentNotes('team')[0].href).toBe('/agents/abilities/roles/owned/moved')
  })

  it('keeps a plain note plain — nothing is carried onto a row that never had it', () => {
    openInReader({ id: 'note-2' })

    expect(loadRecentNotes('team')[0]).toMatchObject({ kind: 'note' })
    expect(loadRecentNotes('team')[0].href).toBeUndefined()
  })
})
