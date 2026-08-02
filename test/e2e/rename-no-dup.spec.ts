import { expect, test } from './fixtures'

// Journey #2 (#8/#15/#6): renaming a note via the inline editor relocates the
// SAME file (move-then-write under originalId) — it must NOT leave the old note
// behind as a duplicate, and since #51 the note keeps its identity: the same
// data-id (note-id) now carries the new title. Enter commits, Escape cancels.

test('inline rename relocates in place, keeping the id and leaving no duplicate', async ({
  page,
}) => {
  await page.goto('/')
  const rows = page.locator('[data-testid="tree-note"]')
  await expect(rows).toHaveCount(4)
  const carbon = page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')
  await expect(carbon).toBeVisible()

  // right-click → Rename → type a new name → Enter
  await carbon.click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Rename' }).click()
  const input = page.getByTestId('rename-input')
  await input.fill('Carbonium')
  await input.press('Enter')

  // the SAME identity now shows the new title (P7: rename ≠ a new note),
  // nothing was duplicated, count holds
  await expect(carbon).toHaveCount(1)
  await expect(carbon).toContainText('Carbonium')
  await expect(page.locator('[data-testid="tree-note"]', { hasText: 'Carbonium' })).toHaveCount(1)
  await expect(rows).toHaveCount(4)
})

test('Escape cancels the rename', async ({ page }) => {
  await page.goto('/')
  await page
    .locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]')
    .click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Rename' }).click()
  await page.getByTestId('rename-input').press('Escape')

  await expect(
    page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]'),
  ).toBeVisible()
  await expect(page.getByTestId('rename-input')).toHaveCount(0)
})
