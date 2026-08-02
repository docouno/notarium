import { expect, test } from './fixtures'

// #94 — the rail's active-note highlight leaked onto chrome-only pages. Opening
// a note, then going to Settings, left the note's row highlighted in the tree:
// the route RETAINS activeId (so "Files" can return to it), but the rail's
// highlight must be gated on actually being on a doc surface. Graph already did
// this; Settings/Management were missed.

test('the tree note highlight clears on Settings and returns on the note (#94)', async ({
  page,
}) => {
  await page.goto('/')

  const noteRow = page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]')
  await noteRow.click()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
  // The open note's anchor carries aria-current="page" (the stable highlight
  // signal — the .active class is presentational).
  await expect(noteRow).toHaveAttribute('aria-current', 'page')

  // Go to Settings via the dedicated 1-click gear in the rail footer (#112).
  await page.getByTestId('rail-settings').click()
  await expect(page).toHaveURL(/\/settings/)

  // On Settings the reader shows no note → nothing in the tree is highlighted.
  await expect(page.locator('[data-testid="tree-note"][aria-current="page"]')).toHaveCount(0)

  // Back on the note, the highlight returns (activeId was retained, just not lit
  // while on the chrome page).
  await page.goBack()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
  await expect(noteRow).toHaveAttribute('aria-current', 'page')
})
