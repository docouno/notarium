import { buildCaseWorld, caseToFixture } from '../cases'
import { expect, type Page, test } from './fixtures'

const WORLD = caseToFixture(buildCaseWorld('agent-sessions', { now: '2099-08-05T12:00:00.000Z' }))
const LIVE_WORLD = caseToFixture(
  buildCaseWorld('agent-sessions', { now: '2020-08-05T12:00:00.000Z' }),
)
const DETAILED_WORLD = caseToFixture(
  buildCaseWorld('agent-telemetry-detailed', { now: '2099-08-05T12:00:00.000Z' }),
)

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

const trackEventSources = async (page: Page) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource
    const sources: EventSource[] = []
    Object.defineProperty(window, '__notariumEventSources', {
      configurable: true,
      value: sources,
    })
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(url, eventSourceInitDict)
        sources.push(this)
      }
    }
  })
}

const callMcp = async (
  page: Page,
  baseURL: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const response = await page.request.post(`${baseURL ?? ''}/mcp`, {
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
  })
  expect(response.ok()).toBe(true)
  const rpc = (await response.json()) as {
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> }
  }
  expect(rpc.result?.isError).not.toBe(true)
  return rpc.result?.structuredContent ?? {}
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
  recurringProblems: [
    {
      fingerprint: 'search-invalid-type',
      tool: 'search',
      issues: { code: 'invalid_type' },
      count: 3,
      firstAt: '2099-08-05T10:45:00.000Z',
      lastAt: '2099-08-05T10:55:00.000Z',
      agents: 2,
    },
  ],
} as const

test('trace-first call detail and instance telemetry settings stay inspectable', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DETAILED_WORLD } })
  await login(page)
  await page.goto('/agents/activity')

  await expect(page.getByTestId('agent-telemetry-notice')).toHaveCount(0)
  await expect(page.getByTestId('agent-call-row')).toHaveCount(18)
  const detailedListCall = page
    .getByTestId('agent-call-row')
    .filter({ hasText: 'list_notes' })
    .filter({ hasText: 'migration review' })
  await detailedListCall
    .getByRole('button', { name: 'Toggle call details for list_notes' })
    .press('Enter')
  await expect(detailedListCall).toContainText('"status": "available"')
  await expect(detailedListCall.getByRole('button', { name: 'Copy code' })).toBeVisible()
  await expect(detailedListCall.locator('.hljs-string').first()).toBeVisible()
  const compactListCall = page
    .getByTestId('agent-call-row')
    .filter({ hasText: 'list_notes' })
    .filter({ hasText: 'Compact-only comparison' })
  await compactListCall
    .getByRole('button', { name: 'Toggle call details for list_notes' })
    .press('Enter')
  await expect(compactListCall).toContainText('"status": "expired_or_missing"')
  const errorsResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())

    return (
      url.pathname === '/api/me/agent-sessions/all' &&
      url.searchParams.get('outcome') === 'errors' &&
      !url.searchParams.has('filter')
    )
  })

  await page.getByRole('button', { name: 'Errors', exact: true }).click()
  await expect(page).toHaveURL(/outcome=errors/)
  expect((await errorsResponse).ok()).toBeTruthy()
  const errorRows = page.getByTestId('agent-call-row')
  await expect(errorRows).toHaveCount(7)
  await page
    .getByRole('group', { name: 'Filter by call outcome' })
    .getByRole('button', { name: 'All', exact: true })
    .click()
  await page.getByRole('button', { name: 'Session', exact: true }).click()
  const failureEpisode = page
    .getByTestId('activity-session-row')
    .filter({ hasText: 'Failure outcome matrix' })
  await failureEpisode.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Copy trace' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Download trace' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Delete session' })).toBeVisible()

  await page.goto('/settings/telemetry')
  await expect(page.getByTestId('agent-telemetry-detailed')).toBeChecked()
  await expect(page.getByText('Compact retention')).toBeVisible()
  await expect(page.getByText(/additional allowlisted detail row/)).toBeVisible()
  await expect(page.getByText(/does not add token charges/)).toBeVisible()
  await expect(page.getByText(/Note bodies, edit content/)).toBeVisible()
})

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
  const requestsBeforeContinuation = eventRequests.length
  await page.getByRole('button', { name: 'Load older activity' }).click()
  await expect(page.getByTestId('session-write-row')).toHaveCount(58)
  expect(eventRequests).toHaveLength(requestsBeforeContinuation + 1)
  expect(eventRequests.at(-1)?.searchParams.has('cursor')).toBe(true)
  const unavailable = page
    .getByTestId('session-write-row')
    .filter({ hasText: 'Unavailable revision' })
  await expect(unavailable.getByText('Unavailable', { exact: true })).toBeVisible()
  await expect(unavailable.getByRole('link', { name: 'Unavailable revision' })).toHaveCount(0)
  expect(eventRequests).not.toHaveLength(0)
  expect(eventRequests.every((url) => !url.searchParams.has('aggregates'))).toBe(true)

  await page.getByRole('button', { name: 'Mutations', exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/activity\?show=writes$/)
  await expect(page.getByTestId('session-write-row').first()).toBeVisible()
  await expect(page.getByTestId('audit-row')).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Mutations', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('session-write-row').first()).toBeVisible()

  await page
    .getByRole('group', { name: 'Show activity' })
    .getByRole('button', { name: 'All', exact: true })
    .click()
  await expect(page).toHaveURL(/\/agents\/activity$/)
})

test('@v15 an open Activity window follows one named MCP episode without a reload', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: LIVE_WORLD } })
  await login(page)
  await page.goto('/agents/activity')

  const stream = page.getByTestId('activity-stream')
  await expect(stream).toBeVisible()
  await page.getByRole('button', { name: 'Load older activity' }).click()
  await expect.poll(() => stream.locator(':scope > li').count()).toBeGreaterThan(50)
  const rowsBefore = await stream.locator(':scope > li').count()
  expect(rowsBefore).toBeGreaterThan(50)
  const metricBefore = await page.getByTestId('agents-tab-activity').textContent()
  const sessions = page.getByTestId('agents-explorer-sessions')
  await expect(sessions).toBeVisible()
  await expect(sessions.getByText('Live Activity proof', { exact: true })).toHaveCount(0)

  const started = await callMcp(page, baseURL, 'start_session', {
    project: 'main',
    session: { name: 'Live Activity proof' },
  })
  const sessionId = (started.session as { id?: string } | undefined)?.id
  expect(sessionId).toBeTruthy()
  await expect(sessions.getByText('Live Activity proof', { exact: true })).toBeVisible()
  await expect
    .poll(() => page.getByTestId('agents-tab-activity').textContent())
    .not.toBe(metricBefore)

  await callMcp(page, baseURL, 'search', {
    project: 'main',
    session: sessionId,
    query: 'live activity delivery proof',
  })
  await callMcp(page, baseURL, 'create_note', {
    project: 'main',
    session: sessionId,
    title: 'Live Activity note',
    body: '# Live Activity note\n\nCreated while Activity stayed open.',
  })

  await expect(
    page.getByTestId('agent-call-row').filter({ hasText: 'live activity delivery proof' }),
  ).toBeVisible()
  await expect(
    page.getByTestId('agent-call-row').filter({ hasText: 'Live Activity note' }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Live Activity proof' }).first()).toBeVisible()
  await expect.poll(() => stream.locator(':scope > li').count()).toBeGreaterThan(50)
  await expect(page).toHaveURL(/\/agents\/activity$/)
})

test('@v15 a session revision supersedes Load older without losing requested depth', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: LIVE_WORLD } })
  let releaseOld: (() => void) | undefined
  let markHeld: (() => void) | undefined
  let markDone: (() => void) | undefined
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  const oldHeld = new Promise<void>((resolve) => {
    markHeld = resolve
  })
  const oldDone = new Promise<void>((resolve) => {
    markDone = resolve
  })
  let blocked = false
  await page.route('**/api/me/agent-sessions/all?*', async (route) => {
    const url = new URL(route.request().url())

    if (url.searchParams.has('cursor') && !blocked) {
      blocked = true
      const response = await route.fetch()
      markHeld?.()
      await oldGate
      await route.fulfill({ response }).catch(() => {})
      markDone?.()
      return
    }
    await route.continue()
  })

  await login(page)
  await page.goto('/agents/activity')
  const stream = page.getByTestId('activity-stream')
  await expect(stream.locator(':scope > li')).toHaveCount(50)
  await page.getByRole('button', { name: 'Load older activity' }).click()
  await oldHeld

  await callMcp(page, baseURL, 'start_session', {
    project: 'main',
    session: { name: 'Load older revision winner' },
  })
  await expect(page.getByRole('link', { name: 'Load older revision winner' }).first()).toBeVisible()
  await expect.poll(() => stream.locator(':scope > li').count()).toBeGreaterThan(50)
  releaseOld?.()
  await oldDone
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await expect(
    page.getByTestId('agent-call-row').filter({ hasText: 'Load older revision winner' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Load older activity' })).toHaveCount(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('@v15 Activity reconciles committed work after its EventSource reconnects', async ({
  page,
  baseURL,
}) => {
  await trackEventSources(page)
  await login(page)
  await page.goto('/agents/activity')
  await expect(page.getByTestId('activity-stream')).toBeVisible()
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
      throw new Error('no open EventSource to disconnect')
    }
    source.close()
    source.dispatchEvent(new Event('error'))
  })
  await page.waitForFunction(() => {
    const sources = (window as typeof window & { __notariumEventSources?: readonly EventSource[] })
      .__notariumEventSources
    return !sources?.some((source) => source.readyState === EventSource.OPEN)
  })

  await callMcp(page, baseURL, 'start_session', {
    project: 'main',
    session: { name: 'Activity reconnect proof' },
  })
  await expect(page.getByRole('link', { name: 'Activity reconnect proof' }).first()).toBeVisible({
    timeout: 10_000,
  })
  await expect(
    page.getByTestId('agents-explorer-sessions').getByText('Activity reconnect proof', {
      exact: true,
    }),
  ).toBeVisible()
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
  // Do not let a routed cursor read that is unwinding browser fixture cleanup outlive the test.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('Session grouping filters before pagination and separates nested episode timelines', async ({
  page,
}) => {
  const episodeContinuations: URL[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())

    if (
      url.pathname.startsWith('/api/me/agent-sessions/') &&
      url.pathname !== '/api/me/agent-sessions/all' &&
      url.searchParams.has('cursor')
    ) {
      episodeContinuations.push(url)
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
  const writesOverview = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === '/api/me/agent-sessions' && url.searchParams.get('filter') === 'writes'
  })
  await page.getByRole('button', { name: 'Session', exact: true }).click()

  await expect(page).toHaveURL(/\/agents\/activity\?show=writes&group=session$/)
  const writesOverviewUrl = new URL((await writesOverview).url())
  expect(
    await page.getByText('Recent episodes', { exact: true }).evaluate((node) => {
      const style = getComputedStyle(node)
      return { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight }
    }),
  ).toEqual(flatHeadingType)
  await expect(page.getByTestId('activity-session-list')).toBeVisible()
  await expect(page.getByTestId('activity-session-outside')).toBeVisible()
  expect(writesOverviewUrl.searchParams.get('filter')).toBe('writes')
  await expect(page.getByText('3 sessions')).toBeVisible()
  const activityMain = page.locator('main.main')
  await expect(activityMain.getByText('release planning', { exact: true })).toHaveCount(0)
  await expect(activityMain.getByText('main · automatic seed', { exact: true })).toHaveCount(0)
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
  const continuationsBefore = episodeContinuations.length
  await archived.getByRole('button', { name: 'Load older episode activity' }).click()
  await expect(archived.getByTestId('session-write-row')).toHaveCount(54)
  expect(episodeContinuations).toHaveLength(continuationsBefore + 1)

  const readsOverview = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === '/api/me/agent-sessions' && url.searchParams.get('filter') === 'reads'
  })
  await page.getByRole('button', { name: 'Reads', exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/activity\?show=reads&group=session$/)
  const readsOverviewUrl = new URL((await readsOverview).url())
  expect(readsOverviewUrl.searchParams.get('filter')).toBe('reads')
  await expect(page.getByText('0 sessions')).toBeVisible()
  await expect(activityMain.getByText('release planning', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('activity-session-events')).toHaveCount(0)
  await expect(
    page.locator('[data-testid="activity-session-row"][data-expanded="true"]'),
  ).toHaveCount(0)
  await expect(page.getByTestId('activity-session-row')).toHaveCount(0)
  await expect(page.getByText('No activity matches these filters')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset filters' })).toBeVisible()

  await page
    .getByRole('group', { name: 'Show activity' })
    .getByRole('button', { name: 'All', exact: true })
    .click()
  const unaudited = page.getByTestId('activity-session-row').filter({
    hasText: 'main · automatic seed',
  })
  await expect(unaudited).toContainText('no audited activity')
  await expect(unaudited).toHaveCSS('opacity', '1')
})

test('@v15 grouped and deep episodes refresh live and a confirmed 404 stays terminal', async ({
  page,
  baseURL,
}) => {
  await login(page)
  await page.goto('/agents/activity?group=session')
  await expect(page.getByTestId('activity-session-list')).toBeVisible()

  const started = await callMcp(page, baseURL, 'start_session', {
    project: 'main',
    session: { name: 'Live grouped proof' },
  })
  const sessionId = (started.session as { id?: string } | undefined)?.id
  expect(sessionId).toBeTruthy()
  const row = page.getByTestId('activity-session-row').filter({ hasText: 'Live grouped proof' })
  await expect(row).toBeVisible()
  await row.getByText('Live grouped proof', { exact: true }).click()
  await expect(row).toHaveAttribute('data-expanded', 'true')

  await callMcp(page, baseURL, 'search', {
    project: 'main',
    session: sessionId,
    query: 'grouped live refresh proof',
  })
  await expect(row).toHaveAttribute('data-expanded', 'true')
  await expect(
    row.getByTestId('agent-call-row').filter({ hasText: 'grouped live refresh proof' }),
  ).toBeVisible()

  await page.goto(`/agents/activity/${sessionId}`)
  await expect(page.getByTestId('agent-activity-episode')).toBeVisible()
  await callMcp(page, baseURL, 'create_note', {
    project: 'main',
    session: sessionId,
    title: 'Deep live Activity note',
    body: '# Deep live Activity note\n\nThe permalink stayed open.',
  })
  await expect(
    page.getByTestId('agent-call-row').filter({ hasText: 'Deep live Activity note' }),
  ).toBeVisible()

  const removed = await page.request.delete(
    `${baseURL}/api/me/agent-sessions/${sessionId}?confirmActive=true`,
  )
  expect(removed.ok()).toBe(true)
  await expect(page.getByTestId('activity-episode-not-found')).toContainText(
    'This activity episode no longer exists.',
  )
  await expect(page).toHaveURL(new RegExp(`/agents/activity/${sessionId}$`))
})

test('@v15 grouped and deep continuations keep N+1 intent across a revision', async ({
  page,
  baseURL,
}) => {
  await login(page)
  const overview = (await (await page.request.get('/api/me/agent-sessions')).json()) as {
    sessions: Array<{ id: string; name: string }>
  }
  const archived = overview.sessions.find((session) => session.name === 'expired retention probe')
  expect(archived).toBeDefined()
  const id = archived!.id
  let blocker: { held: Promise<void>; release: () => void; markHeld: () => void } | null = null

  const armCursorBlock = () => {
    let release: (() => void) | undefined
    let markHeld: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = new Promise<void>((resolve) => {
      markHeld = resolve
    })
    blocker = { held, release: () => release?.(), markHeld: () => markHeld?.() }
    return { held, gate, release: () => release?.() }
  }
  let activeGate: Promise<void> | null = null
  await page.route(`**/api/me/agent-sessions/${id}?*`, async (route) => {
    const url = new URL(route.request().url())

    if (url.searchParams.has('cursor') && blocker) {
      const current = blocker
      blocker = null
      const response = await route.fetch()
      current.markHeld()
      await activeGate
      await route.fulfill({ response }).catch(() => {})
      return
    }
    await route.continue()
  })

  await page.goto('/agents/activity?group=session')
  const row = page.getByTestId('activity-session-row').filter({ hasText: archived!.name })
  await row.getByText(archived!.name, { exact: true }).click()
  await expect(row.getByTestId('session-write-row')).toHaveCount(50)
  const groupedBlock = armCursorBlock()
  activeGate = groupedBlock.gate
  await row.getByRole('button', { name: 'Load older episode activity' }).click()
  await groupedBlock.held
  await callMcp(page, baseURL, 'start_session', {
    project: 'main',
    session: { name: 'Grouped continuation revision' },
  })
  await expect(row.getByTestId('session-write-row')).toHaveCount(54)
  await expect(row).toHaveAttribute('data-expanded', 'true')
  groupedBlock.release()

  await page.getByRole('link', { name: archived!.name, exact: true }).click()
  const deep = page.getByTestId('agent-activity-episode')
  await expect(deep.getByTestId('session-write-row')).toHaveCount(50)
  const deepBlock = armCursorBlock()
  activeGate = deepBlock.gate
  await deep.getByRole('button', { name: 'Load older activity' }).click()
  await deepBlock.held
  await callMcp(page, baseURL, 'start_session', {
    project: 'main',
    session: { name: 'Deep continuation revision' },
  })
  await expect(deep.getByTestId('session-write-row')).toHaveCount(54)
  deepBlock.release()
  await expect(page).toHaveURL(new RegExp(`/agents/activity/${id}$`))
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('@v15 grouped live revalidation caps concurrency and commits only the newest queue', async ({
  page,
}) => {
  await trackEventSources(page)
  await login(page)
  const sourceOverview = (await (
    await page.request.get('/api/me/agent-sessions?limit=30&aggregates=0')
  ).json()) as {
    sessions: Array<
      Record<string, unknown> & { id: string; name: string; reads: number; writes: number }
    >
    [key: string]: unknown
  }
  const template = sourceOverview.sessions.find(
    (session) => session.name === 'expired retention probe',
  )
  expect(template).toBeDefined()
  const sourceEpisode = (await (
    await page.request.get(`/api/me/agent-sessions/${template!.id}?limit=50`)
  ).json()) as {
    events: Array<Record<string, unknown> & { id: string; type: string }>
    target: Record<string, unknown>
    [key: string]: unknown
  }
  const templateEvent = sourceEpisode.events.find((event) => event.type === 'write')
  expect(templateEvent).toBeDefined()
  const fakeSessions = Array.from({ length: 12 }, (_, index) => ({
    ...template,
    id: `perf-episode-${index}`,
    name: `Perf episode ${index}`,
  }))
  let phase: 'initial' | 'old' | 'newest' = 'initial'
  let active = 0
  let maxActive = 0
  let refreshRequests = 0
  let releaseRefreshes: (() => void) | undefined
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefreshes = resolve
  })

  const episodePayload = (id: string, requestPhase: typeof phase) => {
    const name = fakeSessions.find((session) => session.id === id)!.name

    return {
      ...sourceEpisode,
      target: { ...sourceEpisode.target, id, name },
      events: [
        {
          ...templateEvent,
          id: `${requestPhase}-${id}`,
          noteId: `${requestPhase}-${id}`,
          sessionId: id,
          sessionName: name,
          title: `${requestPhase} ${name}`,
        },
      ],
      total: 1,
      hasMore: false,
      nextCursor: null,
      aggregates: null,
    }
  }

  await page.route('**/api/me/agent-sessions?*', async (route) => {
    const url = new URL(route.request().url())

    if (url.searchParams.get('limit') === '30' && url.searchParams.get('aggregates') === '0') {
      await route.fulfill({
        json: {
          ...sourceOverview,
          sessions: fakeSessions,
          outside: null,
          total: fakeSessions.length,
          active: 0,
          hasMore: false,
          nextCursor: null,
          aggregates: null,
        },
      })
      return
    }
    await route.continue()
  })
  await page.route('**/api/me/agent-sessions/perf-episode-*?*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!
    const requestPhase = phase

    if (requestPhase === 'initial') {
      await route.fulfill({ json: episodePayload(id, requestPhase) })
      return
    }
    refreshRequests += 1
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      await refreshGate
      await route.fulfill({ json: episodePayload(id, requestPhase) }).catch(() => {})
    } finally {
      active -= 1
    }
  })

  await page.goto('/agents/activity?group=session')
  const rows = page.getByTestId('activity-session-row')
  await expect(rows).toHaveCount(12)
  for (let index = 0; index < 12; index += 1) {
    const row = rows.filter({
      has: page.getByText(`Perf episode ${index}`, { exact: true }),
    })
    await row.getByText(`Perf episode ${index}`, { exact: true }).click()
    await expect(row).toContainText(`initial Perf episode ${index}`)
  }
  await page.waitForFunction(() => {
    const sources = (window as typeof window & { __notariumEventSources?: readonly EventSource[] })
      .__notariumEventSources
    return sources?.some((source) => source.readyState === EventSource.OPEN)
  })
  const dispatchRevision = async () => {
    await page.evaluate(() => {
      const sources = (
        window as typeof window & { __notariumEventSources?: readonly EventSource[] }
      ).__notariumEventSources
      const source = [...(sources ?? [])]
        .reverse()
        .find((candidate) => candidate.readyState === EventSource.OPEN)

      if (!source) {
        throw new Error('no open EventSource for the Activity performance gate')
      }
      source.dispatchEvent(new Event('agent-sessions'))
    })
  }
  const overviewRefresh = () =>
    page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === '/api/me/agent-sessions' &&
        url.searchParams.get('limit') === '30' &&
        url.searchParams.get('aggregates') === '0'
      )
    })

  phase = 'old'
  const firstOverview = overviewRefresh()
  await dispatchRevision()
  await firstOverview
  await expect.poll(() => refreshRequests).toBe(4)
  expect(active).toBe(4)
  expect(maxActive).toBe(4)

  phase = 'newest'
  const secondOverview = overviewRefresh()
  await dispatchRevision()
  await secondOverview
  releaseRefreshes?.()

  await expect.poll(() => refreshRequests).toBe(16)
  await expect.poll(() => active).toBe(0)
  expect(maxActive).toBe(4)
  for (let index = 0; index < 12; index += 1) {
    const row = rows.filter({
      has: page.getByText(`Perf episode ${index}`, { exact: true }),
    })
    await expect(row).toHaveAttribute('data-expanded', 'true')
    await expect(row).toContainText(`newest Perf episode ${index}`)
    await expect(row).not.toContainText(`old Perf episode ${index}`)
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('@v15 leaving grouped Activity aborts its expanded episode request', async ({ page }) => {
  await page.addInitScript(() => {
    const tracked = window as typeof window & {
      __task398EpisodeSignals?: Array<{ aborted: boolean; url: string }>
    }
    const nativeFetch = window.fetch
    tracked.__task398EpisodeSignals = []
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)

      if (url.pathname.startsWith('/api/me/agent-sessions/') && init?.signal) {
        const entry = { aborted: init.signal.aborted, url: url.pathname }
        init.signal.addEventListener('abort', () => {
          entry.aborted = true
        })
        tracked.__task398EpisodeSignals?.push(entry)
      }

      return nativeFetch(input, init)
    }
  })
  await login(page)
  const overview = (await (await page.request.get('/api/me/agent-sessions')).json()) as {
    sessions: Array<{ id: string; name: string }>
  }
  const archived = overview.sessions.find((session) => session.name === 'expired retention probe')
  expect(archived).toBeDefined()
  let release: (() => void) | undefined
  let markHeld: (() => void) | undefined
  let markDone: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = new Promise<void>((resolve) => {
    markHeld = resolve
  })
  const done = new Promise<void>((resolve) => {
    markDone = resolve
  })
  let first = true
  await page.route(`**/api/me/agent-sessions/${archived!.id}?*`, async (route) => {
    const url = new URL(route.request().url())

    if (first && !url.searchParams.has('cursor')) {
      first = false
      markHeld?.()
      await gate
      try {
        await route.continue()
      } catch {
        /* The page-side AbortSignal is the assertion; the routed socket may still unwind. */
      } finally {
        markDone?.()
      }

      return
    }
    await route.continue()
  })

  await page.goto('/agents/activity?group=session')
  const row = page.getByTestId('activity-session-row').filter({ hasText: archived!.name })
  await row.getByText(archived!.name, { exact: true }).click()
  await held
  await page.getByRole('link', { name: archived!.name, exact: true }).click()
  await expect(page.getByTestId('agent-activity-episode')).toBeVisible()
  expect(
    await page.evaluate((sessionId) => {
      const tracked = window as typeof window & {
        __task398EpisodeSignals?: Array<{ aborted: boolean; url: string }>
      }
      return tracked.__task398EpisodeSignals
        ?.filter((entry) => entry.url.endsWith(`/${sessionId}`))
        .map((entry) => entry.aborted)
    }, archived!.id),
  ).toEqual([true, false])
  release?.()
  await done
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('@v15 a stale overview cannot resurrect a confirmed local deletion', async ({
  page,
  baseURL,
}) => {
  let release: (() => void) | undefined
  let markHeld: (() => void) | undefined
  let markDone: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const firstHeld = new Promise<void>((resolve) => {
    markHeld = resolve
  })
  const allDone = new Promise<void>((resolve) => {
    markDone = resolve
  })
  let hold = false
  let held = 0
  let completed = 0
  let expectedCompletions = 0
  await page.route('**/api/me/agent-sessions?*', async (route) => {
    const url = new URL(route.request().url())

    if (!hold || url.searchParams.get('limit') !== '30') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    held += 1
    markHeld?.()
    await gate
    await route.fulfill({ response }).catch(() => {})
    completed += 1
    if (completed === expectedCompletions) {
      markDone?.()
    }
  })

  await login(page)
  await page.goto('/agents/activity?group=session')
  const archived = page
    .getByTestId('activity-session-row')
    .filter({ hasText: 'expired retention probe' })
  await expect(archived).toBeVisible()
  hold = true
  await callMcp(page, baseURL, 'start_session', {
    project: 'main',
    session: { name: 'Delete race trigger' },
  })
  await firstHeld
  await expect.poll(() => held).toBeGreaterThanOrEqual(2)

  await archived.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete session' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(archived).toHaveCount(0)

  expectedCompletions = held
  hold = false
  release?.()
  await allDone
  await page.evaluate(() => new Promise(requestAnimationFrame))
  expect(
    await page
      .getByTestId('activity-session-list')
      .getByText('expired retention probe', { exact: true })
      .count(),
  ).toBe(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('@v15 a displaced expanded episode stays latent and revalidates once on re-entry', async ({
  page,
  baseURL,
}) => {
  let hiddenId: string | null = null
  let hideEpisode = false
  let episodeRequests = 0
  page.on('request', (request) => {
    if (hiddenId && new URL(request.url()).pathname === `/api/me/agent-sessions/${hiddenId}`) {
      episodeRequests += 1
    }
  })
  await page.route('**/api/me/agent-sessions?*', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as {
      sessions: Array<{ id: string }>
      total: number
      [key: string]: unknown
    }

    if (!hideEpisode || !hiddenId) {
      await route.fulfill({ response, json: body })
      return
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        sessions: body.sessions.filter((session) => session.id !== hiddenId),
        total: Math.max(0, body.total - 1),
      },
    })
  })

  await login(page)
  await page.goto('/agents/activity?group=session')
  const started = await callMcp(page, baseURL, 'start_session', {
    project: 'main',
    session: { name: 'Latent episode proof' },
  })
  hiddenId = (started.session as { id?: string } | undefined)?.id ?? null
  expect(hiddenId).toBeTruthy()
  const row = page.getByTestId('activity-session-row').filter({ hasText: 'Latent episode proof' })
  await expect(row).toBeVisible()
  await row.getByText('Latent episode proof', { exact: true }).click()
  await expect(row).toHaveAttribute('data-expanded', 'true')
  await expect.poll(() => episodeRequests).toBe(1)

  hideEpisode = true
  const hiddenOverview = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/me/agent-sessions' && url.searchParams.get('limit') === '30'
  })
  await callMcp(page, baseURL, 'search', {
    project: 'main',
    session: hiddenId,
    query: 'first hidden revision',
  })
  await hiddenOverview
  await expect(row).toHaveCount(0)
  const requestsAfterDisplacement = episodeRequests

  const stillHiddenOverview = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/me/agent-sessions' && url.searchParams.get('limit') === '30'
  })
  await callMcp(page, baseURL, 'search', {
    project: 'main',
    session: hiddenId,
    query: 'second hidden revision',
  })
  await stillHiddenOverview
  expect(episodeRequests).toBe(requestsAfterDisplacement)

  hideEpisode = false
  await callMcp(page, baseURL, 'search', {
    project: 'main',
    session: hiddenId,
    query: 'visible newest revision',
  })
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-expanded', 'true')
  await expect.poll(() => episodeRequests).toBe(requestsAfterDisplacement + 1)
  await expect(
    row.getByTestId('agent-call-row').filter({ hasText: 'visible newest revision' }),
  ).toBeVisible()
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

test('agent facet stays visible and URL-restorable', async ({ page }) => {
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
  // The facet has no box of its own since #393: the wheel over it moves the aside, not a
  // list inside a list. Read as computed style, because that is the whole difference —
  // a nested scroller is pixel-identical in a screenshot.
  await expect(agentList).toHaveCSS('overflow-y', 'visible')
  await expect(agentList).toHaveCSS('max-height', 'none')
  await expect(page.getByTestId('activity-query-filter')).toBeVisible()
  expect(
    await page
      .getByTestId('activity-filters')
      .locator(':scope > section')
      .evaluateAll((sections) => sections.map((section) => section.getAttribute('data-testid'))),
  ).toEqual(['activity-tool-filter', 'activity-query-filter', 'activity-agent-filter'])
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
  await expect(page.getByRole('button', { name: /Sergey · Sync: Synced/ })).toBeVisible()
  expect(eventRequests).toEqual([])
  await expect(page.getByText('Blind spots')).toHaveCount(0)

  await page.getByRole('button', { name: 'Open activity panels' }).click()
  await page.getByTestId('aside-tab-diagnostics').click()
  const diagnostics = page.getByTestId('activity-diagnostics')
  const blindSpot = page.getByRole('button', { name: /^Search legacy rollout guide/ })
  await expect(blindSpot).toBeVisible()
  await expect(diagnostics.locator('[data-aside-section-heading]')).toHaveCount(3)
  expect(
    await diagnostics
      .locator('section')
      .evaluateAll((sections) =>
        sections.map((section) => getComputedStyle(section).backgroundColor),
      ),
  ).toEqual(Array.from({ length: 3 }, () => 'rgba(0, 0, 0, 0)'))
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
  const debouncedRequest = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return (
      url.pathname === '/api/me/agent-sessions/all' &&
      url.searchParams.get('q') === 'legacy rollout guide' &&
      !url.searchParams.has('tool')
    )
  })
  await queryFilter.getByRole('textbox', { name: 'Retrieval query' }).fill('legacy rollout guide')
  await expect(page).toHaveURL(/\/agents\/activity\?show=reads&q=legacy\+rollout\+guide$/)
  expect(new URL((await debouncedRequest).url()).searchParams.has('tool')).toBe(false)
  await queryFilter.getByRole('button', { name: 'Clear search' }).click()
  await expect(page).toHaveURL(/\/agents\/activity\?show=reads$/)

  // Armed BEFORE the typing so nothing sits between it and the click: the scenario needs the
  // switch to land while the query debounce is still pending.
  const writesStream = page.waitForResponse((response) => {
    const url = new URL(response.url())

    return (
      url.pathname === '/api/me/agent-sessions/all' &&
      url.searchParams.get('filter') === 'writes' &&
      !url.searchParams.has('q')
    )
  })
  await queryFilter.getByRole('textbox', { name: 'Retrieval query' }).fill('stale draft')
  await page.getByRole('button', { name: 'Mutations', exact: true }).click()
  await writesStream
  // The switch CANCELS the pending query debounce instead of racing it. The box is fed by the
  // very state the debounce closes over, so an emptied box is the app reporting that the
  // half-typed filter was dropped and the timer re-evaluated — a sleep reports nothing.
  await expect(queryFilter.getByRole('textbox', { name: 'Retrieval query' })).toHaveValue('')
  await expect(page).toHaveURL(/\/agents\/activity\?show=writes$/)

  // That a timer never fires still has to be proven, and the honest clock for it is the
  // debounce itself: a cycle STARTED after the switch is queued behind the abandoned one and
  // so can only reach the server later. Once this query is answered, a surviving timer would
  // already have shipped `stale draft`. It doubles as the positive control that the debounce
  // is alive at all — a query typed now does pull the stream back to reads.
  const laterQuery = page.waitForResponse((response) => {
    const url = new URL(response.url())

    return (
      url.pathname === '/api/me/agent-sessions/all' &&
      url.searchParams.get('q') === 'typed after the switch'
    )
  })
  await queryFilter.getByRole('textbox', { name: 'Retrieval query' }).fill('typed after the switch')
  await laterQuery
  expect(eventRequests.filter((url) => url.searchParams.get('q') === 'stale draft')).toEqual([])
  await expect(page).toHaveURL(/\/agents\/activity\?show=reads&q=typed\+after\+the\+switch$/)
  await queryFilter.getByRole('button', { name: 'Clear search' }).click()
  await expect(page).toHaveURL(/\/agents\/activity\?show=reads$/)

  await page.getByTestId('aside-tab-diagnostics').click()
  await blindSpot.click()
  await expect(page).toHaveURL(
    /\/agents\/activity\?show=reads&tool=search&q=legacy\+rollout\+guide$/,
  )
  const aggregateRequestsBeforeReopen = eventRequests.filter(
    (url) => url.searchParams.get('aggregates') === '1',
  ).length
  await page.getByRole('button', { name: 'Close activity panels' }).click()
  await page.getByRole('button', { name: 'Open activity panels' }).click()
  await expect(page.getByTestId('aside-tab-diagnostics')).toHaveAttribute('aria-selected', 'true')
  expect(eventRequests.filter((url) => url.searchParams.get('aggregates') === '1')).toHaveLength(
    aggregateRequestsBeforeReopen,
  )

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
  expect(eventRequests.filter((url) => url.searchParams.get('aggregates') === '1')).toHaveLength(
    aggregateRequestsBeforeReopen,
  )

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

test('Recurring problems drill into the flat error stream', async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DETAILED_WORLD } })
  await login(page)
  await page.goto('/agents/activity?show=writes&group=session')
  await page.getByRole('button', { name: 'Open activity panels' }).click()
  await page.getByTestId('aside-tab-diagnostics').click()

  const problem = page
    .getByTestId('activity-recurring-problems')
    .getByRole('button', { name: 'search 3 repeats', exact: true })
  await expect(problem).toBeEnabled()
  const errorStream = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return (
      url.pathname === '/api/me/agent-sessions/all' &&
      url.searchParams.get('tool') === 'search' &&
      url.searchParams.get('outcome') === 'errors' &&
      !url.searchParams.has('filter')
    )
  })
  await problem.click()
  await errorStream

  await expect(page).toHaveURL('/agents/activity?tool=search&outcome=errors')
  await expect(page.getByRole('button', { name: 'None', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(
    page
      .getByRole('group', { name: 'Show activity' })
      .getByRole('button', { name: 'All', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Errors', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const errorRows = page.getByTestId('agent-call-row')
  await expect(errorRows).toHaveCount(3)
  for (const row of await errorRows.all()) {
    await expect(row).toContainText('search')
    await expect(row).toContainText('invalid arguments')
  }
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
  await expect(page.getByRole('button', { name: 'Mutations', exact: true })).toHaveAttribute(
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
  const main = page.locator('main')
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
  await expect(main).toHaveAttribute('inert', '')
  await expect(page.getByRole('button', { name: /activity panels/ })).toHaveCount(1)
  const box = await aside.boundingBox()
  expect(box?.width).toBeLessThanOrEqual(375)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  expect(page.url()).toBe(url)

  await page.setViewportSize({ width: 721, height: 760 })
  await expect(aside).toBeVisible()
  await expect(main).not.toHaveAttribute('inert', '')
  expect(await page.evaluate(() => localStorage.getItem('bm-aside'))).toBe('1')
  await page.setViewportSize({ width: 719, height: 760 })
  await expect(aside).toHaveAttribute('role', 'dialog')
  await expect(aside).toHaveAttribute('aria-modal', 'true')
  await expect(main).toHaveAttribute('inert', '')

  await page.keyboard.press('Escape')
  await expect(aside).toHaveCount(0)
  await expect(main).not.toHaveAttribute('inert', '')
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
