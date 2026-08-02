import { defineConfig, devices } from '@playwright/test'

// E2E layer (#18.3): the production bundle driven in a real browser against the
// deterministic fake backend (#18.2), which serves both the SPA and /api from
// one origin. Behaviour journeys live here; the visual matrix (#18.4) will add
// its own projects/specs under the same config.
//
// The webServer builds the front, then runs the fake with dist/ — so a bare
// `playwright test` reproduces CI. Baselines/screenshots are CI-only (#18.4);
// these behaviour specs are environment-independent.

// Password-mode specs run against the auth-booted fake (AUTH_PORT); the base
// chromium project ignores them (its fake boots mode 'none' and can't switch).
const AUTH_SPECS = [
  '**/e2e/auth.spec.ts',
  '**/e2e/agent-context.spec.ts',
  '**/e2e/personal-layer.spec.ts',
  '**/e2e/project-memory.spec.ts',
  '**/e2e/space-access.spec.ts',
  '**/e2e/space-create.spec.ts',
  '**/e2e/space-rename.spec.ts',
]

const PORT = Number(process.env.E2E_PORT || 8788)
// The auth suite's own fake (#10): the fake's auth MODE follows its boot
// fixture (a runtime world-swap deliberately can't change how the host
// authenticates), so password-mode journeys need a second instance booted
// from an auth-enabled fixture.
const AUTH_PORT = PORT + 1

export default defineConfig({
  testDir: 'test',
  // Behaviour journeys (test/e2e) + the visual matrix (test/visual). Only *.spec.ts
  // — the unit layer is *.test.ts under vitest and must not load here.
  testMatch: '**/*.spec.ts',
  // Serial: the fake backend is one shared in-memory store, re-seeded before each
  // test (see test/e2e/fixtures.ts). Parallel workers would mutate it under each
  // other. The suite is small, so serial is cheap.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: AUTH_SPECS },
    // Password-mode journeys (#10/#13) against the auth-booted fake (AUTH_PORT):
    // the login gate + the personal layer (a signed-in user's profile/memory).
    {
      name: 'chromium-auth',
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${AUTH_PORT}` },
      testMatch: AUTH_SPECS,
    },
  ],
  webServer: [
    {
      // VITE_PWA=off: build the SPA without the service worker (#40). The SW would
      // register, precache and (on first install) fire an offline-ready signal in
      // every spec — non-deterministic noise over the fake backend. The install
      // UI is driven by PwaProvider, not the SW, so it's still covered (a synthetic
      // beforeinstallprompt in pwa.spec.ts); the real SW is verified live.
      command: `VITE_PWA=off npm run build && PORT=${PORT} FIXTURE=test/fixtures/base.json npx tsx test/fake-server/main.ts`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The base server's command owns the SPA build; this one only waits for
      // dist to exist (the fake serves it as static) and boots the auth world.
      command: `until [ -f packages/web/dist/index.html ]; do sleep 1; done; PORT=${AUTH_PORT} FIXTURE=test/fixtures/auth.json npx tsx test/fake-server/main.ts`,
      url: `http://localhost:${AUTH_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
