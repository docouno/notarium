import { buildCaseWorld, caseToFixture } from '../cases'
import { expect, type Page, test } from './fixtures'

const WORLD = caseToFixture(buildCaseWorld('agent-sessions', { now: '2099-08-05T12:00:00.000Z' }))

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: WORLD } })
})

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
})

const login = async (page: Page) => {
  await page.goto('/')
  await page.getByTestId('auth-username').fill('sergey')
  await page.getByTestId('auth-password').fill('sergey')
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('auth-login')).not.toBeVisible()
}

const RETRIEVAL_EVENT = {
  type: 'retrieval',
  id: 'diagnostic-event',
  at: '2099-08-05T10:55:00.000Z',
  tool: 'search',
  query: 'legacy rollout guide',
  project: null,
  classFilter: null,
  resultCount: 0,
  topScore: null,
  hits: [],
  agent: 'CLI',
  principal: 'pat:CLI:seed',
  sessionId: null,
  sessionName: null,
  sessionAttach: null,
} as const

const RETRIEVAL_HIT_EVENT = {
  ...RETRIEVAL_EVENT,
  id: 'ranked-event',
  query: 'migration findings',
  resultCount: 1,
  topScore: 8.4,
  hits: [
    {
      noteId: 'fake-sessions-migration-findings',
      title: 'Migration findings',
      class: 'user-doc',
      score: 8.4,
    },
  ],
} as const

const RETRIEVAL_AGGREGATES = {
  retrieval: {
    totalQueries: 4,
    missCount: 2,
    top: [
      {
        query: 'migration checklist',
        tool: 'search',
        count: 3,
        misses: 0,
        lastAt: '2099-08-05T10:54:00.000Z',
      },
    ],
    misses: [
      {
        query: RETRIEVAL_EVENT.query,
        tool: RETRIEVAL_EVENT.tool,
        count: 2,
        misses: 2,
        lastAt: RETRIEVAL_EVENT.at,
      },
    ],
  },
  agents: [
    { agent: 'CLI', count: 58 },
    { agent: 'Claude', count: 1 },
  ],
} as const

test('Activity opens as a flat URL-restorable stream and keeps Outside explicit', async ({
  page,
}) => {
  const eventRequests: URL[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())

    if (url.pathname === '/api/me/agent-sessions/all') {
      eventRequests.push(url)
    }
  })
  await login(page)
  await page.goto('/agents/activity')

  await expect(page.getByTestId('agents-activity')).toBeVisible()
  await expect(page.getByTestId('activity-stream')).toBeVisible()
  await expect(page.getByTestId('session-write-row').first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Outside session' })).toBeVisible()
  await expect(page.getByTestId('aside-groups')).toHaveCount(0)
  const [panelToggle, railToggle] = await Promise.all([
    page.getByRole('button', { name: 'Open activity panels' }).boundingBox(),
    page.getByRole('button', { name: 'Collapse sidebar' }).boundingBox(),
  ])
  expect(Math.abs((panelToggle?.y ?? 0) - (railToggle?.y ?? 1))).toBeLessThan(0.5)
  await expect(page.getByRole('button', { name: 'Load older activity' })).toBeVisible()
  await expect(page.getByTestId('session-write-row')).toHaveCount(50)
  await page.getByRole('button', { name: 'Load older activity' }).click()
  await expect(page.getByTestId('session-write-row')).toHaveCount(58)
  const unavailable = page
    .getByTestId('session-write-row')
    .filter({ hasText: 'Unavailable revision' })
  await expect(unavailable.getByText('Unavailable', { exact: true })).toBeVisible()
  await expect(unavailable.getByRole('link', { name: 'Unavailable revision' })).toHaveCount(0)
  expect(eventRequests).not.toHaveLength(0)
  expect(eventRequests.every((url) => !url.searchParams.has('aggregates'))).toBe(true)

  await page.getByRole('button', { name: 'Writes', exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/activity\?show=writes$/)
  await expect(page.getByTestId('session-write-row').first()).toBeVisible()
  await expect(page.getByTestId('audit-row')).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Writes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('session-write-row').first()).toBeVisible()

  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/activity$/)
})

test('Retry after a failed older page keeps the cached stream and its cursor', async ({ page }) => {
  let retryPayload: Record<string, unknown> | null = null
  let retryAttempts = 0

  await page.route('**/api/me/agent-sessions/all?*', async (route) => {
    const url = new URL(route.request().url())

    if (url.searchParams.get('cursor') === 'retry-cursor') {
      retryAttempts += 1

      if (retryAttempts === 1) {
        await route.fulfill({ status: 500, json: { error: 'temporary failure' } })
        return
      }
      await route.fulfill({ json: retryPayload })
      return
    }
    const response = await route.fetch()
    const body = (await response.json()) as {
      events: Array<Record<string, unknown>>
      [key: string]: unknown
    }

    if (url.searchParams.has('cursor') && body.events.length > 0) {
      retryPayload = {
        ...body,
        events: [
          {
            ...body.events.at(-1),
            id: 'pagination-retry-event',
            at: '2099-08-01T00:00:00.000Z',
            title: 'Recovered older activity',
          },
        ],
        hasMore: false,
        nextCursor: null,
      }
      await route.fulfill({
        response,
        json: { ...body, hasMore: true, nextCursor: 'retry-cursor' },
      })
      return
    }
    await route.fulfill({ response, json: body })
  })

  await login(page)
  await page.goto('/agents/activity')
  await page.getByRole('button', { name: 'Load older activity' }).click()
  await expect(page.getByTestId('session-write-row')).toHaveCount(58)
  await page.getByRole('button', { name: 'Load older activity' }).click()
  await expect(page.getByTestId('activity-error')).toBeVisible()
  await expect(page.getByTestId('session-write-row')).toHaveCount(58)

  await page.getByTestId('activity-error').getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByText('Recovered older activity', { exact: true })).toBeVisible()
  await expect(page.getByTestId('session-write-row')).toHaveCount(59)
  expect(retryAttempts).toBe(2)
})

test('Session grouping filters before pagination and separates nested episode timelines', async ({
  page,
}) => {
  const overviewRequests: URL[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())

    if (url.pathname === '/api/me/agent-sessions') {
      overviewRequests.push(url)
    }
  })
  await login(page)
  await page.goto('/agents/activity?show=writes')
  const flatHeadingType = await page
    .getByText('Recent activity', { exact: true })
    .evaluate((node) => {
      const style = getComputedStyle(node)
      return { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight }
    })
  await page.getByRole('button', { name: 'Session', exact: true }).click()

  await expect(page).toHaveURL(/\/agents\/activity\?show=writes&group=session$/)
  expect(
    await page.getByText('Recent episodes', { exact: true }).evaluate((node) => {
      const style = getComputedStyle(node)
      return { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight }
    }),
  ).toEqual(flatHeadingType)
  await expect(page.getByTestId('activity-session-list')).toBeVisible()
  await expect(page.getByTestId('activity-session-outside')).toBeVisible()
  expect(overviewRequests.at(-1)?.searchParams.get('filter')).toBe('writes')
  await expect(page.getByText('3 sessions')).toBeVisible()
  await expect(page.getByText('release planning', { exact: true })).toHaveCount(0)
  await expect(page.getByText('main · automatic seed', { exact: true })).toHaveCount(0)
  expect(
    await page
      .getByTestId('activity-session-row')
      .evaluateAll((rows) => rows.map((row) => getComputedStyle(row).opacity)),
  ).toEqual(expect.not.arrayContaining(['0.48']))
  const segments = page.getByTestId('activity-session-segment')
  await expect(segments).toHaveCount(4)
  expect(
    await segments.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element, '::before').display),
    ),
  ).toEqual(Array.from({ length: 4 }, () => 'none'))
  const [firstSegmentBottom, secondSegmentTop] = await Promise.all([
    segments.nth(0).evaluate((element) => element.getBoundingClientRect().bottom),
    segments.nth(1).evaluate((element) => element.getBoundingClientRect().top),
  ])
  expect(secondSegmentTop - firstSegmentBottom).toBe(8)

  const expandable = page
    .getByTestId('activity-session-row')
    .filter({ has: page.locator('button[aria-expanded]') })
    .filter({ hasNotText: 'expired retention probe' })
    .first()
  await expandable.locator('[data-timeline-slot="outcome"]').click()
  await expect(expandable).toHaveAttribute('data-expanded', 'true')
  await expect(expandable.getByTestId('activity-session-events')).toBeVisible()
  const eventTimeline = expandable.getByTestId('activity-session-event-timeline')
  await expect(eventTimeline).toBeVisible()
  const [segmentLeft, eventTimelineLeft, parentTimeRight, nestedHeadRight] = await Promise.all([
    expandable.evaluate((element) => element.parentElement?.getBoundingClientRect().left),
    eventTimeline.evaluate((element) => element.getBoundingClientRect().left),
    expandable
      .locator(':scope > [data-timeline-head] [data-timeline-time]')
      .evaluate((element) => element.getBoundingClientRect().right),
    eventTimeline
      .locator(':scope > li [data-timeline-head]')
      .first()
      .evaluate((element) => element.getBoundingClientRect().right),
  ])
  expect(eventTimelineLeft - (segmentLeft ?? 0)).toBe(24)
  expect(Math.abs(parentTimeRight - nestedHeadRight)).toBeLessThan(0.5)
  expect(
    await eventTimeline.evaluate((element) => {
      const style = getComputedStyle(element, '::before')
      return { display: style.display, width: style.width, top: style.top, bottom: style.bottom }
    }),
  ).toEqual({ display: 'block', width: '2px', top: '20px', bottom: '20px' })
  const lastEvent = eventTimeline.locator(':scope > li').last()
  const lastMarker = lastEvent.locator(':scope > div > span').first()
  const [timelineBottom, lastEventBottom, lastMarkerBottom] = await Promise.all([
    eventTimeline.evaluate((element) => element.getBoundingClientRect().bottom),
    lastEvent.evaluate((element) => element.getBoundingClientRect().bottom),
    lastMarker.evaluate((element) => element.getBoundingClientRect().bottom),
  ])
  expect(Math.abs(timelineBottom - lastEventBottom)).toBeLessThan(0.5)
  expect(timelineBottom - 20).toBeLessThan(lastMarkerBottom)

  const archived = page
    .getByTestId('activity-session-row')
    .filter({ hasText: 'expired retention probe' })
  await archived.getByRole('button', { name: 'More actions' }).click()
  const openEpisode = page.getByRole('menuitem', { name: 'Open episode' })
  await expect(openEpisode).toBeVisible()
  await expect(openEpisode).toBeFocused()
  await expect(archived).not.toHaveAttribute('data-expanded', 'true')
  await page.keyboard.press('Tab')
  await expect(openEpisode).toHaveCount(0)
  await expect(archived.getByRole('button', { name: 'More actions' })).not.toBeFocused()
  await archived.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Open episode' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(archived.getByRole('button', { name: 'More actions' })).toBeFocused()
  await archived.getByText('expired retention probe', { exact: true }).click()
  await expect(expandable).toHaveAttribute('data-expanded', 'true')
  await expect(expandable.getByTestId('activity-session-event-timeline')).toBeVisible()
  await expect(archived.getByTestId('session-write-row')).toHaveCount(50)
  await archived.getByRole('button', { name: 'Load older episode activity' }).click()
  await expect(archived.getByTestId('session-write-row')).toHaveCount(54)

  await page.getByRole('button', { name: 'Reads', exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/activity\?show=reads&group=session$/)
  expect(overviewRequests.at(-1)?.searchParams.get('filter')).toBe('reads')
  await expect(page.getByText('0 sessions')).toBeVisible()
  await expect(page.getByText('release planning', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('activity-session-events')).toHaveCount(0)
  await expect(
    page.locator('[data-testid="activity-session-row"][data-expanded="true"]'),
  ).toHaveCount(0)
  await expect(page.getByTestId('activity-session-row')).toHaveCount(0)
  await expect(page.getByText('No activity matches these filters')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset filters' })).toBeVisible()

  await page.getByRole('button', { name: 'All', exact: true }).click()
  const unaudited = page.getByTestId('activity-session-row').filter({
    hasText: 'main · automatic seed',
  })
  await expect(unaudited).toContainText('no audited activity')
  await expect(unaudited).toHaveCSS('opacity', '1')
})

test('expandable feed rows keep their primary text selectable', async ({ page }) => {
  await login(page)
  await page.goto('/agents/activity?show=writes&group=session')

  const row = page
    .getByTestId('activity-session-row')
    .filter({ hasText: 'migration review' })
    .first()
  const title = row.getByText('migration review', { exact: true })
  const trigger = row.getByRole('button', { name: 'Toggle activity for migration review' })
  const box = await title.boundingBox()

  expect(box).not.toBeNull()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await page.mouse.move((box?.x ?? 0) + 2, (box?.y ?? 0) + (box?.height ?? 0) / 2)
  await page.mouse.down()
  await page.mouse.move(
    (box?.x ?? 0) + (box?.width ?? 4) - 2,
    (box?.y ?? 0) + (box?.height ?? 0) / 2,
    { steps: 8 },
  )
  await page.mouse.up()

  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('migration review')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  await title.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
})

test('event rows reserve one trailing column and keep timestamps aligned', async ({ page }) => {
  await page.route('**/api/me/agent-sessions/all?*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: { ...body, events: [RETRIEVAL_EVENT, ...body.events] },
    })
  })
  await login(page)
  await page.goto('/agents/activity')

  const retrieval = page.getByTestId('audit-row').first()
  const write = page.getByTestId('session-write-row').filter({ hasText: 'Migration findings' })
  await expect(retrieval).toBeVisible()
  await expect(write).toBeVisible()

  expect(
    await retrieval
      .locator('[data-timeline-slot]')
      .evaluateAll((slots) => slots.map((slot) => slot.getAttribute('data-timeline-slot'))),
  ).toEqual(['action', 'actor', 'context', 'outcome'])
  expect(
    await write
      .locator('[data-timeline-slot]')
      .evaluateAll((slots) => slots.map((slot) => slot.getAttribute('data-timeline-slot'))),
  ).toEqual(['action', 'actor', 'context', 'attributes'])

  const [retrievalRight, writeRight] = await Promise.all([
    retrieval.locator('time').evaluate((node) => node.getBoundingClientRect().right),
    write.locator('time').evaluate((node) => node.getBoundingClientRect().right),
  ])
  expect(Math.abs(retrievalRight - writeRight)).toBeLessThan(0.5)

  const [queryBox, timeCenter, caretCenter] = await Promise.all([
    retrieval.getByText(RETRIEVAL_EVENT.query, { exact: true }).boundingBox(),
    retrieval
      .locator('time')
      .evaluate(
        (node) => node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2,
      ),
    retrieval
      .locator('button[aria-expanded] svg, [data-testid="activity-disclosure-caret"] svg')
      .evaluate(
        (node) => node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2,
      ),
  ])
  expect(Math.abs(timeCenter - caretCenter)).toBeLessThan(0.5)

  expect(queryBox).not.toBeNull()
  await page.mouse.click(
    (queryBox?.x ?? 0) + (queryBox?.width ?? 0) / 2,
    (queryBox?.y ?? 0) + (queryBox?.height ?? 0) / 2,
  )
  await expect(retrieval).toHaveAttribute('data-expanded', 'true')
  await expect(retrieval.getByText('Nothing came back for this query.')).toBeVisible()
})

test('query URLs use contains semantics and filtered-zero stays recoverable', async ({ page }) => {
  let requestedQuery: string | null = null
  await page.route('**/api/me/agent-sessions/all?*', async (route) => {
    const url = new URL(route.request().url())
    requestedQuery = url.searchParams.get('q')

    if (requestedQuery !== 'context') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: {
        ...body,
        events: [{ ...RETRIEVAL_EVENT, query: 'unbound context' }],
        nextCursor: null,
      },
    })
  })
  await login(page)
  await page.goto('/agents/activity?q=context')

  await expect(page).toHaveURL(/\/agents\/activity\?q=context&show=reads$/)
  await expect(page.getByTestId('audit-row').filter({ hasText: 'unbound context' })).toBeVisible()
  expect(requestedQuery).toBe('context')

  await page.goto('/agents/activity?q=definitely-not-in-the-audit')
  await expect(page.getByText('No activity matches these filters')).toBeVisible()
  await page.getByRole('button', { name: 'Reset filters' }).click()
  await expect(page).toHaveURL(/\/agents\/activity$/)
  await expect(page.getByTestId('activity-stream')).toBeVisible()
})

test('an owner without captured activity sees the honest first-run state', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('auth-username').fill('empty')
  await page.getByTestId('auth-password').fill('empty')
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('auth-login')).not.toBeVisible()
  const response = await page.request.get('/api/me/agent-sessions/all')
  expect(response.ok()).toBe(true)
  expect((await response.json()).events).toEqual([])
  await page.goto('/agents/activity')

  await expect(page.getByText('No agent activity yet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset filters' })).toHaveCount(0)
})

test('expanded results stay subordinate and explain their ranking', async ({ page }) => {
  await page.route('**/api/me/agent-sessions/all?*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: { ...body, events: [RETRIEVAL_HIT_EVENT, ...body.events] },
    })
  })
  await login(page)
  await page.goto('/agents/activity')

  const row = page.getByTestId('audit-row').first()
  const head = row.locator('[data-timeline-head]')
  await head.hover()
  await expect
    .poll(() => head.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)')
  const [headBox, markerBox] = await Promise.all([
    head.boundingBox(),
    row.locator('[data-timeline-marker]').boundingBox(),
  ])
  expect((markerBox?.x ?? 0) - (headBox?.x ?? 0)).toBe(8)

  await row.getByText(RETRIEVAL_HIT_EVENT.query, { exact: true }).click()
  const detail = row.locator('[data-timeline-detail]')
  await expect(detail).toHaveCSS('border-top-width', '0px')
  const hit = row.getByTestId('activity-hit-link')
  await expect(hit).toContainText('relevance 8.40')
  const [timeRight, hitRight] = await Promise.all([
    row
      .locator(':scope > [data-timeline-head] [data-timeline-time]')
      .evaluate((element) => element.getBoundingClientRect().right),
    hit.evaluate((element) => element.getBoundingClientRect().right),
  ])
  expect(Math.abs(timeRight - hitRight)).toBeLessThan(0.5)
  await hit.hover()
  await expect
    .poll(() => hit.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)')
  await expect(hit.getByText('relevance 8.40')).toHaveAttribute(
    'title',
    'Retrieval relevance score. Higher scores rank first.',
  )
})

test('session skeleton has the loaded row geometry', async ({ page }) => {
  await login(page)
  let releaseOverview: (() => void) | undefined
  const overviewGate = new Promise<void>((resolve) => {
    releaseOverview = resolve
  })
  await page.route('**/api/me/agent-sessions?*', async (route) => {
    await overviewGate
    await route.continue()
  })

  await page.goto('/agents/activity?group=session')
  const skeletonRow = page.getByTestId('session-list-skeleton').locator('li').first()
  await expect(skeletonRow).toBeVisible()
  const skeletonHeight = await skeletonRow.evaluate((row) => row.getBoundingClientRect().height)

  releaseOverview?.()
  const loadedRow = page.getByTestId('activity-session-row').first()
  await expect(loadedRow).toBeVisible()
  const loadedHeight = await loadedRow.evaluate((row) => row.getBoundingClientRect().height)
  expect(skeletonHeight).toBe(loadedHeight)
})

test('flat-stream skeleton has the loaded row geometry', async ({ page }) => {
  await login(page)
  let releaseStream: (() => void) | undefined
  const streamGate = new Promise<void>((resolve) => {
    releaseStream = resolve
  })
  await page.route('**/api/me/agent-sessions/all?*', async (route) => {
    await streamGate
    await route.continue()
  })

  await page.goto('/agents/activity')
  const skeletonRow = page.getByTestId('audit-skeleton').locator(':scope > li').first()
  await expect(skeletonRow).toBeVisible()
  const skeletonHeight = await skeletonRow.evaluate((row) => row.getBoundingClientRect().height)

  releaseStream?.()
  const loadedRow = page.getByTestId('session-write-row').first()
  await expect(loadedRow).toBeVisible()
  const loadedHeight = await loadedRow.evaluate((row) => row.getBoundingClientRect().height)
  expect(skeletonHeight).toBe(loadedHeight)
})

test('agent facet stays visible, compact and URL-restorable', async ({ page }) => {
  await login(page)
  await page.goto('/agents/activity?group=session')
  const openPanels = page.getByRole('button', { name: 'Open activity panels' })
  await openPanels.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('aside-tab-filters')).toBeFocused()

  const facet = page.getByTestId('activity-agent-filter')
  const agentList = facet.getByTestId('activity-agent-list')
  const claude = agentList.getByTitle('Claude')
  await expect(agentList).toBeVisible()
  await expect(agentList).toHaveCSS('max-height', '128px')
  await expect(page.getByTestId('activity-query-filter')).toBeVisible()
  expect(
    await page
      .getByTestId('activity-filters')
      .locator(':scope > section')
      .evaluateAll((sections) => sections.map((section) => section.getAttribute('data-testid'))),
  ).toEqual(['activity-query-filter', 'activity-agent-filter'])
  await expect(facet.getByText('All agents')).toHaveCount(0)
  await expect(claude.locator('span').last()).toHaveText(/^\d+$/)
  await expect(claude).toHaveAttribute('aria-pressed', 'false')
  await claude.click()

  await expect(page).toHaveURL(/\/agents\/activity\?agent=Claude$/)
  await expect(page.getByRole('button', { name: 'None', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('session-write-row')).toHaveCount(1)

  await page.reload()
  await expect(claude).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('session-write-row')).toHaveCount(1)

  await claude.click()
  await expect(page).toHaveURL(/\/agents\/activity$/)
  await expect(claude).toHaveAttribute('aria-pressed', 'false')

  const closePanels = page.getByRole('button', { name: 'Close activity panels' })
  await closePanels.focus()
  await page.keyboard.press('Enter')
  await expect(openPanels).toBeFocused()
})

test('a selected Agent remains visible without a fabricated count when diagnostics fail', async ({
  page,
}) => {
  await page.route('**/api/me/agent-sessions/all?*', async (route) => {
    const url = new URL(route.request().url())

    if (url.searchParams.get('aggregates') === '1') {
      await route.fulfill({ status: 500, json: { error: 'aggregate failure' } })
      return
    }
    await route.continue()
  })

  await login(page)
  await page.goto('/agents/activity?agent=CLI')
  await page.getByRole('button', { name: 'Open activity panels' }).click()

  const selectedAgent = page.getByTestId('activity-agent-list').getByTitle('CLI')
  await expect(selectedAgent).toBeVisible()
  await expect(selectedAgent).toHaveAttribute('aria-pressed', 'true')
  await expect(selectedAgent).toHaveText('CLI')
})

test('Diagnostics opts in once and narrows the stream with one URL write', async ({ page }) => {
  const eventRequests: URL[] = []
  const noteRequests: URL[] = []

  page.on('request', (request) => {
    const url = new URL(request.url())

    if (url.pathname === '/api/me/agent-sessions/all') {
      eventRequests.push(url)
    }
    if (url.pathname === '/api/s/main/notes') {
      noteRequests.push(url)
    }
  })
  await page.route('**/api/me/agent-sessions/all?*', async (route) => {
    const url = new URL(route.request().url())

    if (url.searchParams.get('q') === RETRIEVAL_EVENT.query) {
      await route.fulfill({
        json: {
          target: { kind: 'all' },
          events: [RETRIEVAL_EVENT],
          total: null,
          hasMore: false,
          nextCursor: null,
          aggregates: null,
        },
      })
      return
    }

    const response = await route.fetch()

    if (url.searchParams.get('aggregates') === '1') {
      await route.fulfill({
        response,
        json: { ...(await response.json()), aggregates: RETRIEVAL_AGGREGATES },
      })
      return
    }
    await route.fulfill({ response })
  })

  await login(page)
  await page.goto('/agents/activity?show=writes&group=session')
  await expect(page.getByTestId('activity-session-list')).toBeVisible()
  expect(eventRequests).toEqual([])
  await expect(page.getByText('Blind spots')).toHaveCount(0)

  await page.getByRole('button', { name: 'Open activity panels' }).click()
  await page.getByTestId('aside-tab-diagnostics').click()
  const diagnostics = page.getByTestId('activity-diagnostics')
  const blindSpot = page.getByRole('button', { name: /^Search legacy rollout guide/ })
  await expect(blindSpot).toBeVisible()
  await expect(diagnostics.locator('[data-aside-section-heading]')).toHaveCount(2)
  expect(
    await diagnostics
      .locator('section')
      .evaluateAll((sections) =>
        sections.map((section) => getComputedStyle(section).backgroundColor),
      ),
  ).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
  await expect(blindSpot).toHaveCSS('padding-left', '8px')
  const sections = diagnostics.locator('section')
  await expect(sections.nth(1)).toHaveCSS('border-top-width', '1px')
  expect(
    await sections.nth(1).evaluate((section) => {
      const style = getComputedStyle(section)
      return { marginTop: style.marginTop, paddingTop: style.paddingTop }
    }),
  ).toEqual({ marginTop: '12px', paddingTop: '12px' })
  expect(eventRequests.filter((url) => url.searchParams.get('aggregates') === '1')).toHaveLength(1)

  await page.evaluate(() => {
    const tracked = window as typeof window & { activityReplaceCount: number }
    const original = history.replaceState
    tracked.activityReplaceCount = 0
    history.replaceState = function (...args) {
      tracked.activityReplaceCount += 1
      return original.apply(this, args)
    }
  })
  await blindSpot.click()

  await expect(page).toHaveURL(
    /\/agents\/activity\?show=reads&tool=search&q=legacy\+rollout\+guide$/,
  )
  await expect(page.getByRole('button', { name: 'None', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('button', { name: 'Reads', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('activity-active-filter')).toHaveCount(0)
  await expect(page.getByTestId('audit-row')).toContainText('legacy rollout guide')
  await expect(blindSpot).toHaveAttribute('aria-pressed', 'true')
  await expect(diagnostics.getByRole('button', { name: /Clear legacy rollout guide/ })).toHaveCount(
    0,
  )
  expect(
    await page.evaluate(
      () => (window as typeof window & { activityReplaceCount: number }).activityReplaceCount,
    ),
  ).toBe(1)
  expect(noteRequests).toEqual([])

  await blindSpot.click()
  await expect(page).toHaveURL(/\/agents\/activity\?show=reads$/)
  await expect(blindSpot).toHaveAttribute('aria-pressed', 'false')

  await blindSpot.click()
  const clearedResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname === '/api/me/agent-sessions/all' &&
      url.searchParams.get('filter') === 'reads' &&
      !url.searchParams.has('q')
    )
  })
  await blindSpot.click()
  await clearedResponse
  await expect(page).toHaveURL(/\/agents\/activity\?show=reads$/)
  await expect(blindSpot).toHaveAttribute('aria-pressed', 'false')

  await page.getByTestId('aside-tab-filters').click()
  const queryFilter = page.getByTestId('activity-query-filter')
  await expect(queryFilter.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(queryFilter.getByRole('button', { name: 'Apply query' })).toHaveCount(0)
  await queryFilter.getByRole('textbox', { name: 'Retrieval query' }).fill('legacy rollout guide')
  await expect(page).toHaveURL(/\/agents\/activity\?show=reads&q=legacy\+rollout\+guide$/)
  const debouncedRequest = eventRequests
    .filter((url) => url.searchParams.get('q') === 'legacy rollout guide')
    .at(-1)
  expect(debouncedRequest?.searchParams.has('tool')).toBe(false)
  await queryFilter.getByRole('button', { name: 'Clear search' }).click()
  await expect(page).toHaveURL(/\/agents\/activity\?show=reads$/)

  await queryFilter.getByRole('textbox', { name: 'Retrieval query' }).fill('stale draft')
  await page.getByRole('button', { name: 'Writes', exact: true }).click()
  await page.waitForTimeout(450)
  await expect(page).toHaveURL(/\/agents\/activity\?show=writes$/)
  await expect(queryFilter.getByRole('textbox', { name: 'Retrieval query' })).toHaveValue('')

  await page.getByTestId('aside-tab-diagnostics').click()
  await blindSpot.click()
  await expect(page).toHaveURL(
    /\/agents\/activity\?show=reads&tool=search&q=legacy\+rollout\+guide$/,
  )
  await page.getByRole('button', { name: 'Close activity panels' }).click()
  await page.getByRole('button', { name: 'Open activity panels' }).click()
  await expect(page.getByTestId('aside-tab-diagnostics')).toHaveAttribute('aria-selected', 'true')
  expect(eventRequests.filter((url) => url.searchParams.get('aggregates') === '1')).toHaveLength(1)

  const overviewRight = await page
    .getByTestId('agents-activity')
    .evaluate((element) => element.getBoundingClientRect().right)
  await page.getByRole('link', { name: 'Outside session' }).click()
  const episode = page.getByTestId('agent-activity-episode')
  await expect(episode).toBeVisible()
  const episodeRight = await episode.evaluate((element) => element.getBoundingClientRect().right)
  expect(Math.abs(episodeRight - overviewRight)).toBeLessThanOrEqual(1)
  await expect(page.getByText('Unattributed activity', { exact: true })).toBeVisible()
  await expect(page.getByTestId('aside-groups')).toBeVisible()
  await expect(page.getByTestId('aside-tab-diagnostics')).toHaveAttribute('aria-selected', 'true')
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Activity', exact: true })
    .click()
  await expect(page.getByTestId('agents-activity')).toBeVisible()
  await expect(page.getByTestId('aside-tab-diagnostics')).toHaveAttribute('aria-selected', 'true')
  expect(eventRequests.filter((url) => url.searchParams.get('aggregates') === '1')).toHaveLength(1)

  const finalClearResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname === '/api/me/agent-sessions/all' &&
      url.searchParams.get('filter') === 'reads' &&
      !url.searchParams.has('q')
    )
  })
  await blindSpot.click()
  await finalClearResponse
  await expect(page).toHaveURL(/\/agents\/activity\?show=reads$/)
  await expect(page.getByTestId('activity-active-filter')).toHaveCount(0)
})

test('Diagnostics shows honest empty panels after an empty aggregate response', async ({
  page,
}) => {
  await page.route('**/api/me/agent-sessions/all?*', async (route) => {
    const url = new URL(route.request().url())

    if (url.searchParams.get('aggregates') !== '1') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        aggregates: {
          retrieval: { totalQueries: 0, missCount: 0, top: [], misses: [] },
          agents: [],
        },
      },
    })
  })

  await login(page)
  await page.goto('/agents/activity')
  await page.getByRole('button', { name: 'Open activity panels' }).click()
  await page.getByTestId('aside-tab-diagnostics').click()

  await expect(page.getByTestId('activity-diagnostics')).toBeVisible()
  await expect(page.getByText('No recurring empty queries.')).toBeVisible()
  await expect(page.getByText('No retrieval queries yet.')).toBeVisible()
  await expect(page.getByTestId('audit-skeleton')).toHaveCount(0)
})

test('legacy session links preserve the episode id and back preserves view state', async ({
  page,
}) => {
  await login(page)
  const overview = (await (await page.request.get('/api/me/agent-sessions')).json()) as {
    sessions: Array<{ id: string; parentId: string | null }>
  }
  const fork = overview.sessions.find((session) => session.parentId)
  expect(fork).toBeDefined()
  const id = fork?.id ?? overview.sessions[0].id

  await page.goto(`/agents/sessions/${id}?show=writes&neighbor=kept`)
  await expect(page).toHaveURL(new RegExp(`/agents/activity/${id}\\?show=writes&neighbor=kept$`))
  await expect(page.getByTestId('agent-activity-episode')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Writes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByText('Session activity', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Forked from parent session' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'All activity' })).toHaveCount(0)

  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Activity', exact: true })
    .click()
  await expect(page).toHaveURL(/\/agents\/activity\?show=writes&neighbor=kept$/)

  for (const legacy of ['/agents/sessions', '/agents/audit', '/agents/session/x']) {
    await page.goto(legacy)
    await expect(page).toHaveURL(/\/agents\/activity$/)
    await expect(page.getByTestId('agents-activity')).toBeVisible()
  }
  await page.goto('/agents/activity/all')
  await expect(page).toHaveURL(/\/agents\/activity$/)
})

test('the narrow aside is one inert-safe drawer and keeps persistence across 720px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 760 })
  await login(page)
  await page.goto('/agents/activity?show=writes&neighbor=kept')
  const url = page.url()

  const open = page.getByRole('button', { name: 'Open activity panels' })
  await expect(open).toBeVisible()
  await open.click()

  const aside = page.getByTestId('aside-groups')
  await expect(aside).toBeVisible()
  await expect(aside).toHaveAttribute('role', 'dialog')
  await expect(aside).toHaveAttribute('aria-modal', 'true')
  const filtersTab = page.getByTestId('aside-tab-filters')
  await expect(filtersTab).toBeFocused()
  const diagnosticsTab = page.getByTestId('aside-tab-diagnostics')
  const diagnosticsPanelId = await diagnosticsTab.getAttribute('aria-controls')
  expect(diagnosticsPanelId).toBeTruthy()
  await expect(page.locator(`#${diagnosticsPanelId}`)).toHaveCount(1)
  await page.keyboard.press('ArrowRight')
  await expect(diagnosticsTab).toBeFocused()
  await expect(diagnosticsTab).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Shift+Tab')
  expect(await aside.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  await expect(page.locator('main')).toHaveAttribute('inert', '')
  await expect(page.getByRole('button', { name: /activity panels/ })).toHaveCount(1)
  const box = await aside.boundingBox()
  expect(box?.width).toBeLessThanOrEqual(375)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  expect(page.url()).toBe(url)

  await page.setViewportSize({ width: 721, height: 760 })
  await expect(aside).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('bm-aside'))).toBe('1')
  await page.setViewportSize({ width: 719, height: 760 })
  await expect(aside).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(aside).toHaveCount(0)
  await expect(page.locator('main')).not.toHaveAttribute('inert', '')
  await expect(page.getByRole('button', { name: 'Open activity panels' })).toBeFocused()
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => localStorage.getItem('bm-aside'))).toBe('0')
})

test('a restored-open narrow aside receives focus inside its modal', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 })
  await page.addInitScript(() => localStorage.setItem('bm-aside', '1'))
  await login(page)
  await page.goto('/agents/activity')

  const aside = page.getByTestId('aside-groups')
  await expect(aside).toHaveAttribute('role', 'dialog')
  await expect(page.getByTestId('aside-tab-filters')).toBeFocused()
  expect(await aside.evaluate((node) => node.contains(document.activeElement))).toBe(true)
})
