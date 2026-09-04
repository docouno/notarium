import { type Page } from '@playwright/test'
import { expect, test, treeNote } from './fixtures'

// Auth (#10): the login gate in front of the app — against a password-mode
// world swapped in via the reset hook (the base fixture stays mode 'none' so
// every other spec keeps its single-principal boot). What the API layer pins
// in test/fake-server/auth.test.ts (401/404 matrices, PAT scoping) is NOT
// re-proven here; this spec covers the UI leg: the gate appears, errors speak,
// a session swaps the gate for the app, membership scopes the chrome.

const AUTH_WORLD = {
  now: '2026-06-10T12:00:00.000Z',
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
      { username: 'bob', password: 'bob-password-01', email: 'bob@example.com' },
    ],
    members: [
      { space: 'main', username: 'root', role: 'owner' },
      { space: 'work', username: 'root', role: 'owner' },
      { space: 'main', username: 'bob', role: 'writer' },
    ],
  },
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: AUTH_WORLD } })
})

test.afterEach(async ({ page, baseURL }) => {
  // Hand the shared fake back to the canonical single-principal fixture.
  await page.request.post(`${baseURL}/api/__test/reset`)
})

const login = async (page: Page, username: string, password: string) => {
  await page.getByTestId('auth-username').fill(username)
  await page.getByTestId('auth-password').fill(password)
  await page.getByTestId('auth-submit').click()
}

test('an anonymous visit lands on the login screen, not the app', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('auth-login')).toBeVisible()
  // Nothing space-scoped boots behind the gate.
  await expect(treeNote(page, 'Main Note')).not.toBeVisible()
})

test('a wrong password shows the generic error and stays on the gate', async ({ page }) => {
  await page.goto('/')
  await login(page, 'root', 'not-the-password')
  await expect(page.getByTestId('auth-error')).toHaveText('Invalid username, email or password.')
  await expect(page.getByTestId('auth-login')).toBeVisible()
})

test('a successful login swaps the gate for the app', async ({ page }) => {
  await page.goto('/')
  await login(page, 'root', 'root-password-1')
  await expect(treeNote(page, 'Main Note')).toBeVisible()
  await expect(page.getByTestId('auth-login')).not.toBeVisible()
})

test('the gate takes the e-mail as well as the handle (#421)', async ({ page }) => {
  await page.goto('/')
  // Any case, any spacing: the address is normalised the way it is stored.
  await login(page, ' Bob@Example.com ', 'bob-password-01')
  await expect(treeNote(page, 'Main Note')).toBeVisible()
  await expect(page.getByTestId('auth-login')).not.toBeVisible()
})

test('an account renames itself under Settings → Account and signs in by the new handle (#421)', async ({
  page,
  baseURL,
}) => {
  await page.goto('/')
  await login(page, 'bob', 'bob-password-01')
  await expect(treeNote(page, 'Main Note')).toBeVisible()

  await page.goto('/settings/account')
  await page.getByTestId('account-username').fill('bob.smith')
  await expect(page.getByTestId('account-rename-note')).toBeVisible()
  await page.getByTestId('account-identity-save').click()
  await expect(page.getByTestId('account-identity-saved')).toBeVisible()
  // The session is the same person: `me` carries the new handle without a relogin.
  const me = await page.request.get(`${baseURL}/api/me`)
  expect(((await me.json()) as { username: string }).username).toBe('bob.smith')

  // The old handle no longer signs in; the new one and the address still do.
  await page.request.post(`${baseURL}/api/auth/logout`)
  await page.goto('/')
  await expect(page.getByTestId('auth-login')).toBeVisible()
  await login(page, 'bob', 'bob-password-01')
  await expect(page.getByTestId('auth-error')).toHaveText('Invalid username, email or password.')
  await login(page, 'bob.smith', 'bob-password-01')
  await expect(treeNote(page, 'Main Note')).toBeVisible()
})

test('the space list is the principal’s grants, not the host’s inventory', async ({ page }) => {
  await page.goto('/')
  await login(page, 'bob', 'bob-password-01')
  await expect(treeNote(page, 'Main Note')).toBeVisible()
  // bob has no grant on `work`: its content is invisible and the switcher
  // doesn't offer it.
  await expect(treeNote(page, 'Work Note')).not.toBeVisible()
  await page.getByTestId('space-switcher').click()
  await expect(page.getByText('Management')).toBeVisible() // the menu is open
  await expect(page.getByText('Work', { exact: true })).not.toBeVisible()
})

test('sign out returns to the login screen', async ({ page }) => {
  await page.goto('/')
  await login(page, 'root', 'root-password-1')
  await expect(treeNote(page, 'Main Note')).toBeVisible()
  await page.getByTestId('profile-menu').click()
  await page.getByText('Sign out').click() // the menu item → opens a confirm (#28)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click() // confirm
  await expect(page.getByTestId('auth-login')).toBeVisible()
  await expect(treeNote(page, 'Main Note')).not.toBeVisible()
})
