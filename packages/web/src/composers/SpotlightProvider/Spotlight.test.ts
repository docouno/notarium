// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbilityLocator } from '@notarium/contract'

import type * as ApiModule from '../../services/api'

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  notesGet: vi.fn(),
  searchGet: vi.fn(),
}))

vi.mock('react-router', () => ({ useNavigate: () => harness.navigate }))
vi.mock('../../services/api', async (importOriginal) => {
  const real = await importOriginal<typeof ApiModule>()

  return {
    ...real,
    api: { ...real.api, notesGet: harness.notesGet, searchGet: harness.searchGet },
  }
})

import { pushRecentNote } from '../../libs/recentNotes'
import { agentAbilityRoute } from '../../libs/routing/routePaths'
import { Spotlight } from './Spotlight'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The quick-switcher's half of #309 pt.13, end to end over the REAL chain: the row
// AbilityDetailPage wrote to the MRU, through useNoteSuggestions, into what Cmd+P
// actually navigates to. An Owned Ability's document is a `skill`-class package —
// `/n/<id>` renders it in the generic reader, so a dropped route here is not a
// cosmetic downgrade but the exact regress pt.13 forbids: the user picks the Role
// they just left and lands outside the Agents shell. Nothing downstream can repair
// it, because the id alone only ever rebuilds `/n/<id>`.

const locator: AbilityLocator = {
  source: 'owned',
  kind: 'role',
  packageId: 'Reviewer1234',
  location: { scope: 'space', spaceId: 'space-team' },
}
const abilityHref = agentAbilityRoute(locator)
const ABILITY_NOTE_ID = 'ability-note-1'

const recordAbilityVisit = () =>
  pushRecentNote('team', {
    kind: 'owned-ability',
    id: ABILITY_NOTE_ID,
    title: 'Reviewer',
    noteType: 'Role',
    href: abilityHref,
    modifiedAt: null,
    createdAt: null,
  })

const recordNoteVisit = () =>
  pushRecentNote('team', {
    kind: 'note',
    id: 'plain-1',
    title: 'Plain Note',
    slug: 'plain-note',
    filePath: 'plain.md',
    modifiedAt: null,
    createdAt: null,
  })

describe('Spotlight opens an Owned Ability in the canonical shell', () => {
  let container: HTMLDivElement
  let root: Root
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    harness.navigate.mockReset()
    harness.notesGet.mockReset().mockResolvedValue({ notes: [] })
    harness.searchGet.mockReset().mockResolvedValue([])
    onClose = vi.fn()
    // jsdom has no layout, so the "keep the highlighted row in view" effect would
    // throw on a method it does not implement.
    Element.prototype.scrollIntoView = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  const open = async () => {
    await act(async () => root.render(createElement(Spotlight, { space: 'team', onClose })))
    await act(async () => {
      await Promise.resolve()
    })
  }

  const rowFor = (id: string): HTMLElement => {
    const row = document.querySelector<HTMLElement>(
      `[data-testid="spotlight-result"][data-id="${id}"]`,
    )
    expect(row, `no Recent row for ${id}`).not.toBeNull()

    return row as HTMLElement
  }

  it('routes a Recent Owned Ability click to its exact route, never to /n/<id>', async () => {
    recordAbilityVisit()
    await open()

    await act(async () => {
      rowFor(ABILITY_NOTE_ID).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(harness.navigate).toHaveBeenCalledWith(abilityHref)
    expect(harness.navigate).not.toHaveBeenCalledWith(expect.stringContaining('/n/'))
    expect(onClose).toHaveBeenCalled()
  })

  it('routes the same row the same way when Enter picks it from the keyboard', async () => {
    recordAbilityVisit()
    await open()
    const input = document.querySelector<HTMLInputElement>('[data-testid="spotlight-input"]')!

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(harness.navigate).toHaveBeenCalledWith(abilityHref)
    expect(harness.navigate).not.toHaveBeenCalledWith(expect.stringContaining('/n/'))
  })

  it('opens the exact route in a new tab too, so the modifier is not a back door', async () => {
    recordAbilityVisit()
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null)
    await open()

    await act(async () => {
      rowFor(ABILITY_NOTE_ID).dispatchEvent(
        new MouseEvent('click', { bubbles: true, metaKey: true }),
      )
    })

    expect(openWindow).toHaveBeenCalledWith(abilityHref, '_blank', 'noopener,noreferrer')
    expect(harness.navigate).not.toHaveBeenCalled()
  })

  it('still derives /n/<id>/<slug> for a generic note in the same list', async () => {
    recordNoteVisit()
    recordAbilityVisit()
    await open()

    await act(async () => {
      rowFor('plain-1').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(harness.navigate).toHaveBeenCalledWith('/n/plain-1/plain-note')
  })
})
