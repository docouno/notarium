import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// #116 (named #180): the editor surfaces the body per the global Source/WYSIWYM
// setting (ChromeProvider.editorMode, persisted to localStorage — no in-editor
// toggle). WYSIWYM is "styled source": the raw markdown markers stay VISIBLE (so
// the line length never changes and the caret never makes text jump), but the text
// is richly styled and block lines (quote/code) get a tinted backdrop. Source is
// the plain raw markdown. Both edit the same raw body — decorations never rewrite
// it, so the saved bytes are identical regardless of mode (the load-bearing
// invariant; verified live).

const NOTE = 'fake-demo-carbon'
const BODY = '# Heading\n**bold** text here\n> a quoted line'

const openEditorWithBody = async (page: Page) => {
  await page.locator(`[data-testid="tree-note"][data-id="${NOTE}"]`).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  const body = page.locator('.cm-content')
  await body.click()
  await body.fill(BODY)
  await expect(body).toContainText('Heading')
  return body
}

test('WYSIWYM mode styles the source and tints block lines, keeping markers visible', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('bm-editor-mode', 'wysiwym'))
  await page.goto('/')
  const body = await openEditorWithBody(page)

  await expect(page.locator('.cm-host--wysiwym')).toHaveCount(1)
  // Block backdrop on the quote line (the WYSIWYM-source block treatment).
  await expect(page.locator('.cm-line.cm-md-blockquote')).toHaveCount(1)
  // Markers stay VISIBLE — that's what kills the caret-jump. `**bold**` is shown
  // raw (styled), not hidden behind a decoration.
  await expect(body).toContainText('**bold**')
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
})

test('Source mode is plain source, no WYSIWYM treatment', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bm-editor-mode', 'source'))
  await page.goto('/')
  const body = await openEditorWithBody(page)

  await expect(page.locator('.cm-host--wysiwym')).toHaveCount(0)
  await expect(page.locator('.cm-md-blockquote')).toHaveCount(0)
  await expect(body).toContainText('**bold**')
})

// #180 renamed the persisted values for the SECOND time: the styled-source mode
// was 'wysiwyg' (#116 first cut) then 'styled' (#116 final) before 'wysiwym'; the
// plain mode was 'markdown' before 'source'. The migration must never flip a
// returning user's mode — both legacy styled-source labels land on WYSIWYM, and
// the legacy plain label (and anything unknown) lands on Source.
for (const legacy of ['styled', 'wysiwyg']) {
  test(`legacy '${legacy}' in localStorage migrates to WYSIWYM`, async ({ page }) => {
    await page.addInitScript((v) => localStorage.setItem('bm-editor-mode', v), legacy)
    await page.goto('/')
    await openEditorWithBody(page)
    await expect(page.locator('.cm-host--wysiwym')).toHaveCount(1)
    // The migration rewrites the stored value to the new canonical name.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('bm-editor-mode')))
      .toBe('wysiwym')
  })
}

test("legacy 'markdown' in localStorage migrates to Source", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bm-editor-mode', 'markdown'))
  await page.goto('/')
  await openEditorWithBody(page)
  await expect(page.locator('.cm-host--wysiwym')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('bm-editor-mode')))
    .toBe('source')
})

// The most common real input: a fresh user / private window with no key set at
// all. It must default to Source AND have the default persisted (so the value is
// canonical from the first run, not left absent).
test('no stored editor mode defaults to Source and persists it', async ({ page }) => {
  await page.goto('/')
  await openEditorWithBody(page)
  await expect(page.locator('.cm-host--wysiwym')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('bm-editor-mode')))
    .toBe('source')
})
