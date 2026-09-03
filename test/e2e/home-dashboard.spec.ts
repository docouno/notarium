import { installControlledEventSource } from './controlledEventSource'
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
    {
      slug: 'solo',
      displayName: 'Solo',
      notes: [
        {
          title: 'Solo note',
          filePath: 'solo.md',
          modifiedAt: TODAY,
          createdAt: TODAY,
          tags: [],
          content: '# Solo note\n\nOnly this Space carries this note.',
        },
      ],
      activity: [
        {
          date: TODAY,
          kind: 'created',
          title: 'Solo note',
          principal: 'ui',
          noteId: 'fake-solo',
        },
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

  // The standing feed starts in Note mode: Alpha's two events occupy one row, and
  // the hidden-class "Secret" never appears.
  const feed = page.getByTestId('activity-feed')
  await expect(feed).toBeVisible()
  await expect(feed.getByText('Secret')).toHaveCount(0)
  const feedRows = feed.getByTestId('dashboard-activity-note-group')
  await expect(feedRows).toHaveCount(3)
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
  // The aggregate row owns the full-window count/churn. Disclosure then renders the
  // existing raw EventRow contract, including actor and current folder breadcrumb.
  await expect(feed.getByText('+12 −0')).toBeVisible()
  await expect(feedRows.filter({ hasText: 'Alpha' })).toContainText('2 changes')
  await feed.getByRole('button', { name: 'Expand changes for Alpha' }).press('Enter')
  const agentEvent = feed.getByTestId('dashboard-activity-row').filter({ hasText: '+12 −0' })
  await expect(agentEvent).toBeVisible()
  expect(
    await agentEvent
      .locator('[data-timeline-slot]')
      .evaluateAll((slots) => slots.map((slot) => slot.getAttribute('data-timeline-slot'))),
  ).toEqual(['action', 'actor', 'outcome'])
  await expect(agentEvent.locator('[data-timeline-slot="actor"]')).toContainText('alice’s agent')
  await expect(agentEvent.locator('[data-timeline-slot="actor"] svg')).toBeVisible()
  // Scoped to the raw event row on purpose: the Note group row above it now draws
  // the same breadcrumb, so an unscoped locator would stop proving the EventRow.
  const folderCrumb = agentEvent.getByRole('link', { name: 'notes' })
  await expect(folderCrumb).toBeVisible()
  await expect(folderCrumb).toHaveAttribute('href', /\/s\/main\/files\/notes$/)

  // Folder mode builds folder → note → events and keeps multiple disclosures open.
  await feed.getByRole('button', { name: 'Folder', exact: true }).click()
  const folderGroup = feed
    .getByTestId('dashboard-activity-folder-group')
    .filter({ hasText: 'notes' })
  await expect(folderGroup).toBeVisible()
  await feed.getByRole('button', { name: /Expand notes in Folder · notes/ }).press('Enter')
  await expect(
    feed.getByTestId('dashboard-activity-note-group').filter({ hasText: 'Alpha' }),
  ).toBeVisible()
  await feed.getByRole('button', { name: 'Note', exact: true }).click()

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

test('Home dashboard: a Space switch never paints the previous Dashboard under the target URL', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/s/main')
  const dash = page.getByTestId('home-dashboard')
  await expect(dash).toContainText('3 notes')
  await page.getByTestId('space-switcher').click()

  await page.evaluate(() => {
    type Sample = {
      path: string
      marker: string | null
      visible: boolean
      sourceVisible: boolean
      switcher: string | null
    }
    type Probe = { samples: Sample[]; stop: () => void }
    const probeWindow = window as Window & { __notariumSpaceProbe?: Probe }
    const samples: Sample[] = []
    let running = true

    const tick = () => {
      const currentDash = document.querySelector('[data-testid="home-dashboard"]')
      const rect = currentDash?.getBoundingClientRect()
      const style = currentDash ? getComputedStyle(currentDash) : null
      const text = currentDash?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

      samples.push({
        path: location.pathname,
        marker: document.documentElement.dataset.notariumSpaceTransition ?? null,
        visible: Boolean(
          currentDash &&
          style &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect &&
          rect.width > 0 &&
          rect.height > 0,
        ),
        sourceVisible: text.includes('3 notes'),
        switcher:
          document
            .querySelector('[data-testid="space-switcher"]')
            ?.textContent?.replace(/\s+/g, ' ')
            .trim() ?? null,
      })
      if (running) {
        requestAnimationFrame(tick)
      }
    }

    probeWindow.__notariumSpaceProbe = {
      samples,
      stop: () => {
        running = false
      },
    }
    requestAnimationFrame(tick)
  })

  await page.getByRole('menuitemradio', { name: 'Solo' }).click()
  await expect(page).toHaveURL(/\/s\/solo$/)
  await expect(page.getByTestId('space-switcher')).toContainText('Solo')
  await expect(dash).toContainText('1 note')

  const probe = await page.evaluate(() => {
    type Sample = {
      path: string
      marker: string | null
      visible: boolean
      sourceVisible: boolean
      switcher: string | null
    }
    type Probe = { samples: Sample[]; stop: () => void }
    const probeWindow = window as Window & { __notariumSpaceProbe?: Probe }
    const current = probeWindow.__notariumSpaceProbe

    current?.stop()
    const targetFrames = current?.samples.filter((sample) => sample.path === '/s/solo') ?? []

    return {
      targetFrames: targetFrames.length,
      hiddenFrames: targetFrames.filter((sample) => !sample.visible).length,
      staleSourceFrames: targetFrames.filter(
        (sample) => sample.visible && (sample.sourceVisible || sample.switcher === 'Main'),
      ).length,
      marker: document.documentElement.dataset.notariumSpaceTransition ?? null,
    }
  })

  expect(probe.targetFrames).toBeGreaterThan(0)
  expect(probe.hiddenFrames).toBeGreaterThan(0)
  expect(probe.staleSourceFrames).toBe(0)
  expect(probe.marker).toBeNull()
})

test('Home dashboard: a projection rebuild is a state that explains itself and clears itself', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  // The fake back end cannot rebuild, so the typed 503 is a one-shot stub. The
  // controlled EventSource suppresses every real frame: completion below is the
  // explicit `changed` frame the projection emits on publication, nothing else.
  await page.addInitScript(installControlledEventSource)
  let rebuilding = true
  let groupRequests = 0

  await page.route('**/api/s/main/activity/groups?**', async (route) => {
    groupRequests++
    if (rebuilding) {
      rebuilding = false
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'activity summary is rebuilding',
          reason: 'activity_projection_rebuilding',
        }),
      })
      return
    }
    await route.continue()
  })
  // Bind the first assertions to the 503 itself: a bare skeleton check would also be
  // satisfied by the cold-start skeleton, before the rebuild was ever discovered.
  const rebuildAnswered = page.waitForResponse(
    (response) => response.url().includes('/activity/groups') && response.status() === 503,
  )

  await page.goto('/')
  const feed = page.getByTestId('activity-feed')
  const notice = feed.locator('[role="status"]')

  await rebuildAnswered
  // First seconds: a skeleton and nothing else — no alert, no button, no text.
  await expect(feed.locator('[data-skeleton]')).toBeVisible()
  await expect(feed.getByRole('alert')).toHaveCount(0)
  await expect(feed.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  await expect(notice).toHaveCount(0)
  const requestsBeforeWait = groupRequests

  // Past the threshold: one calm status line, still no alert and no Retry, and the
  // wait issued no request of its own — there is no cadence to a rebuild.
  await expect(notice).toHaveText(
    'Rebuilding the activity summary. This can take a while; the feed will refresh on its own when it’s done.',
    { timeout: 15_000 },
  )
  expect(groupRequests).toBe(requestsBeforeWait)
  await expect(feed.getByRole('alert')).toHaveCount(0)
  await expect(feed.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  await expect(feed.locator('[data-skeleton]')).toBeVisible()

  // Neighbours stay alive: the year keeps its active cells under preferred
  // Everyone, the Projects and Health pills carry real metrics, the Health surface
  // renders its queue, and the pill round trip does not re-arm the threshold.
  await expect(page.getByTestId('heat-cell-active').first()).toBeVisible()
  await expect(page.getByTestId('activity-heatmap').locator('[data-skeleton]')).toHaveCount(0)
  await expect(page.getByTestId('dash-pill-projects')).not.toContainText('…')
  await expect(page.getByTestId('dash-pill-health')).toContainText('1 to fix')
  await page.getByTestId('dash-pill-health').click()
  await expect(page.getByTestId('dash-broken-links')).toContainText('Nonexistent')
  await page.getByTestId('dash-pill-activity').click()
  await expect(notice).toHaveText(
    'Rebuilding the activity summary. This can take a while; the feed will refresh on its own when it’s done.',
    { timeout: 1_000 },
  )

  // Completion: the projection's own `changed` frame, fed to the same handler the
  // sync client installs. The surface swaps to rows on its own.
  await page.waitForFunction(() => {
    const sources = (window as typeof window & { __notariumEventSources?: readonly EventSource[] })
      .__notariumEventSources
    return sources?.some((source) => source.readyState === EventSource.OPEN)
  })
  await page.evaluate(() => {
    const sources = (window as typeof window & { __notariumEventSources?: readonly EventSource[] })
      .__notariumEventSources
    const source = [...(sources ?? [])]
      .reverse()
      .find((candidate) => candidate.readyState === EventSource.OPEN)

    if (!source) {
      throw new Error('no open EventSource for the rebuild completion frame')
    }
    source.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'changed', upserts: [], removed: [] }),
      }),
    )
  })
  await expect(feed.getByTestId('dashboard-activity-note-group').first()).toBeVisible()
  await expect(notice).toHaveCount(0)
  await expect(feed).not.toContainText(
    'Rebuilding the activity summary. This can take a while; the feed will refresh on its own when it’s done.',
  )
  await expect(feed.locator('[data-skeleton]')).toHaveCount(0)

  // Note navigation stayed live throughout: the rail opens a note as usual.
  await page.getByTestId('rail-scroll').getByRole('link', { name: 'Alpha' }).click()
  await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible()
})

test('Home dashboard: location is a breadcrumb in every Group mode', async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto('/')
  const feed = page.getByTestId('activity-feed')

  // Group=Note: the note row's own location links into the folder without
  // expanding the row or opening the note.
  const alphaRow = feed.getByTestId('dashboard-activity-note-group').filter({ hasText: 'Alpha' })
  const noteCrumb = alphaRow.getByRole('link', { name: 'notes' })

  await expect(noteCrumb).toHaveAttribute('href', /\/s\/main\/files\/notes$/)
  await noteCrumb.click()
  await expect(page).toHaveURL(/\/s\/main\/files\/notes$/)
  // Back to the dashboard for the Folder half. Nothing is asserted about disclosure
  // here: the return remounts the surface with an empty open set, so any such check
  // would pass regardless. "A crumb click does not toggle or open the note" is
  // proven where it can fail — ActivityFeed.test.ts, same-frame, with the request
  // counter and the `onOpen` spy.
  await page.goBack()

  // Group=Folder: the qualifier stays text, the path segments are the links.
  await feed.getByRole('button', { name: 'Folder', exact: true }).click()
  const folderRow = feed.getByTestId('dashboard-activity-folder-group').filter({ hasText: 'notes' })

  await expect(folderRow).toContainText('Folder · notes')
  const folderCrumb = folderRow.getByRole('link', { name: 'notes' })

  await expect(folderCrumb).toHaveAttribute('href', /\/s\/main\/files\/notes$/)
  await folderCrumb.click()
  await expect(page).toHaveURL(/\/s\/main\/files\/notes$/)
})

test('Home dashboard: a body edit updates the open feed in place', async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  // A live body edit of an EXISTING note: its journal append advances only the
  // source cut. Creating a note instead would move the location generation and
  // legitimately clear every branch — the symptom this test must not confuse with
  // the defect. The token is read before the page opens.
  const bravo = await page.request.get(`${baseURL}/api/note?id=fake-notes-bravo`)
  expect(bravo.ok()).toBeTruthy()
  let versionToken = ((await bravo.json()) as { versionToken: string }).versionToken
  const detailRequests: Record<string, number> = {}

  page.on('request', (request) => {
    const url = new URL(request.url())

    if (url.pathname.endsWith('/activity/events') && url.searchParams.has('noteId')) {
      const noteId = url.searchParams.get('noteId')!
      detailRequests[noteId] = (detailRequests[noteId] ?? 0) + 1
    }
  })
  await page.goto('/')
  const feed = page.getByTestId('activity-feed')
  const rows = feed.getByTestId('dashboard-activity-note-group')
  const bravoRow = rows.filter({ hasText: 'Bravo' })

  await feed.getByRole('button', { name: 'Expand changes for Alpha' }).press('Enter')
  await feed.getByRole('button', { name: 'Expand changes for Bravo' }).press('Enter')
  await expect(feed.getByRole('button', { name: 'Collapse changes for Alpha' })).toBeVisible()
  await expect(feed.getByRole('button', { name: 'Collapse changes for Bravo' })).toBeVisible()
  await expect(bravoRow).toContainText('1 change')
  await expect.poll(() => detailRequests['fake-notes-alpha']).toBe(1)
  await expect.poll(() => detailRequests['fake-notes-bravo']).toBe(1)

  const edit = async (content: string) => {
    // The journal append is fire-and-forget and the `changed` frame is emitted
    // before it settles, so the wait is the grouped response that follows the
    // edit, not a bare poll.
    const refreshed = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname.endsWith('/activity/groups') && !url.searchParams.has('location')
    })
    const saved = await page.request.post(`${baseURL}/api/note`, {
      data: { content, originalId: 'fake-notes-bravo', versionToken },
    })

    expect(saved.ok()).toBeTruthy()
    versionToken = ((await saved.json()) as { versionToken: string }).versionToken
    await refreshed
  }

  const startProbe = () =>
    page.evaluate(() => {
      type Sample = { skeleton: boolean; loading: boolean; expanded: number; heading: string }
      type Probe = { samples: Sample[]; stop: () => void }
      const probeWindow = window as Window & { __notariumFeedProbe?: Probe }
      const samples: Sample[] = []
      let running = true

      const tick = () => {
        const feedNode = document.querySelector('[data-testid="activity-feed"]')

        samples.push({
          skeleton: feedNode?.querySelector('[data-skeleton]') != null,
          loading: feedNode?.textContent?.includes('Loading…') ?? false,
          expanded: feedNode?.querySelectorAll('[aria-expanded="true"]').length ?? 0,
          heading: feedNode?.querySelector('h2')?.textContent?.trim() ?? '',
        })
        if (running) {
          requestAnimationFrame(tick)
        }
      }

      probeWindow.__notariumFeedProbe = {
        samples,
        stop: () => {
          running = false
        },
      }
      requestAnimationFrame(tick)
    })
  const stopProbe = () =>
    page.evaluate(() => {
      type Sample = { skeleton: boolean; loading: boolean; expanded: number; heading: string }
      type Probe = { samples: Sample[]; stop: () => void }
      const probe = (window as Window & { __notariumFeedProbe?: Probe }).__notariumFeedProbe

      probe?.stop()
      return probe?.samples ?? []
    })

  // Standing lane: rows update in place, both branches stay open through every
  // frame, the untouched branch is not re-requested and the touched one exactly once.
  await startProbe()
  await edit('# Bravo\n\nA hub, edited once.')
  await expect(bravoRow).toContainText('2 changes')
  await expect.poll(() => detailRequests['fake-notes-bravo']).toBe(2)
  const standing = await stopProbe()

  expect(standing.length).toBeGreaterThan(0)
  expect(standing.filter((sample) => sample.skeleton)).toHaveLength(0)
  expect(standing.filter((sample) => sample.loading)).toHaveLength(0)
  expect(standing.filter((sample) => sample.expanded < 2)).toHaveLength(0)
  expect(detailRequests['fake-notes-alpha']).toBe(1)
  // Re-read after the probe: `expect.poll` above stops at its first match, so only
  // this second reading proves the edited branch issued exactly ONE refresh and not
  // a stream of them.
  expect(detailRequests['fake-notes-bravo']).toBe(2)
  await expect(feed.getByRole('button', { name: 'Collapse changes for Alpha' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(feed.getByRole('button', { name: 'Collapse changes for Bravo' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )

  // Day lane: an open day survives the next edit and updates in place. The last
  // active cell is today — the day the live edits land on (Bravo's seeded event is
  // two days back, so today's drill starts at the one live change).
  await page.getByTestId('heat-cell-active').last().click()
  await expect(feed.getByText(/Changes on \d{4}-\d{2}-\d{2}/)).toBeVisible()
  await expect(rows.filter({ hasText: 'Bravo' })).toContainText('1 change')
  await startProbe()
  await edit('# Bravo\n\nA hub, edited twice.')
  await expect(rows.filter({ hasText: 'Bravo' })).toContainText('2 changes')
  const day = await stopProbe()

  expect(day.length).toBeGreaterThan(0)
  expect(day.filter((sample) => sample.skeleton)).toHaveLength(0)
  expect(day.filter((sample) => !sample.heading.startsWith('Changes on'))).toHaveLength(0)
})

test('Home dashboard: a pure move refreshes open Note and Folder detail branches', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  let bravoDetailRequests = 0

  page.on('request', (request) => {
    const url = new URL(request.url())

    if (
      url.pathname.endsWith('/activity/events') &&
      url.searchParams.get('noteId') === 'fake-notes-bravo'
    ) {
      bravoDetailRequests++
    }
  })
  await page.goto('/')
  const feed = page.getByTestId('activity-feed')

  await feed.getByRole('button', { name: 'Folder', exact: true }).click()
  await feed.getByRole('button', { name: /Expand notes in Folder · notes/ }).press('Enter')
  await feed.getByRole('button', { name: /Expand changes for Bravo/ }).press('Enter')
  await expect(
    feed.getByTestId('dashboard-activity-row').filter({ hasText: 'Bravo' }),
  ).toBeVisible()
  expect(bravoDetailRequests).toBe(1)

  const firstMove = await page.request.post(`${baseURL}/api/move`, {
    data: { id: 'fake-notes-alpha', destinationPath: 'elsewhere/Alpha.md' },
  })
  expect(firstMove.ok()).toBeTruthy()
  await expect.poll(() => bravoDetailRequests).toBeGreaterThanOrEqual(2)
  await expect(feed.getByRole('button', { name: /Collapse changes for Bravo/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  )

  await feed.getByRole('button', { name: 'Note', exact: true }).click()
  await feed.getByRole('button', { name: /Expand changes for Alpha/ }).press('Enter')
  // The assertion lives on the raw event rows INSIDE the open branch: the Note group
  // row draws the same breadcrumb now and follows the overview on its own, so an
  // unscoped locator would pass without the branch ever being refetched.
  const alphaEvents = feed.getByTestId('dashboard-activity-row')

  await expect(alphaEvents.getByRole('link', { name: 'elsewhere' }).first()).toBeVisible()
  const secondMove = await page.request.post(`${baseURL}/api/move`, {
    data: { id: 'fake-notes-alpha', destinationPath: 'final/Alpha.md' },
  })
  expect(secondMove.ok()).toBeTruthy()
  await expect(alphaEvents.getByRole('link', { name: 'final' }).first()).toBeVisible()
  await expect(feed.getByRole('button', { name: /Collapse changes for Alpha/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
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
