import type { Page } from '@playwright/test'
import { expect, openSpotlight, test, waitForAppReady } from './fixtures'

// Global hotkeys (#30): the central dispatcher + the `?` cheat sheet + the Settings
// editor (preset + per-action rebind). Single keys fire only outside text fields;
// `g`-sequences navigate; modifier chords work anywhere; the editor's formatting
// keymap is built from the same map. Runs against the fake backend (space `main`).

const EXISTING_NOTE = 'fake-demo-carbon'

const openExistingEditor = async (page: Page) => {
  await page.goto(`/n/${EXISTING_NOTE}`)
  await page.getByRole('button', { name: 'Edit' }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
}

test('? opens the cheat sheet, Escape closes it', async ({ page }) => {
  await page.goto('/')
  await page.locator('body').click() // focus off any field
  await page.keyboard.press('Shift+Slash') // '?'
  await expect(page.getByTestId('cheatsheet')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('Quick switcher')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('cheatsheet')).toHaveCount(0)
})

test('g h / g g navigate; single keys do nothing while typing', async ({ page }) => {
  await page.goto('/s/main/feed')
  await page.locator('body').click()
  // `g` then `g` → Graph (the sequence completes within the timeout).
  await page.keyboard.press('g')
  await page.keyboard.press('g')
  await expect(page).toHaveURL(/\/s\/main\/graph$/)

  // A plain key typed into a field must NOT trigger its global action: focus the
  // topbar OmniSearch (present on the Feed) and type 'c' — it lands in the input,
  // no navigation happens. The inline search shows only on a wide topbar (#190), so
  // widen the viewport first.
  await page.setViewportSize({ width: 1800, height: 1000 })
  await page.goto('/s/main/feed')
  const omni = page.getByTestId('omni-search')
  await omni.click()
  await omni.fill('') // ensure focus
  await omni.press('c') // 'c' = New note globally
  await expect(omni).toHaveValue('c')
  await expect(page).toHaveURL(/\/s\/main\/feed/) // still feed — no new-note draft
})

test('t toggles the theme; [ toggles the left panel', async ({ page }) => {
  await page.goto('/')
  await page.locator('body').click()
  const html = page.locator('html')
  const before = await html.getAttribute('data-theme')
  await page.keyboard.press('t')
  await expect(html).not.toHaveAttribute('data-theme', before || 'dark')

  // '[' toggles the rail panel (the wide tree column) — assert it hides.
  await expect(page.getByTestId('tree-note').first()).toBeVisible()
  await page.keyboard.press('[')
  // The panel is hidden via CSS; the tree's notes are no longer visible.
  await expect(page.getByTestId('tree-note').first()).toBeHidden()
})

test('Cmd/Ctrl+P opens Spotlight from the central dispatcher', async ({ page }) => {
  await page.goto('/')
  await openSpotlight(page)
  await page.keyboard.press('Escape')
})

test('Cmd/Ctrl+S browser default is suppressed app-wide (not only while editing)', async ({
  page,
}) => {
  await page.goto('/')
  // A bubble listener reads defaultPrevented AFTER the capture dispatcher ran. Cmd+S is
  // bound to Save (editing) — an OWNED modifier chord, so its browser "save page" default
  // must be killed everywhere, even on the space home where there's nothing to save.
  await page.evaluate(() => {
    ;(window as unknown as { __sPrevented?: boolean }).__sPrevented = undefined
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') {
        ;(window as unknown as { __sPrevented?: boolean }).__sPrevented = e.defaultPrevented
      }
    })
  })
  await page.locator('body').click()
  await page.keyboard.press('Control+s')
  const prevented = await page.evaluate(
    () => (window as unknown as { __sPrevented?: boolean }).__sPrevented,
  )
  expect(prevented).toBe(true)
})

test('zone priority: an editor chord wins inside the editor, the global one wins outside', async ({
  page,
}) => {
  // Bind Cmd/Ctrl+D (default = editor multi-cursor) ALSO to "new note" (global), set
  // before load so it's active on first paint.
  await page.addInitScript(() => {
    localStorage.setItem(
      'bm-hotkey-overrides',
      JSON.stringify({ 'note.new': [[{ code: 'KeyD', mod: true }]] }),
    )
  })
  await page.goto('/')
  await waitForAppReady(page)

  // Outside the editor: Cmd/Ctrl+D creates a note (the global binding).
  await page.locator('body').click()
  await page.keyboard.press('Control+d')
  await expect(page).toHaveURL(/\?new=1$/)

  // Open the new draft's editor, type repeated words, and inside it Cmd/Ctrl+D must do
  // multi-cursor (the editor zone wins) — NOT create another note / navigate away.
  const body = page.locator('.cm-content')
  await body.click()
  await body.fill('# Zone test\n\nalpha alpha alpha')
  await page.keyboard.press('Control+d') // selects the word
  await page.keyboard.press('Control+d') // adds the next occurrence
  await expect(page).toHaveURL(/\?new=1$/) // still the same draft — no note created
  await expect(page.locator('.cm-selectionBackground')).toHaveCount(2) // two cursors
})

test('Settings → Keyboard: switching the preset rebinds an action', async ({ page }) => {
  await page.goto('/settings/keyboard')
  // Default (Notarium): toggle-left-panel is '['.
  const leftPanel = page.getByTestId('hotkey-row-view.leftPanel')
  await expect(leftPanel).toContainText('[')

  // Switch to VS Code → it becomes Cmd/Ctrl+B.
  await page.getByTestId('hotkey-preset-select').click()
  await page.getByRole('menuitemradio', { name: 'VS Code' }).click()
  await expect(leftPanel).toContainText('B')
  // Save draft picks up VS Code's Cmd/Ctrl+S.
  await expect(page.getByTestId('hotkey-row-editing.save')).toContainText('S')
})

test('Settings → Keyboard: recording adds a binding that applies live', async ({ page }) => {
  await page.goto('/settings/keyboard')
  const row = page.getByTestId('hotkey-row-view.theme')
  // Add a shortcut (the "+" recorder) and press a new key — it's appended.
  await row.getByRole('button', { name: /Add a shortcut/ }).click()
  await expect(row).toContainText('Press a key')
  await page.keyboard.press('y')
  await expect(row).toContainText('Y')

  // The new binding applies live: 'y' now toggles the theme.
  await page.locator('body').click()
  const html = page.locator('html')
  const before = await html.getAttribute('data-theme')
  await page.keyboard.press('y')
  await expect(html).not.toHaveAttribute('data-theme', before || 'dark')
})

for (const chord of ['Control+s', 'Control+Enter']) {
  test(`${chord} finishes a clean existing editor without a mutation`, async ({ page }) => {
    const before = await (await page.request.get(`/api/note?id=${EXISTING_NOTE}`)).json()
    const writes: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/note') {
        writes.push(request.url())
      }
    })
    await openExistingEditor(page)
    await page.keyboard.press(chord)
    await expect(page.locator('.cm-content')).toHaveCount(0)
    const after = await (await page.request.get(`/api/note?id=${EXISTING_NOTE}`)).json()

    expect(writes).toHaveLength(0)
    expect(after).toEqual(before)
  })
}

test('a custom editing.save binding has the same clean-finish semantics', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'bm-hotkey-overrides',
      JSON.stringify({
        'editing.save': [[{ code: 'KeyK', mod: true, shift: true }]],
      }),
    )
  })
  await openExistingEditor(page)
  await page.keyboard.press('Control+Shift+k')
  await expect(page.locator('.cm-content')).toHaveCount(0)
})

test('Save keeps a clean not-saveable new draft open', async ({ page }) => {
  await page.goto('/s/main?new=1')
  await expect(page.locator('.cm-content')).toBeVisible()
  await page.keyboard.press('Control+s')
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(page).toHaveURL(/\?new=1$/)
})

test('Save creates a valid new draft through the same action', async ({ page }) => {
  const writes: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      ['/api/note', '/api/s/main/notes'].includes(new URL(request.url()).pathname)
    ) {
      writes.push(request.url())
    }
  })
  await page.goto('/s/main?new=1')
  const editor = page.locator('.cm-content')
  await expect(editor).toBeVisible()
  await editor.fill('# Saved from the action\n\nA valid new document.')
  await page.keyboard.press('Control+s')

  await expect(page.getByRole('heading', { name: 'Saved from the action', level: 1 })).toBeVisible()
  expect(writes).toHaveLength(1)
})

test('Save preserves a dirty existing draft whose document is invalid', async ({ page }) => {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/note') {
      writes.push(request.url())
    }
  })
  await openExistingEditor(page)
  const editor = page.locator('.cm-content')
  await editor.fill('## No document title\n\nKeep this invalid draft.')
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  await page.keyboard.press('Control+s')

  await expect(editor).toContainText('Keep this invalid draft.')
  expect(writes).toHaveLength(0)
})

test('Save keeps a clean virtual folder page open without materializing it', async ({ page }) => {
  const writes: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname

    if (request.method() === 'POST' && (path === '/api/note' || path.endsWith('/folders/page'))) {
      writes.push(request.url())
    }
  })
  await page.goto('/')
  const demo = page.locator('[data-testid="tree-folder"][data-path="demo"]')
  await demo.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open page' }).click()
  await expect(page.getByTestId('virtual-folder-page')).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.cm-content')
  await expect(editor).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  await page.keyboard.press('Control+s')

  await expect(editor).toBeVisible()
  await expect(page).toHaveURL(/\/s\/main\/files\/demo$/)
  expect(writes).toHaveLength(0)
})

test('two Save actions in the same task produce one existing-note write', async ({ page }) => {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/note') {
      writes.push(request.url())
    }
  })
  await openExistingEditor(page)
  await page.locator('.cm-content').press('ControlOrMeta+End')
  await page.keyboard.insertText('\nSave once')
  await page.evaluate(() => {
    const save = () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 's',
          code: 'KeyS',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    save()
    save()
  })
  await expect(page.locator('.cm-content')).toHaveCount(0)
  expect(writes).toHaveLength(1)
})
