// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeAgentSkillsResponse } from '@notarium/contract'

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
  loadSkillInventory: vi.fn(),
  params: { kind: 'roles', draftId: 'x' } as { kind: string; draftId: string },
  editing: {
    isEditing: false,
    draft: null as unknown,
    editor: {} as unknown,
    startSession: vi.fn(),
  },
}))

vi.mock('./helpers/skillInventory', () => ({ loadSkillInventory: harness.loadSkillInventory }))
vi.mock('../../composers/AgentsExplorerProvider', () => ({
  useAgentsExplorer: () => ({ scope: { spaceId: 'space-team' }, invalidate: vi.fn() }),
}))
vi.mock('../../composers/AuthProvider', () => ({
  useAuth: () => ({ mode: 'password', me: { username: 'maya' } }),
}))
vi.mock('../../composers/EditingProvider', () => ({ useEditing: () => harness.editing }))
vi.mock('../../composers/SpaceProvider', () => ({
  useSpace: () => ({ space: 'team', canWrite: true }),
}))
vi.mock('./AgentsProvider', () => ({
  useAgentsShell: () => ({ actionsHost: null, setBreadcrumbTail: () => {} }),
}))
vi.mock('./AbilityEditorSurface', async () => {
  const { createElement: h } = await import('react')

  return { AbilityEditorSurface: () => h('div', { 'data-testid': 'ability-editor-surface' }) }
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

const inventory = () => ({
  first: { projects: [] } as unknown as MeAgentSkillsResponse,
  all: [],
})

describe('the new-ability page', () => {
  let container: HTMLDivElement
  let root: Root

  const render = () =>
    act(async () => root.render(createElement(AbilityDraftPage, { expectedKind: 'roles' })))

  beforeEach(() => {
    localStorage.clear()
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
    await render()

    expect(editor()).toBeNull()

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
})
