import { expect, openSpotlight, test } from './fixtures'

// Spotlight quick-switcher (#31): the centred jump-to-note overlay. It coexists
// with the rail's "Search view" (the strip's Search icon) — Spotlight is the
// transient Cmd/Ctrl+P switcher, hotkey-only (VS Code Quick Open). Keyboard-first
// over the hybrid backend (#81), with recents as the empty state. The base fixture
// (space `main`) holds Welcome (root, newest), Titanium + Carbon + My Note (demo/),
// and Old Archive — modified order: Welcome, Titanium, Carbon, My Note, Old Archive.

test('opens via Cmd/Ctrl+P; Recent lists recently-modified notes; Escape closes', async ({
  page,
}) => {
  await page.goto('/')

  // Hotkey (Cmd/Ctrl+P) — the print default is suppressed, the overlay opens.
  await openSpotlight(page)
  // Empty query → Recent. No note opened yet, so it's the server's recently-modified
  // window: Welcome is the newest.
  const first = page.getByTestId('spotlight-result').first()
  await expect(first).toContainText('Welcome')
  await expect(first.locator('time')).toHaveAttribute('datetime', '2026-06-05T08:00:00.000Z')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('spotlight-input')).toHaveCount(0)
})

test('search filters with highlighted matches; Enter opens the canonical note URL', async ({
  page,
}) => {
  await page.goto('/')
  await openSpotlight(page)

  // 'metal' is unique to Titanium's body — 'titanium' would also match Carbon, whose
  // body links [[Titanium]] (the fake search is a title+content substring match).
  await page.getByTestId('spotlight-input').fill('metal')
  const results = page.getByTestId('spotlight-result')
  await expect(results).toHaveCount(1)
  await expect(results.first()).toContainText('Titanium')
  await expect(results.first().locator('time')).toHaveAttribute(
    'datetime',
    '2026-06-01T09:00:00.000Z',
  )
  await expect(results.first()).toContainText('demo')
  await expect(results.first()).toContainText('element')
  // Matches are highlighted client-side (the backend has no offsets) — here in the snippet.
  await expect(page.locator('[data-testid="spotlight-result"] mark').first()).toHaveText('metal')

  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
  await expect(page.getByTestId('spotlight-input')).toHaveCount(0) // closed on open
})

test('arrow keys move the selection; Enter opens the highlighted row', async ({ page }) => {
  await page.goto('/')
  await openSpotlight(page)

  // Recent: Welcome(0), Titanium(1). ArrowDown highlights the second.
  const results = page.getByTestId('spotlight-result')
  await expect(results.nth(0)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(results.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(results.nth(1)).toContainText('Titanium')

  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
})

test('Cmd/Ctrl+Enter opens the result in a new tab; the current page stays put', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await openSpotlight(page)
  await page.getByTestId('spotlight-input').fill('metal') // unique to Titanium (see above)
  await expect(page.getByTestId('spotlight-result')).toHaveCount(1)

  const popupPromise = context.waitForEvent('page')
  await page.keyboard.press('Control+Enter')
  const popup = await popupPromise
  await popup.waitForURL(/\/n\/fake-demo-titanium\/titanium$/)
  await popup.close()

  // The opener never navigated — it's still on the space home.
  expect(new URL(page.url()).pathname).toBe('/s/main')
})

test('opening a note promotes it to the top of Recent (MRU)', async ({ page }) => {
  await page.goto('/')

  // Open a note that is NOT the newest-modified (Titanium sits behind Welcome).
  await page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]').click()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)

  await openSpotlight(page)
  // MRU wins the ordering: the just-opened Titanium is now first, ahead of Welcome.
  const first = page.getByTestId('spotlight-result').first()
  await expect(first).toContainText('Titanium')
  await expect(first.locator('time')).toHaveAttribute('datetime', '2026-06-01T09:00:00.000Z')
  await expect(first).toContainText('element')
})

test('no matches shows the empty state; Escape closes', async ({ page }) => {
  await page.goto('/')
  await openSpotlight(page)

  await page.getByTestId('spotlight-input').fill('zzqqxnope')
  await expect(page.getByTestId('spotlight-empty')).toBeVisible()
  await expect(page.getByTestId('spotlight-result')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('spotlight-input')).toHaveCount(0)
})
