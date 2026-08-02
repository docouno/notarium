import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

// #229 — the open note (activeId) and the multi-select set are now VISUALLY
// DISTINCT and the open note PARTICIPATES in the set. Before #229 `.active` and
// `.selected` both painted the same `--bg-hover` grey, so an open row and a picked
// row were indistinguishable and toggling the open file into the set had no visible
// effect (#163/#206 pain). Now they differ by neutral grey DEPTH (no accent): the
// open note keeps the light `--bg-hover` pill, a selected row is a denser
// `--border-strong` grey. A row that's BOTH reads as the deeper set-grey. The model
// was ALWAYS independent (activeId vs the selection Map); #229 is the visual
// separation + the canon flip.

const FIXTURE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        { title: 'alpha', filePath: 'f1/alpha.md', content: '# alpha', tags: [] },
        { title: 'bravo', filePath: 'f1/bravo.md', content: '# bravo', tags: [] },
      ].map((n) => ({
        ...n,
        modifiedAt: '2026-06-08T00:00:00.000Z',
        createdAt: '2026-06-01T09:00:00.000Z',
      })),
    },
  ],
}

const noteSel = (id: string) => `[data-testid="tree-note"][data-id="${id}"]`

const idOf = (page: Page, title: string) =>
  page.locator(`[data-testid="tree-note"]`, { hasText: title }).first().getAttribute('data-id')

// Open (`.active`) and selected (`.selected`) now differ by neutral grey DEPTH —
// `--bg-hover` vs the denser `--border-strong` — so the resolved background-color
// is the stable signal that separates "open" from "in the set". Both are opaque
// (a non-highlighted row is transparent).
const bgOf = (page: Page, sel: string) =>
  page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor)
// The "both" state (open AND selected) adds a neutral left border via `::before`;
// a plain selected row has no such pseudo. Its background-color is the stable signal.
const beforeBgOf = (page: Page, sel: string) =>
  page.locator(sel).evaluate((el) => getComputedStyle(el, '::before').backgroundColor)
// The pill fills use background-COLOR (not the `background` shorthand) so the tree's
// `background-clip: padding-box` (the 1px inter-row gap) survives selection. Reverting
// to the shorthand would reset clip to border-box — this reads the guard directly.
const clipOf = (page: Page, sel: string) =>
  page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundClip)
const TRANSPARENT = 'rgba(0, 0, 0, 0)'

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

const reset = async (page: Page, baseURL: string | undefined) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(2)
}

test('the open note is visually distinct from a selection and toggles in/out visibly (#229)', async ({
  page,
  baseURL,
}) => {
  await reset(page, baseURL)
  const alpha = await idOf(page, 'alpha')
  const bravo = await idOf(page, 'bravo')
  expect(alpha).toBeTruthy()
  expect(bravo).toBeTruthy()

  // Open alpha with a plain click. It becomes the active doc (`aria-current`), and
  // a plain click CLEARS the set — the open note does NOT auto-join (Model 1).
  await page.locator(noteSel(alpha!)).click()
  await expect(page).toHaveURL(new RegExp(`/n/${alpha}`))
  await expect(page.locator(noteSel(alpha!))).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(0)

  // Move the real cursor OFF the row first: a plain .click() leaves the pointer over
  // alpha, and `.nav-item:hover` paints the same --bg-hover as `.active` — so reading
  // the fill now would pass on hover alone and NOT isolate the .active rule.
  await page.mouse.move(0, 0)
  // The open row shows the light neutral pill (from .active, not hover); a plain,
  // un-highlighted row shows none. The pill keeps background-clip: padding-box (the
  // 1px gap) — it uses background-color, not the shorthand.
  const openBg = await bgOf(page, noteSel(alpha!))
  expect(openBg).not.toBe(TRANSPARENT)
  expect(await clipOf(page, noteSel(alpha!))).toBe('padding-box')
  expect(await bgOf(page, noteSel(bravo!))).toBe(TRANSPARENT)
  // Active-only (open, NOT yet in the set): NO left border — the ::before bar is
  // exclusive to the "both" state (guards the other side of the 3-state distinction).
  expect(await beforeBgOf(page, noteSel(alpha!))).toBe(TRANSPARENT)

  // Ctrl-click the OPEN note → it toggles INTO the set with a now-visible effect:
  // the row is BOTH active (aria-current) AND selected (aria-selected), and its pill
  // DEEPENS to the denser set-grey. Pre-#229 this toggle changed nothing on screen
  // (both were the same grey).
  await modClick(page, noteSel(alpha!), { ctrl: true })
  await expect(page.locator(noteSel(alpha!))).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(1)
  const alphaWrap = page
    .locator(noteSel(alpha!))
    .locator('xpath=ancestor::*[@aria-selected]')
    .first()
  await expect(alphaWrap).toHaveAttribute('aria-selected', 'true')
  const setBg = await bgOf(page, noteSel(alpha!))
  expect(setBg).not.toBe(openBg) // the pill visibly deepened — the toggle shows

  // Ctrl-click bravo → a second, selected-but-NOT-open member. It gets the SAME
  // denser set-grey (aria-selected) and NO aria-current — and that set-grey differs
  // from the open-only pill, so within one selection you can tell open from picked.
  await modClick(page, noteSel(bravo!), { ctrl: true })
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(2)
  await expect(page.locator(noteSel(bravo!))).not.toHaveAttribute('aria-current', 'page')
  expect(await bgOf(page, noteSel(bravo!))).toBe(setBg) // both selected → same grey
  expect(await bgOf(page, noteSel(bravo!))).not.toBe(openBg) // ≠ the open-only pill
  expect(await clipOf(page, noteSel(bravo!))).toBe('padding-box') // gap survives selection

  // The "both" row (alpha: open AND selected) carries the neutral left border
  // (::before); the selected-but-not-open row (bravo) does not — so within the set
  // the open one is still distinguishable.
  expect(await beforeBgOf(page, noteSel(alpha!))).not.toBe(TRANSPARENT)
  expect(await beforeBgOf(page, noteSel(bravo!))).toBe(TRANSPARENT)
})

test('deleting a set that includes the open note carries it with the rest (#229)', async ({
  page,
  baseURL,
}) => {
  await reset(page, baseURL)
  const alpha = await idOf(page, 'alpha')
  const bravo = await idOf(page, 'bravo')

  // The issue's example: open A, ctrl-click A and B → the set is {A, B}. Delete
  // carries BOTH (pre-#229 the open file, absent from the Map, was silently left).
  await page.locator(noteSel(alpha!)).click()
  await expect(page.locator(noteSel(alpha!))).toHaveAttribute('aria-current', 'page')
  await modClick(page, noteSel(alpha!), { ctrl: true })
  await modClick(page, noteSel(bravo!), { ctrl: true })
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(2)

  await page.locator(noteSel(alpha!)).click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Delete 2 items' }).click()
  await page.getByRole('button', { name: 'Delete 2 items' }).click()

  // Both gone — including the open one — and the reader really CLEARS: the URL leaves
  // /n/<alpha> (asserting aria-current=0 alone is degenerate — the rows are gone too).
  await expect(page.locator(noteSel(alpha!))).toHaveCount(0)
  await expect(page.locator(noteSel(bravo!))).toHaveCount(0)
  await expect(page).not.toHaveURL(new RegExp(`/n/${alpha}`))
  await expect(page.locator('[data-testid="tree-note"][aria-current="page"]')).toHaveCount(0)
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(0)
})

test('a plain click on the open note clears the multi-select set (#229, Model 1)', async ({
  page,
  baseURL,
}) => {
  await reset(page, baseURL)
  const alpha = await idOf(page, 'alpha')
  const bravo = await idOf(page, 'bravo')

  // Build a set {alpha, bravo} with alpha open.
  await page.locator(noteSel(alpha!)).click()
  await modClick(page, noteSel(alpha!), { ctrl: true })
  await modClick(page, noteSel(bravo!), { ctrl: true })
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(2)

  // A plain click on the open note re-opens it and CLEARS the set (the set is the
  // explicit pick — the open note stays active via aria-current, but leaves the set).
  await page.locator(noteSel(alpha!)).click()
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(0)
  await expect(page.locator(noteSel(alpha!))).toHaveAttribute('aria-current', 'page')
  // Still visually the open doc — the light neutral pill remains (cursor moved off, so
  // it's the .active fill, not hover).
  await page.mouse.move(0, 0)
  expect(await bgOf(page, noteSel(alpha!))).not.toBe(TRANSPARENT)
})

test('a selected folder darkens like a note, and its go-to-page icon continues that fill (#229)', async ({
  page,
  baseURL,
}) => {
  await reset(page, baseURL)
  const alpha = await idOf(page, 'alpha')
  const folderRow = '[data-testid="tree-folder"][data-path="f1"]'
  const folderBtn = `${folderRow} button:not([aria-label="Toggle folder"])`
  const rowAction = `${folderRow} [data-testid="folder-open-page"]`

  // Folders and notes share the .selected rule, so a ctrl-clicked folder must take the
  // SAME denser --border-strong set-grey as a selected note (canon §4 includes folders).
  // The go-to-page icon (.row-action) renders ONLY on folder rows — this is the sole
  // place the #229 "icon continues the fill, no lighter-box punch-through" holds.
  await modClick(page, noteSel(alpha!), { ctrl: true })
  await modClick(page, folderBtn, { ctrl: true })
  await expect(page.locator(folderRow)).toHaveAttribute('aria-selected', 'true')
  const noteSetBg = await bgOf(page, noteSel(alpha!))
  const folderBg = await bgOf(page, folderBtn)
  expect(folderBg).not.toBe(TRANSPARENT)
  expect(folderBg).toBe(noteSetBg) // folder darkens exactly like a selected note

  // Hover the folder row (cursor on the name, not the icon) → the go-to-page icon
  // reveals and paints the row's CURRENT fill (var(--row-fill) == --border-strong here),
  // NOT a lighter --bg-hover box that would punch through the denser selected pill (the
  // regression #229 targets). A revert to a hardcoded --bg-hover reveal fails this.
  await page.locator(folderBtn).hover()
  await expect(page.locator(rowAction)).toBeVisible()
  // The overlay fill snaps to the row's --row-fill instantly now — #246 made both surfaces
  // instant (only the icon glyph fades). toHaveCSS still auto-retries for the hover to
  // settle, but the background must equal the folder's own --border-strong pill.
  await expect(page.locator(rowAction)).toHaveCSS('background-color', folderBg)
})
