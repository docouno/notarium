import { describe, expect, it } from 'vitest'
import type { Draft } from '../../../../composers/EditingProvider/useNoteDraft'
import type { AbilityDraftRecord } from '../../../../libs/abilityDraftStorage'
import { abilityDraftSessionOf, abilityDraftSignature, abilityDraftSync } from './abilityDraftSync'

const record = (draftId: string, instructions: string): AbilityDraftRecord => ({
  version: 1,
  owner: '@ada',
  draftId,
  kind: 'role',
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: '2026-08-18T09:01:00.000Z',
  authoredDraft: { name: 'captain', description: '', instructions, attachments: [] },
  creationSettings: {
    home: 'personal',
    space: 'team',
    availability: 'all-projects',
    projects: [],
  },
})

const draftOf = (session: Draft['abilityDraft']): Draft => ({
  isNew: true,
  documentKind: 'ability',
  abilityKind: 'role',
  abilityDraft: session,
  slug: '',
  directory: '',
  content: '# ',
  tags: [],
  noteType: 'note',
  createdAt: null,
})

describe('ability draft persistence', () => {
  it('refuses to file the open body under the draft id the route just moved to', () => {
    // The route is already on B; the editing session (and therefore the body the
    // editor is holding) is still A's, because the provider clears it one effect later.
    const live = draftOf({ owner: '@ada', draftId: 'draft-a', restored: false })

    expect(abilityDraftSessionOf(live, '@ada', 'draft-b')).toBeNull()
    expect(
      abilityDraftSync({
        session: abilityDraftSessionOf(live, '@ada', 'draft-b'),
        dirty: true,
        written: null,
        build: () => record('draft-b', 'the body of draft A'),
      }),
    ).toEqual({ kind: 'idle' })
  })

  it('writes for the session the route agrees with', () => {
    const live = draftOf({ owner: '@ada', draftId: 'draft-b', restored: false })
    const next = record('draft-b', 'its own body')

    expect(
      abilityDraftSync({
        session: abilityDraftSessionOf(live, '@ada', 'draft-b'),
        dirty: true,
        written: null,
        build: () => next,
      }),
    ).toEqual({ kind: 'write', record: next, signature: abilityDraftSignature(next) })
  })

  it('keeps a restored draft the user has not edited since it came back', () => {
    expect(
      abilityDraftSync({
        session: { owner: '@ada', draftId: 'draft-a', restored: true },
        dirty: false,
        written: null,
        build: () => record('draft-a', 'restored text'),
      }),
    ).toEqual({ kind: 'idle' })
  })

  it('removes the record of a fresh draft the user emptied again', () => {
    expect(
      abilityDraftSync({
        session: { owner: '@ada', draftId: 'draft-a', restored: false },
        dirty: false,
        written: 'a-signature',
        build: () => record('draft-a', ''),
      }),
    ).toEqual({ kind: 'remove', owner: '@ada', draftId: 'draft-a' })
  })

  it('does not rewrite an unchanged record', () => {
    const same = record('draft-a', 'unchanged')

    expect(
      abilityDraftSync({
        session: { owner: '@ada', draftId: 'draft-a', restored: true },
        dirty: true,
        written: abilityDraftSignature({ ...same, updatedAt: '2026-08-18T10:00:00.000Z' }),
        build: () => same,
      }),
    ).toEqual({ kind: 'idle' })
  })

  it('ignores a session belonging to another owner', () => {
    const live = draftOf({ owner: '@grace', draftId: 'draft-a', restored: false })

    expect(abilityDraftSessionOf(live, '@ada', 'draft-a')).toBeNull()
  })
})
