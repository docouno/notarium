import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// Unit layer (Layer 2 of the test strategy): pure functions tested
// against the spec, not the implementation. No React/DOM here — these are
// node-environment tests over framework-free logic. E2E and visual layers
// get their own Playwright config; they do not run under vitest.
export default defineConfig({
  resolve: {
    alias: {
      // vite 5 doesn't know the prefix-only `node:sqlite` builtin (it strips
      // the prefix and tries to resolve a "sqlite" npm package), which breaks
      // importing the meta-DB driver in tests. Route the specifier
      // through a shim that hands over the real builtin at runtime. Production
      // (tsx/node) imports `node:sqlite` directly — this is test-runner-only.
      'node:sqlite': fileURLToPath(
        new URL('./test/unit/helpers/nodeSqliteShim.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // The default reporter counts skips; this one names the gate behind each.
    reporters: ['default', './test/skipSummary.ts'],
    // *.test.ts under test/ (unit layer + fake-server conformance) plus
    // co-located unit tests inside packages (the target layout). The
    // Playwright e2e/visual layers use *.spec.ts and a separate runner, so
    // they never match here.
    include: ['test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    // Tests import app modules written in JS (packages/web/src/lib/*.js) —
    // vitest transpiles them via esbuild, no extra config needed. Keep the
    // front's vite.config out of the picture so its react plugin / dev-server
    // settings don't load here.
    css: false,
    // Coverage baseline: measurable progress, not eyeballed. Scoped to the
    // backend packages (pure TS — no tsx/scss transform) whose monoliths the
    // vertical pass splits; web coverage is wired in its own sessions. `all: true`
    // counts untested files as 0 so decomposition-driven gains are honest.
    coverage: {
      provider: 'v8',
      all: true,
      include: [
        'packages/contract/src/**/*.ts',
        'packages/core/src/**/*.ts',
        'packages/engine/src/**/*.ts',
        'packages/engine-memory/src/**/*.ts',
        'packages/server/src/**/*.ts',
      ],
      // `*.fixture.ts` is test scaffolding, not shipped code — the canon counts it as a
      // concern file, and measuring it would hold product thresholds against branches
      // only the other install profile ever takes.
      exclude: [
        '**/*.{test,spec}.ts',
        '**/*.fixture.ts',
        '**/*.d.ts',
        '**/index.ts',
        '**/types.ts',
        '**/consts.ts',
      ],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      // Ratchet floors from the 2026-07-11 baseline (measured lines/branches/funcs):
      // contract 100/100/100 · core 94/88/99 · engine 88/87/97 · engine-memory 94/88/95
      // · server 73/78/89. Set just under measured so decomposition can't silently
      // drop coverage; raise as the vertical pass converts integration→unit tests.
      thresholds: {
        'packages/contract/src/**': { lines: 97, statements: 97, functions: 97, branches: 95 },
        'packages/core/src/**': { lines: 91, statements: 91, functions: 96, branches: 85 },
        'packages/engine/src/**': { lines: 84, statements: 84, functions: 95, branches: 84 },
        'packages/engine-memory/src/**': { lines: 90, statements: 90, functions: 92, branches: 85 },
        'packages/server/src/**': { lines: 70, statements: 70, functions: 86, branches: 74 },
      },
    },
  },
})
