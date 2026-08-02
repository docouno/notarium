import { expect, test } from './fixtures'

// Journey #3, reshaped by #245 (merged Files + Feed): the Feed lost its own rail
// icon — feed / folder page / open note are now three faces of ONE "Files"
// section, so the SINGLE Files icon lights across all of them. Its click opens the
// section's default view, the feed overview, not the last note.
// The collapsed rail still highlights the current scope correctly at every step,
// and lights NOTHING in the file scope on Home or a chrome surface.

test('the single Files icon tracks the merged section and opens the feed overview', async ({
  page,
}) => {
  await page.goto('/')

  // open a note in the expanded tree, then collapse the rail to the icon strip
  await page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]').click()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
  await page.getByTitle('Collapse sidebar').click()

  const files = page.getByTestId('rail-files')
  const graph = page.getByTestId('rail-graph')

  // the Feed icon is gone — the section has one entry now
  await expect(page.getByTestId('rail-feed')).toHaveCount(0)
  // that entry points at the feed overview (the section default), not the note
  await expect(files).toHaveAttribute('href', '/s/main/feed')

  // a note is open → Files is the lit scope (a note is a face of the section)
  await expect(files).toHaveAttribute('aria-current', 'page')

  // Graph: its own scope lights up, Files goes dark
  await graph.click()
  await expect(page).toHaveURL(/\/graph$/)
  await expect(graph).toHaveAttribute('aria-current', 'page')
  await expect(files).not.toHaveAttribute('aria-current', 'page')

  // Home: nothing in the file scope is lit (the reader is cleared, the logo owns
  // home). Home is the active space's root since #16 (/s/<space>).
  await page.getByTestId('rail-home').click()
  await expect(page).toHaveURL(/\/s\/main$/)
  await expect(files).not.toHaveAttribute('aria-current', 'page')

  // Files → the feed overview (the section default), and the icon lights there:
  // the feed is now a face of the Files section, not a separate scope.
  await files.click()
  await expect(page).toHaveURL(/\/feed$/)
  await expect(files).toHaveAttribute('aria-current', 'page')

  // and opening a note again keeps the SAME Files icon lit (one section, one icon)
  await page.getByTitle('Expand sidebar').click()
  await page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]').click()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
  await expect(files).toHaveAttribute('aria-current', 'page')
})
