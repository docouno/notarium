import { expect, openSpotlight, test, waitForAppReady } from './fixtures'

// Global hotkeys (#30): the central dispatcher + the `?` cheat sheet + the Settings
// editor (preset + per-action rebind). Single keys fire only outside text fields;
// `g`-sequences navigate; modifier chords work anywhere; the editor's formatting
// keymap is built from the same map. Runs against the fake backend (space `main`).

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
