// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../services/api'

// The Context constructor against the TWO doors it now reads (#309). The role a URL
// addresses is two different questions with two different owners, and the page has to
// hold both at once: WHICH role this address names and whether its shared context may
// be configured (the identity door — a question about the space) versus whether the
// agent loads it here and what that costs (the preview — a question about this reader,
// here, now). Folding them into one value is what let a role the reader had switched
// off render byte-for-byte like a live one, charged to a budget the agent never spends.
//
// So these render the REAL page into jsdom and read pixels. A mock that answered the
// question under test would make the assertion unreachable by construction; the api,
// the router and the providers are mocked because they are the page's environment, and
// nothing that is asserted is minted inside a mock factory.

const harness = vi.hoisted(() => ({
  panels: [] as Array<{ panels: number; label: string }>,
  mounts: 0,
  api: {
    meAgentContextGet: vi.fn(),
    meRoleContextGet: vi.fn(),
    projectAgentContextGet: vi.fn(),
    projectMemoryGet: vi.fn(),
    previewsPost: vi.fn(),
    contextSetsGet: vi.fn(),
  },
  search: new URLSearchParams(),
  navigate: vi.fn(),
  // Held by the harness rather than minted inside the mock factory: a fresh `vi.fn()`
  // per render is unreachable from a test, so "the page normalized the URL" could stop
  // happening and every assertion stay green.
  setSearchParams: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  // Identity-stable, like the real providers: a fresh object per render would rebuild
  // `load` on every commit and spin the page forever instead of testing it.
  projects: { projects: [] as unknown[], projectsSpace: 'me' },
  sync: { subscribe: () => () => {} },
  dialog: { confirm: vi.fn() },
  shell: { actionsHost: null, setBreadcrumbTail: () => {} },
  summary: { updateContext: () => {} },
  space: {
    space: 'me',
    spaces: [] as unknown[],
    personalSpace: { id: 'sp-me', slug: 'me', displayName: 'Personal' },
    reportNoteSpace: vi.fn(),
    canWrite: true,
  },
}))

vi.mock('../../services/api', async () => {
  const { ApiError: RealApiError } = await import('../../services/api/client')

  return { api: harness.api, ApiError: RealApiError }
})
// Mutable, because the route's scope is half of the question this page asks the
// identity door: reach is a question about a project, so a page that never renders on
// a project route can never be caught asking from nowhere.
const PARAMS: { scope: string } = { scope: 'personal' }
vi.mock('react-router', () => ({
  useNavigate: () => harness.navigate,
  useParams: () => PARAMS,
  useSearchParams: () => [harness.search, harness.setSearchParams],
}))
vi.mock('../../composers/ProjectsProvider', () => ({ useProjects: () => harness.projects }))
vi.mock('../../composers/SpaceProvider', () => ({ useSpace: () => harness.space }))
vi.mock('../../composers/SyncProvider', () => ({
  CHANGED_COALESCE_MS: 0,
  useSync: () => harness.sync,
}))
vi.mock('../../core/Dialog', () => ({ useDialog: () => harness.dialog }))
vi.mock('../../core/Toast', () => ({ useToast: () => harness.toast }))
vi.mock('./AgentsProvider', () => ({
  useAgentsShell: () => harness.shell,
  useAgentsSummary: () => harness.summary,
}))
// The panel is the shell's adapter, not this page's subject: it reads `useChrome`, which
// throws outside its provider. What it renders has its own unit (`ContextAside.test.ts`);
// the stub records what the page asked it to host, which is how "this route has an aside
// at all" (#393) is asserted here.
vi.mock('./AgentsPanel', async () => {
  const { useEffect, useRef } = await import('react')

  return {
    AgentsPanel: (props: { panels: unknown[]; label: string }) => {
      // Every LIVE panel, not the last one seen: one record cannot tell one panel from two
      // mounted at once. The record is kept CURRENT on every render — a route that starts
      // with a panel and later hands over an empty array would otherwise read as healthy —
      // and removed by identity when this panel actually goes away. `mounts` counts
      // mountings, so a panel torn down and rebuilt between two states is visible as such.
      const mine = useRef({ panels: props.panels.length, label: props.label }).current

      mine.panels = props.panels.length
      mine.label = props.label
      useEffect(() => {
        harness.panels.push(mine)
        harness.mounts += 1
        return () => {
          harness.panels = harness.panels.filter((entry) => entry !== mine)
        }
      }, [mine])
      return null
    },
  }
})

import { ContextPage } from './ContextPage'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LOCATOR = 'owned-role-locator'

const ROLE_FACTS = {
  source: 'owned',
  scope: 'personal',
  name: 'release-reviewer',
  title: 'Release Reviewer',
  description: 'Reviews releases',
  locator: {
    source: 'owned',
    kind: 'role',
    packageId: 'pkg-1',
    location: { scope: 'personal', spaceId: 'sp-me' },
  },
}

/** A pin as the IDENTITY door states it: what the note is and how heavy it is — and
 *  not one word about anybody's budget. */
const layerPin = (noteId: string, title: string, order: number) => ({
  noteId,
  title,
  tokens: 300,
  order,
})

/** A set item as the IDENTITY door states it — same omission as a pin, for the same
 *  reason: an item's `loaded` is a verdict of a budget, and this door weighs none. */
const layerItem = (noteId: string, title: string, order: number) => ({
  noteId,
  title,
  tokens: 300,
  order,
  space: 'main',
})

/** The layer carries a SET as well as loose pins, because a set states the same budget
 *  verdict in two more places (the row's own `Trimmed` badge, each member's) and a
 *  fixture without one leaves both unwatched. */
const layerSet = {
  id: 'set-release',
  name: 'Release Kit',
  homeSpace: 'main',
  order: 2,
  items: [layerItem('note-c', 'Cutover Steps', 0)],
}

const identityAnswer = (extra: Record<string, unknown> = {}) => ({
  role: {
    ...ROLE_FACTS,
    pins: [layerPin('note-a', 'Release Checklist', 0), layerPin('note-b', 'Rollback Notes', 1)],
    sets: [layerSet],
  },
  active: true,
  ...extra,
})

/** The PREVIEW door: it states the role only when the agent would load it here, and
 *  everything it states about that layer is a budget claim. */
const weighedRole = {
  ...ROLE_FACTS,
  pins: [
    { ...layerPin('note-a', 'Release Checklist', 0), loaded: true },
    { ...layerPin('note-b', 'Rollback Notes', 1), loaded: false },
  ],
  sets: [{ ...layerSet, items: [{ ...layerItem('note-c', 'Cutover Steps', 0), loaded: false }] }],
  loadedTokens: 300,
}

const previewAnswer = (role?: unknown) => ({
  roles: [],
  ...(role ? { role } : {}),
  pins: [],
  memory: [],
  sets: [],
  loadedTokens: 1200,
  totalTokens: 1200,
  budgetTokens: 4000,
})

/** The project this reader stands in on a project route. */
const PROJECT = {
  id: 'proj-scratch',
  space: 'sp-me',
  path: 'scratch',
  slug: 'scratch',
  aliases: [] as string[],
  pathAliases: [] as string[],
  handle: 'scratch',
  displayName: 'Scratch',
  status: 'active',
  lastSeen: '2026-08-19T00:00:00Z',
  createdAt: '2026-08-19T00:00:00Z',
}

/** The PREVIEW door on a project route: the same budget claim, against Q. */
const projectPreviewAnswer = (role?: unknown) => ({
  roles: [],
  ...(role ? { role } : {}),
  pins: [],
  sets: [],
  projectLoadedTokens: 0,
  personal: { pins: [], sets: [], memory: [], loadedTokens: 0 },
  loadedTokens: 1200,
  totalTokens: 1200,
  budgetTokens: 4000,
  index: { noteCount: 0, folderCount: 0 },
})

let host: HTMLElement | null = null
let root: Root | null = null

const render = async (): Promise<HTMLElement> => {
  const mount = document.createElement('div')
  document.body.append(mount)
  host = mount
  await act(async () => {
    root = createRoot(mount)
    root.render(createElement(ContextPage))
  })
  await act(async () => {})

  return mount
}

const boxOf = (mount: HTMLElement, testId: string) =>
  mount.querySelector(`[data-testid="${testId}"]`)

const textOf = (mount: HTMLElement, testId: string) =>
  (boxOf(mount, testId)?.textContent ?? '').replace(/\s+/gu, ' ').trim()

/** One card's HEADER row, picked by the name it shows. A card's badges live in the
 *  header, and a SET's body holds its member cards — so reading the whole set card would
 *  let a member's `Trimmed` answer for the set's own, and reading the whole panel would
 *  let a loose pin's answer for both. Absent card ⇒ '' ⇒ any `toContain` below fails,
 *  which is the honest reading: the row it asks about is not there. */
const headerOf = (mount: HTMLElement, testId: string, name: string): string =>
  [...mount.querySelectorAll(`[data-testid="${testId}-row"]`)]
    .map((el) => (el.textContent ?? '').replace(/\s+/gu, ' ').trim())
    .find((text) => text.includes(name)) ?? ''

const visibleText = (mount: HTMLElement) =>
  mount.innerHTML
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

/** Every row of the pin list that a click can open. A card states its meta — including
 *  the sentence "Over the token budget" — in the BODY the disclosure primitive renders
 *  only while open, so a test that never opens one asserts about a string that cannot
 *  be in the DOM under ANY behaviour. Opening is what makes the negative below mean
 *  something; the live half of the same test proves the opening works. */
const DISCLOSURE_HEADERS = ['context-set-row-row', 'context-pin-row-row', 'context-set-item-row']

const expandRows = async (mount: HTMLElement): Promise<void> => {
  // Nested: a set's members only exist in the DOM once the set itself is open.
  for (let pass = 0; pass < 3; pass += 1) {
    const closed = DISCLOSURE_HEADERS.flatMap((id) => [
      ...mount.querySelectorAll(`[data-testid="${id}"]`),
    ]).filter((el) => el.getAttribute('aria-expanded') === 'false')

    if (closed.length === 0) {
      return
    }
    await act(async () => {
      for (const el of closed) {
        ;(el as HTMLElement).click()
      }
    })
  }
}

const unmount = async (mount: HTMLElement): Promise<void> => {
  const current = root

  await act(async () => current?.unmount())
  mount.remove()
  root = null
  host = null
}

beforeEach(() => {
  localStorage.clear()
  PARAMS.scope = 'personal'
  harness.projects = { projects: [], projectsSpace: 'me' }
  harness.search = new URLSearchParams({ role: LOCATOR })
  harness.setSearchParams.mockReset()
  harness.navigate.mockReset()
  harness.toast.warning.mockReset()
  harness.api.meAgentContextGet.mockReset().mockResolvedValue(previewAnswer())
  harness.api.meRoleContextGet.mockReset().mockResolvedValue(identityAnswer())
  harness.api.projectAgentContextGet.mockReset().mockResolvedValue(projectPreviewAnswer())
  harness.api.projectMemoryGet.mockReset().mockResolvedValue([])
  harness.api.previewsPost.mockReset().mockResolvedValue({ previews: {} })
  harness.api.contextSetsGet.mockReset().mockResolvedValue([])
})

afterEach(async () => {
  if (root) {
    const current = root
    await act(async () => current.unmount())
  }
  host?.remove()
  root = null
  host = null
})

describe('the Context constructor and the role an address names (#309)', () => {
  it('renders the role layer the identity door hands back, not the one the preview weighs', async () => {
    // The preview knows nothing about this role — the agent does not load it here.
    harness.api.meAgentContextGet.mockResolvedValue(previewAnswer())
    harness.api.meRoleContextGet.mockResolvedValue(
      identityAnswer({ active: false, inactive: 'disabled' }),
    )
    const mount = await render()

    expect(harness.api.meRoleContextGet).toHaveBeenCalledWith(LOCATOR, undefined)
    expect(boxOf(mount, 'context-role')).not.toBeNull()
    expect(textOf(mount, 'context-role-pins')).toContain('Release Checklist')
    expect(textOf(mount, 'context-role-pins')).toContain('Rollback Notes')
    // Editing is a question about the space, so a role the reader switched off for
    // themselves keeps every write affordance.
    expect(boxOf(mount, 'context-add-role-pin')).not.toBeNull()
    expect(boxOf(mount, 'context-role-readonly')).toBeNull()
    // And it is NOT the "this address names nothing" path.
    expect(boxOf(mount, 'context-role-unavailable')).toBeNull()
    expect(harness.setSearchParams).not.toHaveBeenCalled()
  })

  it('says, in its own words, why the agent does not load this role here', async () => {
    const seen: Record<string, string> = {}

    for (const reason of ['disabled', 'out-of-reach', 'unhealthy'] as const) {
      harness.api.meRoleContextGet.mockResolvedValue(
        identityAnswer({ active: false, inactive: reason }),
      )
      const mount = await render()
      const notice = textOf(mount, 'context-role-inactive')

      expect(notice.length).toBeGreaterThan(0)
      seen[reason] = notice
      await act(async () => root?.unmount())
      mount.remove()
      root = null
      host = null
    }
    // Three causes, three answers: a reader who switched a role off and a reader whose
    // Space role is narrowed away from this project are not told the same thing.
    expect(new Set(Object.values(seen)).size).toBe(3)
  })

  it('does not render an inactive role identically to the one the agent loads', async () => {
    harness.api.meAgentContextGet.mockResolvedValue(previewAnswer(weighedRole))
    harness.api.meRoleContextGet.mockResolvedValue(identityAnswer())
    const live = visibleText(await render())
    await act(async () => root?.unmount())
    host?.remove()
    root = null
    host = null

    harness.api.meAgentContextGet.mockResolvedValue(previewAnswer())
    harness.api.meRoleContextGet.mockResolvedValue(
      identityAnswer({ active: false, inactive: 'disabled' }),
    )
    const off = visibleText(await render())

    expect(off).not.toBe(live)
    expect(boxOf(host!, 'context-role-inactive')).not.toBeNull()
  })

  it('takes the budget picture from the preview and makes none of its own', async () => {
    harness.api.meAgentContextGet.mockResolvedValue(previewAnswer(weighedRole))
    const live = await render()

    await expandRows(live)
    // The preview weighed this exact layer: one pin fits the budget, one does not, and
    // one set member does not. Every sentence the page has for that is read here, so the
    // negatives below are read against a world where each one demonstrably shows up:
    // the row badge, the block caption over the list, and the row's own meta line — the
    // last of which lives in the card body, which is why the rows are opened first.
    // The caption counts the lane it stands over — pins AND sets — so it reads the sum
    // of the dropped pin and the dropped set member, not the pin alone.
    expect(textOf(live, 'context-role-pins')).toContain('Trimmed')
    expect(textOf(live, 'context-role-pins')).toContain('Over the token budget')
    expect(textOf(live, 'context-role')).toContain('≈600 trimmed')
    // The rule the caption serves: a layer's tally on the scale IS the sum of the captions
    // under it. Reading only the caption would leave the halves free to disagree, which is
    // the state this vertical found. U+2212, the way the meter prints it.
    expect(textOf(live, 'context-aggregate-role')).toContain('−600')
    expect(textOf(live, 'context-aggregate-role')).toContain('Role · Release Reviewer')
    // A set states the verdict in two more places, and BOTH are read here by row rather
    // than over the panel: the trimmed pin above already puts the word in the panel, so
    // a join that stopped carrying verdicts to set members would leave every assertion
    // above green while the member and the set it sits in silently lost their badge.
    expect(headerOf(live, 'context-set-item', 'Cutover Steps')).toContain('Trimmed')
    expect(headerOf(live, 'context-set-row', 'Release Kit')).toContain('Trimmed')
    await unmount(live)

    // Nobody weighed it now, so nothing is reported dropped: `Trimmed` is a claim about
    // a budget, and the door that hands back this layer weighs none.
    harness.api.meAgentContextGet.mockResolvedValue(previewAnswer())
    harness.api.meRoleContextGet.mockResolvedValue(
      identityAnswer({ active: false, inactive: 'out-of-reach' }),
    )
    const off = await render()

    await expandRows(off)
    expect(textOf(off, 'context-role-pins')).toContain('Rollback Notes')
    expect(textOf(off, 'context-role-pins')).toContain('Cutover Steps')
    // Read over the WHOLE panel, and case-insensitively: the caption under the block
    // head writes the same verdict in lower case, one level above the list, and it is
    // the loudest of the three — the live half above reads it as "≈600 trimmed", so a
    // caption that survived unweighing would say that about a budget nobody spent.
    const said = textOf(off, 'context-role').toLowerCase()

    expect(said).not.toContain('trimmed')
    expect(said).not.toContain('over the token budget')
    // Named per row as well, so the two rows the live half reads are the two read here:
    // an unweighed set member, and the set whose badge is a claim about its members.
    // Each is asserted PRESENT by something other than the name it was found by, because
    // `headerOf` of a row that never rendered is '', and '' contains no word at all —
    // badge or not.
    const member = headerOf(off, 'context-set-item', 'Cutover Steps')
    const set = headerOf(off, 'context-set-row', 'Release Kit')

    expect(member).toContain('≈300')
    expect(member).not.toContain('Trimmed')
    expect(set).toContain('Set · 1')
    expect(set).not.toContain('Trimmed')
    // The band stays — the panel below it has to remain reachable from the Personal tab —
    // and reads zero, which is exactly what this layer costs the budget the agent spends.
    expect(boxOf(off, 'context-aggregate-role')?.getAttribute('data-loaded-tokens')).toBe('0')
  })

  // The tab used to be the one route of the section without an aside, which is what made
  // the content column jump 340px on the way in and out of it (#393).
  it('gives the route one aside panel of its own', async () => {
    harness.api.meAgentContextGet.mockResolvedValue(previewAnswer())
    harness.panels = []
    harness.mounts = 0
    await render()

    expect(harness.panels).toEqual([{ panels: 1, label: 'context details' }])
    // One mounting for the whole settle: the panel is not rebuilt as the scopes arrive.
    expect(harness.mounts).toBe(1)
  })

  it('asks the identity door from where the reader stands, not from nowhere', async () => {
    // A door that answers like the server's: reach is a question about a project
    // (`locationsFor` grows the Space and Project links only when one is named), so the
    // SAME role is out of reach asked from nowhere and live asked from inside the
    // project that holds it. A page that drops the argument can only ever be told the
    // first — and would print it beside the weight the preview drew for the second.
    PARAMS.scope = PROJECT.slug
    harness.projects = { projects: [PROJECT], projectsSpace: 'me' }
    harness.api.projectAgentContextGet.mockResolvedValue(projectPreviewAnswer(weighedRole))
    harness.api.meRoleContextGet.mockImplementation(async (_locator: string, project?: string) =>
      project === PROJECT.id
        ? identityAnswer()
        : identityAnswer({ active: false, inactive: 'out-of-reach' }),
    )
    const mount = await render()

    // The preview stands inside the project and weighs this role there…
    expect(boxOf(mount, 'context-aggregate-role')?.getAttribute('data-loaded-tokens')).toBe('300')
    // …so the page must not say "the agent won't load it here" over a weight it is
    // drawing for exactly that load. One address, one answer about reach.
    expect(boxOf(mount, 'context-role-inactive')).toBeNull()
    expect(boxOf(mount, 'context-role')).not.toBeNull()
    // And the mechanism, named so a failure above is diagnosable: the door was asked
    // from the project, which is the only argument that can tell the two answers apart.
    expect(harness.api.meRoleContextGet).toHaveBeenCalledWith(LOCATOR, PROJECT.id)
  })

  it('keeps an address the identity door merely failed to answer for', async () => {
    // "No such role" has exactly one spelling, a 404. Anything else is the door being
    // down, and a reader's own address is not something a transient 503 may consume.
    const down = new ApiError('service unavailable')

    down.status = 503
    harness.api.meRoleContextGet.mockRejectedValue(down)
    const mount = await render()

    expect(boxOf(mount, 'context-role-unavailable')).toBeNull()
    expect(harness.setSearchParams).not.toHaveBeenCalled()
    expect(harness.toast.warning).not.toHaveBeenCalled()
    // …and the failure is SAID rather than swallowed into a page that reads complete:
    // the role panel is missing, so the reader has to be told why it is missing.
    expect(textOf(mount, 'context-error')).toContain('role context')
  })

  it('shows a placement this context cannot reach, rather than dropping the address', async () => {
    // The identity door answers both halves of reach, so a Project role addressed from
    // Personal arrives as `out-of-reach` — the same door, the same word, as a Space role
    // narrowed away from a project. Neither may be silently swapped for the base context:
    // the address names a real role, and it is still this reader's to configure.
    harness.api.meAgentContextGet.mockResolvedValue(previewAnswer())
    harness.api.meRoleContextGet.mockResolvedValue(
      identityAnswer({ active: false, inactive: 'out-of-reach' }),
    )
    const mount = await render()

    expect(boxOf(mount, 'context-role')).not.toBeNull()
    expect(boxOf(mount, 'context-role-unavailable')).toBeNull()
    expect(boxOf(mount, 'context-add-role-pin')).not.toBeNull()
    expect(harness.setSearchParams).not.toHaveBeenCalled()
  })

  it('returns to the base context only when the address names no role at all', async () => {
    const missing = new ApiError('not found')
    missing.status = 404
    harness.api.meRoleContextGet.mockRejectedValue(missing)
    const mount = await render()

    expect(boxOf(mount, 'context-role-unavailable')).not.toBeNull()
    expect(boxOf(mount, 'context-role')).toBeNull()
    expect(harness.setSearchParams).toHaveBeenCalled()
    expect(harness.toast.warning).toHaveBeenCalled()
  })
})
