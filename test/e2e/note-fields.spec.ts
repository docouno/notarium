import { type Page } from '@playwright/test'
import { test as base, expect } from './fixtures'

const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => window.localStorage.clear())
    await use(page)
  },
})

const WORLD = {
  now: '2026-08-22T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      fieldSchema: {
        version: 1,
        fields: [
          {
            key: 'status',
            label: 'Status',
            type: 'enum',
            card: true,
            values: [
              { key: 'todo', label: 'Todo', color: 'slate' },
              { key: 'doing', label: 'Doing', color: 'amber' },
            ],
          },
          { key: 'priority', label: 'Priority', type: 'number', card: true },
          { key: 'reviewers', label: 'Reviewers', type: 'list', card: true },
          { key: 'approved', label: 'Approved', type: 'checkbox' },
          { key: 'due', label: 'Due', type: 'date' },
          { key: 'client', label: 'Client', type: 'text' },
        ],
      },
      notes: [
        {
          id: 'field-note',
          title: 'Field note',
          filePath: 'board/field-note.md',
          content: '# Field note\n\nField values are edited with the document.',
          tags: ['planning', 'delivery', 'team', 'urgent', 'weekly'],
          frontmatter: [
            'status: doing',
            'priority: high',
            'type: task',
            'reviewers:',
            '- ann',
            '- bo',
            'approved: true',
            'due: 2026-09-01T10:00:00Z',
            "client: ''",
            'view: board',
          ].join('\n'),
          modifiedAt: '2026-08-22T10:00:00.000Z',
          createdAt: '2026-08-22T09:00:00.000Z',
        },
        {
          id: 'unsafe-field-note',
          title: 'Unsafe field note',
          filePath: 'board/unsafe-field-note.md',
          content: '# Unsafe field note\n\nReadable, but unsafe to rewrite.',
          frontmatter: 'template: &base x\nstatus: doing',
        },
      ],
    },
    {
      slug: 'research',
      displayName: 'Research',
      fieldSchema: {
        version: 1,
        fields: [
          {
            key: 'status',
            label: 'Research status',
            type: 'enum',
            values: [{ key: 'review', label: 'Review', color: 'violet' }],
          },
        ],
      },
      notes: [
        {
          id: 'research-note',
          title: 'Research note',
          filePath: 'research-note.md',
          content: '# Research note\n\nRead only for the current principal.',
          frontmatter: 'status: review',
        },
      ],
    },
  ],
  auth: {
    users: [
      { username: 'owner', password: 'owner-password-1' },
      { username: 'reader', password: 'reader-password-1' },
    ],
    members: [
      { space: 'main', username: 'owner', role: 'owner' as const },
      { space: 'research', username: 'owner', role: 'reader' as const },
      { space: 'main', username: 'reader', role: 'reader' as const },
    ],
  },
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: WORLD } })
})

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
})

const login = async (page: Page, username: string, password: string) => {
  await page.goto('/')
  await page.getByTestId('auth-username').fill(username)
  await page.getByTestId('auth-password').fill(password)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('auth-login')).not.toBeVisible()
}

const openMeta = async (page: Page, title: string) => {
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  const opener = page.getByRole('button', { name: 'Open panel' })

  if (await opener.isVisible()) {
    await opener.click()
  }
  await expect(page.getByTestId('aside-groups')).toBeVisible()
  await page.getByTestId('aside-tab-meta').click()
  await expect(page.getByTestId('meta-panel')).toBeVisible()
}

const javaScriptKey = (url: string) => {
  const parsed = new URL(url)

  return `${parsed.pathname}${parsed.search}`
}

const loadedJavaScript = async (page: Page): Promise<Set<string>> =>
  new Set(
    await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => new URL(entry.name))
        .filter((url) => url.pathname.endsWith('.js'))
        .map((url) => `${url.pathname}${url.search}`),
    ),
  )

const settleJavaScriptDemand = async (page: Page) => {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const response = await fetch('/api/me')

    if (!response.ok) {
      throw new Error(`UI settle request failed with ${response.status}`)
    }
  })
}

const holdExactJavaScript = async (page: Page, javaScript: ReadonlySet<string>) => {
  let open!: () => void
  let released = false
  const held = new Promise<void>((resolve) => {
    open = resolve
  })
  const requested = new Set<string>()

  await page.route(
    (url) => javaScript.has(javaScriptKey(url.href)),
    async (route) => {
      requested.add(javaScriptKey(route.request().url()))
      await held
      await route.continue()
    },
  )

  return {
    requested,
    release: () => {
      if (!released) {
        released = true
        open()
      }
    },
  }
}

test('all card fields render and custom values share quiet inline and editor controls', async ({
  page,
}) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/s/main/feed?sort=modified')

  const card = page.locator('[data-testid="feed-item"][data-id="field-note"]')
  const fieldChips = card.getByTestId('feed-field-chip')
  await expect(fieldChips).toHaveText(['Doing', 'high', 'ann, bo'])
  await expect(fieldChips.first()).not.toContainText('Status:')
  await expect(fieldChips.first()).toHaveRole('img')
  await expect(fieldChips.first()).toHaveAccessibleName('Status: Doing')
  await expect(fieldChips.first()).toHaveAttribute(
    'style',
    /--chip-solid: var\(--field-color-amber\)/,
  )
  await expect(card.locator('[class*="feed-tag"]')).toHaveCount(4)
  const cardMeta = await card
    .locator(
      '[data-testid="feed-date-chip"], [data-testid="feed-type-chip"], [data-testid="feed-field-chip"], [class*="tag-chip"]',
    )
    .allTextContents()
  expect(cardMeta).toEqual(['Aug 22, 2026', 'task', 'Doing', 'high', 'ann, bo'])

  await card.click()
  const detailMeta = page.getByTestId('note-detail-meta')
  await expect(detailMeta).toBeVisible()
  await expect(detailMeta.getByTestId('note-detail-field').first()).toHaveRole('img')
  await expect(detailMeta.getByTestId('note-detail-field').first()).toHaveAccessibleName(
    'Status: Doing',
  )
  expect(await detailMeta.locator(':scope > *').allTextContents()).toEqual([
    'Aug 22, 2026',
    'task',
    'Doing',
    'high',
    'ann, bo',
    '#planning',
    '#delivery',
    '#team',
    '#urgent',
    '#weekly',
  ])
  await openMeta(page, 'Field note')
  const meta = page.getByTestId('meta-panel')
  await expect(meta.locator('[data-field="Status"]')).toBeVisible()
  const inlineStatus = meta.getByRole('button', { name: 'Status value' })
  await expect(inlineStatus).toContainText('Doing')
  await expect(meta.locator('[data-field="Priority"]')).toContainText(
    'Does not match declared type',
  )
  await expect(meta.locator('[data-field="Client"]')).not.toContainText('Empty value')
  await expect(meta.locator('[data-field="Client"] input')).toHaveAttribute('placeholder', '—')
  const clientShell = meta.locator('[data-field="Client"] [data-testid="field-control-shell"]')
  const clientRemove = meta.getByRole('button', { name: 'Remove Client' })
  const [clientShellBox, clientRemoveBox] = await Promise.all([
    clientShell.boundingBox(),
    clientRemove.boundingBox(),
  ])
  expect(
    (clientRemoveBox?.x ?? 0) + (clientRemoveBox?.width ?? 0) <=
      (clientShellBox?.x ?? 0) + (clientShellBox?.width ?? 0),
  ).toBe(true)
  await expect(meta.locator('[data-field="view"] input')).toHaveCount(0)
  await expect(meta).not.toContainText('Read-only metadata')
  await expect(meta.locator('[data-field="Folder"]')).toHaveCount(0)
  const readOrder = await meta
    .locator('[data-field]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-field')))
  expect(readOrder[0]).toBe('Type')
  expect(readOrder.slice(-4)).toEqual(['Class', 'Created', 'Modified', 'Tags'])
  const alignedValueXs = await meta.evaluate((panel) => {
    const row = (name: string) => panel.querySelector(`[data-field="${name}"]`)!

    const inputTextX = (name: string) => {
      const input = row(name).querySelector('input')!
      return (
        input.getBoundingClientRect().x + Number.parseFloat(getComputedStyle(input).paddingLeft)
      )
    }
    const mismatch = [...row('Priority').querySelectorAll('span')].find(
      (element) => element.textContent === 'Does not match declared type',
    )!
    const dateLabel = [...row('Due').querySelectorAll('span')].find(
      (element) => element.children.length === 0 && element.textContent === 'Sep 1, 2026',
    )!

    return [
      row('Status').querySelector('button')!.getBoundingClientRect().x,
      inputTextX('Priority'),
      inputTextX('Client'),
      mismatch.getBoundingClientRect().x,
      row('Approved').querySelector('[role="switch"]')!.getBoundingClientRect().x,
      dateLabel.getBoundingClientRect().x,
    ]
  })
  expect(Math.max(...alignedValueXs) - Math.min(...alignedValueXs)).toBeLessThanOrEqual(1)
  await expect(meta.locator('[data-field]').first()).toHaveCSS('display', 'grid')
  await expect(meta.getByTestId('declared-fields')).toHaveCSS('border-top-width', '0px')
  const readTypeRow = meta.locator('[data-field="Type"]')
  const [readPanelBox, readRowBox] = await Promise.all([
    meta.boundingBox(),
    readTypeRow.boundingBox(),
  ])
  expect(Math.round((readRowBox?.x ?? 0) - (readPanelBox?.x ?? 0))).toBe(8)
  expect(
    Math.round(
      (readPanelBox?.x ?? 0) +
        (readPanelBox?.width ?? 0) -
        (readRowBox?.x ?? 0) -
        (readRowBox?.width ?? 0),
    ),
  ).toBe(8)
  const readIdleBackground = await readTypeRow.evaluate(
    (row) => getComputedStyle(row).backgroundColor,
  )
  await readTypeRow.hover()
  expect(await readTypeRow.evaluate((row) => getComputedStyle(row).backgroundColor)).not.toBe(
    readIdleBackground,
  )
  await expect(meta.getByTestId('undeclared-fields').locator('[data-field="status"]')).toHaveCount(
    0,
  )

  let pointWrites = 0
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/api/note/fields')) {
      pointWrites++
    }
  })
  const inlineBox = await inlineStatus.boundingBox()
  await expect(inlineStatus.locator('svg')).toHaveCSS('opacity', '1')
  await inlineStatus.hover()
  expect(await inlineStatus.boundingBox()).toEqual(inlineBox)
  const [selectLabelColor, selectChevronColor] = await inlineStatus.evaluate((button) => [
    getComputedStyle(button).color,
    getComputedStyle(button.querySelector('svg')!).color,
  ])
  expect(selectChevronColor).toBe(selectLabelColor)
  const pointSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/note/fields'),
  )
  await inlineStatus.click()
  await page.getByRole('menuitemradio', { name: 'Todo' }).click()
  expect((await pointSaved).status()).toBe(200)
  await expect(meta.getByRole('button', { name: 'Status value' })).toContainText('Todo')
  expect(pointWrites).toBe(1)
  const approved = meta.getByRole('switch', { name: 'Approved value' })
  await expect(approved).toBeChecked()
  const booleanSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/note/fields'),
  )
  await approved.click()
  expect((await booleanSaved).status()).toBe(200)
  await expect(meta.getByRole('switch', { name: 'Approved value' })).not.toBeChecked()
  expect(pointWrites).toBe(2)
  const due = meta.locator('[data-field="Due"] > div button').first()
  await expect(due).toContainText('Sep 1, 2026')
  await expect(due.locator(':scope > span')).toHaveCount(1)
  await expect(due.locator(':scope > span').first()).toHaveCSS('opacity', '1')
  await expect(meta.getByRole('button', { name: 'Clear Due value' })).toBeAttached()
  const dateSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/note/fields'),
  )
  await due.click()
  const calendar = page.getByRole('dialog', { name: 'Choose date' })
  await calendar.press('ArrowRight')
  await calendar.press('Enter')
  const dateResponse = await dateSaved
  expect(dateResponse.status()).toBe(200)
  expect(dateResponse.request().postDataJSON()).toMatchObject({
    fields: { due: '2026-09-02T10:00:00Z' },
  })
  await expect(meta.locator('[data-field="Due"] > div button').first()).toContainText('Sep 2, 2026')
  expect(pointWrites).toBe(3)

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.getByTestId('editor-meta')
  await expect(editor).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Clear Creation date' })).toHaveCount(0)
  await expect(editor.locator('[data-field="Folder"]')).toHaveCount(0)
  const editLabels = await editor
    .locator('[data-field], [class*="meta-field"]')
    .evaluateAll((rows) => rows.map((row) => row.textContent?.trim() ?? ''))
  expect(editLabels[0]).toMatch(/^Type/)
  await expect(editor.locator('[data-field]').first()).toHaveCSS('display', 'grid')
  await expect(editor.getByTestId('declared-fields')).toHaveCSS('border-top-width', '0px')
  const editTypeRow = editor.locator('[data-field="Type"]')
  const [editPanelBox, editRowBox] = await Promise.all([
    editor.boundingBox(),
    editTypeRow.boundingBox(),
  ])
  expect(Math.round((editRowBox?.x ?? 0) - (editPanelBox?.x ?? 0))).toBe(8)
  expect(
    Math.round(
      (editPanelBox?.x ?? 0) +
        (editPanelBox?.width ?? 0) -
        (editRowBox?.x ?? 0) -
        (editRowBox?.width ?? 0),
    ),
  ).toBe(8)
  const editIdleBackground = await editTypeRow.evaluate(
    (row) => getComputedStyle(row).backgroundColor,
  )
  await editTypeRow.hover()
  expect(await editTypeRow.evaluate((row) => getComputedStyle(row).backgroundColor)).not.toBe(
    editIdleBackground,
  )

  const status = editor.getByRole('button', { name: 'Status value' })
  await status.click()
  await page.getByRole('menuitemradio', { name: 'Doing' }).click()
  await editor.getByRole('button', { name: 'Remove ann' }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/note'),
  )
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const savedResponse = await saved
  expect(savedResponse.status()).toBe(200)
  expect(savedResponse.request().postDataJSON()).toMatchObject({
    fields: { status: 'doing', reviewers: ['bo'] },
  })
  expect(pointWrites).toBe(3)

  const changed = (await (await page.request.get('/api/note?id=field-note')).json()) as {
    frontmatter: Record<string, unknown>
  }
  expect(changed.frontmatter.status).toBe('doing')
  expect(changed.frontmatter.reviewers).toEqual(['bo'])
  expect(changed.frontmatter.approved).toBe('false')
  expect(changed.frontmatter.due).toBe('2026-09-02T10:00:00Z')

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByTestId('editor-meta').getByRole('button', { name: 'Status value' }).click()
  await page.getByRole('menuitemradio', { name: 'None' }).click()
  const removed = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/note'),
  )
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await removed).status()).toBe(200)
  const afterRemove = (await (await page.request.get('/api/note?id=field-note')).json()) as {
    frontmatter: Record<string, unknown>
  }
  expect(afterRemove.frontmatter.status).toBeUndefined()
  expect(pointWrites).toBe(3)
})

test('a note-space reader gets that space schema without write affordances', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/n/research-note')
  await openMeta(page, 'Research note')

  const row = page.getByTestId('meta-panel').locator('[data-field="Research status"]')
  await expect(row).toContainText('Review')
  await expect(row.locator('input, button')).toHaveCount(0)
  await expect(page.getByTestId('meta-panel').locator('[data-field="Status"]')).toHaveCount(0)
})

test('a readable YAML-anchor document exposes custom fields read-only before write', async ({
  page,
}) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/n/unsafe-field-note')
  await openMeta(page, 'Unsafe field note')

  const meta = page.getByTestId('meta-panel')
  await expect(meta.getByTestId('field-schema-warning')).toContainText('YAML anchors or aliases')
  await expect(
    meta.locator('[data-field="Status"] input, [data-field="Status"] button'),
  ).toHaveCount(0)

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.getByTestId('editor-meta')
  await expect(editor.getByTestId('field-schema-warning')).toContainText('YAML anchors or aliases')
  await expect(
    editor.locator('[data-field="Status"] input, [data-field="Status"] button'),
  ).toHaveCount(0)
})

test('a reader sees unsafe field values without an irrelevant editing warning', async ({
  page,
}) => {
  await login(page, 'reader', 'reader-password-1')
  await page.goto('/n/unsafe-field-note')
  await openMeta(page, 'Unsafe field note')

  const meta = page.getByTestId('meta-panel')

  await expect(meta.getByTestId('field-schema-warning')).toHaveCount(0)
  await expect(meta.locator('[data-field="Status"]')).toContainText('Doing')
  await expect(
    meta.locator('[data-field="Status"] input, [data-field="Status"] button'),
  ).toHaveCount(0)
})

test('schema read-only management does not disable allowed value writes', async ({ page }) => {
  await page.route('**/api/s/main/fields/schema', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>

    await route.fulfill({
      response,
      json: {
        ...body,
        readOnly: true,
        valueWrites: true,
        error: 'schema version 2 is newer than supported version 1',
      },
    })
  })
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/n/field-note')
  await openMeta(page, 'Field note')

  await expect(page.getByTestId('meta-panel').getByTestId('field-schema-warning')).toContainText(
    'newer than supported',
  )
  const status = page.getByTestId('meta-panel').getByRole('button', { name: 'Status value' })
  await expect(status).toBeEnabled()
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/note/fields'),
  )
  await status.click()
  await page.getByRole('menuitemradio', { name: 'Todo' }).click()
  expect((await saved).status()).toBe(200)
})

test('editor save shortcut owns focused text and an uncommitted list item', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/n/field-note')
  await openMeta(page, 'Field note')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.getByTestId('editor-meta')
  await editor.getByRole('textbox', { name: 'Client value' }).fill('Shortcut client')
  const reviewers = editor.getByRole('textbox', { name: 'Reviewers value' })
  await reviewers.fill('carol')
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/note'),
  )
  await reviewers.press('ControlOrMeta+Enter')
  const response = await saved

  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON()).toMatchObject({
    fields: { client: 'Shortcut client', reviewers: ['ann', 'bo', 'carol'] },
  })
})

test('@spa-load-size lazy editor preserves metadata focus and accepts Save before its body resolves', async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) {
    throw new Error('chromium-auth baseURL is required')
  }

  await login(page, 'owner', 'owner-password-1')
  await page.goto('/n/field-note')
  await openMeta(page, 'Field note')
  await settleJavaScriptDemand(page)
  await page.evaluate(() => performance.clearResourceTimings())
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await settleJavaScriptDemand(page)
  const discoveredEditorJavaScript = await loadedJavaScript(page)

  expect(discoveredEditorJavaScript.size).toBeGreaterThan(0)

  const focusContext = await browser.newContext({ baseURL })
  await focusContext.addInitScript(() => window.localStorage.clear())
  const focusPage = await focusContext.newPage()
  const focusGate = await holdExactJavaScript(focusPage, discoveredEditorJavaScript)

  try {
    await login(focusPage, 'owner', 'owner-password-1')
    await focusPage.goto('/n/field-note')
    await openMeta(focusPage, 'Field note')
    await settleJavaScriptDemand(focusPage)
    expect(focusGate.requested.size).toBe(0)

    await focusPage.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(focusPage.getByTestId('editor-loading-skeleton')).toBeVisible()
    await expect
      .poll(() => [...focusGate.requested].sort())
      .toEqual([...discoveredEditorJavaScript].sort())

    const client = focusPage
      .getByTestId('editor-meta')
      .getByRole('textbox', { name: 'Client value' })
    await client.fill('Focus stays here')
    await expect(client).toBeFocused()
    focusGate.release()
    await expect(focusPage.locator('.cm-content')).toBeVisible()
    await expect(client).toBeFocused()
    await focusPage.keyboard.type(' after resolve')
    await expect(client).toHaveValue('Focus stays here after resolve')
  } finally {
    focusGate.release()
    await focusContext.close()
  }

  const saveContext = await browser.newContext({ baseURL })
  await saveContext.addInitScript(() => window.localStorage.clear())
  const savePage = await saveContext.newPage()
  const saveGate = await holdExactJavaScript(savePage, discoveredEditorJavaScript)

  try {
    await login(savePage, 'owner', 'owner-password-1')
    await savePage.goto('/n/field-note')
    await openMeta(savePage, 'Field note')
    await settleJavaScriptDemand(savePage)
    expect(saveGate.requested.size).toBe(0)

    await savePage.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(savePage.getByTestId('editor-loading-skeleton')).toBeVisible()
    await expect
      .poll(() => [...saveGate.requested].sort())
      .toEqual([...discoveredEditorJavaScript].sort())

    const editorMeta = savePage.getByTestId('editor-meta')
    await editorMeta.getByRole('textbox', { name: 'Client value' }).fill('Shortcut client')
    const reviewers = editorMeta.getByRole('textbox', { name: 'Reviewers value' })
    await reviewers.fill('carol')
    const saved = savePage.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/api/note'),
    )
    await reviewers.press('ControlOrMeta+Enter')
    const response = await saved

    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toMatchObject({
      fields: { client: 'Shortcut client', reviewers: ['ann', 'bo', 'carol'] },
    })
  } finally {
    saveGate.release()
    await saveContext.close()
  }
})

test('a cached editor draft swap restores focus to the fresh title line', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/n/field-note')
  await expect(page.getByRole('heading', { level: 1, name: 'Field note' })).toBeVisible()
  await page.getByTestId('rail-settings').click()
  await page.getByTestId('settings-tab-keyboard').click()
  await page
    .getByTestId('hotkey-row-note.new')
    .getByRole('button', { name: 'Add a shortcut' })
    .click()
  await page.keyboard.press('ControlOrMeta+d')
  await page.goBack()
  await page.goBack()
  await openMeta(page, 'Field note')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  const client = page.getByTestId('editor-meta').getByRole('textbox', { name: 'Client value' })
  await client.focus()
  await expect(client).toBeFocused()
  await client.press('ControlOrMeta+d')

  await expect(page).toHaveURL(/\?new=1/)
  const freshEditor = page.locator('.cm-content')
  await expect(freshEditor).toBeFocused()
  await page.keyboard.type('Fresh title')
  await expect(freshEditor).toContainText('# Fresh title')
})

test('schema transport failure keeps custom controls read-only but allows body-only Edit', async ({
  page,
}) => {
  await page.route('**/api/s/main/fields/schema', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down"}' }),
  )
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/n/field-note')
  await openMeta(page, 'Field note')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const meta = page.getByTestId('editor-meta')

  await expect(meta.getByTestId('field-schema-warning')).toBeVisible()
  await expect(
    meta.locator('[data-field="Status"] input, [data-field="Status"] button'),
  ).toHaveCount(0)
  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('# Field note\n\nBody-only save survives schema transport failure.')
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/note'),
  )
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  expect((await saved).status()).toBe(200)
})

test('a successful document Save reports a failed in-place refresh honestly', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/n/field-note')
  await openMeta(page, 'Field note')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page
    .getByTestId('editor-meta')
    .getByRole('textbox', { name: 'Client value' })
    .fill('Saved before refresh failure')
  let failRefresh = true
  await page.route('**/api/note?id=field-note', async (route) => {
    if (failRefresh && route.request().method() === 'GET') {
      failRefresh = false
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"down"}',
      })
      return
    }
    await route.continue()
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(
    page.getByText('Note was saved, but the latest version could not be refreshed.'),
  ).toBeVisible()
})

test('an open detail follows another tab field write through SSE', async ({ page, context }) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/n/field-note')
  await openMeta(page, 'Field note')
  const observer = page.getByTestId('meta-panel').locator('[data-field="Client"] input')
  const writer = await context.newPage()

  await writer.goto('/n/field-note')
  await openMeta(writer, 'Field note')
  const saved = writer.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/note/fields'),
  )
  const input = writer.getByTestId('meta-panel').locator('[data-field="Client"] input')

  await input.fill('Changed in another tab')
  await input.press('Tab')
  expect((await saved).status()).toBe(200)
  await expect(observer).toHaveValue('Changed in another tab')
  await writer.close()
})

test('an inline conflict adopts server truth and the next edit converges', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/n/field-note')
  await openMeta(page, 'Field note')
  const before = (await (await page.request.get('/api/note?id=field-note')).json()) as {
    versionToken: string
  }
  const concurrent = await page.request.put('/api/note/fields', {
    data: {
      id: 'field-note',
      versionToken: before.versionToken,
      fields: { client: 'Remote client' },
    },
  })
  expect(concurrent.ok()).toBe(true)
  const status = page.getByTestId('meta-panel').getByRole('button', { name: 'Status value' })
  const conflict = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/note/fields'),
  )
  await status.click()
  await page.getByRole('menuitemradio', { name: 'Todo' }).click()
  expect((await conflict).status()).toBe(409)
  await expect(status).toContainText('Doing')
  await expect(page.getByTestId('meta-panel').locator('[data-field="Client"] input')).toHaveValue(
    'Remote client',
  )

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/note/fields'),
  )
  await status.click()
  await page.getByRole('menuitemradio', { name: 'Todo' }).click()
  expect((await saved).status()).toBe(200)
  await expect(status).toContainText('Todo')
})
