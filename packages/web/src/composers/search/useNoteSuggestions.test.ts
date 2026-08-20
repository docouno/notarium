// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbilityLocator } from '@notarium/contract'

import type * as ApiModule from '../../services/api'

const harness = vi.hoisted(() => ({
  notesGet: vi.fn(),
  searchGet: vi.fn(),
}))

vi.mock('../../services/api', async (importOriginal) => {
  const real = await importOriginal<typeof ApiModule>()

  return {
    ...real,
    api: { ...real.api, notesGet: harness.notesGet, searchGet: harness.searchGet },
  }
})

import { pushRecentNote } from '../../libs/recentNotes'
import { agentAbilityRoute } from '../../libs/routing/routePaths'
import { type NoteSuggestions, useNoteSuggestions } from './useNoteSuggestions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The quick-jump data layer is the second link of the Owned Ability MRU chain
// (#309 pt.13): AbilityDetailPage records the package's EXACT shell route, and this
// hook is the only thing standing between that record and the two chromes that
// navigate. It normalises titles and lets the server's recently-modified page top
// up thin rows — both of which read a note-shaped row and could quietly drop the
// one field that says "this document is not addressed by /n/<id>". Nothing else
// can recover it: the id alone can only rebuild the generic reader route.

const locator: AbilityLocator = {
  source: 'owned',
  kind: 'role',
  packageId: 'Reviewer1234',
  location: { scope: 'space', spaceId: 'space-team' },
}
const abilityHref = agentAbilityRoute(locator)
const ABILITY_NOTE_ID = 'ability-note-1'

const probed: NoteSuggestions[] = []

const Probe = ({ space, query }: { space: string; query: string }) => {
  probed.push(useNoteSuggestions(space, query))
  return null
}

const noteRow = (over: Record<string, unknown> = {}) => ({
  id: 'plain-1',
  title: 'Plain Note',
  filePath: 'plain.md',
  slug: 'plain-note',
  modifiedAt: null,
  createdAt: null,
  ...over,
})

describe('useNoteSuggestions carries an Owned Ability exact route', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    probed.length = 0
    harness.notesGet.mockReset()
    harness.searchGet.mockReset()
    harness.notesGet.mockResolvedValue({ notes: [] })
    harness.searchGet.mockResolvedValue([])
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = async (space = 'team', query = '') => {
    await act(async () => root.render(createElement(Probe, { space, query })))
    await act(async () => {
      await Promise.resolve()
    })

    return probed[probed.length - 1]
  }

  it('hands the recorded shell route to the chromes, alongside plain notes', async () => {
    pushRecentNote('team', {
      kind: 'note',
      id: 'plain-1',
      title: 'Plain Note',
      slug: 'plain-note',
      filePath: 'plain.md',
      modifiedAt: null,
      createdAt: null,
    })
    pushRecentNote('team', {
      kind: 'owned-ability',
      id: ABILITY_NOTE_ID,
      title: 'Reviewer',
      noteType: 'Role',
      href: abilityHref,
      modifiedAt: null,
      createdAt: null,
    })

    const suggestions = await render()

    expect(suggestions.recent.map((r) => r.id)).toEqual([ABILITY_NOTE_ID, 'plain-1'])
    // The ability's exact route survives the hop…
    expect(suggestions.recent[0].href).toBe(abilityHref)
    // …and a generic note still has none, so its consumer derives /n/<id> itself.
    expect(suggestions.recent[1].href).toBeUndefined()
  })

  it('keeps the exact route when the server row for the same note tops it up', async () => {
    pushRecentNote('team', {
      kind: 'owned-ability',
      id: ABILITY_NOTE_ID,
      title: 'Reviewer',
      href: abilityHref,
      modifiedAt: null,
      createdAt: null,
    })
    // The package's document is a note like any other, so the recently-modified
    // backfill can carry the very same id. It refreshes the label — it must not
    // decide where the row leads.
    harness.notesGet.mockResolvedValue({
      notes: [
        noteRow({
          id: ABILITY_NOTE_ID,
          title: 'Reviewer (server title)',
          slug: 'reviewer',
          filePath: 'agents/roles/reviewer.md',
        }),
      ],
    })

    const suggestions = await render()

    expect(suggestions.recent).toHaveLength(1)
    expect(suggestions.recent[0]).toMatchObject({
      id: ABILITY_NOTE_ID,
      title: 'Reviewer (server title)',
      href: abilityHref,
    })
  })
})
