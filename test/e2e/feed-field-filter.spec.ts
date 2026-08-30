import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

const items = (page: Page) => page.locator('[data-testid="feed-item"]')
const folderFacet = '[data-testid="feed-folder-filter"]'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const setFields = async (
  page: Page,
  baseURL: string,
  filePath: string,
  fields: Record<string, string>,
) => {
  const listed = await page.request.get(`${baseURL}/api/s/main/notes?sort=modified`)
  const notes = (await listed.json()) as { notes: Array<{ id: string; filePath: string }> }
  const note = notes.notes.find((candidate) => candidate.filePath === filePath)

  expect(note).toBeDefined()
  const detail = await page.request.get(`${baseURL}/api/note?id=${note!.id}`)
  const current = (await detail.json()) as { versionToken: string }
  const updated = await page.request.put(`${baseURL}/api/note/fields`, {
    data: { id: note!.id, versionToken: current.versionToken, fields },
  })

  expect(updated.ok()).toBeTruthy()
}

test('the field facet filters the window and clears from URL state', async ({ page, baseURL }) => {
  const schema = await page.request.get(`${baseURL}/api/s/main/fields/schema`)
  const current = (await schema.json()) as { versionToken: string }
  const declared = await page.request.put(`${baseURL}/api/s/main/fields/schema`, {
    data: {
      version: 1,
      versionToken: current.versionToken,
      fields: [
        {
          key: 'status',
          type: 'enum',
          label: 'Status',
          values: [
            { key: 'backlog', label: 'Backlog', color: 'slate' },
            { key: 'wip', label: 'In progress', color: 'amber' },
            { key: 'done', label: 'Done', color: 'green' },
            { key: 'blocked', label: 'Blocked', color: 'red' },
          ],
        },
        { key: 'owner', type: 'text', label: 'Owner' },
        { key: 'estimate', type: 'text', label: 'Estimate' },
        { key: 'due', type: 'date', label: 'Due' },
      ],
    },
  })
  expect(declared.ok()).toBeTruthy()
  await setFields(page, baseURL!, 'demo/Carbon.md', {
    status: 'wip',
    owner: 'sergey',
    estimate: '>3',
    due: '2026-09-01',
  })
  await setFields(page, baseURL!, 'demo/Titanium.md', {
    status: 'done',
    owner: 'other',
    due: '2026-09-01T10:00:00Z',
  })

  await page.goto('/')
  await page.getByTestId('rail-files').click()
  await page.getByRole('button', { name: 'Modified' }).click()
  await expect(items(page)).toHaveCount(5)
  await page.getByTitle('Open panel').click()

  const fieldFilter = page.getByTestId('feed-field-filter')
  await expect(fieldFilter).toContainText('Status')
  await expect(fieldFilter).toContainText('Owner')
  await expect(fieldFilter).toContainText('Estimate')
  await expect(fieldFilter).toContainText('Due')
  await expect(fieldFilter).not.toContainText('Fields')
  const wip = fieldFilter.getByRole('button', { name: 'Status: In progress, 1 note' })
  const owner = fieldFilter.getByRole('button', { name: 'Owner: sergey, 1 note' })
  const due = fieldFilter.getByRole('button', { name: 'Due: Sep 1, 2026, 2 notes' })
  const tag = page.locator('[data-testid="feed-tag-filter"] button[title="element"]')
  const geometry = async (button: typeof wip) =>
    button.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        padding: style.padding,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        borderRadius: style.borderRadius,
      }
    })

  expect(await geometry(wip)).toEqual(await geometry(tag))
  expect(await geometry(wip)).toMatchObject({ fontSize: '11.5px', lineHeight: '11.5px' })
  await expect(tag).toContainText('#')
  await expect(wip).not.toContainText('#')
  await expect(wip.locator(':scope > span')).toHaveCount(2)
  await expect(wip.locator('xpath=..')).toHaveAttribute(
    'style',
    /--facet-solid: var\(--field-color-amber\)/,
  )
  const [facetLabelColor, facetCountColor] = await wip
    .locator(':scope > span')
    .evaluateAll((parts) => parts.map((part) => getComputedStyle(part).color))
  expect(facetCountColor).toBe(facetLabelColor)
  await expect(due).toHaveAttribute('title', 'Due: Sep 1, 2026')
  await due.click()
  await expect(page).toHaveURL(/fieldDay=note.due%3A2026-09-01/)
  await expect(page).not.toHaveURL(/[?&]field=note.due/)
  await expect(items(page)).toHaveCount(2)
  await due.click()
  await expect(items(page)).toHaveCount(5)

  // The facet is corpus-wide even while the window is folder-filtered. A write
  // outside `demo` must refresh its counts without needlessly refreshing the window.
  await page.locator(`${folderFacet} button[title="demo"]`).click()
  await expect(items(page)).toHaveCount(3)
  await setFields(page, baseURL!, 'root.md', { status: 'backlog' })
  await expect(fieldFilter.locator('button[title="Status: Backlog"]')).toHaveAttribute(
    'aria-label',
    'Status: Backlog, 1 note',
  )
  await expect(items(page)).toHaveCount(3)
  await page.getByTestId('feed-folder-filter-reset').click()
  await expect(items(page)).toHaveCount(5)

  await owner.click()
  await wip.click()

  await expect(page).toHaveURL(/field=note.owner%3Asergey/)
  await expect(page).toHaveURL(/field=note.status%3Awip/)
  await expect(items(page)).toHaveCount(1)
  await expect(items(page).first()).toContainText('Carbon')
  await expect(wip).toHaveAttribute('aria-pressed', 'true')

  await tag.click()
  const selectedBackground = async (button: typeof wip) =>
    button.locator('xpath=..').evaluate((element) => getComputedStyle(element).backgroundColor)

  expect(await selectedBackground(wip)).not.toBe(await selectedBackground(tag))
  await tag.click()

  await page.getByTestId('feed-field-filter-status-reset').click()
  await expect(page).not.toHaveURL(/field=note.status%3Awip/)
  await expect(page).toHaveURL(/field=note.owner%3Asergey/)
  await expect(items(page)).toHaveCount(1)

  await page.getByTestId('feed-field-filter-owner-reset').click()
  await expect(page).not.toHaveURL(/[?&]field=/)
  await expect(items(page)).toHaveCount(5)

  // A comparison-shaped authored string is still exact equality, not an operator.
  await fieldFilter.getByRole('button', { name: 'Estimate: >3, 1 note' }).click()
  await expect(items(page)).toHaveCount(1)
  await expect(items(page).first()).toContainText('Carbon')
  await page.getByTestId('feed-field-filter-estimate-reset').click()
  await expect(items(page)).toHaveCount(5)

  // A field-only dead end remains identifiable and escapable with the panel closed.
  await fieldFilter.getByRole('button', { name: 'Status: Blocked, 0 notes' }).click()
  await expect(items(page)).toHaveCount(0)
  await page.getByTitle('Collapse panel').click()
  await expect(page.getByTestId('feed-empty-clear')).toBeVisible()
  await page.getByTestId('feed-empty-clear').click()
  await expect(page).not.toHaveURL(/[?&]field=/)
  await expect(items(page)).toHaveCount(5)
})

test('the field facet ignores a response superseded by a corpus change', async ({
  page,
  baseURL,
}) => {
  const releaseFirst = deferred()
  const firstCaptured = deferred()
  const firstApplied = deferred()
  const secondApplied = deferred()
  let calls = 0

  await page.route('**/api/s/main/fields?*', async (route) => {
    const call = ++calls
    const response = await route.fetch()
    const body = await response.body()

    if (call === 1) {
      firstCaptured.resolve()
      await releaseFirst.promise
    }
    await route.fulfill({ response, body })
    if (call === 1) {
      firstApplied.resolve()
    }
    if (call === 2) {
      secondApplied.resolve()
    }
  })

  try {
    await page.goto('/')
    await page.getByTestId('rail-files').click()
    await page.getByRole('button', { name: 'Modified' }).click()
    await expect(items(page)).toHaveCount(5)
    await firstCaptured.promise

    await setFields(page, baseURL!, 'demo/Carbon.md', { status: 'wip' })
    await secondApplied.promise
    await page.getByTitle('Open panel').click()
    const fieldFilter = page.getByTestId('feed-field-filter')

    await expect(fieldFilter.getByRole('button', { name: 'wip, 1 note' })).toBeVisible()
    releaseFirst.resolve()
    await firstApplied.promise
    await expect(fieldFilter.getByRole('button', { name: 'wip, 1 note' })).toBeVisible()
  } finally {
    releaseFirst.resolve()
  }
})

test('a fully truncated field facet stays honest without promising a search UI', async ({
  page,
}) => {
  await page.route('**/api/s/main/fields?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fields: [], total: 0, truncated: true }),
    }),
  )
  await page.goto('/')
  await page.getByTestId('rail-files').click()
  await page.getByTitle('Open panel').click()

  const fieldFilter = page.getByTestId('feed-field-filter')

  await expect(fieldFilter).toContainText('More open fields are available')
  await expect(fieldFilter).not.toContainText('search')
})
