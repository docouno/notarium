import type { Route } from '@playwright/test'
import { expect, test } from './fixtures'

const deletedAt = '2026-08-10T12:00:00.000Z'
const item = (
  noteId: string,
  title: string,
  restoreAvailability: 'full' | 'partial' | 'opaque' | 'gap',
) => ({
  noteId,
  title,
  filePath: `recovery/${noteId}.md`,
  class: 'user-doc',
  deletedAt,
  deletedBy: null,
  external: false,
  restorable: restoreAvailability !== 'gap',
  restoreAvailability,
  stateFormat:
    restoreAvailability === 'partial'
      ? null
      : restoreAvailability === 'opaque'
        ? 'opaque-v1'
        : restoreAvailability === 'gap'
          ? null
          : 'markdown-v2',
  revisionId: `revision-${noteId}`,
})

const full = item('complete', 'Accidentally deleted meeting notes', 'full')
const partial = item('partial', 'Launch outline from an older Notarium', 'partial')
const source = item('source', 'Imported helper source', 'opaque')
const record = item('record', 'Notes removed before capture', 'gap')

test('keeps the first unavailable recovery rows after loading a distant window', async ({
  page,
}) => {
  const ordinary = Array.from({ length: 121 }, (_, index) =>
    item(`ordinary-${index}`, `Recoverable note ${index}`, 'full'),
  )
  const allItems = [partial, source, record, ...ordinary]
  let loadedSecondPage = false

  await page.route('**/api/s/main/trash**', async (route: Route) => {
    const requestUrl = new URL(route.request().url())
    const offset = Number(requestUrl.searchParams.get('offset') ?? 0)
    const limit = Number(requestUrl.searchParams.get('limit') ?? 100)

    loadedSecondPage ||= offset >= 100
    await route.fulfill({
      json: {
        items: allItems.slice(offset, offset + limit),
        total: allItems.length,
        restorableTotal: ordinary.length + 1,
        partialTotal: 1,
        restoreAvailable: true,
      },
    })
  })

  await page.goto('/s/main/trash?tab=notes')
  await expect(page.getByTestId('trash-recovery-status')).toHaveText([
    'Partial restore',
    'Source only',
    'No copy',
  ])

  const scroll = page.getByTestId('trash-page')
  await scroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect.poll(() => loadedSecondPage).toBe(true)
  await scroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await scroll.evaluate((element) => element.scrollTo({ top: 0 }))

  await expect(page.getByTestId('trash-recovery-status')).toHaveText([
    'Partial restore',
    'Source only',
    'No copy',
  ])
  await expect(page.getByTestId('trash-row').first()).toContainText(
    'Launch outline from an older Notarium',
  )
})

test('opens opaque UTF-8 and binary rows as exact literal source, never Markdown', async ({
  page,
}) => {
  const utf8 = item('opaque-utf8', 'Opaque UTF-8 source', 'opaque')
  const binary = item('opaque-binary', 'Opaque binary source', 'opaque')
  const literal = '---\nname: another-package\n---\n# literal **not bold**\n'
  const details = new Map([
    [utf8.noteId, { encoding: 'utf8', data: literal }],
    [binary.noteId, { encoding: 'base64', data: '/wD+YQ==' }],
  ])

  await page.route('**/api/s/main/trash**', (route) =>
    route.fulfill({
      json: {
        items: [utf8, binary],
        total: 2,
        restorableTotal: 0,
        partialTotal: 0,
        restoreAvailable: true,
      },
    }),
  )
  await page.route(
    (url) => url.pathname === '/api/note' && details.has(url.searchParams.get('id') ?? ''),
    (route) => {
      const id = new URL(route.request().url()).searchParams.get('id')!

      return route.fulfill({
        json: {
          id,
          space: 'main',
          title: id === utf8.noteId ? utf8.title : binary.title,
          filePath: `recovery/${id}.md`,
          class: 'user-doc',
          content: '',
          frontmatter: {},
          versionToken: '',
          deleted: true,
          deletedAt,
          deletedBy: null,
          restorable: true,
          restoreAvailability: 'opaque',
          source: details.get(id),
        },
      })
    },
  )

  await page.goto('/s/main/trash?tab=notes')
  await page
    .getByTestId('trash-row')
    .filter({ hasText: utf8.title })
    .getByTestId('trash-row-open')
    .click()
  await expect(page.getByTestId('deleted-source')).toHaveText(literal)
  await expect(page.getByTestId('deleted-source').locator('strong')).toHaveCount(0)

  await page.goto('/s/main/trash?tab=notes')
  await page
    .getByTestId('trash-row')
    .filter({ hasText: binary.title })
    .getByTestId('trash-row-open')
    .click()
  await expect(page.getByTestId('deleted-source')).toHaveText('base64\n/wD+YQ==')
})

test('mixed recovery explains the selection, restores the available subset, and clears skipped rows', async ({
  page,
}) => {
  let restored = false
  let restoreBody: Record<string, unknown> | null = null

  await page.route('**/api/s/main/trash**', async (route: Route) => {
    const request = route.request()

    if (request.method() === 'POST' && request.url().includes('/restore-many')) {
      restoreBody = request.postDataJSON() as Record<string, unknown>
      restored = true
      await route.fulfill({
        json: {
          status: 'completed',
          operationId: 'bulk-recovery',
          items: [
            {
              id: full.noteId,
              revisionId: full.revisionId,
              status: 'succeeded',
              operationId: `restore-${full.noteId}`,
              restoredRevisionId: `restored-${full.noteId}`,
              filePath: full.filePath,
              versionToken: `token-${full.noteId}`,
            },
            {
              id: partial.noteId,
              revisionId: partial.revisionId,
              status: 'conflict',
              operationId: `restore-${partial.noteId}`,
              reason: 'physical-target-changed',
            },
          ],
          counts: {
            total: 2,
            queued: 0,
            pending: 0,
            succeeded: 1,
            conflict: 1,
            notRestorable: 0,
          },
        },
      })
      return
    }

    const availability = new URL(request.url()).searchParams.get('availability')
    const remaining = restored ? [partial, source, record] : [full, partial, source, record]
    const items =
      availability === 'restorable'
        ? remaining.filter((entry) => ['full', 'partial'].includes(entry.restoreAvailability))
        : availability === 'unavailable'
          ? remaining.filter((entry) => !['full', 'partial'].includes(entry.restoreAvailability))
          : remaining
    const partialTotal = items.filter((entry) => entry.restoreAvailability === 'partial').length
    const restorableTotal = items.filter((entry) =>
      ['full', 'partial'].includes(entry.restoreAvailability),
    ).length

    await route.fulfill({
      json: {
        items,
        total: items.length,
        restorableTotal,
        partialTotal,
        restoreAvailable: true,
      },
    })
  })

  await page.goto('/s/main/trash?tab=notes')
  await expect(page.getByTestId('trash-row')).toHaveCount(4)

  await page.getByTestId('trash-availability-unavailable').click()
  await expect(page).toHaveURL(/availability=unavailable/)
  await expect(page.getByTestId('trash-row')).toHaveCount(2)
  await expect(page.getByTestId('trash-recovery-status')).toHaveText(['Source only', 'No copy'])
  await page.getByTestId('trash-recovery-status').first().click()
  await expect(page.getByRole('dialog')).toContainText('The original source can still be inspected')
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()

  await page.getByTestId('trash-availability-all').click()
  await expect(page.getByTestId('trash-row')).toHaveCount(4)
  await page.getByTestId('trash-select-all').check({ force: true })
  await expect(page.getByTestId('trash-selection-breakdown')).toHaveText(
    '2 can restore · 2 unavailable',
  )
  await expect(page.getByTestId('trash-restore-selected')).toHaveText('Restore 2 available')
  await page.getByTestId('trash-restore-selected').click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('1 selected item is an older partial copy')
  await expect(dialog).toContainText('2 unavailable items will remain in Trash')
  await dialog.getByRole('button', { name: 'Restore 2 available' }).click()

  await expect(page.getByTestId('trash-footer')).toHaveCount(0)
  await expect(page.getByTestId('trash-row')).toHaveCount(3)
  expect(restoreBody).toMatchObject({ ids: ['complete', 'partial'] })
  await expect(page.getByText(/Restored 1 of 2 available items/)).toBeVisible()
  await expect(page.getByText(/Move or rename that note/)).toBeVisible()
  await expect(page.getByText(/2 unavailable items remain in Trash/)).toBeVisible()
})

test('an occupied original path explains the recovery action', async ({ page }) => {
  const collision = item('collision', 'Earlier weekly status', 'full')

  await page.route('**/api/s/main/trash**', async (route: Route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 409,
        json: {
          status: 'conflict',
          error: 'Restore conflict',
          operationId: 'restore-collision',
          reason: 'physical-target-changed',
        },
      })
      return
    }

    await route.fulfill({
      json: {
        items: [collision],
        total: 1,
        restorableTotal: 1,
        partialTotal: 0,
        restoreAvailable: true,
      },
    })
  })

  await page.goto('/s/main/trash?tab=notes')
  await page.getByTestId('trash-restore').click()

  await expect(page.getByText('The original path is occupied by another note.')).toBeVisible()
  await expect(page.getByText(/Move or rename that note, then try restoring again/)).toBeVisible()
})
