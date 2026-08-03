import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Journey (P3, the create half of #50's optimistic-save story): a new note whose
// title is already taken in that folder must NOT replace the note sitting there.
// The save is refused, the draft survives, and every way out of the dialog is
// explicit. Plus the wire contract: the 409 envelope and the uniquify retry.
// canon: docs/note-model.md#create-collisions

const TAKEN = 'Plans'
const FOLDER = 'demo'

// The collision partner is created HERE rather than taken from the fixture: the rule
// fences the PATH, and the fixture's notes carry legacy human file names that do not
// equal slug(title) (`demo/Carbon.md`), so none of them is at a path a new note would
// aim at. A note written through the API lands at `slug(title).md` by definition.
const seedTaken = async (page: Page, baseURL: string, body: string): Promise<string> => {
  const res = await page.request.post(`${baseURL}/api/s/main/notes`, {
    data: { directory: FOLDER, content: `# ${TAKEN}\n\n${body}` },
  })
  expect(res.status()).toBe(200)
  return (await res.json()).id as string
}

// The create-intent IS a URL (`?new&dir=…`) — every "New note" affordance in the app
// navigates to it, so driving it directly exercises the same draft without depending on
// which shape the + button takes for this fixture's capabilities.
const startNewNoteIn = async (page: Page, folder: string) => {
  await page.goto(`/s/main/files/${folder}?new=1&dir=${folder}`)
  await expect(page.locator('.cm-content')).toBeVisible()
}

// A blank new draft already opens on an empty `# ` title line, so the document is
// REPLACED rather than typed into — otherwise the leading marker doubles and the title
// silently becomes "# Plans", which still slugs to the same path and would let a wrong
// title sail past a `toContainText` assertion.
const typeDocument = async (page: Page, title: string, body: string) => {
  const content = page.locator('.cm-content')
  await content.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type(`# ${title}`)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type(body)
  await expect(content).toContainText(body.slice(0, 20))
}

test('a taken title is refused: the draft stands, the existing note keeps its body', async ({
  page,
  baseURL,
}) => {
  const taken = await seedTaken(page, baseURL!, 'The body that must survive.')
  await startNewNoteIn(page, FOLDER)
  await typeDocument(page, TAKEN, 'My brand new text.')
  await page.getByRole('button', { name: 'Save' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('A note with this name already exists here')
  // The occupant is named — the client got its identity in the 409 envelope.
  await expect(dialog).toContainText(`“${TAKEN}” already lives in this folder`)
  // A save shortcut leaves the keyboard on the dialog's LAST option, so the trailing
  // slot must never be the branch that drops the draft.
  await expect(dialog.getByRole('button').last()).toHaveText(/^Save as /)
  await expect(dialog.getByRole('button').last()).toBeFocused()

  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page.locator('.cm-content')).toContainText('My brand new text.')

  // Nothing was overwritten.
  await page.goto(`/n/${taken}`)
  await expect(page.locator('.markdown')).toContainText('The body that must survive.')
})

test('"Save under a free name" lands beside the occupant and says which name it got', async ({
  page,
  baseURL,
}) => {
  const taken = await seedTaken(page, baseURL!, 'The original.')
  await startNewNoteIn(page, FOLDER)
  await typeDocument(page, TAKEN, 'Beside the original.')
  await page.getByRole('button', { name: 'Save' }).click()
  // The offer names the free title the server picked, not a vague "a free name".
  await page.getByRole('dialog').getByRole('button', { name: 'Save as “Plans 2”' }).click()

  // The rename the user consented to is stated, not silent.
  await expect(page.getByRole('status')).toContainText('Saved as “Plans 2”.')
  await expect(page.locator('.markdown')).toContainText('Beside the original.')
  // Two distinct notes now — the original is untouched.
  await page.goto(`/n/${taken}`)
  await expect(page.locator('.markdown')).toContainText('The original.')
})

test('"Open the existing note" leaves for it only after the draft discard is confirmed', async ({
  page,
  baseURL,
}) => {
  const taken = await seedTaken(page, baseURL!, 'The original.')
  await startNewNoteIn(page, FOLDER)
  await typeDocument(page, TAKEN, 'Text I would lose.')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Open the existing note' }).click()

  // The collision dialog promised the text was safe, so leaving asks first.
  const discard = page.getByRole('dialog')
  await expect(discard).toContainText('Discard unsaved changes?')
  await discard.getByRole('button', { name: 'Discard' }).click()

  await expect(page).toHaveURL(new RegExp(`/n/${taken}`))
  await expect(page.locator('.markdown')).toContainText('The original.')
})

test('wire contract: a create onto a taken path is a 409 naming the occupant; uniquify steps aside', async ({
  page,
  baseURL,
}) => {
  const taken = await seedTaken(page, baseURL!, 'The original.')

  const clash = await page.request.post(`${baseURL}/api/s/main/notes`, {
    data: { directory: FOLDER, content: `# ${TAKEN}\n\nintruder` },
  })
  expect(clash.status()).toBe(409)
  const envelope = await clash.json()
  expect(envelope.reason).toBe('note_already_exists')
  expect(envelope.existing.id).toBe(taken)
  expect(envelope.existing.filePath).toBe(`${FOLDER}/plans.md`)

  // The victim's bytes never moved.
  const live = await (await page.request.get(`${baseURL}/api/note?id=${taken}`)).json()
  expect(live.content).toContain('The original.')

  const beside = await page.request.post(`${baseURL}/api/s/main/notes`, {
    data: { directory: FOLDER, content: `# ${TAKEN}\n\nmine`, ifExists: 'uniquify' },
  })
  expect(beside.status()).toBe(200)
  const saved = await beside.json()
  expect(saved.title).toBe('Plans 2')
  expect(saved.id).not.toBe(taken)

  // `overwrite` is not a value any client can send.
  const clobber = await page.request.post(`${baseURL}/api/s/main/notes`, {
    data: { directory: FOLDER, content: `# ${TAKEN}\n\nclobber`, ifExists: 'overwrite' },
  })
  expect(clobber.status()).toBe(400)
})
