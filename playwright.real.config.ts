import { defineConfig, devices } from '@playwright/test'

// A narrow browser-to-production-stack gate. The ordinary E2E suite deliberately
// uses the deterministic in-memory backend for broad UI coverage; this project
// boots the real SQLite metadata store, LocalFS engine, restore coordinators and
// SSE projector from the named trash-recovery seed so transport seams cannot be
// replaced by page.route fixtures without losing this proof.
const PORT = Number(process.env.REAL_E2E_PORT || 8792)
const READY_PORT = Number(process.env.REAL_E2E_READY_PORT || PORT + 1)
const PREBUILT = process.env.PLAYWRIGHT_PREBUILT === '1'
const PREBUILT_CHECK = PREBUILT ? 'node scripts/checkup/browserArtifact.mjs verify && ' : ''
const BUILD = PREBUILT ? '' : 'VITE_PWA=off npm run build -w @notarium/web && '
const TSX = 'node --no-maglev --import tsx'
const BROWSER_ENV = {
  ...process.env,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? 'disabled:',
}

export default defineConfig({
  testDir: 'test/e2e-real',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: true,
  reporter: 'list',
  outputDir: 'test-results/real',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    launchOptions: { env: BROWSER_ENV },
  },
  webServer: {
    command: `${PREBUILT_CHECK}${BUILD}REAL_E2E_PORT=${PORT} ${TSX} test/e2e-real/start.ts`,
    url: `http://localhost:${READY_PORT}/ready`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
