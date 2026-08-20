import { agentActivityRoute, feedQueryRoute } from '../../packages/web/src/libs/routing/routePaths'
import { expect, test } from './fixtures'

for (const path of ['/s/main/feed/', '/s/main/Feed']) {
  test(`a router-valid Feed path loads its window: ${path}`, async ({ page }) => {
    const requests: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())

      if (url.pathname === '/api/s/main/notes') {
        requests.push(url.href)
      }
    })

    await page.goto(path)
    await expect(page.getByTestId('feed-row').first()).toBeVisible()
    expect(requests.length).toBeGreaterThan(0)
  })
}

test('an off-Feed q bookmark does not boot the Feed window', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())

    if (url.pathname === '/api/s/main/notes') {
      requests.push(url.href)
    }
  })

  await page.goto(`${agentActivityRoute()}?tool=search&q=metal`)
  await expect(page.getByTestId('agents-activity')).toBeVisible()

  expect(requests).toEqual([])
})

test('an off-Feed q leaves the held Feed window untouched', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())

    if (url.pathname === '/api/s/main/notes') {
      requests.push(url.href)
    }
  })

  await page.goto(feedQueryRoute('main', 'metal'))
  const rows = page.getByTestId('feed-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Titanium')
  const baseline = requests.length

  await page.getByTestId('rail-agents').click()
  // Agents lands on its package library, not on Context — the rail opens the
  // section, and the section's first surface is Abilities.
  await expect(page.getByTestId('agents-roles')).toBeVisible()
  await page.evaluate((path) => {
    history.replaceState(null, '', path)
    dispatchEvent(new PopStateEvent('popstate'))
  }, `${agentActivityRoute()}?tool=search&q=blind-spot`)
  await expect(page).toHaveURL(/\/agents\/activity\?tool=search&q=blind-spot$/)
  await expect(page.getByTestId('agents-activity')).toBeVisible()

  expect(requests).toHaveLength(baseline)

  await page.goBack()
  await expect(page).toHaveURL(feedQueryRoute('main', 'metal'))
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Titanium')
  expect(requests).toHaveLength(baseline)
})
