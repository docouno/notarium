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
const archived = (page: Page) =>
  page.locator('[data-testid="feed-item"][data-id="fake-archive-2020-old"]')

/** Relocate a note straight through the API — an "external" move (another
 *  client, an agent, the MCP gateway): this tab learns of it only over SSE. */
const moveExternally = async (page: Page, baseURL: string, id: string, destinationPath: string) => {
  const res = await page.request.post(`${baseURL}/api/move`, { data: { id, destinationPath } })

  expect(res.ok()).toBe(true)
}

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
  await page.getByRole('menuitem', { name: 'Show only this folder' }).click()
  await expect(items(page)).toHaveCount(3)
  await expect(
    page.locator('[data-testid="feed-item"][data-id="fake-archive-2020-old"]'),
  ).toHaveCount(0)
  await expect(page.locator('[data-testid="feed-item"][data-id="fake-demo-carbon"]')).toBeVisible()
})

// With the filter on, a note moved INTO the selected subtree by someone else must
// join the window on the `changed` frame alone. Our own cache still places it in
// the folder it LEFT, so the old location can only ever prove the reverse move —
// the event's server-truth folders are the other half of the relevance test.
test('an external move in or out of the selected folder updates the window', async ({
  page,
  baseURL,
}) => {
  // Only the WINDOW requests — the buckets/tags facets ride other paths.
  const windowRequests: string[] = []
  page.on('request', (req) => {
    if (/\/api\/s\/[^/]+\/notes\?/.test(req.url())) {
      windowRequests.push(req.url())
    }
  })

  await page.goto('/')
  await page.getByTestId('rail-files').click()
  await expect(page).toHaveURL(/\/feed$/)

  await page.getByRole('button', { name: 'Modified' }).click()
  await expect(items(page)).toHaveCount(5)
  // The unfiltered window seeds the session's resolution cache with the note's
  // CURRENT folder. That precondition IS the test: an id the session cannot
  // place counts as possibly-visible and would refetch even unfixed.
  await expect(archived(page)).toBeVisible()

  await page.getByTitle('Open panel').click()
  await page.locator(`${facet} button[title="demo"]`).click()
  await expect(items(page)).toHaveCount(3)
  await expect(archived(page)).toHaveCount(0)

  // archive/2020 → demo: the note enters the filtered window, no reload, no
  // filter flip — the coalesced SSE sweep refetches the held pages.
  await moveExternally(page, baseURL!, 'fake-archive-2020-old', 'demo/old.md')
  await expect(items(page)).toHaveCount(4, { timeout: 8000 })
  await expect(archived(page)).toBeVisible()

  // …and back out of the selection: it leaves the window the same way.
  await moveExternally(page, baseURL!, 'fake-archive-2020-old', 'archive/2020/old.md')
  await expect(items(page)).toHaveCount(3, { timeout: 8000 })
  await expect(archived(page)).toHaveCount(0)

  // Neither end selected ⇒ no window refetch: the relevance test stays precise,
  // it did not degrade into "any change refreshes".
  const baseline = windowRequests.length
  await moveExternally(page, baseURL!, 'fake-root', 'archive/2020/root.md')
  await page.waitForTimeout(1500) // past the 1s changed-coalesce window
  expect(windowRequests.length).toBe(baseline)
  await expect(items(page)).toHaveCount(3)
})
