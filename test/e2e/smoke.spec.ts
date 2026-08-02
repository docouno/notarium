import { expect, test, treeNote } from './fixtures'

// Proves the whole E2E harness end-to-end: the production bundle is served, it
// fetches /api/config + /api/notes from the fake backend, and React renders the
// seed data. Every other journey builds on this wiring.

test('app boots and renders seed notes from the fake backend', async ({ page }) => {
  await page.goto('/')
  // The seed fixture's notes surface in the file tree.
  await expect(treeNote(page, 'Titanium')).toBeVisible()
  await expect(treeNote(page, 'Carbon')).toBeVisible()
  // Sync status (#60) rides the SSE status; it's the square button beside the
  // profile (#28). The fake can legitimately be "busy" just after a delta poll
  // with changes, so the boot smoke accepts either healthy post-connect state.
  const sync = page.getByTestId('sync-indicator')
  await expect(sync).toHaveAttribute('data-state', /^(busy|ok)$/)
  await sync.click()
  await expect(page.getByTestId('sync-indicator-popover')).toContainText('Engine')
})
