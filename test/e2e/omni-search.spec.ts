import { expect, test } from './fixtures'

// Cross-cutting search (#190): the rail no longer hosts a Search VIEW. The strip's
// Search icon opens the Spotlight quick-switcher; the topbar OmniSearch (Home/Feed)
// offers quick-jump suggestions AND an Enter hand-off to the Feed's detailed `?q=`
// search, where it composes with the folder/tag filters and the date histogram.
// Base fixture (space `main`): Titanium + Carbon + My Note + Welcome + Old Archive;
// 'metal' lives in Titanium's body (so it matches Titanium, not Carbon).

// The inline topbar search is a WIDE-SCREEN affordance (#190): below ~1320px of
// topbar width it's dropped (search lives in Spotlight there). The default device
// viewport (1280) is below that, so widen it for the tests that drive the field.
test.use({ viewport: { width: 1800, height: 1000 } })

test('rail Search icon opens Spotlight — there is no rail Search view', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-testid="tree-note"]').first()).toBeVisible()
  // The old in-panel Search view (its input) is gone for good.
  await expect(page.getByTestId('rail-search-input')).toHaveCount(0)
  // The strip's Search icon opens the centred switcher instead.
  await page.getByTestId('rail-search').click()
  await expect(page.getByTestId('spotlight-input')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('spotlight-input')).toHaveCount(0)
})

test('topbar OmniSearch: Enter narrows the Feed to ?q=, composing the window', async ({ page }) => {
  await page.goto('/s/main/feed')
  const omni = page.getByTestId('omni-search')
  await omni.click()
  await omni.fill('metal')
  // The dropdown offers the "Search … in Feed" action plus the matching note.
  await expect(page.getByTestId('omni-submit')).toBeVisible()
  await expect(page.getByTestId('omni-result').filter({ hasText: 'Titanium' })).toBeVisible()

  // Enter activates the default (top) row → the Feed narrows to ?q=metal.
  await omni.press('Enter')
  await expect(page).toHaveURL(/\/s\/main\/feed\?q=metal$/)

  // The window now holds only the match — Titanium in, Carbon out.
  const rows = page.getByTestId('feed-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Titanium')
  // The field reflects the active query and offers a clear.
  await expect(omni).toHaveValue('metal')
})

test('topbar OmniSearch: arrow to a suggestion + Enter jumps to that note', async ({ page }) => {
  await page.goto('/s/main/feed')
  const omni = page.getByTestId('omni-search')
  await omni.click()
  await omni.fill('metal')
  await expect(page.getByTestId('omni-result').filter({ hasText: 'Titanium' })).toBeVisible()
  // ArrowDown steps off the submit row onto the first note; Enter opens it.
  await omni.press('ArrowDown')
  await omni.press('Enter')
  await expect(page).toHaveURL(/\/n\//)
})
