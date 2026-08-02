import { expect, test } from './fixtures'

// #68.3 — switching to another note must not leave the PREVIOUS note's content
// on screen while the next one loads. fetchNote sets activeId optimistically but
// `note` holds the previous note until its replacement lands, so the main reader
// used to show the old note (URL and tree already moved on). The fix derives a
// `navigating` flag (loading && note.id !== activeId) and renders the note
// skeleton instead of the stale content — while the shell (breadcrumbs, panel)
// stays put so it doesn't collapse for a blink.

test('switching notes shows a skeleton, not the previous note, while the next loads', async ({
  page,
}) => {
  // Hold Carbon's response so the in-flight (navigating) state is observable.
  await page.route(
    (url) => url.pathname === '/api/note' && url.searchParams.get('id') === 'fake-demo-carbon',
    async (route) => {
      await new Promise((r) => setTimeout(r, 1200))
      await route.continue()
    },
  )

  await page.goto('/')
  const titanium = page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]')
  const carbon = page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')
  await titanium.click()
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toBeVisible()

  // Switch to Carbon (its response is held): the main column must show the note
  // skeleton, and Titanium's content must be GONE — not held while Carbon loads.
  await carbon.click()
  await expect(page.getByTestId('note-skeleton')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toHaveCount(0)
  await expect(page).toHaveURL(/\/n\/fake-demo-carbon$/)

  // Once Carbon's response lands, the skeleton gives way to its content.
  await expect(page.getByRole('heading', { name: 'Carbon', level: 1 })).toBeVisible()
  await expect(page.getByTestId('note-skeleton')).toHaveCount(0)
})
