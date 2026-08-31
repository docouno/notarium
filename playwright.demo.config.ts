import { defineConfig, devices } from '@playwright/test'

// The demo screenshot run (#256) — deliberately its own config rather than a
// project inside playwright.config.ts. Two reasons: it boots a DIFFERENT world
// (the `demo` seed case, password-mode) on its own port, and it produces
// artifacts rather than verdicts, so it must never join a `playwright test` run
// that gates a merge.
//
//   npm run demo:shots              # en, both themes
//   LOCALE=ru npm run demo:shots    # once the bundle exists (see test/cases/demo)
//
// Output lands in test/demo/out/<locale>/. See docs/demo-screenshots.md.

const PORT = Number(process.env.DEMO_PORT || 8790)
const LOCALE = process.env.LOCALE || 'en'
const BROWSER_ENV = {
  ...process.env,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? 'disabled:',
}

// The world's "today" — noon UTC of the day the shots are taken, shared by the
// seeded world and the browser clock so the two never disagree about what "3 days
// ago" means. Noon rather than the current instant: the frames then depend on the
// DAY of the run, not the minute, so re-shooting an unchanged bundle twice in one
// day is byte-identical. Override with DEMO_NOW to reproduce an older run.
const NOW = process.env.DEMO_NOW || `${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`
process.env.DEMO_NOW = NOW

export default defineConfig({
  testDir: 'test/demo',
  testMatch: '**/*.spec.ts',
  // Start from an empty output dir, so a failed frame can't leave the previous
  // run's PNG behind and make a partial shoot look complete (see test/demo/clean.ts).
  globalSetup: './test/demo/clean.ts',
  // Serial: one shared in-memory fake, and a screenshot run is short anyway.
  fullyParallel: false,
  workers: 1,
  // A frame that won't settle is a bug to look at, not to paper over with a retry.
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Screenshots are taken explicitly; nothing here is a baseline comparison.
    trace: 'off',
    launchOptions: { env: BROWSER_ENV },
  },
  projects: [
    {
      name: 'demo',
      use: {
        ...devices['Desktop Chrome'],
        // Shot at 2× (1440×900 CSS → 2880×1800 px). Every consumer of these stills —
        // the landing, the README banner, the docs site — displays them on a retina
        // screen at close to their CSS width, so a 1× still is soft everywhere it is
        // published, and the banner scales it down again on top of that.
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: {
    // The fake serves the built SPA and /api from one origin, seeded straight from
    // the catalog — no intermediate fixture JSON, so the pixels and
    // `make seed CASE=demo` can't drift apart.
    command: `VITE_PWA=off npm run build && PORT=${PORT} CASE=demo LOCALE=${LOCALE} NOW=${NOW} node --no-maglev --import tsx test/fake-server/main.ts`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
