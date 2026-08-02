import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// #205: Enter in the shared CodeMirror editor should behave like a markdown writer
// in BOTH Source and WYSIWYM. The mode only changes decorations; the raw markdown
// editing command is one shared keymap.

const NOTE = 'fake-demo-carbon'

const openEditor = async (page: Page, mode: 'source' | 'wysiwym') => {
  await page.addInitScript((m) => localStorage.setItem('bm-editor-mode', m), mode)
  await page.goto('/')
  await page.locator(`[data-testid="tree-note"][data-id="${NOTE}"]`).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  const body = page.locator('.cm-content')
  await body.click()
  return body
}

const replaceDoc = async (page: Page, text: string) => {
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(text)
}

const readDoc = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-line'))
      .map((l) => l.textContent)
      .join('\n'),
  )

for (const mode of ['source', 'wysiwym'] as const) {
  test(`Enter continues markdown lists and exits an empty item in ${mode}`, async ({ page }) => {
    await openEditor(page, mode)

    await replaceDoc(page, '- item')
    await page.keyboard.press('Enter')
    await page.keyboard.type('next')
    expect(await readDoc(page)).toBe('- item\n- next')

    await replaceDoc(page, '1. item')
    await page.keyboard.press('Enter')
    await page.keyboard.type('next')
    expect(await readDoc(page)).toBe('1. item\n2. next')

    await replaceDoc(page, '- [ ] item')
    await page.keyboard.press('Enter')
    await page.keyboard.type('next')
    expect(await readDoc(page)).toBe('- [ ] item\n- [ ] next')

    await replaceDoc(page, '  - nested item')
    await page.keyboard.press('Enter')
    await page.keyboard.type('next')
    expect(await readDoc(page)).toBe('  - nested item\n  - next')

    await replaceDoc(page, '- parent\n  - child')
    await page.keyboard.press('Enter')
    expect(await readDoc(page)).toBe('- parent\n  - child\n  - ')
    await page.keyboard.press('Enter')
    expect(await readDoc(page)).toBe('- parent\n  - child\n- ')
    await page.keyboard.press('Enter')
    expect(await readDoc(page)).toBe('- parent\n  - child\n')

    await replaceDoc(page, '- parent\n  - child\n    - leaf')
    await page.keyboard.press('Enter')
    expect(await readDoc(page)).toBe('- parent\n  - child\n    - leaf\n    - ')
    await page.keyboard.press('Enter')
    expect(await readDoc(page)).toBe('- parent\n  - child\n    - leaf\n  - ')
    await page.keyboard.press('Enter')
    expect(await readDoc(page)).toBe('- parent\n  - child\n    - leaf\n- ')

    await replaceDoc(page, '- item')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('after')
    expect(await readDoc(page)).toBe('- item\nafter')

    await replaceDoc(page, '1. item')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('after')
    expect(await readDoc(page)).toBe('1. item\nafter')

    await replaceDoc(page, '- [ ] item')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('after')
    expect(await readDoc(page)).toBe('- [ ] item\nafter')

    // Blockquote continuation shares the one Enter binding with lists.
    await replaceDoc(page, '> quote')
    await page.keyboard.press('Enter')
    await page.keyboard.type('more')
    expect(await readDoc(page)).toBe('> quote\n> more')

    // MUST-NOT-REGRESS (#205): outside any list/quote the continuation command returns
    // false, so Enter must fall through to defaultKeymap and insert a PLAIN newline —
    // no marker inserted, nothing swallowed. Cover both prose and a fenced code block,
    // the two negative paths the whole precedence/addKeymap wiring rests on.
    await replaceDoc(page, 'hello')
    await page.keyboard.press('Enter')
    await page.keyboard.type('x')
    expect(await readDoc(page)).toBe('hello\nx')

    await replaceDoc(page, '```\ncode')
    await page.keyboard.press('Enter')
    await page.keyboard.type('x')
    expect(await readDoc(page)).toBe('```\ncode\nx')
  })
}

test('slash menu keeps owning Enter before markdown continuation', async ({ page }) => {
  await openEditor(page, 'source')
  await replaceDoc(page, '/')

  const menu = page.locator('.cm-tooltip-autocomplete')
  await expect(menu).toBeVisible()
  await page.keyboard.type('code')
  await expect(menu.getByRole('option', { name: /Code block/ })).toBeVisible()
  await page.keyboard.press('Enter')

  await expect(menu).toBeHidden()
  expect(await readDoc(page)).toContain('```')
  expect(await readDoc(page)).not.toContain('/code')
})
