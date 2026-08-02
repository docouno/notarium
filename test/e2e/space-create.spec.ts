import { type Page } from '@playwright/test'
import { expect, test, treeNote } from './fixtures'

// #154 — the creator of a fresh space must be able to write in it IMMEDIATELY, with no
// relogin and no "invite someone else" workaround. The owner grant IS minted server-side
// on POST /api/spaces, but it lives in `me.spaces` — loaded once at boot. createSpace
// reflects that grant locally (addLocalGrant) after a successful mint so canWriteSpace
// sees it BEFORE the tab lands in the space; otherwise the empty space shows the read-only
// splash (no "New note") until the user reloads. (#155, the cross-tab half of the same
// silent-grant root, is pinned server-side in test/fake-server/auth.test.ts — the `access`
// nudge that wakes the creator's OTHER tabs.)

const WORLD = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'home',
      displayName: 'Home',
      notes: [
        {
          title: 'Home Note',
          filePath: 'home/Home Note.md',
          modifiedAt: '2026-06-08T00:00:00.000Z',
          createdAt: '2026-06-01T09:00:00.000Z',
          tags: [],
          content: '# Home Note\n\nlives in home',
        },
      ],
    },
  ],
  // A mintable host so the switcher offers "New space" and POST /api/spaces is live.
  capabilities: { spaceCreate: true },
  auth: {
    // Minting a space is an admin act (spaces:create need:'admin'); admin does NOT
    // itself confer space:write, so the post-create owner grant is what lets the
    // creator write — the grant this test proves reaches the chrome without a reload.
    users: [{ username: 'bob', password: 'bob-password-01', admin: true }],
    members: [{ space: 'home', username: 'bob', role: 'owner' }],
  },
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: WORLD } })
})

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
})

const login = async (page: Page, username: string, password: string) => {
  await page.getByTestId('auth-username').fill(username)
  await page.getByTestId('auth-password').fill(password)
  await page.getByTestId('auth-submit').click()
}

test('the owner of a freshly created space can write in it immediately, no relogin (#154)', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, 'bob', 'bob-password-01')
  await expect(treeNote(page, 'Home Note')).toBeVisible() // session settled, bob is in `home`

  // Mint a new space from the switcher — a human name, the server derives the handle (#123).
  await page.getByTestId('space-switcher').click()
  await page.getByText('New space', { exact: true }).click()
  await page.getByTestId('dialog-prompt-input').fill('Research')
  await page.getByRole('button', { name: 'Create' }).click()

  // We land in the empty new space — and the write affordance is THERE: the owner grant was
  // reflected into `me.spaces` locally (addLocalGrant), so canWriteSpace is true. Before the
  // fix this showed the read-only splash (no "New note") until a reload.
  await expect(page).toHaveURL(/\/s\/research$/)
  await expect(page.getByRole('button', { name: 'New note' })).toBeVisible()
})
