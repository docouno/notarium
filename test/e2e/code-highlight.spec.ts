import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// #178/#177: in BOTH editor modes the fenced-code body tokenizes by language
// (codeLanguages wires the nested lezer parsers) and the tokens are painted from
// the SAME `--hl-*` role palette that the reading-view highlighter (highlight.js)
// and the Code-theme presets use. So one Code-theme preset themes editor AND
// preview alike — the bridge that this asserts. The body is never rewritten
// (decorations only), so round-trip stays byte-exact like every other mode.

const NOTE = 'fake-demo-carbon'
const BODY = '# Code\n\n```js\nconst x = 1\n```'

// Resolve a CSS variable to the concrete rgb the browser computes, then compare
// the rendered "const" keyword token's colour to the `--hl-keyword` role. Equality
// proves the bridge: the editor's code token is driven by the shared palette, not a
// hard-coded colour. Returns nulls until the lazy language parser has loaded and
// re-highlighted (the caller polls), and guards against a false pass by also
// reporting the plain body colour (the keyword must NOT be the default text).
const keywordVsRole = async (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--hl-keyword)'
    document.body.appendChild(probe)
    const roleColor = getComputedStyle(probe).color
    probe.remove()
    const spans = [...document.querySelectorAll('.cm-content .cm-line span')]
    const kw = spans.find((s) => s.textContent === 'const')
    const text = getComputedStyle(document.querySelector('.cm-content') as Element).color
    return { roleColor, kwColor: kw ? getComputedStyle(kw).color : null, text }
  })

const openWithCode = async (page: Page) => {
  await page.locator(`[data-testid="tree-note"][data-id="${NOTE}"]`).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  const body = page.locator('.cm-content')
  await body.click()
  await body.fill(BODY)
  await expect(body).toContainText('const x = 1')
  return body
}

test('Source mode paints fenced code tokens from the --hl-* palette', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bm-editor-mode', 'source'))
  await page.goto('/')
  await openWithCode(page)

  // The nested parser loads lazily, so poll until the keyword token is coloured by
  // the role (and is distinct from the plain text colour — a real highlight).
  await expect
    .poll(async () => {
      const r = await keywordVsRole(page)
      return r.kwColor !== null && r.kwColor === r.roleColor && r.kwColor !== r.text
    })
    .toBe(true)
})

test('WYSIWYM mode paints fenced code tokens from the --hl-* palette', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bm-editor-mode', 'wysiwym'))
  await page.goto('/')
  await openWithCode(page)

  await expect(page.locator('.cm-host--wysiwym')).toHaveCount(1)
  await expect
    .poll(async () => {
      const r = await keywordVsRole(page)
      return r.kwColor !== null && r.kwColor === r.roleColor && r.kwColor !== r.text
    })
    .toBe(true)
})
