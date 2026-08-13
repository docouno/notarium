import { defineConfig, devices } from '@playwright/test'

// A narrow browser-to-production-stack gate. The ordinary E2E suite deliberately
// uses the deterministic in-memory backend for broad UI coverage; this project
// boots the real SQLite metadata store, LocalFS engine, restore coordinators and
// SSE projector from the named trash-recovery seed so transport seams cannot be
// replaced by page.route fixtures without losing this proof.
const PORT = Number(process.env.REAL_E2E_PORT || 8792)

export default defineConfig({
  testDir: 'test/e2e-real',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: 'test-results/real',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `VITE_PWA=off npm run build -w @notarium/web && REAL_E2E_PORT=${PORT} npx tsx test/e2e-real/start.ts`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
