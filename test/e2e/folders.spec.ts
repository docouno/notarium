import { expect, test } from './fixtures'

// Folders are first-class (#97): a plain (unmarked) folder can be created from the
// tree, is durable on disk (never-prune), shows via the server's directory channel,
// and a whole folder can be deleted in one act. Runs in mode 'none' (base fixture):
// the single principal manages everything, so the actions are available without a
// sign-in. The base fixture has a `demo` folder holding notes.

test('New folder from a folder menu creates a durable child folder in the tree', async ({
  page,
}) => {
  await page.goto('/')
  const demo = page.locator('[data-testid="tree-folder"][data-path="demo"]')
  await expect(demo).toBeVisible()

  await demo.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New folder' }).click()
  await page.getByTestId('dialog-prompt-input').fill('drafts')
  await page.getByRole('button', { name: 'Create folder' }).click()

  // The new child folder appears (empty, no project badge — it is a plain folder).
  const drafts = page.locator('[data-testid="tree-folder"][data-path="demo/drafts"]')
  await expect(drafts).toBeVisible()
  await expect(drafts.getByTestId('project-badge')).toHaveCount(0)
})

test('New folder from the root + menu creates a top-level folder', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('new-menu').click()
  await page.getByRole('menuitem', { name: 'New folder' }).click()
  await page.getByTestId('dialog-prompt-input').fill('inbox')
  await page.getByRole('button', { name: 'Create folder' }).click()

  await expect(page.locator('[data-testid="tree-folder"][data-path="inbox"]')).toBeVisible()
})

test('renaming a folder relocates it — the OLD folder does not linger as a duplicate (#97)', async ({
  page,
}) => {
  await page.goto('/')
  const demo = page.locator('[data-testid="tree-folder"][data-path="demo"]')
  await expect(demo).toBeVisible()

  await demo.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const input = page.getByTestId('rename-input')
  await input.fill('demo-renamed')
  await input.press('Enter')

  // Exactly ONE folder, at the new path — the old `demo` is gone (the dup-on-rename
  // bug showed BOTH a stale `demo` and a fresh `demo-renamed`).
  await expect(page.locator('[data-testid="tree-folder"][data-path="demo-renamed"]')).toHaveCount(1)
  await expect(page.locator('[data-testid="tree-folder"][data-path="demo"]')).toHaveCount(0)
})

test('a renamed folder stays expanded — its open state survives the path change (#97)', async ({
  page,
}) => {
  // The bug: openSet is keyed by folder PATH (folders carry no id), so a rename —
  // which changes the path — left the old key stranded and the relocated folder
  // read as collapsed, snapping shut the moment the new skeleton landed. The fix
  // carries the expansion across the rename and self-heals the stale key.
  await page.goto('/')
  const demo = page.locator('[data-testid="tree-folder"][data-path="demo"]')
  await expect(demo).toBeVisible()
  // Top-level folders auto-expand on first load, so a child note is visible — the
  // observable proxy for "this folder is expanded".
  await expect(page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')).toBeVisible()

  await demo.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const input = page.getByTestId('rename-input')
  await input.fill('demo-renamed')
  await input.press('Enter')

  // The folder relocated…
  await expect(page.locator('[data-testid="tree-folder"][data-path="demo-renamed"]')).toBeVisible()
  // …and it is STILL EXPANDED: its child note re-appears under the new path
  // instead of the folder collapsing shut.
  await expect(page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')).toBeVisible()
})

test('a DnD-moved folder stays expanded under its new parent (#97)', async ({ page }) => {
  // The SECOND path through carryOpenAcross (the first is rename, above): dragging
  // an expanded folder into another folder relocates its path, and the expansion
  // must follow it. Drag `demo` (auto-expanded, holding notes) into `archive`.
  await page.goto('/')
  await expect(page.locator('[data-testid="tree-folder"][data-path="demo"]')).toBeVisible()
  await expect(page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')).toBeVisible()

  await page.evaluate(() => {
    const handle = document.querySelector(
      '[data-testid="tree-folder"][data-path="demo"] button[draggable="true"]',
    ) as HTMLElement
    const onto = document.querySelector(
      '[data-testid="tree-folder"][data-path="archive"]',
    ) as HTMLElement // data-drop-folder="archive"
    const dt = new DataTransfer()
    const fire = (el: HTMLElement, t: string) =>
      el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }))
    fire(handle, 'dragstart')
    fire(onto, 'dragover')
    fire(onto, 'drop')
  })

  // The folder landed under archive…
  await expect(page.locator('[data-testid="tree-folder"][data-path="archive/demo"]')).toBeVisible()
  await expect(page.locator('[data-testid="tree-folder"][data-path="demo"]')).toHaveCount(0)
  // …still expanded: its note shows under the new path (carryOpenAcross carried
  // the open state; without it the moved folder would read as collapsed).
  await expect(page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')).toBeVisible()
})

test('a DnD drop clears the source dim even if the native dragend never fires (#97)', async ({
  page,
}) => {
  // The bug: `dragId` (the `.dragging` opacity-.4 dim) was cleared ONLY on the
  // native `dragend`, which an optimistic move (#94) swallows because it relocates
  // the dragged row's DOM on `drop` (before dragend) — so the row stayed stuck
  // dimmed and masked the `.just-moved` landing flash. The fix clears `dragId` in
  // the drop handler. Here we dispatch the sequence WITHOUT dragend (exactly the
  // native-lost-dragend shape) and assert the source is not left dimmed.
  await page.goto('/')
  const src = page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')
  await expect(src).toBeVisible()

  await page.evaluate(() => {
    const carbon = document.querySelector(
      '[data-testid="tree-note"][data-id="fake-demo-carbon"]',
    ) as HTMLElement
    const onto = (
      document.querySelector(
        '[data-testid="tree-note"][data-id="fake-demo-titanium"]',
      ) as HTMLElement
    ).parentElement as HTMLElement // same folder → a no-op move, but the drop still runs
    const dt = new DataTransfer()
    const fire = (el: HTMLElement, t: string) =>
      el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }))
    fire(carbon, 'dragstart')
    fire(onto, 'dragover')
    fire(onto, 'drop')
    // deliberately NO dragend — the native event the relocation eats
  })

  // The source row must NOT be stuck dimmed (`.dragging`).
  const stuck = await page.evaluate(() => {
    const wrap = document
      .querySelector('[data-testid="tree-note"][data-id="fake-demo-carbon"]')!
      .closest('[data-drop-folder]')!
    return /_dragging_/.test(wrap.className)
  })
  expect(stuck).toBe(false)
})

test('deleting a folder removes it and the notes inside, in one act', async ({ page }) => {
  await page.goto('/')
  const demo = page.locator('[data-testid="tree-folder"][data-path="demo"]')
  await expect(demo).toBeVisible()

  await demo.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  // The confirm names the note count — accept it.
  await page.getByRole('button', { name: 'Delete' }).click()

  // The folder (and its subtree) is gone from the tree.
  await expect(page.locator('[data-testid="tree-folder"][data-path="demo"]')).toHaveCount(0)
})
