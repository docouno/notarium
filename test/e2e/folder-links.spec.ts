import { expect, test, waitForAppReady } from './fixtures'

// #214 [FOLDERS][C]: the breadcrumb trail and the tree's folder rows become a
// navigation surface — every ANCESTOR folder links to its page (durable
// `/folder/<id>` when identified, else `/files/<path>`), while the current leaf
// stays plain. One id-preferred rule (folderPageHref) drives both surfaces.

test('breadcrumb folder segments link to their page; the current leaf stays plain', async ({
  page,
}) => {
  await page.goto('/n/fake-demo-carbon')
  await waitForAppReady(page)

  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' })
  // The space crumb links to the space home.
  await expect(crumbs.getByRole('link', { name: 'Main', exact: true })).toHaveAttribute(
    'href',
    '/s/main',
  )
  // A plain, never-identified folder → its path route.
  await expect(crumbs.getByRole('link', { name: 'demo', exact: true })).toHaveAttribute(
    'href',
    '/s/main/files/demo',
  )
  // The current note is the last crumb — present, but never a link to itself.
  await expect(crumbs).toContainText('Carbon')
  await expect(crumbs.getByRole('link', { name: 'Carbon', exact: true })).toHaveCount(0)

  // Clicking a folder crumb navigates to that folder's (here virtual) page.
  await crumbs.getByRole('link', { name: 'demo', exact: true }).click()
  await expect(page).toHaveURL(/\/s\/main\/files\/demo$/)
  await expect(page.getByTestId('virtual-folder-page')).toBeVisible()
  // On the folder page the folder itself is the current crumb — no self-link.
  await expect(crumbs.getByRole('link', { name: 'demo', exact: true })).toHaveCount(0)
})

test('an identified folder crumb uses its durable /folder/<id>', async ({ page }) => {
  // Give `demo` a page — one of the acts that mint a folder-identity (#212). The
  // crumb must then prefer the durable permalink.
  const created = await page.request.post('/api/s/main/folders/page', {
    data: { folderPath: 'demo', content: '# demo\n\nOverview.' },
  })
  expect(created.status()).toBe(201)
  const { folderId } = await created.json()
  expect(folderId).toMatch(/^[A-Za-z0-9_-]{12}$/)

  await page.goto('/n/fake-demo-carbon')
  await waitForAppReady(page)
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' })
  const demoCrumb = crumbs.getByRole('link', { name: 'demo', exact: true })
  await expect(demoCrumb).toHaveAttribute('href', `/folder/${folderId}`)

  // The durable id resolves-and-redirects to the page note's body.
  await demoCrumb.click()
  await expect(page).toHaveURL(/\/n\/.+\/demo$/)
})

test('a folder row has a go-to-page action that navigates without toggling', async ({ page }) => {
  await page.goto('/')
  await waitForAppReady(page)

  const demoRow = page.locator('[data-testid="tree-folder"][data-path="demo"]')
  await expect(demoRow).toBeVisible()

  // The toggle control and the go-to-page action coexist on the row.
  await expect(demoRow.getByRole('button', { name: 'Toggle folder' })).toBeVisible()
  const goto = demoRow.getByTestId('folder-open-page')
  await expect(goto).toHaveAttribute('href', '/s/main/files/demo')

  // The go-to-page action must NOT double as the expand toggle — capture the row's
  // current expand state so we can prove the click left it untouched (a folder page
  // navigation never changes tree expansion — verified live).
  const expandedBefore = await demoRow.getAttribute('aria-expanded')
  expect(expandedBefore === 'true' || expandedBefore === 'false').toBe(true)

  // Hover reveals the (otherwise quiet) action; a real click navigates to the page.
  await demoRow.hover()
  await goto.click()
  await expect(page).toHaveURL(/\/s\/main\/files\/demo$/)
  await expect(page.getByTestId('virtual-folder-page')).toBeVisible()

  // No toggle: the row's expand state is exactly as it was before the click.
  await expect(page.locator('[data-testid="tree-folder"][data-path="demo"]')).toHaveAttribute(
    'aria-expanded',
    expandedBefore as string,
  )
})

test('a nested folder page opens its chain and the rest of the top level', async ({ page }) => {
  await page.goto('/s/main/files/archive/2020')
  await waitForAppReady(page)

  // Folder-page reveal opens ancestors, not the targeted folder itself.
  await expect(page.locator('[data-testid="tree-folder"][data-path="archive"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.locator('[data-testid="tree-folder"][data-path="archive/2020"]')).toBeVisible()

  // First-load seeding also expands the unrelated top-level branch.
  await expect(page.locator('[data-testid="tree-folder"][data-path="demo"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')).toBeVisible()
})

test('a late nested folder page stays revealed after the first root union', async ({ page }) => {
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_folderValue, folder) =>
      Array.from({ length: 5 }, (_noteValue, note) =>
        page.request.post('/api/s/main/notes', {
          data: {
            title: `Area ${folder + 1} note ${note + 1}`,
            directory: `area-${String(folder + 1).padStart(2, '0')}`,
            content: `# Area ${folder + 1} note ${note + 1}`,
          },
        }),
      ),
    ).flat(),
  )

  expect(responses.every((response) => response.ok())).toBe(true)
  const created = await page.request.post('/api/s/main/folders', {
    data: { path: 'zz-bottom/deep' },
  })

  expect(created.ok()).toBe(true)
  await page.goto('/s/main/files/zz-bottom/deep')
  await waitForAppReady(page)

  const target = page.locator('[data-testid="tree-folder"][data-path="zz-bottom/deep"]')

  await expect(target).toHaveAttribute('aria-current', 'page')
  await expect(target).toBeInViewport()
})

test('the folder whose page is the current surface is highlighted in the tree', async ({
  page,
}) => {
  const demoRow = () => page.locator('[data-testid="tree-folder"][data-path="demo"]')

  // A page-less folder's virtual /files page lights its own row (like an active note).
  await page.goto('/s/main/files/demo')
  await waitForAppReady(page)
  await expect(demoRow()).toHaveAttribute('aria-current', 'page')

  // A regular note under the folder does NOT light the folder — its own row is active.
  await page.goto('/n/fake-demo-carbon')
  await expect(demoRow()).not.toHaveAttribute('aria-current', 'page')

  // A page-bearing folder opens as its hidden index.md note (/n/<pageNoteId>) — that
  // note has no tree row, so the FOLDER lights instead of nothing.
  const created = await page.request.post('/api/s/main/folders/page', {
    data: { folderPath: 'demo', content: '# demo\n\nOverview.' },
  })
  expect(created.status()).toBe(201)
  const { pageNoteId } = await created.json()
  await page.goto(`/n/${pageNoteId}`)
  await expect(demoRow()).toHaveAttribute('aria-current', 'page')
})
