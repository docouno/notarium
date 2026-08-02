import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Journey #201: the Feed date range is URL state (`from`/`to` as local
// YYYY-MM-DD), applied server-side before the window and the bucket histogram.
// UI v1 filters by the current sort axis: the default Created sort means this
// range addresses createdAt. The aside owns the visible controls and reset.

const items = (page: Page) => page.locator('[data-testid="feed-item"]')

test('Feed date range narrows from URL and clears from the aside (#201)', async ({ page }) => {
  await page.goto('/s/main/feed?sort=created&from=2026-06-02&to=2026-06-02')

  // Default sort = Created. Only Carbon was created on 2026-06-02 in the fixture.
  await expect(items(page)).toHaveCount(1)
  await expect(page.locator('[data-testid="feed-item"][data-id="fake-demo-carbon"]')).toBeVisible()
  await expect(page.locator('[data-testid="feed-item"][data-id="fake-demo-titanium"]')).toHaveCount(
    0,
  )

  await page.getByTitle('Open panel').click()
  await expect(page.getByTestId('feed-date-filter')).toContainText('Created date')
  await expect(page.getByTestId('feed-date-from')).toContainText('2 Jun 2026')
  await expect(page.getByTestId('feed-date-to')).toContainText('2 Jun 2026')

  await page.getByTestId('feed-date-filter-reset').click()
  await expect(page).not.toHaveURL(/[?&](from|to)=/)
  await expect(items(page)).toHaveCount(3)
})

test('Feed date picker writes URL state and sends timezone to the API (#201)', async ({ page }) => {
  const noteRequests: string[] = []
  page.on('request', (req) => {
    const url = new URL(req.url())

    if (url.pathname === '/api/s/main/notes' && url.searchParams.has('from')) {
      noteRequests.push(url.href)
    }
  })

  await page.goto('/s/main/feed?from=2026-06-02&to=2026-06-03')
  await page.getByTitle('Open panel').click()

  await page.getByTestId('feed-date-to').click()
  await page
    .getByRole('dialog', { name: 'Choose date' })
    .getByRole('button', { name: '2' })
    .first()
    .click()
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get('sort') === 'created' &&
      url.searchParams.get('from') === '2026-06-02' &&
      url.searchParams.get('to') === '2026-06-02',
  )
  await expect(items(page)).toHaveCount(1)
  await expect
    .poll(() =>
      noteRequests.some((href) => {
        const url = new URL(href)
        return url.searchParams.get('from') === '2026-06-02' && url.searchParams.has('tz')
      }),
    )
    .toBe(true)
})

test('Feed date filter title names the modified axis (#201)', async ({ page }) => {
  await page.goto('/s/main/feed')

  await page.getByRole('button', { name: 'Modified' }).click()
  await page.getByTitle('Open panel').click()
  await expect(page.getByTestId('feed-date-filter')).toContainText('Modified date')
})

test('Feed date deep link owns its axis even when local sort preference differs (#201)', async ({
  page,
}) => {
  await page.goto('/s/main/feed')
  await page.evaluate(() => localStorage.setItem('bm-feed-sort', 'modified'))

  await page.goto('/s/main/feed?from=2026-06-02&to=2026-06-02')
  await expect(items(page)).toHaveCount(1)
  await expect(page.locator('[data-testid="feed-item"][data-id="fake-demo-carbon"]')).toBeVisible()

  await page.getByTitle('Open panel').click()
  await expect(page.getByTestId('feed-date-filter')).toContainText('Created date')

  await page.goto('/s/main/feed')
  if (
    await page
      .getByTitle('Open panel')
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByTitle('Open panel').click()
  }
  await expect(page.getByTestId('feed-date-filter')).toContainText('Modified date')
})

test('Invalid date URL does not override the saved sort preference (#201)', async ({ page }) => {
  await page.goto('/s/main/feed')
  await page.evaluate(() => localStorage.setItem('bm-feed-sort', 'modified'))

  await page.goto('/s/main/feed?from=2026-02-30')
  await page.getByTitle('Open panel').click()
  await expect(page.getByTestId('feed-date-filter')).toContainText('Modified date')
  await expect(page.getByTestId('feed-date-from')).toContainText('Any date')
})

test('Feed date range prevents an end date before the start (#201)', async ({ page }) => {
  await page.goto('/s/main/feed?sort=created&from=2026-06-02&to=2026-06-02')

  await page.getByTitle('Open panel').click()
  await page.getByTestId('feed-date-to').click()
  let dialog = page.getByRole('dialog', { name: 'Choose date' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Previous' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '1' }).first()).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '2' }).first()).toBeEnabled()

  await page.keyboard.press('Escape')
  await page.getByTestId('feed-date-from').click()
  dialog = page.getByRole('dialog', { name: 'Choose date' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '3' }).first()).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '2' }).first()).toBeEnabled()
})

test('Feed empty clear drops all URL filter axes at once (#201)', async ({ page }) => {
  await page.goto(
    '/s/main/feed?sort=created&tag=element&q=zzznomatch&from=2026-06-02&to=2026-06-02',
  )

  await expect(page.getByTestId('feed-empty-clear')).toBeVisible()
  await page.getByTestId('feed-empty-clear').click()
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get('sort') === 'created' &&
      !url.searchParams.has('tag') &&
      !url.searchParams.has('q') &&
      !url.searchParams.has('from') &&
      !url.searchParams.has('to'),
  )
  await expect(items(page)).toHaveCount(3)
})

test('Feed ignores stale to-before-from URLs without blocking the From picker (#201)', async ({
  page,
}) => {
  await page.goto('/s/main/feed?sort=created&from=2026-06-03&to=2026-06-02')

  await page.getByTitle('Open panel').click()
  await expect(page.getByTestId('feed-date-to')).toContainText('Any date')

  await page.getByTestId('feed-date-from').click()
  await page
    .getByRole('dialog', { name: 'Choose date' })
    .getByRole('button', { name: '10' })
    .first()
    .click()
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('from') === '2026-06-10' && !url.searchParams.has('to'),
  )
})

test('DatePicker clamps keyboard month jumps to real calendar days (#201)', async ({ page }) => {
  await page.goto('/s/main/feed?sort=created&from=2026-01-31')

  await page.getByTitle('Open panel').click()
  await page.getByTestId('feed-date-from').click()
  const dialog = page.getByRole('dialog', { name: 'Choose date' })
  await dialog.press('PageDown')
  await dialog.press('Enter')
  await expect(page).toHaveURL((url) => url.searchParams.get('from') === '2026-02-28')
})
