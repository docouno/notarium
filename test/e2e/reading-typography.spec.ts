import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// #27: reading typography — a font (data-reading-font) and a base size
// (data-reading-size) for the RENDERED markdown body. One CSS-var contract
// (--reading-font / --reading-size) drives every `.markdown` surface (reader,
// the editor's Preview, history, the Settings sample); we assert it on the
// reader. The size is expressed once on `.markdown` and the whole type scale is
// em-relative to it, so this single px value scales headings/code/lists too.
//
// Scope check: the knobs style the rendered BODY only. The reader's note TITLE
// (the <h1> in the .doc header, OUTSIDE .markdown) keeps the UI font (--font-sans),
// NOT the reading font — so a note's title never shifts between read and edit (the
// invariant in shared.scss). (--font-sans leads with the Inter UI font and ends in
// the OS stack incl. -apple-system; the point is it never picks up --reading-font.)

const NOTE = 'fake-demo-carbon'

const openReader = async (page: Page) => {
  await page.locator(`[data-testid="tree-note"][data-id="${NOTE}"]`).click()
  await expect(page.locator('.doc .markdown')).toBeVisible()
}

const editBody = async (page: Page, text: string) => {
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const body = page.locator('.cm-content')
  await body.click()
  await body.fill(text)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
}

const openHistoryDiff = async (page: Page) => {
  await editBody(page, 'First body.')
  await editBody(page, 'Second edited body with more detail.')

  const opener = page.getByRole('button', { name: 'Open panel' })

  if (await opener.isVisible()) {
    await opener.click()
  }
  await page.getByRole('tab', { name: 'History' }).click()
  await page.getByTestId('history-item').nth(1).click()
  await expect(page.getByTestId('history-diff')).toBeVisible()
}

test('default reading typography is the system sans at 17px', async ({ page }) => {
  await page.goto('/')
  await openReader(page)

  const md = page.locator('.doc .markdown')
  await expect(md).toHaveCSS('font-size', '17px')
  // The default preset is the Inter-backed sans stack; serif presets must not leak in.
  const family = await md.evaluate((el) => getComputedStyle(el).fontFamily)
  expect(family).toContain('Inter')
  expect(family).toContain('-apple-system')
  expect(family).not.toContain('Literata')
})

test('a font/size preset styles the rendered body but not the note title', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('bm-reading-font', 'literata')
    localStorage.setItem('bm-reading-size', 'l')
  })
  await page.goto('/')
  await openReader(page)

  // <html> carries the chosen presets (the data-attr rail).
  await expect(page.locator('html')).toHaveAttribute('data-reading-font', 'literata')
  await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'l')

  // The body picks them up: Literata family, L = 19px base.
  const md = page.locator('.doc .markdown')
  await expect(md).toHaveCSS('font-size', '19px')
  const bodyFamily = await md.evaluate((el) => getComputedStyle(el).fontFamily)
  expect(bodyFamily).toContain('Literata')

  // Invariant: the note TITLE keeps the UI font, not the reading font — the
  // reading font must not reach it, or read↔edit would shift the title. The title
  // resolves to the --font-sans stack (UI font → OS fallback incl. -apple-system);
  // the load-bearing check is that --reading-font (Literata) never appears in it.
  const titleFamily = await page
    .locator('.doc > header h1')
    .evaluate((el) => getComputedStyle(el).fontFamily)
  expect(titleFamily).not.toContain('Literata')
  expect(titleFamily).toContain('-apple-system')
})

test('history diff follows the reading size through a compact monospace token', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('bm-reading-size', 'xl')
  })
  await page.goto('/')
  await openReader(page)
  await openHistoryDiff(page)

  const diff = page.getByTestId('history-diff')
  await expect(diff).toHaveCSS('font-size', '17.85px')
  const family = await diff.evaluate((el) => getComputedStyle(el).fontFamily)
  expect(family).toContain('JetBrains Mono')

  await diff.evaluate(() => {
    document.documentElement.setAttribute('data-reading-size', 's')
  })
  await expect(diff).toHaveCSS('font-size', '13.175px')
})
