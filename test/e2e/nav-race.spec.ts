import { expect, test } from './fixtures'

// #68.2 — fast file switching must be latest-wins. When two opens race, the
// SLOWER (earlier-clicked) note's response lands LAST and must NOT hijack the
// reader from the note the user actually settled on. Before the fix, fetchNote
// applied every response unconditionally, so a stale answer yanked you back to
// a note you'd already navigated away from — the reader and the URL diverged.

test('fast file switching is latest-wins: a slow stale response never hijacks the reader', async ({
  page,
}) => {
  // Hold Titanium's note response well past Carbon's, so its (now stale) answer
  // is the LAST to land — exactly the out-of-order case the race produced.
  await page.route(
    (url) => url.pathname === '/api/note' && url.searchParams.get('id') === 'fake-demo-titanium',
    async (route) => {
      await new Promise((r) => setTimeout(r, 1200))
      await route.continue()
    },
  )

  await page.goto('/')
  const titanium = page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]')
  const carbon = page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')
  await expect(titanium).toBeVisible()

  // Click the slow note, then immediately the fast one — the user "settles" on Carbon.
  await titanium.click()
  await carbon.click()

  // Carbon opens right away (its response isn't held).
  await expect(page).toHaveURL(/\/n\/fake-demo-carbon\/carbon$/)
  await expect(page.getByRole('heading', { name: 'Carbon', level: 1 })).toBeVisible()

  // Wait past Titanium's delay: its stale response must be IGNORED — the reader
  // stays on Carbon, the URL stays on Carbon, and the tree's active row stays Carbon.
  await page.waitForTimeout(1500)
  await expect(page.getByRole('heading', { name: 'Carbon', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toHaveCount(0)
  await expect(page).toHaveURL(/\/n\/fake-demo-carbon\/carbon$/)
  await expect(carbon).toHaveAttribute('aria-current', 'page')
  await expect(titanium).not.toHaveAttribute('aria-current', 'page')
})
