import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// #231: the editing scroller (.content-scroll) is not owned by CodeMirror, and two glass
// bars overlap its edges — the topbar (--chrome-h) at the top and the editor status bar
// (--editor-statusbar-h) at the bottom. chromeInsetScroll nudges the ancestor scroller so
// caret-into-view never leaves the caret line behind either bar: below the topbar at the
// start, above the status bar at the end.
//
// It does this WITHOUT EditorView.scrollMargins on purpose — that facet also shrinks the
// box CM checks a tooltip's anchor against, which would clip the slash / format menu at
// the first/last line. So these specs assert BOTH: the caret clears each bar, and the
// slash menu still opens on-screen at the last line (the regression that ruled scroll-
// margins out). Default viewport is Desktop Chrome (1280×720), where a ~40-line doc
// overflows the scroller.

const NOTE = 'fake-demo-carbon'

const openEditor = async (page: Page, mode: 'source' | 'wysiwym') => {
  await page.addInitScript((m) => localStorage.setItem('bm-editor-mode', m), mode)
  await page.goto('/')
  await page.locator(`[data-testid="tree-note"][data-id="${NOTE}"]`).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.locator('.cm-content').click()
}

// A tall document that reliably overflows the scroller at the default viewport.
const LONG_DOC = [
  '# Caret offset 231',
  ...Array.from({ length: 40 }, (_, i) => `Line ${i + 1} lorem ipsum dolor sit amet`),
].join('\n')

const seedLongDoc = async (page: Page) => {
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(LONG_DOC)
}

// chromeInsetScroll nudges the scroller in a rAF; let it settle before measuring.
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))),
  )

const measure = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('.cm-cursor-primary')!.getBoundingClientRect()
    const b = document.querySelector('[data-testid="editor-statusbar"]')!.getBoundingClientRect()
    const chromeH =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chrome-h')) || 0
    return { caretTop: c.top, caretBottom: c.bottom, statusBarTop: b.top, topbarBottom: chromeH }
  })

test('caret clears both floating bars — bottom on type, top on Home (#231)', async ({ page }) => {
  await openEditor(page, 'source')
  await seedLongDoc(page)

  // Bottom: typing at the very end keeps the caret line above the status bar.
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('!')
  await settle(page)
  const bottom = await measure(page)
  expect(bottom.caretBottom).toBeLessThanOrEqual(bottom.statusBarTop)

  // Top: jumping to the start keeps the caret line below the topbar.
  await page.keyboard.press('ControlOrMeta+Home')
  await settle(page)
  const top = await measure(page)
  expect(top.caretTop).toBeGreaterThanOrEqual(top.topbarBottom)
})

// Arrowing DOWN through the wrapped visual rows of ONE long paragraph must also clear the
// bar. The re-check keys on caret MOVES, not the logical-line number — with line wrapping a
// paragraph is a single logical line spanning many rows, so a per-line gate would miss these
// moves and leave the caret hidden under the status bar (the bug this guards).
test('caret clears the status bar arrowing through a wrapped paragraph (#231)', async ({
  page,
}) => {
  await openEditor(page, 'source')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  // One heading + one very long single logical line that wraps across ~100 visual rows.
  await page.keyboard.insertText('# Wrap test\n' + 'lorem ipsum dolor sit amet '.repeat(300))
  await page.keyboard.press('ControlOrMeta+Home')
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('ArrowDown')
  } // deep into the wrapped line
  await settle(page)
  const m = await measure(page)
  expect(m.caretBottom).toBeLessThanOrEqual(m.statusBarTop)
})

// The regression that ruled out scrollMargins: with the caret on the last line, the slash
// menu must still render on-screen — not clipped off-screen because a scroll margin shrank
// the tooltip's visible box below the caret. Covered in BOTH surfaces — WYSIWYM's taller,
// variable line boxes are where the clipping first showed up.
for (const mode of ['source', 'wysiwym'] as const) {
  test(`slash menu stays on-screen at the last line in ${mode} (#231)`, async ({ page }) => {
    await openEditor(page, mode)
    await seedLongDoc(page)
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/')

    const menu = page.locator('.cm-tooltip-autocomplete')
    await expect(menu).toBeVisible()
    // Not parked off-screen (CM hides an out-of-view tooltip at top:-10000).
    const box = await menu.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThan(-1000)
    expect(box!.y).toBeLessThan(720)
  })
}
