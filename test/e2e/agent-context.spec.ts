import { type Page } from '@playwright/test'
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
  ],
  projects: [
    { space: 'main', path: 'docs', slug: 'docs', displayName: 'Docs', aliases: ['old-docs'] },
    { space: 'main', path: 'specs', slug: 'specs', displayName: 'Specs' },
  ],
  agentRoles: [
    { name: 'research', target: { kind: 'personal', user: 'sam' } },
    { name: 'grooming', target: { kind: 'personal', user: 'sam' } },
    { name: 'research', target: { kind: 'project', space: 'main', path: 'docs' } },
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
    ],
    members: [
      { space: 'main', username: 'sam', role: 'owner' },
      { space: 'main', username: 'robin', role: 'reader' },
      { space: 'sam-personal', username: 'sam', role: 'owner' },
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
  await expect(page.getByRole('menuitemradio', { name: 'Unmute' })).toBeVisible()
  await page.keyboard.press('Escape')

  await language.getByTestId('context-memory-row-menu').click()
  await expect(page.getByRole('menuitemradio', { name: 'Mute' })).toBeVisible()

  // Toggle the loaded category → it mutes (the write lands, the row reconciles): the
  // row now carries the Muted badge and its menu offers "Unmute" (the reverse) instead.
  await page.getByRole('menuitemradio', { name: 'Mute' }).click()
  await expect(language).toContainText('Muted')
  await language.getByTestId('context-memory-row-menu').click()
  await expect(page.getByRole('menuitemradio', { name: 'Unmute' })).toBeVisible()
})

test('a note’s ⋮ menu offers «Pin to agent context» where a pin has a target', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')

  // The plain note is unpinned → the action reads «Pin to agent context».
  await page.goto('/n/fake-scratch')
  await expect(page.getByRole('heading', { name: 'Scratch' })).toBeVisible()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitemradio', { name: 'Pin to agent context' })).toBeVisible()
  await page.getByRole('menuitemradio', { name: 'Pin to agent context' }).click()

  // It now reads as pinned in the Context constructor (the pinned list shows directly).
  await page.goto('/agents/context/personal')
  await expect(page.getByTestId('context-pin-row').filter({ hasText: 'Scratch' })).toBeVisible()

  // The already-pinned note offers «Unpin from agent context».
  await page.goto('/n/fake-deploy')
  await expect(page.getByRole('heading', { name: 'Deploy Runbook' })).toBeVisible()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitemradio', { name: 'Unpin from agent context' })).toBeVisible()
})

test('folder overview actions and picker rows name the note boundary explicitly', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/n/fake-project-overview')
  await expect(page.getByRole('heading', { name: 'Docs overview' })).toBeVisible()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(
    page.getByRole('menuitemradio', { name: 'Unpin folder overview from agent context' }),
  ).toBeVisible()
  await page
    .getByRole('menuitemradio', { name: 'Unpin folder overview from agent context' })
    .click()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(
    page.getByRole('menuitemradio', { name: 'Pin folder overview to agent context' }),
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
  await page.getByRole('link', { name: 'Docs' }).click()
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

test('a project route focuses the project; the Personal tab switches to it inline (#208)', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/s/main')
  await expect(page.getByTestId('space-switcher')).toContainText('Main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await expect(page).toHaveURL(/\/agents\/context\/personal$/)
  await page.getByRole('link', { name: 'Docs' }).click()
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
  await page.getByRole('menuitemradio', { name: 'Open note' }).click()
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
  const personalPin = await page.request.put('/api/me/agent-roles/research/context-pins', {
    data: { space: 'sam-personal', noteId: 'fake-scratch' },
  })
  expect(personalPin.ok()).toBe(true)
  const projectPin = await page.request.put(
    '/api/me/agent-roles/research/context-pins?projectId=proj-main-docs',
    { data: { space: 'main', noteId: 'fake-project-scratch' } },
  )
  expect(projectPin.ok()).toBe(true)

  await page.goto('/agents/context/personal')
  await page.getByTestId('context-role-selector').click()
  await page.getByRole('menuitemradio', { name: 'research · Personal' }).click()
  await expect(page).toHaveURL(/\/agents\/context\/personal\?role=research$/)
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
  await page.getByRole('link', { name: 'Docs' }).click()
  await page.getByTestId('context-role-selector').click()
  await page.getByRole('menuitemradio', { name: 'research · Project' }).click()
  await expect(page).toHaveURL(/\/agents\/context\/docs\?role=research$/)
  await expect(page.getByTestId('context-role')).toBeVisible()
  await expect(page.getByTestId('context-role-pins')).toContainText('Project Scratch')
  await expect(
    page.getByTestId('context-role-pins').getByText('Scratch', { exact: true }),
  ).toHaveCount(0)

  // A role is an orthogonal context axis: scope navigation preserves the selection
  // and resolves the same name against the destination's exact placement.
  await page.getByTestId('context-scope-tab-personal').click()
  await expect(page).toHaveURL(/\/agents\/context\/personal\?role=research$/)
  await expect(page.getByTestId('context-role-pins')).toContainText('Scratch')
  await expect(page.getByTestId('context-role-pins')).not.toContainText('Project Scratch')
  await page.getByTestId('context-scope-tab-docs').click()
  await expect(page).toHaveURL(/\/agents\/context\/docs\?role=research$/)
  await expect(page.getByTestId('context-role-pins')).toContainText('Project Scratch')

  await page.goto('/agents/context/proj-main-docs?role=research')
  await expect(page).toHaveURL(/\/agents\/context\/docs\?role=research$/)
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
  for (const [role, noteId] of [
    ['research', 'fake-scratch'],
    ['grooming', 'fake-grooming'],
  ] as const) {
    expect(
      (
        await page.request.put(`/api/me/agent-roles/${role}/context-pins`, {
          data: { space: 'sam-personal', noteId },
        })
      ).ok(),
    ).toBe(true)
  }
  await page.route('**/api/me/agent-context?role=research', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route.continue()
  })

  await page.goto('/agents/context/personal')
  await page.getByTestId('context-role-selector').click()
  await page.getByRole('menuitemradio', { name: 'research · Personal' }).click()
  await page.getByTestId('context-role-selector').click()
  await page.getByRole('menuitemradio', { name: 'grooming · Personal' }).click()
  await expect(page).toHaveURL(/\?role=grooming$/)
  await expect(page.getByTestId('context-role-pins')).toContainText('Grooming Checklist')
  await expect(page.getByTestId('context-role-pins')).not.toContainText('Scratch')
  await page.waitForTimeout(400)
  await expect(page.getByTestId('context-role-pins')).toContainText('Grooming Checklist')

  await page.goto('/agents/context/personal?role=removed-role')
  await expect(page).toHaveURL(/\/agents\/context\/personal$/)
  await expect(page.getByTestId('context-profile')).toBeVisible()
  await expect(page.getByTestId('context-role')).toHaveCount(0)
})

test('a failed role preview exposes no base mutation surface', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')
  await page.route('**/api/s/main/projects/*/agent-context?role=research', async (route) => {
    await route.fulfill({ status: 503, body: 'temporarily unavailable' })
  })

  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByRole('link', { name: 'Docs' }).click()
  await page.getByTestId('context-role-selector').click()
  await page.getByRole('menuitemradio', { name: 'research · Project' }).click()
  await expect(page.getByTestId('context-error')).toContainText('Couldn’t load project context')
  await expect(page).toHaveURL(/\/agents\/context\/docs\?role=research$/)
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
  await page.getByRole('link', { name: 'Docs' }).click()
  await page.getByTestId('context-role-selector').click()
  await page.getByRole('menuitemradio', { name: 'research · Project' }).click()

  await expect(page.getByTestId('context-role')).toBeVisible()
  await expect(page.getByTestId('context-role-readonly')).toBeVisible()
  await expect(page.getByTestId('context-add-role-pin')).toHaveCount(0)
})

test('project context shows, adds, and removes project pins', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByRole('link', { name: 'Docs' }).click()
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
  await page.getByRole('menuitemradio', { name: 'Unpin' }).click()
  await expect(projectPins.filter({ hasText: 'Project Scratch' })).toHaveCount(0)
})

test('the project context audits project memory and muting it persists across a reload (#207)', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByRole('link', { name: 'Docs' }).click()
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
  await page.getByRole('menuitemradio', { name: 'Mute' }).click()
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
  await expect(page.getByRole('menuitemradio', { name: 'Unmute' })).toBeVisible()
})

test('switching from one project to another re-targets the project Memory block (#207)', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/s/main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByRole('link', { name: 'Docs' }).click()
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

test('the Memory explorer lists project memory and opens it through /m', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/s/main')
  await expect(page.getByTestId('space-switcher')).toContainText('Main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await expect(page.getByTestId('agents-context')).toBeVisible()
  await expect(page.getByTestId('memory-tree')).toBeVisible()

  const projectMemory = page.getByTestId('memory-leaf').filter({ hasText: 'deploy-memory' })
  await expect(projectMemory).toBeVisible()
  await projectMemory.click()
  await expect(page).toHaveURL(/\/m\/fake-project-memory/)
  await expect(page.getByRole('heading', { name: 'deploy-memory' })).toBeVisible()
})

test('agent context and note routes canonicalize legacy forms', async ({ page }) => {
  await login(page, 'sam', 'sam-password-1')
  const projects = (await (await page.request.get('/api/s/main/projects')).json()) as {
    projects: Array<{ id: string; slug: string }>
  }
  const docsProject = projects.projects.find((p) => p.slug === 'docs')!

  await page.goto('/agents')
  await expect(page).toHaveURL(/\/agents\/context\/personal$/)
  await page.goto('/agents/context')
  await expect(page).toHaveURL(/\/agents\/context\/personal$/)
  await page.goto('/agents/session')
  await expect(page).toHaveURL(/\/agents\/sessions$/)

  await page.goto('/s/main')
  await expect(page.getByTestId('space-switcher')).toContainText('Main')
  await page.getByRole('link', { name: 'Agents' }).click()
  await page.getByRole('link', { name: 'Docs' }).click()
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
