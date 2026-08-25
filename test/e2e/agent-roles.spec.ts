import type { Request } from '@playwright/test'
import { buildCaseWorld, caseToFixture } from '../cases'
import { expect, type Locator, type Page, test } from './fixtures'

const WORLD = caseToFixture(buildCaseWorld('agent-roles', { now: '2099-08-05T12:00:00.000Z' }))

// One page of the library is 50 roles and one page of the explorer is 30, so a world
// that proves continuation has to carry more than that. Seeding them is what makes
// `nextCursor` the server's answer instead of a rewritten response.
const PAGED_WORLD = {
  ...WORLD,
  agentRoles: [
    ...(WORLD.agentRoles ?? []),
    ...Array.from({ length: 60 }, (_, index) => {
      const number = String(index + 1).padStart(2, '0')
      return {
        source: 'custom' as const,
        name: `paging-proof-${number}`,
        description: `Fills page one so a second page exists (${number}).`,
        instructions: `# Paging proof ${number}\n\nExists to push the listing past one page.`,
        target: { kind: 'personal' as const, user: 'maya' },
      }
    }),
  ],
}

// The same world under a library bound low enough for the seeded placements to cross
// it, so `truncated` is what the listing reports rather than what a route rewrote.
const BOUNDED_WORLD = { ...WORLD, limits: { libraryPackages: 1 } }

// The abilities world at volume — the one that declares owner Enable/Disable rows.
// It is here because a browser gate is the only place the SEEDED state can be told
// apart from the one a test produced by clicking the toggle itself.
const ABILITIES_WORLD = caseToFixture(
  buildCaseWorld('agent-abilities-rich', { now: '2099-08-05T12:00:00.000Z' }),
)

/** The Roles rail of this world, top to bottom: closest-to-the-user first — Personal,
 *  then the active Space and the project inside it — then the packaged System
 *  inventory, and the Catalog shelf last. Stated WHOLE rather than as a containment
 *  plus two index comparisons: a group that appears twice, or one that should not be
 *  in a Space-scoped rail at all, is the same bug as a wrong order.
 *
 *  Each entry is SCOPE plus label, not the label alone. The seed gives the Space and
 *  its project the same display name on purpose (`test/cases/cases/agentRoles.ts`),
 *  and that is a case in its own right — the rail must keep them apart by scope
 *  without spelling an address into the caption. Read as labels only, the expected
 *  value carried the ambiguity itself (`['Personal', 'Team', 'Team', …]`), so a rail
 *  that rendered the Space group twice and lost the project group matched it exactly. */
const EXPLORER_GROUP_ORDER = [
  'personal:Personal',
  'space:Team',
  'project:Team',
  'system:System',
  'catalog:Catalog',
]

/** The rail's groups as ONE retrying read: scope and label of every group row, in tree
 *  order. Both come off the SAME element in one pass — two locator reads can straddle
 *  a re-render and pair one row's label with another row's scope. `expect.poll` is
 *  what retries it: a tree that is still filling reads as an empty rail, and that is a
 *  wrong answer, not a slow one. */
const explorerGroups = (explorer: Locator) => async () =>
  await explorer
    .getByTestId('agents-explorer-group')
    .evaluateAll((nodes) =>
      nodes.map(
        (node) => `${node.getAttribute('data-group') ?? '?'}:${(node.textContent ?? '').trim()}`,
      ),
    )

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: WORLD } })
})

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
})

const login = async (page: Page, username = 'sergey', password = username) => {
  await page.goto('/')
  await page.getByTestId('auth-username').fill(username)
  await page.getByTestId('auth-password').fill(password)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('auth-login')).not.toBeVisible()
}

const setAbilityInstructions = async (page: Page, instructions: string) => {
  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(instructions)
  const marker = instructions.split('\n').filter(Boolean).at(-1) ?? instructions
  await expect(editor).toContainText(marker.slice(0, 32))
}

/** The global right-aside is a PERSISTED preference, and this is its storage key
 *  (`STORAGE_KEYS.asideOpen`). Read rather than guessed from the DOM on purpose: the
 *  aside and its opener are mutually exclusive and both are portaled into hosts a page
 *  mounts as `null`, so two consecutive DOM reads can straddle a frame in which neither
 *  is painted. A helper that samples such a frame goes on to click an opener that is not
 *  there yet and waits out the whole timeout. The preference has no such frame: nothing
 *  but this spec's own clicks ever changes it.
 *
 *  Since #393 a route of this section no longer goes panel-less: every state, including
 *  the skeleton and the error screen, mounts one. `AgentsPanel`'s empty-`panels` guard
 *  stays as a guard, not as a state any route of the section reaches. */
const ABILITY_ASIDE_PREFERENCE = 'bm-aside'

/** Leave the ability aside open, whatever it was doing when we arrived. */
const openAbilityPanel = async (page: Page) => {
  const asideOpen = await page.evaluate(
    (key) => localStorage.getItem(key) === '1',
    ABILITY_ASIDE_PREFERENCE,
  )

  if (!asideOpen) {
    // No branch on what is currently painted: the click auto-waits for the opener
    // this preference guarantees will arrive.
    await page.getByRole('button', { name: /Open (role|skill) details/ }).click()
  }
  await expect(page.getByTestId('aside-groups')).toBeVisible()
}

const pickAbilityAction = async (page: Page, action: string) => {
  await page.getByTestId('ability-detail-menu').click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

const pickDataset = async (page: Page, dataset: string) => {
  await page.getByTestId('agents-explorer-picker').click()
  await page.getByRole('menuitemradio', { name: dataset, exact: true }).click()
}

/** The Agents section as the rail reaches it, inside the shared Team space. */
const openTeamAgents = async (page: Page) => {
  await login(page, 'maya')
  await page.getByTestId('space-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Team', exact: true }).click()
  await expect(page).toHaveURL(/\/s\/team$/)

  await page.getByTestId('rail-agents').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles$/)
  await expect(page.getByTestId('agents-roles')).toBeVisible()
  // The rail's tree is a SECOND surface with its own request: the library page being
  // painted says nothing about it. Every caller below reads the tree first, so the
  // helper hands back an explorer that has already answered — otherwise a caller that
  // takes a non-retrying snapshot of it (`evaluateAll`) reads the empty skeleton.
  await expect(
    page.getByTestId('agents-explorer-roles').getByTestId('agents-explorer-group').first(),
  ).toBeVisible()
  return page.getByTestId('agents-explorer-picker')
}

/** A failed continuation must stay parked until the user asks again. The loop that
 *  would resume it is an IntersectionObserver over the sentinel, so scrolling the
 *  sentinel out of view and back fires exactly the event a live loop answers — a
 *  wall-clock wait would only prove a retry was slower than the wait. The button also
 *  has to READ as parked: `Retry`, enabled, not `Loading…`. */
const expectParkedOnRetry = async (root: Locator) => {
  const sentinel = root.getByRole('button', { name: 'Retry', exact: true })

  await expect(sentinel).toBeEnabled()
  await sentinel.evaluate((node) => {
    for (let element = node.parentElement; element; element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight) {
        element.scrollTop = 0
        return
      }
    }
    window.scrollTo(0, 0)
  })
  await sentinel.scrollIntoViewIfNeeded()
  await expect(sentinel).toBeEnabled()
  // The counter snapshots the callers take after this are NEGATIVE assertions
  // ("nothing asked again"), and a negative assertion cannot be retried into truth —
  // `expect.poll` would pass on its first evaluation just as a bare `expect` does.
  // What makes one honest is taking it late enough: a resumed continuation is issued
  // from the observer's callback, which lands in a frame of its own, so the snapshot
  // waits out those frames and then a round trip the browser could only have ordered
  // BEHIND the request a resumption would already have sent.
  await root.page().evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      }),
  )
  await root.page().evaluate(async () => {
    await fetch('/api/me').catch(() => undefined)
  })
}

/** The editor aside hosts SETTINGS, never commands: every button it owns belongs to
 *  the placement segment. A per-setting apply or a per-row detach beside the
 *  document's single Save shows up here as one more button. */
const expectAsideHasNoCommands = async (aside: Locator) => {
  const placement = aside.getByRole('group', { name: 'Belongs to' }).getByRole('button')
  await expect(placement.first()).toBeVisible()
  await expect(aside.getByRole('button')).toHaveCount(await placement.count())
}

test('@v15 the Agents shell opens on Roles under one main with a natural explorer', async ({
  page,
}) => {
  const picker = await openTeamAgents(page)

  await expect(page.locator('main.main')).toHaveCount(1)
  await expect(picker).toHaveAttribute('data-dataset', 'roles')
  await expect(picker).toHaveAttribute('data-mode', 'natural')
  await expect(page.getByTestId('agents-explorer-roles')).toBeVisible()
})

test('@v15 the Roles explorer groups read closest-to-the-user first', async ({ page }) => {
  const picker = await openTeamAgents(page)
  const roles = page.getByTestId('agents-explorer-roles')

  // Groups read closest-to-the-user first and are ordinary collapsible tree rows,
  // the same shape the Memory dataset uses.
  await expect.poll(explorerGroups(roles)).toEqual(EXPLORER_GROUP_ORDER)

  await expect(roles.getByTestId('agents-explorer-group').first()).toHaveCSS(
    'text-transform',
    'none',
  )
  await expect(picker.locator('span')).toHaveCSS('text-transform', 'uppercase')
  await expect(roles.locator('a[href*="/agents/abilities/roles/owned/"]').first()).toBeVisible()
  await expect(roles.locator('a[href*="/agents/abilities/roles/system/"]').first()).toBeVisible()
})

test('@v15 the Catalog group is a shelf that starts closed', async ({ page }) => {
  await openTeamAgents(page)
  const roles = page.getByTestId('agents-explorer-roles')
  const catalog = roles.getByTestId('agents-explorer-group').filter({ hasText: 'Catalog' })

  // Catalog is a template shelf, so it starts collapsed and opens on demand.
  await expect(roles.locator('a[href*="/agents/abilities/roles/catalog/"]')).toHaveCount(0)
  await catalog.getByRole('button', { name: 'Toggle' }).click()
  await expect(roles.locator('a[href*="/agents/abilities/roles/catalog/"]').first()).toBeVisible()
})

test('@v15 a manual explorer dataset outlives a reload and a new-tab click', async ({ page }) => {
  const picker = await openTeamAgents(page)
  const libraryUrl = page.url()

  await pickDataset(page, 'Sessions')
  await expect(page).toHaveURL(libraryUrl)
  await expect(picker).toHaveAttribute('data-dataset', 'sessions')
  await expect(picker).toHaveAttribute('data-mode', 'manual')
  await expect(page.getByTestId('agents-explorer-sessions')).toBeVisible()

  await page.reload()
  await expect(picker).toHaveAttribute('data-dataset', 'sessions')
  await expect(picker).toHaveAttribute('data-mode', 'manual')

  const [contextTab] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByTestId('agents-tab-context').click({ modifiers: ['Control'] }),
  ])
  await contextTab.close()
  await expect(page).toHaveURL(libraryUrl)
  await expect(picker).toHaveAttribute('data-dataset', 'sessions')
  await expect(picker).toHaveAttribute('data-mode', 'manual')
})

test('@v15 an explicit subsection reveals its dataset and a manual pick keeps the route', async ({
  page,
}) => {
  const picker = await openTeamAgents(page)

  await page.getByTestId('agents-tab-context').click()
  await expect(page).toHaveURL(/\/agents\/context$/)
  await expect(picker).toHaveAttribute('data-dataset', 'memory')
  await expect(picker).toHaveAttribute('data-mode', 'natural')

  await pickDataset(page, 'Roles')
  await expect(page).toHaveURL(/\/agents\/context$/)
  await expect(picker).toHaveAttribute('data-dataset', 'roles')
  await expect(picker).toHaveAttribute('data-mode', 'manual')
})

test('@v15 a manual dataset survives opening an entity and coming back', async ({ page }) => {
  const picker = await openTeamAgents(page)

  await page.getByTestId('agents-tab-context').click()
  await pickDataset(page, 'Roles')
  const ownedRole = page
    .getByTestId('agents-explorer-roles')
    .locator('a[href*="/agents/abilities/roles/owned/"]')
    .first()
  await ownedRole.click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/owned\//)
  await expect(page.getByTestId('agent-ability-detail')).toBeVisible()
  await expect(page.locator('main.main')).toHaveCount(1)
  await expect(picker).toHaveAttribute('data-dataset', 'roles')
  await expect(picker).toHaveAttribute('data-mode', 'manual')

  await page.goBack()
  await expect(page).toHaveURL(/\/agents\/context$/)
  await page.getByTestId('agents-tab-context').click()
  await expect(picker).toHaveAttribute('data-dataset', 'memory')
  await expect(picker).toHaveAttribute('data-mode', 'natural')
})

test('@v17 Roles explorer scopes to the active Space and keeps Personal alongside it', async ({
  page,
}) => {
  await login(page, 'maya')
  const explorerRequests: URL[] = []

  page.on('request', (request) => {
    const url = new URL(request.url())

    if (url.pathname === '/api/me/agent-roles' && url.searchParams.get('limit') === '30') {
      explorerRequests.push(url)
    }
  })

  await page.getByTestId('space-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Team', exact: true }).click()
  await page.goto('/agents/abilities/roles')
  const explorer = page.getByTestId('agents-explorer-roles')
  await expect(explorer.locator('a[href*="/agents/abilities/roles/owned/"]').first()).toBeVisible()
  // The pre-cap filter is the whole point: the active Space is listed whole rather
  // than competing with every readable Space for one bounded scan.
  await expect.poll(() => explorerRequests.length).toBeGreaterThan(0)
  expect(explorerRequests.every((url) => url.searchParams.has('spaceId'))).toBe(true)

  const groups = explorer.getByTestId('agents-explorer-group')
  // Personal is the cross-space fallback, so it rides along whatever Space is active.
  await expect(groups.filter({ hasText: 'Personal' })).toHaveCount(1)
  // The seed gives the Space and its project the same display name on purpose: they
  // stay distinguishable by scope, without an address in the caption.
  await expect(groups.filter({ hasText: 'Team' }).and(explorer.locator('[data-group="space"]'))) //
    .toHaveCount(1)
  await expect(
    groups.filter({ hasText: 'Team' }).and(explorer.locator('[data-group="project"]')),
  ).toHaveCount(1)
})

test('@v17 opening an entity from a manually picked dataset keeps the tree loaded', async ({
  page,
}) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')
  const picker = page.getByTestId('agents-explorer-picker')
  await picker.click()
  await page.getByRole('menuitemradio', { name: 'Skills', exact: true }).click()

  const skills = page.getByTestId('agents-explorer-skills')
  await expect(skills.locator('a[href*="/agents/abilities/skills/owned/"]').first()).toBeVisible()
  // Navigating changes the route's NATURAL dataset while the manual pick stands; the
  // tree must keep its rows instead of dropping into a skeleton nobody reloads.
  await skills.locator('a[href*="/agents/abilities/skills/owned/"]').first().click()
  await expect(page).toHaveURL(/\/agents\/abilities\/skills\/owned\//)
  await expect(page.getByTestId('agents-explorer-skills')).toBeVisible()
  await expect(
    page.getByTestId('agents-explorer-skills').getByTestId('agents-explorer-group').first(),
  ).toBeVisible()
})

test('@v17 explorer groups collapse, persist and start with Catalog closed', async ({ page }) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')
  const explorer = page.getByTestId('agents-explorer-roles')
  const catalog = explorer.getByTestId('agents-explorer-group').filter({ hasText: 'Catalog' })
  const personal = explorer.getByTestId('agents-explorer-group').filter({ hasText: 'Personal' })
  await expect(catalog).toHaveAttribute('aria-expanded', 'false')
  await expect(personal).toHaveAttribute('aria-expanded', 'true')

  await personal.getByRole('button', { name: 'Toggle' }).click()
  await expect(personal).toHaveAttribute('aria-expanded', 'false')

  await page.reload()
  await expect(
    explorer.getByTestId('agents-explorer-group').filter({ hasText: 'Personal' }),
  ).toHaveAttribute('aria-expanded', 'false')
})

test('@v17 the explorer head creates the dataset it is showing', async ({ page }) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')
  await page.getByTestId('new-ability').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/new\//)

  await page.goto('/agents/abilities/skills')
  await page.getByTestId('new-ability').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/skills\/new\//)
})

test('@v17 the explorer rail stays whole in the editor and on a draft route', async ({ page }) => {
  const picker = await openTeamAgents(page)
  const roles = page.getByTestId('agents-explorer-roles')

  // Reading a role keeps the rail (covered elsewhere); EDITING one is where a
  // section-sized surface is tempting to take over the whole frame, and the draft
  // route is worse still — a draft has no package to navigate back from, so a rail
  // that disappears there strands the user in the one place with no way back.
  await expect.poll(explorerGroups(roles)).toEqual(EXPLORER_GROUP_ORDER)
  await roles.locator('a[href*="/agents/abilities/roles/owned/"]').first().click()
  await expect(page.getByTestId('agent-ability-detail')).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByTestId('ability-editor')).toBeVisible()
  await expect(page.locator('main.main')).toHaveCount(1)
  await expect(picker).toHaveAttribute('data-dataset', 'roles')
  // Whole, not merely present: an editor that swaps the tree for a skeleton or drops
  // every group but the one being edited passes a visibility check and still loses
  // the surface the user navigated with.
  await expect.poll(explorerGroups(roles)).toEqual(EXPLORER_GROUP_ORDER)

  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()

  await page.goto('/agents/abilities/roles')
  await page.getByTestId('role-create').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/new\//)
  await expect(page.getByTestId('ability-editor')).toBeVisible()
  await expect(picker).toHaveAttribute('data-dataset', 'roles')
  await expect.poll(explorerGroups(roles)).toEqual(EXPLORER_GROUP_ORDER)
})

test('@v18 a seeded owner Disable reaches the browser, and only at its own placement', async ({
  page,
  baseURL,
}) => {
  // Enable/Disable used to be a real-stand-only state: the fixture had no preference
  // channel, so a browser gate could only produce a disabled ability by clicking the
  // toggle — which proves the toggle, never the state a stand was seeded INTO. The
  // search narrows the listing instead of paging to the card, so this stays true of
  // the case however far it grows.
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: ABILITIES_WORLD } })
  await login(page, 'sergey')
  await page.getByTestId('space-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Product', exact: true }).click()
  await page.goto('/agents/abilities/roles?q=shared')

  // The same NAME at two placements, one row disabled: the override belongs to the
  // package, so the other placement must be untouched. A preference keyed by name
  // would switch both off and still look like a working seed.
  const shared = page.getByTestId('ability-owned-shared-reviewer')
  await expect(shared).toHaveCount(2)
  await expect(
    shared.filter({ hasText: 'Personal' }).getByRole('img', { name: 'Disabled' }),
  ).toBeVisible()
  await expect(
    shared.filter({ hasText: 'Product' }).getByRole('img', { name: 'Enabled' }),
  ).toBeVisible()

  // The other kind, at a Personal home — a skill the same owner disabled.
  await page.goto('/agents/abilities/skills?q=evidence-index')
  await expect(
    page.getByTestId('ability-owned-evidence-index').getByRole('img', { name: 'Disabled' }),
  ).toBeVisible()
})

test('@v17 a System ability is read-only wherever the UI reaches it', async ({ page }) => {
  await openTeamAgents(page)
  const roles = page.getByTestId('agents-explorer-roles')

  await roles.locator('a[href*="/agents/abilities/roles/system/"]').first().click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/system\//)
  await expect(page.getByTestId('agent-ability-detail')).toBeVisible()
  await openAbilityPanel(page)
  await expect(page.getByTestId('ability-settings')).toContainText('system')

  // Packaged WITH the product: there is no Edit, and the kebab that carries every
  // other mutation carries none of them here. Stated as the absence of the whole
  // mutating set rather than of one button, because a read-only surface that grows
  // exactly one command is the bug this guards.
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await page.getByTestId('ability-detail-menu').click()
  const items = page.getByRole('menuitem')
  await expect(items.first()).toBeVisible()
  await expect(items.filter({ hasText: /^(Edit|Delete|Add|Add version|Rename)$/ })).toHaveCount(0)
  // What an owner MAY do to a packaged ability is stop using it — that is a
  // preference of theirs, not a change to the package.
  await expect(items.filter({ hasText: /^(Enable|Disable)$/ })).toHaveCount(1)

  // …and this is the half the criterion asks for and no gate performed: the lever is
  // PRESSED, from a state the SEED produced rather than one this spec clicked itself.
  // Reading "Enable" here is the seeded preference arriving through the real door; a
  // gate that starts from enabled proves the button and never the state.
  await expect(items.filter({ hasText: /^Enable$/ })).toHaveCount(1)
  await page.getByRole('menuitem', { name: 'Enable', exact: true }).click()
  await expect(page.getByRole('menuitem')).toHaveCount(0)
  await page.getByTestId('ability-detail-menu').click()
  await expect(page.getByRole('menuitem', { name: 'Disable', exact: true })).toBeVisible()
})

test('@v15 continuation failures stay visible and bounded until explicit retry', async ({
  page,
  baseURL,
}) => {
  // The cursor is the server's: the world carries more roles than one page holds, so
  // only the FAILURE is simulated here.
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: PAGED_WORLD } })
  await login(page, 'maya')
  let explorerFailures = 0
  let libraryFailures = 0

  await page.route('**/api/me/agent-roles*', async (route) => {
    const url = new URL(route.request().url())

    if (!url.searchParams.has('cursor')) {
      await route.continue()
      return
    }
    if (url.searchParams.get('limit') === '30') {
      explorerFailures++
    } else {
      libraryFailures++
    }
    await route.abort('connectionfailed')
  })

  await page.goto('/agents/abilities/roles')
  // Both continuations are driven by their sentinel coming into view, and a real page
  // of rows keeps both below the fold — so both are asked for explicitly.
  for (const root of ['agents-explorer-roles', 'agents-roles']) {
    await page
      .getByTestId(root)
      .getByRole('button', { name: /Load more|Retry/ })
      .scrollIntoViewIfNeeded()
  }
  await expect(page.getByTestId('agents-explorer-more-error')).toBeVisible()
  await expect(page.getByTestId('ability-library-more-error')).toBeVisible()
  await expect
    .poll(() => ({ explorerFailures, libraryFailures }))
    .toEqual({ explorerFailures: 1, libraryFailures: 1 })

  await expectParkedOnRetry(page.getByTestId('agents-explorer-roles'))
  await expectParkedOnRetry(page.getByTestId('agents-roles'))
  // Snapshots, not polls: the claim is that NOTHING asked again, and the helper above
  // has already waited out the frames and the round trip a resumption would have
  // ridden — see its note.
  expect({ explorerFailures, libraryFailures }).toEqual({ explorerFailures: 1, libraryFailures: 1 })

  await page
    .getByTestId('agents-explorer-roles')
    .getByRole('button', { name: 'Retry', exact: true })
    .click()
  await expect.poll(() => explorerFailures).toBe(2)
  await expectParkedOnRetry(page.getByTestId('agents-explorer-roles'))
  expect(explorerFailures).toBe(2)
})

test('@v15 an open Sessions explorer follows owner session changes live', async ({ page }) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')

  const picker = page.getByTestId('agents-explorer-picker')
  await picker.click()
  await page.getByRole('menuitemradio', { name: 'Sessions', exact: true }).click()
  const sessions = page.getByTestId('agents-explorer-sessions')
  await expect(sessions).toBeVisible()

  const response = await page.evaluate(async () => {
    const result = await fetch('/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'start_session',
          arguments: { session: { name: 'Live explorer proof' } },
        },
      }),
    })
    return { ok: result.ok, status: result.status }
  })
  expect(response).toEqual({ ok: true, status: 200 })
  await expect(sessions.getByText('Live explorer proof', { exact: true })).toBeVisible()
})

test('@v15 Sessions reconciles a mutation missed while SSE is disconnected', async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource
    const sources: EventSource[] = []
    Object.defineProperty(window, '__notariumEventSources', {
      configurable: true,
      value: sources,
    })
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(url, eventSourceInitDict)
        sources.push(this)
      }
    }
  })
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')

  const initialSessions = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/me/agent-sessions' && url.searchParams.get('limit') === '30'
  })
  await page.getByTestId('agents-explorer-picker').click()
  await page.getByRole('menuitemradio', { name: 'Sessions', exact: true }).click()
  await (await initialSessions).finished()
  const sessions = page.getByTestId('agents-explorer-sessions')
  await expect(sessions).toBeVisible()
  await expect(sessions.getByText('Reconnect explorer proof', { exact: true })).toHaveCount(0)

  await page.waitForFunction(() => {
    const sources = (window as typeof window & { __notariumEventSources?: readonly EventSource[] })
      .__notariumEventSources
    return sources?.some((source) => source.readyState === EventSource.OPEN)
  })
  const closedState = await page.evaluate(() => {
    const sources = (window as typeof window & { __notariumEventSources?: readonly EventSource[] })
      .__notariumEventSources
    const source = [...(sources ?? [])]
      .reverse()
      .find((candidate) => candidate.readyState === EventSource.OPEN)

    if (!source) {
      throw new Error('no open EventSource to disconnect')
    }
    source.close()
    source.dispatchEvent(new Event('error'))
    return source.readyState
  })
  expect(closedState).toBe(2)

  // The mutation has to land while the stream is DOWN, or this proves live delivery
  // instead of reconciliation. That is a state, not a delay: no source may be open.
  await page.waitForFunction(() => {
    const sources = (window as typeof window & { __notariumEventSources?: readonly EventSource[] })
      .__notariumEventSources
    return !sources?.some((source) => source.readyState === EventSource.OPEN)
  })
  const response = await page.request.post(`${baseURL}/mcp`, {
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'start_session',
        arguments: { session: { name: 'Reconnect explorer proof' } },
      },
    },
  })
  expect(response.ok()).toBe(true)

  await expect(sessions.getByText('Reconnect explorer proof', { exact: true })).toBeVisible({
    timeout: 10_000,
  })
})

test('@v15 removed ability routes fail honestly', async ({ page }) => {
  await login(page, 'maya')

  await page.goto('/agents/roles')
  await expect(page.getByTestId('page-not-found')).toBeVisible()

  await page.goto('/skill/dead-address')
  await expect(page.getByTestId('page-not-found')).toBeVisible()
})

test('@v15 narrow explorer is an accessible temporary drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')

  const toggle = page.getByTitle('Open sidebar')
  await expect(toggle).toBeVisible()
  await toggle.click()

  const drawer = page.getByRole('dialog', { name: 'Explorer' })
  await expect(drawer).toBeVisible()
  await expect(page.locator('main.main')).toHaveAttribute('inert', '')
  await expect(page.locator('main.main')).toHaveAttribute('aria-hidden', 'true')
  expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true)

  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(toggle).toBeFocused()
  await expect(page.locator('main.main')).not.toHaveAttribute('inert', '')

  await toggle.click()
  await page.getByTestId('rail-graph').click()
  await expect(page).toHaveURL(/\/s\/maya-home\/graph$/)
  await expect(drawer).toHaveCount(0)

  const graphToggle = page.getByTitle('Open sidebar')
  await graphToggle.click()
  await expect(drawer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(graphToggle).toBeFocused()

  await page.keyboard.press('[')
  await expect(drawer).toBeVisible()
  await page.getByTestId('rail-trash').click()
  await expect(page).toHaveURL(/\/s\/maya-home\/trash$/)
  await expect(drawer).toHaveCount(0)

  const trashToggle = page.getByTitle('Open sidebar')
  await trashToggle.click()
  await expect(drawer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trashToggle).toBeFocused()
})

test('@v14 catalog preview and Add land on exact routed ability pages', async ({ page }) => {
  await login(page, 'maya')
  await page.getByTestId('space-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Team', exact: true }).click()
  await page.goto('/agents/abilities/roles')

  await expect(page.getByTestId('agents-roles')).toBeVisible()
  await page.getByTestId('ability-catalog-grooming').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/catalog\//)
  await openAbilityPanel(page)
  await expect(page.getByTestId('ability-settings')).toContainText('Shape ambiguous work')
  await expect(page.getByText('Establish the underlying pain')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)

  await pickAbilityAction(page, 'Add')
  const add = page.getByTestId('catalog-ability-add-dialog')
  await expect(add).toContainText('Choose where the Catalog role becomes an Owned package.')
  await add.getByRole('button', { name: 'Project', exact: true }).click()
  await add.getByTestId('catalog-add-project').click()
  await page.getByRole('menuitemradio', { name: 'Alpha', exact: true }).click()
  await add.getByTestId('catalog-ability-add-dialog-submit').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/owned\//)
  const detail = page.getByTestId('agent-ability-detail')
  await openAbilityPanel(page)
  await expect(page.getByTestId('ability-settings')).toContainText('catalog')
  // Added into a project that has no same-name Space base: it belongs to that
  // project, named the way the user named it — not to an internal slot (#309 V18).
  await expect(page.getByTestId('ability-settings')).toContainText('Belongs to')
  await expect(page.getByTestId('ability-settings')).toContainText('Alpha')
  await expect(detail).toContainText('Establish the underlying pain')
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
})

test('@v16 cards expose canonical state and working quick actions', async ({ page }) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')

  const card = page.getByTestId('ability-owned-release-captain')
  await expect(card.getByRole('heading', { name: 'Release captain' })).toBeVisible()
  await expect(card.getByRole('img', { name: 'Enabled' })).toBeVisible()
  await expect(card).toContainText('Personal')
  await expect(card).toContainText('Custom')

  const menu = page.getByTestId('ability-owned-release-captain-menu')
  await menu.click()
  await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Configure context' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Disable' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Disable' }).click()
  const disabledStatus = card.getByRole('img', { name: 'Disabled' })
  await expect(disabledStatus).toBeVisible()
  await expect
    .poll(() => disabledStatus.evaluate((node) => getComputedStyle(node).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)')

  await menu.click()
  await page.getByRole('menuitem', { name: 'Enable' }).click()
  await expect(card.getByRole('img', { name: 'Enabled' })).toBeVisible()

  await menu.click()
  await page.getByRole('menuitem', { name: 'Configure context' }).click()
  await expect(page).toHaveURL(/\/agents\/context\?role=/)
  await expect(page.getByTestId('context-role-selector')).toContainText('Release captain')
  await expect(page.getByText('That role is no longer available here.')).toHaveCount(0)
  await expect(page.getByLabel('Breadcrumb')).toContainText(
    'Agents/Context/Personal/Release captain',
  )

  await page.goto('/agents/abilities/skills')
  const skillCard = page.getByTestId('ability-owned-meeting-brief')
  await expect(skillCard.getByRole('heading', { name: 'Meeting brief' })).toBeVisible()
  await expect(skillCard.getByRole('img', { name: 'Enabled' })).toBeVisible()
  await skillCard.getByTestId('ability-owned-meeting-brief-menu').click()
  await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Disable' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Configure context' })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/abilities\/skills\/owned\//)
  await expect(page.getByTestId('ability-editor')).toBeVisible()
})

test('@v16 project and Space role actions configure their exact Context scope', async ({
  page,
}) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')

  // A project version is not a card of its own (#309 V18) — it is reached from the
  // base it overrides, and configures its own exact Context from there.
  const teamCard = page.getByTestId('ability-owned-research').filter({ hasText: 'Version · Team' })
  await expect(teamCard).toHaveCount(1)
  await teamCard.click()
  await openAbilityPanel(page)
  await page.getByTestId('ability-settings').getByRole('link', { name: 'Team' }).click()
  await openAbilityPanel(page)
  // It belongs to the project and says what it overrides — with a link back, because
  // a version has no card of its own.
  await expect(page.getByTestId('ability-settings')).toContainText('Overrides')
  await pickAbilityAction(page, 'Configure context')
  await expect(page).toHaveURL(/\/agents\/context\/[^?]+\?role=/)
  await expect(page.getByTestId('context-role-selector')).toContainText('Research')
  await expect(page.getByText('That role is no longer available here.')).toHaveCount(0)

  await page.goto('/agents/abilities/roles')
  const spaceCard = page.getByTestId('ability-owned-research').filter({ hasText: 'Version · Team' })
  await expect(spaceCard).toHaveCount(1)
  await spaceCard.getByTestId('ability-owned-research-menu').click()
  const configure = page.getByRole('menuitem', { name: 'Configure context' })
  await configure.hover()
  await page.getByRole('menuitem', { name: 'Alpha', exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/context\/alpha\?role=/)
  await expect(page.getByTestId('context-role-selector')).toContainText('Research')
  await expect(page.getByText('That role is no longer available here.')).toHaveCount(0)
  await expect(page.getByTestId('space-switcher')).toContainText('Team')
})

test('@v16 the global aside stays user-controlled across read, edit and sections', async ({
  page,
}) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')
  await page.getByTestId('ability-owned-release-captain').click()
  await expect(page.getByLabel('Breadcrumb')).toContainText(
    'Agents/Abilities/Roles/Release captain',
  )
  await expect(page.getByTestId('agent-ability-detail')).toHaveCSS('padding-top', '0px')
  await expect(page.getByTestId('topbar-action-separator')).toBeVisible()

  await openAbilityPanel(page)
  const readSettings = page.getByTestId('ability-settings')
  await expect(readSettings).toBeVisible()
  await expect(readSettings.getByRole('switch')).toHaveCount(0)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByTestId('ability-editor-aside')).toBeVisible()
  await expect(page.getByTestId('editor-body-column')).toHaveCSS('padding-top', '0px')
  const editorAside = page.getByTestId('ability-editor-aside')
  await expect(editorAside.getByRole('checkbox').first()).toBeVisible()
  // A skill is attached and detached by its own checkbox: no per-row command sits
  // beside it, and none may appear.
  await expectAsideHasNoCommands(editorAside)
  // Enable/Disable is an operation, not a field: it belongs to the kebab, so the
  // editor carries no switch that would commit outside the document's Save.
  await expect(page.getByTestId('ability-editor').getByRole('switch')).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(readSettings).toBeVisible()

  await page.getByRole('button', { name: 'Close role details' }).click()
  await page.getByTestId('agent-library-tab-skills').click()
  await expect(page.getByTestId('package-library-filters')).toHaveCount(0)
  await page.getByRole('button', { name: 'Open library filters' }).click()
  await expect(page.getByTestId('package-library-filters')).toBeVisible()
  await page.getByTestId('agent-library-tab-roles').click()
  await expect(page.getByTestId('package-library-filters')).toBeVisible()
  await page.getByTestId('ability-owned-release-captain').click()
  await expect(page.getByTestId('ability-settings')).toBeVisible()
})

test('@v14 project drafts expose exact project identities and eligible skills only', async ({
  page,
}) => {
  await login(page, 'maya')
  await page.getByTestId('space-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Team', exact: true }).click()
  await page.goto('/agents/abilities/roles')
  await page.getByTestId('role-create').click()
  await openAbilityPanel(page)

  // One question, one list (#309 V18): the whole Space, or the projects it covers.
  const belongsTo = page.getByRole('group', { name: 'Belongs to' })
  await belongsTo.getByRole('button', { name: 'Projects', exact: true }).click()
  const projects = page.getByRole('group', { name: 'Available projects' })
  // There is no second "All projects" row under it — that answer IS the Space segment,
  // and asking the same question twice is how the two answers start disagreeing.
  await expect(projects.getByRole('checkbox', { name: 'All projects', exact: true })).toHaveCount(0)
  // A project reads by its name; the handle joins in only for the two the seed
  // deliberately names alike.
  await expect(projects.getByRole('checkbox', { name: 'Team · team', exact: true })).toBeVisible()
  for (const name of ['Team · team', 'Team · team/other', 'Beta', 'Gamma']) {
    await projects.getByText(name, { exact: true }).click()
  }
  await expect(projects.getByRole('checkbox', { name: 'Alpha', exact: true })).toBeChecked()

  const aside = page.getByTestId('ability-editor-aside')
  await expect(aside.getByRole('checkbox', { name: /Coder/ })).toBeVisible()
  await expect(aside.getByRole('checkbox', { name: /Team tone/ })).toBeVisible()
  await expect(aside.getByRole('checkbox', { name: /Release check/ })).toHaveCount(0)

  await page.getByTestId('ability-description').fill('Reviews evidence for Alpha work.')
  await setAbilityInstructions(page, '# Alpha reviewer\n\nInspect the Alpha evidence.')
  const coderSkill = aside.getByRole('checkbox', { name: /Coder/ })
  await coderSkill.locator('..').click()
  await expect(coderSkill).toBeChecked()
  await page.getByTestId('ability-save').click()

  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/owned\//)
  await expect(page.getByTestId('agent-ability-detail')).toContainText('Coder · healthy')
})

test('@v14 a role draft survives reload and publishes exact attachments', async ({ page }) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')
  await page.getByTestId('role-create').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/new\//)
  const draftUrl = page.url()

  await openAbilityPanel(page)
  await page.getByTestId('ability-description').fill('Keeps release evidence complete.')
  await setAbilityInstructions(page, '# Release auditor\n\nCheck evidence before handoff.')
  const meetingBriefSkill = page
    .getByTestId('ability-editor-aside')
    .getByRole('checkbox', { name: /Meeting brief/ })
  await meetingBriefSkill.locator('..').click()
  await expect(meetingBriefSkill).toBeChecked()

  await page.getByTestId('agent-library-tab-skills').click()
  const discard = page.getByRole('dialog')
  await expect(discard).toContainText('Discard unsaved changes?')
  await discard.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(draftUrl)

  page.once('dialog', (dialog) => void dialog.accept())
  await page.reload()
  await expect(page.locator('.cm-content')).toContainText('Release auditor')
  await expect(page.getByTestId('ability-description')).toHaveValue(
    'Keeps release evidence complete.',
  )
  await expect(page.locator('.cm-content')).toContainText('Check evidence before handoff.')
  await expect(page.getByTestId('ability-editor-aside')).toContainText('Meeting brief')

  await page.getByTestId('ability-save').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/owned\//)
  const detail = page.getByTestId('agent-ability-detail')
  await expect(detail).toContainText('Release auditor')
  await expect(detail).toContainText('Meeting brief · healthy')
})

test('@v24 a restored unavailable target blocks the global Save shortcut', async ({ page }) => {
  await openTeamAgents(page)
  await page.getByTestId('role-create').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/new\//)
  const draftUrl = page.url()

  await openAbilityPanel(page)
  await page.getByTestId('ability-description').fill('Must stay recoverable without publishing.')
  await setAbilityInstructions(page, '# Unavailable Personal\n\nKeep this draft local.')
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(sessionStorage).some((key) => key.startsWith('notarium:ability-draft:')),
      ),
    )
    .toBe(true)

  await page.route('**/api/me/agent-roles?*', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as {
      installAvailability?: { personal?: boolean }
    }

    await route.fulfill({
      response,
      json: {
        ...body,
        installAvailability: { ...body.installAvailability, personal: false },
      },
    })
  })
  let createCalls = 0

  await page.route('**/api/me/agent-roles/custom', async (route) => {
    createCalls++
    await route.continue()
  })
  page.once('dialog', (dialog) => void dialog.accept())
  await page.reload()

  await expect(page).toHaveURL(draftUrl)
  await expect(page.locator('.cm-content')).toContainText('Unavailable Personal')
  await expect(page.getByTestId('ability-save')).toBeDisabled()
  await page.keyboard.press('Control+Enter')
  await page.evaluate(async () => {
    await fetch('/api/me')
  })

  expect(createCalls).toBe(0)
  await expect(page).toHaveURL(draftUrl)
})

test('@v25 a restored stale Projects target blocks the global Save shortcut', async ({ page }) => {
  await openTeamAgents(page)
  await page.getByTestId('role-create').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/new\//)
  const draftUrl = page.url()

  await openAbilityPanel(page)
  await page
    .getByRole('group', { name: 'Belongs to' })
    .getByRole('button', {
      name: 'Projects',
      exact: true,
    })
    .click()
  await page.getByTestId('ability-description').fill('The selected projects disappeared.')
  await setAbilityInstructions(page, '# Stale Projects\n\nKeep this draft local.')
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(sessionStorage).some((key) => key.startsWith('notarium:ability-draft:')),
      ),
    )
    .toBe(true)

  await page.route(/\/api\/me\/agent-skills\?.*limit=100(?:&|$)/, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { projects?: unknown[] }

    await route.fulfill({ response, json: { ...body, projects: [] } })
  })
  let createCalls = 0

  await page.route('**/api/me/agent-roles/custom', async (route) => {
    createCalls++
    await route.abort()
  })
  page.once('dialog', (dialog) => void dialog.accept())
  await page.reload()

  await expect(page).toHaveURL(draftUrl)
  await expect(page.locator('.cm-content')).toContainText('Stale Projects')
  await expect(page.getByTestId('ability-save')).toBeDisabled()
  await page.keyboard.press('Control+Enter')
  await page.evaluate(async () => {
    await fetch('/api/me')
  })

  expect(createCalls).toBe(0)
  await expect(page).toHaveURL(draftUrl)
})

test('@v14 a truncated library remains honest and keeps routed catalog cards', async ({
  page,
  baseURL,
}) => {
  // The bound belongs to the server, so the world states a low one and the placements
  // cross it for real. A rewritten response would only prove the UI can paint a flag
  // it was handed.
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: BOUNDED_WORLD } })
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')

  await expect(
    page
      .locator('main.main')
      .getByTestId('agents-roles')
      .getByText('Some placements are outside this bounded view.'),
  ).toBeVisible()
  await expect(page.getByTestId('ability-catalog-grooming')).toBeVisible()
})

test('@v14 draft recovery is owner-bound across logout and principal change', async ({ page }) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/skills')
  await page.getByTestId('skill-create').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/skills\/new\//)
  const draftUrl = page.url()
  await openAbilityPanel(page)
  await page.getByTestId('ability-description').fill('Must never cross an owner boundary.')
  await setAbilityInstructions(page, '# Private draft\n\nOnly Maya may recover this text.')

  await page.getByTestId('profile-menu').click()
  await page.getByText('Sign out', { exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByTestId('auth-login')).toBeVisible()

  await page.getByTestId('auth-username').fill('bob')
  await page.getByTestId('auth-password').fill('bob')
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('auth-login')).not.toBeVisible()
  await page.goto(draftUrl)
  await expect(page.locator('.cm-content')).not.toContainText('Private draft')
  await openAbilityPanel(page)
  await expect(page.getByTestId('ability-description')).toHaveValue('')
  await expect(page.locator('.cm-content')).not.toContainText('Only Maya')
})

test('@v14 an invalid legacy attachment survives unrelated edits until explicit detach', async ({
  page,
}) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')
  await page.getByTestId('ability-owned-release-captain').click()

  const detail = page.getByTestId('agent-ability-detail')
  await expect(detail).toContainText('retired-helper')
  await expect(detail).toContainText('invalid-locator')
  await expect(detail).toContainText('Agent activation remains fail-closed')

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await openAbilityPanel(page)
  await page
    .getByTestId('ability-description')
    .fill('Coordinate a release while preserving the legacy attachment.')
  await page.getByTestId('ability-save').click()
  await expect(detail).toContainText('retired-helper')
  await expect(detail).toContainText('invalid-locator')

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const legacyAttachment = page.getByRole('checkbox', { name: /retired-helper/ })

  await legacyAttachment.locator('..').click()
  await expect(legacyAttachment).toHaveCount(0)
  await page.getByTestId('ability-save').click()
  await expect(detail).not.toContainText('retired-helper')
  await expect(detail).not.toContainText('Agent activation remains fail-closed')
})

test('@v17 Space skill availability leaves with the document under one Save', async ({ page }) => {
  await login(page, 'maya')
  await page.getByTestId('space-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Team', exact: true }).click()
  await page.goto('/agents/abilities/skills')
  await page.getByTestId('ability-owned-team-tone').click()

  const detail = page.getByTestId('agent-ability-detail')
  await expect(detail.getByRole('heading', { name: 'Team tone', level: 1 })).toHaveCount(1)
  await expect(detail).toContainText('Apply the Team writing voice')
  await openAbilityPanel(page)
  await expect(page.getByTestId('ability-settings')).toContainText('Team')
  // Read mode states the value; it does not hand the user a control.
  await expect(page.getByRole('group', { name: 'Belongs to' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  // A Skill answers the same one question a Role does (#309 V18): the whole Space,
  // or the projects it covers.
  const belongs = page.getByRole('group', { name: 'Belongs to' })
  await expect(belongs.getByRole('button', { name: 'Team', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // There is exactly ONE way to commit an edit here: the aside carries settings and
  // no commands, so no per-setting apply button can land a change beside the
  // document's Save.
  await expectAsideHasNoCommands(page.getByTestId('ability-editor-aside'))
  await belongs.getByRole('button', { name: 'Projects', exact: true }).click()
  const projectList = page.getByRole('group', { name: 'Available projects' })
  await expectAsideHasNoCommands(page.getByTestId('ability-editor-aside'))

  for (const name of ['Team · team', 'Team · team/other', 'Beta', 'Gamma']) {
    await projectList.getByText(name, { exact: true }).click()
  }
  const saveWrites: string[] = []

  const captureSaveWrite = (request: Request) => {
    const path = new URL(request.url()).pathname

    if (
      (request.method() === 'POST' && path === '/api/note') ||
      (request.method() === 'PUT' &&
        /\/api\/me\/agent-abilities\/[^/]+\/(?:save|home|availability)$/.test(path))
    ) {
      saveWrites.push(`${request.method()} ${path}`)
    }
  }
  page.on('request', captureSaveWrite)
  await page.getByTestId('ability-save').click()
  // One Save commits the document AND the setting, so leaving edit mode is the
  // signal that both landed — reloading before that races the second write.
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  page.off('request', captureSaveWrite)
  expect(saveWrites).toHaveLength(1)
  expect(saveWrites[0]).toMatch(/^PUT \/api\/me\/agent-abilities\/[^/]+\/save$/)

  await page.reload()
  await openAbilityPanel(page)
  await expect(page.getByTestId('ability-settings')).toContainText('Alpha')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(
    page.getByRole('group', { name: 'Belongs to' }).getByRole('button', { name: 'Projects' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('checkbox', { name: 'Alpha', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(detail).toContainText('Apply the Team writing voice')
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
})

test('@v18 one role carries its reach and its project versions instead of copies', async ({
  page,
}) => {
  await login(page, 'maya')
  await page.getByTestId('space-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Team', exact: true }).click()
  await page.goto('/agents/abilities/roles')

  // One card per role. The base and its version share a name by construction, and
  // two identically named cards read as a duplicate bug rather than as an override.
  const research = page.getByTestId('ability-owned-research')
  await expect(research).toHaveCount(2) // Personal and Team, not their four packages
  const launch = page.getByTestId('ability-owned-launch-review')
  await expect(launch).toContainText('2 of 5 projects')

  // The reach is a Role setting now, edited in the same aside and committed by the
  // one Save the document already has.
  await launch.click()
  await openAbilityPanel(page)
  await expect(page.getByTestId('ability-settings')).toContainText('Alpha')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const belongsTo = page.getByRole('group', { name: 'Belongs to' })
  await expect(belongsTo.getByRole('button', { name: 'Projects' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // Answering the whole Space and changing your mind is not an edit of WHICH projects
  // were chosen: the ticks come back as they were, and Save stays inert because the
  // user changed nothing. Losing them would silently widen the reach to every project.
  const availableProjects = page.getByRole('group', { name: 'Available projects' })
  await belongsTo.getByRole('button', { name: 'Team', exact: true }).click()
  await belongsTo.getByRole('button', { name: 'Projects' }).click()
  await expect(
    availableProjects.getByRole('checkbox', { name: 'Alpha', exact: true }),
  ).toBeChecked()
  await expect(
    availableProjects.getByRole('checkbox', { name: 'Gamma', exact: true }),
  ).not.toBeChecked()
  await expect(page.getByTestId('ability-save')).toBeDisabled()

  await availableProjects.getByText('Gamma', { exact: true }).click()
  await page.getByTestId('ability-save').click()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  await page.reload()
  await openAbilityPanel(page)
  await expect(page.getByTestId('ability-settings')).toContainText('Gamma')

  // The other half of the answer to copying: a version for one project, forked from
  // the base and opened straight into its own body.
  await page.getByTestId('ability-detail-menu').click()
  await page.getByRole('menuitem', { name: 'Add version', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Gamma', exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/owned\//)
  await expect(page.getByTestId('ability-editor')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await openAbilityPanel(page)
  // A version says what it belongs to AND what it overrides; a base of that name
  // exists, so the placement is a stated fact rather than a picker that pretends.
  await expect(page.getByTestId('ability-settings')).toContainText('Gamma')
  await expect(page.getByTestId('ability-settings')).toContainText('Overrides')

  // Back in the library it is still ONE role, with the version hanging off it.
  await page.goto('/agents/abilities/roles')
  await expect(page.getByTestId('ability-owned-launch-review')).toHaveCount(1)
  await expect(page.getByTestId('ability-owned-launch-review')).toContainText('Version · Gamma')
})

test('@v18 a project-only role changes what it belongs to, in the editor', async ({ page }) => {
  await login(page, 'maya')
  await page.getByTestId('space-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Team', exact: true }).click()
  await page.goto('/agents/abilities/roles')

  // The card names what the role belongs to, the same way the Explorer and the aside
  // do. It never had a Space base, so nothing overrides anything: no version chip.
  const guide = page.getByTestId('ability-owned-field-guide')
  await expect(guide).toContainText('Team')
  await expect(guide).not.toContainText('Version ·')
  await guide.click()
  const detail = page.getByTestId('agent-ability-detail')
  await expect(detail).toContainText('Work the project surface')
  await openAbilityPanel(page)
  // It belongs to the project, named the way the user named the project.
  await expect(page.getByTestId('ability-settings')).toContainText('Team')
  // Where it belongs is a PROPERTY, so it changes in the editor and commits with the
  // one Save the document already has — never as a command in a quick-actions menu.
  await expect(page.getByTestId('ability-detail-menu')).toBeVisible()
  await page.getByTestId('ability-detail-menu').click()
  // The kebab's whole item set, so a placement command has nowhere to hide in it:
  // Add version is a Space base's action and Edit is the topbar's own button.
  await expect(page.getByRole('menuitem')).toHaveText(['Configure context', 'Disable', 'Delete'])
  await page.keyboard.press('Escape')

  // One question, still live after publication: the whole Space, or the projects it
  // covers. Personal stays VISIBLE and disabled with its reason — silently dropping
  // an option sends the user hunting for something that is not available yet.
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const belongsTo = page.getByRole('group', { name: 'Belongs to' })
  await expect(belongsTo.getByRole('button', { name: 'Personal', exact: true })).toBeDisabled()
  await expect(belongsTo.getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // Adding a second project is the whole gesture. Where the package ends up living is
  // not asked about — that is ours.
  await page
    .getByRole('group', { name: 'Available projects' })
    .getByText('Alpha', { exact: true })
    .click()
  await page.getByTestId('ability-save').click()

  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  await openAbilityPanel(page)
  // Same body, and both projects — the one it served plus the one just ticked.
  // Nothing widened behind the user's back.
  await expect(detail).toContainText('Work the project surface')
  await expect(page.getByTestId('ability-settings')).toContainText('Alpha')
  await page.goto('/agents/abilities/roles')
  await expect(page.getByTestId('ability-owned-field-guide')).toContainText('2 of 5 projects')

  // …and the whole Space, through the same control.
  await page.getByTestId('ability-owned-field-guide').click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page
    .getByRole('group', { name: 'Belongs to' })
    .getByRole('button', { name: 'Team', exact: true })
    .click()
  await expect(page.getByRole('group', { name: 'Available projects' })).toHaveCount(0)
  await page.getByTestId('ability-save').click()

  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  await openAbilityPanel(page)
  await expect(page.getByTestId('ability-settings')).toContainText('Team')
  await expect(detail).toContainText('Work the project surface')

  // The mirror of the same rule, now that it belongs to the whole Space: looking at
  // the project list and coming back leaves the answer — and the Save button — where
  // they were. Dirty is judged on what the ability BELONGS TO, not on the fields the
  // control happened to touch on the way.
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const scope = page.getByRole('group', { name: 'Belongs to' })
  await scope.getByRole('button', { name: 'Projects', exact: true }).click()
  await scope.getByRole('button', { name: 'Team', exact: true }).click()
  await expect(page.getByTestId('ability-save')).toBeDisabled()
})

test('@v14 a Catalog skill is read-only and Add replaces it with an exact Owned route', async ({
  page,
}) => {
  await login(page, 'maya')
  await page.getByTestId('space-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Team', exact: true }).click()
  await page.goto('/agents/abilities/skills')
  await page.getByTestId('ability-catalog-grooming-evidence').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/skills\/catalog\//)
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await pickAbilityAction(page, 'Add')
  const add = page.getByTestId('catalog-ability-add-dialog')
  await expect(add).toContainText('Choose where the Catalog skill becomes an Owned package.')
  await add.getByRole('button', { name: 'Space', exact: true }).click()
  const allProjects = add.getByTestId('catalog-add-all-projects')
  await expect(allProjects).toHaveAttribute('aria-checked', 'true')
  await allProjects.click()
  await expect(add.getByRole('checkbox', { name: 'Alpha', exact: true })).toBeVisible()
  await add.getByRole('button', { name: 'Personal', exact: true }).click()
  await add.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(add).toHaveCount(0)

  await page.getByTestId('profile-menu').click()
  await page.getByText('Sign out', { exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await login(page)
  await page.goto('/agents/abilities/skills')
  await page.getByTestId('ability-catalog-grooming-evidence').click()
  await pickAbilityAction(page, 'Add')
  await page.getByTestId('catalog-ability-add-dialog-submit').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/skills\/owned\//)
  await openAbilityPanel(page)
  await expect(page.getByTestId('ability-settings')).toContainText('catalog')
  await expect(page.getByText('Read the current product contract')).toBeVisible()
})

test('@v14 explicit Cancel discards a routed skill draft and returns to its library', async ({
  page,
}) => {
  await login(page)
  await page.goto('/agents/abilities/skills')
  await page.getByTestId('skill-create').click()
  await setAbilityInstructions(
    page,
    `# Deep review\n\n${'Keep every acceptance detail in the draft. '.repeat(20)}`,
  )

  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  const discard = page.getByRole('dialog')
  await expect(discard).toContainText('Your new skill has not been published.')
  await discard.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/abilities\/skills$/)
  await expect(page.getByTestId('agents-skills')).toBeVisible()
})

test('@v14 Owned ability edits share the common CAS conflict flow', async ({ page, baseURL }) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/roles')
  await page.getByTestId('ability-owned-release-captain').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/owned\//)
  await expect(page.getByTestId('agent-ability-detail')).toBeVisible()
  const abilityUrl = page.url()
  const locator = decodeURIComponent(new URL(abilityUrl).pathname.split('/').at(-1)!)
  const ability = await (
    await page.request.get(`${baseURL}/api/me/agent-abilities/${encodeURIComponent(locator)}`)
  ).json()
  const note = await (
    await page.request.get(`${baseURL}/api/note?id=${encodeURIComponent(ability.ability.noteId)}`)
  ).json()

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await setAbilityInstructions(page, '# Release captain\n\nBody from tab one.')

  const external = await page.request.post(`${baseURL}/api/note`, {
    data: {
      originalId: ability.ability.noteId,
      versionToken: note.versionToken,
      content: '# Release captain\n\nBody from an external writer.',
    },
  })
  expect(external.status(), await external.text()).toBe(200)

  await page.getByTestId('ability-save').click()
  const conflict = page.getByRole('dialog')
  await expect(conflict).toContainText('Note changed on the server')
  await conflict.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('Body from tab one.')

  await page.getByTestId('ability-save').click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save my version', exact: true })
    .click()
  await expect(page.getByTestId('agent-ability-detail')).toContainText('Body from tab one.')
})

test('@v14 Skills keeps routed creation and Catalog discovery available', async ({ page }) => {
  await login(page)
  await page.goto('/agents/abilities/skills')

  await expect(page.getByTestId('skill-create')).toHaveCount(1)
  await expect(page.getByTestId('ability-catalog-grooming-evidence')).toBeVisible()
})

test('The shared library aside drives server filters and keeps them between Roles and Skills', async ({
  page,
}) => {
  await login(page, 'maya')
  await page.goto('/agents/abilities/skills')
  await page.getByRole('button', { name: 'Open library filters' }).click()

  await expect(page.getByTestId('package-library-filters')).toBeVisible()
  await page.getByTestId('package-library-search').fill('release')
  await expect(page).toHaveURL(/q=release/)
  const library = page.locator('main.main').getByTestId('agents-skills')
  await expect(library.getByText('Release check', { exact: true })).toBeVisible()
  await expect(library.getByText('Meeting brief', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Clear package search' }).click()
  await page
    .getByRole('group', { name: 'Package source' })
    .getByRole('button', { name: 'Mine' })
    .click()
  await page
    .getByRole('group', { name: 'Package home' })
    .getByRole('button', { name: 'Space' })
    .click()
  await page
    .getByRole('group', { name: 'Project availability' })
    .getByRole('button', { name: 'Selected' })
    .click()
  await page.getByTitle('team/alpha', { exact: true }).click()

  await expect(page).toHaveURL(
    /\/agents\/abilities\/skills\?source=owned&home=space&availability=selected&project=team%2Falpha$/,
  )
  await expect(library.getByText('Coder', { exact: true })).toBeVisible()
  await page.getByTestId('agent-library-tab-roles').click()
  await expect(page).toHaveURL(
    /\/agents\/abilities\/roles\?source=owned&home=space&availability=selected&project=team%2Falpha$/,
  )
  // The same three filters read the same way for a Role now: `selected` is a
  // narrowed Space base, which is what a role needed in two projects out of five has
  // instead of a copy (#309 V18).
  await expect(page.getByTestId('agents-roles')).toContainText('Launch review')
  await expect(page.getByTestId('package-library-filters')).toBeVisible()
})

test('Role library pagination appends a cursor page without leaking cursor into the URL', async ({
  page,
}) => {
  await login(page)
  let complete: Record<string, unknown> | null = null

  await page.route('**/api/me/agent-roles*', async (route) => {
    const url = new URL(route.request().url())

    // The section's own pill reads the same endpoint with `limit=1` — an unfiltered
    // count, not this list. Rewriting that answer too would hand the continuation a
    // one-row world and prove nothing about paging.
    if (url.searchParams.get('limit') === '1') {
      await route.fallback()
      return
    }
    if (url.searchParams.get('cursor') === 'browser-next' && complete) {
      const items = complete.items as unknown[]
      await route.fulfill({
        json: { ...complete, items: items.slice(1), nextCursor: null },
      })
      return
    }

    const response = await route.fetch()
    complete = (await response.json()) as Record<string, unknown>
    const items = complete.items as unknown[]
    await route.fulfill({
      response,
      json: { ...complete, items: items.slice(0, 1), nextCursor: 'browser-next' },
    })
  })

  await page.goto('/agents/abilities/roles')
  const cards = page
    .locator('main.main')
    .getByTestId('agents-roles')
    .locator('article[data-testid^="ability-"]')
  await expect.poll(() => cards.count()).toBeGreaterThan(1)
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(false)
})

test('The library aside uses the system modal behavior on a narrow viewport', async ({ page }) => {
  await login(page)
  await page.setViewportSize({ width: 390, height: 667 })
  await page.goto('/agents/abilities/roles')

  const open = page.getByRole('button', { name: 'Open library filters' })
  await open.click()
  const aside = page.getByRole('dialog', { name: 'Package library filters' })
  await expect(aside).toBeVisible()
  await expect(aside).toHaveAttribute('aria-modal', 'true')
  await expect(page.locator('main')).toHaveAttribute('inert', '')

  await page.keyboard.press('Escape')
  await expect(aside).toHaveCount(0)
  await expect(page.locator('main')).not.toHaveAttribute('inert', '')
  await expect(page.getByRole('button', { name: 'Open library filters' })).toBeFocused()
})
