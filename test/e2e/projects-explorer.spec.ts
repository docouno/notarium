import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The explorer "Projects" view (#164): the FILES header is a scope picker —
// Files (the whole tree), Projects (only the marked projects, nested ones shown
// in place — no recursion/duplication), or a single project in focus (re-rooted
// to its contents). Switching is a pure CLIENT view filter over the same
// server-authoritative skeleton + project registry, persisted per space.

// A space with a top-level project (Roadmap) that itself CONTAINS a nested project
// (Roadmap/sub), a plain folder (demo), and a root-level note — enough to exercise
// every scope and the project-in-project edge.
const FIXTURE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          title: 'Plan',
          filePath: 'Roadmap/plan.md',
          modifiedAt: '2026-06-08T00:00:00.000Z',
          createdAt: '2026-06-01T09:00:00.000Z',
          tags: [],
          content: '# Plan',
        },
        {
          title: 'Task',
          filePath: 'Roadmap/sub/task.md',
          modifiedAt: '2026-06-08T00:00:00.000Z',
          createdAt: '2026-06-01T09:00:00.000Z',
          tags: [],
          content: '# Task',
        },
        {
          title: 'Idea',
          filePath: 'demo/idea.md',
          modifiedAt: '2026-06-08T00:00:00.000Z',
          createdAt: '2026-06-01T09:00:00.000Z',
          tags: [],
          content: '# Idea',
        },
        {
          title: 'Welcome',
          filePath: 'welcome.md',
          modifiedAt: '2026-06-09T00:00:00.000Z',
          createdAt: '2026-06-05T08:00:00.000Z',
          tags: [],
          content: '# Welcome',
        },
      ],
    },
  ],
  projects: [
    { space: 'main', path: 'Roadmap', slug: 'roadmap', displayName: 'Roadmap' },
    { space: 'main', path: 'Roadmap/sub', slug: 'sub', displayName: 'Sub Project' },
  ],
}

const folder = (page: Page, path: string) =>
  page.locator(`[data-testid="tree-folder"][data-path="${path}"]`)
const note = (page: Page, id: string) => page.locator(`[data-testid="tree-note"][data-id="${id}"]`)

test('switch Files → Projects → single-project focus', async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')

  const picker = page.getByTestId('explorer-scope')
  await expect(picker).toHaveAttribute('data-scope', 'files')
  // Files shows everything: the project, the plain folder, the root note.
  await expect(folder(page, 'Roadmap')).toBeVisible()
  await expect(folder(page, 'demo')).toBeVisible()
  await expect(note(page, 'fake-welcome')).toBeVisible()

  // → Projects: only the marked projects. The nested Roadmap/sub stays IN PLACE
  // under Roadmap (one row, no duplication as a second top-level root); the plain
  // demo folder and the root note are hidden.
  await picker.click()
  await page.getByRole('menuitemradio', { name: 'Projects' }).click()
  await expect(picker).toHaveAttribute('data-scope', 'projects')
  await expect(folder(page, 'Roadmap')).toBeVisible()
  await expect(folder(page, 'Roadmap')).toHaveCount(1)
  await expect(folder(page, 'Roadmap').getByTestId('project-badge')).toBeVisible()
  await expect(folder(page, 'Roadmap/sub')).toHaveCount(1) // nested project, shown once
  await expect(folder(page, 'Roadmap/sub').getByTestId('project-badge')).toBeVisible()
  await expect(folder(page, 'demo')).toHaveCount(0)
  await expect(note(page, 'fake-welcome')).toHaveCount(0)

  // → Focus a single project from its row's context menu (NOT the picker — that
  // doesn't scale past a handful of projects). Re-rooted to its CONTENTS: the
  // Roadmap folder row itself is gone (the header label carries the name); its
  // notes + nested project show; demo stays hidden.
  await folder(page, 'Roadmap').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Focus project' }).click()
  await expect(picker).toHaveAttribute('data-scope', 'project')
  await expect(folder(page, 'Roadmap')).toHaveCount(0) // its own row is implied by the header
  await expect(note(page, 'fake-roadmap-plan')).toBeVisible()
  await expect(folder(page, 'Roadmap/sub')).toBeVisible()
  await expect(folder(page, 'demo')).toHaveCount(0)

  // Back to Files via the picker.
  await picker.click()
  await page.getByRole('menuitemradio', { name: 'Files' }).click()
  await expect(picker).toHaveAttribute('data-scope', 'files')
  await expect(folder(page, 'demo')).toBeVisible()
})

test('a focused project becomes a recent quick-jump in the dropdown', async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')

  const picker = page.getByTestId('explorer-scope')
  await expect(folder(page, 'Roadmap')).toBeVisible()
  // Not focused yet → the dropdown has no project quick-jumps.
  await picker.click()
  await expect(page.getByRole('menuitemradio', { name: 'Roadmap' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Focus Roadmap from its context menu → it enters the recent MRU.
  await folder(page, 'Roadmap').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Focus project' }).click()
  await expect(picker).toHaveAttribute('data-scope', 'project')

  // Leave to Files, then the dropdown offers Roadmap as a recent quick-jump.
  await picker.click()
  await page.getByRole('menuitemradio', { name: 'Files' }).click()
  await picker.click()
  await page.getByRole('menuitemradio', { name: 'Roadmap' }).click()
  await expect(picker).toHaveAttribute('data-scope', 'project')
  await expect(note(page, 'fake-roadmap-plan')).toBeVisible()
})

test('deep-linking a note INSIDE the focused project keeps the focus (no false bounce)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')

  const picker = page.getByTestId('explorer-scope')
  await expect(folder(page, 'Roadmap')).toBeVisible()
  // Focus Roadmap (persists the scope), then reload straight onto a note that
  // lives INSIDE Roadmap. The boot seeds nav.folder='' before the note resolves;
  // the scope must NOT bounce to Files on that transient placeholder — the note is
  // in-scope, so the stored focus has to survive (the inverse of the Q3 case).
  await folder(page, 'Roadmap').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Focus project' }).click()
  await expect(picker).toHaveAttribute('data-scope', 'project')

  await page.goto('/n/fake-roadmap-plan')
  // Give any erroneous bounce a chance to fire, then assert the focus held.
  await expect(picker).toContainText('Roadmap')
  await expect(picker).toHaveAttribute('data-scope', 'project')
  await expect(note(page, 'fake-roadmap-plan')).toBeVisible()
})

test('opening a note outside the focused project bounces the scope back to Files (Q3)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')

  const picker = page.getByTestId('explorer-scope')
  await expect(folder(page, 'Roadmap')).toBeVisible()
  // Focus Roadmap from its context menu (persists the scope for the reload below).
  await folder(page, 'Roadmap').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Focus project' }).click()
  await expect(picker).toHaveAttribute('data-scope', 'project')

  // Deep-link straight to a note OUTSIDE Roadmap (the demo note). The stored focus
  // would hide it from the tree, so the explorer falls back to Files once the note
  // + project registry land — the open note must always be revealable.
  await page.goto('/n/fake-demo-idea')
  await expect(picker).toHaveAttribute('data-scope', 'files')
  await expect(folder(page, 'demo')).toBeVisible()
})

test('Projects view is empty until a folder is marked; marking it adds it to the picker', async ({
  page,
  baseURL,
}) => {
  // Base fixture: no projects seeded — the Projects view is the actionable empty
  // state, and marking a folder makes it appear (one source of truth).
  await page.request.post(`${baseURL}/api/__test/reset`)
  await page.goto('/s/main')

  const picker = page.getByTestId('explorer-scope')
  await picker.click()
  await page.getByRole('menuitemradio', { name: 'Projects' }).click()
  await expect(page.getByTestId('projects-empty')).toBeVisible()

  // Mark demo as a project from the tree (works in mode 'none').
  await picker.click()
  await page.getByRole('menuitemradio', { name: 'Files' }).click()
  const demo = folder(page, 'demo')
  await demo.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Mark as project' }).click()
  await page.getByRole('button', { name: 'Mark as project' }).click()
  await expect(demo.getByTestId('project-badge')).toBeVisible()

  // It can now be focused from its context menu — re-rooted to its contents.
  await demo.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Focus project' }).click()
  await expect(picker).toHaveAttribute('data-scope', 'project')
  await expect(note(page, 'fake-demo-carbon')).toBeVisible()
})
