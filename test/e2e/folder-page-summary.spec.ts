import { expect, test } from './fixtures'

test('folder page shows a direct children summary under the page body', async ({ page }) => {
  await page.goto('/')

  const demo = page.locator('[data-testid="tree-folder"][data-path="demo"]')
  await expect(demo).toBeVisible()

  await demo.click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'New folder' }).click()
  await page.getByTestId('dialog-prompt-input').fill('drafts')
  await page.getByRole('button', { name: 'Create folder' }).click()
  const drafts = page.locator('[data-testid="tree-folder"][data-path="demo/drafts"]')
  await expect(drafts).toBeVisible()

  await drafts.click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Mark as project' }).click()
  await page.getByRole('button', { name: 'Mark as project' }).click()
  await expect(drafts.getByTestId('project-badge')).toBeVisible()

  await demo.click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Open page' }).click()
  await expect(page.getByTestId('folder-no-page')).toHaveCount(0)
  await expect(page.getByTestId('virtual-folder-page')).toBeVisible()

  const summary = page.getByTestId('folder-children-summary')
  await expect(summary).toBeVisible()
  const summaryFolder = summary.getByTestId('folder-summary-folder')
  await expect(summaryFolder).toHaveText('drafts')
  await expect(summaryFolder).toHaveAttribute('href', /^\/folder\/[A-Za-z0-9_-]{12}$/)
  await expect(summaryFolder.getByTestId('project-badge')).toBeVisible()
  await expect(summary.getByTestId('folder-summary-note')).toHaveCount(3)
  await expect(summary).toContainText('Carbon')
  await expect(summary).toContainText('My Note')
  await expect(summary).toContainText('Titanium')
  await expect(summary).not.toContainText('index')
  const beforeSaveTree = await (await page.request.get('/api/s/main/tree')).json()
  expect(
    beforeSaveTree.folders.find((f: { path: string; pageNoteId?: string }) => f.path === 'demo')
      ?.pageNoteId,
  ).toBeUndefined()

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.cm-content')
  await expect(editor).toContainText('# demo')
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  await editor.fill('# demo\n\nFolder overview.')
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(/\/n\/.+\/demo$/)
  await expect(page.locator('.doc .markdown')).toContainText('Folder overview.')
  const savedSummary = page.getByTestId('folder-children-summary')
  await expect(savedSummary).toBeVisible()

  await savedSummary.getByRole('link', { name: 'Carbon' }).click()
  await expect(page).toHaveURL(/\/n\/fake-demo-carbon\/carbon$/)
})

test('virtual folder page materialize race keeps the draft until explicit overwrite', async ({
  page,
}) => {
  await page.goto('/')

  const demo = page.locator('[data-testid="tree-folder"][data-path="demo"]')
  await expect(demo).toBeVisible()
  await demo.click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Open page' }).click()
  await expect(page.getByTestId('virtual-folder-page')).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.cm-content')
  await editor.fill('# demo\n\nMy local overview.')

  const raced = await page.request.post('/api/s/main/folders/page', {
    data: {
      folderPath: 'demo',
      content: '# demo\n\nSaved elsewhere.',
    },
  })
  expect(raced.status()).toBe(201)

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: 'Folder page already exists' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing' }).click()
  await expect(editor).toContainText('My local overview.')
  await expect(page).toHaveURL(/\/s\/main\/files\/demo$/)

  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Show saved page' }).click()
  await expect(page.getByTestId('folder-page-current-content')).toContainText('Saved elsewhere.')
  await page.getByRole('button', { name: 'Back to my draft' }).click()
  await expect(editor).toContainText('My local overview.')

  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Save my version' }).click()
  await expect(page).toHaveURL(/\/n\/.+\/demo$/)
  await expect(page.locator('.doc .markdown')).toContainText('My local overview.')

  const tree = await (await page.request.get('/api/s/main/tree')).json()
  const demoFolder = tree.folders.find(
    (f: { path: string; pageNoteId?: string }) => f.path === 'demo',
  )
  expect(demoFolder?.pageNoteId).toBeTruthy()
  const note = await (await page.request.get(`/api/note?id=${demoFolder.pageNoteId}`)).json()
  expect(note.filePath).toBe('demo/index.md')
})
