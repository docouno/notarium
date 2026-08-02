import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The personal layer's UI leg (#13 I4): the human curates their Profile (the
// always-load note an agent reads at session start) under Settings, and audits
// what agents recorded about them under Agents → Memory. The backend contract
// (mint, provenance, edit/forget) is pinned in test/fake-server/personalLayer.test.ts;
// this spec covers the screens — the form saves and rides into the chrome, and
// the Memory feed renders its honest empty state for a user nothing's been
// remembered about yet. Runs password-mode (a personal domain is a user concept).

const WORLD = {
  now: '2026-06-14T12:00:00.000Z',
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
    // sam's personal domain, pre-seeded but empty — nothing remembered yet.
    { slug: 'sam-personal', displayName: 'Personal', notes: [] },
  ],
  auth: {
    users: [
      {
        username: 'sam',
        password: 'sam-password-1',
        displayName: 'Sam',
        personalSpace: 'sam-personal',
      },
    ],
    members: [
      { space: 'main', username: 'sam', role: 'owner' },
      { space: 'sam-personal', username: 'sam', role: 'owner' },
    ],
  },
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: WORLD } })
})

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
})

const login = async (page: Page, username: string, password: string) => {
  await page.goto('/')
  await page.getByTestId('auth-username').fill(username)
  await page.getByTestId('auth-password').fill(password)
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('auth-login')).not.toBeVisible()
}

test('the Profile tab saves the always-load note and the new name reaches the chrome', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile')).toBeVisible()

  await page.getByTestId('profile-display-name').fill('Sam the Founder')
  await page.getByTestId('profile-content').fill('Prefer short answers with concrete examples.')
  await page.getByTestId('profile-save').click()

  // The save lands (no error surfaces) and the new display name rides `me` into
  // the sidebar profile control — the activity strip's avatar carries it as its
  // tooltip now (#103: the profile is icon-only on the permanent strip, no name row).
  await expect(page.getByTestId('profile-error')).toHaveCount(0)
  await expect(page.getByTestId('profile-menu')).toHaveAttribute('title', 'Sam the Founder')

  // Reload → the persisted values come back from the server (the note exists now).
  await page.reload()
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-display-name')).toHaveValue('Sam the Founder')
  await expect(page.getByTestId('profile-content')).toHaveValue(
    'Prefer short answers with concrete examples.',
  )
})

test('the Agents surface shows the memory tree empty state when nothing is remembered yet', async ({
  page,
}) => {
  await login(page, 'sam', 'sam-password-1')

  // The memory audit is the explorer's «Memory» tree now (#165) — the Agents rail
  // auto-switches the sidebar to it; with nothing remembered it reads its empty state.
  await page.goto('/agents/context/personal')
  await expect(page.getByTestId('agents-context')).toBeVisible()
  await expect(page.getByTestId('memory-tree-empty')).toBeVisible()
})
