import { expect, test } from './fixtures'

// Journey #4 (#29): sidebar nav items are real <a href>. A plain click is
// hijacked for in-app SPA navigation; middle-click falls through to the browser
// so it opens a new tab. Ctrl/Cmd-click is deliberately owned by tree
// multi-select (#163); search/recent links keep regular modified-click browser
// behavior.

test('tree note is a real anchor: plain click = SPA nav, middle-click = new tab', async ({
  page,
  context,
}) => {
  await page.goto('/')

  const titanium = page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]')
  await expect(titanium).toHaveAttribute('href', '/n/fake-demo-titanium')

  // middle-click → the browser opens a NEW tab at the href; the app does not
  // intercept, and the current page stays put.
  const popupPromise = context.waitForEvent('page')
  await titanium.click({ button: 'middle' })
  const popup = await popupPromise
  await popup.waitForURL(/\/n\/fake-demo-titanium\/titanium$/)
  await popup.close()
  // the current page never moved off the space home (#16: '/' → /s/main)
  expect(new URL(page.url()).pathname).toBe('/s/main')

  // plain click → in-app navigation, no new tab, the note becomes current.
  await titanium.click()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
  await expect(titanium).toHaveAttribute('aria-current', 'page')
})

test('Files / Graph scopes are real anchors and navigate in-app', async ({ page, context }) => {
  await page.goto('/')

  // Since #245 the Feed has no own rail icon: the merged Files entry opens the
  // feed overview (its default view), so rail-files points at /feed.
  await expect(page.getByTestId('rail-feed')).toHaveCount(0)
  await expect(page.getByTestId('rail-files')).toHaveAttribute('href', '/s/main/feed')
  await expect(page.getByTestId('rail-graph')).toHaveAttribute('href', '/s/main/graph')

  // Middle-click the merged Files icon → the browser opens a NEW tab at /feed (it's a
  // real <Link>, not a button-with-onClick), and the current page stays put.
  const popupPromise = context.waitForEvent('page')
  await page.getByTestId('rail-files').click({ button: 'middle' })
  const popup = await popupPromise
  await popup.waitForURL(/\/s\/main\/feed$/)
  await popup.close()
  expect(new URL(page.url()).pathname).toBe('/s/main')

  await page.getByTestId('rail-files').click()
  await expect(page).toHaveURL(/\/feed$/)
  await expect(page.getByTestId('rail-files')).toHaveAttribute('aria-current', 'page')

  await page.getByTestId('rail-graph').click()
  await expect(page).toHaveURL(/\/graph$/)
  await expect(page.getByTestId('rail-graph')).toHaveAttribute('aria-current', 'page')
})
