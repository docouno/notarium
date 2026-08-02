import { expect, test } from './fixtures'

// #65 — errors get owners and faces. Covers the three layers that used to share
// one global banner that rode every page:
//  - a missing note → a styled not-found STATE on its own /n/<id> URL (back works);
//  - an unknown URL → a real 404 page (not a silent bounce home);
//  - a failed action → a toast (not a sticky banner), the note left intact;
//  - a broken [[wiki link]] → the create-from-ghost flow (variant C), and a link
//    the cache hasn't loaded yet still OPENS its real note (resolve-first).

test('deep-link to a missing note shows a not-found state, and back still works', async ({
  page,
}) => {
  // Land somewhere real first so there's a history entry to go back to. Since #245
  // the feed is the merged Files section's default view, so the FILES icon lights.
  await page.goto('/s/main/feed')
  await expect(page.getByTestId('rail-files')).toHaveAttribute('aria-current', 'page')

  await page.goto('/n/does-not-exist-xyz')
  // A styled state, not a blank page or a raw banner.
  await expect(page.getByTestId('note-not-found')).toBeVisible()
  // The failed open kept its OWN url — so the browser back button is meaningful.
  await expect(page).toHaveURL(/\/n\/does-not-exist-xyz$/)

  await page.goBack()
  await expect(page).toHaveURL(/\/feed$/)
})

test('an unknown URL shows a 404 page instead of silently redirecting home', async ({ page }) => {
  await page.goto('/this/route/does/not/exist')
  await expect(page.getByTestId('page-not-found')).toBeVisible()

  await page.getByRole('button', { name: 'Go home' }).click()
  await expect(page).toHaveURL(/\/s\/main$/)
})

test('clicking a broken [[wiki link]] in the reader offers to create the note', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]').click()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)

  // Titanium's body links to [[Missing Element]] (no such note) and [[Carbon]]
  // (real). The ghost link routes to create; click it.
  const ghost = page.locator('.markdown a', { hasText: 'Missing Element' })
  await expect(ghost).toBeVisible()
  await ghost.click()

  // The create-from-ghost flow: a prefilled, immediately-saveable new draft whose
  // title slug-matches the link target so saving resolves it.
  // Body-first title (#156): the prefilled new note opens on its `# H1` title line.
  await expect(page.locator('.cm-content')).toContainText('# Missing Element')
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
})

test('create-from-link owns a URL: back/forward and reload restore the form', async ({ page }) => {
  await page.goto('/n/fake-demo-titanium')
  await page.locator('.markdown a', { hasText: 'Missing Element' }).click()

  // The draft is a real URL (?new…), not ephemeral state.
  // Body-first title (#156): the prefilled new note opens on its `# H1` title line.
  await expect(page.locator('.cm-content')).toContainText('# Missing Element')
  await expect(page).toHaveURL(/[?&]new=1/)

  // Back returns to the source note…
  await page.goBack()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toBeVisible()

  // …and forward restores the create form (the bug #2 was: it didn't).
  await page.goForward()
  await expect(page).toHaveURL(/[?&]new=1/)
  // Body-first title (#156): the prefilled new note opens on its `# H1` title line.
  await expect(page.locator('.cm-content')).toContainText('# Missing Element')

  // A reload of the create URL restores it too.
  await page.reload()
  // Body-first title (#156): the prefilled new note opens on its `# H1` title line.
  await expect(page.locator('.cm-content')).toContainText('# Missing Element')
})

test('a resolved [[wiki link]] opens its real note (resolve-first, no duplicate)', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]').click()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)

  // [[Carbon]] is a real note — clicking it navigates, never opens a create draft.
  await page.locator('.markdown a', { hasText: 'Carbon' }).click()
  await expect(page).toHaveURL(/\/n\/fake-demo-carbon\/carbon$/)
  await expect(page.locator('.cm-content')).toHaveCount(0) // read mode, not the editor
})

test('cold-loading a note shows its skeleton from the URL, never a flash of home', async ({
  page,
}) => {
  // Hold the note + tree responses so the loading phase is observable — the boot
  // used to flash the home Splash for the whole tree load before the reader showed.
  await page.route('**/api/note?id=*', async (route) => {
    await new Promise((r) => setTimeout(r, 700))
    await route.continue()
  })
  await page.route('**/api/s/*/tree', async (route) => {
    await new Promise((r) => setTimeout(r, 700))
    await route.continue()
  })

  await page.goto('/n/fake-demo-titanium')

  // The shell matches the destination immediately: a note skeleton in the reader
  // and a tree skeleton in the rail — NOT the empty default or the home splash.
  await expect(page.getByTestId('note-skeleton')).toBeVisible()
  await expect(page.getByTestId('tree-skeleton')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your knowledge base' })).toHaveCount(0)

  // …then the real content lands in place.
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toBeVisible()
})

test('a failed action surfaces a toast and leaves the note intact', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]').click()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)

  // Make the delete fail at the transport — the action must report it without
  // tearing down the open note.
  await page.route('**/api/note?id=*', (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'boom' }),
        })
      : route.continue(),
  )

  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitemradio', { name: 'Delete' }).click() // overflow-menu item
  await page.getByRole('button', { name: 'Delete' }).click() // confirm dialog

  await expect(page.getByTestId('toast')).toContainText('boom')
  // The note is still open — a failed delete didn't blank the reader.
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
})

test('a failed folder delete leaves an open note intact', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]').click()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)

  await page.route('**/api/s/*/folders?*', (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'folder boom' }),
        })
      : route.continue(),
  )

  await page.locator('[data-testid="tree-folder"][data-path="demo"]').click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete' }).click()

  await expect(page.getByTestId('toast')).toContainText('folder boom')
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toBeVisible()
  await expect(page.locator('[data-testid="tree-folder"][data-path="demo"]')).toBeVisible()
})
