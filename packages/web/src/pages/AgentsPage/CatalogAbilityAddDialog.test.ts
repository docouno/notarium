// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeAgentSkillsResponse } from '@notarium/contract'
import { DialogProvider } from '../../core/Dialog'
import { CatalogAbilityAddDialog } from './CatalogAbilityAddDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Project = MeAgentSkillsResponse['projects'][number]

const project = (id: string, space: string): Project => ({
  id,
  handle: `${space}/${id}`,
  displayName: id,
  space,
  status: 'active',
})

// The library page asks for its cards owner-globally on purpose, so the list it
// hands over spans every readable Space while the destination names exactly one.
const acrossSpaces: Project[] = [project('here', 'alpha'), project('elsewhere', 'beta')]

describe('the Catalog add dialog offers only the destination Space’s projects', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const open = (kind: 'role' | 'skill') =>
    act(async () =>
      root.render(
        createElement(
          DialogProvider,
          null,
          createElement(CatalogAbilityAddDialog, {
            kind,
            name: 'reviewer',
            space: 'alpha',
            spaceAvailable: true,
            projects: acrossSpaces,
            onAdd: vi.fn(),
            onClose: vi.fn(),
          }),
        ),
      ),
    )

  const pickShared = async () => {
    const shared = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Project' || button.textContent === 'Space',
    )!

    await act(async () => shared.click())
  }

  it('lists no project of another Space in the role destination', async () => {
    await open('role')
    await pickShared()

    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-add-project"]',
    )!

    await act(async () => trigger.click())

    const offered = [...document.querySelectorAll('[role="menuitemradio"]')].map(
      (row) => row.textContent,
    )

    expect(offered).toContain('here')
    expect(offered).not.toContain('elsewhere')
  })

  it('offers no project of another Space to tick as a skill’s reach', async () => {
    await open('skill')
    await pickShared()

    const allProjects = document.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-add-all-projects"]',
    )!

    await act(async () => allProjects.click())

    expect(
      document.querySelector('[data-testid="ability-availability-project-here"]'),
    ).not.toBeNull()
    expect(
      document.querySelector('[data-testid="ability-availability-project-elsewhere"]'),
    ).toBeNull()
  })
})
