// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeAgentSkillsResponse } from '@notarium/contract'
import { DialogProvider } from '../../core/Dialog'
import { CatalogAbilityAddDialog, type CatalogInstallAvailability } from './CatalogAbilityAddDialog'

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

/** A host that can publish everywhere the listing offers. Spelled out rather than
 *  defaulted: the field is what a target IS offered by, so a case that forgot it
 *  would prove the opposite of what it reads. */
const rolesEverywhere: CatalogInstallAvailability = {
  personal: true,
  projects: { 'alpha/here': true, 'beta/elsewhere': true },
}
const skillsEverywhere: CatalogInstallAvailability = {
  personal: true,
  spaces: { alpha: true, beta: true },
}

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

  const open = async (
    kind: 'role' | 'skill',
    install?: CatalogInstallAvailability,
    onAdd = vi.fn(),
    onClose = vi.fn(),
  ) => {
    const render = async (nextInstall: CatalogInstallAvailability | undefined) => {
      await act(async () =>
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
              install: nextInstall,
              onAdd,
              onClose,
            }),
          ),
        ),
      )
    }
    await render(install)
    return { onAdd, onClose, render }
  }

  const projectOptions = async () => {
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-add-project"]',
    )!

    await act(async () => trigger.click())

    return [...document.querySelectorAll('[role="menuitemradio"]')].map((row) => row.textContent)
  }

  const destination = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === label,
    )!

  const pickShared = async () => {
    const shared = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Project' || button.textContent === 'Space',
    )!

    await act(async () => shared.click())
  }

  it('lists no project of another Space in the role destination', async () => {
    await open('role', rolesEverywhere)
    await pickShared()

    const offered = await projectOptions()

    expect(offered).toContain('here')
    expect(offered).not.toContain('elsewhere')
  })

  it('offers no project this host cannot publish a role into', async () => {
    await open('role', { personal: true, projects: { 'alpha/here': false } })
    await pickShared()

    // The Project destination itself has nothing left to select, so the segment is
    // closed rather than opening onto an empty list.
    expect(destination('Project').disabled).toBe(true)
    expect(document.querySelector('[data-testid="catalog-add-project"]')).toBeNull()
  })

  it('cannot submit a selected project after refreshed availability removes it', async () => {
    const onAdd = vi.fn()
    const { render } = await open('role', rolesEverywhere, onAdd)
    await pickShared()

    const submit = document.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-ability-add-dialog-submit"]',
    )!
    expect(submit.disabled).toBe(false)

    await render({ personal: true, projects: { 'alpha/here': false } })

    expect(destination('Project').disabled).toBe(true)
    expect(document.querySelector('[data-testid="catalog-add-project"]')).toBeNull()
    expect(submit.disabled).toBe(true)

    await act(async () => submit.click())
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('cannot submit a shared skill after refreshed availability removes its space', async () => {
    const onAdd = vi.fn()
    const { render } = await open('skill', skillsEverywhere, onAdd)
    await pickShared()

    const submit = document.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-ability-add-dialog-submit"]',
    )!
    expect(submit.disabled).toBe(false)

    await render({ personal: true, spaces: { alpha: false } })

    expect(destination('Space').disabled).toBe(true)
    expect(document.querySelector('[data-testid="catalog-add-all-projects"]')).toBeNull()
    expect(submit.disabled).toBe(true)

    await act(async () => submit.click())
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('starts on the shared destination when Personal is unavailable', async () => {
    await open('role', { personal: false, projects: { 'alpha/here': true } })

    expect(destination('Personal').disabled).toBe(true)
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="catalog-ability-add-dialog-submit"]',
      )!.disabled,
    ).toBe(false)
    expect(document.querySelector('[data-testid="catalog-add-project"]')?.textContent).toContain(
      'here',
    )
    expect(await projectOptions()).toContain('here')
  })

  it('offers nothing and says why when the host can publish nowhere', async () => {
    // Also the LEGACY case: a response without the field reads as no target at all,
    // so an older server fails closed instead of advertising a refused install.
    const { onClose } = await open('role', undefined)

    expect(document.querySelector('[data-testid="catalog-add-unavailable"]')).not.toBeNull()
    expect(destination('Personal').disabled).toBe(true)
    expect(destination('Project').disabled).toBe(true)
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="catalog-ability-add-dialog-submit"]',
      )!.disabled,
    ).toBe(true)

    await act(async () => {
      ;[...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Cancel')!
        .click()
    })
    expect(onClose).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain('Discard role placement?')
  })

  it('offers no project of another Space to tick as a skill’s reach', async () => {
    await open('skill', skillsEverywhere)
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

  it('keeps a refused Add open and lets a retry use the settled target', async () => {
    const onAdd = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('unstable server detail'), {
          reason: 'role_install_unavailable',
        }),
      )
      .mockResolvedValueOnce(undefined)
    await open('role', { personal: true, projects: {} }, onAdd)
    const submit = document.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-ability-add-dialog-submit"]',
    )!

    await act(async () => submit.click())

    expect(onAdd).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-testid="catalog-ability-add-dialog"]')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'This host cannot install packages in that location. Reload and try again.',
    )
    expect(submit.disabled).toBe(false)

    await act(async () => submit.click())

    expect(onAdd).toHaveBeenCalledTimes(2)
  })
})
