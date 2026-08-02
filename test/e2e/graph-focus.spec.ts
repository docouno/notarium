import { expect, test } from './fixtures'

// Journey #5 (#25): on the overview a node click pins a persistent focus (camera
// + lit connections), and that focus is an ANCHOR — hovering other nodes does
// not erase it. Clicking the already-focused node is the deliberate second step
// that opens it. Driven by node id through the canvas test-hook.

// __graphTest is the canvas test-hook (see ForceGraphCanvas / fixtures.ts).
// Helpers run their callbacks IN THE BROWSER via page.evaluate.

test('focus is an anchor: hover keeps it, second click opens the note', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('rail-graph').click()
  await page.waitForFunction(
    () => !!window.__graphTest?.nodes().some((n) => n.id === 'fake-demo-titanium'),
  )

  // first click → focus the node
  await page.evaluate(() => window.__graphTest!.click('fake-demo-titanium'))
  await page.waitForFunction(() => window.__graphTest?.focusId() === 'fake-demo-titanium')

  // hovering another node must NOT clear the pinned focus
  await page.evaluate(() => window.__graphTest!.hover('fake-demo-carbon'))
  expect(await page.evaluate(() => window.__graphTest!.focusId())).toBe('fake-demo-titanium')

  // second click on the focused node opens it (in-app nav)
  await page.evaluate(() => window.__graphTest!.click('fake-demo-titanium'))
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
})
