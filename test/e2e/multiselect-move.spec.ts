import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

// #163 — multi-select move: pick several notes/folders with ctrl/cmd/shift-click,
// then drag the whole selection into a target folder with one drop. The selection
// model + the set-shaped drag payload are new axes (there was no selection state
// before this); the move itself reuses the per-item paths (notes via the
// optimistic pipeline, folders via the sequential batch) — see
// docs/drag-and-drop.md §4 (selection) + §6 (drop the movable subset).
//
// Native drag timing can't be driven by Playwright (drag-and-drop.md §7), so —
// like move-refresh.spec — we dispatch the HTML5 DragEvent sequence directly. The
// selection is set first by dispatching real modifier-clicks (React commits the
// state → the row's aria-selected flips), THEN the drag reads it.

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

const noteSel = (id: string) => `[data-testid="tree-note"][data-id="${id}"]`
const folderSel = (path: string) => `[data-testid="tree-folder"][data-path="${path}"]`
// The folder's NAME button (not the chevron) — where the select/drag handlers live.
const folderBtnSel = (path: string) => `${folderSel(path)} button:not([aria-label="Toggle folder"])`

const idOf = (page: Page, title: string) =>
  page.locator(`[data-testid="tree-note"]`, { hasText: title }).first().getAttribute('data-id')

// Dispatch a real click with modifier keys so React's onClick runs the select
// branch (ctrl/cmd toggles, shift ranges).
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

// Drag from a (selected) row onto a destination folder row — the payload is read
// from the live selection at dragstart. dragstart on the drag source, then
// dragover/drop on the dest row (which declares its data-drop-folder), one shared
// DataTransfer, as a browser does.
const dragSelectionOnto = async (page: Page, fromSel: string, destSel: string) => {
  await page.evaluate(
    ({ fromSel: sourceSelector, destSel: targetSelector }) => {
      const src = document.querySelector(sourceSelector) as HTMLElement
      const dest = document.querySelector(targetSelector) as HTMLElement

      if (!src || !dest) {
        throw new Error('drag endpoints not mounted')
      }
      const dt = new DataTransfer()
      const fire = (el: HTMLElement, type: string) =>
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      fire(src, 'dragstart')
      fire(dest, 'dragenter')
      fire(dest, 'dragover')
      fire(dest, 'drop')
      fire(src, 'dragend')
    },
    { fromSel, destSel },
  )
}

// The folder a note's row currently declares ('' = root) — proves where it landed.
const folderOfRow = (page: Page, id: string) =>
  page.evaluate(
    (rowId) =>
      document
        .querySelector(`[data-testid="tree-note"][data-id="${rowId}"]`)
        ?.parentElement?.getAttribute('data-drop-folder'),
    id,
  )

test('ctrl-click several notes, drag them into a folder in one drop (#163)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(5)

  const a1 = await idOf(page, 'a1')
  const b1 = await idOf(page, 'b1')
  expect(a1).toBeTruthy()
  expect(b1).toBeTruthy()

  // Select a1 (in f1) and b1 (in f2) with ctrl/cmd-click — both light up.
  await modClick(page, noteSel(a1!), { ctrl: true })
  await modClick(page, noteSel(b1!), { ctrl: true })
  await expect(
    page
      .locator(`${noteSel(a1!)}`)
      .locator('xpath=ancestor::*[@aria-selected]')
      .first(),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    page
      .locator(`${noteSel(b1!)}`)
      .locator('xpath=ancestor::*[@aria-selected]')
      .first(),
  ).toHaveAttribute('aria-selected', 'true')

  // Drag the selection (grabbing one of the selected rows) onto 'archive'.
  await dragSelectionOnto(page, noteSel(a1!), folderSel('archive'))

  // Both notes now live in 'archive' (and nothing was lost: still 5 rows).
  await expect.poll(() => folderOfRow(page, a1!)).toBe('archive')
  await expect.poll(() => folderOfRow(page, b1!)).toBe('archive')
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(5)
  await expect(page.locator(noteSel(a1!))).toHaveCount(1)
})

test('ctrl-click several folders, drag them into another folder in one drop (#163)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await expect(page.locator(folderSel('f1'))).toBeVisible()
  await expect(page.locator(folderSel('f2'))).toBeVisible()
  await expect(page.locator(folderSel('f3'))).toBeVisible()

  // Select folders f1 and f2 (ctrl-click their name buttons) — both light up,
  // and a ctrl-click does NOT expand/collapse them.
  await modClick(page, folderBtnSel('f1'), { ctrl: true })
  await modClick(page, folderBtnSel('f2'), { ctrl: true })
  await expect(page.locator(folderSel('f1'))).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator(folderSel('f2'))).toHaveAttribute('aria-selected', 'true')

  // Drag the two selected folders into f3 — both subtrees relocate under it.
  await dragSelectionOnto(page, folderBtnSel('f1'), folderSel('f3'))

  await expect(page.locator(folderSel('f3/f1'))).toBeVisible()
  await expect(page.locator(folderSel('f3/f2'))).toBeVisible()
  // The old top-level rows are gone (moved, not copied).
  await expect(page.locator(folderSel('f1'))).toHaveCount(0)
  await expect(page.locator(folderSel('f2'))).toHaveCount(0)
})

test('shift-click ranges over the rows between the anchor and the click (#163)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  // Ensure f1 is open so its two notes (a1, a2) become rows the range can span.
  const a1 = 'fake-f1-a1'
  const a2 = 'fake-f1-a2'
  const f1Folder = page.locator(folderSel('f1'))
  const a1Row = page.locator(noteSel(a1))
  await expect(f1Folder).toBeVisible()
  if ((await f1Folder.getAttribute('aria-expanded')) !== 'true') {
    await page.locator(`${folderSel('f1')} button[aria-label="Toggle folder"]`).click()
  }
  await expect(f1Folder).toHaveAttribute('aria-expanded', 'true')
  await expect(a1Row).toBeVisible()
  await expect(page.locator(noteSel(a2))).toBeVisible()

  // ctrl-click a1 (anchor + select), then shift-click a2 → the inclusive run
  // a1..a2 is selected (here two adjacent notes; folders in a range come too).
  await modClick(page, noteSel(a1), { ctrl: true })
  await modClick(page, noteSel(a2), { shift: true })
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(2)

  // Drag the ranged pair onto f2 — both land there.
  await dragSelectionOnto(page, noteSel(a1), folderSel('f2'))
  await expect.poll(() => folderOfRow(page, a1)).toBe('f2')
  await expect.poll(() => folderOfRow(page, a2)).toBe('f2')
})

test('a mixed set (a folder + a note) moves together in one drop (#163)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await expect(page.locator(folderSel('f1'))).toBeVisible()
  const b1 = await idOf(page, 'b1') // lives in f2

  // ctrl-select folder f1 AND note b1 (a folder + a note, mixed), drag into f3.
  await modClick(page, folderBtnSel('f1'), { ctrl: true })
  await modClick(page, noteSel(b1!), { ctrl: true })
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(2)

  await dragSelectionOnto(page, folderBtnSel('f1'), folderSel('f3'))
  // The folder relocated under f3; the note landed in f3 too.
  await expect(page.locator(folderSel('f3/f1'))).toBeVisible()
  await expect(page.locator(folderSel('f1'))).toHaveCount(0)
  await expect.poll(() => folderOfRow(page, b1!)).toBe('f3')
})

test('plain click clears a multi-selection; Escape clears it too (#163)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(5)

  const a1 = await idOf(page, 'a1')
  const a2 = await idOf(page, 'a2')
  await modClick(page, noteSel(a1!), { ctrl: true })
  await modClick(page, noteSel(a2!), { ctrl: true })
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(2)

  // Escape clears the set.
  await page.keyboard.press('Escape')
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(0)

  // Re-select, then a plain click elsewhere clears it.
  await modClick(page, noteSel(a1!), { ctrl: true })
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(1)
  await page.locator(folderBtnSel('f2')).click() // plain click → clears + toggles f2
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(0)
})
