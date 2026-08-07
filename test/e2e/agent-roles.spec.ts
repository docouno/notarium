import { buildCaseWorld, caseToFixture } from '../cases'
import { expect, type Page, test } from './fixtures'

const WORLD = caseToFixture(buildCaseWorld('agent-roles', { now: '2099-08-05T12:00:00.000Z' }))

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

test('Roles keeps the catalog separate and Add creates an owned personal fork', async ({
  page,
}) => {
  await login(page)
  await page.goto('/agents/roles')

  await expect(page.getByTestId('agents-roles')).toBeVisible()
  await expect(page.getByText('No roles added')).toBeVisible()
  await expect(page.getByTestId('catalog-role-grooming')).toBeVisible()
  await expect(page.getByTestId('catalog-role-research')).toBeVisible()

  await page.getByTestId('role-view-grooming-catalog').click()
  const catalogDetail = page.getByTestId('role-detail-grooming')
  await expect(catalogDetail).toBeVisible()
  await expect(catalogDetail).toContainText('Role instructions')
  await expect(catalogDetail).toContainText('Establish the underlying pain')
  await expect(catalogDetail).toContainText('grooming-evidence')
  await expect(catalogDetail).toContainText('Read-only preview')
  await expect(catalogDetail.locator('h1')).toHaveCount(0)
  await expect(
    catalogDetail.getByRole('heading', { name: 'Grooming', exact: true, level: 4 }),
  ).toBeVisible()
  await expect(
    catalogDetail.getByRole('heading', { name: 'Evidence for grooming', exact: true, level: 5 }),
  ).toBeVisible()
  const detailIds = await catalogDetail
    .locator('[id]')
    .evaluateAll((nodes) => nodes.map((node) => node.id).filter(Boolean))
  expect(new Set(detailIds).size).toBe(detailIds.length)
  await page.getByRole('button', { name: 'Close role details' }).click()

  await page.getByTestId('role-add-grooming').click()
  await expect(page.getByRole('heading', { name: 'Add grooming' })).toBeVisible()
  await expect(page.getByTestId('role-add-scope')).toContainText('Personal')
  await page.getByTestId('role-add-confirm').click()

  const owned = page.getByTestId('owned-role-personal:grooming')
  await expect(owned).toBeVisible()
  await expect(owned).toContainText('Personal')
  await expect(owned).toContainText('Forked from built-in catalog')
  await expect(page.getByTestId('catalog-role-grooming')).toBeVisible()
  await expect(page.getByTestId('agents-tab-roles')).toContainText('1 role')

  await page.getByTestId('role-view-personal:grooming').click()
  const ownedDetail = page.getByTestId('role-detail-grooming')
  await expect(ownedDetail).toContainText('Personal')
  await expect(ownedDetail).toContainText('Establish the underlying pain')
})

test('Project choices stay unambiguous when display names collide', async ({ page }) => {
  await login(page)
  await page.goto('/agents/roles')
  await page.getByTestId('role-add-research').click()
  const scope = page.getByTestId('role-add-scope')
  await scope.focus()
  await page.keyboard.press('ArrowDown')
  await expect(scope).toHaveValue('project')

  const project = page.getByTestId('role-add-project')
  await expect(project.locator('option')).toHaveText(['Main — main', 'Main — main/other'])
  await project.focus()
  await page.keyboard.press('ArrowDown')
  await expect(project).toHaveValue('main/other')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('role-add-confirm')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('owned-role-project:main:main/other:research')).toContainText(
    'Project · main/other',
  )
})

test('An active role name does not falsely mark both same-name forks active', async ({ page }) => {
  await login(page, 'maya')
  await page.route('**/api/me/agent-roles', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), truncated: true } })
  })
  await page.goto('/agents/roles')

  await expect(page.getByTestId('owned-role-personal:research')).toContainText('Personal')
  await expect(page.getByTestId('owned-role-space:team::research')).toContainText('Space · team')
  await expect(page.getByTestId('owned-role-project:team:team/other:research')).toContainText(
    'Project · team/other',
  )
  await expect(
    page.getByTestId('owned-role-project:maya-home:maya-home/work:research'),
  ).toContainText('Project · maya-home/work')
  await expect(
    page.getByRole('button', { name: 'View research role in Personal', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'View research role in Project · maya-home/work',
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'View built-in research role', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Add built-in research role', exact: true }),
  ).toBeVisible()
  await expect(page.getByTestId('agents-tab-roles')).toContainText('5+ roles · research active')
  await expect(page.getByText('Active session')).toHaveCount(0)
})

test('A truncated empty window never claims that no roles are added', async ({ page }) => {
  await login(page)
  await page.route('**/api/me/agent-roles', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), truncated: true } })
  })
  await page.goto('/agents/roles')

  await expect(page.getByText('No roles in this bounded view')).toBeVisible()
  await expect(page.getByText('No roles added')).toHaveCount(0)
  await expect(page.getByTestId('agents-tab-roles')).toContainText('partial role count')
  await expect(page.getByTestId('catalog-role-grooming')).toBeVisible()
})

test('A completed Add remains visible when the follow-up refresh fails', async ({ page }) => {
  await login(page)
  await page.goto('/agents/roles')
  await expect(page.getByText('No roles added')).toBeVisible()

  await page.route('**/api/me/agent-roles', async (route) => {
    if (route.request().method() === 'GET') {
      await route.abort('connectionfailed')
    } else {
      await route.continue()
    }
  })
  await page.getByTestId('role-add-grooming').click()
  await page.getByTestId('role-add-confirm').click()

  await expect(page.getByTestId('owned-role-personal:grooming')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
  await page.unroute('**/api/me/agent-roles')
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
})

test('A late chrome bootstrap cannot roll the Roles pill back after Add', async ({ page }) => {
  await login(page)
  let releaseFirst!: () => void
  let markCaptured!: () => void
  let markFinished!: () => void
  const release = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const captured = new Promise<void>((resolve) => {
    markCaptured = resolve
  })
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve
  })
  let rolesGets = 0

  await page.route('**/api/me/agent-roles', async (route) => {
    if (route.request().method() !== 'GET' || rolesGets++ > 0) {
      await route.continue()
      return
    }
    const stale = await route.fetch()
    markCaptured()
    await release
    await route.fulfill({ response: stale })
    markFinished()
  })

  await page.goto('/agents/context')
  await captured
  await page.getByTestId('agents-tab-roles').click()
  await expect(page.getByText('No roles added')).toBeVisible()
  await page.getByTestId('role-add-grooming').click()
  await page.getByTestId('role-add-confirm').click()
  await expect(page.getByTestId('agents-tab-roles')).toContainText('1 role')

  releaseFirst()
  await finished
  await expect(page.getByTestId('agents-tab-roles')).toContainText('1 role')
})
