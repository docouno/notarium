import { expect, test } from './fixtures'

// Journey #8 (#4/#5): a single Save gate (dirty via snapshot, not a one-way
// latch) and an unsaved-changes guard on navigation. Editing then reverting must
// clear "dirty"; navigating away while dirty must prompt before discarding.

test('Save gate is snapshot-based and navigation guards unsaved edits', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]').click()
  await page.getByRole('button', { name: 'Edit' }).click()

  const editor = page.locator('.cm-content')
  // #156: the title is the document's leading `# H1`, reconstructed into the body.
  await expect(editor).toContainText('# Titanium')
  // nothing diverges from the snapshot yet → Save inert
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()

  // a real edit (type into the document) enables Save
  await editor.click()
  await page.keyboard.type('X')
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()

  // navigating away while dirty prompts; Cancel keeps us in the editor
  await page.getByTestId('rail-files').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Discard unsaved changes?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page).not.toHaveURL(/\/feed$/)
  await expect(editor).toBeVisible()

  // reverting the edit (undo) restores the snapshot body → Save inert again
  await editor.click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()

  // now navigation is unguarded — no dialog, it just goes
  await page.getByTestId('rail-files').click()
  await expect(page).toHaveURL(/\/feed$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Discard confirms and leaves the editor', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]').click()
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.type('X') // a real edit makes the draft dirty (#156: no title field)

  await page.getByTestId('rail-graph').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click()
  await expect(page).toHaveURL(/\/graph$/)
})
