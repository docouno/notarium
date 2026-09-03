import { expect, test } from './fixtures'

const WORLD = {
  now: '2026-08-30T10:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          title: 'Mine main',
          filePath: 'work/mine.md',
          modifiedAt: '2026-08-29T10:00:00.000Z',
          createdAt: '2026-08-20T10:00:00.000Z',
          tags: [],
          content: '# Mine main',
        },
        {
          title: 'Bob main',
          filePath: 'work/bob.md',
          modifiedAt: '2026-08-29T11:00:00.000Z',
          createdAt: '2026-08-20T11:00:00.000Z',
          tags: [],
          content: '# Bob main',
        },
      ],
      activity: [
        {
          date: '2026-08-29T10:00:00.000Z',
          kind: 'edited',
          title: 'Mine main',
          noteId: 'fake-work-mine',
          principal: 'user:alice',
        },
        {
          date: '2026-08-29T11:00:00.000Z',
          kind: 'edited',
          title: 'Bob main',
          noteId: 'fake-work-bob',
          principal: 'user:bob',
        },
      ],
    },
    {
      slug: 'solo',
      displayName: 'Solo',
      notes: [
        {
          title: 'Mine solo',
          filePath: 'solo/mine.md',
          modifiedAt: '2026-08-29T12:00:00.000Z',
          createdAt: '2026-08-20T12:00:00.000Z',
          tags: [],
          content: '# Mine solo',
        },
      ],
      activity: [
        {
          date: '2026-08-29T12:00:00.000Z',
          kind: 'edited',
          title: 'Mine solo',
          noteId: 'fake-solo-mine',
          principal: 'user:alice',
        },
      ],
    },
  ],
  auth: {
    users: [
      { username: 'alice', password: 'alice-password-1', admin: true },
      { username: 'bob', password: 'bob-password-01' },
    ],
    members: [
      { space: 'main', username: 'alice', role: 'owner' },
      { space: 'main', username: 'bob', role: 'writer' },
      { space: 'solo', username: 'alice', role: 'owner' },
    ],
  },
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: WORLD } })
  await page.addInitScript(() => {
    localStorage.setItem('bm-dashboard-activity-group', 'folder')
    localStorage.setItem('bm-dashboard-activity-scope', 'mine')
  })
})

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
})

test('saved Folder + Mine waits for the gate and survives reload and Space switches', async ({
  page,
}) => {
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  let delayed = false

  await page.route('**/api/s/main/activity/groups?**', async (route) => {
    const url = new URL(route.request().url())

    if (!delayed && !url.searchParams.has('author')) {
      delayed = true
      await gate
    }
    await route.continue()
  })
  await page.goto('/')
  await page.getByTestId('auth-username').fill('alice')
  await page.getByTestId('auth-password').fill('alice-password-1')
  await page.getByTestId('auth-submit').click()

  await expect(
    page.getByTestId('activity-heatmap').locator('[data-skeleton]').first(),
  ).toBeVisible()
  await expect(page.getByTestId('dashboard-activity-folder-group')).toHaveCount(0)

  releaseGate()
  await expect(page.getByTestId('dashboard-activity-folder-group')).toBeVisible()
  await page.getByRole('button', { name: /Expand notes in Folder · work/ }).press('Enter')
  await expect(page.getByTestId('dashboard-activity-note-group')).toContainText('Mine main')
  const groupControl = page.getByRole('group', { name: 'Group activity' })
  const scopeControl = page.getByRole('group', { name: 'Activity author scope' })

  await expect(groupControl.getByRole('button', { name: 'Folder' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(scopeControl.getByRole('button', { name: 'Mine' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page.reload()
  await expect(groupControl.getByRole('button', { name: 'Folder' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(scopeControl.getByRole('button', { name: 'Mine' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page.goto('/s/solo')
  await expect(page.getByTestId('dashboard-activity-folder-group')).toBeVisible()
  await page.getByRole('button', { name: /Expand notes in Folder · solo/ }).press('Enter')
  await expect(page.getByTestId('dashboard-activity-note-group')).toContainText('Mine solo')
  await expect(page.getByRole('group', { name: 'Activity author scope' })).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('bm-dashboard-activity-scope'))).toBe(
    'mine',
  )

  await page.goto('/s/main')
  await expect(page.getByRole('group', { name: 'Activity author scope' })).toBeVisible()
  await expect(
    page
      .getByRole('group', { name: 'Activity author scope' })
      .getByRole('button', { name: 'Mine' }),
  ).toHaveAttribute('aria-pressed', 'true')
})

test('the author segment paints the click and never labels the other scope', async ({ page }) => {
  // Note rows tell the scopes apart ('Bob main' exists only under Everyone), and
  // the stored Mine from beforeEach is cleared so the journey starts on Everyone.
  await page.addInitScript(() => {
    localStorage.setItem('bm-dashboard-activity-group', 'note')
    localStorage.removeItem('bm-dashboard-activity-scope')
  })
  await page.goto('/')
  await page.getByTestId('auth-username').fill('alice')
  await page.getByTestId('auth-password').fill('alice-password-1')
  await page.getByTestId('auth-submit').click()

  const feed = page.getByTestId('activity-feed')
  const rows = feed.getByTestId('dashboard-activity-note-group')
  const scopeControl = page.getByRole('group', { name: 'Activity author scope' })

  await expect(rows).toHaveCount(2)
  await expect(scopeControl.getByRole('button', { name: 'Everyone' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // One rAF probe samples the control's presence, its pressed segment and the row
  // set together, so a label and the rows it stands over are read in one frame.
  await page.evaluate(() => {
    type Sample = { control: boolean; mine: boolean; everyone: boolean; rows: number; bob: boolean }
    type Probe = { samples: Sample[]; stop: () => void }
    const probeWindow = window as Window & { __notariumScopeProbe?: Probe }
    const samples: Sample[] = []
    let running = true

    const tick = () => {
      const control = document.querySelector('[role="group"][aria-label="Activity author scope"]')
      const pressed = (label: string) =>
        [...(control?.querySelectorAll('button') ?? [])].some(
          (button) =>
            button.textContent?.trim() === label && button.getAttribute('aria-pressed') === 'true',
        )
      const rowNodes = [
        ...document.querySelectorAll('[data-testid="dashboard-activity-note-group"]'),
      ]

      samples.push({
        control: control != null,
        mine: pressed('Mine'),
        everyone: pressed('Everyone'),
        rows: rowNodes.length,
        bob: rowNodes.some((node) => node.textContent?.includes('Bob main')),
      })
      if (running) {
        requestAnimationFrame(tick)
      }
    }

    probeWindow.__notariumScopeProbe = {
      samples,
      stop: () => {
        running = false
      },
    }
    requestAnimationFrame(tick)
  })

  await scopeControl.getByRole('button', { name: 'Mine' }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText('Mine main')
  await scopeControl.getByRole('button', { name: 'Everyone' }).click()
  await expect(rows).toHaveCount(2)

  const samples = await page.evaluate(() => {
    type Sample = { control: boolean; mine: boolean; everyone: boolean; rows: number; bob: boolean }
    type Probe = { samples: Sample[]; stop: () => void }
    const probe = (window as Window & { __notariumScopeProbe?: Probe }).__notariumScopeProbe

    probe?.stop()
    return probe?.samples ?? []
  })
  const firstMine = samples.findIndex((sample) => sample.mine)
  const backToEveryone = samples.findIndex((sample, index) => index > firstMine && sample.everyone)

  expect(firstMine).toBeGreaterThan(0)
  expect(backToEveryone).toBeGreaterThan(firstMine)
  // Immediacy, and the half a lag would break: no painted frame ever carried the
  // Everyone label over an already reset feed. Bound to the resolved gate instead of
  // the click, the segment would show exactly that — Everyone pressed above zero
  // rows — for the whole round trip.
  expect(
    samples.slice(0, backToEveryone).filter((sample) => sample.rows === 0 && sample.everyone),
  ).toHaveLength(0)
  // The control never vanished or flickered through either reset window.
  expect(samples.filter((sample) => !sample.control)).toHaveLength(0)
  expect(samples.filter((sample) => sample.mine === sample.everyone)).toHaveLength(0)
  // Under the Mine label no frame ever showed Bob's row; under the Everyone label
  // no frame ever showed a row set that was Mine's alone.
  expect(samples.slice(firstMine, backToEveryone).filter((sample) => sample.bob)).toHaveLength(0)
  expect(
    samples.slice(backToEveryone).filter((sample) => sample.rows > 0 && !sample.bob),
  ).toHaveLength(0)
})

test('saved None owns the standing gate without a hidden grouped request', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('bm-dashboard-activity-group', 'none')
  })
  let groupedRequests = 0

  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/activity/groups')) {
      groupedRequests++
    }
  })
  await page.goto('/')
  await page.getByTestId('auth-username').fill('alice')
  await page.getByTestId('auth-password').fill('alice-password-1')
  await page.getByTestId('auth-submit').click()

  const groupControl = page.getByRole('group', { name: 'Group activity' })
  await expect(groupControl.getByRole('button', { name: 'None' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('dashboard-activity-row')).toContainText('Mine main')
  expect(groupedRequests).toBe(0)
})
