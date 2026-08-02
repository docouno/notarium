import { expect, test } from './fixtures'

// Journey #1 (#25): clicking a ghost (unresolved [[link]] target) in the graph
// opens a prefilled "new note" — title de-kebabbed to slug-match the target,
// body carrying a [[backlink]] to each source — and saving it resolves the link
// from both sides (the ghost disappears, a real node takes its place).
//
// The graph is a <canvas>, so we drive it through the test-only window.__graphTest
// handle (real click/hover handlers, by node id — no pixel guessing). The shared
// fixture arms it before the app loads.

test('ghost → create prefills the note and resolves the link both ways', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('rail-graph').click()

  // wait until the graph is mounted and the ghost is present
  await page.waitForFunction(
    () => !!window.__graphTest?.nodes().some((n) => n.id === 'ghost:missing-element'),
  )

  // click the ghost by id → the create-from-ghost flow opens a prefilled draft
  await page.evaluate(() => window.__graphTest!.click('ghost:missing-element'))

  // The title (de-kebabbed from the target slug) is the document's leading `# H1`
  // (#156) — there is no separate title field.
  await expect(page.locator('.cm-content')).toContainText('# Missing Element')
  // a new note is saveable immediately (prefilled, not "dirty")
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()

  await page.getByRole('button', { name: 'Save' }).click()

  // back to the graph: the ghost is gone, replaced by a real note, and Titanium's
  // [[Missing Element]] now resolves to it (slug match).
  await page.getByTestId('rail-graph').click()
  await page.waitForFunction(
    () => !!window.__graphTest?.nodes().some((n) => n.id === 'fake-demo-missing-element'),
  )
  const stillGhost = await page.evaluate(() =>
    window.__graphTest!.nodes().some((n) => n.id === 'ghost:missing-element'),
  )
  expect(stillGhost).toBe(false)
})
