import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const WORLD = {
  now: '2026-08-21T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          id: 'field-note',
          title: 'Field note',
          filePath: 'field-note.md',
          content: '# Field note\n\nCarries an undeclared status.',
          frontmatter: 'status: backlog',
        },
      ],
    },
    {
      slug: 'other',
      displayName: 'Other',
      notes: [],
      fieldSchema: { version: 1, fields: [] },
    },
  ],
  auth: {
    users: [
      { username: 'owner', password: 'owner-password-1' },
      { username: 'reader', password: 'reader-password-1' },
    ],
    members: [
      { space: 'main', username: 'owner', role: 'owner' as const },
      { space: 'other', username: 'owner', role: 'owner' as const },
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

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const valueOrder = async (page: Page) =>
  page
    .getByTestId('field-value')
    .evaluateAll((rows) =>
      rows.map(
        (row) =>
          row.querySelector<HTMLElement>('[data-testid="field-value-label"]')?.textContent ?? '',
      ),
    )

const fieldOrder = async (page: Page) =>
  page
    .getByTestId('field-row')
    .evaluateAll((rows) =>
      rows.map(
        (row) => row.querySelector<HTMLElement>('[data-testid="field-name"]')?.textContent ?? '',
      ),
    )

const boxOf = async (locator: ReturnType<Page['locator']>) => {
  const box = await locator.boundingBox()

  expect(box).not.toBeNull()
  return box!
}

const centerY = (box: { y: number; height: number }) => box.y + box.height / 2

const fieldsActionLift = (page: Page) =>
  page.getByTestId('fields-actions').evaluate((node) => {
    const raw = node.style.getPropertyValue('--glass-lift')
    return raw === '' ? -1 : Number(raw)
  })

const dragBefore = async (
  page: Page,
  sourceTestId: string,
  sourceText: string,
  targetTestId: string,
  targetText: string,
) => {
  const source = page.getByTestId(sourceTestId).filter({ hasText: sourceText })
  const target = page.getByTestId(targetTestId).filter({ hasText: targetText })
  const sourceHandle = await source.elementHandle()
  const targetHandle = await target.elementHandle()

  expect(sourceHandle).not.toBeNull()
  expect(targetHandle).not.toBeNull()
  await page.evaluate(
    ([from, to]) => {
      const dataTransfer = new DataTransfer()
      const fire = (element: Element, type: string, clientY = 0) =>
        element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientY }),
        )
      const targetBox = to.getBoundingClientRect()

      fire(from, 'dragstart')
      fire(to, 'dragover', targetBox.top + 1)
      fire(to, 'drop', targetBox.top + 1)
      fire(from, 'dragend')
    },
    [sourceHandle!, targetHandle!] as const,
  )
}

test('a writer declares an enum, orders it by keyboard and mouse, and keeps a conflict draft', async ({
  page,
}) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/s/main/management/fields')

  await expect(page.getByTestId('fields-section')).toBeVisible()
  await expect(page.getByTestId('settings-tab-fields')).toBeVisible()
  await page.getByTestId('fields-add').click()
  const field = page.getByTestId('field-row')
  await expect(field.getByTestId('field-row-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(field.getByTestId('field-name-error')).toHaveCount(0)
  await expect(field.getByTestId('field-key-input')).toHaveCount(0)
  await expect(page.getByTestId('fields-reset')).toBeVisible()
  expect(await page.getByTestId('fields-actions').evaluate((node) => [...node.classList])).toEqual(
    expect.arrayContaining(['glass', 'glass-scroll', 'glass-edge-top']),
  )
  const actionPanelShape = await page.getByTestId('fields-actions').evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      classes: [...node.classList],
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      topLeftRadius: style.borderTopLeftRadius,
      topRightRadius: style.borderTopRightRadius,
      bottomLeftRadius: style.borderBottomLeftRadius,
      bottomRightRadius: style.borderBottomRightRadius,
    }
  })
  expect.soft(actionPanelShape.classes).toEqual(expect.arrayContaining(['glass-panel']))
  expect.soft(actionPanelShape.paddingLeft).toBe('12px')
  expect.soft(actionPanelShape.paddingRight).toBe('12px')
  expect.soft(actionPanelShape.topLeftRadius).not.toBe('0px')
  expect.soft(actionPanelShape.topRightRadius).not.toBe('0px')
  expect.soft(actionPanelShape.bottomLeftRadius).toBe('0px')
  expect.soft(actionPanelShape.bottomRightRadius).toBe('0px')
  const [actionPanelBox, fieldBox, addButtonBox, saveButtonBox] = await Promise.all([
    boxOf(page.getByTestId('fields-actions')),
    boxOf(field),
    boxOf(page.getByTestId('fields-add')),
    boxOf(page.getByTestId('fields-save')),
  ])
  expect.soft(fieldBox.x - actionPanelBox.x).toBeCloseTo(12, 1)
  expect
    .soft(actionPanelBox.x + actionPanelBox.width - (fieldBox.x + fieldBox.width))
    .toBeCloseTo(12, 1)
  expect.soft(Math.abs(addButtonBox.x - fieldBox.x)).toBeLessThanOrEqual(1.1)
  expect
    .soft(Math.abs(saveButtonBox.x + saveButtonBox.width - (fieldBox.x + fieldBox.width)))
    .toBeLessThanOrEqual(1.1)
  await expect.poll(() => fieldsActionLift(page)).toBe(0)

  await field.getByTestId('field-label-input').fill('Status')
  await field.getByTestId('field-type-select').click()
  await page.getByRole('menuitemradio', { name: 'Enum' }).click()
  const enumAdd = field.getByTestId('enum-add-value')
  await expect(field.getByTestId('enum-values-empty')).toContainText('No values yet')
  await expect(field.getByTestId('enum-values-empty')).toContainText('An empty catalog is valid.')
  await expect(enumAdd).toHaveAccessibleName('Add value')
  await expect(enumAdd).toHaveAttribute('title', 'Add value')
  await expect(enumAdd).toHaveText('')
  await field.getByText('Show on note cards', { exact: true }).click()

  for (const [value, color] of [
    ['Backlog', 'slate'],
    ['Doing', 'amber'],
    ['Done', 'green'],
  ] as const) {
    await field.getByTestId('enum-add-value').click()
    const row = field.getByTestId('field-value').last()
    await row.getByTestId('field-value-label-input').fill(value)
    await row.getByTestId(`field-value-color-${color}`).click()
  }

  const contentScroll = page.getByTestId('content-scroll')
  await contentScroll.evaluate((node) => node.scrollTo({ top: 0 }))
  expect(
    await contentScroll.evaluate((node) => node.scrollHeight - node.clientHeight),
  ).toBeGreaterThan(0)
  await expect.poll(() => fieldsActionLift(page)).toBeGreaterThan(0.9)
  await contentScroll.evaluate((node) => node.scrollTo({ top: node.scrollHeight }))
  await expect.poll(() => fieldsActionLift(page)).toBe(0)

  const done = field.getByTestId('field-value').filter({ hasText: 'Done' })
  const doneGrip = done.getByRole('button', { name: 'Reorder item' })
  await doneGrip.focus()
  await doneGrip.press('ArrowUp')
  expect(await valueOrder(page)).toEqual(['Backlog', 'Done', 'Doing'])

  await dragBefore(page, 'field-value', 'Doing', 'field-value', 'Backlog')
  expect(await valueOrder(page)).toEqual(['Doing', 'Backlog', 'Done'])

  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/s/main/fields/schema'),
  )
  await page.getByTestId('fields-save').click()
  expect((await saveResponse).status()).toBe(200)

  const stored = await page.request.get('/api/s/main/fields/schema')
  expect(stored.ok()).toBe(true)
  let schema = (await stored.json()) as {
    fields: Array<{
      key: string
      type: string
      label?: string
      card?: boolean
      values?: Array<{ key: string; label?: string; color?: string }>
    }>
    versionToken: string
  }
  expect(schema.fields[0]).toEqual({
    key: 'status',
    type: 'enum',
    label: 'Status',
    card: true,
    values: [
      { key: 'doing', label: 'Doing', color: 'amber' },
      { key: 'backlog', label: 'Backlog', color: 'slate' },
      { key: 'done', label: 'Done', color: 'green' },
    ],
  })
  await expect(field.getByTestId('field-row-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(field).toContainText('Status')
  await expect(field.getByText('status', { exact: true })).toHaveCount(0)
  await expect(field).toContainText('Shown on cards')
  await expect(page.getByTestId('fields-reset')).toHaveCount(0)
  await field.getByTestId('field-row-toggle').click()
  await expect(field.getByTestId('field-key-input')).toHaveCount(0)
  await expect(field.getByText('Frontmatter key', { exact: true })).toHaveCount(0)
  const persistedDoing = field.getByTestId('field-value').filter({ hasText: 'Doing' })
  const [nameBox, typeBox, fieldToggleBox, fieldMenuBox, cardControlBox, checkboxBox] =
    await Promise.all([
      boxOf(field.getByTestId('field-label-input')),
      boxOf(field.getByTestId('field-type-select')),
      boxOf(field.getByTestId('field-row-toggle')),
      boxOf(field.getByTestId('field-actions-menu')),
      boxOf(field.getByTestId('field-card-control')),
      boxOf(field.getByTestId('field-card-control').locator('label')),
    ])
  const [valueToggleBox, valueRemoveBox] = await Promise.all([
    boxOf(persistedDoing.getByRole('button', { name: 'Doing amber' })),
    boxOf(persistedDoing.getByTestId('enum-value-remove')),
  ])

  expect.soft(nameBox.height).toBe(typeBox.height)
  expect.soft(Math.abs(centerY(fieldToggleBox) - centerY(fieldMenuBox))).toBeLessThanOrEqual(0.5)
  expect.soft(checkboxBox.y - cardControlBox.y).toBeLessThanOrEqual(0.5)
  expect.soft(Math.abs(centerY(valueToggleBox) - centerY(valueRemoveBox))).toBeLessThanOrEqual(0.5)
  await persistedDoing.getByRole('button', { name: 'Doing amber' }).click()
  await expect(persistedDoing.getByTestId('field-value-label-input')).toHaveValue('Doing')
  await expect(persistedDoing).toContainText('The stored key and note files stay unchanged')
  await persistedDoing.getByTestId('field-value-label-input').fill('In progress')
  await page.getByTestId('fields-save').click()
  schema = (await (await page.request.get('/api/s/main/fields/schema')).json()) as typeof schema
  expect(schema.fields[0].values).toEqual([
    { key: 'doing', label: 'In progress', color: 'amber' },
    { key: 'backlog', label: 'Backlog', color: 'slate' },
    { key: 'done', label: 'Done', color: 'green' },
  ])
  const unchangedNote = (await (await page.request.get('/api/note?id=field-note')).json()) as {
    frontmatter: Record<string, unknown>
  }
  expect(unchangedNote.frontmatter.status).toBe('backlog')
  await field.getByTestId('field-row-toggle').click()

  await expect(field.getByTestId('field-row-toggle')).toContainText('1 note')
  await field.getByTestId('field-type-select').click()
  await page.getByRole('menuitemradio', { name: 'Number' }).click()
  await expect(field).toContainText('Saving this type change affects 1 note')
  await page.getByTestId('fields-save').click()
  await expect(page.getByRole('heading', { name: 'Save field type changes?' })).toBeVisible()
  await expect(page.getByText(/Affected fields: Status \(1 note\)/)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('fields-reset')).toBeVisible()
  await page.getByTestId('fields-reset').click()
  await field.getByTestId('field-row-toggle').click()

  await field.getByTestId('field-label-input').fill('Local label')
  const concurrent = await page.request.put('/api/s/main/fields/schema', {
    data: {
      version: 1,
      fields: [...schema.fields, { key: 'remote', type: 'text' }],
      versionToken: schema.versionToken,
    },
  })
  expect(concurrent.ok()).toBe(true)
  await page.getByTestId('fields-save').click()
  await expect(page.getByTestId('fields-conflict')).toContainText('Your draft is still here')
  await expect(field.getByTestId('field-label-input')).toHaveValue('Local label')
  await expect(page.getByTestId('fields-save')).toBeDisabled()
  const conflicted = (await (await page.request.get('/api/s/main/fields/schema')).json()) as {
    fields: Array<{ key: string; type: string; label?: string }>
  }
  expect(conflicted.fields).toContainEqual({ key: 'remote', type: 'text' })
  expect(conflicted.fields.find((declaration) => declaration.key === 'status')?.label).toBe(
    'Status',
  )

  await page.getByTestId('fields-conflict-reload').click()
  await expect(page.getByTestId('field-row').filter({ hasText: 'Remote' })).toBeVisible()
  const reloadedStatus = page.getByTestId('field-row').filter({ hasText: 'Status' }).first()
  await reloadedStatus.getByTestId('field-row-toggle').click()
  await expect(reloadedStatus.getByTestId('field-label-input')).toHaveValue('Status')
})

test('human names are unique only in their owning scope', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/s/main/management/fields')

  await page.getByTestId('fields-add').click()
  await expect(page.getByTestId('field-row')).toHaveCount(1)
  const rows = page.getByTestId('field-row')
  const status = rows.nth(0)
  await status.getByTestId('field-label-input').fill('Status')
  await page.getByTestId('fields-add').click()
  await expect(rows).toHaveCount(2)
  const resolution = rows.nth(1)
  await resolution.getByTestId('field-label-input').fill(' status ')
  await expect(resolution.getByTestId('field-name-error')).toContainText(
    'Field name already exists',
  )
  const duplicateFieldInput = resolution.getByTestId('field-label-input')
  await expect(duplicateFieldInput).toHaveAttribute('aria-invalid', 'true')
  const fieldErrorId = await duplicateFieldInput.getAttribute('aria-describedby')
  expect(fieldErrorId).toBeTruthy()
  await expect(page.locator(`[id="${fieldErrorId}"]`)).toContainText('Field name already exists')
  await expect(page.getByTestId('fields-save')).toBeDisabled()
  await resolution.getByTestId('field-label-input').fill('Resolution')

  for (const row of [status, resolution]) {
    await row.getByTestId('field-type-select').click()
    await page.getByRole('menuitemradio', { name: 'Enum' }).click()
    await row.getByTestId('enum-add-value').click()
    await row.getByTestId('field-value').last().getByTestId('field-value-label-input').fill('Done')
  }
  await status.getByTestId('enum-add-value').click()
  const duplicate = status.getByTestId('field-value').last()
  await duplicate.getByTestId('field-value-label-input').fill(' done ')
  await expect(duplicate).toContainText('Value name already exists in this field')
  const duplicateInput = duplicate.getByTestId('field-value-label-input')
  await expect(duplicateInput).toHaveAttribute('aria-invalid', 'true')
  const describedBy = await duplicateInput.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  await expect(page.locator(`[id="${describedBy}"]`)).toContainText(
    'Value name already exists in this field',
  )
  await expect(page.getByTestId('fields-save')).toBeDisabled()
  await duplicate.getByTestId('field-value-label-input').fill('Closed')

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/s/main/fields/schema'),
  )
  await page.getByTestId('fields-save').click()
  expect((await saved).status()).toBe(200)
})

test('a Save response advances the base without dropping a newer draft edit', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/s/main/management/fields')
  await page.getByTestId('fields-add').click()
  const row = page.getByTestId('field-row')
  const input = row.getByTestId('field-label-input')
  await input.fill('Status')
  await page.getByTestId('fields-save').click()
  await expect(row.getByTestId('field-row-toggle')).toHaveAttribute('aria-expanded', 'false')
  await row.getByTestId('field-row-toggle').click()

  const captured = deferred()
  const release = deferred()
  let held = false
  await page.route('**/api/s/main/fields/schema', async (route) => {
    if (route.request().method() !== 'PUT' || held) {
      await route.continue()
      return
    }
    held = true
    const response = await route.fetch()
    captured.resolve()
    await release.promise
    await route.fulfill({ response })
  })

  await input.fill('Submitted name')
  await page.getByTestId('fields-save').click()
  await captured.promise
  await input.fill('Newer local name')
  release.resolve()
  await expect(page.getByTestId('fields-save')).toHaveText('Save schema')
  await expect(input).toHaveValue('Newer local name')
  await expect(page.getByTestId('fields-save')).toBeEnabled()
  const afterFirst = (await (await page.request.get('/api/s/main/fields/schema')).json()) as {
    fields: Array<{ label?: string }>
  }
  expect(afterFirst.fields[0].label).toBe('Submitted name')

  await page.getByTestId('fields-save').click()
  await expect(page.getByTestId('fields-reset')).toHaveCount(0)
  const afterSecond = (await (await page.request.get('/api/s/main/fields/schema')).json()) as {
    fields: Array<{ label?: string }>
  }
  expect(afterSecond.fields[0].label).toBe('Newer local name')
})

test('a delayed first Save promotes stable field and enum identities into the newer draft', async ({
  page,
}) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/s/main/management/fields')
  const captured = deferred()
  const release = deferred()
  let held = false
  await page.route('**/api/s/main/fields/schema', async (route) => {
    if (route.request().method() !== 'PUT' || held) {
      await route.continue()
      return
    }
    held = true
    const response = await route.fetch()
    captured.resolve()
    await release.promise
    await route.fulfill({ response })
  })

  await page.getByTestId('fields-add').click()
  const row = page.getByTestId('field-row')
  const fieldName = row.getByTestId('field-label-input')
  await fieldName.fill('Status')
  await row.getByTestId('field-type-select').click()
  await page.getByRole('menuitemradio', { name: 'Enum' }).click()
  await row.getByTestId('enum-add-value').click()
  const valueName = row.getByTestId('field-value-label-input')
  await valueName.fill('Backlog')

  await page.getByTestId('fields-save').click()
  await captured.promise
  await fieldName.fill('Workflow')
  await valueName.fill('Inbox')
  release.resolve()

  await expect(fieldName).toHaveValue('Workflow')
  await expect(valueName).toHaveValue('Inbox')
  await expect(page.getByTestId('fields-save')).toBeEnabled()
  await page.getByTestId('fields-save').click()
  await expect(page.getByTestId('fields-reset')).toHaveCount(0)

  const stored = (await (await page.request.get('/api/s/main/fields/schema')).json()) as {
    fields: Array<{
      key: string
      type: string
      label?: string
      values?: Array<{ key: string; label?: string }>
    }>
  }
  expect(stored.fields).toEqual([
    {
      key: 'status',
      type: 'enum',
      label: 'Workflow',
      values: [{ key: 'backlog', label: 'Inbox' }],
    },
  ])
})

test('an unavailable field facet is never presented as zero usage', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  const current = (await (await page.request.get('/api/s/main/fields/schema')).json()) as {
    versionToken: string
  }
  const seeded = await page.request.put('/api/s/main/fields/schema', {
    data: {
      version: 1,
      versionToken: current.versionToken,
      fields: [{ key: 'status', type: 'text', label: 'Status' }],
    },
  })
  expect(seeded.ok()).toBe(true)
  await page.route('**/api/s/main/fields?*', (route) => route.abort('failed'))
  await page.goto('/s/main/management/fields')

  const row = page.getByTestId('field-row').filter({ hasText: 'Status' })
  await expect(row).toContainText('Usage unavailable')
  await row.getByTestId('field-row-toggle').click()
  await row.getByTestId('field-type-select').click()
  await page.getByRole('menuitemradio', { name: 'Number' }).click()
  await expect(row).toContainText('Usage count is unavailable')
  await expect(row).not.toContainText('affects 0 notes')
})

test('generated keys, field order, deletion and unrestricted card flags stay honest', async ({
  page,
}) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/s/main/management/fields')
  await page.getByTestId('fields-add').click()
  const rows = page.getByTestId('field-row')
  const first = rows.nth(0)
  const firstName = first.getByTestId('field-label-input')

  await expect(first.getByTestId('field-name-error')).toHaveCount(0)
  await expect(page.getByTestId('fields-save')).toBeDisabled()
  await firstName.blur()
  await expect(first.getByTestId('field-name-error')).toContainText('Enter a field name')
  await firstName.fill('Tags')
  await expect(first.getByTestId('field-name-error')).toHaveCount(0)
  await first.getByText('Show on note cards', { exact: true }).click()

  await page.getByTestId('fields-add').click()
  const second = rows.nth(1)
  await second.getByTestId('field-label-input').fill('Status')
  await second.getByText('Show on note cards', { exact: true }).click()

  await page.getByTestId('fields-add').click()
  const third = rows.nth(2)
  await third.getByTestId('field-label-input').fill('Third')
  await expect(third.getByTestId('field-card')).toBeEnabled()
  await third.getByText('Show on note cards', { exact: true }).click()

  const thirdGrip = third.getByRole('button', { name: 'Reorder item' })
  await thirdGrip.focus()
  await thirdGrip.press('ArrowUp')
  expect(await fieldOrder(page)).toEqual(['Tags', 'Third', 'Status'])

  await dragBefore(page, 'field-row', 'Status', 'field-row', 'Tags')
  expect(await fieldOrder(page)).toEqual(['Status', 'Tags', 'Third'])

  await page.getByTestId('fields-save').click()
  await expect(page.getByTestId('fields-reset')).toHaveCount(0)
  const stored = (await (await page.request.get('/api/s/main/fields/schema')).json()) as {
    fields: Array<{ key: string; type: string; label?: string; card?: boolean }>
  }
  expect(stored.fields).toEqual([
    { key: 'status', type: 'text', label: 'Status', card: true },
    { key: 'tags-2', type: 'text', label: 'Tags', card: true },
    { key: 'third', type: 'text', label: 'Third', card: true },
  ])
  await page.reload()
  await expect(rows).toHaveCount(3)
  expect(await fieldOrder(page)).toEqual(['Status', 'Tags', 'Third'])

  const status = rows.filter({ hasText: 'Status' }).first()
  await status.getByRole('button', { name: 'More actions for Status' }).click()
  await page.getByRole('menuitem', { name: 'Delete field' }).click()
  await expect(page.getByRole('heading', { name: 'Delete field “Status”?' })).toBeVisible()
  await expect(page.getByText('Values in 1 note stay in their files')).toBeVisible()
  await page.getByRole('button', { name: 'Delete field' }).click()
  await page.getByTestId('fields-save').click()
  const note = (await (await page.request.get('/api/note?id=field-note')).json()) as {
    frontmatter: Record<string, string>
  }
  expect(note.frontmatter.status).toBe('backlog')
})

test('deleting the last declaration keeps Save and Reset available', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  const current = (await (await page.request.get('/api/s/main/fields/schema')).json()) as {
    versionToken: string
  }
  const seeded = await page.request.put('/api/s/main/fields/schema', {
    data: {
      version: 1,
      versionToken: current.versionToken,
      fields: [{ key: 'status', type: 'text', label: 'Status' }],
    },
  })
  expect(seeded.ok()).toBe(true)
  await page.goto('/s/main/management/fields')

  await page.getByRole('button', { name: 'More actions for Status' }).click()
  await page.getByRole('menuitem', { name: 'Delete field' }).click()
  await page.getByRole('button', { name: 'Delete field' }).click()

  await expect(page.getByTestId('fields-empty')).toBeVisible()
  await expect(page.getByTestId('fields-reset')).toBeVisible()
  await expect(page.getByTestId('fields-save')).toBeEnabled()
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/s/main/fields/schema'),
  )
  await page.getByTestId('fields-save').click()
  expect((await saved).request().postDataJSON()).toMatchObject({ fields: [] })
})

test('a dirty declaration draft never crosses a routed space boundary', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/s/main/management/fields')
  await page.getByTestId('fields-add').click()
  await page.getByTestId('field-label-input').fill('Main unsaved field')
  await expect(page.getByTestId('fields-reset')).toBeVisible()

  await page.evaluate(() => {
    history.pushState({}, '', '/s/other/management/fields')
    dispatchEvent(new PopStateEvent('popstate'))
  })

  await expect(page).toHaveURL(/\/s\/other\/management\/fields$/u)
  await expect(page.getByText('Main unsaved field', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('fields-empty')).toBeVisible()
  await expect(page.getByTestId('fields-reset')).toHaveCount(0)
})

test('a schema Save in one tab refreshes another tab without a reload', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  const other = await page.context().newPage()
  await page.goto('/s/main/management/fields')
  await other.goto('/s/main/management/fields')

  await page.getByTestId('fields-add').click()
  await page.getByTestId('field-label-input').fill('Shared status')
  await page.getByTestId('fields-save').click()

  await expect(other.getByTestId('field-row').filter({ hasText: 'Shared status' })).toBeVisible()
})

test('a confirmation opened in one space cannot start work after navigation', async ({ page }) => {
  await login(page, 'owner', 'owner-password-1')
  const current = (await (await page.request.get('/api/s/main/fields/schema')).json()) as {
    versionToken: string
  }
  expect(
    (
      await page.request.put('/api/s/main/fields/schema', {
        data: {
          version: 1,
          versionToken: current.versionToken,
          fields: [{ key: 'status', type: 'text', label: 'Status' }],
        },
      })
    ).ok(),
  ).toBe(true)
  await page.goto('/s/main/management/fields')
  const row = page.getByTestId('field-row').filter({ hasText: 'Status' })
  await row.getByTestId('field-row-toggle').click()
  await row.getByTestId('field-type-select').click()
  await page.getByRole('menuitemradio', { name: 'Number' }).click()
  let writes = 0
  await page.route('**/api/s/main/fields/schema', async (route) => {
    if (route.request().method() === 'PUT') {
      writes++
    }
    await route.continue()
  })
  await page.getByTestId('fields-save').click()
  await expect(page.getByRole('heading', { name: 'Save field type changes?' })).toBeVisible()
  await page.evaluate(() => {
    history.pushState({}, '', '/s/other/management/fields')
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await page.getByRole('dialog').getByRole('button', { name: 'Save schema' }).click()

  await expect(page).toHaveURL(/\/s\/other\/management\/fields$/u)
  await expect(page.getByTestId('fields-empty')).toBeVisible()
  await expect(page.getByText('Saving…')).toHaveCount(0)
  expect(writes).toBe(0)
})

test('the tab is hidden from a reader while its direct route remains readable', async ({
  page,
  request,
}) => {
  const loginResponse = await request.post('/api/auth/login', {
    data: { identifier: 'owner', password: 'owner-password-1' },
  })
  expect(loginResponse.ok()).toBe(true)
  const current = (await (await request.get('/api/s/main/fields/schema')).json()) as {
    versionToken: string
  }
  expect(
    (
      await request.put('/api/s/main/fields/schema', {
        data: {
          version: 1,
          fields: [
            {
              key: 'status',
              type: 'enum',
              values: [{ key: 'backlog', label: 'Backlog' }],
            },
          ],
          versionToken: current.versionToken,
        },
      })
    ).ok(),
  ).toBe(true)

  await login(page, 'reader', 'reader-password-1')
  await page.goto('/s/main/management/fields')
  await expect(page.getByTestId('settings-tab-fields')).toHaveCount(0)
  await expect(page.getByTestId('fields-reader-notice')).toBeVisible()
  await expect(page.getByTestId('field-summary').filter({ hasText: 'Status' })).toBeVisible()
  await expect(page.getByText('status', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('fields-save')).toHaveCount(0)
  await expect(page.getByTestId('field-key-input')).toHaveCount(0)
})

test('a future schema stays readable and exposes its reason without a write form', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, {
    data: {
      fixture: {
        ...WORLD,
        spaces: [
          {
            ...WORLD.spaces[0],
            fieldSchema: {
              version: 2,
              fields: [{ key: 'future-field', type: 'text' }],
            },
          },
          WORLD.spaces[1],
        ],
      },
    },
  })
  await login(page, 'owner', 'owner-password-1')
  await page.goto('/s/main/management/fields')

  await expect(page.getByTestId('fields-readonly')).toBeVisible()
  await expect(page.getByTestId('fields-schema-error')).toContainText(
    'newer than supported version',
  )
  await expect(page.getByTestId('field-summary').filter({ hasText: 'Future Field' })).toBeVisible()
  await expect(page.getByText('future-field', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('fields-save')).toHaveCount(0)
})
