import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Journey #7 (#25): the graph filters compose with AND — a node survives only if
// it passes every active facet — while ghost (unresolved) nodes are ALWAYS shown,
// short-circuiting the predicates. We assert the surviving node set through the
// canvas test-hook (it reflects the filtered graph, no pixels needed).
//
// Fixture: Titanium↔Carbon are connected; Titanium also has a dead link
// ([[Missing Element]] → ghost); My Note / Welcome / Old Archive are isolated.
// So Connections=Connected AND Dead=With leaves exactly Titanium (+ the ghost).

const realIds = (page: Page) =>
  page.evaluate(() =>
    window
      .__graphTest!.nodes()
      .filter((n) => !n.ghost)
      .map((n) => n.id)
      .sort(),
  )
const hasGhost = (page: Page) =>
  page.evaluate(() => window.__graphTest!.nodes().some((n) => n.id === 'ghost:missing-element'))

test('filters AND-compose; ghosts are always shown', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('rail-graph').click()
  await page.waitForFunction(
    () => !!window.__graphTest?.nodes().some((n) => n.id === 'fake-demo-carbon'),
  )

  // unfiltered: both connected notes and the ghost are present
  expect(await realIds(page)).toContain('fake-demo-carbon')
  expect(await hasGhost(page)).toBe(true)

  // open the Filters panel
  await page.getByTitle('Open panel').click()
  await page.getByRole('tab', { name: 'Filters' }).click()

  // facet 1: Connections = Connected (degree > 0) → drops the 3 isolated notes
  await page.getByRole('button', { name: 'Connected', exact: true }).click()
  await page.waitForFunction(() => {
    const ids = window.__graphTest!.nodes().map((n) => n.id)
    return !ids.includes('fake-root') && ids.includes('fake-demo-carbon')
  })

  // facet 2 (AND): Dead links = With (has an unresolved outgoing link) → of the
  // connected pair only Titanium qualifies; Carbon drops out.
  await page.getByRole('button', { name: 'With', exact: true }).click()
  await page.waitForFunction(
    () => !window.__graphTest!.nodes().some((n) => n.id === 'fake-demo-carbon'),
  )

  // exactly Titanium survives the AND — and the ghost is still shown regardless
  expect(await realIds(page)).toEqual(['fake-demo-titanium'])
  expect(await hasGhost(page)).toBe(true)
})
