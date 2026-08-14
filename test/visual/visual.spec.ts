import type { Page } from '@playwright/test'
import { expect, test } from '../e2e/fixtures'

// Visual regression matrix (#18.4). One base resolution (1440×900) — responsive
// resolutions come after the responsive work lands. For every page we sweep the
// two asides (left rail open/collapsed × right aside closed/open) and the right
// aside's width (min/mid/max — content reflows with it), in BOTH themes. The graph
// is captured for real (deterministic static layout under the test flag — see
// ForceGraphCanvas), including its three aside tabs and a pinned-focus state.
//
// All UI state is set through localStorage before load (no click choreography),
// so each cell is independent and reproducible. Baselines are committed from this
// container; running them in CI is a separate task.

const W = 1440
const H = 900
// Aside width clamp at 1440: min 240, max 0.45·1440 = 648, default ~340.
const MIN = 240
const MID = 440
const MAX = 648

type Theme = 'dark' | 'light'
type State = {
  theme: Theme
  rail?: 'open' | 'collapsed'
  aside?: 'open' | 'closed'
  asideW?: number
  graphPanel?: 'open' | 'closed'
  graphTab?: 'display' | 'filters' | 'focus'
  clock?: boolean
}
// A page cell without the theme (added per-theme by the loop).
type Cell = Omit<State, 'theme'>

const apply = async (page: Page, s: State) => {
  await page.setViewportSize({ width: W, height: H })
  if (s.clock) {
    await page.clock.install({ time: new Date('2026-06-10T12:00:00') })
    await page.route('**/api/s/*/activity?*', async (route) => {
      const url = new URL(route.request().url())

      // Freeze only the day-bucket aggregate. /events and /projects keep their
      // production requests, and the aggregate still executes in the fake server
      // rather than returning a test-owned payload.
      if (/^\/api\/s\/[^/]+\/activity$/.test(url.pathname)) {
        url.searchParams.set('to', '2026-06-10T12:00:00.000Z')
        await route.continue({ url: url.href })
        return
      }
      await route.continue()
    })
  }
  await page.addInitScript((st) => {
    localStorage.setItem('bm-theme', st.theme)
    localStorage.setItem('bm-rail-open', st.rail === 'collapsed' ? '0' : '1')
    localStorage.setItem('bm-aside', st.aside === 'open' ? '1' : '0')
    localStorage.setItem('bm-aside-w', String(st.asideW ?? 340))
    localStorage.setItem('bm-graph-filters', st.graphPanel === 'open' ? '1' : '0')
    localStorage.setItem('bm-graph-tab', st.graphTab ?? 'display')
  }, s as Required<State>)
}

const waitGraph = (page: Page) =>
  page.waitForFunction(() => (window.__graphTest?.nodes().length ?? 0) > 0)

// Wait for the graph hook, then re-apply the camera with the settled canvas size
// and let it paint — so the snapshot never catches a stale-size (empty / over-
// zoomed) frame. Used for the graph page and the note-reader's local graph.
const settleGraph = async (page: Page) => {
  await waitGraph(page)
  // wait for the force sim to cool + initial fit, then re-apply the camera (focus
  // view or overview fit) with the settled size and let that animation finish.
  await page.waitForFunction(() => window.__graphTest?.ready?.() === true)
  await page.evaluate(() => window.__graphTest?.settle())
  await page.waitForTimeout(900)
}

// Snapshot the whole page once it has settled into the requested state. Both DOM
// and graph cells are pixel-exact: the graph's layout is deterministic (seeded RNG
// + fixed cooldown ticks) and settleGraph() re-applies the fit with the settled
// canvas size, so the camera — and thus every pixel — is reproducible run-to-run.
// Every cell first waits for the sidebar sync indicator to settle on 'ok' (the
// fake's store is permanently ready) — otherwise a slow SSE handshake leaves a
// spinning "Connecting…" in the rail and the pixels race.
const syncSettled = (page: Page) =>
  expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'ok')

const shot = async (page: Page, name: string) => {
  await syncSettled(page)
  await expect(page).toHaveScreenshot(`${name}.png`)
}

const graphShot = async (page: Page, name: string) => {
  await syncSettled(page)
  // animations:'allow' — the default 'disabled' injects a freeze stylesheet that
  // blanks the force-graph <canvas>; the graph has no CSS animations anyway.
  await expect(page).toHaveScreenshot(`${name}.png`, { animations: 'allow' })
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`home — ${theme}`, () => {
    for (const rail of ['open', 'collapsed'] as const) {
      test(`rail ${rail}`, async ({ page }) => {
        await apply(page, { theme, rail, clock: true })
        await page.goto('/')
        // The dashboard's own container, not its heading: the h1 is "Dashboard"
        // once a tree has loaded and only falls back to "Your knowledge base" on an
        // empty base, so keying the wait to the fallback text made this cell fail
        // on any populated fixture (it did, before #256 noticed).
        await expect(page.getByTestId('home-dashboard')).toBeVisible()
        await shot(page, `home-${rail}-${theme}`)
      })
    }
  })

  test.describe(`feed — ${theme}`, () => {
    const cells: Cell[] = [
      { rail: 'open', aside: 'closed' },
      { rail: 'collapsed', aside: 'closed' },
      { rail: 'open', aside: 'open', asideW: MID },
      { rail: 'collapsed', aside: 'open', asideW: MID },
      { rail: 'open', aside: 'open', asideW: MIN },
      { rail: 'open', aside: 'open', asideW: MAX },
    ]

    for (const c of cells) {
      const w = c.aside === 'open' ? `-w${c.asideW}` : ''
      test(`rail ${c.rail} · aside ${c.aside}${w}`, async ({ page }) => {
        await apply(page, { theme, clock: true, ...c })
        await page.goto('/feed')
        await expect(page.locator('[data-testid="feed-item"]').first()).toContainText(/\w/)
        await shot(page, `feed-${c.rail}-${c.aside}${w}-${theme}`)
      })
    }
  })

  test.describe(`note read — ${theme}`, () => {
    const cells: Cell[] = [
      { rail: 'open', aside: 'closed' },
      { rail: 'collapsed', aside: 'closed' },
      { rail: 'open', aside: 'open', asideW: MID },
      { rail: 'collapsed', aside: 'open', asideW: MID },
      { rail: 'open', aside: 'open', asideW: MIN },
      { rail: 'open', aside: 'open', asideW: MAX },
    ]

    for (const c of cells) {
      const w = c.aside === 'open' ? `-w${c.asideW}` : ''
      test(`rail ${c.rail} · aside ${c.aside}${w}`, async ({ page }) => {
        await apply(page, { theme, ...c })
        await page.goto('/n/fake-demo-titanium')
        await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible()
        if (c.aside === 'open') {
          await expect(page.locator('aside canvas')).toBeVisible()
          await settleGraph(page)
        }
        await shot(page, `note-read-${c.rail}-${c.aside}${w}-${theme}`)
      })
    }
  })

  test.describe(`note edit — ${theme}`, () => {
    const cells: Cell[] = [
      { rail: 'open', aside: 'closed' },
      { rail: 'open', aside: 'open', asideW: MID },
      { rail: 'collapsed', aside: 'open', asideW: MID },
      { rail: 'open', aside: 'open', asideW: MIN },
      { rail: 'open', aside: 'open', asideW: MAX },
    ]

    for (const c of cells) {
      const w = c.aside === 'open' ? `-w${c.asideW}` : ''
      test(`rail ${c.rail} · aside ${c.aside}${w}`, async ({ page }) => {
        await apply(page, { theme, ...c })
        await page.goto('/n/fake-demo-titanium')
        await page.getByRole('button', { name: 'Edit' }).click()
        // #156: the title is the document's leading `# H1`, edited inline — the editor
        // surface (no separate title field) is the readiness signal for the shot.
        await expect(page.locator('.cm-content')).toBeVisible()
        await shot(page, `note-edit-${c.rail}-${c.aside}${w}-${theme}`)
      })
    }
  })

  test.describe(`graph — ${theme}`, () => {
    test('rail open · panel closed', async ({ page }) => {
      await apply(page, { theme, rail: 'open', graphPanel: 'closed' })
      await page.goto('/graph')
      await settleGraph(page)
      await graphShot(page, `graph-railopen-panelclosed-${theme}`)
    })

    test('rail collapsed · panel closed', async ({ page }) => {
      await apply(page, { theme, rail: 'collapsed', graphPanel: 'closed' })
      await page.goto('/graph')
      await settleGraph(page)
      await graphShot(page, `graph-railcollapsed-panelclosed-${theme}`)
    })

    for (const tab of ['display', 'filters', 'focus'] as const) {
      test(`panel open · ${tab} tab`, async ({ page }) => {
        await apply(page, { theme, rail: 'open', graphPanel: 'open', graphTab: tab, asideW: MID })
        await page.goto('/graph')
        await waitGraph(page)
        if (tab === 'focus') {
          // the Focus tab needs a pinned node — click one through the canvas hook
          await page.evaluate(() => window.__graphTest!.click('fake-demo-titanium'))
          await page.waitForFunction(() => window.__graphTest?.focusId() === 'fake-demo-titanium')
          await settleGraph(page)
        }
        await graphShot(page, `graph-panel-${tab}-${theme}`)
      })
    }

    test('panel open · filters · width min', async ({ page }) => {
      await apply(page, {
        theme,
        rail: 'open',
        graphPanel: 'open',
        graphTab: 'filters',
        asideW: MIN,
      })
      await page.goto('/graph')
      await settleGraph(page)
      await graphShot(page, `graph-panel-filters-wmin-${theme}`)
    })

    test('panel open · filters · width max', async ({ page }) => {
      await apply(page, {
        theme,
        rail: 'open',
        graphPanel: 'open',
        graphTab: 'filters',
        asideW: MAX,
      })
      await page.goto('/graph')
      await settleGraph(page)
      await graphShot(page, `graph-panel-filters-wmax-${theme}`)
    })

    // NOTE: the pinned-focus state is covered by the `panel open · focus tab` cell
    // above (emphasis + the Focus panel). A separate full-width focused-canvas shot
    // is intentionally omitted: with the panel closed, toHaveScreenshot captures the
    // force-graph <canvas> blank for that one case (a Playwright canvas-capture
    // quirk — page.screenshot renders it fine), so it isn't a reliable baseline.
  })
}

// Transient / overlay states: skeleton placeholders, the right-click context
// menus, and the confirm dialog — in both themes.
for (const theme of ['dark', 'light'] as const) {
  test.describe(`states — ${theme}`, () => {
    test('feed — loading skeletons', async ({ page }) => {
      await apply(page, { theme, rail: 'open', aside: 'closed', clock: true })
      // Stage the cold-preview state (#64): strip the warm inline previews off
      // the notes window and keep the batch endpoint pending, so cards stay in
      // their skeleton state.
      await page.route('**/api/previews', () => {
        /* hang — never resolve */
      })
      await page.route('**/api/s/*/notes**', async (route) => {
        const res = await route.fetch()
        const body = await res.json()

        if (Array.isArray(body.notes)) {
          for (const n of body.notes) {
            delete n.preview
          }
        }
        await route.fulfill({ response: res, json: body })
      })
      await page.goto('/feed')
      await expect(page.locator('[data-testid="feed-item"]').first()).toBeVisible()
      await expect(page.locator('.feed-snippet-skeleton').first()).toBeVisible()
      await shot(page, `feed-skeleton-${theme}`)
    })

    test('context menu — note', async ({ page }) => {
      await apply(page, { theme, rail: 'open' })
      await page.goto('/')
      await page
        .locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')
        .click({ button: 'right' })
      await expect(page.getByRole('menu')).toBeVisible()
      await shot(page, `context-menu-note-${theme}`)
    })

    test('context menu — folder', async ({ page }) => {
      await apply(page, { theme, rail: 'open' })
      await page.goto('/')
      await page.getByText('demo', { exact: true }).click({ button: 'right' })
      await expect(page.getByRole('menu')).toBeVisible()
      await shot(page, `context-menu-folder-${theme}`)
    })

    test('confirm dialog', async ({ page }) => {
      await apply(page, { theme, rail: 'open' })
      await page.goto('/')
      await page
        .locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')
        .click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Delete' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await shot(page, `confirm-dialog-${theme}`)
    })
  })
}
