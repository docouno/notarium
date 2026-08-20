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
vi.mock('../SpaceProvider', () => ({ useSpace: () => ({ space: 'team' }) }))
vi.mock('../../services/api', async (importOriginal) => {
  const real = await importOriginal<typeof ApiModule>()

  return {
    ...real,
    api: { ...real.api, notesGet: harness.notesGet, searchGet: harness.searchGet },
  }
})

import { pushRecentNote } from '../../libs/recentNotes'
import { agentAbilityRoute } from '../../libs/routing/routePaths'
import { OmniSearch } from './OmniSearch'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The topbar's half of #309 pt.13. OmniSearch shares the recents pool with Cmd+P but
// owns its OWN route decision, so "Spotlight is covered" says nothing here: the two
// surfaces have drifted before, which is why #190 fused their data layer and not
// their chrome. Same regress if it drops the recorded route — an Owned Ability picked
// from Recent lands in the generic `/n/<id>` reader instead of the Agents shell.

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

describe('OmniSearch opens an Owned Ability in the canonical shell', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    harness.navigate.mockReset()
    harness.notesGet.mockReset().mockResolvedValue({ notes: [] })
    harness.searchGet.mockReset().mockResolvedValue([])
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  // The field is idle until focused (it is mounted on every page's topbar), so the
  // dropdown only exists after the user opens it.
  const openDropdown = async () => {
    await act(async () => root.render(createElement(OmniSearch, {})))
    const input = container.querySelector<HTMLInputElement>('[data-testid="omni-search"]')!

    await act(async () => {
      input.focus()
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    return input
  }

  const rowFor = (id: string): HTMLElement => {
    const row = container.querySelector<HTMLElement>(`[data-testid="omni-result"][data-id="${id}"]`)
    expect(row, `no Recent row for ${id}`).not.toBeNull()

    return row as HTMLElement
  }

  it('routes a Recent Owned Ability click to its exact route, never to /n/<id>', async () => {
    recordAbilityVisit()
    await openDropdown()

    await act(async () => {
      rowFor(ABILITY_NOTE_ID).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(harness.navigate).toHaveBeenCalledWith(abilityHref)
    expect(harness.navigate).not.toHaveBeenCalledWith(expect.stringContaining('/n/'))
  })

  it('routes the same row the same way when Enter picks it from the keyboard', async () => {
    recordAbilityVisit()
    const input = await openDropdown()

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(harness.navigate).toHaveBeenCalledWith(abilityHref)
    expect(harness.navigate).not.toHaveBeenCalledWith(expect.stringContaining('/n/'))
  })

  it('opens the exact route in a new tab too, so the modifier is not a back door', async () => {
    recordAbilityVisit()
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null)
    await openDropdown()

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
    await openDropdown()

    await act(async () => {
      rowFor('plain-1').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(harness.navigate).toHaveBeenCalledWith('/n/plain-1/plain-note')
  })
})
