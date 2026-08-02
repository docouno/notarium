import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'

// #35 — the right aside is a stack of tabbed, resizable panel groups. This spec
// covers the panels' DATA and the GROUP model against the fake backend's
// Titanium note, whose body links to [[Carbon]] (resolves) and [[Missing Element]]
// (a ghost): outgoing Links in body order with ghost = click-to-create, incoming
// Backlinks, read-only Meta, and the split/persist group mechanics.

// The layout persists in localStorage; the fake's reset only re-seeds the backend,
// not the browser — so clear it before each test for a deterministic default
// layout. SPA navigation (Settings ↔ note) keeps it, which the restore case uses.
const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.clear()
      } catch {
        /* sandboxed */
      }
    })
    await use(page)
  },
})

const openTitanium = async (page: Page) => {
  await page.goto('/')
  await page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]').click()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  const opener = page.getByRole('button', { name: 'Open panel' })

  if (await opener.isVisible()) {
    await opener.click()
  }
  await expect(page.getByTestId('aside-groups')).toBeVisible()
}

test("Links shows the note's own outgoing wikilinks in body order; ghosts are flagged (#35)", async ({
  page,
}) => {
  await openTitanium(page)

  // The lower group defaults to the Links tab. Honest outgoing edges come from the
  // read-model body parse (#60), so the list is exactly the body's two links, in
  // body order — [[Carbon]] then [[Missing Element]].
  const links = page.getByTestId('links-list')
  await expect(links.locator('> li')).toHaveCount(2)
  await expect(links.locator('> li').nth(0)).toContainText('Carbon')
  await expect(links.locator('> li').nth(1)).toContainText('Missing Element')
  // Missing Element is unwritten → a ghost row.
  await expect(links.locator('[data-ghost]')).toContainText('Missing Element')
  await expect(links.locator('[data-ghost]')).toHaveCount(1)

  // Backlinks is the other direction: Carbon links back to Titanium.
  await page.getByTestId('aside-tab-backlinks').click()
  const back = page.getByTestId('backlinks-list')
  await expect(back.locator('> li')).toHaveCount(1)
  await expect(back).toContainText('Carbon')
})

test('clicking a ghost link creates the note from it (create-from-ghost, #25/#35)', async ({
  page,
}) => {
  await openTitanium(page)
  await page.getByTestId('links-list').locator('[data-ghost]').click()
  // The create-from-ghost flow opens a prefilled draft; the title (de-kebabbed) is
  // the document's leading `# H1` (#156), not a separate field.
  await expect(page.locator('.cm-content')).toContainText('# Missing Element')
})

test('Meta shows read-only metadata: folder, tags, class (#35)', async ({ page }) => {
  await openTitanium(page)
  await page.getByTestId('aside-tab-meta').click()
  const meta = page.getByTestId('meta-panel')
  await expect(meta).toBeVisible()
  await expect(meta).toContainText('demo') // folder from filePath demo/Titanium.md
  await expect(meta).toContainText('metal')
  await expect(meta).toContainText('element')
})

test('edit Meta uses neutral removable tag chips, not accent filter chips (#204)', async ({
  page,
}) => {
  await openTitanium(page)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()

  const metalRemove = page.getByRole('button', { name: 'Remove metal' })
  await expect(metalRemove).toBeVisible()
  const metalChip = metalRemove.locator('xpath=ancestor::span[contains(@class, "tag-chip")][1]')
  await expect(metalChip).toHaveClass(/tag-chip/)
  await expect(metalChip).toHaveClass(/removable-tag-chip/)
  await expect(metalChip).not.toHaveAttribute('href', /./)

  await metalRemove.click()
  await expect(page.getByRole('button', { name: 'Remove metal' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove element' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
})

test('the inspector is two fixed groups with no add/remove UI; the active tab persists (#35)', async ({
  page,
}) => {
  await openTitanium(page)

  // Fixed read layout: graph on top, the rest tabbed below — two groups, always.
  // No add/remove-group controls (composition is fixed; tab DnD is #36).
  await expect(page.getByTestId('aside-group')).toHaveCount(2)
  await expect(page.getByTestId('aside-split')).toHaveCount(0)
  await expect(page.getByTestId('aside-close-group')).toHaveCount(0)

  // Switch the lower group to Meta; the active tab persists across a no-aside
  // round-trip (leave to Settings, come back — rebuilt from localStorage).
  await page.getByTestId('aside-tab-meta').click()
  await expect(page.getByTestId('meta-panel')).toBeVisible()
  await page.getByTestId('rail-settings').click() // dedicated 1-click gear (#112)
  await expect(page).toHaveURL(/\/settings/)
  await page.goBack()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
  await expect(page.getByTestId('aside-group')).toHaveCount(2)
  await expect(page.getByTestId('meta-panel')).toBeVisible()
})

test('the corner grip resizes width and the group height in one gesture (#35)', async ({
  page,
}) => {
  await openTitanium(page)

  const aside = page.getByTestId('aside-groups')
  const topGroup = page.getByTestId('aside-group').first()
  const before = { aside: await aside.boundingBox(), group: await topGroup.boundingBox() }

  // Drag the corner grip of the top (graph) group left + down: the left-docked
  // aside widens when dragged left, and the group grows taller — both in one drag.
  const grip = page.getByTestId('aside-corner').first()
  const box = (await grip.boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx - 80, cy + 60, { steps: 8 })
  await page.mouse.up()

  const after = { aside: await aside.boundingBox(), group: await topGroup.boundingBox() }
  expect(after.aside!.width).toBeGreaterThan(before.aside!.width + 40)
  expect(after.group!.height).toBeGreaterThan(before.group!.height + 30)
})

test('the panel toggle collapses and reopens the inspector to its layout (#35)', async ({
  page,
}) => {
  await openTitanium(page)
  await page.getByRole('button', { name: 'Collapse panel' }).click()
  await expect(page.getByTestId('aside-groups')).toBeHidden()
  await page.getByRole('button', { name: 'Open panel' }).click()
  await expect(page.getByTestId('aside-groups')).toBeVisible()
})

export { expect }
