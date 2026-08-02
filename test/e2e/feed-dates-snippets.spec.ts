import { expect, test } from './fixtures'

// Journey #6 (#32): the Feed reads dates from two signals — createdAt (precise,
// only within the backend's window) and modifiedAt (every note). Sorting by
// Created therefore hides notes that have no createdAt; Modified shows them all.
// Card snippets load lazily once a card is in view. (Relative date-group labels
// depend on the wall clock, so they're left to the visual layer #18.4; here we
// assert the clock-independent behaviour.)

test('Created vs Modified governs which notes appear; snippets lazy-load', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('rail-files').click()
  await expect(page).toHaveURL(/\/feed$/)

  const items = page.locator('[data-testid="feed-item"]')

  // Default sort = Created → only the 3 notes WITH createdAt show; the two
  // without (My Note, Old Archive) are hidden.
  await expect(items).toHaveCount(3)
  await expect(page.locator('[data-testid="feed-item"][data-id="fake-demo-my-note"]')).toHaveCount(
    0,
  )
  await expect(
    page.locator('[data-testid="feed-item"][data-id="fake-demo-titanium"]'),
  ).toBeVisible()

  // a top card's snippet streams in (lazy per-viewport fetch from the fake)
  await expect(
    page.locator('[data-testid="feed-item"][data-id="fake-demo-titanium"]'),
  ).toContainText('strong, light metal')

  // switch to Modified → every note appears, including the createdAt-less ones
  await page.getByRole('button', { name: 'Modified' }).click()
  await expect(items).toHaveCount(5)
  await expect(page.locator('[data-testid="feed-item"][data-id="fake-demo-my-note"]')).toBeVisible()
  await expect(
    page.locator('[data-testid="feed-item"][data-id="fake-archive-2020-old"]'),
  ).toBeVisible()
})
