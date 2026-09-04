// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeAgentSkillsResponse } from '@notarium/contract'
import { writeAbilityDraft } from '../../libs/abilityDraftStorage'

const editorStub = {
  dirty: false,
  contentVersion: 0,
  abilityMachineName: '',
  abilityDescription: '',
  abilityHome: 'personal',
  abilitySpace: 'team',
  abilityAvailability: 'all-projects',
  abilityProjects: [] as string[],
  attachments: [] as unknown[],
  buildPayload: () => ({ content: '' }),
}

const harness = vi.hoisted(() => ({
  panels: [] as Array<{ panels: number; label: string }>,
  loadSkillInventory: vi.fn(),
  api: {
    agentRolesGet: vi.fn(),
    agentRoleCreate: vi.fn(),
    agentSkillPublish: vi.fn(),
  },
  surfaceProps: null as unknown,
  spaces: [
    { id: 'space-team', slug: 'team' },
    { id: 'space-alpha', slug: 'alpha' },
  ],
  personalSpace: { id: 'space-personal', slug: 'personal' },
  params: { kind: 'roles', draftId: 'x' } as { kind: string; draftId: string },
  editing: {
    isEditing: false,
    draft: null as unknown,
    editor: {} as unknown,
    startSession: vi.fn(),
  },
}))

vi.mock('./helpers/skillInventory', () => ({ loadSkillInventory: harness.loadSkillInventory }))
vi.mock('../../services/api', () => ({ api: harness.api }))
vi.mock('../../composers/AgentsExplorerProvider', () => ({
  useAgentsExplorer: () => ({ scope: { spaceId: 'space-team' }, invalidate: vi.fn() }),
}))
vi.mock('../../composers/AuthProvider', () => ({
  // Drafts key on the stable account id, never on the handle — the two differ here on
  // purpose, so a page that went back to keying by the handle would read nothing.
  useAuth: () => ({ mode: 'password', me: { id: 'a1b2c3d4e5f60718', username: 'maya' } }),
}))
vi.mock('../../composers/EditingProvider', () => ({ useEditing: () => harness.editing }))
vi.mock('../../composers/SpaceProvider', () => ({
  useSpace: () => ({
    space: 'team',
    canWrite: true,
    spaces: harness.spaces,
    personalSpace: harness.personalSpace,
  }),
}))
vi.mock('./AgentsProvider', () => ({
  useAgentsShell: () => ({ actionsHost: null, setBreadcrumbTail: () => {} }),
}))
// The panel is the shell's adapter, not this page's subject: it reads `useChrome`, which
// throws outside its provider, and `useAgentsShell`, which this file stubs down to the two
// members the page itself uses. The stub records what the page asked it to host, so "the
// route keeps its aside in every state" (#393) is assertable here.
vi.mock('./AgentsPanel', async () => {
  const { useEffect, useRef } = await import('react')

  return {
    AgentsPanel: (props: { panels: unknown[]; label: string }) => {
      // Every LIVE panel, not the last one seen: one record cannot tell one panel from two
      // mounted at once. The record is kept CURRENT on every render — a route that starts
      // with a panel and later hands over an empty array would otherwise read as healthy —
      // and removed by identity when this panel actually goes away.
      const mine = useRef({ panels: props.panels.length, label: props.label }).current

      mine.panels = props.panels.length
      mine.label = props.label
      useEffect(() => {
        harness.panels.push(mine)
        return () => {
          harness.panels = harness.panels.filter((entry) => entry !== mine)
        }
      }, [mine])
      return null
    },
  }
})
vi.mock('./AbilityEditorSurface', async () => {
  const { createElement: h } = await import('react')

  return {
    AbilityEditorSurface: (props: unknown) => {
      harness.surfaceProps = props
      return h('div', { 'data-testid': 'ability-editor-surface' })
    },
  }
})
vi.mock('react-router', () => ({
  useNavigate: () => () => {},
  useParams: () => harness.params,
}))

import { AbilityDraftPage } from './AbilityDraftPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })

  return { promise, resolve }
}

const inventory = (personal = true, space = true) => ({
  first: {
    projects: [],
    installAvailability: { personal, spaces: { team: space } },
  } as unknown as MeAgentSkillsResponse,
  all: [],
})

describe('the new-ability page', () => {
  let container: HTMLDivElement
  let root: Root

  const render = () =>
    act(async () => root.render(createElement(AbilityDraftPage, { expectedKind: 'roles' })))

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    Object.assign(editorStub, {
      abilityHome: 'personal',
      abilitySpace: 'team',
      abilityAvailability: 'all-projects',
      abilityProjects: [],
    })
    harness.params = { kind: 'roles', draftId: 'x' }
    harness.editing = {
      isEditing: false,
      draft: null,
      editor: editorStub,
      // The provider seeds the session synchronously; the page re-renders on it.
      startSession: vi.fn((adapter: { draft: unknown }) => {
        harness.editing.isEditing = true
        harness.editing.draft = adapter.draft
      }),
    }
    harness.loadSkillInventory.mockReset()
    harness.loadSkillInventory.mockResolvedValue(inventory())
    harness.api.agentRolesGet.mockReset()
    harness.api.agentRolesGet.mockResolvedValue({
      projects: [],
      installAvailability: { personal: true, projects: {} },
    })
    harness.surfaceProps = null
    harness.api.agentRoleCreate.mockReset()
    harness.api.agentSkillPublish.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const editor = () => document.querySelector('[data-testid="ability-editor-surface"]')

  // `+ New` from a draft route reuses this component, and re-seeding the session waits
  // on the inventory read. In that window the page is addressed at the new draft while
  // the editor still holds the old one's body.
  it('shows no editor while the open session is a draft other than the routed one', async () => {
    await render()
    await render()

    expect(editor()).not.toBeNull()

    const seeding = deferred<ReturnType<typeof inventory>>()

    harness.loadSkillInventory.mockReturnValueOnce(seeding.promise)
    harness.params = { kind: 'roles', draftId: 'y' }
    harness.panels = []
    await render()

    expect(editor()).toBeNull()
    // No editor yet, but the route still owns an aside — otherwise the content column
    // would resize under the reader between the two (#393). The surface is stubbed in this
    // file, so "one panel, not two" is an e2e question; what is asserted here is that the
    // page mounts one at all, with the route's own label.
    expect(harness.panels).toEqual([{ panels: 1, label: 'role details' }])

    await act(async () => {
      seeding.resolve(inventory())
      await seeding.promise
    })
    await render()

    expect(editor()).not.toBeNull()
    expect(
      (harness.editing.draft as { abilityDraft: { draftId: string } }).abilityDraft.draftId,
    ).toBe('y')
  })

  it('defaults a new custom Role to Space when Personal is unavailable', async () => {
    harness.loadSkillInventory.mockResolvedValue(inventory(false, true))
    harness.api.agentRolesGet.mockResolvedValue({
      projects: [],
      installAvailability: { personal: false, projects: {} },
    })

    await render()
    await render()

    const adapter = harness.editing.startSession.mock.calls.at(-1)?.[0] as {
      canWrite: boolean
      draft: { abilityHome: string }
    }
    expect(adapter.canWrite).toBe(true)
    expect(adapter.draft.abilityHome).toBe('space')
    expect(harness.surfaceProps).toMatchObject({
      personalAvailable: false,
      spaceAvailable: true,
    })
  })

  it('keeps unavailable homes visible but blocks a draft with no publication target', async () => {
    harness.loadSkillInventory.mockResolvedValue(inventory(false, false))
    harness.api.agentRolesGet.mockResolvedValue({
      projects: [],
      installAvailability: { personal: false, projects: {} },
    })

    await render()
    await render()

    const adapter = harness.editing.startSession.mock.calls.at(-1)?.[0] as {
      canWrite: boolean
    }
    expect(adapter.canWrite).toBe(false)
    expect(harness.surfaceProps).toMatchObject({
      personalAvailable: false,
      spaceAvailable: false,
    })
  })

  it('loads a restored Space draft against its persisted target, not the active Space', async () => {
    writeAbilityDraft({
      version: 1,
      owner: 'a1b2c3d4e5f60718',
      draftId: 'x',
      kind: 'role',
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
      authoredDraft: {
        name: 'alpha-review',
        description: 'Restored in Alpha.',
        instructions: '# Alpha review\n\nStay in Alpha.',
        attachments: [],
      },
      creationSettings: {
        home: 'space',
        space: 'alpha',
        availability: 'selected-projects',
        projects: ['proj-alpha'],
      },
    })
    harness.loadSkillInventory.mockResolvedValue({
      first: {
        projects: [{ id: 'proj-alpha', handle: 'alpha/review' }],
        installAvailability: { personal: false, spaces: { alpha: true } },
      },
      all: [],
    })
    harness.api.agentRolesGet.mockResolvedValue({
      projects: [],
      installAvailability: { personal: false, projects: {} },
    })
    Object.assign(editorStub, {
      abilityHome: 'space',
      abilitySpace: 'alpha',
      abilityAvailability: 'selected-projects',
      abilityProjects: ['proj-alpha'],
    })
    harness.api.agentRoleCreate.mockResolvedValue({ locator: {} })

    await render()
    await render()

    expect(harness.loadSkillInventory).toHaveBeenCalledWith('space-alpha')
    const adapter = harness.editing.startSession.mock.calls.at(-1)?.[0] as {
      canSave: (editor: typeof editorStub) => boolean
      save: (payload: { content: string }) => Promise<unknown>
    }
    expect(adapter.canSave(editorStub)).toBe(true)
    await adapter.save({ content: '# Alpha review\n\nStay in Alpha.' })
    expect(harness.api.agentRoleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'space',
        space: 'alpha',
        availability: { mode: 'selected-projects', projects: ['alpha/review'] },
      }),
    )
  })

  it('rejects restored selected projects that no longer belong to the exact target', async () => {
    writeAbilityDraft({
      version: 1,
      owner: 'a1b2c3d4e5f60718',
      draftId: 'x',
      kind: 'role',
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
      authoredDraft: {
        name: 'stale-project-review',
        description: 'The selected project is gone.',
        instructions: '# Stale project review\n\nKeep the draft.',
        attachments: [],
      },
      creationSettings: {
        home: 'space',
        space: 'alpha',
        availability: 'selected-projects',
        projects: ['project-gone'],
      },
    })
    harness.loadSkillInventory.mockResolvedValue({
      first: {
        projects: [{ id: 'project-live', handle: 'alpha/live' }],
        installAvailability: { personal: false, spaces: { alpha: true } },
      },
      all: [],
    })
    harness.api.agentRolesGet.mockResolvedValue({
      projects: [],
      installAvailability: { personal: false, projects: {} },
    })
    Object.assign(editorStub, {
      abilityHome: 'space',
      abilitySpace: 'alpha',
      abilityAvailability: 'selected-projects',
      abilityProjects: ['project-gone'],
    })

    await render()
    await render()

    const adapter = harness.editing.startSession.mock.calls.at(-1)?.[0] as {
      canSave: (editor: typeof editorStub) => boolean
      save: (payload: { content: string }) => Promise<unknown>
    }
    expect(adapter.canSave(editorStub)).toBe(false)
    await expect(
      adapter.save({ content: '# Stale project review\n\nKeep the draft.' }),
    ).rejects.toThrow('selected ability target is unavailable')
    expect(harness.api.agentRoleCreate).not.toHaveBeenCalled()
  })

  it('rejects a restored unavailable target before any Save adapter calls the API', async () => {
    writeAbilityDraft({
      version: 1,
      owner: 'a1b2c3d4e5f60718',
      draftId: 'x',
      kind: 'role',
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
      authoredDraft: {
        name: 'personal-review',
        description: 'No longer publishable here.',
        instructions: '# Personal review\n\nKeep the draft.',
        attachments: [],
      },
      creationSettings: {
        home: 'personal',
        space: 'team',
        availability: 'all-projects',
        projects: [],
      },
    })
    harness.loadSkillInventory.mockResolvedValue(inventory(false, true))
    harness.api.agentRolesGet.mockResolvedValue({
      projects: [],
      installAvailability: { personal: false, projects: {} },
    })
    editorStub.abilityHome = 'personal'

    await render()
    await render()

    const adapter = harness.editing.startSession.mock.calls.at(-1)?.[0] as {
      canSave: (editor: typeof editorStub) => boolean
      save: (payload: { content: string }) => Promise<unknown>
    }
    expect(adapter.canSave(editorStub)).toBe(false)
    await expect(adapter.save({ content: '# Personal review\n\nKeep the draft.' })).rejects.toThrow(
      'selected ability target is unavailable',
    )
    expect(harness.api.agentRoleCreate).not.toHaveBeenCalled()
  })
})
