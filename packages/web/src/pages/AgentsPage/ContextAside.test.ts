// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The panel is read-only and takes everything it prints as a prop, so the only mock it
// needs is the router: `Link` is the one interactive element on the surface, and the
// tests below read the href it produces.
vi.mock('react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) =>
    createElement('a', { href: to }, children),
}))

import { ContextAside } from './ContextAside'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Props = Parameters<typeof ContextAside>[0]

const counted = (pins: number, sets: number) => ({
  pins: Array.from({ length: pins }, () => ({})),
  sets: Array.from({ length: sets }, () => ({})),
})

const roleIn = (location: Record<string, string>) =>
  ({
    name: 'release-reviewer',
    title: 'Release Reviewer',
    ...counted(2, 0),
    locator: { source: 'owned', kind: 'role', packageId: 'MvJor9heUmRt', location },
  }) as unknown as Props['roleLayer']

const props = (over: Partial<Props> = {}): Props => ({
  loading: false,
  roleFailed: false,
  scopeFailed: false,
  roleUnavailable: false,
  roleLayer: undefined,
  isRoleScope: false,
  isProjectScope: false,
  roleRoute: false,
  projectRoute: false,
  project: null,
  personal: undefined,
  spaces: [],
  projects: [],
  ...over,
})

describe('the Context aside witnesses the scope the page is showing', () => {
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

  const render = async (over: Partial<Props> = {}) => {
    await act(async () => root.render(createElement(ContextAside, props(over))))
    return container.querySelector<HTMLElement>('[data-testid="context-details"]')!
  }

  // Fields are addressed by their LABEL, the way a reader addresses them: `AsideField`
  // has no testId of its own and its class names are hashed in the bundle.
  const fieldNode = (label: string) =>
    [...container.querySelectorAll('span')].find((span) => span.textContent === label)
      ?.nextElementSibling ?? null
  const field = (label: string) => fieldNode(label)?.textContent ?? null

  it('counts the personal scope it stands over and offers no project index', async () => {
    await render({ personal: counted(3, 1) })

    expect(field('Composition')).toBe('3 pinned · 1 set')
    expect(field('Auto')).toBeNull()
  })

  it('names a role placement in human words and links the role it names', async () => {
    const panel = await render({
      isRoleScope: true,
      roleLayer: roleIn({ scope: 'project', spaceId: 'sp-1', projectId: 'pr-1' }),
      spaces: [
        { id: 'sp-1', slug: 'product', displayName: 'Product' },
      ] as unknown as Props['spaces'],
      projects: [
        { id: 'pr-1', handle: 'product/web', path: 'web', displayName: 'Web' },
      ] as unknown as Props['projects'],
    })

    expect(field('Placement')).toBe('Web · Product')
    expect(panel.textContent).not.toContain('product/web')
    expect(panel.querySelector('a')?.getAttribute('href')).toBe(
      '/agents/abilities/roles/owned/eyJzb3VyY2UiOiJvd25lZCIsImtpbmQiOiJyb2xlIiwicGFja2FnZUlkIjoiTXZKb3I5aGVVbVJ0IiwibG9jYXRpb24iOnsic2NvcGUiOiJwcm9qZWN0Iiwic3BhY2VJZCI6InNwLTEiLCJwcm9qZWN0SWQiOiJwci0xIn19',
    )
  })

  it('falls back to a word, never to the raw address, when the project is out of view', async () => {
    const panel = await render({
      isRoleScope: true,
      roleLayer: roleIn({ scope: 'project', spaceId: 'sp-9', projectId: 'pr-9' }),
    })

    expect(field('Placement')).toBe('This project')
    expect(panel.textContent).not.toContain('pr-9')
    expect(panel.textContent).not.toContain('sp-9')
  })

  it('counts the role layer under a role scope and says nothing about memory', async () => {
    const panel = await render({
      isRoleScope: true,
      roleLayer: roleIn({ scope: 'personal', spaceId: 'sp-1' }),
      personal: counted(7, 3),
    })

    expect(field('Composition')).toBe('2 pinned · 0 sets')
    expect(field('Placement')).toBe('Personal')
    expect(panel.textContent?.toLowerCase()).not.toContain('memory')
  })

  it('says the context is the base one when no address named a role', async () => {
    const panel = await render({ personal: counted(1, 0) })

    expect(field('Effective role')).toBe('Base context')
    expect(field('Placement')).toBeNull()
    expect(panel.querySelector('a')).toBeNull()
  })

  it('separates a role door that failed from a context that names no role', async () => {
    await render({ roleFailed: true, personal: counted(4, 2) })

    expect(field('Effective role')).toBe('Couldn’t load the role')
    // The body falls through to the profile when the door is silent, so the panel counts
    // the same scope — printing zeros for a role whose pins simply never arrived would
    // be a claim about an empty role.
    expect(field('Composition')).toBe('4 pinned · 2 sets')
  })

  it('says which door failed instead of counting a scope it never received', async () => {
    await render({
      isProjectScope: true,
      projectRoute: true,
      scopeFailed: true,
      personal: counted(4, 2),
    })

    expect(field('Composition')).toBe('Couldn’t load')
    expect(field('Auto')).toBe('Couldn’t load')
    expect(field('Effective role')).toBe('Base context')
  })

  it('reserves every field while the scope is still in flight and states no number', async () => {
    const panel = await render({ loading: true, projectRoute: true })

    expect(panel.textContent).not.toMatch(/\d/)
    // By label, like the eight cases above: a count of anonymous nodes cannot tell three
    // reserved fields from one field holding three shimmer lines.
    for (const label of ['Effective role', 'Composition', 'Auto']) {
      expect(field(label)).toBe('')
      expect(fieldNode(label)?.querySelector('[aria-hidden="true"]')).not.toBeNull()
    }
  })

  it('drops the role fields the moment the address stops naming a role', async () => {
    // The page is one commit away from rewriting the URL to the base context; a label
    // without a value would outlive its own subject.
    const panel = await render({
      roleUnavailable: true,
      roleLayer: roleIn({ scope: 'personal', spaceId: 'sp-1' }),
      personal: counted(4, 2),
    })

    expect(field('Effective role')).toBeNull()
    expect(field('Placement')).toBeNull()
    expect(field('Composition')).toBe('4 pinned · 2 sets')
    expect(panel.querySelector('a')).toBeNull()
  })

  it('names the failed door instead of waiting forever when both are true', async () => {
    // Reachable: the reset effect clears the two preview failures on a new request key and
    // leaves `role context` standing, so the next load runs with the failure still set.
    await render({ roleFailed: true, loading: true, personal: counted(1, 0) })

    expect(field('Effective role')).toBe('Couldn’t load the role')
  })

  it('counts the scope the body renders, not whichever role happens to be loaded', async () => {
    // A role IS addressed, but the reader clicked the Personal band on the scale, so the
    // body renders the profile. The panel has to follow the body, not the role.
    await render({
      roleLayer: roleIn({ scope: 'personal', spaceId: 'sp-1' }),
      isRoleScope: false,
      personal: counted(7, 3),
    })

    expect(field('Composition')).toBe('7 pinned · 3 sets')
  })

  it('names the Space of a Space role, and says the Space when it cannot', async () => {
    await render({
      isRoleScope: true,
      roleLayer: roleIn({ scope: 'space', spaceId: 'sp-9' }),
      spaces: [
        { id: 'sp-9', slug: 'product', displayName: 'Product' },
      ] as unknown as Props['spaces'],
    })

    expect(field('Placement')).toBe('Product')

    const panel = await render({
      isRoleScope: true,
      roleLayer: roleIn({ scope: 'space', spaceId: 'sp-9' }),
    })

    expect(field('Placement')).toBe('the Space')
    expect(panel.textContent).not.toContain('sp-9')
  })

  it('reserves the placement of a role it is already reading', async () => {
    // The address names a role, so the settled panel will state where that role lives.
    // Reserving the row keeps `Composition` from sliding down when the door answers.
    const panel = await render({ loading: true, roleRoute: true })

    expect(field('Effective role')).toBe('')
    expect(field('Placement')).toBe('')
    expect(field('Auto')).toBeNull()
    expect(panel.textContent).not.toMatch(/\d/)
  })

  it('reserves no project index on a route that has none to fill it with', async () => {
    // The reservation is for a route that SETTLES into the project scope. A personal
    // route — and a project route that names a role — would gain a row and then lose it.
    await render({ loading: true, projectRoute: false })

    expect(field('Composition')).toBe('')
    expect(field('Auto')).toBeNull()
  })

  it('states the project index the page no longer prints in its body', async () => {
    await render({
      isProjectScope: true,
      projectRoute: true,
      project: {
        ...counted(2, 1),
        index: { noteCount: 29, folderCount: 4 },
      } as unknown as Props['project'],
    })

    expect(field('Auto')).toBe('29 notes · 4 folders + recent changes')
    expect(field('Composition')).toBe('2 pinned · 1 set')
  })
})
