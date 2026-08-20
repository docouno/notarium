// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeAgentRolesResponse } from '@notarium/contract'

type MenuProps = {
  addVersion?: Array<{ label: string; onClick: () => void }>
  onAdd?: () => void
  onDelete?: () => void
  onToggle?: (enabled: boolean) => void
}

const harness = vi.hoisted(() => ({
  api: {
    agentRolesGet: vi.fn(),
    agentSkillsGet: vi.fn(),
    agentAbilityCreateVersion: vi.fn(),
    agentRoleAddExact: vi.fn(),
    agentAbilitySetEnabled: vi.fn(),
    noteRemove: vi.fn(),
  },
  navigate: vi.fn(),
  // The section's reload key, held by the harness rather than minted inside the mock
  // factory: a fresh `vi.fn()` per render is unreachable from a test by construction,
  // so the listing could stop asking anything to re-read and every test stay green.
  invalidate: vi.fn(),
  confirm: vi.fn(),
  // The kebab of each card, by the ability it belongs to: these tests take the
  // callbacks the page hands it rather than opening it, which is the menu's own test.
  menus: {} as Record<string, MenuProps>,
  dialog: null as { onAdd: (input: unknown) => Promise<void> } | null,
  versions: { roles: 0, skills: 0, memory: 0, sessions: 0 },
  // The real frame reads this out of the URL with a memo, so it holds still between
  // renders — and `load` (which keys on it) holds still with it.
  libraryState: { q: null, source: null, home: null, availability: null, project: null },
  setState: vi.fn(),
  reportFacets: vi.fn(),
}))

vi.mock('../../services/api', () => ({ api: harness.api }))
vi.mock('../../composers/AgentsExplorerProvider', () => ({
  useAgentsExplorer: () => ({ versions: harness.versions, invalidate: harness.invalidate }),
}))
vi.mock('../../composers/SpaceProvider', () => ({
  useSpace: () => ({
    space: 'team',
    spaces: [{ id: 'space-team', slug: 'team', displayName: 'Team' }],
    personalSpace: null,
    canWrite: true,
    reportNoteSpace: vi.fn(),
  }),
}))
vi.mock('../../core/Dialog', () => ({ useDialog: () => ({ confirm: harness.confirm }) }))
vi.mock('../../core/Toast', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))
vi.mock('./PackageLibraryFrame', () => ({
  usePackageLibraryFrame: () => ({
    state: harness.libraryState,
    setState: harness.setState,
    reportFacets: harness.reportFacets,
  }),
}))
vi.mock('./AbilityActionsMenu', () => ({
  AbilityActionsMenu: (props: MenuProps & { ability: { name: string } }) => {
    harness.menus[props.ability.name] = props
    return null
  },
}))
vi.mock('./CatalogAbilityAddDialog', () => ({
  CatalogAbilityAddDialog: (props: { onAdd: (input: unknown) => Promise<void> }) => {
    harness.dialog = props
    return null
  },
}))
vi.mock('react-router', async () => {
  const { createElement: h } = await import('react')

  return {
    useNavigate: () => harness.navigate,
    useParams: () => ({ kind: 'roles' }),
    Link: (props: { to: string; children?: unknown }) =>
      h('a', { href: props.to }, props.children as never),
  }
})

import { agentAbilityRoute } from '../../libs/routing/routePaths'
import { AbilityLibraryPage } from './AbilityLibraryPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A sentinel that is already inside the observer's margin: a real
 *  IntersectionObserver delivers an entry for it the moment it is observed, which is
 *  exactly how a parked continuation resumes without the user asking. */
class InViewObserver {
  private nodes = new Set<Element>()

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(node: Element) {
    this.nodes.add(node)
    // Delivery is a task of its own, never a call inside `observe` — the real
    // observer never reports back inside the effect that armed it.
    queueMicrotask(() => {
      if (!this.nodes.has(node)) {
        return
      }
      this.callback(
        [{ isIntersecting: true, target: node } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      )
    })
  }

  unobserve(node: Element) {
    this.nodes.delete(node)
  }

  disconnect() {
    this.nodes.clear()
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })

  return { promise, resolve }
}

const page = (nextCursor: string | null): MeAgentRolesResponse =>
  ({
    items: [
      {
        source: 'owned',
        locator: {
          source: 'owned',
          kind: 'role',
          packageId: 'Reviewer1234',
          location: { scope: 'space', spaceId: 'space-team' },
        },
        title: 'Reviewer',
        name: 'Reviewer1234',
        description: 'Reviews',
        noteId: 'note-reviewer',
        origin: 'custom',
        enabled: true,
      },
    ],
    projects: [],
    activeRole: null,
    nextCursor,
    filteredTotal: 1,
    total: 1,
    facets: null,
    truncated: false,
  }) as unknown as MeAgentRolesResponse

describe('the ability library parks a failed continuation until the user asks again', () => {
  let container: HTMLDivElement
  let root: Root
  let cursorCalls: number

  beforeEach(async () => {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = InViewObserver
    harness.versions = { roles: 0, skills: 0, memory: 0, sessions: 0 }
    cursorCalls = 0
    harness.api.agentRolesGet.mockReset()
    harness.api.agentRolesGet.mockImplementation(async (query: { cursor?: string }) => {
      if (query.cursor) {
        cursorCalls += 1
        throw new Error('offline')
      }

      return page('cursor-2')
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(AbilityLibraryPage, {})))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const parked = () => document.querySelector('[data-testid="ability-library-more-error"]') !== null

  it('leaves a background refresh from moving the parked continuation', async () => {
    expect(cursorCalls).toBe(1)
    expect(parked()).toBe(true)

    // Anything at all invalidated the listing — a save in another tab, a reconnect.
    // The rows re-read at the same depth; the continuation the user has NOT retried
    // must not ride along with them.
    harness.versions = { ...harness.versions, roles: harness.versions.roles + 1 }
    await act(async () => root.render(createElement(AbilityLibraryPage, {})))

    expect(cursorCalls).toBe(1)
    expect(parked()).toBe(true)
  })

  it('asks again when the user presses Retry', async () => {
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry',
    )

    expect(retry).toBeDefined()
    await act(async () => retry!.click())

    expect(cursorCalls).toBe(2)
  })
})

// Both writes below answer on the network and then LAND the reader somewhere. The
// listing is a route entry of its own, so opening any card unmounts it — and
// `navigate` keeps working from a page that is gone (react-router arms its own guard
// in a layout effect and never disarms it). What arrives late is then a landing the
// reader never asked for: it drags them out of whatever they opened, and for a new
// version it drags them into an editor for a package they are not looking at.
describe('the ability library hands a landing only to the reader still on it', () => {
  let container: HTMLDivElement
  let root: Root
  let gone: boolean

  const versionLocator = {
    source: 'owned',
    kind: 'role',
    packageId: 'Version12345',
    location: { scope: 'project', spaceId: 'space-team', projectId: 'proj-1' },
  } as const
  const adoptedLocator = {
    source: 'owned',
    kind: 'role',
    packageId: 'Adopted12345',
    location: { scope: 'personal', spaceId: 'space-personal' },
  } as const

  const listing = (): MeAgentRolesResponse =>
    ({
      ...page(null),
      items: [
        ...page(null).items,
        {
          source: 'catalog',
          locator: { source: 'catalog', kind: 'role', packageId: 'CatalogRole1' },
          title: 'Catalog role',
          name: 'CatalogRole1',
          description: 'From the catalog',
        },
      ],
      projects: [{ id: 'proj-1', displayName: 'Alpha', handle: 'alpha', space: 'team' }],
    }) as unknown as MeAgentRolesResponse

  const leave = async () => {
    await act(async () => root.unmount())
    gone = true
  }

  beforeEach(async () => {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = InViewObserver
    harness.versions = { roles: 0, skills: 0, memory: 0, sessions: 0 }
    harness.api.agentRolesGet.mockReset()
    harness.api.agentRolesGet.mockImplementation(async () => listing())
    harness.api.agentAbilityCreateVersion.mockReset()
    harness.api.agentRoleAddExact.mockReset()
    harness.api.agentAbilitySetEnabled.mockReset().mockResolvedValue(undefined)
    harness.api.noteRemove.mockReset().mockResolvedValue(undefined)
    harness.navigate.mockReset()
    harness.invalidate.mockReset()
    harness.confirm.mockReset().mockResolvedValue(true)
    harness.menus = {}
    harness.dialog = null
    gone = false
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(AbilityLibraryPage, {})))
  })

  afterEach(async () => {
    if (!gone) {
      await act(async () => root.unmount())
    }
    container.remove()
  })

  it('does not open an editor for a version the reader has already walked away from', async () => {
    const created = deferred<{ locator: unknown }>()

    harness.api.agentAbilityCreateVersion.mockReturnValue(created.promise)

    const addVersion = harness.menus.Reviewer1234?.addVersion

    expect(addVersion).toHaveLength(1)
    await act(async () => {
      addVersion![0].onClick()
    })
    await leave()
    await act(async () => {
      created.resolve({ locator: versionLocator })
      await created.promise
    })

    expect(harness.navigate).not.toHaveBeenCalled()
  })

  it('does not open a catalog addition the reader has already walked away from', async () => {
    const added = deferred<{ locator: unknown }>()

    harness.api.agentRoleAddExact.mockReturnValue(added.promise)
    await act(async () => {
      harness.menus.CatalogRole1?.onAdd?.()
    })

    expect(harness.dialog).not.toBeNull()
    await act(async () => {
      void harness.dialog!.onAdd({ name: 'CatalogRole1', scope: 'personal' })
    })
    await leave()
    await act(async () => {
      added.resolve({ locator: adoptedLocator })
      await added.promise
    })

    expect(harness.navigate).not.toHaveBeenCalled()
  })

  // The other half of the same gate, and the half a reader actually experiences:
  // asking for a version from the library is asking to SAY how it differs, so the
  // landing is the feature — "never navigate" satisfies both tests above.
  it('opens the new version’s editor for the reader who asked from this page', async () => {
    const created = { locator: versionLocator }

    harness.api.agentAbilityCreateVersion.mockResolvedValue(created)
    await act(async () => {
      harness.menus.Reviewer1234!.addVersion![0].onClick()
    })

    expect(harness.navigate).toHaveBeenCalledWith(agentAbilityRoute(versionLocator), {
      state: { editAbility: true },
    })
  })

  it('opens the adopted package for the reader who asked from this page', async () => {
    harness.api.agentRoleAddExact.mockResolvedValue({ locator: adoptedLocator })
    await act(async () => {
      harness.menus.CatalogRole1?.onAdd?.()
    })
    await act(async () => {
      await harness.dialog!.onAdd({ name: 'CatalogRole1', scope: 'personal' })
    })

    expect(harness.navigate).toHaveBeenCalledWith(agentAbilityRoute(adoptedLocator))
  })

  // The landing is the reader's to lose; the RE-READ is not. Every Agents listing —
  // the Explorer rail, the shell counters, this page — reads the section that just
  // changed only when something tells it to, so a write whose invalidation is tied to
  // the writer still being on screen leaves stale rows behind for anyone who walked on.
  it('invalidates the section even for a reader who has walked away', async () => {
    const created = deferred<{ locator: unknown }>()

    harness.api.agentAbilityCreateVersion.mockReturnValue(created.promise)
    await act(async () => {
      harness.menus.Reviewer1234!.addVersion![0].onClick()
    })
    await leave()
    await act(async () => {
      created.resolve({ locator: versionLocator })
      await created.promise
    })

    expect(harness.invalidate).toHaveBeenCalledWith('roles')
    expect(harness.navigate).not.toHaveBeenCalled()
  })

  it('invalidates the section when a catalog addition lands after the reader left', async () => {
    const added = deferred<{ locator: unknown }>()

    harness.api.agentRoleAddExact.mockReturnValue(added.promise)
    await act(async () => {
      harness.menus.CatalogRole1?.onAdd?.()
    })
    await act(async () => {
      void harness.dialog!.onAdd({ name: 'CatalogRole1', scope: 'personal' })
    })
    await leave()
    await act(async () => {
      added.resolve({ locator: adoptedLocator })
      await added.promise
    })

    expect(harness.invalidate).toHaveBeenCalledWith('roles')
  })

  // A delete the section is never told about is the loudest of the four: the row stays
  // on every listing that is already open, and clicking it opens a package in Trash.
  it('invalidates the section when an ability is deleted from a card', async () => {
    await act(async () => {
      harness.menus.Reviewer1234?.onDelete?.()
    })

    expect(harness.api.noteRemove).toHaveBeenCalledWith('note-reviewer')
    expect(harness.invalidate).toHaveBeenCalledWith('roles')
  })

  it('invalidates the section when a card toggles an ability off', async () => {
    await act(async () => {
      harness.menus.Reviewer1234?.onToggle?.(false)
    })

    expect(harness.api.agentAbilitySetEnabled).toHaveBeenCalled()
    expect(harness.invalidate).toHaveBeenCalledWith('roles')
  })
})
