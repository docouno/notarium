import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// #119: two contextual editor surfaces sharing CM6's tooltip-positioning layer.
//   1. Slash menu (`/` on an empty line / after whitespace) → inserts a CLEAN
//      markdown snippet (heading/list/code/table/callout/…). The body stays raw
//      markdown — a slash command is smart text insertion, not a block object — so
//      the round-trip is byte-exact, like every other edit.
//   2. Floating format bar (over a non-empty selection) → the inline + block format
//      toggles, replacing the old top toolbar (removed) in BOTH modes.
// Both render as `position:fixed` CM tooltips INSIDE the editor's own DOM (we pass NO
// `parent: body` — a body host re-introduced a full-viewport phantom screen); fixed
// escapes the scroll-container clipping on its own.

const NOTE = 'fake-demo-carbon'

const openEditor = async (page: Page) => {
  await page.goto('/')
  await page.locator(`[data-testid="tree-note"][data-id="${NOTE}"]`).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  const body = page.locator('.cm-content')
  await body.click()
  return body
}

// CM renders each source line as its own `.cm-line` div (no `\n` in the DOM), so join
// them to assert on the raw markdown across lines.
const readDoc = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-line'))
      .map((l) => l.textContent)
      .join('\n'),
  )

const acceptSlashCommand = async (page: Page, optionName: string | RegExp) => {
  const menu = page.locator('.cm-tooltip-autocomplete')
  await expect(menu).toBeVisible()
  await menu.getByRole('option', { name: optionName }).click()
  await expect(menu).toBeHidden()
}

test('slash menu inserts a clean markdown snippet on an empty line', async ({ page }) => {
  const body = await openEditor(page)
  // Clear to an empty line, then open the menu.
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type('/')

  const menu = page.locator('.cm-tooltip-autocomplete')
  await expect(menu).toBeVisible()

  // Filter to the code-block command and accept it.
  await page.keyboard.type('code')
  await acceptSlashCommand(page, /Code block/)

  // A fenced code block was inserted as raw markdown — and the `/code` query plus
  // the slash itself are gone (the snippet replaced them).
  await expect(body).toContainText('```')
  await expect(body).not.toContainText('/code')
})

test('slash menu does NOT trigger inside a word (e.g. a URL)', async ({ page }) => {
  const body = await openEditor(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  // A `/` that follows a non-space char must not open the menu.
  await page.keyboard.type('http:/')
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0)
  await expect(body).toContainText('http:/')
})

test('floating format bar toggles formatting on a selection', async ({ page }) => {
  const body = await openEditor(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type('hello world')

  // Select the text → the floating bar appears (it shows only on a non-empty
  // selection); there is no top toolbar strip.
  await page.keyboard.press('ControlOrMeta+a')
  const bar = page.locator('.cm-md-formatbar')
  await expect(bar).toBeVisible()

  await bar.getByRole('button', { name: 'Bold' }).click()
  await expect(body).toContainText('**hello world**')
})

// A footnote is a SPLIT construct: an inline ref `[^1]` where you are + a definition
// `[^1]: …` in the footnote block. The caret JUMPS to the definition so you type the
// note there immediately (the two-token shape is then self-explanatory).
test('slash footnote: inline ref + definition, caret lands in the definition', async ({ page }) => {
  await openEditor(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type('A claim ')
  await page.keyboard.type('/foot')
  await acceptSlashCommand(page, /Footnote/)
  await page.keyboard.type('the source') // lands in the definition stub, not the prose

  const doc = await readDoc(page)
  expect(doc).toMatch(/A claim \[\^1\]/) // ref stayed inline
  expect(doc).toMatch(/^\[\^1\]: the source$/m) // text went into the definition
})

// The callout type is an editable field, but the caret starts in the BODY so typing
// can't clobber a preset's type; Tab reaches the type to change it to any of the looks.
test('slash callout: caret starts in the body, Tab edits the type', async ({ page }) => {
  await openEditor(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type('/callout')
  await acceptSlashCommand(page, /^Callout \[!note\]$/)
  await page.keyboard.type('body text') // goes to the body field
  await page.keyboard.press('Tab') // → the type field
  await page.keyboard.type('warning')

  const doc = await readDoc(page)
  expect(doc).toContain('> [!warning]')
  expect(doc).toContain('> body text')
})

// A multi-line block invoked on an INDENTED line (a nested list item) must land at
// column 0 — not inherit the list indent, which would corrupt the callout/code/table.
test('slash block on an indented line lands at column 0', async ({ page }) => {
  await openEditor(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type('  - nested item ')
  await page.keyboard.type('/callout')
  await acceptSlashCommand(page, /^Callout \[!note\]$/)

  const doc = await readDoc(page)
  expect(doc).toMatch(/^> \[!note\]$/m) // marker at column 0…
  expect(doc).not.toContain('  > [!note]') // …not indented under the list
})

// Internal/wiki links insert INLINE at the caret, cursor between the brackets.
test('slash internal link inserts [[ ]] inline', async ({ page }) => {
  await openEditor(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type('Related: ')
  await page.keyboard.type('/internal')
  await acceptSlashCommand(page, /Internal link/)
  await page.keyboard.type('My Note')

  const doc = await readDoc(page)
  expect(doc).toContain('Related: [[My Note]]')
})
