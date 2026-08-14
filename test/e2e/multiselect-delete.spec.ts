import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

// #206 — the tree context menu must use the same effective set semantics as the
// #163 drag payload: right-click a selected row -> act on the whole selection;
// right-click an unselected row -> one-row target.

const FIXTURE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        { title: 'a1', filePath: 'f1/a1.md', content: '# a1', tags: [] },
        { title: 'a2', filePath: 'f1/a2.md', content: '# a2', tags: [] },
        { title: 'b1', filePath: 'f2/b1.md', content: '# b1', tags: [] },
        { title: 'c1', filePath: 'f3/c1.md', content: '# c1', tags: [] },
        { title: 'keep', filePath: 'archive/keep.md', content: '# keep', tags: [] },
      ].map((n) => ({
        ...n,
        modifiedAt: '2026-06-08T00:00:00.000Z',
        createdAt: '2026-06-01T09:00:00.000Z',
      })),
    },
  ],
}

const NESTED_FIXTURE = {
  ...FIXTURE,
  spaces: FIXTURE.spaces.map((space) => ({
    ...space,
    notes: [
      ...space.notes,
      {
        title: 'deep',
        filePath: 'f1/nested/deep.md',
        content: '# deep',
        tags: [],
        modifiedAt: '2026-06-08T00:00:00.000Z',
        createdAt: '2026-06-01T09:00:00.000Z',
      },
    ],
  })),
}

const noteSel = (id: string) => `[data-testid="tree-note"][data-id="${id}"]`
const folderSel = (path: string) => `[data-testid="tree-folder"][data-path="${path}"]`
const folderBtnSel = (path: string) => `${folderSel(path)} button:not([aria-label="Toggle folder"])`

const idOf = (page: Page, title: string) =>
  page.locator(`[data-testid="tree-note"]`, { hasText: title }).first().getAttribute('data-id')

const modClick = async (
  page: Page,
  selector: string,
  mods: { ctrl?: boolean; shift?: boolean } = {},
) => {
  await page.evaluate(
    ({ selector: clickSelector, mods: clickMods }) => {
      const el = document.querySelector(clickSelector) as HTMLElement

      if (!el) {
        throw new Error(`no element for ${clickSelector}`)
      }
      el.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ctrlKey: !!clickMods.ctrl,
          metaKey: !!clickMods.ctrl,
          shiftKey: !!clickMods.shift,
        }),
      )
    },
    { selector, mods },
  )
}

const reset = async (page: Page, baseURL: string | undefined, fixture = FIXTURE) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture } })
  await page.goto('/s/main')
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(
    FIXTURE.spaces[0].notes.length,
  )
}

test('right-clicking a selected row deletes the whole selected note set (#206)', async ({
  page,
  baseURL,
}) => {
  await reset(page, baseURL)
  const a1 = await idOf(page, 'a1')
  const b1 = await idOf(page, 'b1')
  expect(a1).toBeTruthy()
  expect(b1).toBeTruthy()

  await modClick(page, noteSel(a1!), { ctrl: true })
  await modClick(page, noteSel(b1!), { ctrl: true })
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(2)

  await page.locator(noteSel(a1!)).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete 2 items' }).click()
  await page.getByRole('button', { name: 'Delete 2 items' }).click()

  await expect(page.locator(noteSel(a1!))).toHaveCount(0)
  await expect(page.locator(noteSel(b1!))).toHaveCount(0)
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(3)
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(0)
})

test('right-clicking an unselected row uses a single target and clears the old set (#206)', async ({
  page,
  baseURL,
}) => {
  await reset(page, baseURL)
  const a1 = await idOf(page, 'a1')
  const b1 = await idOf(page, 'b1')
  expect(a1).toBeTruthy()
  expect(b1).toBeTruthy()

  await modClick(page, noteSel(a1!), { ctrl: true })
  await modClick(page, noteSel(b1!), { ctrl: true })
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(2)

  await page.locator(folderSel('f3')).click({ button: 'right' })
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Delete 2 items' })).toHaveCount(0)
})

test('folder plus descendant rows delete only the outer folder on the server (#206)', async ({
  page,
  baseURL,
}) => {
  await reset(page, baseURL, NESTED_FIXTURE)
  const a1 = await idOf(page, 'a1')
  expect(a1).toBeTruthy()

  const f1 = page.locator(folderSel('f1'))

  if ((await f1.getAttribute('aria-expanded')) !== 'true') {
    await page.locator(`${folderSel('f1')} button[aria-label="Toggle folder"]`).click()
  }
  await expect(page.locator(folderSel('f1/nested'))).toBeVisible()

  let descendantNoteDeletes = 0
  let outerFolderDeletes = 0
  let descendantFolderDeletes = 0
  await page.route('**/api/note?id=*', async (route) => {
    const url = new URL(route.request().url())

    if (route.request().method() === 'DELETE' && url.searchParams.get('id') === a1) {
      descendantNoteDeletes += 1
    }
    await route.continue()
  })
  await page.route('**/api/s/*/folders?*', async (route) => {
    const url = new URL(route.request().url())

    if (route.request().method() === 'DELETE') {
      const path = url.searchParams.get('path')

      if (path === 'f1') {
        outerFolderDeletes += 1
      }
      if (path === 'f1/nested') {
        descendantFolderDeletes += 1
      }
    }
    await route.continue()
  })

  await modClick(page, folderBtnSel('f1'), { ctrl: true })
  await modClick(page, noteSel(a1!), { ctrl: true })
  await modClick(page, folderBtnSel('f1/nested'), { ctrl: true })
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(3)

  await page.locator(folderBtnSel('f1')).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete 3 items' }).click()
  await page.getByRole('button', { name: 'Delete 3 items' }).click()

  await expect(page.locator(folderSel('f1'))).toHaveCount(0)
  await expect(page.locator(folderSel('f1/nested'))).toHaveCount(0)
  await expect(page.locator(noteSel(a1!))).toHaveCount(0)
  expect(outerFolderDeletes).toBe(1)
  expect(descendantNoteDeletes).toBe(0)
  expect(descendantFolderDeletes).toBe(0)
  await expect(page.getByTestId('toast').filter({ hasText: /not found|404/i })).toHaveCount(0)
})
