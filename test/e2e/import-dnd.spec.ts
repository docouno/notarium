import { type Page } from '@playwright/test'
import AdmZip from 'adm-zip'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  files: Array<{
    name: string
    content?: string
    bytes?: number[]
    type?: string
    lastModified?: number
  }>,
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
          new File([f.bytes ? new Uint8Array(f.bytes) : (f.content ?? '')], f.name, {
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

/** Deliver one synthetic legacy FileSystemEntry tree. The app captures the entry
 * synchronously on drop, then the callbacks intentionally resolve asynchronously. */
const dropFolder = async (
  page: Page,
  targetSel: string,
  files: Array<{
    path: string
    content: string
    type?: string
    lastModified?: number
  }>,
) => {
  await page.evaluate(
    ({ targetSel: sel, files: fs }) => {
      type Leaf = (typeof fs)[number]
      type Directory = { name: string; files: Leaf[]; directories: Map<string, Directory> }
      const paths = fs.map((file) => file.path.split('/'))
      const rootName = paths[0]?.[0]

      if (!rootName || paths.some((parts) => parts[0] !== rootName || parts.length < 2)) {
        throw new Error('the synthetic folder needs one common root')
      }
      const tree: Directory = { name: rootName, files: [], directories: new Map() }

      fs.forEach((file, index) => {
        const parts = paths[index]
        let directory = tree

        for (const name of parts.slice(1, -1)) {
          let child = directory.directories.get(name)

          if (!child) {
            child = { name, files: [], directories: new Map() }
            directory.directories.set(name, child)
          }
          directory = child
        }
        directory.files.push({ ...file, path: parts.at(-1)! })
      })

      const fileEntry = (file: Leaf, parentPath: string): FileSystemFileEntry =>
        ({
          isFile: true,
          isDirectory: false,
          name: file.path,
          fullPath: `${parentPath}/${file.path}`,
          file: (success: FileCallback) =>
            queueMicrotask(() =>
              success(
                new File([file.content], file.path, {
                  type: file.type ?? 'text/markdown',
                  ...(file.lastModified ? { lastModified: file.lastModified } : {}),
                }),
              ),
            ),
        }) as FileSystemFileEntry

      const directoryEntry = (directory: Directory, parentPath = ''): FileSystemDirectoryEntry => {
        const fullPath = `${parentPath}/${directory.name}`

        return {
          isFile: false,
          isDirectory: true,
          name: directory.name,
          fullPath,
          createReader: () => {
            let read = false

            return {
              readEntries: (success: FileSystemEntriesCallback) => {
                const entries = read
                  ? []
                  : [
                      ...[...directory.directories.values()].map((child) =>
                        directoryEntry(child, fullPath),
                      ),
                      ...directory.files.map((file) => fileEntry(file, fullPath)),
                    ]

                read = true
                queueMicrotask(() => success(entries))
              },
            } as FileSystemDirectoryReader
          },
        } as FileSystemDirectoryEntry
      }

      const anchor = document.querySelector(sel)

      if (!anchor) {
        throw new Error(`no drop target for ${sel}`)
      }
      const rect = anchor.getBoundingClientRect()
      const clientX = Math.round(rect.left + rect.width / 2)
      const clientY = Math.round(rect.top + rect.height / 2)
      const at = document.elementFromPoint(clientX, clientY) ?? anchor
      const transfer = new DataTransfer()
      const item = transfer.items.add(new File([], rootName))

      if (!item) {
        throw new Error('could not create a synthetic DataTransfer item')
      }
      // Chromium may hand Array.from(DataTransferItemList) a fresh DOM wrapper,
      // so an expando on `item` is not a reliable method override. Patch its
      // prototype only for the synchronous event dispatch, then restore it.
      const itemPrototype = Object.getPrototypeOf(item) as object
      const originalEntryMethod = Object.getOwnPropertyDescriptor(itemPrototype, 'webkitGetAsEntry')

      Object.defineProperty(itemPrototype, 'webkitGetAsEntry', {
        configurable: true,
        value: () => directoryEntry(tree),
      })
      const fire = (type: string) =>
        at.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX,
            clientY,
          }),
        )

      try {
        fire('dragenter')
        fire('dragover')
        fire('drop')
      } finally {
        if (originalEntryMethod) {
          Object.defineProperty(itemPrototype, 'webkitGetAsEntry', originalEntryMethod)
        } else {
          delete (itemPrototype as { webkitGetAsEntry?: unknown }).webkitGetAsEntry
        }
      }
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

test('Settings ordinary picker imports a Markdown file offered by its native filter', async ({
  page,
  baseURL,
}) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'notarium-file-picker-'))
  const notePath = join(fixtureRoot, 'picked.mdown')

  try {
    await writeFile(notePath, '# Picked Markdown\n\nImported from Settings.')
    await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
    await page.goto('/s/main/management/import')
    await waitForAppReady(page)

    const input = page.getByTestId('import-file')

    await expect(input).toHaveAttribute('accept', /\.mdown/)
    await input.setInputFiles(notePath)
    await expect(page.getByText('picked.mdown')).toBeVisible()
    await expect(page.getByTestId('import-run')).toBeEnabled()
    await page.getByTestId('import-run').click()

    await expect(page.getByTestId('import-summary')).toContainText('Imported 1 note')
    await expect(treeNote(page, 'Picked Markdown')).toBeVisible()
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('Settings folder picker snapshots the native directory selection before clearing it', async ({
  page,
  baseURL,
}) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'notarium-folder-picker-'))
  const vault = join(fixtureRoot, 'vault')

  try {
    await mkdir(join(vault, 'nested'), { recursive: true })
    await writeFile(join(vault, 'alpha.md'), '# Folder Alpha')
    await writeFile(join(vault, 'nested', 'beta.txt'), 'Folder Beta')
    await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
    await page.goto('/s/main/management/import')
    await waitForAppReady(page)

    await page.getByTestId('import-folder').setInputFiles(vault)

    await expect(page.getByText('vault/ (2 items)')).toBeVisible()
    await expect(page.getByTestId('import-run')).toBeEnabled()
    await page.getByTestId('import-run').click()
    await expect(page.getByTestId('import-summary')).toContainText('Imported 2 notes')
    const paths = await page.request
      .get(`${baseURL}/api/s/main/notes?limit=50`)
      .then((response) => response.json())
      .then((body) => body.notes.map((note: { filePath: string }) => note.filePath))

    expect(paths).toContain('vault/alpha.md')
    expect(paths).toContain('vault/nested/beta.md')
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

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
  await expect(page.getByTestId('toast').filter({ hasText: 'Imported 1 note' })).toBeVisible()
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

test('drop a folder onto a tree row → its wrapper and nested paths land under that row', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)
  await expect(page.locator(folderSel('Frontend'))).toBeVisible()

  await dropFolder(page, folderSel('Frontend'), [
    { path: 'vault/nested/alpha.md', content: '# Folder Alpha' },
    { path: 'vault/notes.txt', content: 'Folder plain text', type: 'text/plain' },
    { path: 'vault/assets/cover.png', content: 'not uploaded', type: 'image/png' },
  ])

  await expect
    .poll(async () => (await page.getByTestId('toast').allTextContents()).join('\n'))
    .toContain('Imported 2 notes')
  const paths = await page.request
    .get(`${baseURL}/api/s/main/notes?limit=50`)
    .then((response) => response.json())
    .then((body) => body.notes.map((note: { filePath: string }) => note.filePath))

  expect(paths).toContain('Frontend/vault/nested/alpha.md')
  expect(paths).toContain('Frontend/vault/notes.md')
  const warning = page.getByTestId('toast').filter({ hasText: '1 unsupported' })
  await expect(warning).toHaveAttribute('data-variant', 'warning')
})

test('drop a folder in the reader → it keeps the wrapper beside the open note', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)
  await expect(treeNote(page, 'existing')).toBeVisible()
  await treeNote(page, 'existing').click()
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Frontend')

  await dropFolder(page, 'main', [{ path: 'research/sub/beta.mdown', content: '# Folder Beta' }])

  await expect
    .poll(async () => (await page.getByTestId('toast').allTextContents()).join('\n'))
    .toContain('Imported 1 note')
  const paths = await page.request
    .get(`${baseURL}/api/s/main/notes?limit=50`)
    .then((response) => response.json())
    .then((body) => body.notes.map((note: { filePath: string }) => note.filePath))

  expect(paths).toContain('Frontend/research/sub/beta.md')
})

test('drop one Markdown ZIP → the auto classifier imports its tree without opening one note', async ({
  page,
  baseURL,
}) => {
  const archive = new AdmZip()

  archive.addFile('vault/nested/from-archive.md', Buffer.from('# From archive'))
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)

  await dropTextFiles(page, 'main', [
    {
      name: 'vault.zip',
      bytes: [...archive.toBuffer()],
      type: 'application/zip',
    },
  ])

  await expect(page.getByTestId('toast').filter({ hasText: 'Imported 1 note' })).toBeVisible()
  const paths = await page.request
    .get(`${baseURL}/api/s/main/notes?limit=50`)
    .then((response) => response.json())
    .then((body) => body.notes.map((note: { filePath: string }) => note.filePath))

  expect(paths).toContain('vault/nested/from-archive.md')
  await expect(page).toHaveURL('/s/main')
})

test('a top-level ZIP mixed with another file is refused before any import request', async ({
  page,
  baseURL,
}) => {
  const archive = new AdmZip()
  let importRequests = 0

  archive.addFile('vault/from-archive.md', Buffer.from('# From archive'))
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/s/main/import') {
      importRequests++
    }
  })
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)

  await dropTextFiles(page, 'main', [
    { name: 'vault.zip', bytes: [...archive.toBuffer()], type: 'application/zip' },
    { name: 'beside.md', content: '# Beside' },
  ])

  await expect(
    page.getByTestId('toast').filter({ hasText: 'A ZIP archive must be dropped on its own' }),
  ).toBeVisible()
  expect(importRequests).toBe(0)
  const titles = await page.request
    .get(`${baseURL}/api/s/main/notes?limit=50`)
    .then((response) => response.json())
    .then((body) => body.notes.map((note: { title: string }) => note.title))

  expect(titles).toEqual(['existing'])
})

test('an ambiguous all-null drop shows capability help without a partial request', async ({
  page,
  baseURL,
}) => {
  let importRequests = 0

  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/s/main/import') {
      importRequests++
    }
  })
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)

  await dropTextFiles(page, 'main', [
    { name: 'vault.v1', content: '', type: '' },
    { name: 'beside.md', content: '# Beside' },
  ])

  const notice = page
    .getByTestId('toast')
    .filter({ hasText: 'This browser could not fully read the dropped items' })

  await expect(notice).toBeVisible()
  await expect(notice.getByRole('button', { name: 'Open Import settings' })).toBeVisible()
  expect(importRequests).toBe(0)
})

test('drop one foreign ZIP → it stays on the existing export classifier', async ({
  page,
  baseURL,
}) => {
  const archive = new AdmZip()

  archive.addFile(
    'conversations.json',
    Buffer.from(
      JSON.stringify([
        {
          uuid: 'foreign-1',
          name: 'Foreign conversation',
          created_at: '2024-03-15T14:30:00Z',
          chat_messages: [{ sender: 'human', text: 'Hello from Claude' }],
        },
      ]),
    ),
  )
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  await waitForAppReady(page)

  await dropTextFiles(page, 'main', [
    {
      name: 'claude.zip',
      bytes: [...archive.toBuffer()],
      type: 'application/zip',
    },
  ])

  await expect(page.getByTestId('toast').filter({ hasText: 'Imported 1 note' })).toBeVisible()
  const titles = await page.request
    .get(`${baseURL}/api/s/main/notes?limit=50`)
    .then((response) => response.json())
    .then((body) => body.notes.map((note: { title: string }) => note.title))

  expect(titles).toContain('Foreign conversation')
  await expect(page).toHaveURL('/s/main')
})
