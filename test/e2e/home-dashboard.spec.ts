import { expect, test } from './fixtures'

// #33 / #216 — the Home dashboard. The stat row is now a PILL TAB-BAR (#216): the
// space home is the Activity surface (heatmap + "what changed"), and the deep
// surfaces (Projects, Health) live at `/s/<space>/dashboard/<view>`. Source for the
// Activity half is the revision journal (#12), seeded here via the fixture's
// `activity` channel. Dates are computed relative to the REAL now so they always
// land inside the server's default trailing-53-week window (the dashboard fetches
// /activity with no explicit range), no matter when the suite runs.

const noon = (d: Date) => {
  const z = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0))
  return z.toISOString()
}

const daysAgo = (n: number) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return noon(d)
}
const TODAY = daysAgo(0)
const TWO_AGO = daysAgo(2)

const FIXTURE = {
  now: new Date().toISOString(),
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      // A tiny graph: Alpha → Bravo (both connected), Alpha → [[Nonexistent]] (a
      // broken link / ghost), Charlie alone (degree 0 = orphan).
      notes: [
        {
          title: 'Alpha',
          filePath: 'notes/alpha.md',
          modifiedAt: TODAY,
          createdAt: TODAY,
          tags: [],
          content: '# Alpha\n\nLinks to [[Bravo]] and a broken [[Nonexistent]].',
        },
        {
          title: 'Bravo',
          filePath: 'notes/bravo.md',
          modifiedAt: TODAY,
          createdAt: TODAY,
          tags: [],
          content: '# Bravo\n\nA hub.',
        },
        {
          title: 'Charlie',
          filePath: 'notes/charlie.md',
          modifiedAt: TODAY,
          createdAt: TODAY,
          tags: [],
          content: '# Charlie\n\nNo links.',
        },
      ],
      // noteId ties an event to a real note so the feed can resolve its folder path
      // (#217). fake note ids are `fake-<slugged-path>`: notes/alpha.md → fake-notes-alpha.
      activity: [
        {
          date: TODAY,
          kind: 'created',
          title: 'Alpha',
          principal: 'ui',
          noteId: 'fake-notes-alpha',
        },
        {
          date: TODAY,
          kind: 'edited',
          title: 'Alpha',
          principal: 'pat:alice:key-9',
          noteId: 'fake-notes-alpha',
          charsAdded: 12,
          charsRemoved: 0,
        },
        { date: TWO_AGO, kind: 'edited', title: 'Bravo', noteId: 'fake-notes-bravo' },
        { date: TWO_AGO, kind: 'deleted', title: 'Gamma' },
        // Excluded from counts/feed: a synthetic baseline and a hidden class.
        { date: TWO_AGO, kind: 'baseline', title: 'Alpha' },
        { date: TWO_AGO, kind: 'edited', title: 'Secret', class: 'agent-memory' },
      ],
    },
  ],
}

test('Home dashboard: pills, activity surface, day-drill, health/projects surfaces', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto('/')

  // Lands on the dashboard (not the empty Splash — the base has notes).
  const dash = page.getByTestId('home-dashboard')
  await expect(dash).toBeVisible()

  // The pill tab-bar (#216): three surfaces, Activity active by default (the home).
  const activityPill = page.getByTestId('dash-pill-activity')
  const projectsPill = page.getByTestId('dash-pill-projects')
  const healthPill = page.getByTestId('dash-pill-health')
  await expect(activityPill).toHaveAttribute('aria-current', 'page')
  await expect(projectsPill).toBeVisible()
  await expect(healthPill).toBeVisible()
  // Reference strip carries the real base numbers (3 notes), not just labels.
  await expect(page.getByTestId('dash-refstrip')).toContainText('3')
  await expect(page.getByTestId('dash-refstrip')).toContainText('notes')
  // The Health pill flags the broken link: a danger dot + "1 to fix" metric.
  await expect(healthPill.locator('[data-severity="danger"]')).toBeVisible()
  await expect(healthPill).toContainText('1 to fix')

  // Activity surface (the default): the heatmap renders active cells; exact
  // aggregation is pinned in the fake-server conformance tests, this E2E proves the
  // UI path + day drill.
  await expect(page.getByTestId('activity-heatmap')).toBeVisible()
  const activeCells = page.getByTestId('heat-cell-active')
  await expect(activeCells.first()).toBeVisible()
  expect(await activeCells.count()).toBeGreaterThanOrEqual(1)

  // The standing "what changed" feed shows events; the hidden-class "Secret" never
  // appears.
  const feed = page.getByTestId('activity-feed')
  await expect(feed).toBeVisible()
  await expect(feed.getByText('Secret')).toHaveCount(0)
  const feedRows = feed.getByTestId('dashboard-activity-row')
  const timeline = feedRows.first().locator('..')
  const [timelineBox, firstMarkerBox, lastMarkerBox, endpoints] = await Promise.all([
    timeline.boundingBox(),
    feedRows.first().locator('[data-timeline-marker]').boundingBox(),
    feedRows.last().locator('[data-timeline-marker]').boundingBox(),
    timeline.evaluate((element) => {
      const style = getComputedStyle(element, '::before')
      return { top: Number.parseFloat(style.top), bottom: Number.parseFloat(style.bottom) }
    }),
  ])
  const lineTop = (timelineBox?.y ?? 0) + endpoints.top
  const lineBottom = (timelineBox?.y ?? 0) + (timelineBox?.height ?? 0) - endpoints.bottom
  expect(lineTop).toBeGreaterThan(firstMarkerBox?.y ?? Number.POSITIVE_INFINITY)
  expect(lineTop).toBeLessThan((firstMarkerBox?.y ?? 0) + (firstMarkerBox?.height ?? 0))
  expect(lineBottom).toBeGreaterThan(lastMarkerBox?.y ?? Number.POSITIVE_INFINITY)
  expect(lineBottom).toBeLessThan((lastMarkerBox?.y ?? 0) + (lastMarkerBox?.height ?? 0))
  await expect(feed.getByText('Alpha').first()).toBeVisible()
  // #217 gitlab-style: each event is a two-line entry — the metadata line shows the
  // kind + churn, and line one carries the note's location as a clickable folder
  // breadcrumb (Alpha lives in notes/, so the crumb links that folder's Files view).
  await expect(feed.getByText('+12 −0')).toBeVisible()
  const agentEvent = feed.getByTestId('dashboard-activity-row').filter({ hasText: '+12 −0' })
  expect(
    await agentEvent
      .locator('[data-timeline-slot]')
      .evaluateAll((slots) => slots.map((slot) => slot.getAttribute('data-timeline-slot'))),
  ).toEqual(['action', 'actor', 'outcome'])
  await expect(agentEvent.locator('[data-timeline-slot="actor"]')).toContainText('alice’s agent')
  await expect(agentEvent.locator('[data-timeline-slot="actor"] svg')).toBeVisible()
  const folderCrumb = feed.getByRole('link', { name: 'notes' }).first()
  await expect(folderCrumb).toBeVisible()
  await expect(folderCrumb).toHaveAttribute('href', /\/s\/main\/files\/notes$/)

  // Day-drill: click an active cell → the feed scopes to that day with a header.
  await activeCells.first().click()
  await expect(feed.getByText(/Changes on \d{4}-\d{2}-\d{2}/)).toBeVisible()
  // Clear returns to the standing feed.
  await feed.getByRole('button', { name: /clear/i }).click()
  await expect(feed.getByText(/Changes on/)).toHaveCount(0)

  // Health surface: click the pill → routes to /dashboard/health, the pill gains
  // aria-current and Activity loses it (the active-state highlight tracks the URL).
  await healthPill.click()
  await expect(page).toHaveURL(/\/s\/main\/dashboard\/health$/)
  await expect(healthPill).toHaveAttribute('aria-current', 'page')
  await expect(activityPill).not.toHaveAttribute('aria-current', 'page')
  // Broken links (the ghost [[Nonexistent]], 1 ref) and Orphans (Charlie, degree 0).
  // Hubs are gone (the graph shows them); orphans moved here from the old card.
  const broken = page.getByTestId('dash-broken-links')
  await expect(broken).toBeVisible()
  await expect(broken).toContainText('Nonexistent')
  await expect(broken).toContainText('1 ref')
  const orphans = page.getByTestId('dash-orphans')
  await expect(orphans).toBeVisible()
  await expect(orphans.getByText('Charlie')).toBeVisible()
  // The heatmap is not on this surface — surfaces swap under the shared pill bar.
  await expect(page.getByTestId('activity-heatmap')).toHaveCount(0)

  // Projects surface: the pill routes to /dashboard/projects and gains aria-current.
  await projectsPill.click()
  await expect(page).toHaveURL(/\/s\/main\/dashboard\/projects$/)
  await expect(projectsPill).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('dash-surface-projects')).toBeVisible()

  // The Activity pill returns to the canonical bare home URL and re-lights.
  await activityPill.click()
  await expect(page).toHaveURL(/\/s\/main$/)
  await expect(activityPill).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('activity-heatmap')).toBeVisible()
})

test('Home dashboard: canonical dashboard URLs redirect to the home surface', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  // Activity is the space home — its /dashboard and /dashboard/activity aliases
  // canonicalise back to the bare /s/<space> (DashboardHomeRedirect).
  await page.goto('/s/main/dashboard')
  await expect(page).toHaveURL(/\/s\/main$/)
  await expect(page.getByTestId('activity-heatmap')).toBeVisible()
  await page.goto('/s/main/dashboard/activity')
  await expect(page).toHaveURL(/\/s\/main$/)
  await expect(page.getByTestId('dash-pill-activity')).toHaveAttribute('aria-current', 'page')
})

test('Home dashboard: data loads once — switching pills does not refetch', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  // The whole #216 architecture: data loads ONCE in the shared DashboardLayout and
  // is handed to surfaces via the Outlet, so a pill switch (a route change under
  // /s/:space) must NOT remount/refetch the layout. Count the activity heatmap
  // fetch across a full pill round-trip — it must fire exactly once (initial load).
  let activityFetches = 0
  page.on('request', (r) => {
    if (/\/api\/s\/main\/activity\?/.test(r.url())) {
      activityFetches++
    }
  })
  await page.goto('/')
  await expect(page.getByTestId('activity-heatmap')).toBeVisible()
  await page.getByTestId('dash-pill-health').click()
  await expect(page).toHaveURL(/dashboard\/health$/)
  await page.getByTestId('dash-pill-projects').click()
  await expect(page).toHaveURL(/dashboard\/projects$/)
  await page.getByTestId('dash-pill-activity').click()
  await expect(page).toHaveURL(/\/s\/main$/)
  await expect(page.getByTestId('activity-heatmap')).toBeVisible()
  expect(activityFetches).toBe(1)
})

test('Home dashboard: Health surface lists links resolved via a former name', async ({
  page,
  baseURL,
}) => {
  // Seed an alias-resolved edge at runtime (fixtures can't express note-alias
  // history): create a note, a note that links to it by name, then RENAME the
  // target — its old name lives on as an alias, so the referrer now resolves
  // "via a former name" (#100 phase 5), which the Health surface surfaces.
  await page.request.post(`${baseURL}/api/__test/reset`, {
    data: {
      fixture: {
        now: new Date().toISOString(),
        spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
      },
    },
  })
  const post = async (path: string, body: unknown) => {
    const r = await page.request.post(`${baseURL}/api/s/main${path}`, { data: body })
    expect(r.ok()).toBeTruthy()
    return r.json()
  }
  const legacy = await post('/notes', { content: '# Legacy Name\n\nThe original note.' })
  await post('/notes', { content: '# Refers Legacy\n\nPoints at [[Legacy Name]].' })
  // Rename Legacy Name → Renamed Note (move-then-write under originalId).
  const renamed = await page.request.post(`${baseURL}/api/note`, {
    data: {
      content: '# Renamed Note\n\nThe original note, now renamed.',
      originalId: legacy.id,
      versionToken: legacy.versionToken,
    },
  })
  expect(renamed.ok()).toBeTruthy()

  await page.goto('/s/main/dashboard/health')
  const stale = page.getByTestId('dash-stale-links')
  await expect(stale).toBeVisible()
  // Row reads "Refers Legacy → Renamed Note" with a "former name" badge.
  await expect(stale).toContainText('Renamed Note')
  await expect(stale).toContainText('former name')
})

test('Home dashboard: a brand-new empty base keeps the Splash CTA', async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, {
    data: {
      fixture: {
        now: new Date().toISOString(),
        spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
      },
    },
  })
  await page.goto('/')
  // No dashboard on an empty base — the friendly "create your first note" splash.
  await expect(page.getByTestId('home-dashboard')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Your knowledge base' })).toBeVisible()
})
