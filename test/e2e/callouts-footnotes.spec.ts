import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// #117: callouts (`> [!type]`) and footnotes (`[^id]`) are render-only markdown
// extensions wired into the single renderMarkdown funnel (reading view, the
// editor's Preview toggle, Settings preview, history). The body bytes are never
// rewritten — the markers are plain markdown, so the source round-trips byte-exact.
// In Styled mode the editor keeps the source visible but tints the callout's rail
// by its type (a light parity nod, not a full render).

const NOTE = 'fake-demo-carbon'

const BODY = [
  '> [!warning] Heads up',
  '> Be careful here.',
  '',
  '> [!tip]- Folded',
  '> Hidden until clicked.',
  '',
  '> Just a normal quote.',
  '',
  'A claim with a footnote.[^1]',
  '',
  '[^1]: The supporting note.',
].join('\n')

const openEditorWithBody = async (page: Page) => {
  await page.locator(`[data-testid="tree-note"][data-id="${NOTE}"]`).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  const body = page.locator('.cm-content')
  await body.click()
  await body.fill(BODY)
  await expect(body).toContainText('Heads up')
  return body
}

test('Preview renders callouts (incl. foldable) and footnotes; a plain quote stays a quote', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('bm-editor-mode', 'source'))
  await page.goto('/')
  await openEditorWithBody(page)
  await page.getByRole('button', { name: 'Preview' }).click()

  const preview = page.locator('[data-testid="editor-preview"]')
  // A typed callout box, with its custom title.
  await expect(preview.locator('.callout.callout-warning')).toHaveCount(1)
  await expect(preview.locator('.callout-warning .callout-title')).toHaveText('Heads up')
  // Foldable → a native <details> (collapsed, since `-`).
  const folded = preview.locator('details.callout.callout-tip')
  await expect(folded).toHaveCount(1)
  await expect(folded).not.toHaveAttribute('open', /.*/)
  // A `[!type]`-less blockquote is left as a plain blockquote, not a callout.
  await expect(preview.locator('blockquote')).toHaveCount(1)
  // Footnote: a superscript ref + the collected definitions section with a back-ref.
  await expect(preview.locator('sup a[data-footnote-ref]')).toHaveCount(1)
  await expect(preview.locator('section.footnotes a[data-footnote-backref]')).toHaveCount(1)
})

test('callout/footnote output is sanitised by DOMPurify (no script / no onerror)', async ({
  page,
}) => {
  // The whole safety net is the single renderMarkdown DOMPurify pass: callouts
  // interpolate a parsed-inline title and the footnote lib emits attributes, so
  // nothing must let raw HTML through. Render a callout whose title + body carry an
  // XSS payload and assert the rendered DOM is clean.
  await page.addInitScript(() => localStorage.setItem('bm-editor-mode', 'source'))
  await page.goto('/')
  await page.locator(`[data-testid="tree-note"][data-id="${NOTE}"]`).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  const body = page.locator('.cm-content')
  await body.click()
  await body.fill(
    '> [!note] <img src=x onerror=alert(1)>\n> Body <script>alert(2)</script> here.[^x]\n\n[^x]: def <script>alert(3)</script>',
  )
  await expect(body).toContainText('[!note]')
  await page.getByRole('button', { name: 'Preview' }).click()

  const preview = page.locator('[data-testid="editor-preview"]')
  await expect(preview.locator('.callout.callout-note')).toHaveCount(1)
  await expect(preview.locator('script')).toHaveCount(0) // scripts stripped
  // The img survives but inert — the onerror handler must be gone.
  const imgs = preview.locator('img')

  for (let i = 0; i < (await imgs.count()); i++) {
    await expect(imgs.nth(i)).not.toHaveAttribute('onerror', /.*/)
  }
})

test('WYSIWYM mode tints the callout rail by type while keeping the source visible', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('bm-editor-mode', 'wysiwym'))
  await page.goto('/')
  const body = await openEditorWithBody(page)

  // The callout's first quote line carries the shared look class for the rail tint.
  await expect(page.locator('.cm-line.cm-md-callout.callout-warning')).not.toHaveCount(0)
  // The markers stay visible — styled-source never hides the `[!warning]` head.
  await expect(body).toContainText('[!warning]')
})
