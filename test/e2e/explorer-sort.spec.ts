import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ locale: 'sv-SE' })

const dated = (
  id: string,
  title: string,
  filePath: string,
  createdAt: string,
  modifiedAt: string,
  extra: Record<string, unknown> = {},
) => ({ id, title, filePath, createdAt, modifiedAt, content: `# ${title}`, ...extra })

const WORLD = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        dated(
          'fake-alpha',
          'Alpha',
          'sort-lab/alpha.md',
          '2026-01-01T00:00:00.000Z',
          '2026-01-07T00:00:00.000Z',
        ),
        dated(
          'fake-bravo',
          'Bravo',
          'sort-lab/bravo.md',
          '2026-01-09T00:00:00.000Z',
          '2026-01-05T00:00:00.000Z',
        ),
        dated(
          'fake-charlie',
          'Charlie',
          'sort-lab/charlie.md',
          '2026-01-05T00:00:00.000Z',
          '2026-01-09T00:00:00.000Z',
        ),
        dated(
          'fake-root-alpha',
          'Root Alpha',
          'root-alpha.md',
          '2026-01-01T00:00:00.000Z',
          '2026-01-07T00:00:00.000Z',
        ),
        dated(
          'fake-root-bravo',
          'Root Bravo',
          'root-bravo.md',
          '2026-01-09T00:00:00.000Z',
          '2026-01-05T00:00:00.000Z',
        ),
        dated(
          'fake-root-charlie',
          'Root Charlie',
          'root-charlie.md',
          '2026-01-05T00:00:00.000Z',
          '2026-01-09T00:00:00.000Z',
        ),
        dated(
          'fake-alpha-alpha-project',
          'alpha-alpha-project',
          '.notarium/memory/proj-main-alpha-project/alpha.md',
          '2026-01-01T00:00:00.000Z',
          '2026-01-07T00:00:00.000Z',
          { class: 'agent-memory', summary: 'Alpha project memory' },
        ),
        dated(
          'fake-bravo-alpha-project',
          'bravo-alpha-project',
          '.notarium/memory/proj-main-alpha-project/bravo.md',
          '2026-01-09T00:00:00.000Z',
          '2026-01-05T00:00:00.000Z',
          { class: 'agent-memory', summary: 'Bravo project memory' },
        ),
        dated(
          'fake-charlie-alpha-project',
          'charlie-alpha-project',
          '.notarium/memory/proj-main-alpha-project/charlie.md',
          '2026-01-05T00:00:00.000Z',
          '2026-01-09T00:00:00.000Z',
          { class: 'agent-memory', summary: 'Charlie project memory' },
        ),
        dated(
          'fake-alpha-zulu-project',
          'alpha-zulu-project',
          '.notarium/memory/proj-main-zulu-project/alpha.md',
          '2026-01-01T00:00:00.000Z',
          '2026-01-07T00:00:00.000Z',
          { class: 'agent-memory', summary: 'Alpha zulu memory' },
        ),
        dated(
          'fake-bravo-zulu-project',
          'bravo-zulu-project',
          '.notarium/memory/proj-main-zulu-project/bravo.md',
          '2026-01-09T00:00:00.000Z',
          '2026-01-05T00:00:00.000Z',
          { class: 'agent-memory', summary: 'Bravo zulu memory' },
        ),
        dated(
          'fake-charlie-zulu-project',
          'charlie-zulu-project',
          '.notarium/memory/proj-main-zulu-project/charlie.md',
          '2026-01-05T00:00:00.000Z',
          '2026-01-09T00:00:00.000Z',
          { class: 'agent-memory', summary: 'Charlie zulu memory' },
        ),
        dated(
          'fake-delta',
          'Delta',
          'target/delta.md',
          '2026-01-04T00:00:00.000Z',
          '2026-01-08T00:00:00.000Z',
        ),
        dated(
          'fake-alg',
          'Älg',
          'locale-lab/alg.md',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ),
        dated(
          'fake-angstrom',
          'Ångström',
          'locale-lab/angstrom.md',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ),
        dated(
          'fake-orebro',
          'Örebro',
          'locale-lab/orebro.md',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ),
        dated(
          'fake-zebra',
          'Zebra',
          'locale-lab/zebra.md',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ),
      ],
    },
    {
      slug: 'sam-personal',
      displayName: 'Personal',
      notes: [
        dated(
          'fake-memory-alpha',
          'alpha-memory',
          'alpha-memory.md',
          '2026-01-01T00:00:00.000Z',
          '2026-01-07T00:00:00.000Z',
          { class: 'agent-memory', summary: 'Alpha memory' },
        ),
        dated(
          'fake-memory-bravo',
          'bravo-memory',
          'bravo-memory.md',
          '2026-01-09T00:00:00.000Z',
          '2026-01-05T00:00:00.000Z',
          { class: 'agent-memory', summary: 'Bravo memory' },
        ),
        dated(
          'fake-memory-charlie',
          'charlie-memory',
          'charlie-memory.md',
          '2026-01-05T00:00:00.000Z',
          '2026-01-09T00:00:00.000Z',
          { class: 'agent-memory', summary: 'Charlie memory' },
        ),
      ],
    },
    {
      slug: 'work',
      displayName: 'Work',
      notes: [
        dated(
          'fake-work-alpha',
          'Work Alpha',
          'work-sort/alpha.md',
          '2026-01-01T00:00:00.000Z',
          '2026-01-03T00:00:00.000Z',
        ),
      ],
    },
  ],
  projects: [
    { space: 'main', path: 'zulu-project', slug: 'zulu-project', displayName: 'Zulu Project' },
    {
      space: 'main',
      path: 'alpha-project',
      slug: 'alpha-project',
      displayName: 'Alpha Project',
    },
  ],
  auth: {
    users: [
      {
        username: 'sam',
        password: 'sam-password-1',
        displayName: 'Sam',
        personalSpace: 'sam-personal',
      },
    ],
    members: [
      { space: 'main', username: 'sam', role: 'owner' },
      { space: 'sam-personal', username: 'sam', role: 'owner' },
      { space: 'work', username: 'sam', role: 'owner' },
    ],
  },
}

const ANCHOR_WORLD = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: Array.from({ length: 40 }, (_, index) => {
        const number = String(index + 1).padStart(2, '0')
        return dated(
          `fake-anchor-${number}`,
          `Anchor ${number}`,
          `anchor/anchor-${number}.md`,
          new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
          new Date(Date.UTC(2026, 1, 1, 0, 40 - index)).toISOString(),
        )
      }),
    },
  ],
  auth: {
    users: [{ username: 'sam', password: 'sam-password-1', displayName: 'Sam' }],
    members: [{ space: 'main', username: 'sam', role: 'owner' }],
  },
}

const login = async (page: Page) => {
  await page.goto('/')
  await page.getByTestId('auth-username').fill('sam')
  await page.getByTestId('auth-password').fill('sam-password-1')
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('auth-login')).not.toBeVisible()
}

const choose = async (page: Page, label: string) => {
  await page.getByTestId('explorer-sort').click()
  await page.getByRole('menuitemradio', { name: label, exact: true }).click()
}

const setOrder = async (page: Page, field: string, direction: string) => {
  await choose(page, field)
  await choose(page, direction)
}

const folderRows = (page: Page, folder: string) =>
  page.locator(`[data-drop-folder="${folder}"] [data-testid="tree-note"]`)

const titles = (rows: ReturnType<typeof folderRows>) =>
  rows.evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ''))

const expectTitles = async (rows: ReturnType<typeof folderRows>, expected: string[]) => {
  await expect.poll(() => titles(rows)).toEqual(expected)
}

const COMBINATIONS: Array<[string, string, string[]]> = [
  ['Name', 'Ascending', ['Alpha', 'Bravo', 'Charlie']],
  ['Name', 'Descending', ['Charlie', 'Bravo', 'Alpha']],
  ['Created', 'Ascending', ['Alpha', 'Charlie', 'Bravo']],
  ['Created', 'Descending', ['Bravo', 'Charlie', 'Alpha']],
  ['Modified', 'Ascending', ['Bravo', 'Alpha', 'Charlie']],
  ['Modified', 'Descending', ['Charlie', 'Alpha', 'Bravo']],
]

const dragNoteTo = async (page: Page, srcId: string, destinationId: string) => {
  await page.evaluate(
    ({ srcId: sourceId, destinationId: targetId }) => {
      const source = document.querySelector(
        `[data-testid="tree-note"][data-id="${sourceId}"]`,
      ) as HTMLElement
      const target = document.querySelector(`[data-testid="tree-note"][data-id="${targetId}"]`)
        ?.parentElement as HTMLElement

      if (!source || !target) {
        throw new Error('drag endpoints not mounted')
      }
      const transfer = new DataTransfer()
      const fire = (element: HTMLElement, type: string) =>
        element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        )

      fire(source, 'dragstart')
      fire(target, 'dragover')
      fire(target, 'drop')
      fire(source, 'dragend')
    },
    { srcId, destinationId },
  )
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: WORLD } })
  await page.addInitScript(() => {
    localStorage.setItem('bm-rail-w', '200')
  })
})

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
})

test('Files and Memory share all six orders, fixed Name collation and persisted state', async ({
  page,
}) => {
  await login(page)
  await page.goto('/s/main')
  const browserLocale = await page.evaluate(() => ({
    language: navigator.language,
    collatorLocale: new Intl.Collator().resolvedOptions().locale,
  }))

  expect(browserLocale.language).toBe('sv-SE')
  expect(browserLocale.collatorLocale).toMatch(/^sv(?:-|$)/i)
  const fileRows = folderRows(page, 'sort-lab')

  for (const [field, direction, expected] of COMBINATIONS) {
    await setOrder(page, field, direction)
    await expectTitles(fileRows, expected)
  }

  // Browser locale is sv-SE, but the product contract fixes Name to en-US. Hold
  // the authoritative response so this expectation observes the browser's
  // immediate local comparator, not the server result that follows it.
  const localeRows = folderRows(page, 'locale-lab')

  await setOrder(page, 'Name', 'Descending')
  await expectTitles(localeRows, ['Zebra', 'Örebro', 'Ångström', 'Älg'])
  let releaseLocale!: () => void
  const localeHeld = new Promise<void>((resolve) => {
    releaseLocale = resolve
  })
  const treePattern = '**/api/s/main/tree/children?**'
  const localeRequestFinished = page.waitForEvent('requestfinished', {
    predicate: (request) => {
      const url = new URL(request.url())

      return (
        url.pathname === '/api/s/main/tree/children' &&
        url.searchParams.get('path') === 'locale-lab' &&
        url.searchParams.get('sort') === 'title' &&
        url.searchParams.get('dir') === 'asc'
      )
    },
  })

  await page.route(treePattern, async (route) => {
    const url = new URL(route.request().url())

    if (
      url.searchParams.get('path') === 'locale-lab' &&
      url.searchParams.get('sort') === 'title' &&
      url.searchParams.get('dir') === 'asc'
    ) {
      await localeHeld
    }
    await route.continue()
  })
  await choose(page, 'Ascending')
  await expectTitles(localeRows, ['Älg', 'Ångström', 'Örebro', 'Zebra'])
  releaseLocale()
  await localeRequestFinished
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expectTitles(localeRows, ['Älg', 'Ångström', 'Örebro', 'Zebra'])
  await page.unroute(treePattern)

  // The single control still fits inside the header at the minimum 200px rail.
  const sortBox = await page.getByTestId('explorer-sort').boundingBox()
  const headBox = await page.getByTestId('panel-head').boundingBox()
  expect(sortBox).not.toBeNull()
  expect(headBox).not.toBeNull()
  expect(sortBox!.x + sortBox!.width).toBeLessThanOrEqual(headBox!.x + headBox!.width)

  await setOrder(page, 'Created', 'Descending')
  await page.reload()
  await expect(page.getByTestId('explorer-sort')).toHaveAttribute(
    'aria-label',
    'Sort explorer: Created, descending',
  )
  await expectTitles(folderRows(page, 'sort-lab'), ['Bravo', 'Charlie', 'Alpha'])

  await page.getByTestId('space-switcher').click()
  await page.getByText('Work', { exact: true }).click()
  await expect(page).toHaveURL(/\/s\/work$/)
  await expect(page.getByTestId('explorer-sort')).toHaveAttribute(
    'aria-label',
    'Sort explorer: Created, descending',
  )
  await page.getByTestId('space-switcher').click()
  await page.getByText('Main', { exact: true }).click()
  await expect(page).toHaveURL(/\/s\/main$/)

  await page.getByTestId('rail-agents').click()
  await expect(page.getByTestId('memory-tree')).toBeVisible()
  const memoryRows = page.getByTestId('memory-leaf')
  const memoryAxes = page.getByTestId('memory-axis')

  for (const [field, direction, expected] of COMBINATIONS) {
    await setOrder(page, field, direction)
    await expect(memoryAxes).toHaveText(['Personal', 'Alpha Project', 'Zulu Project'])
    await expect
      .poll(() => memoryRows.allTextContents())
      .toEqual([
        ...expected.map((title) => `${title.toLowerCase()}-memory`),
        ...expected.map((title) => `${title.toLowerCase()}-alpha-project`),
        ...expected.map((title) => `${title.toLowerCase()}-zulu-project`),
      ])
  }
})

test('root notes follow all six orders while root folders stay fixed', async ({ page }) => {
  await login(page)
  await page.goto('/s/main')
  const rootRows = folderRows(page, '')
  const rootFolders = page.locator('[data-testid="tree-folder"]:not([data-path*="/"])')
  const expectedRootFolders = ['alpha-project', 'locale-lab', 'sort-lab', 'target', 'zulu-project']

  for (const [field, direction, expected] of COMBINATIONS) {
    await setOrder(page, field, direction)
    await expectTitles(
      rootRows,
      expected.map((title) => `Root ${title}`),
    )
    await expect
      .poll(() =>
        rootFolders.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-path'))),
      )
      .toEqual(expectedRootFolders)
  }
})

test('the shared menu preserves keyboard continuity on Tab and activation', async ({ page }) => {
  await login(page)
  await page.goto('/s/main')
  const scope = page.getByTestId('explorer-scope')
  const menu = page.getByRole('menu')

  await scope.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('group', { name: 'Explorer scope' })).toBeVisible()
  await expect(page.getByRole('menuitemradio', { name: 'Files', exact: true })).toBeFocused()
  await expect(page.getByRole('menuitemradio', { name: 'Files', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.keyboard.press('Tab')
  await expect(menu).not.toBeVisible()
  await expect(page.getByTestId('explorer-sort')).toBeFocused()

  await scope.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitemradio', { name: 'Files', exact: true }).press('Enter')
  await expect(menu).not.toBeVisible()
  await expect(scope).toBeFocused()
})

test('the shared sort control stays available in every explorer scope', async ({ page }) => {
  await login(page)
  await page.goto('/s/main')
  const scope = page.getByTestId('explorer-scope')
  const sort = page.getByTestId('explorer-sort')

  await expect(scope).toHaveAttribute('data-scope', 'files')
  await expect(sort).toBeVisible()

  await scope.click()
  await page.getByRole('menuitemradio', { name: 'Favorites', exact: true }).click()
  await expect(scope).toHaveAttribute('data-scope', 'favorites')
  await expect(sort).toBeVisible()

  await scope.click()
  await page.getByRole('menuitemradio', { name: 'Projects', exact: true }).click()
  await expect(scope).toHaveAttribute('data-scope', 'projects')
  await expect(sort).toBeVisible()

  await page.locator('[data-testid="tree-folder"][data-path="alpha-project"]').click({
    button: 'right',
  })
  await page.getByRole('menuitem', { name: 'Focus project', exact: true }).click()
  await expect(scope).toHaveAttribute('data-scope', 'project')
  await expect(sort).toBeVisible()

  await scope.click()
  await page.getByRole('menuitemradio', { name: 'Memory', exact: true }).click()
  await expect(scope).toHaveAttribute('data-scope', 'memory')
  await expect(sort).toBeVisible()
})

test('a held reconciliation keeps real rows and the visible anchor during reorder', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: ANCHOR_WORLD } })
  await login(page)
  await page.goto('/s/main')
  const scroll = page.getByTestId('rail-scroll')
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(400)

  const anchor = await scroll.evaluate(async (element) => {
    // Start at the bottom so reversing the list moves the glass-line anchor
    // upward, where the browser has enough scroll range to keep its exact Y.
    // Anchoring at the other boundary would correctly clamp at maxScrollTop and
    // cannot preserve the row's screen position once that row moves farther down.
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const clearTop =
      element.getBoundingClientRect().top +
      (document.querySelector('[data-testid="panel-head"]')?.getBoundingClientRect().height ?? 0)
    const rows = [...element.querySelectorAll('[data-testid="tree-note"]')]
      .map((row) => ({
        id: row.getAttribute('data-id') ?? '',
        top: row.getBoundingClientRect().top,
        bottom: row.getBoundingClientRect().bottom,
      }))
      .filter((row) => row.bottom > clearTop)
      .sort((a, b) => a.top - b.top)
    return rows[0]
  })
  expect(anchor.id).toBeTruthy()

  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(/\/tree\/children\?.*sort=modified/, async (route) => {
    await held
    await route.continue()
  })
  await choose(page, 'Modified')

  // The cache is reordered synchronously: no skeleton/empty pass while the
  // matching server window is deliberately held.
  await expect.poll(() => page.locator('[data-testid="tree-note"]').count()).toBeGreaterThan(0)
  const anchoredRow = page.locator(`[data-testid="tree-note"][data-id="${anchor.id}"]`)
  await expect(anchoredRow).toBeVisible()
  await expect
    .poll(async () => (await anchoredRow.boundingBox())?.y ?? Number.NaN)
    .toBeCloseTo(anchor.top, 0)
  release()
})

test('an optimistic move keeps the active order and a point favorite follows it', async ({
  page,
}) => {
  await login(page)
  await page.request.put('/api/s/main/favorites', { data: { kind: 'note', id: 'fake-alpha' } })
  await page.goto('/s/main')
  await setOrder(page, 'Modified', 'Descending')

  let releaseMove!: () => void
  const heldMove = new Promise<void>((resolve) => {
    releaseMove = resolve
  })
  await page.route('**/api/move', async (route) => {
    await heldMove
    await route.continue()
  })
  const moved = page.waitForResponse(
    (response) => response.url().endsWith('/api/move') && response.request().method() === 'POST',
  )
  await dragNoteTo(page, 'fake-alpha', 'fake-delta')

  // Before the server can stamp the move with a new modifiedAt, the local
  // projection must already use the active ordering and keep real rows visible.
  try {
    await expectTitles(folderRows(page, 'target'), ['Delta', 'Alpha'])
  } finally {
    releaseMove()
  }
  expect((await moved).ok()).toBe(true)

  await page.getByTestId('rail-favorites').click()
  await expect(page.getByTestId('explorer-scope')).toHaveAttribute('data-scope', 'favorites')
  await expect(page.locator('[data-testid="tree-folder"][data-path="target"]')).toBeVisible()
  await expect(folderRows(page, 'target')).toHaveText(['Alpha'])
})

test('a rejected move rolls a point favorite back when its background reload fails', async ({
  page,
  baseURL,
}) => {
  await login(page)
  await page.goto('/s/main')
  await page.request.put('/api/s/main/favorites', { data: { kind: 'note', id: 'fake-alpha' } })
  await page.getByTestId('rail-favorites').click()
  await expect(folderRows(page, 'sort-lab')).toHaveText(['Alpha'])
  await page.getByTestId('rail-files').click()

  await page.route('**/api/s/main/favorites', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'favorites offline' }),
    })
  })

  let releaseMove!: () => void
  const heldMove = new Promise<void>((resolve) => {
    releaseMove = resolve
  })
  await page.route('**/api/move', async (route) => {
    await heldMove
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'move rejected' }),
    })
  })
  await dragNoteTo(page, 'fake-alpha', 'fake-delta')
  await expectTitles(folderRows(page, 'target'), ['Alpha', 'Delta'])
  releaseMove()
  await expect(page.getByTestId('toast')).toContainText('move rejected')
  await expectTitles(folderRows(page, 'sort-lab'), ['Alpha', 'Bravo', 'Charlie'])

  const failedReload = page.waitForResponse(
    (response) => response.url().endsWith('/api/s/main/favorites') && response.status() === 500,
  )
  const externalMove = await page.request.post(`${baseURL}/api/move`, {
    data: { id: 'fake-bravo', destinationPath: 'target/bravo.md' },
  })
  expect(externalMove.ok()).toBe(true)
  await failedReload

  await page.getByTestId('rail-favorites').click()
  await expect(page.getByTestId('explorer-scope')).toHaveAttribute('data-scope', 'favorites')
  await expect(folderRows(page, 'sort-lab')).toHaveText(['Alpha'])
  await expect(folderRows(page, 'target').filter({ hasText: 'Alpha' })).toHaveCount(0)
})
