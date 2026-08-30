import { type Page } from '@playwright/test'
import type { OwnedAbilityLocator } from '@notarium/contract'
import { encodeAbilityLocator } from '@notarium/core'
import { expect, test } from './fixtures'

// The Context constructor (#165), UI leg: the human steers what an agent loads
// before work. The backend contract (pin/mute write, the agent-context preview,
// the start_session reflection) is pinned in test/fake-server/agentContext.test.ts;
// this spec covers the screens — the Context constructor lists the profile's memory, its
// ⋮ menu exposes load/mute, pinned notes are visible, and a note's ⋮ menu offers
// «Pin to agent context» (the action, gated to where a pin has a target). Runs
// password-mode (the personal domain is a user concept).

const WORLD = {
  now: '2026-06-23T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          id: 'fake-project-pin',
          title: 'Project Deploy',
          filePath: 'docs/project-deploy.md',
          class: 'user-doc',
          tags: ['always-load'],
          content: '# Project Deploy\n\nproject context',
        },
        {
          id: 'fake-project-overview',
          title: 'Docs overview',
          filePath: 'docs/index.md',
          class: 'user-doc',
          tags: ['always-load'],
          content: '# Docs overview\n\nproject introduction',
        },
        {
          id: 'fake-project-scratch',
          title: 'Project Scratch',
          filePath: 'docs/project-scratch.md',
          class: 'user-doc',
          content: '# Project Scratch\n\nproject notes',
        },
        {
          id: 'fake-project-memory',
          title: 'deploy-memory',
          filePath: '.notarium/memory/proj-main-docs/deploy-memory.md',
          class: 'agent-memory',
          summary: 'Project deploy memory',
          content: '# deploy-memory\n\nDeploys need two approvals.',
        },
        // A SECOND project under the same space, with its OWN memory partition
        // (.notarium/memory/proj-main-specs/) — lets a test switch docs → specs and
        // prove the Memory block re-targets (#207 reset effect), not just reloads.
        {
          id: 'fake-specs-doc',
          title: 'API Spec',
          filePath: 'specs/api-spec.md',
          class: 'user-doc',
          content: '# API Spec\n\nthe contract',
        },
        {
          id: 'fake-specs-memory',
          title: 'api-rules',
          filePath: '.notarium/memory/proj-main-specs/api-rules.md',
          class: 'agent-memory',
          summary: 'Project API memory',
          content: '# api-rules\n\nVersion every breaking change.',
        },
      ],
    },
    {
      slug: 'sam-personal',
      displayName: 'Personal',
      notes: [
        // A pinned KB note (always-load) → the profile's pinned list.
        {
          id: 'fake-deploy',
          title: 'Deploy Runbook',
          filePath: 'deploy.md',
          class: 'user-doc',
          tags: ['always-load'],
          content: '# Deploy Runbook\n\nstaging then prod',
        },
        // A plain KB note (unpinned) → the «Pin to agent context» action target.
        {
          id: 'fake-scratch',
          title: 'Scratch',
          filePath: 'scratch.md',
          class: 'user-doc',
          content: '# Scratch\n\nnotes',
        },
        {
          id: 'fake-grooming',
          title: 'Grooming Checklist',
          filePath: 'grooming.md',
          class: 'user-doc',
          content: '# Grooming Checklist\n\nvalidate the pain',
        },
        {
          id: 'fake-personal-overview-root',
          title: 'Overview',
          filePath: 'index.md',
          class: 'user-doc',
          content: '# Overview\n\nworkspace introduction',
        },
        {
          id: 'fake-personal-overview-nested',
          title: 'Overview',
          filePath: 'guides/index.md',
          class: 'user-doc',
          content: '# Overview\n\nguides introduction',
        },
        // Two about-user memory categories: one loaded, one muted.
        {
          id: 'fake-language',
          title: 'language',
          filePath: 'language.md',
          class: 'agent-memory',
          summary: 'RU',
          content: '# language\n\nPrefers English',
        },
        {
          id: 'fake-stale',
          title: 'stale',
          filePath: 'stale.md',
          class: 'agent-memory',
          summary: 'outdated',
          muted: true,
          content: '# stale\n\nold fact',
        },
      ],
    },
    {
      slug: 'casey-personal',
      displayName: 'Casey Personal',
      fieldSchema: {
        version: 1,
        fields: [{ key: 'status', type: 'text', label: 'Status' }],
      },
      notes: [
        {
          id: 'fake-casey-memory',
          title: 'casey-memory',
          filePath: 'casey-memory.md',
          class: 'agent-memory',
          summary: 'Casey memory',
          frontmatter: 'status: personal',
          content: '# casey-memory\n\nOwned personal memory.',
        },
      ],
    },
  ],
  projects: [
    { space: 'main', path: 'docs', slug: 'docs', displayName: 'Docs', aliases: ['old-docs'] },
    { space: 'main', path: 'specs', slug: 'specs', displayName: 'Specs' },
  ],
  agentRoles: [
    {
      source: 'custom' as const,
      name: 'research',
      description: 'Investigate a question with explicit evidence.',
      instructions: '# Research\n\nResearch the evidence before deciding.',
      target: { kind: 'personal', user: 'sam' },
    },
    { name: 'grooming', target: { kind: 'personal', user: 'sam' } },
    {
      source: 'custom' as const,
      name: 'research',
      description: 'Investigate a question with explicit evidence.',
      instructions: '# Research\n\nResearch the evidence before deciding.',
      target: { kind: 'project', space: 'main', path: 'docs' },
    },
  ],
  auth: {
    users: [
      {
        username: 'sam',
        password: 'sam-password-1',
        displayName: 'Sam',
        personalSpace: 'sam-personal',
      },
      {
        username: 'robin',
        password: 'robin-password-1',
        displayName: 'Robin',
      },
      {
        username: 'casey',
        password: 'casey-password-1',
        displayName: 'Casey',
        personalSpace: 'casey-personal',
      },
    ],
    members: [
      { space: 'main', username: 'sam', role: 'owner' },
      { space: 'main', username: 'robin', role: 'reader' },
      { space: 'main', username: 'casey', role: 'reader' },
      { space: 'sam-personal', username: 'sam', role: 'owner' },
      { space: 'casey-personal', username: 'casey', role: 'owner' },
    ],
  },
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: WORLD } })
})

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
})

const login = async (page: Page, username: string, password: string) => {
  await page.goto('/')
  await page.getByTestId('auth-username').fill(username)
  await page.getByTestId('auth-password').fill(password)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('auth-login')).not.toBeVisible()
}

const dragAfter = async (page: Page, source: string, target: string) => {
  const sourceHandle = await page.getByTestId(source).elementHandle()
  const targetHandle = await page.getByTestId(target).elementHandle()

  expect(sourceHandle).not.toBeNull()
  expect(targetHandle).not.toBeNull()
  await page.evaluate(
    ([from, to]) => {
      const dataTransfer = new DataTransfer()
      const fire = (element: Element, type: string, clientY = 0) =>
        element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientY }),
        )
      const targetBox = to.getBoundingClientRect()

      fire(from, 'dragstart')
      fire(to, 'dragover', targetBox.bottom - 1)
      fire(to, 'drop', targetBox.bottom - 1)
      fire(from, 'dragend')
    },
    [sourceHandle!, targetHandle!] as const,
  )
}

const ownedRoleLocator = async (
  page: Page,
  name: string,
  scope: OwnedAbilityLocator['location']['scope'],
): Promise<string> => {
  const response = await page.request.get('/api/me/agent-roles?limit=100')
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as {
    items: Array<{
      name: string
      source: string
      locator: OwnedAbilityLocator
    }>
  }
  const role = body.items.find(
    (item) =>
      item.source === 'owned' &&
      item.locator.kind === 'role' &&
      item.name === name &&
      item.locator.location.scope === scope,
  )

  expect(role).toBeDefined()
  return encodeAbilityLocator(role!.locator)
}

test('the Context constructor lists the profile and muting a category flips its row', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/agents/context/personal')
  await expect(page.getByTestId('agents-context')).toBeVisible()

  // The aggregate token scale (#208) headlines the page with a token budget.
  const aggregate = page.getByTestId('context-aggregate')
  await expect(aggregate).toBeVisible()
  await expect(aggregate).toContainText('tokens')

  // PROFILE: the items show directly — no disclosure toggle (#208). The pinned note
  // is in the pinned list…
  const pins = page.getByTestId('context-pin-row')
  await expect(pins.filter({ hasText: 'Deploy Runbook' })).toBeVisible()
  // …carrying its per-note weight meter (#208, "how much it eats").
  await expect(pins.filter({ hasText: 'Deploy Runbook' })).toContainText('≈')

  // …and both memory categories show. The menu toggles mute on both axes as the plain
  // reverse pair (#210): a muted category offers "Unmute", a loaded one "Mute".
  const stale = page.getByTestId('context-memory-row').filter({ hasText: 'stale' })
  const language = page.getByTestId('context-memory-row').filter({ hasText: 'language' })
  await expect(stale).toBeVisible()
  await expect(language).toBeVisible()

  await stale.getByTestId('context-memory-row-menu').click()
  await expect(page.getByRole('menuitem', { name: 'Unmute' })).toBeVisible()
  await page.keyboard.press('Escape')

  await language.getByTestId('context-memory-row-menu').click()
  await expect(page.getByRole('menuitem', { name: 'Mute' })).toBeVisible()

  // Toggle the loaded category → it mutes (the write lands, the row reconciles): the
  // row now carries the Muted badge and its menu offers "Unmute" (the reverse) instead.
  await page.getByRole('menuitem', { name: 'Mute' }).click()
  await expect(language).toContainText('Muted')
  await language.getByTestId('context-memory-row-menu').click()
  await expect(page.getByRole('menuitem', { name: 'Unmute' })).toBeVisible()
})

test('a note’s ⋮ menu offers «Pin to agent context» where a pin has a target', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')

  // The plain note is unpinned → the action reads «Pin to agent context».
  await page.goto('/n/fake-scratch')
  await expect(page.getByRole('heading', { name: 'Scratch' })).toBeVisible()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Pin to agent context' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Pin to agent context' }).click()

  // It now reads as pinned in the Context constructor (the pinned list shows directly).
  await page.goto('/agents/context/personal')
  await expect(page.getByTestId('context-pin-row').filter({ hasText: 'Scratch' })).toBeVisible()

  // The already-pinned note offers «Unpin from agent context».
  await page.goto('/n/fake-deploy')
  await expect(page.getByRole('heading', { name: 'Deploy Runbook' })).toBeVisible()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Unpin from agent context' })).toBeVisible()
})

test('folder overview actions and picker rows name the note boundary explicitly', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/n/fake-project-overview')
  await expect(page.getByRole('heading', { name: 'Docs overview' })).toBeVisible()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(
    page.getByRole('menuitem', { name: 'Unpin folder overview from agent context' }),
  ).toBeVisible()
  await page.getByRole('menuitem', { name: 'Unpin folder overview from agent context' }).click()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(
    page.getByRole('menuitem', { name: 'Pin folder overview to agent context' }),
  ).toBeVisible()

  await page.goto('/agents/context/personal')
  await page.getByTestId('context-add-personal-pin').click()
  await page.getByPlaceholder('Search notes…').fill('Overview')
  const root = page
    .getByTestId('pin-picker-item')
    .filter({ hasText: 'Folder overview · workspace root' })
  const nested = page.getByTestId('pin-picker-item').filter({ hasText: 'Folder overview · guides' })
  await expect(root).toBeVisible()
  await expect(nested).toBeVisible()
  await expect(
    root.getByRole('checkbox', { name: 'Overview · Folder overview · workspace root' }),
  ).toBeVisible()
  await expect(
    nested.getByRole('checkbox', { name: 'Overview · Folder overview · guides' }),
  ).toBeVisible()
  await expect(root).not.toContainText('index')
  await expect(nested).not.toContainText('index')
})

test('direct pins and context-set items keep the title and show a Folder overview chip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 900 })
  await login(page, 'sam', 'sam-password-1')

  const created = await page.request.post('/api/s/sam-personal/context-sets', {
    data: { name: 'Overview set' },
  })
  expect(created.ok()).toBe(true)
  const setId = ((await created.json()) as { set: { id: string } }).set.id
  expect(
    (
      await page.request.post(`/api/s/sam-personal/context-sets/${setId}/items`, {
        data: { space: 'sam-personal', noteId: 'fake-personal-overview-nested' },
      })
    ).ok(),
  ).toBe(true)
  expect((await page.request.put(`/api/me/context-sets/${setId}`)).ok()).toBe(true)

  await page.goto('/agents/context/personal')
  const setRow = page.getByTestId('context-set-row').filter({ hasText: 'Overview set' })
  await expect(setRow).toBeVisible()
  await setRow.getByTestId('context-set-row-row').click()
  const item = page.getByTestId('context-set-item').filter({ hasText: 'Overview' })
  await expect(item).toContainText('Overview')
  await expect(item).toContainText('Folder overview')
  const badgeRow = item.getByTestId('context-item-badges')
  const badgeRowBox = await badgeRow.boundingBox()
  expect(badgeRowBox).not.toBeNull()
  for (const label of ['Folder overview', 'sam-personal']) {
    const badge = item.getByText(label, { exact: true })
    await expect(badge).toBeVisible()
    const badgeBox = await badge.boundingBox()
    expect(badgeBox).not.toBeNull()
    expect(badgeBox!.x).toBeGreaterThanOrEqual(badgeRowBox!.x - 0.5)
    expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(
      badgeRowBox!.x + badgeRowBox!.width + 0.5,
    )
  }

  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByTestId('agents-tab-context').click()
  await page.getByTestId('context-scope-tab-docs').click()
  const direct = page
    .getByTestId('context-project')
    .getByTestId('context-pin-row')
    .filter({ hasText: 'Docs overview' })
  await expect(direct).toContainText('Docs overview')
  await expect(direct).toContainText('Folder overview')
  const directTitle = direct.getByText('Docs overview', { exact: true })
  await expect(directTitle).toBeVisible()
  const titleGeometry = await directTitle.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(titleGeometry.clientWidth).toBeGreaterThan(0)
  expect(titleGeometry.scrollWidth).toBeGreaterThan(0)
})

test('keyboard reorder is isolated for nested set items and mouse reorder still works', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')
  const created = await page.request.post('/api/s/sam-personal/context-sets', {
    data: { name: 'Keyboard set' },
  })
  expect(created.ok()).toBe(true)
  const setId = ((await created.json()) as { set: { id: string } }).set.id

  for (const noteId of ['fake-scratch', 'fake-grooming']) {
    expect(
      (
        await page.request.post(`/api/s/sam-personal/context-sets/${setId}/items`, {
          data: { space: 'sam-personal', noteId },
        })
      ).ok(),
    ).toBe(true)
  }
  expect((await page.request.put(`/api/me/context-sets/${setId}`)).ok()).toBe(true)

  await page.goto('/agents/context/personal')
  const outer = page.getByTestId('context-personal-pins')
  const outerOrder = () =>
    outer
      .locator(':scope > :is([data-testid="context-pin-row"], [data-testid="context-set-row"])')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')))
  await expect.poll(outerOrder).toEqual(['context-pin-row', 'context-set-row'])

  const setRow = page.getByTestId('context-set-row').filter({ hasText: 'Keyboard set' })
  await setRow.getByTestId('context-set-row-row').click()
  const nestedOrder = () =>
    setRow
      .getByTestId('context-set-item')
      .evaluateAll((rows) => rows.map((row) => row.textContent ?? ''))
  await expect
    .poll(nestedOrder)
    .toEqual([expect.stringContaining('Scratch'), expect.stringContaining('Grooming Checklist')])

  const groomingGrip = setRow
    .getByTestId('context-set-item')
    .filter({ hasText: 'Grooming Checklist' })
    .getByRole('button', { name: 'Reorder item' })
  await groomingGrip.focus()
  await groomingGrip.press('ArrowUp')
  await expect
    .poll(nestedOrder)
    .toEqual([expect.stringContaining('Grooming Checklist'), expect.stringContaining('Scratch')])
  await expect.poll(outerOrder).toEqual(['context-pin-row', 'context-set-row'])

  await setRow.getByRole('button', { name: 'Reorder item' }).first().focus()
  await setRow.getByRole('button', { name: 'Reorder item' }).first().press('ArrowUp')
  await expect.poll(outerOrder).toEqual(['context-set-row', 'context-pin-row'])

  await dragAfter(page, 'context-set-row', 'context-pin-row')
  await expect.poll(outerOrder).toEqual(['context-pin-row', 'context-set-row'])
})

test('a project route focuses the project; the Personal tab switches to it inline (#208)', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/s/main')
  await expect(page.getByTestId('space-switcher')).toContainText('Main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByTestId('agents-tab-context').click()
  await expect(page).toHaveURL(/\/agents\/context$/)
  await page.getByTestId('context-scope-tab-docs').click()
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)
  // A project route focuses the PROJECT band of the one scale — its panels show, the
  // personal Profile panel is NOT stacked below (#208): it's the Personal tab instead.
  await expect(page.getByTestId('context-project')).toBeVisible()
  await expect(page.getByTestId('context-profile')).toHaveCount(0)

  // Opening the project's own pin and Back returns to the PROJECT context (not
  // Personal) — the route/space preservation #165 guarded, on the project axis. The
  // pinned list shows directly (no disclosure toggle, #208).
  const projectPin = page
    .getByTestId('context-project')
    .getByTestId('context-pin-row')
    .filter({ hasText: 'Project Deploy' })
  await expect(projectPin).toBeVisible()
  await projectPin.getByTestId('context-pin-row-menu').click()
  await page.getByRole('menuitem', { name: 'Open note' }).click()
  await expect(page.getByRole('heading', { name: 'Project Deploy' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)
  await expect(page.getByTestId('context-project')).toBeVisible()

  // The Personal tab of the scale switches to the personal panels INLINE (its band
  // lights, its panels replace the project's) — staying on the project route, no
  // second stacked panel (#208).
  await page.getByTestId('context-aggregate-personal').click()
  await expect(page.getByTestId('context-profile')).toBeVisible()
  await expect(page.getByTestId('context-project')).toHaveCount(0)
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)
})

test('an effective role is a separate first context band with an independent preset', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')
  const personalRole = await ownedRoleLocator(page, 'research', 'personal')
  const projectRole = await ownedRoleLocator(page, 'research', 'project')
  const personalPin = await page.request.put(
    `/api/me/agent-roles/${encodeURIComponent(personalRole)}/context-pins`,
    { data: { space: 'sam-personal', noteId: 'fake-scratch' } },
  )
  expect(personalPin.ok()).toBe(true)
  const projectPin = await page.request.put(
    `/api/me/agent-roles/${encodeURIComponent(projectRole)}/context-pins`,
    { data: { space: 'main', noteId: 'fake-project-scratch' } },
  )
  expect(projectPin.ok()).toBe(true)

  await page.goto('/agents/context/personal')
  await page.getByTestId('context-role-selector').click()
  await page
    .getByRole('group', { name: 'Personal' })
    .getByRole('menuitemradio', { name: 'Research' })
    .click()
  await expect(page).toHaveURL(
    (url) => url.pathname === '/agents/context' && url.searchParams.get('role') === personalRole,
  )
  await expect(page.getByTestId('context-role')).toBeVisible()
  await expect(page.getByTestId('context-role-pins')).toContainText('Scratch')
  await expect(page.getByTestId('context-aggregate-role')).toBeVisible()
  const aggregate = page.getByTestId('context-aggregate')
  const total = Number(await aggregate.getAttribute('data-total-loaded-tokens'))
  const roleLoaded = Number(
    await page.getByTestId('context-aggregate-role').getAttribute('data-loaded-tokens'),
  )
  const personalLoaded = Number(
    await page.getByTestId('context-aggregate-personal').getAttribute('data-loaded-tokens'),
  )
  expect(roleLoaded + personalLoaded).toBe(total)

  // The Context route is space-less, so enter the project through its space first;
  // this also keeps the test independent from another test's remembered active space.
  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByTestId('agents-tab-context').click()
  await page.getByTestId('context-scope-tab-docs').click()
  await page.getByTestId('context-role-selector').click()
  await page
    .getByRole('group', { name: 'From this project' })
    .getByRole('menuitemradio', { name: 'Research' })
    .click()
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/agents/context/docs' && url.searchParams.get('role') === projectRole,
  )
  await expect(page.getByTestId('context-role')).toBeVisible()
  await expect(page.getByTestId('context-role-pins')).toContainText('Project Scratch')
  await expect(
    page.getByTestId('context-role-pins').getByText('Scratch', { exact: true }),
  ).toHaveCount(0)

  // A role preset belongs to one exact placement, so a scope tab does not carry the
  // selection across: the destination opens on its own Base context directly, instead of
  // fetching a role it cannot hold and undoing the URL afterwards (#309).
  await page.getByTestId('context-scope-tab-personal').click()
  await expect(page).toHaveURL(/\/agents\/context$/)
  await expect(page.getByTestId('context-role')).toHaveCount(0)
  await expect(page.getByTestId('context-profile')).toBeVisible()
  await page.getByTestId('context-scope-tab-docs').click()
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)

  await page.goto(
    `/agents/context/proj-main-docs?${new URLSearchParams({ role: projectRole }).toString()}`,
  )
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/agents/context/docs' && url.searchParams.get('role') === projectRole,
  )
  await expect(page.getByTestId('context-role-pins')).toContainText('Project Scratch')
  await page.getByTestId('context-aggregate-personal').click()
  await expect(page.getByTestId('context-profile')).toBeVisible()

  await page.getByTestId('context-role-selector').click()
  await page.getByRole('menuitemradio', { name: 'Base context' }).click()
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)
  await expect(page.getByTestId('context-role')).toHaveCount(0)
  await expect(page.getByTestId('context-project')).toBeVisible()
})

test('role switching rejects stale responses and an unavailable bookmark normalizes to Base', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')
  const researchRole = await ownedRoleLocator(page, 'research', 'personal')
  const groomingRole = await ownedRoleLocator(page, 'grooming', 'personal')

  for (const [role, noteId] of [
    [researchRole, 'fake-scratch'],
    [groomingRole, 'fake-grooming'],
  ] as const) {
    expect(
      (
        await page.request.put(`/api/me/agent-roles/${encodeURIComponent(role)}/context-pins`, {
          data: { space: 'sam-personal', noteId },
        })
      ).ok(),
    ).toBe(true)
  }
  // The research preview is HELD, not merely slowed: the test itself decides when the
  // stale answer lands, so "it came back last" is a property of the scenario instead of a
  // bet on how the machine happens to schedule two sleeps.
  let releaseResearchPreview!: () => void
  const heldResearchPreview = new Promise<void>((resolve) => {
    releaseResearchPreview = resolve
  })
  await page.route('**/api/me/agent-context?*', async (route) => {
    const url = new URL(route.request().url())

    if (url.searchParams.get('role') === researchRole) {
      await heldResearchPreview
    }
    await route.continue()
  })

  await page.goto('/agents/context/personal')
  await page.getByTestId('context-role-selector').click()
  await page
    .getByRole('group', { name: 'Personal' })
    .getByRole('menuitemradio', { name: 'Research' })
    .click()
  await page.getByTestId('context-role-selector').click()
  await page
    .getByRole('group', { name: 'Personal' })
    .getByRole('menuitemradio', { name: 'Grooming' })
    .click()
  await expect(page).toHaveURL((url) => url.searchParams.get('role') === groomingRole)
  await expect(page.getByTestId('context-role-pins')).toContainText('Grooming Checklist')
  await expect(page.getByTestId('context-role-pins')).not.toContainText('Scratch')

  // Now let the abandoned preview answer and wait for that answer to reach the client —
  // a rejection can only be proven against a response that actually arrived.
  const staleResearchPreview = page.waitForResponse((response) => {
    const url = new URL(response.url())

    return url.pathname === '/api/me/agent-context' && url.searchParams.get('role') === researchRole
  })
  releaseResearchPreview()
  await staleResearchPreview

  // Arrival is not application, so read the pins only behind a render the app can produce
  // only afterwards: the picker's rows come from a round-trip started once the stale answer
  // was already on the client, and React cannot paint them while an earlier commit is still
  // pending. Whatever that answer would have done to the role pins is therefore on screen by
  // the time the first row is — and it never washes out, so the read below cannot pass by
  // catching the page a moment too early.
  await page.getByTestId('context-add-role-pin').click()
  await expect(page.getByTestId('pin-picker-item').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('pin-picker')).toHaveCount(0)
  await expect(page.getByTestId('context-role-pins')).toContainText('Grooming Checklist')
  await expect(page.getByTestId('context-role-pins')).not.toContainText('Scratch')

  await page.goto('/agents/context/personal?role=removed-role')
  await expect(page).toHaveURL(/\/agents\/context$/)
  await expect(page.getByTestId('context-profile')).toBeVisible()
  await expect(page.getByTestId('context-role')).toHaveCount(0)
})

test('a failed role preview exposes no base mutation surface', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')
  const projectRole = await ownedRoleLocator(page, 'research', 'project')
  await page.route('**/api/s/main/projects/*/agent-context?*', async (route) => {
    const url = new URL(route.request().url())

    if (url.searchParams.get('role') === projectRole) {
      await route.fulfill({ status: 503, body: 'temporarily unavailable' })
      return
    }
    await route.continue()
  })

  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByTestId('agents-tab-context').click()
  await page.getByTestId('context-scope-tab-docs').click()
  await page.getByTestId('context-role-selector').click()
  await page
    .getByRole('group', { name: 'From this project' })
    .getByRole('menuitemradio', { name: 'Research' })
    .click()
  await expect(page.getByTestId('context-error')).toContainText('Couldn’t load project context')
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/agents/context/docs' && url.searchParams.get('role') === projectRole,
  )
  await expect(page.getByTestId('context-profile')).toHaveCount(0)
  await expect(page.getByTestId('context-project')).toHaveCount(0)
  await expect(page.getByTestId('context-role')).toHaveCount(0)
  await expect(page.getByTestId('context-add-personal-pin')).toHaveCount(0)
  await expect(page.getByTestId('context-add-project-pin')).toHaveCount(0)
  await expect(page.getByTestId('context-add-role-pin')).toHaveCount(0)
})

test('a reader can inspect a shared role preset without write affordances', async ({ page }) => {
  await login(page, 'robin', 'robin-password-1')
  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByTestId('agents-tab-context').click()
  await page.getByTestId('context-scope-tab-docs').click()
  await page.getByTestId('context-role-selector').click()
  await page
    .getByRole('group', { name: 'From this project' })
    .getByRole('menuitemradio', { name: 'Research' })
    .click()

  await expect(page.getByTestId('context-role')).toBeVisible()
  await expect(page.getByTestId('context-role-readonly')).toBeVisible()
  await expect(page.getByTestId('context-add-role-pin')).toHaveCount(0)
})

/** The blocker of round 7, in a browser (#309). Switching a role off is a private
 *  READING preference — it says nothing about whether that role's shared context may be
 *  configured, and the very menu that switches it off offers «Configure context» right
 *  beside. So the page it lands on has to say, in words, that the agent will not load
 *  this role here — and still hand over every control that changes what it loads. */
test('a role the reader switched off is named, explained, and still editable', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')
  const personalRole = await ownedRoleLocator(page, 'research', 'personal')
  expect(
    (
      await page.request.put(
        `/api/me/agent-roles/${encodeURIComponent(personalRole)}/context-pins`,
        { data: { space: 'sam-personal', noteId: 'fake-scratch' } },
      )
    ).ok(),
  ).toBe(true)
  expect(
    (
      await page.request.put(
        `/api/me/agent-abilities/${encodeURIComponent(personalRole)}/enabled`,
        { data: { enabled: false } },
      )
    ).ok(),
  ).toBe(true)

  await page.goto(`/agents/context?${new URLSearchParams({ role: personalRole }).toString()}`)
  await expect(page).toHaveURL((url) => url.searchParams.get('role') === personalRole)

  // The address still names the role — this is NOT the "no longer available" path.
  await expect(page.getByTestId('context-role')).toBeVisible()
  await expect(page.getByTestId('context-role-unavailable')).toHaveCount(0)
  await expect(page.getByTestId('context-role-inactive')).toContainText(
    'switched this role off for yourself',
  )
  // Its own layer is on screen, and editable: the right to change a role's context is a
  // question about the space, not about this reader's private switch.
  await expect(page.getByTestId('context-role-pins')).toContainText('Scratch')
  await expect(page.getByTestId('context-add-role-pin')).toBeVisible()
  // And it costs the session budget nothing, because the agent does not load it here.
  await expect(page.getByTestId('context-aggregate-role')).toHaveAttribute(
    'data-loaded-tokens',
    '0',
  )
})

test('project context shows, adds, and removes project pins', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByTestId('agents-tab-context').click()
  await page.getByTestId('context-scope-tab-docs').click()
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)

  const projectPins = page.getByTestId('context-project').getByTestId('context-pin-row')
  await expect(projectPins.filter({ hasText: 'Project Deploy' })).toBeVisible()

  await page.getByTestId('context-add-project-pin').click()
  await page.getByPlaceholder('Search notes…').fill('Project Scratch')
  // The picker is multi-select now (#209): check the note, then Save pins it.
  await page.getByTestId('pin-picker-item').filter({ hasText: 'Project Scratch' }).click()
  await page.getByTestId('pin-picker-save').click()
  await expect(projectPins.filter({ hasText: 'Project Scratch' })).toBeVisible()

  const scratch = projectPins.filter({ hasText: 'Project Scratch' })
  await scratch.getByTestId('context-pin-row-menu').click()
  await page.getByRole('menuitem', { name: 'Unpin' }).click()
  await expect(projectPins.filter({ hasText: 'Project Scratch' })).toHaveCount(0)
})

test('the project context audits project memory and muting it persists across a reload (#207)', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByTestId('agents-tab-context').click()
  await page.getByTestId('context-scope-tab-docs').click()
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)

  // The PROJECT section carries its own Memory block — the about-project axis the
  // explorer shows (the personal one lives under the Personal tab, not duplicated
  // here, #208). It is an AUDIT list (categories/muted) shown directly with a caption,
  // not a fake budget (#207).
  const project = page.getByTestId('context-project')
  const caption = project.getByTestId('context-project-memory-caption')
  const deployMemory = project
    .getByTestId('context-project-memory-row')
    .filter({ hasText: 'deploy-memory' })
  await expect(deployMemory).toBeVisible()
  await expect(caption).toContainText('1 category')

  // Mute the project category → the audit caption reflects it.
  await deployMemory.getByTestId('context-project-memory-row-menu').click()
  await page.getByRole('menuitem', { name: 'Mute' }).click()
  await expect(caption).toContainText('1 muted')

  // The write PERSISTS server-side (id-addressed mute), not just an optimistic flip:
  // reload and re-read — the category is still muted and now offers Unmute.
  await page.reload()
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)
  await expect(caption).toContainText('1 muted')
  await project
    .getByTestId('context-project-memory-row')
    .filter({ hasText: 'deploy-memory' })
    .getByTestId('context-project-memory-row-menu')
    .click()
  await expect(page.getByRole('menuitem', { name: 'Unmute' })).toBeVisible()
})

test('switching from one project to another re-targets the project Memory block (#207)', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByTestId('agents-tab-context').click()
  await page.getByTestId('context-scope-tab-docs').click()
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)

  // Project A (Docs): its own memory category renders (rows show directly, #208).
  const project = page.getByTestId('context-project')
  await expect(
    project.getByTestId('context-project-memory-row').filter({ hasText: 'deploy-memory' }),
  ).toBeVisible()
  await expect(
    project.getByTestId('context-project-memory-row').filter({ hasText: 'api-rules' }),
  ).toHaveCount(0)

  // Switch to project B (Specs) WITHOUT a reload — the in-app project tab. To prove
  // it is the RESET effect (not merely the eventual re-load) that drops A's rows, HOLD
  // B's project-memory response: the switch fires the load, but it cannot commit until
  // the request resolves. The reset effect must clear A's row in that window all the
  // same. Without the reset, deploy-memory would linger here until B's load lands —
  // and a mute click in that window would hit the wrong (A's) note id.
  let releaseSpecsMemory!: () => void
  const specsMemoryHeld = new Promise<void>((resolve) => {
    releaseSpecsMemory = resolve
  })
  // Match the memory endpoint with a REGEX, not a glob: the real request carries a query
  // (`…/memory?order=eager`, api.projectMemoryGet), and a trailing-anchored glob
  // (`**/…/memory`) does NOT match past the `?`, so the hold silently no-ops and the test
  // passes or fails on raw network timing. The regex holds it for real, so B's Promise.all
  // in load() can't commit until we release — the window the reset must clear A's row in.
  await page.route(/\/projects\/proj-main-specs\/memory(\?|$)/, async (route) => {
    await specsMemoryHeld
    await route.continue()
  })

  await page.getByRole('link', { name: 'Specs' }).click()
  await expect(page).toHaveURL(/\/agents\/context\/specs$/)
  // B's memory has NOT loaded yet (request held), yet A's row is already gone — the
  // reset, not the reload. The Memory rows show directly (no disclosure state to
  // remount, #208), so this is a real cleared list.
  await expect(
    project.getByTestId('context-project-memory-row').filter({ hasText: 'deploy-memory' }),
  ).toHaveCount(0)
  await expect(
    project.getByTestId('context-project-memory-row').filter({ hasText: 'api-rules' }),
  ).toHaveCount(0)

  // Release B's load → its own category renders; A's stays gone.
  releaseSpecsMemory()
  await expect(
    project.getByTestId('context-project-memory-row').filter({ hasText: 'api-rules' }),
  ).toBeVisible()
  await expect(
    project.getByTestId('context-project-memory-row').filter({ hasText: 'deploy-memory' }),
  ).toHaveCount(0)
  await expect(project.getByTestId('context-project-memory-caption')).toContainText('1 category')
})

test('Memory read and edit keep the Agents shell and originating project scope', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/s/main')
  await expect(page.getByTestId('space-switcher')).toContainText('Main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByTestId('agents-tab-context').click()
  await expect(page.getByTestId('agents-context')).toBeVisible()
  await expect(page.getByTestId('memory-tree')).toBeVisible()

  const projectMemory = page.getByTestId('memory-leaf').filter({ hasText: 'deploy-memory' })
  await expect(projectMemory).toBeVisible()
  await projectMemory.click()
  await expect(page).toHaveURL(/\/m\/fake-project-memory\/deploy-memory\?context=docs$/)
  await expect(page.getByTestId('memory-note-surface')).toBeVisible()
  await expect(page.getByTestId('context-scope-tab-docs')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('context-scope-tab-personal')).not.toHaveAttribute(
    'aria-current',
    'page',
  )
  const explorer = page.getByTestId('memory-tree')
  const activeMemory = explorer.getByTestId('memory-leaf').filter({ hasText: 'deploy-memory' })
  await expect(page.getByTestId('agents-explorer-picker')).toHaveAttribute('data-dataset', 'memory')
  await expect(explorer.getByTestId('memory-axis').filter({ hasText: 'Docs' })).toBeVisible()
  await expect(activeMemory.getByRole('link')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'deploy-memory' })).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByTestId('memory-note-surface')).toBeVisible()
  await expect(page.getByTestId('context-scope-tab-docs')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('memory-tree')).toBeVisible()
  await expect(activeMemory.getByRole('link')).toHaveAttribute('aria-current', 'page')
  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('# deploy-memory\n\nDeploys need two approvals and an owner.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page).toHaveURL(/\/m\/fake-project-memory\/deploy-memory\?context=docs$/)
  await expect(page.getByText('Deploys need two approvals and an owner.')).toBeVisible()
  await expect(page.getByTestId('context-scope-tab-docs')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('memory-tree')).toBeVisible()
  await expect(activeMemory.getByRole('link')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByLabel('Breadcrumb')).toContainText('Agents/Context/Memory/deploy-memory')
})

test('personal Memory remains editable while the active workspace grant is reader', async ({
  page,
}) => {
  await login(page, 'casey', 'casey-password-1')
  await page.goto('/s/main')
  await expect(page.getByTestId('space-switcher')).toContainText('Main')
  await page.goto('/m/fake-casey-memory')

  await expect(page.getByRole('heading', { name: 'casey-memory' })).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Open memory details' }).click()
  await expect(page.getByTestId('editor-meta')).toBeVisible()
  await page.getByTestId('editor-meta').getByRole('textbox', { name: 'Status value' }).fill('kept')
  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('# casey-memory\n\nEdited while Main stays read-only.')
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/note'),
  )
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  expect((await saved).request().postDataJSON()).toMatchObject({ fields: { status: 'kept' } })
  await expect(page.getByText('Edited while Main stays read-only.')).toBeVisible()
})

test('agent context and note routes canonicalize legacy forms', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')
  const projects = (await (await page.request.get('/api/s/main/projects')).json()) as {
    projects: Array<{ id: string; slug: string }>
  }
  const docsProject = projects.projects.find((p) => p.slug === 'docs')!

  await page.goto('/agents')
  await expect(page).toHaveURL(/\/agents\/abilities\/roles$/)
  await page.goto('/agents/context')
  await expect(page).toHaveURL(/\/agents\/context$/)
  await page.goto('/agents/session')
  await expect(page).toHaveURL(/\/agents\/activity$/)

  await page.goto('/s/main')
  await expect(page.getByTestId('space-switcher')).toContainText('Main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByTestId('agents-tab-context').click()
  await page.getByTestId('context-scope-tab-docs').click()
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)
  await expect(page.getByTestId('context-project')).toBeVisible()
  await page.waitForFunction(
    ([id]) =>
      localStorage.getItem(`nt-context-scope-space:${id}`) === 'main' &&
      localStorage.getItem('nt-context-scope-space:old-docs') === 'main',
    [docsProject.id],
  )

  await page.goto(`/agents/context/${docsProject.id}`)
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)
  await page.goto('/agents/context/old-docs')
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)

  await page.goto('/n/fake-language')
  await expect(page).toHaveURL(/\/m\/fake-language/)
  await page.goto('/m/fake-deploy')
  await expect(page).toHaveURL(/\/n\/fake-deploy/)
})

// ── one aside per route, one owner per aside (#393) ──────────────────────────
// The section's routes are one surface and have to agree on three things: the aside is
// there, exactly one component owns it, and nothing inside it scrolls except the panel
// body. All three are read as computed style and counts rather than as pixels — a nested
// scroll box is pixel-identical in a screenshot and is only felt under a wheel.

/** Every surface names its own panel, so the toggle's label is also the proof that the
 *  route's OWN panel is the one mounted. Worded as a fenced alternation rather than
 *  `/^(Open|Close) /`: below 720px the sidebar's own toggle reads `Close sidebar`, and a
 *  bare prefix would match two buttons and fail on strictness instead of on the invariant. */
const ASIDE_TOGGLE =
  /^(Open|Close) (role|skill|context|library|activity|memory) (details|filters|panels)$/

/** A gate every intercepted request waits on, opened once by the test. Deliberately ONE
 *  promise for all of them: a per-request promise leaves the second request held forever,
 *  and nothing releases it — `page.unroute` does not. */
const openable = () => {
  let open!: () => void
  const held = new Promise<void>((release) => {
    open = release
  })

  return { held, open: () => open() }
}

const asideState = (page: Page) =>
  page.evaluate(() => {
    const groups = document.querySelector('[data-testid="aside-groups"]')
    const describe = (element: Element) =>
      `${element.tagName.toLowerCase()}.${element.className || '(no class)'}`

    const scrolls = (element: Element) => {
      const overflowY = getComputedStyle(element).overflowY

      return overflowY === 'auto' || overflowY === 'scroll'
    }
    // A native multi-line control scrolls its own value — that is the platform's box, not
    // a layout box the panel put around a list, and the same is true everywhere else in
    // the app. The invariant is about boxes WE nest, so the editor's description field is
    // excluded by kind rather than by name.
    const control = (element: Element) => element.tagName === 'TEXTAREA'
    const panel = (element: Element) =>
      element.getAttribute('role') === 'tabpanel' && !element.hasAttribute('hidden')
    const inside = groups ? [...groups.querySelectorAll('*')].filter(scrolls) : []

    return {
      groups: document.querySelectorAll('[data-testid="aside-groups"]').length,
      contentWidth: document.querySelector('[data-testid="content-scroll"]')?.clientWidth ?? 0,
      owners: inside.filter(panel).length,
      // Anything else that takes a wheel inside the aside — the thing this invariant is
      // about. Reported by name so a failure says WHICH box came back.
      nested: inside.filter((element) => !panel(element) && !control(element)).map(describe),
    }
  })

const stopWidth = async (page: Page): Promise<number> => (await asideState(page)).contentWidth

test('every route of the section keeps one aside, one owner and one scroller', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')
  const roleLocator = await ownedRoleLocator(page, 'research', 'personal')
  // A draft is left open at the end of the walk; leaving it must not stall on a confirm.
  page.on('dialog', (dialog) => void dialog.accept())

  await page.goto('/agents/abilities/roles')
  await expect(page.getByTestId('agents-roles')).toBeVisible()
  await page.getByRole('button', { name: 'Open library filters' }).click()
  await expect(page.getByTestId('aside-groups')).toBeVisible()

  // The aside is ONE persisted preference, so it is opened once and everything below
  // reads the same open aside on a different route.
  const stop = async (aside: string): Promise<number> => {
    const toggle = page.getByRole('button', { name: ASIDE_TOGGLE })
    await expect(toggle).toHaveCount(1)
    await expect(toggle).toHaveAccessibleName(`Close ${aside}`)

    const state = await asideState(page)

    const { contentWidth, ...invariant } = state

    expect({ route: aside, ...invariant }).toEqual({
      route: aside,
      groups: 1,
      owners: 1,
      nested: [],
    })
    return contentWidth
  }
  const widths: Array<[string, number]> = [['library filters', await stop('library filters')]]

  await page.getByTestId('agents-tab-context').click()
  await expect(page.getByTestId('agents-context')).toBeVisible()
  widths.push(['context details', await stop('context details')])

  await page.getByTestId('agents-tab-activity').click()
  widths.push(['activity panels', await stop('activity panels')])

  await page.goto(`/agents/abilities/roles/owned/${encodeURIComponent(roleLocator)}`)
  await expect(page.getByTestId('agent-ability-detail')).toBeVisible()
  widths.push(['role details (card)', await stop('role details')])

  // Editing the card hands the panel over to the editor surface. The handover is the one
  // place where a page that kept its own panel would put TWO on screen — the shape the
  // brief calls out by name — and `stop()` counts them.
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByTestId('ability-editor')).toBeVisible()
  widths.push(['role details (card, editing)', await stop('role details')])
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByTestId('agent-ability-detail')).toBeVisible()

  await page.goto('/m/fake-project-memory/deploy-memory?context=docs')
  await expect(page.getByTestId('memory-note-surface')).toBeVisible()
  widths.push(['memory details', await stop('memory details')])

  // The draft route is the one place where two components mount a panel in sequence — the
  // page while the inventory lands, the editor surface after it. Both name the panel the
  // same way, so a stop taken at an arbitrary moment cannot say which of the two it saw:
  // the inventory read is held open, and the invariant is read on BOTH sides of it.
  const inventory = openable()

  await page.route('**/api/me/agent-skills?*', async (route) => {
    await inventory.held
    await route.continue()
  })
  await page.goto('/agents/abilities/roles')
  await page.getByTestId('role-create').click()
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\/new\//)
  await expect(page.getByTestId('aside-placeholder')).toBeVisible()
  widths.push(['role details (draft, waiting)', await stop('role details')])
  inventory.open()
  await expect(page.getByTestId('ability-editor')).toBeVisible()
  widths.push(['role details (draft, editing)', await stop('role details')])
  await page.unroute('**/api/me/agent-skills?*')

  // The point of the whole walk: the content column never resizes under the reader.
  expect(new Set(widths.map(([, width]) => width)).size).toBe(1)
  expect(widths.every(([, width]) => width > 0)).toBe(true)
})

test('the aside toggle keeps its place to the right of the page’s own actions', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  // Read with the aside CLOSED — that is the only state where the toggle is in the topbar
  // at all. The memory route is the one that exposed the order: its own action arrives
  // with the note, i.e. after the panel has already mounted (#393).
  await page.goto('/m/fake-project-memory/deploy-memory?context=docs')
  await expect(page.getByTestId('memory-note-surface')).toBeVisible()

  const edit = page.getByRole('button', { name: 'Edit', exact: true })
  const separator = page.getByTestId('topbar-action-separator')
  const toggle = page.getByRole('button', { name: 'Open memory details' })

  await expect(edit).toBeVisible()
  await expect(toggle).toBeVisible()

  const [editBox, separatorBox, toggleBox] = await Promise.all([
    edit.boundingBox(),
    separator.boundingBox(),
    toggle.boundingBox(),
  ])

  expect(editBox!.x).toBeLessThan(separatorBox!.x)
  expect(separatorBox!.x).toBeLessThan(toggleBox!.x)
})

test('an ability keeps its aside and its width while reading, and after a failed read', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')
  const roleLocator = await ownedRoleLocator(page, 'research', 'personal')
  const card = `/agents/abilities/roles/owned/${encodeURIComponent(roleLocator)}`

  await page.goto(card)
  await expect(page.getByTestId('agent-ability-detail')).toBeVisible()
  await page.getByRole('button', { name: 'Open role details' }).click()
  const loaded = await stopWidth(page)

  expect(loaded).toBeGreaterThan(0)

  // The state the jump was measured in: the read is held open, so the page is a skeleton
  // and the panel has nothing to describe yet. Both the toggle and the width are the
  // loaded ones — that is the whole invariant.
  //
  // One gate for EVERY matching request, opened once. A handler that mints its own promise
  // per request holds the second one forever — and this page re-reads whenever the section
  // is invalidated, so a second request is not hypothetical. The route is registered before
  // the navigation, or the read the test means to hold slips past it.
  const gate = openable()

  await page.route('**/api/me/agent-abilities/*', async (route) => {
    await gate.held
    await route.continue()
  })
  await page.goto(card)
  await expect(page.getByTestId('ability-detail-skeleton')).toBeVisible()
  await expect(page.getByRole('button', { name: ASIDE_TOGGLE })).toHaveAccessibleName(
    'Close role details',
  )
  await expect(page.getByTestId('aside-placeholder')).toBeVisible()
  expect(await stopWidth(page)).toBe(loaded)
  gate.open()
  await expect(page.getByTestId('agent-ability-detail')).toBeVisible()
  await page.unroute('**/api/me/agent-abilities/*')

  await page.route('**/api/me/agent-abilities/*', (route) =>
    route.fulfill({ status: 500, json: { error: 'boom' } }),
  )
  await page.reload()
  await expect(page.getByTestId('ability-error')).toBeVisible()
  await expect(page.getByRole('button', { name: ASIDE_TOGGLE })).toHaveAccessibleName(
    'Close role details',
  )
  await expect(page.getByTestId('aside-groups')).toHaveCount(1)
  // The panel says which of the two it is, rather than going blank in both.
  await expect(page.getByTestId('aside-placeholder')).toContainText('didn’t open')
  expect(await stopWidth(page)).toBe(loaded)
})

test('a memory note that will not open keeps its aside and says which state it is in', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  const memory = '/m/fake-project-memory/deploy-memory?context=docs'

  await page.goto(memory)
  await expect(page.getByTestId('memory-note-surface')).toBeVisible()
  await page.getByRole('button', { name: 'Open memory details' }).click()
  const loaded = await stopWidth(page)

  expect(loaded).toBeGreaterThan(0)

  // Held, not failed: the panel reserves its shape rather than announcing that a note it
  // has not read has nothing to show (#393).
  const gate = openable()

  await page.route('**/api/note?*', async (route) => {
    await gate.held
    await route.continue()
  })
  await page.goto(memory)
  await expect(page.getByTestId('aside-placeholder')).toBeVisible()
  await expect(page.getByTestId('aside-placeholder')).toHaveText('')
  expect(await stopWidth(page)).toBe(loaded)
  gate.open()
  await expect(page.getByRole('heading', { name: 'deploy-memory' })).toBeVisible()
  await page.unroute('**/api/note?*')

  await page.route('**/api/note?*', (route) => route.fulfill({ status: 500, json: { error: 'x' } }))
  await page.goto(memory)
  await expect(page.getByTestId('aside-placeholder')).toContainText('didn’t open')
  await expect(page.getByRole('button', { name: ASIDE_TOGGLE })).toHaveAccessibleName(
    'Close memory details',
  )
  expect(await stopWidth(page)).toBe(loaded)
})

test('the Context details panel witnesses the scope and commands nothing', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/agents/context')
  await expect(page.getByTestId('agents-context')).toBeVisible()
  await page.getByRole('button', { name: 'Open context details' }).click()
  const panel = page.getByTestId('context-details')
  await expect(panel).toBeVisible()
  // Addressed by field LABEL: `AsideField` has no testId of its own, and counting
  // anonymous nodes would pass just as happily on the wrong three.
  await expect(panel.getByText('Effective role', { exact: true })).toBeVisible()
  await expect(panel.getByText('Composition', { exact: true })).toBeVisible()
  await expect(panel.getByText('Auto', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button')).toHaveCount(0)
  await expect(panel.getByRole('link')).toHaveCount(0)

  await page.getByTestId('context-role-selector').click()
  await page
    .getByRole('group', { name: 'Personal' })
    .getByRole('menuitemradio', { name: 'Research' })
    .click()
  await expect(panel.getByText('Placement', { exact: true })).toBeVisible()
  // The role document is the single way out of a panel that is otherwise a witness.
  await expect(panel.getByRole('link')).toHaveCount(1)
  await expect(panel.getByRole('button')).toHaveCount(0)

  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByTestId('agents-tab-context').click()
  await page.getByTestId('context-scope-tab-docs').click()
  await expect(page).toHaveURL(/\/agents\/context\/docs$/)
  await expect(panel.getByText('Auto', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button')).toHaveCount(0)
})
