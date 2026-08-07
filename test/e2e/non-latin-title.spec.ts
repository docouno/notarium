import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Journey (#296): a note whose title is in a script we cannot romanise must get a real
// file, survive, and be reachable by name. It used to slug to '' — so the note was
// written to the dot-file `<dir>/.md` (hidden from the scan, dead on the next boot),
// every such title aimed at that one path, and every `[[label]]` in such a script
// resolved through one shared empty key.
// canon: docs/note-model.md#note-ontology

const FOLDER = 'demo'
const CJK = '第三季度规划'
const JP = '会議の議事録'

const startNewNoteIn = async (page: Page, folder: string) => {
  await page.goto(`/s/main/files/${folder}?new=1&dir=${folder}`)
  await expect(page.locator('.cm-content')).toBeVisible()
}

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

test('a CJK title saves to a real file and opens as itself', async ({ page }) => {
  await startNewNoteIn(page, FOLDER)
  await typeDocument(page, CJK, 'Q3 roadmap body.')
  await page.getByRole('button', { name: 'Save' }).click()

  // No collision dialog: the name is the note's own, not a shared empty one.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.markdown')).toContainText('Q3 roadmap body.')
  // The URL tail is the slug — it used to be empty, leaving `/n/<id>/`.
  await expect(page).toHaveURL(new RegExp(`/n/[^/]+/${encodeURIComponent(CJK)}`))
  await expect(page.getByTestId('rail-scroll').getByRole('link', { name: CJK })).toBeVisible()
})

test('two different non-Latin titles coexist in one folder', async ({ page, baseURL }) => {
  // Straight on the wire: this is where the second create used to be refused as a
  // duplicate of a note whose title was visibly different.
  const create = (title: string, body: string) =>
    page.request.post(`${baseURL}/api/s/main/notes`, {
      data: { directory: FOLDER, content: `# ${title}\n\n${body}` },
    })

  const first = await create(CJK, 'first body')
  const second = await create(JP, 'second body')
  expect(first.status()).toBe(200)
  expect(second.status()).toBe(200)

  const a = await first.json()
  const b = await second.json()
  expect(a.filePath).toBe(`${FOLDER}/${CJK}.md`)
  expect(b.filePath).toBe(`${FOLDER}/${JP}.md`)
  expect(a.id).not.toBe(b.id)

  // And a REAL duplicate is still refused, now naming a free title a human can read.
  const clash = await create(CJK, 'intruder')
  expect(clash.status()).toBe(409)
  const envelope = await clash.json()
  expect(envelope.reason).toBe('note_already_exists')
  expect(envelope.existing).toMatchObject({ id: a.id, title: CJK })
  expect(envelope.suggestedTitle).toBe(`${CJK} 2`)
})

test('a wikilink written in a non-Latin script resolves to its note', async ({ page, baseURL }) => {
  const target = await page.request.post(`${baseURL}/api/s/main/notes`, {
    data: { directory: FOLDER, content: `# ${CJK}\n\nthe target body` },
  })
  const targetId = (await target.json()).id as string
  const linker = await page.request.post(`${baseURL}/api/s/main/notes`, {
    data: { directory: FOLDER, content: `# Linker\n\nPoints at [[${CJK}]].` },
  })
  const linkerId = (await linker.json()).id as string

  // The rendered link is a real one (not a ghost "create this note" stub), and it
  // leads to the target rather than to whichever non-Latin note happened to be last.
  await page.goto(`/n/${linkerId}`)
  await expect(page.locator('.markdown')).toContainText('Points at')
  await page.locator('.markdown').getByRole('link', { name: CJK }).click()
  await expect(page).toHaveURL(new RegExp(`/n/${targetId}`))
  await expect(page.locator('.markdown')).toContainText('the target body')
})

test('an in-page anchor to a non-Latin heading scrolls to it', async ({ page, baseURL }) => {
  // The heading id is the core slug (non-ASCII since #296) while marked percent-encodes
  // the href it generates — so the reader has to meet them after decoding, or every
  // anchor into a non-romanisable heading is dead.
  const body = [
    `# Anchor host`,
    ``,
    `[jump](#${CJK})`,
    ``,
    ...Array.from({ length: 40 }, (_, i) => `filler line ${i}`),
    ``,
    `## ${CJK}`,
    ``,
    `the section body`,
  ].join('\n')
  const created = await page.request.post(`${baseURL}/api/s/main/notes`, {
    data: { directory: FOLDER, content: body },
  })
  const id = (await created.json()).id as string

  await page.goto(`/n/${id}`)
  const heading = page.locator(`.markdown h2`, { hasText: CJK })
  await expect(heading).not.toBeInViewport()
  await page.locator('.markdown').getByRole('link', { name: 'jump' }).click()
  await expect(heading).toBeInViewport()
})
