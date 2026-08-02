import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Journey #93/#109: the Feed's Folders facet is an INCLUSION filter (the app's one
// filter language) — a click ADDS a folder to the focus (server-side, via `folders`),
// selecting more widens the window (OR/union), and "Show only this folder" narrows to
// just it. Server-windowed, so this exercises the filter flowing through the wire into
// the windowed total.
//
// Fixture (5 notes): demo/{Titanium,Carbon,My Note}, root.md, archive/2020/old.md.
// Sort=Modified shows all five (Created would hide the undated ones).

const items = (page: Page) => page.locator('[data-testid="feed-item"]')
const facet = '[data-testid="feed-folder-filter"]'

test('Folders facet narrows to selected subtrees (inclusion, server-windowed)', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('rail-files').click()
  await expect(page).toHaveURL(/\/feed$/)

  await page.getByRole('button', { name: 'Modified' }).click()
  await expect(items(page)).toHaveCount(5)

  // open the aside that hosts the Folders facet
  await page.getByTitle('Open panel').click()

  // Select `demo` → only its 3 notes survive the windowed total (nothing else).
  const demo = page.locator(`${facet} button[title="demo"]`)
  await demo.click()
  await expect(items(page)).toHaveCount(3)
  await expect(page.locator('[data-testid="feed-item"][data-id="fake-demo-carbon"]')).toBeVisible()
  await expect(
    page.locator('[data-testid="feed-item"][data-id="fake-archive-2020-old"]'),
  ).toHaveCount(0)

  // Add `archive` → demo ∪ archive = 4 (OR/union; root.md sits under neither).
  await page.locator(`${facet} button[title="archive"]`).click()
  await expect(items(page)).toHaveCount(4)
  await expect(
    page.locator('[data-testid="feed-item"][data-id="fake-archive-2020-old"]'),
  ).toBeVisible()

  // The facet head × clears the filter (back to all five).
  await page.getByTestId('feed-folder-filter-reset').click()
  await expect(items(page)).toHaveCount(5)

  // "Show only this folder" on `demo` (right-click) selects just it — exactly the
  // demo subtree; root.md is under no folder, so it drops (the inclusion refinement).
  await demo.click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Show only this folder' }).click()
  await expect(items(page)).toHaveCount(3)
  await expect(
    page.locator('[data-testid="feed-item"][data-id="fake-archive-2020-old"]'),
  ).toHaveCount(0)
  await expect(page.locator('[data-testid="feed-item"][data-id="fake-demo-carbon"]')).toBeVisible()
})
