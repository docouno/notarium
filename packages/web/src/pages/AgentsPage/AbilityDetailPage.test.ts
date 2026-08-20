// @vitest-environment jsdom

import { act, createElement, Fragment, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAbilityDetailResponse, OwnedAbilityLocator } from '@notarium/contract'
import { encodeAbilityLocator } from '@notarium/core'
import { loadRecentNotes } from '../../libs/recentNotes'
import { agentAbilityRoute } from '../../libs/routing/routePaths'

type MenuProps = {
  addVersion?: Array<{ label: string; onClick: () => void }>
  onAdd?: () => void
  onDelete?: () => void
  onToggle?: (enabled: boolean) => void
}

const harness = vi.hoisted(() => ({
  api: {
    agentAbilityGet: vi.fn(),
    noteGet: vi.fn(),
    noteSave: vi.fn(),
    agentAbilityCreateVersion: vi.fn(),
    agentAbilitySetEnabled: vi.fn(),
    agentRoleAddExact: vi.fn(),
    noteRemove: vi.fn(),
  },
  // The section's reload key. Held by the HARNESS, not minted inside the mock factory:
  // a `vi.fn()` created per render has a new identity every render and no test can
  // ever reach it, so the five writes below could stop telling the section anything
  // and the whole file would stay green — the harness would be mocking away the very
  // thing it exists to check.
  invalidate: vi.fn(),
  confirm: vi.fn(),
  params: {} as { locator?: string; packageId?: string },
  location: { key: 'first', state: null as unknown },
  versions: { roles: 0, skills: 0, memory: 0, sessions: 0 },
  editing: {
    isEditing: false,
    draft: null as unknown,
    editor: {},
    startSession: vi.fn(),
  },
  readInventory: vi.fn(),
  navigate: vi.fn(),
  // The kebab is a menu of callbacks; the tests below take the ones the page hands it
  // rather than opening it, which is the menu's own test.
  menu: null as MenuProps | null,
  dialog: null as { onAdd: (input: unknown) => Promise<void> } | null,
  inventory: { projects: [] } as {
    projects: Array<{ id: string; displayName: string; handle: string; space: string }>
  },
  actionsHost: null as HTMLElement | null,
}))

vi.mock('../../services/api', () => ({ api: harness.api }))
vi.mock('../../composers/AgentsExplorerProvider', () => ({
  useAgentsExplorer: () => ({
    scope: { spaceId: 'space-team' },
    versions: harness.versions,
    invalidate: harness.invalidate,
  }),
}))
vi.mock('../../composers/EditingProvider', () => ({ useEditing: () => harness.editing }))
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
vi.mock('../../libs/markdown/markdown', () => ({ renderMarkdown: () => '' }))
vi.mock('../../libs/markdown/useMarkdownEnhance', () => ({ useMarkdownEnhance: () => {} }))
vi.mock('./AgentsProvider', () => ({
  useAgentsShell: () => ({ actionsHost: harness.actionsHost, setBreadcrumbTail: () => {} }),
}))
vi.mock('./hooks/useSkillInventory', () => ({
  useSkillInventory: () => ({
    inventory: harness.inventory,
    skills: [],
    read: harness.readInventory,
  }),
}))
vi.mock('./AbilityEditorSurface', async () => {
  const { createElement: h } = await import('react')

  return {
    AbilityEditorSurface: () => h('div', { 'data-testid': 'ability-editor-surface' }),
  }
})
vi.mock('./AgentsPanel', () => ({ AgentsPanel: () => null }))
vi.mock('./AbilityActionsMenu', () => ({
  AbilityActionsMenu: (props: MenuProps) => {
    harness.menu = props
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
    useParams: () => harness.params,
    useLocation: () => harness.location,
    Link: (props: { to: string; children?: unknown }) =>
      h('a', { href: props.to }, props.children as never),
  }
})

import { AbilityDetailPage } from './AbilityDetailPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })

  return { promise, resolve }
}

const locatorOf = (packageId: string): OwnedAbilityLocator => ({
  source: 'owned',
  kind: 'role',
  packageId,
  location: { scope: 'space', spaceId: 'space-team' },
})

const detailOf = (packageId: string, title = packageId): AgentAbilityDetailResponse =>
  ({
    ability: {
      source: 'owned',
      locator: locatorOf(packageId),
      title,
      name: packageId,
      description: 'A role',
      noteId: `note-${packageId}`,
      origin: 'custom',
      enabled: true,
      instructions: 'body',
    },
    health: { healthy: true, attachments: [] },
    truncated: false,
  }) as unknown as AgentAbilityDetailResponse

const CATALOG_LOCATOR = { source: 'catalog', kind: 'role', packageId: 'CatalogRole1' } as const

const catalogDetail = () =>
  ({
    ability: {
      source: 'catalog',
      locator: CATALOG_LOCATOR,
      title: 'Catalog role',
      name: 'CatalogRole1',
      description: 'From the catalog',
      instructions: 'body',
    },
    health: { healthy: true, attachments: [] },
    truncated: false,
  }) as unknown as AgentAbilityDetailResponse

const noteOf = (packageId: string) => ({
  id: `note-${packageId}`,
  title: packageId,
  documentTitle: packageId,
  content: 'body',
  slug: packageId,
  filePath: `agents/${packageId}.md`,
  versionToken: `v-${packageId}`,
  space: 'team',
  createdAt: null,
})

describe('the ability page', () => {
  let container: HTMLDivElement
  let root: Root
  let gone: boolean

  const render = (props: Parameters<typeof AbilityDetailPage>[0] = {}) =>
    act(async () =>
      root.render(
        createElement(AbilityDetailPage, {
          expectedKind: 'role',
          expectedSource: 'owned',
          ...props,
        }),
      ),
    )

  const address = (packageId: string) => {
    harness.params = { locator: encodeAbilityLocator(locatorOf(packageId)) }
  }

  /** The reader closes this surface for good — the same thing a walk to any other
   *  section does, and the case a page-local address gate cannot see from a ref it
   *  only ever writes while rendering. */
  const leave = async () => {
    await act(async () => root.unmount())
    gone = true
  }

  beforeEach(() => {
    harness.versions = { roles: 0, skills: 0, memory: 0, sessions: 0 }
    harness.location = { key: 'first', state: null }
    harness.editing = { isEditing: false, draft: null, editor: {}, startSession: vi.fn() }
    harness.readInventory.mockReset()
    harness.readInventory.mockResolvedValue({ first: { projects: [] }, all: [] })
    harness.api.agentAbilityGet.mockReset()
    harness.api.noteGet.mockReset()
    harness.api.noteSave.mockReset()
    harness.api.agentAbilityCreateVersion.mockReset()
    harness.api.agentAbilitySetEnabled.mockReset().mockResolvedValue(undefined)
    harness.api.agentRoleAddExact.mockReset()
    harness.api.noteRemove.mockReset().mockResolvedValue(undefined)
    harness.navigate.mockReset()
    harness.invalidate.mockReset()
    harness.confirm.mockReset().mockResolvedValue(true)
    harness.menu = null
    harness.dialog = null
    harness.inventory = { projects: [] }
    gone = false
    localStorage.clear()
    container = document.createElement('div')
    document.body.append(container)
    // The topbar slot the page portals its Edit button and kebab into: without it the
    // actions are never mounted and no test can reach what they do.
    harness.actionsHost = document.createElement('div')
    document.body.append(harness.actionsHost)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (!gone) {
      await act(async () => root.unmount())
    }
    container.remove()
    harness.actionsHost?.remove()
  })

  const title = () => document.querySelector('.doc-title')?.textContent ?? null

  // Owned abilities share ONE route entry, so walking from A to B never remounts this
  // component: an Edit that is still waiting on the network outlives the address it
  // was asked for. Landing A's draft on B's screen hands the user an editor whose
  // Save writes into A — with B's inventory deciding what A's attachments mean.
  it('drops an Edit whose address the reader has already walked away from', async () => {
    const note = deferred<ReturnType<typeof noteOf>>()

    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    harness.api.noteGet.mockReturnValue(note.promise)
    address('Reviewer1234')
    harness.location = { key: 'a', state: { editAbility: true } }
    await render()

    expect(harness.api.noteGet).toHaveBeenCalledTimes(1)

    address('Scribe123456')
    harness.location = { key: 'b', state: null }
    await render()

    expect(title()).toBe('Scribe123456')

    await act(async () => {
      note.resolve(noteOf('Reviewer1234'))
      await note.promise
    })

    expect(harness.editing.startSession).not.toHaveBeenCalled()
  })

  it('opens the editor when the reader is still on the address Edit was asked for', async () => {
    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    harness.api.noteGet.mockImplementation(async () => noteOf('Reviewer1234'))
    address('Reviewer1234')
    harness.location = { key: 'a', state: { editAbility: true } }
    await render()

    expect(harness.editing.startSession).toHaveBeenCalledTimes(1)
    expect(
      encodeAbilityLocator(harness.editing.startSession.mock.calls[0][0].draft.abilityLocator),
    ).toBe(encodeAbilityLocator(locatorOf('Reviewer1234')))
  })

  // The page hands `invalidate` to five of its own writes and rides the same live
  // CHANGED frames every other Agents surface rides, so a detail read once per
  // address goes stale in place — and Edit then mints its draft from the stale half.
  it('re-reads the ability when the section is invalidated', async () => {
    const refreshed = deferred<AgentAbilityDetailResponse>()

    harness.api.agentAbilityGet
      .mockImplementationOnce(async () => detailOf('Reviewer1234', 'Reviewer'))
      .mockImplementationOnce(() => refreshed.promise)
    address('Reviewer1234')
    await render()

    expect(harness.api.agentAbilityGet).toHaveBeenCalledTimes(1)
    expect(title()).toBe('Reviewer')

    harness.versions = { ...harness.versions, roles: harness.versions.roles + 1 }
    await render()

    expect(harness.api.agentAbilityGet).toHaveBeenCalledTimes(2)
    // A refresh, not a reset: the document stays readable while it runs.
    expect(document.querySelector('[data-testid="ability-detail-skeleton"]')).toBeNull()
    expect(title()).toBe('Reviewer')

    await act(async () => {
      refreshed.resolve(detailOf('Reviewer1234', 'Reviewer, renamed'))
      await refreshed.promise
    })

    expect(title()).toBe('Reviewer, renamed')
  })

  // Recent, the Spotlight and the omni-search all send the reader back by the HREF
  // this row carries: an ability is not addressable from its note id the way a plain
  // note is, so a visit recorded under any other route is a dead link the moment it
  // is followed. The row lands in the bucket of the Space the ability LIVES in — the
  // one these space-free routes never name.
  it('records the visit under the route this ability answers to', async () => {
    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    address('Reviewer1234')
    await render()

    expect(loadRecentNotes('team')).toEqual([
      expect.objectContaining({
        kind: 'owned-ability',
        id: 'note-Reviewer1234',
        title: 'Reviewer1234',
        noteType: 'Role',
        href: agentAbilityRoute(locatorOf('Reviewer1234')),
      }),
    ])
  })

  // A bundled ability carries its package id in the URL raw, so what arrives here is
  // whatever a stale link, a typo or an old bookmark holds. `encodeAbilityLocator` —
  // which this page runs on every render — refuses an address the system could not
  // have minted by THROWING, and a throw in render is not this page's error state: the
  // boundary above it replaces the entire Agents surface with the crash screen.
  it('answers a malformed bundled address with its own error state', async () => {
    harness.params = { packageId: 'foo' }
    await render({ expectedKind: 'role', expectedSource: 'system' })

    expect(document.querySelector('[data-testid="ability-error"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Invalid ability address.')
    expect(harness.api.agentAbilityGet).not.toHaveBeenCalled()
  })

  // Arriving at a freshly created version opens its draft before this page has ever
  // read that address. Withholding the read while a draft is open is right for a
  // REFRESH — it could only flash a skeleton under the editor — but the FIRST read is
  // the document the editor edits, and withholding it leaves the editor empty.
  it('reads the document even when a draft for this address is already open', async () => {
    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    address('Reviewer1234')
    harness.editing = {
      ...harness.editing,
      isEditing: true,
      draft: { documentKind: 'ability', abilityLocator: locatorOf('Reviewer1234') },
    }
    await render()

    expect(harness.api.agentAbilityGet).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="ability-editor-surface"]')).not.toBeNull()
  })

  // The session outlives the page's address: `saveDraft` clears the session BEFORE it
  // awaits `onSaved`, so the edit's landing runs against whatever the reader is
  // looking at now. Adopting it there re-reads the ability they LEFT and paints it
  // over the one they opened — through a `load` closure that still holds the old
  // address and takes the newest request number on its way.
  it('drops an edit that ended after the reader walked to another ability', async () => {
    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    harness.api.noteGet.mockImplementation(async () => noteOf('Reviewer1234'))
    harness.api.noteSave.mockResolvedValue({ versionToken: 'v2' })
    address('Reviewer1234')
    harness.location = { key: 'a', state: { editAbility: true } }
    await render()

    const session = harness.editing.startSession.mock.calls[0][0]

    // The document write landed: from here what the page holds is stale, which is the
    // whole reason the edit's end re-reads at all.
    await act(async () => {
      await session.save({ content: 'body' }, 'v-Reviewer1234')
    })

    address('Scribe123456')
    harness.location = { key: 'b', state: null }
    await render()

    expect(title()).toBe('Scribe123456')

    const reads = harness.api.agentAbilityGet.mock.calls.length

    await act(async () => {
      await session.onSaved()
    })

    expect(harness.api.agentAbilityGet).toHaveBeenCalledTimes(reads)
    expect(title()).toBe('Scribe123456')
    expect(harness.navigate).not.toHaveBeenCalled()
    // Dropping the LANDING is not dropping the write: the document was saved, and
    // every listing that is already open still shows what it said before.
    expect(harness.invalidate).toHaveBeenCalledWith('roles')
  })

  // Leaving the section entirely is a walk too. `navigate` keeps working after this
  // component is gone — react-router arms its own guard in a layout effect and never
  // disarms it — so a create that lands afterwards would drag the reader out of
  // whatever they opened, into an editor for a package they never asked to see.
  it('does not drag a reader who left the section into a version it just created', async () => {
    const created = deferred<{ locator: OwnedAbilityLocator }>()

    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    harness.api.agentAbilityCreateVersion.mockReturnValue(created.promise)
    harness.inventory = {
      projects: [{ id: 'proj-1', displayName: 'Alpha', handle: 'alpha', space: 'team' }],
    }
    address('Reviewer1234')
    await render()

    const addVersion = harness.menu?.addVersion

    expect(addVersion).toHaveLength(1)
    await act(async () => {
      addVersion![0].onClick()
    })
    await leave()
    await act(async () => {
      created.resolve({
        locator: {
          source: 'owned',
          kind: 'role',
          packageId: 'Version12345',
          location: { scope: 'project', spaceId: 'space-team', projectId: 'proj-1' },
        },
      })
      await created.promise
    })

    expect(harness.navigate).not.toHaveBeenCalled()
    // The version EXISTS — the listing the reader walked to has to hear about it.
    expect(harness.invalidate).toHaveBeenCalledWith('roles')
  })

  // The intent rides a navigation, and a navigation arrives one beat before this page
  // has changed documents: its own reset has not run when the intent is first seen.
  // Spending it on that beat spends it on a refusal — `startEdit` will not mint a draft
  // from the document the reader came FROM — and nothing asks again.
  it('keeps an edit intent that arrived while the page still held the last document', async () => {
    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    harness.api.noteGet.mockImplementation(async () => noteOf('Scribe123456'))
    address('Reviewer1234')
    await render()

    expect(title()).toBe('Reviewer1234')

    address('Scribe123456')
    harness.location = { key: 'b', state: { editAbility: true } }
    await render()

    expect(harness.editing.startSession).toHaveBeenCalledTimes(1)
    expect(
      encodeAbilityLocator(harness.editing.startSession.mock.calls[0][0].draft.abilityLocator),
    ).toBe(encodeAbilityLocator(locatorOf('Scribe123456')))
  })

  // The navigation that carries this intent is made BY an action of this page, and
  // both ends share one route pattern — so the component is reused and the intent
  // arrives with the busy flag of that action still set. `startEdit` refuses while
  // busy, so a busy page is a WAIT: spending the intent there loses it for good.
  it('spends an edit intent only once the page can act on it', async () => {
    const created = deferred<{ locator: OwnedAbilityLocator }>()

    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    harness.api.noteGet.mockImplementation(async () => noteOf('Version12345'))
    harness.api.agentAbilityCreateVersion.mockReturnValue(created.promise)
    harness.inventory = {
      projects: [{ id: 'proj-1', displayName: 'Alpha', handle: 'alpha', space: 'team' }],
    }
    address('Reviewer1234')
    await render()
    await act(async () => {
      harness.menu!.addVersion![0].onClick()
    })

    // The version exists and its route is open; the action that made it has not
    // finished unwinding, so the page is still busy when the intent lands.
    address('Version12345')
    harness.location = { key: 'c', state: { editAbility: true } }
    await render()

    expect(harness.editing.startSession).not.toHaveBeenCalled()

    await act(async () => {
      created.resolve({ locator: locatorOf('Version12345') })
      await created.promise
    })

    expect(harness.editing.startSession).toHaveBeenCalledTimes(1)
    expect(
      encodeAbilityLocator(harness.editing.startSession.mock.calls[0][0].draft.abilityLocator),
    ).toBe(encodeAbilityLocator(locatorOf('Version12345')))
  })

  // The reader's click lands in the beat between the commit that carries the new
  // address and the passive effect that resets the page to it: the topbar still shows
  // the Edit button of the document they came FROM. A layout effect is exactly that
  // beat — it runs on the commit, before any passive effect of the same commit.
  it('refuses an Edit clicked in the beat before a new address resets the page', async () => {
    const ClickEdit = () => {
      useLayoutEffect(() => {
        const edit = [...(harness.actionsHost?.querySelectorAll('button') ?? [])].find((button) =>
          button.textContent?.includes('Edit'),
        )

        edit?.click()
      }, [])
      return null
    }

    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    harness.api.noteGet.mockImplementation(async () => noteOf('Reviewer1234'))
    address('Reviewer1234')
    await render()

    expect(title()).toBe('Reviewer1234')

    address('Scribe123456')
    await act(async () =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement(AbilityDetailPage, { expectedKind: 'role', expectedSource: 'owned' }),
          createElement(ClickEdit),
        ),
      ),
    )

    expect(harness.editing.startSession).not.toHaveBeenCalled()
    expect(harness.api.noteGet).not.toHaveBeenCalled()
  })

  // Every write on this page hands the section its reload key, and that key is the
  // ONLY thing that makes the Explorer rail, the shell counters and the library re-read
  // what just changed. Nothing on screen shows whether it was handed over, so each of
  // the five is asserted here — and asserted for the reader who has WALKED AWAY too,
  // because that is the half the page's own address gates deliberately skip. The order
  // matters as much as the call: the comments beside those gates argue that invalidation
  // happens BEFORE the landing is judged, and that argument is what these pin.
  it('lands the reader who is still here in the version it just created', async () => {
    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    harness.api.agentAbilityCreateVersion.mockResolvedValue({ locator: locatorOf('Version12345') })
    harness.inventory = {
      projects: [{ id: 'proj-1', displayName: 'Alpha', handle: 'alpha', space: 'team' }],
    }
    address('Reviewer1234')
    await render()
    await act(async () => {
      harness.menu!.addVersion![0].onClick()
    })

    expect(harness.navigate).toHaveBeenCalledWith(agentAbilityRoute(locatorOf('Version12345')), {
      state: { editAbility: true },
    })
    expect(harness.invalidate).toHaveBeenCalledWith('roles')
  })

  // The reader deletes the Role from its own page and is sent back to the library. If
  // the section is not invalidated on the way, that library is whatever it read before
  // — with the deleted Role still in it, until a reconnect or another write happens to
  // bump the same key. Silent, and indistinguishable from a delete that failed.
  it('sends a delete back to the library and tells the section it happened', async () => {
    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    address('Reviewer1234')
    await render()
    await act(async () => {
      harness.menu!.onDelete?.()
    })

    expect(harness.api.noteRemove).toHaveBeenCalledWith('note-Reviewer1234')
    expect(harness.invalidate).toHaveBeenCalledWith('roles')
    expect(harness.navigate).toHaveBeenCalledWith('/agents/abilities/roles')
  })

  it('tells the section about a delete that landed after the reader left', async () => {
    const removed = deferred<void>()

    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    harness.api.noteRemove.mockReturnValue(removed.promise)
    address('Reviewer1234')
    await render()
    await act(async () => {
      harness.menu!.onDelete?.()
    })
    await leave()
    await act(async () => {
      removed.resolve()
      await removed.promise
    })

    expect(harness.invalidate).toHaveBeenCalledWith('roles')
    expect(harness.navigate).not.toHaveBeenCalled()
  })

  it('tells the section when the kebab toggles this ability off', async () => {
    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    address('Reviewer1234')
    await render()
    await act(async () => {
      harness.menu!.onToggle?.(false)
    })

    expect(harness.api.agentAbilitySetEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: 'Reviewer1234' }),
      false,
    )
    expect(harness.invalidate).toHaveBeenCalledWith('roles')
  })

  // Adopting a catalog package is a write into the library the reader is NOT looking at
  // — they are on the catalog page. Only the landing is theirs to lose.
  it('opens the adopted package and tells the section it exists', async () => {
    harness.api.agentAbilityGet.mockImplementation(async () => catalogDetail())
    harness.api.agentRoleAddExact.mockResolvedValue({ locator: locatorOf('Adopted12345') })
    harness.params = { packageId: 'CatalogRole1' }
    await render({ expectedSource: 'catalog' })
    await act(async () => {
      harness.menu!.onAdd?.()
    })

    expect(harness.dialog).not.toBeNull()
    await act(async () => {
      await harness.dialog!.onAdd({ name: 'CatalogRole1', scope: 'personal' })
    })

    expect(harness.invalidate).toHaveBeenCalledWith('roles')
    expect(harness.navigate).toHaveBeenCalledWith(agentAbilityRoute(locatorOf('Adopted12345')), {
      replace: true,
    })
  })

  it('tells the section about an adoption that landed after the reader left', async () => {
    const added = deferred<{ locator: OwnedAbilityLocator }>()

    harness.api.agentAbilityGet.mockImplementation(async () => catalogDetail())
    harness.api.agentRoleAddExact.mockReturnValue(added.promise)
    harness.params = { packageId: 'CatalogRole1' }
    await render({ expectedSource: 'catalog' })
    await act(async () => {
      harness.menu!.onAdd?.()
    })
    await act(async () => {
      void harness.dialog!.onAdd({ name: 'CatalogRole1', scope: 'personal' })
    })
    await leave()
    await act(async () => {
      added.resolve({ locator: locatorOf('Adopted12345') })
      await added.promise
    })

    expect(harness.invalidate).toHaveBeenCalledWith('roles')
    expect(harness.navigate).not.toHaveBeenCalled()
  })

  it('does not paint one ability’s open draft over another ability’s page', async () => {
    harness.api.agentAbilityGet.mockImplementation(async (at: OwnedAbilityLocator) =>
      detailOf(at.packageId),
    )
    address('Scribe123456')
    harness.editing = {
      ...harness.editing,
      isEditing: true,
      draft: { documentKind: 'ability', abilityLocator: locatorOf('Reviewer1234') },
    }
    await render()

    expect(document.querySelector('[data-testid="ability-editor-surface"]')).toBeNull()
    expect(title()).toBe('Scribe123456')
  })
})
