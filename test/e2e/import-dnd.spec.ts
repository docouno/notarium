import { type Page } from '@playwright/test'

import { expect, test, treeNote, waitForAppReady } from './fixtures'

// #223 — drag a text file into the window → import it as a note. Two drop zones:
// the TREE (a folder row, owned by the Sidebar section — it lights the row like an
// internal move) and the CONTENT reader (owned by the window dropzone — target is
// the OPEN note's folder, else the scope root). Both ride `DataTransfer.files`, a
// DIFFERENT payload from the tree's internal move (`application/x-notarium-item`),
// so they never collide — see docs/drag-and-drop.md §10.
//
// Native OS file drags can't be driven by Playwright (drag-and-drop.md §7), so we
// dispatch the DragEvent sequence with a synthetic DataTransfer carrying a File,
// ON the element under the drop point (so it bubbles through the Sidebar's React
// handler for tree drops AND to the window handler for content drops), just as a
// real drop does.

const FIXTURE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        { title: 'existing', filePath: 'Frontend/existing.md', content: '# existing', tags: [] },
      ].map((n) => ({
        ...n,
        modifiedAt: '2026-06-08T00:00:00.000Z',
        createdAt: '2026-06-01T09:00:00.000Z',
      })),
    },
  ],
}

const folderSel = (path: string) => `[data-testid="tree-folder"][data-path="${path}"]`

/** Drop text files at the centre of `targetSel`. Dispatches ON the element under
 *  that point (what a real drop hits), so a tree-folder drop reaches the Sidebar's
 *  React onDrop and a reader drop reaches the window listener. */
const dropTextFiles = async (
  page: Page,
  targetSel: string,
  files: Array<{ name: string; content: string; type?: string; lastModified?: number }>,
) => {
  await page.evaluate(
    ({ targetSel: sel, files: fs }) => {
      const anchor = document.querySelector(sel)

      if (!anchor) {
        throw new Error(`no drop target for ${sel}`)
      }
      const r = anchor.getBoundingClientRect()
      const clientX = Math.round(r.left + r.width / 2)
      const clientY = Math.round(r.top + r.height / 2)
      const at = document.elementFromPoint(clientX, clientY) ?? anchor
      const dt = new DataTransfer()

      for (const f of fs) {
        dt.items.add(
          new File([f.content], f.name, {
            type: f.type ?? 'text/markdown',
            // The file's own mtime — the date a frontmatter-less note falls back to
            // (#280). A real OS drag carries it; here we set it explicitly.
            ...(f.lastModified ? { lastModified: f.lastModified } : {}),
          }),
        )
      }
      const fire = (type: string) =>
        at.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX,
            clientY,
          }),
        )
      fire('dragenter')
      fire('dragover')
      fire('drop')
    },
    { targetSel, files },
  )
}

/** The folder a note's tree row declares (its wrapper's data-drop-folder). */
const folderOfTitle = (page: Page, title: string) =>
  page.evaluate((t) => {
    const rows = [...document.querySelectorAll('[data-testid="tree-note"]')]
    return (
      rows
        .find((r) => r.textContent?.includes(t))
        ?.parentElement?.getAttribute('data-drop-folder') ?? null
    )
  }, title)

test('drop a markdown file in the reader → a note in the scope root (#223)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)

  // Drop in the content area with no note open → the current scope root (space root).
  await dropTextFiles(page, 'main', [
    { name: 'welcome.md', content: '# Welcome Note\n\nHello there.' },
  ])

  await expect(treeNote(page, 'Welcome Note')).toBeVisible()
  await expect.poll(() => folderOfTitle(page, 'Welcome Note')).toBe('')
  await expect(page.getByTestId('toast')).toContainText('Imported 1 note')
  // A SINGLE-file drop OPENS the imported note (the headline behavior).
  await expect(page).toHaveURL(/\/n\/[^/]+/)
})

test('a mixed drop imports the text files and WARNS about the unsupported ones (#223)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)

  // One importable .md + one non-text file the client filters out → imported 1, and the
  // toast is a WARNING (not a green "done") because something was left unimported.
  await dropTextFiles(page, 'main', [
    { name: 'keep.md', content: '# Keep\n\ntext' },
    { name: 'data.json', content: '{"x":1}', type: 'application/json' },
  ])
  await expect(treeNote(page, 'Keep')).toBeVisible()
  const warn = page.getByTestId('toast').filter({ hasText: 'unsupported' })
  await expect(warn).toBeVisible()
  await expect(warn).toHaveAttribute('data-variant', 'warning')
})

test('drop a file onto a folder row → the note lands in that folder (#223)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)
  await expect(page.locator(folderSel('Frontend'))).toBeVisible()

  await dropTextFiles(page, folderSel('Frontend'), [
    { name: 'into-fe.md', content: '# Into Frontend\n\nbody' },
  ])

  // Frontend auto-expands on load, so the new note appears under it.
  await expect(treeNote(page, 'Into Frontend')).toBeVisible()
  await expect.poll(() => folderOfTitle(page, 'Into Frontend')).toBe('Frontend')
})

test('drop in the reader while a note is open → lands next to that note (#223 refinement)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)
  // Open the note in Frontend/, so the reader's drop target is its folder.
  await treeNote(page, 'existing').click()
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Frontend')

  await dropTextFiles(page, 'main', [
    { name: 'sibling.md', content: '# Sibling\n\nnext to existing' },
  ])

  await expect(treeNote(page, 'Sibling')).toBeVisible()
  await expect.poll(() => folderOfTitle(page, 'Sibling')).toBe('Frontend')
})

test('re-dropping a same-named file WARNS (yellow), never a green "done" (#223)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)
  await dropTextFiles(page, 'main', [{ name: 'once.md', content: '# Once\n\noriginal' }])
  await expect(treeNote(page, 'Once')).toBeVisible()

  // Same name, DIFFERENT content — skipExisting compares the path, not the body, so it
  // skips; that must read as a warning ("content not compared"), not a green success.
  await dropTextFiles(page, 'main', [
    { name: 'once.md', content: '# Once\n\nEDITED — different body' },
  ])
  const warn = page.getByTestId('toast').filter({ hasText: 'already exist' })
  await expect(warn).toBeVisible()
  await expect(warn).toHaveAttribute('data-variant', 'warning')
})

test('an all-failed drop shows the exact durable summary error (#280)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)

  // The write boundary rejects the carried control byte per-note. The durable job
  // itself therefore SUCCEEDS with `{failed:1, errors:[...]}`; the client must read
  // that summary instead of looking only at the terminal job error.
  await dropTextFiles(page, 'main', [
    { name: 'poisoned.md', content: '---\nauthor: safe\0poison\n---\nBody.' },
  ])

  const error = page
    .getByTestId('toast')
    .filter({ hasText: 'frontmatter contains invalid raw lines' })
  await expect(error).toBeVisible()
  await expect(error).toHaveAttribute('data-variant', 'error')
  await expect(treeNote(page, 'poisoned')).toHaveCount(0)
})

// #280 — the dropped file's own frontmatter is the user's data. This is the ONLY
// place the client leg is exercised end to end: a real browser `File` carries the
// mtime, and `useFileImport` has to put it on the wire for a frontmatter-less note
// to be dated by the FILE rather than by the import moment.
test('a dropped file keeps its own title, tags and date (#280)', async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)

  await dropTextFiles(page, 'main', [
    {
      name: 'dogovor.md',
      content:
        '---\ntitle: Договор\ntags: [работа, 2025]\ncreated: 2025-03-14\nauthor: Sergey\n---\n# Черновик\n\nТело.',
    },
  ])

  // Titled by the frontmatter, NOT by the file name — and the differing H1 stays.
  await expect(treeNote(page, 'Договор')).toBeVisible()
  const note = await page.request
    .get(`${baseURL}/api/s/main/notes?limit=50`)
    .then((r) => r.json())
    .then((d) => d.notes.find((n: { filePath: string }) => n.filePath === 'dogovor.md'))
  expect(note.title).toBe('Договор')
  expect(note.createdAt).toBe('2025-03-14T00:00:00.000Z')
  const detail = await page.request
    .get(`${baseURL}/api/s/main/note?ref=${note.id}`)
    .then((r) => r.json())
  expect(detail.frontmatter.tags).toEqual(['работа', '2025'])
  expect(detail.frontmatter.author).toBe('Sergey')
  expect(detail.content).toContain('# Черновик')
})

test('a frontmatter-less drop is dated by the FILE, not by the import moment (#280)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)
  const mtime = Date.UTC(2019, 4, 5, 10)

  await dropTextFiles(page, 'main', [
    { name: 'old note.md', content: '# Old note\n\nbody', lastModified: mtime },
  ])

  await expect(treeNote(page, 'Old note')).toBeVisible()
  const created = await page.request
    .get(`${baseURL}/api/s/main/notes?limit=50`)
    .then((r) => r.json())
    .then((d) => d.notes.find((n: { filePath: string }) => n.filePath === 'old-note.md')?.createdAt)
  expect(created).toBe(new Date(mtime).toISOString())
})

test('drop several files at once → all imported in one go (#223 multi-file)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)

  await dropTextFiles(page, 'main', [
    { name: 'one.md', content: '# One\n\n1' },
    { name: 'two.md', content: '# Two\n\n2' },
    { name: 'three.txt', content: 'plain three', type: 'text/plain' },
  ])

  await expect(treeNote(page, 'One')).toBeVisible()
  await expect(treeNote(page, 'Two')).toBeVisible()
  await expect(treeNote(page, 'three')).toBeVisible() // .txt titled from its filename
})
