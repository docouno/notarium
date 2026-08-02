import { expect, type Page, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { deterministicNoteId } from '@notarium/engine-memory'
import { getDemoBundle } from '../cases/demo'

// The demo screenshot run (#256). NOT a test: nothing here asserts a baseline —
// it drives the app over the `demo` seed case and writes the PNGs the landing
// page, the README and the docs site publish. `expect` appears only as a wait
// (the frame must be settled before the shutter), never as a verdict.
//
// Why it lives under Playwright at all: the visual matrix (#18.4) already solved
// every hard part of photographing this app deterministically — theme and rail
// state through localStorage before load, a frozen clock, a seeded force-graph
// with a settle() hook, and a sync-indicator to wait on. Re-deriving that for a
// screenshot script would be a second, worse copy.
//
// Run it with the demo config, which boots its own fake over the case:
//   npm run demo:shots            (or `make demo-shots`)
//
// Output: test/demo/out/<locale>/<frame>-<theme>.png

const W = 1440
const H = 900
// Wide enough to leave the breadcrumb un-truncated; every aside-open frame sets
// its own width anyway (the panels want different room).
const ASIDE_W = 400

const LOCALE = process.env.LOCALE || 'en'
const OUT = join('test/demo/out', LOCALE)
// Set by playwright.demo.config (and inherited here) — the world's "today".
const NOW = process.env.DEMO_NOW || `${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`

// Frame subjects, DERIVED FROM THE BUNDLE by their stable keys — never hardcoded.
// A seeded note's id falls out of its path (`fake-<slugged-path>`), and a locale
// translates paths, so a literal id here would 404 every frame in every language
// but English. The query comes from the bundle too, for the same reason: it has to
// hit that locale's own notes.
const bundle = getDemoBundle(LOCALE)

const noteId = (key: string): string => {
  const note = bundle.notes.find((n) => n.key === key)

  if (!note) {
    throw new Error(`demo bundle "${bundle.locale}": no note keyed "${key}"`)
  }

  return deterministicNoteId(note.path)
}
const NOTE_OVERVIEW = noteId('home-server')
const NOTE_RUNBOOK = noteId('runbook-restore')

type Theme = 'dark' | 'light'
/** What the right aside persists, positionally per group (see useAsideLayout):
 *  the active tab and the group's height. Seeding it BEFORE load is how a frame
 *  picks its panel without a click — and how it gives that panel enough height.
 *  The default top group is 260px, which slices the Meta panel's tag row in half
 *  on the hero frame; the clipped row is a vertical, not a width, problem. */
type AsideGroups = Array<{ activeTab?: string; height?: number }>
type State = {
  theme: Theme
  rail?: 'open' | 'collapsed'
  aside?: 'open' | 'closed'
  /** Per-frame aside width — the panels want different room. */
  asideW?: number
  /** Per-frame aside layout; omitted = the product's default. */
  asideGroups?: AsideGroups
}

const apply = async (page: Page, s: State) => {
  await page.setViewportSize({ width: W, height: H })
  // Pin the browser clock to the SAME instant the world was seeded against (the
  // config's DEMO_NOW), so relative dates are stable within a run and the frames
  // depend on the day of the shoot rather than the minute.
  await page.clock.install({ time: new Date(NOW) })
  await page.addInitScript(
    (st) => {
      localStorage.setItem('bm-theme', st.theme)
      localStorage.setItem('bm-rail-open', st.rail === 'collapsed' ? '0' : '1')
      localStorage.setItem('bm-aside', st.aside === 'open' ? '1' : '0')
      localStorage.setItem('bm-aside-w', String(st.asideW))

      if (st.asideGroups) {
        localStorage.setItem('bm-aside-groups', JSON.stringify(st.asideGroups))
      }
      ;(window as unknown as { __NOTARIUM_TEST__: boolean }).__NOTARIUM_TEST__ = true
    },
    { ...s, asideW: s.asideW ?? ASIDE_W },
  )
}

/** Sign in as the seeded owner — the demo world declares auth, so the fake boots
 *  password-mode. Being signed in as the content's author is what makes the
 *  history read "you" and "your agent" rather than a stranger's name (#13). */
const login = async (page: Page) => {
  await page.goto('/')
  const gate = page.getByTestId('auth-login')
  // Unconditional: the demo world always declares auth, so the gate is ALWAYS
  // coming. A zero-wait `isVisible()` probe raced AuthProvider (which renders
  // nothing until /api/auth/session resolves) and silently skipped the login on a
  // slow boot — which would photograph an unauthenticated app, turning the
  // history's "you" / "your agent" into a stranger's name.
  await expect(gate).toBeVisible()
  await page.getByTestId('auth-username').fill('sergey')
  await page.getByTestId('auth-password').fill('seed-pass')
  await page.getByTestId('auth-submit').click()
  await expect(gate).not.toBeVisible()
}

// Readiness gate: never shoot while the rail still says "Connecting…". In
// password mode the standalone sync indicator is absorbed into the avatar (#112),
// which carries the same `data-state` — the demo world is authed, so that is the
// element to poll here (the visual matrix polls `sync-indicator` because its
// world is none-mode).
const settled = (page: Page) =>
  expect(page.getByTestId('profile-menu')).toHaveAttribute('data-state', 'ok')

const settleGraph = async (page: Page) => {
  await page.waitForFunction(() => (window.__graphTest?.nodes().length ?? 0) > 0)
  await page.waitForFunction(() => window.__graphTest?.ready?.() === true)
  await page.evaluate(() => window.__graphTest?.settle())
  await page.waitForTimeout(900)
}

/** Wait for the mermaid fence to become a real diagram (#236 renders it lazily,
 *  after the markdown pass). Without this the shutter can catch the raw
 *  `flowchart LR …` source — which is what happened the first time this frame was
 *  taken without a slow neighbour to hide the race. */
const mermaidRendered = (page: Page) =>
  expect(page.locator('.md-mermaid svg').first()).toBeVisible()

const shoot = async (page: Page, name: string, theme: Theme) => {
  await settled(page)
  await mkdir(OUT, { recursive: true })
  await page.screenshot({ path: join(OUT, `${name}-${theme}.png`) })
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme}`, () => {
    // 1. The hero frame: an overview note open, tree on the left, its local graph
    //    on the right. One picture of "a web editor over your own markdown".
    test('reader', async ({ page }) => {
      // Meta over the local graph, selected through the persisted layout rather than
      // a click (one less thing to race). The overview note is the base's hub, and
      // eighteen graph labels in a 400px panel overprint into noise — the graph gets
      // a full-width frame of its own, where it reads. Meta earns the space instead:
      // it names the note's folder and class, the file-first model as a fact on
      // screen. 340px so the tag row is not sliced by the group boundary.
      await apply(page, {
        theme,
        rail: 'open',
        aside: 'open',
        asideGroups: [{ activeTab: 'meta', height: 340 }, { activeTab: 'links' }],
      })
      await login(page)
      await page.goto(`/n/${NOTE_OVERVIEW}`)
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
      await mermaidRendered(page)
      await shoot(page, 'reader', theme)
    })

    // 2. The same note in the editor — CodeMirror, live preview, the source a
    //    reader can check against the .md on disk.
    test('editor', async ({ page }) => {
      await apply(page, { theme, rail: 'open', aside: 'closed' })
      await login(page)
      await page.goto(`/n/${NOTE_OVERVIEW}`)
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      await expect(page.locator('.cm-content')).toBeVisible()
      await shoot(page, 'editor', theme)
    })

    // 3. THE frame the whole case exists for: a revision timeline where an agent's
    //    edit sits in the same chain as the human's, signed and versioned the same
    //    way. The product's core claim, with no caption needed.
    test('history', async ({ page }) => {
      await apply(page, {
        theme,
        rail: 'open',
        aside: 'open',
        asideGroups: [{ activeTab: 'history' }, { activeTab: 'links' }],
      })
      await login(page)
      await page.goto(`/n/${NOTE_RUNBOOK}`)
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
      // Wait for a ROW, not for the panel: `note-history` is on both branches of
      // HistoryTimeline — skeleton and loaded list — and the tab content mounts
      // lazily, so the fetch only starts on this click. Gating on the container
      // resolves while the skeleton is up, and the margin measured in the pinned
      // container is ~20–30ms: under load this frame published a loading placard.
      await expect(page.getByTestId('history-item').first()).toBeVisible()
      await shoot(page, 'history', theme)
    })

    // 4. The link web the notes actually spell out — no synthetic padding.
    test('graph', async ({ page }) => {
      // The force layout cools down before it's photogenic; the default 30s budget
      // has to cover a cold SPA boot plus that settle on a slow container.
      test.setTimeout(90_000)
      await apply(page, { theme, rail: 'open', aside: 'closed' })
      await login(page)
      await page.goto('/graph')
      await expect(page.locator('main canvas, canvas').first()).toBeVisible()
      await settleGraph(page)
      await settled(page)
      await mkdir(OUT, { recursive: true })
      // animations:'allow' — the freeze stylesheet Playwright injects by default
      // blanks the force-graph <canvas> (same reason as the visual matrix).
      await page.screenshot({ path: join(OUT, `graph-${theme}.png`), animations: 'allow' })
    })

    // 5. Search across the base — the bundle's query is chosen to hit an
    //    architecture note, a runbook and an incident at once.
    test('search', async ({ page }) => {
      await apply(page, { theme, rail: 'open', aside: 'closed' })
      await login(page)
      await page.goto('/')
      await page.locator('body').click()
      await page.keyboard.press('Control+P')
      const input = page.getByTestId('spotlight-input')
      await expect(input).toBeFocused()
      await input.fill(bundle.searchQuery)
      await expect(page.getByTestId('spotlight-result').first()).toBeVisible()
      await shoot(page, 'search', theme)
    })

    // 6. The dashboard: ten months of honest, backdated activity — the heatmap is
    //    a lived-in base, which is the claim a screenshot can make and prose can't.
    test('dashboard', async ({ page }) => {
      await apply(page, { theme, rail: 'open', aside: 'closed' })
      await login(page)
      await page.goto('/')
      // Wait for a PAINTED heatmap, not just the dashboard shell: an empty grid
      // renders instantly and would photograph as a base with no history.
      await expect(page.getByTestId('activity-heatmap')).toBeVisible()
      await expect(page.getByTestId('heat-cell-active').first()).toBeVisible()
      await expect(page.getByTestId('activity-feed')).toBeVisible()
      await shoot(page, 'dashboard', theme)
    })
  })
}
