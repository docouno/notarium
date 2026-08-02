import { type Page } from '@playwright/test'
import { expect, test, treeNote } from './fixtures'

// #100 phase 4 / #123 — renaming a space from the UI, link-safely and live:
//  • RENAME: an owner changes the slug + display name in the General tab. The slug is
//    a mutable URL handle over a stable id — a changed one retires the old slug into
//    the alias history, so a bookmarked `/s/<old>` URL keeps resolving and redirects.
//  • CROSS-TAB: a rename from another context reaches an open tab live via the named
//    `rename` SSE nudge — no reload, and crucially NO false `space-lost` takeover (the
//    active slug lags the renamed space for a render; the alias-aware access
//    classifier keeps the verdict `ok`).
//  • GATING: renaming is an owner-need management act — a writer/reader never sees the
//    General tab (mirrors the #121 read-only chrome rule).
//
// Against the fake's REAL buildApp + createAuthService + the #127 space registry, so
// the PATCH endpoint, the slug↔id seam and the SSE broadcast are all exercised end to
// end (the fake mints an opaque space-id ≠ slug, exactly as a meta-DB host does).

const RENAME_WORLD = {
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
  auth: {
    users: [
      { username: 'root', password: 'root-password-1', admin: true },
      { username: 'bob', password: 'bob-password-01' },
      { username: 'ron', password: 'ron-password-01' },
    ],
    members: [
      { space: 'main', username: 'root', role: 'owner' },
      { space: 'work', username: 'root', role: 'owner' },
      { space: 'main', username: 'bob', role: 'writer' },
      { space: 'main', username: 'ron', role: 'reader' },
    ],
  },
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: RENAME_WORLD } })
})

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
  await page.evaluate(() => localStorage.removeItem('nt-space'))
})

const login = async (page: Page, username: string, password: string) => {
  await page.getByTestId('auth-username').fill(username)
  await page.getByTestId('auth-password').fill(password)
  await page.getByTestId('auth-submit').click()
}

// A runtime-minted space — config-declared spaces are slug-PINNED (their handle is
// frozen by host config, the PATCH 400s), so the rename tests work on one the owner
// minted, which carries no pin. The creator (root, host-admin) becomes its owner.
const createSpace = async (page: Page, slug: string) => {
  await page.getByTestId('space-switcher').click()
  await page.getByText('New space').click()
  await page.getByTestId('dialog-prompt-input').fill(slug)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(new RegExp(`/s/${slug}$`))
}

test('an owner renames a space: URL canonicalises, the old slug still redirects', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, 'root', 'root-password-1')
  await expect(treeNote(page, 'Main Note')).toBeVisible()
  await createSpace(page, 'scratch')

  await page.goto('/s/scratch/management/general')
  await expect(page.getByTestId('space-slug')).toHaveValue('scratch')

  await page.getByTestId('space-display-name').fill('Crew')
  await page.getByTestId('space-slug').fill('crew')
  await page.getByTestId('space-rename-save').click()

  // The slug change canonicalises the URL to the new handle (SpaceProvider) WITHOUT
  // dropping the tab, and the form re-seeds from the committed record (no longer dirty).
  await expect(page).toHaveURL(/\/s\/crew\/management\/general/)
  await expect(page.getByTestId('space-slug')).toHaveValue('crew')
  // The old slug retired into the alias history — surfaced as "still resolves".
  await expect(page.getByText(/Old handles still resolve:\s*scratch/)).toBeVisible()

  // A bookmarked `/s/scratch` URL keeps working — the server resolves the alias and
  // the client canonicalises the URL to the live handle.
  await page.goto('/s/scratch')
  await expect(page).toHaveURL(/\/s\/crew$/)
  await expect(page.getByTestId('space-switcher')).toContainText('Crew')
})

test('a rename from another tab reaches an open tab live — no reload, no false takeover (#123)', async ({
  page,
  request,
  baseURL,
}) => {
  await page.goto('/')
  await login(page, 'root', 'root-password-1')
  await expect(treeNote(page, 'Main Note')).toBeVisible()
  await createSpace(page, 'scratch') // a renameable runtime space, now open in this tab

  // A second session (another tab) renames `scratch` → `crew`. The server broadcasts
  // the named `rename` SSE event to every live viewer of the space.
  const loggedIn = await request.post(`${baseURL}/api/auth/login`, {
    data: { username: 'root', password: 'root-password-1' },
  })
  expect(loggedIn.ok()).toBeTruthy()
  const renamed = await request.patch(`${baseURL}/api/s/scratch`, {
    data: { slug: 'crew', displayName: 'Crew' },
  })
  expect(renamed.ok()).toBeTruthy()

  // The open tab follows the rename live: the URL canonicalises old→new and the
  // switcher relabels — without a reload.
  await expect(page).toHaveURL(/\/s\/crew$/)
  await expect(page.getByTestId('space-switcher')).toContainText('Crew')
  // The active space was renamed, NOT lost — the alias-aware classifier must keep the
  // verdict `ok`, so no takeover and the content stays put (the structural fix #123).
  await expect(page.getByTestId('space-access-lost')).not.toBeVisible()
})

test('renaming is owner-need: a writer does not see the General tab', async ({ page }) => {
  await page.goto('/')
  await login(page, 'bob', 'bob-password-01')
  await expect(treeNote(page, 'Main Note')).toBeVisible()

  await page.goto('/s/main/management')
  // The members tab is the default landing and is visible to a writer…
  await expect(page.getByTestId('settings-tab-members')).toBeVisible()
  // …but General (rename) is hidden — a writer can't manage the space.
  await expect(page.getByTestId('settings-tab-general')).toHaveCount(0)
})
