import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Journey (#50, P3): optimistic save. Two tabs edit the same note; the slower
// save must NOT silently overwrite the faster one — it gets the conflict
// dialog, and no path through that dialog loses either side's text. Plus the
// wire contract itself: strict tokenless reject and the 409 envelope.

const NOTE = 'fake-demo-carbon'

// Every helper foregrounds its tab first: CodeMirror flushes DOM input into
// its document on requestAnimationFrame, and rAF is frozen in a background
// tab — typing there changes the visible DOM but never the editor state (the
// Save gate stays inert). Real two-tab editing is foreground-by-turns anyway.
const openCarbonEditor = async (page: Page) => {
  await page.bringToFront()
  await page.goto('/')
  await page.locator(`[data-testid="tree-note"][data-id="${NOTE}"]`).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  // #156: the title is the document's leading `# H1`, edited inline (no title field).
  await expect(page.locator('.cm-content')).toContainText('# Carbon')
}

// Replace the document body, KEEPING the `# Carbon` title line (#156): the title now
// lives in the body, so replacing the whole document with bare text would re-title the
// note from its new first line (and empty the stored content). Type the title back as
// the leading H1 so the note stays "Carbon" and `text` is its body.
const setBody = async (page: Page, text: string) => {
  await page.bringToFront()
  const body = page.locator('.cm-content')
  await body.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type('# Carbon')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type(text)
  await expect(body).toContainText(text.slice(0, 24))
}

const saveAndExpectClosed = async (page: Page) => {
  await page.bringToFront()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible()
}

test('two tabs, one note: the slower save conflicts; "Show latest" keeps the draft, overwrite stays explicit', async ({
  page,
}) => {
  const tab2 = await page.context().newPage()
  await openCarbonEditor(page)
  await openCarbonEditor(tab2)

  // tab2 wins the race
  await setBody(tab2, 'Body from tab two.')
  await saveAndExpectClosed(tab2)

  // tab1's save is refused — the dialog explains, nothing is overwritten
  await setBody(page, 'Body from tab one.')
  await page.getByRole('button', { name: 'Save' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Note changed on the server')

  // "Show latest": the live version is visible, the draft stays in the editor
  await dialog.getByRole('button', { name: 'Show latest' }).click()
  await expect(page.getByTestId('conflict-current-content')).toContainText('Body from tab two.')
  const overwritten = page.getByTestId('conflict-current-fields')

  for (const label of ['Title', 'Type', 'Folder', 'Slug', 'Tags']) {
    await expect(overwritten.getByText(label, { exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: 'Back to my draft' }).click()
  await expect(page.locator('.cm-content')).toContainText('Body from tab one.')

  // viewing did NOT arm an overwrite: the next save conflicts again — the
  // only way to overwrite is the explicit dialog action, however much time
  // passed since viewing
  await page.bringToFront()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('dialog')).toContainText('Note changed on the server')
  await page.getByRole('dialog').getByRole('button', { name: 'Save my version' }).click()
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible()
  await expect(page.locator('.markdown')).toContainText('Body from tab one.')

  // the overwrite was a decision, not an accident: the reader shows ONE truth
  // across tabs now.
  await tab2.reload()
  await expect(tab2.locator('.markdown')).toContainText('Body from tab one.')
})

test('Show latest names the concurrent custom-field value an overwrite would replace', async ({
  page,
  baseURL,
}) => {
  const schema = (await (await page.request.get(`${baseURL}/api/s/main/fields/schema`)).json()) as {
    versionToken: string
  }
  const schemaWrite = await page.request.put(`${baseURL}/api/s/main/fields/schema`, {
    data: {
      version: 1,
      versionToken: schema.versionToken,
      fields: [
        {
          key: 'status',
          type: 'enum',
          label: 'Status',
          values: [
            { key: 'backlog', label: 'Backlog' },
            { key: 'doing', label: 'In progress' },
            { key: 'blocked', label: 'Blocked' },
          ],
        },
      ],
    },
  })
  expect(schemaWrite.ok()).toBe(true)
  const initial = (await (await page.request.get(`${baseURL}/api/note?id=${NOTE}`)).json()) as {
    versionToken: string
  }
  const initialWrite = await page.request.put(`${baseURL}/api/note/fields`, {
    data: { id: NOTE, versionToken: initial.versionToken, fields: { status: 'backlog' } },
  })
  expect(initialWrite.ok()).toBe(true)

  const tab2 = await page.context().newPage()
  await openCarbonEditor(page)
  await openCarbonEditor(tab2)
  await page.bringToFront()
  await page.getByTitle('Open panel').click()
  await tab2.bringToFront()
  await tab2.getByTitle('Open panel').click()
  const chooseStatus = async (target: Page, name: string) => {
    await target.bringToFront()
    await target.getByTestId('editor-meta').getByRole('button', { name: 'Status value' }).click()
    await target.getByRole('menuitemradio', { name }).click()
  }

  await chooseStatus(tab2, 'Blocked')
  await saveAndExpectClosed(tab2)
  await chooseStatus(page, 'In progress')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Show latest' }).click()

  const fields = page.getByTestId('conflict-current-fields')
  await expect(fields).toContainText('Status')
  await expect(fields).toContainText('Latest: Blocked')
  await expect(fields).toContainText('Your draft: In progress')
})

test('"Save my version" retries with the fresh token and wins explicitly', async ({ page }) => {
  const tab2 = await page.context().newPage()
  await openCarbonEditor(page)
  await openCarbonEditor(tab2)

  await setBody(tab2, 'Their body.')
  await saveAndExpectClosed(tab2)

  await setBody(page, 'My body.')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save my version' }).click()

  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible()
  await expect(page.locator('.markdown')).toContainText('My body.')
  await expect(page.locator('.markdown')).not.toContainText('Their body.')
})

test('"Keep editing" closes the dialog, the draft and the conflict both stand', async ({
  page,
}) => {
  const tab2 = await page.context().newPage()
  await openCarbonEditor(page)
  await openCarbonEditor(tab2)

  await setBody(tab2, 'Their body.')
  await saveAndExpectClosed(tab2)

  await setBody(page, 'My body.')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Keep editing' }).click()

  // still editing, text intact — and a retry conflicts again (token unchanged)
  await expect(page.locator('.cm-content')).toContainText('My body.')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('dialog')).toContainText('Note changed on the server')
})

test('wire contract (#50): tokenless update is a 400 with reason; stale token is a 409 carrying the live note', async ({
  page,
  baseURL,
}) => {
  const note = await (await page.request.get(`${baseURL}/api/note?id=${NOTE}`)).json()
  expect(note.versionToken).toBeTruthy()

  // strict: update without a token never lands — same rule for agents (#21)
  const noToken = await page.request.post(`${baseURL}/api/note`, {
    data: { title: 'Carbon', directory: 'demo', originalId: NOTE, content: 'sneaky' },
  })
  expect(noToken.status()).toBe(400)
  expect((await noToken.json()).reason).toBe('version_token_required')

  // stale token → 409 with the live note + fresh token in the envelope
  const stale = await page.request.post(`${baseURL}/api/note`, {
    data: {
      title: 'Carbon',
      directory: 'demo',
      originalId: NOTE,
      content: 'mine',
      versionToken: 'v1:stale',
    },
  })
  expect(stale.status()).toBe(409)
  const conflict = await stale.json()
  expect(conflict.reason).toBe('version_conflict')
  expect(conflict.current.id).toBe(NOTE)
  expect(conflict.current.versionToken).toBe(note.versionToken)
  expect(conflict.current.content).toContain('Bonds with')

  // echoing the live token is the explicit overwrite — it lands and answers a
  // fresh token a client can chain on
  const ok = await page.request.post(`${baseURL}/api/note`, {
    data: {
      title: 'Carbon',
      directory: 'demo',
      originalId: NOTE,
      content: 'mine, deliberately',
      versionToken: conflict.current.versionToken,
    },
  })
  expect(ok.status()).toBe(200)
  const saved = await ok.json()
  expect(saved.versionToken).toBeTruthy()
  expect(saved.versionToken).not.toBe(note.versionToken)
})
