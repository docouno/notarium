import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Journey #109: the Feed's tag facet — the shared hierarchical-chips pane (same
// widget the Graph filters use), driven by the app's one filter language:
// INCLUSION. Nothing selected = no filter; clicking a tag chip ADDS it (accented),
// the Tags head × clears the lot. The facet rides the read-model snapshot's tag
// axis (NoteMeta.tags), so the filter flows through the wire into the windowed
// `total` (no client-side preview sweep). The selected tags are URL state (a
// repeatable `?tag=`), read off the aside chips — no chip floats over the content.
//
// Fixture (5 notes): demo/Titanium [metal, element], demo/Carbon [element],
// root.md [intro], demo/My Note [], archive/2020/old.md []. Sort=Modified shows all.

const items = (page: Page) => page.locator('[data-testid="feed-item"]')

const createTaggedNote = async (page: Page, baseURL: string, title: string, tags: string[]) => {
  const res = await page.request.post(`${baseURL}/api/s/main/notes`, {
    data: { title, directory: 'demo', content: `# ${title}\n\nBody for ${title}.`, tags },
  })
  expect(res.ok()).toBeTruthy()
  return (await res.json()) as { id: string }
}

test('the tag pane filters the windowed feed; the head × clears it (#109)', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('rail-files').click()
  await expect(page).toHaveURL(/\/feed$/)
  await page.getByRole('button', { name: 'Modified' }).click()
  await expect(items(page)).toHaveCount(5)

  // Open the aside that hosts the Folders + Tags facets.
  await page.getByTitle('Open panel').click()

  // Click the `element` chip → only the 2 notes carrying it survive the window, and
  // `total` (hence the count) drops server-side, not by hiding cards client-side.
  const elementChip = page.locator('[data-testid="feed-tag-filter"] button[title="element"]')
  await elementChip.click()
  await expect(page).toHaveURL(/[?&]tag=element/)
  await expect(items(page)).toHaveCount(2)
  await expect(page.locator('[data-testid="feed-item"][data-id="fake-demo-carbon"]')).toBeVisible()
  await expect(
    page.locator('[data-testid="feed-item"][data-id="fake-archive-2020-old"]'),
  ).toHaveCount(0)
  // The selected chip reads its active state in the aside (the inclusion mark) —
  // there's no chip over the content.
  await expect(elementChip).toHaveAttribute('aria-pressed', 'true')

  // The Tags head × clears the whole tag filter (back to the full window).
  await page.getByTestId('feed-tag-filter-reset').click()
  await expect(page).not.toHaveURL(/[?&]tag=/)
  await expect(items(page)).toHaveCount(5)
})

test('a tag click in the reader opens the tag-filtered feed (#109)', async ({ page }) => {
  // Open a tagged note in the reader, then click its tag chip → the feed scoped to it.
  await page.goto('/n/fake-demo-titanium')
  const tagChip = page.locator('a[data-tag="element"]')
  await expect(tagChip).toBeVisible()
  await tagChip.click()
  await expect(page).toHaveURL(/\/feed\?tag=element/)
  await expect(items(page)).toHaveCount(2)
})

test('a tag click in the Meta panel opens the same tag-filtered feed (#204)', async ({ page }) => {
  await page.goto('/n/fake-demo-titanium')
  await page.getByTitle('Open panel').click()
  await page.getByTestId('aside-tab-meta').click()

  const metaTag = page.getByTestId('meta-panel').locator('a[data-tag="element"]')
  await expect(metaTag).toBeVisible()
  await metaTag.click()
  await expect(page).toHaveURL(/\/feed\?tag=element/)
  await expect(items(page)).toHaveCount(2)
})

test('Reader and Meta show every tag; Feed cards stay compact and non-nested (#204)', async ({
  page,
  baseURL,
}) => {
  const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
  const note = await createTaggedNote(page, baseURL!, 'Five Tags', tags)

  await page.goto(`/n/${note.id}`)
  const readerTags = page.locator('article a[data-tag]')
  await expect(readerTags).toHaveCount(5)
  await expect(readerTags.nth(4)).toHaveAttribute('data-tag', 'epsilon')

  await page.getByTitle('Open panel').click()
  await page.getByTestId('aside-tab-meta').click()
  const metaTags = page.getByTestId('meta-panel').locator('a[data-tag]')
  await expect(metaTags).toHaveCount(5)
  await expect(metaTags.nth(4)).toHaveAttribute('data-tag', 'epsilon')

  await page.getByTestId('rail-files').click()
  const feedItem = page.locator(`[data-testid="feed-item"][data-id="${note.id}"]`)
  await expect(feedItem).toBeVisible()
  await expect(feedItem).toContainText('alpha')
  await expect(feedItem).toContainText('gamma')
  await expect(feedItem).not.toContainText('delta')
  await expect(feedItem).not.toContainText('epsilon')
  await expect(feedItem.locator('a[data-tag]')).toHaveCount(0)
})
