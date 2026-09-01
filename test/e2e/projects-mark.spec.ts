import { expect, test } from './fixtures'

// Mark-as-project (#13 I4): the human marks a folder in the tree and it becomes
// a project an agent can address by handle. The capability is visible — a badge
// on the folder row + a contextual Mark/Unmark in the right-click menu — and the
// tree shares ONE source of truth (ProjectsProvider) with the space-management
// Projects list. Runs in mode 'none' (the base fixture): the single principal
// manages everything, so the actions are available without a sign-in.

test('mark a folder as a project from the tree, see it in management, then unmark', async ({
  page,
}) => {
  await page.goto('/')
  const demo = page.locator('[data-testid="tree-folder"][data-path="demo"]')
  await expect(demo).toBeVisible()
  // Not a project yet — no badge, and the menu offers "Mark as project".
  await expect(demo.getByTestId('project-badge')).toHaveCount(0)

  // right-click → Mark as project → confirm the dialog
  await demo.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Mark as project' }).click()
  await page.getByRole('button', { name: 'Mark as project' }).click()

  // The badge appears on the folder row…
  await expect(demo.getByTestId('project-badge')).toBeVisible()
  // …and the menu is now contextual — the SAME folder offers "Unmark project"
  // (proves the shared provider state updated, not just a local optimistic flag).
  await demo.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Unmark project' })).toBeVisible()
  await page.keyboard.press('Escape') // close the menu without acting

  // The space-management Projects list reflects it — one source of truth.
  await page.goto('/s/main/management/projects')
  await expect(page.getByTestId('projects-list')).toContainText('main/demo')

  // Unmark from the tree → badge gone. Wait for the badge first: a cold goto
  // re-fetches projects, and the menu's items are a snapshot taken when it opens,
  // so the right-click must land AFTER the row is known (else it offers "Mark").
  await page.goto('/')
  await expect(demo.getByTestId('project-badge')).toBeVisible()
  await demo.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Unmark project' }).click()
  await page.getByRole('button', { name: 'Unmark' }).click()
  await expect(demo.getByTestId('project-badge')).toHaveCount(0)
})

// Create a NEW empty project (#13 C): the + is a menu (New note / New folder /
// New project); a project is born as a FRESH marked folder with no notes, and shows
// in the tree as an empty project folder anyway — the server tree (#97) unions the
// directory channel + project registry into the skeleton, so a project is
// first-class, never invisible (no client-side withProjectFolders crutch).
test('create a new empty project from the + menu — it shows as an empty project folder + in management', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('new-menu').click()
  await page.getByRole('menuitem', { name: 'New project' }).click()
  await page.getByTestId('dialog-prompt-input').fill('Roadmap')
  await page.getByRole('button', { name: 'Create project' }).click()

  // The empty project appears in the tree as a project folder (briefcase badge),
  // with zero notes — the whole point of C (no seed note, still visible).
  const roadmap = page.locator('[data-testid="tree-folder"][data-path="Roadmap"]')
  await expect(roadmap).toBeVisible()
  await expect(roadmap.getByTestId('project-badge')).toBeVisible()

  // The project directory was admitted through the same store-backed channel as
  // an ordinary folder, so its first page can materialize immediately — no
  // restart/reconcile and no marker-only ghost in between.
  await roadmap.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open page' }).click()
  await expect(page.getByTestId('virtual-folder-page')).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.cm-content')
  await editor.fill('# Roadmap\n\nThe project overview.')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(/\/n\/.+\/roadmap$/)
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(
    page.getByRole('menuitem', { name: 'Unpin folder page from agent context' }),
  ).toBeVisible()

  // One source of truth — the space-management Projects list shows it too.
  await page.goto('/s/main/management/projects')
  await expect(page.getByTestId('projects-list')).toContainText('main/roadmap')
})

// Nav lighting (#13/#94): a chrome-only surface (Agents) must not keep a tree
// note lit — the rail retains activeId only to restore it on return to Files.
test('the Agents surface does not keep a tree note highlighted', async ({ page }) => {
  await page.goto('/')
  const carbon = page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')
  await carbon.click()
  await expect(
    page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"][aria-current="page"]'),
  ).toBeVisible()

  await page.getByTestId('rail-agents').click()
  await expect(page.locator('[data-testid="tree-note"][aria-current="page"]')).toHaveCount(0)
})
