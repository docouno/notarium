import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Journey (#12): note history, VSCode-style panel pair. The aside's History
// tab holds the timeline (including the pre-edit baseline the first edit
// captured) with "+N −M" char counters per revision; picking a revision swaps
// the main column to the revision view with a word-level diff and a banner;
// restore rolls the note back through the CAS path and lands in the history
// as a 'restore' revision; the ways back to the current version are the
// banner button, Escape, deselecting and leaving the tab.

const NOTE = 'fake-demo-carbon'

const openCarbon = async (page: Page) => {
  await page.goto('/')
  await page.locator(`[data-testid="tree-note"][data-id="${NOTE}"]`).click()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
}

const editBody = async (page: Page, text: string) => {
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const body = page.locator('.cm-content')
  await body.click()
  await body.fill(text)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
}

const openHistoryTab = async (page: Page) => {
  // The aside starts collapsed; open it, then activate the History tab (#35: one
  // tab among the inspector's panels, wherever the saved layout places it).
  const opener = page.getByRole('button', { name: 'Open panel' })

  if (await opener.isVisible()) {
    await opener.click()
  }
  await page.getByRole('tab', { name: 'History' }).click()
  await expect(page.getByTestId('note-history')).toBeVisible()
}

test('two edits build a timeline with char counters; picking a revision shows its diff', async ({
  page,
}) => {
  await openCarbon(page)
  await editBody(page, 'First body.')
  await editBody(page, 'Second edited body with more detail.')
  await openHistoryTab(page)

  // Newest first: write, write, and the baseline the first edit captured.
  const items = page.getByTestId('history-item')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toContainText('Edited')
  await expect(items.nth(2)).toContainText('External change')
  await expect(page.getByTestId('note-history')).toContainText('3 revisions')

  // Char counters: same-length replacement shows a neutral total; the word diff
  // below still proves both sides of the edit.
  await expect(items.nth(0)).toContainText('±0')
  await expect(items.nth(2)).toContainText('+')

  // The reader stays until a revision is picked.
  await expect(page.getByTestId('revision-view')).toBeHidden()
  await items.nth(1).click()
  await expect(page.getByTestId('revision-banner')).toContainText('Back to note')

  // While viewing a revision the document actions step back.
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeHidden()

  // The middle revision's diff: against its chain parent.
  const diff = page.getByTestId('history-diff')
  await expect(diff.locator('del')).toContainText('The basis of organic chemistry')

  // The baseline holds the fixture's original body.
  await items.nth(2).click()
  await expect(diff).toContainText('The basis of organic chemistry')

  // Clicking the selected row again deselects — back to the reader.
  await items.nth(2).click()
  await expect(page.getByTestId('revision-view')).toBeHidden()
  await expect(page.getByRole('article')).toBeVisible()
})

test('restore rolls the note back, journals the rollback, and the reader shows the old body', async ({
  page,
}) => {
  await openCarbon(page)
  const original = await page.locator('.markdown').innerText()
  await editBody(page, 'Edited away from the original.')
  await openHistoryTab(page)

  // Pick the baseline (the pre-edit state) and restore it.
  await page.getByTestId('history-item').nth(1).click()
  await page.getByTestId('history-restore').click()
  await page.getByRole('button', { name: 'Restore', exact: true }).click()

  // Restore closes the revision view: the reader is back on the original body.
  await expect(page.getByTestId('revision-view')).toBeHidden()
  await expect(page.locator('.markdown')).toContainText(original.split('\n')[0])
  await expect(page.locator('.markdown')).not.toContainText('Edited away')

  // The rollback is itself a revision at the top of the timeline, naming where
  // it was rolled back from…
  await expect(page.getByTestId('history-item').nth(0)).toContainText('Restored from v')
  await expect(page.getByTestId('history-item')).toHaveCount(3)

  // …and the latest revision is the current state — no restore offered, just a
  // marker saying so.
  await page.getByTestId('history-item').nth(0).click()
  await expect(page.getByTestId('history-restore')).toHaveCount(0)
  await expect(page.getByTestId('history-current')).toBeVisible()
})

test('ways back to the current version: banner and Escape; switching tabs keeps the revision (#35)', async ({
  page,
}) => {
  await openCarbon(page)
  await editBody(page, 'An edit to give the timeline something.')
  await openHistoryTab(page)
  const items = page.getByTestId('history-item')

  // Banner button.
  await items.nth(0).click()
  await page.getByTestId('history-back').click()
  await expect(page.getByTestId('revision-view')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()

  // Escape.
  await items.nth(0).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('revision-view')).toBeHidden()

  // Switching the aside tab away now only hides the timeline — the open revision
  // stays in the main column. History is one tab of a group (#35), possibly shown
  // beside others, so the revision view is no longer bound to which tab is active;
  // Escape / banner / deselect close it.
  await items.nth(0).click()
  await page.getByTestId('aside-tab-meta').click()
  await expect(page.getByTestId('note-history')).toBeHidden()
  await expect(page.getByTestId('revision-view')).toBeVisible()
})

test('a note never edited has no history yet — and says so once', async ({ page }) => {
  await openCarbon(page)
  await openHistoryTab(page)
  await expect(page.getByTestId('note-history')).toContainText('No history yet')
  // The placard alone carries the empty state — no redundant "0 revisions"
  // count line over it (#35 empty-state polish).
  await expect(page.getByTestId('note-history')).not.toContainText('revision')
})
