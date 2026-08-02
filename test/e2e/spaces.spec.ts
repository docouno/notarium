import { type Page } from '@playwright/test'
import { expect, test, treeNote } from './fixtures'

// Spaces (#16): the switcher, the per-space chrome and the create flow —
// against a two-space world swapped in via the reset hook (the base fixture
// stays single-space so every other spec keeps its familiar tree).
//
// Isolation by construction is pinned at the API layer
// (test/fake-server/isolation.test.ts); what THIS spec proves is the UI leg:
// switching spaces actually re-anchors everything the rail and pages show.

const TWO_SPACES = {
  now: '2026-06-10T12:00:00.000Z',
  capabilities: { spaceCreate: true },
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          title: 'Main Note',
          filePath: 'demo/Main Note.md',
          modifiedAt: '2026-06-08T00:00:00.000Z',
          createdAt: '2026-06-01T09:00:00.000Z',
          tags: [],
          content: '# Main Note\n\nlives in main',
        },
      ],
    },
    {
      slug: 'work',
      displayName: 'Work',
      notes: [
        {
          title: 'Work Note',
          filePath: 'projects/Work Note.md',
          modifiedAt: '2026-06-09T00:00:00.000Z',
          createdAt: '2026-06-02T09:00:00.000Z',
          tags: [],
          content: '# Work Note\n\nlives in work',
        },
      ],
    },
  ],
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: TWO_SPACES } })
})

test.afterEach(async ({ page, baseURL }) => {
  // Hand the shared fake back to the canonical single-space fixture.
  await page.request.post(`${baseURL}/api/__test/reset`)
  await page.evaluate(() => localStorage.removeItem('nt-space'))
})

test('switcher swaps the whole space: tree, URL and the other space stays invisible', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/s\/main$/)
  await expect(treeNote(page, 'Main Note')).toBeVisible()
  await expect(treeNote(page, 'Work Note')).not.toBeVisible()

  await page.getByTestId('space-switcher').click()
  await page.getByText('Work', { exact: true }).click()

  await expect(page).toHaveURL(/\/s\/work$/)
  await expect(treeNote(page, 'Work Note')).toBeVisible()
  await expect(treeNote(page, 'Main Note')).not.toBeVisible()
})

test('a space deep-link lands directly in that space', async ({ page }) => {
  await page.goto('/s/work')
  await expect(treeNote(page, 'Work Note')).toBeVisible()
  await expect(treeNote(page, 'Main Note')).not.toBeVisible()
})

test('a space-free note URL re-anchors the chrome to the note’s space', async ({ page }) => {
  // The Work note's deterministic fake id (fake-<slugged-path>, see app.ts).
  await page.goto('/n/fake-projects-work-note')
  await expect(page.getByRole('heading', { name: 'Work Note' })).toBeVisible()
  // The rail follows the note's REAL space (the registry's verdict): the tree
  // shows work's folders, and the switcher names Work.
  await expect(page.getByTestId('space-switcher')).toContainText('Work')
})

test('creating a space takes a display NAME and derives the URL handle (#123)', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('space-switcher').click()
  await page.getByText('New space').click()
  // The dialog asks for a human name, not a slug: "Public Space" used to fail with
  // "bad space slug". The handle is slugified from it; the name stays the label.
  await page.getByTestId('dialog-prompt-input').fill('Scratch Space')
  await page.getByRole('button', { name: 'Create' }).click()

  await expect(page).toHaveURL(/\/s\/scratch-space$/)
  await expect(page.getByTestId('space-switcher')).toContainText('Scratch Space')
  // The fresh space is empty — and the previous spaces' notes are not here.
  await expect(treeNote(page, 'Main Note')).not.toBeVisible()
})

const createNamed = async (page: Page, name: string) => {
  await page.getByTestId('space-switcher').click()
  await page.getByText('New space').click()
  await page.getByTestId('dialog-prompt-input').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
}

const createNote = async (page: Page, baseURL: string, title: string) => {
  const res = await page.request.post(`${baseURL}/api/s/main/notes`, {
    data: { title, content: `# ${title}\n\nbody`, directory: 'demo' },
  })
  expect(res.ok()).toBeTruthy()
  return (await res.json()) as { id: string }
}

const deleteNote = async (page: Page, baseURL: string, id: string) => {
  const res = await page.request.delete(`${baseURL}/api/note?id=${encodeURIComponent(id)}`)
  expect(res.ok()).toBeTruthy()
}

test('a non-Latin name is romanised into the handle (#123)', async ({ page }) => {
  await page.goto('/')
  await createNamed(page, 'Моё Пространство') // Russian → transliterated
  await expect(page).toHaveURL(/\/s\/moio-prostranstvo$/)
  await expect(page.getByTestId('space-switcher')).toContainText('Моё Пространство') // the name is kept verbatim
})

test('a name that does not romanise (CJK) still creates — an id-shaped handle, name kept (#123)', async ({
  page,
}) => {
  await page.goto('/')
  await createNamed(page, '你好世界') // Chinese — no romaniser, so the handle falls back to an id
  // A real, non-empty handle (not /s/ with an empty segment), and the label is the name.
  await expect(page).toHaveURL(/\/s\/[a-z0-9_-]+$/)
  await expect(page).not.toHaveURL(/\/s\/?$/)
  await expect(page.getByTestId('space-switcher')).toContainText('你好世界')
})

test('two spaces with the same name get distinct handles — soft suffix, never an error (#123)', async ({
  page,
}) => {
  await page.goto('/')
  await createNamed(page, 'Team')
  await expect(page).toHaveURL(/\/s\/team$/)
  await createNamed(page, 'Team') // same name again
  await expect(page).toHaveURL(/\/s\/team-2$/) // suffixed, not rejected
  await expect(page.getByTestId('space-switcher')).toContainText('Team')
})

// Delete a space (#110): it leaves the switcher and lands in the Trash → Spaces tab
// (the ONE place for everything deleted); restore brings it back whole. A RUNTIME-
// minted space (a config-pinned fixture space refuses delete), so it's created first.
test('delete a space → it lands in the Trash (Spaces), restore brings it back (#110)', async ({
  page,
}) => {
  await page.goto('/')
  await createNamed(page, 'Scratch Space')
  await expect(page).toHaveURL(/\/s\/scratch-space$/)

  // Delete from Management → General → Danger zone.
  await page.goto('/s/scratch-space/management/general')
  await page.getByTestId('space-delete').click()
  await page.getByRole('button', { name: 'Move to Trash' }).click()

  // Redirected off the deleted space; it's gone from the switcher.
  await expect(page).not.toHaveURL(/\/s\/scratch-space/)
  await page.getByTestId('space-switcher').click()
  await expect(page.getByRole('menuitemradio', { name: 'Scratch Space' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // It now lives in the Trash → Spaces tab (deleted spaces are host-level — visible
  // from any space's Trash), with a "deleted by" attribution.
  await page.goto('/s/main/trash?tab=spaces')
  await expect(page.getByTestId('trash-space-row')).toContainText('Scratch Space')
  await expect(page.getByTestId('trash-space-row')).toContainText('you')

  // Restore returns it to the switcher, served again.
  await page.getByTestId('trash-space-restore').click()
  await expect(page.getByTestId('trash-empty-state')).toContainText('Trash is empty')
  await page.getByTestId('space-switcher').click()
  await expect(page.getByRole('menuitemradio', { name: 'Scratch Space' })).toBeVisible()
})

// Permanent delete (#110): the SAME mechanic as a note — tick the row, then the bulk
// footer's danger-confirm. Irreversible.
test('permanently delete a space from the Trash via the bulk footer (#110)', async ({ page }) => {
  await page.goto('/')
  await createNamed(page, 'Scratch Space')
  await expect(page).toHaveURL(/\/s\/scratch-space$/)
  await page.goto('/s/scratch-space/management/general')
  await page.getByTestId('space-delete').click()
  await page.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(page).not.toHaveURL(/\/s\/scratch-space/)

  await page.goto('/s/main/trash?tab=spaces')
  await expect(page.getByTestId('trash-space-row')).toContainText('Scratch Space')
  await expect(page.getByTestId('trash-footer')).toHaveCount(0)
  await expect(page.getByTestId('trash-empty')).toHaveCount(0)
  // Tick the space, then delete from the footer — identical to deleting notes.
  await page.getByTestId('trash-space-check').check({ force: true })
  await page.getByTestId('trash-delete-selected').click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Delete 1 forever/ })
    .click()
  await expect(page.getByTestId('trash-empty-state')).toContainText('Trash is empty')
})

test('purge is hidden until selection, then filtered Select-all-N deletes only matches (#183)', async ({
  page,
  baseURL,
}) => {
  for (let i = 0; i < 101; i++) {
    const note = await createNote(page, baseURL!, `Meeting Purge ${String(i).padStart(3, '0')}`)
    await deleteNote(page, baseURL!, note.id)
  }
  const other = await createNote(page, baseURL!, 'Other Purge')
  await deleteNote(page, baseURL!, other.id)

  await page.goto('/s/main/trash?tab=notes')
  const reload = page.waitForResponse((res) => {
    const url = res.url()
    return (
      res.request().method() === 'GET' &&
      url.includes('/api/s/main/trash') &&
      url.includes('q=meeting')
    )
  })
  await page.getByTestId('trash-search').fill('meeting')
  await reload
  await expect(page.getByTestId('trash-row').first()).toContainText('Meeting Purge')
  await expect(page.getByTestId('trash-footer')).toHaveCount(0)
  await expect(page.getByTestId('trash-empty')).toHaveCount(0)

  await page.getByTestId('trash-select-all').check({ force: true })
  await expect(page.getByTestId('trash-footer')).toBeVisible()
  await expect(page.getByTestId('trash-select-all-n')).toContainText('Select all 101')
  await page.getByTestId('trash-select-all-n').click()
  await expect(page.getByText('All 101 selected')).toBeVisible()
  await expect(page.getByTestId('trash-delete-selected')).toContainText('Delete 101 forever')
  await page.getByTestId('trash-delete-selected').click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Delete 101 forever/ })
    .click()
  await expect(page.getByTestId('trash-empty-state')).toContainText('Nothing matches')

  const trash = await (await page.request.get(`${baseURL}/api/s/main/trash`)).json()
  expect(trash.total).toBe(1)
  expect(trash.items[0].noteId).toBe(other.id)
})

test('bulk delete handles a mixed selection of a deleted note and a deleted space (#183)', async ({
  page,
  baseURL,
}) => {
  const note = await createNote(page, baseURL!, 'Mixed Purge')
  await deleteNote(page, baseURL!, note.id)
  await page.goto('/')
  await createNamed(page, 'Scratch Space')
  await page.goto('/s/scratch-space/management/general')
  await page.getByTestId('space-delete').click()
  await page.getByRole('button', { name: 'Move to Trash' }).click()

  await page.goto('/s/main/trash')
  await expect(page.getByTestId('trash-row')).toContainText('Mixed Purge')
  await expect(page.getByTestId('trash-space-row')).toContainText('Scratch Space')
  await expect(page.getByTestId('trash-footer')).toHaveCount(0)
  await page.getByTestId('trash-row-check').check({ force: true })
  await page.getByTestId('trash-space-check').check({ force: true })
  await expect(page.getByTestId('trash-delete-selected')).toContainText('Delete 2 forever')
  await page.getByTestId('trash-delete-selected').click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Delete 2 forever/ })
    .click()

  await expect(page.getByTestId('trash-empty-state')).toContainText('Trash is empty')
  const trash = await (await page.request.get(`${baseURL}/api/s/main/trash`)).json()
  expect(trash.total).toBe(0)
  await page.getByTestId('space-switcher').click()
  await expect(page.getByRole('menuitemradio', { name: 'Scratch Space' })).toHaveCount(0)
})

test('bulk restore several deleted notes from the footer (#184)', async ({ page, baseURL }) => {
  const alpha = await createNote(page, baseURL!, 'Alpha Restore')
  const beta = await createNote(page, baseURL!, 'Beta Restore')
  await deleteNote(page, baseURL!, alpha.id)
  await deleteNote(page, baseURL!, beta.id)

  await page.goto('/s/main/trash?tab=notes')
  await expect(page.getByTestId('trash-row')).toHaveCount(2)
  await page.getByTestId('trash-select-all').check({ force: true })
  await expect(page.getByTestId('trash-restore-selected')).toContainText('Restore 2')
  await page.getByTestId('trash-restore-selected').click()

  await expect(page.getByTestId('trash-empty-state')).toContainText('Trash is empty')
  expect(
    (await page.request.get(`${baseURL}/api/note?id=${encodeURIComponent(alpha.id)}`)).ok(),
  ).toBeTruthy()
  expect(
    (await page.request.get(`${baseURL}/api/note?id=${encodeURIComponent(beta.id)}`)).ok(),
  ).toBeTruthy()
})

test('bulk restore uses the real Select-all-N path beyond one page (#184)', async ({
  page,
  baseURL,
}) => {
  for (let i = 0; i < 101; i++) {
    const note = await createNote(page, baseURL!, `Paged Restore ${String(i).padStart(3, '0')}`)
    await deleteNote(page, baseURL!, note.id)
  }

  await page.goto('/s/main/trash?tab=notes')
  await page.getByTestId('trash-select-all').check({ force: true })
  await expect(page.getByTestId('trash-select-all-n')).toContainText('Select all 101')
  await page.getByTestId('trash-select-all-n').click()
  await expect(page.getByText('All 101 selected')).toBeVisible()
  await expect(page.getByTestId('trash-restore-selected')).toContainText('Restore 101')
  await page.getByTestId('trash-restore-selected').click()
  await expect(page.getByTestId('trash-empty-state')).toContainText('Trash is empty')
})

test('bulk restore handles a mixed selection of a deleted note and a deleted space (#184)', async ({
  page,
  baseURL,
}) => {
  const note = await createNote(page, baseURL!, 'Mixed Restore')
  await deleteNote(page, baseURL!, note.id)
  await page.goto('/')
  await createNamed(page, 'Scratch Space')
  await page.goto('/s/scratch-space/management/general')
  await page.getByTestId('space-delete').click()
  await page.getByRole('button', { name: 'Move to Trash' }).click()

  await page.goto('/s/main/trash')
  await expect(page.getByTestId('trash-row')).toContainText('Mixed Restore')
  await expect(page.getByTestId('trash-space-row')).toContainText('Scratch Space')
  await page.getByTestId('trash-row-check').check({ force: true })
  await page.getByTestId('trash-space-check').check({ force: true })
  await expect(page.getByTestId('trash-restore-selected')).toContainText('Restore 2')
  await page.getByTestId('trash-restore-selected').click()

  await expect(page.getByTestId('trash-empty-state')).toContainText('Trash is empty')
  expect(
    (await page.request.get(`${baseURL}/api/note?id=${encodeURIComponent(note.id)}`)).ok(),
  ).toBeTruthy()
  await page.getByTestId('space-switcher').click()
  await expect(page.getByRole('menuitemradio', { name: 'Scratch Space' })).toBeVisible()
})
