# Tests

Three layers (see issue #18 for the strategy):

| Layer | What | Runner | Files |
|---|---|---|---|
| Unit | pure functions vs spec + `/api/*` contract + fake-server conformance | Vitest | `test/unit/**`, `test/fake-server/*.test.ts` |
| E2E | behaviour journeys against the in-memory fake backend | Playwright | `test/e2e/**` |
| Visual | screenshot matrix (screen × aside-state × theme) | Playwright | `test/visual/**` |

## Commands

```bash
npm test                  # unit (Vitest)
npm run typecheck         # tsc --noEmit

npm run e2e               # E2E on the host (env-independent — no screenshots)

# Visual baselines are font/OS-dependent, so visual ALWAYS runs in the official
# Playwright Docker image — there is deliberately no host variant (a host render
# never matches the canonical baselines). Baselines are NOT in git
# (.gitignore #18.4): kept local per machine; S3/CI sync is a separate task.
# On a fresh clone, generate them once with visual:update.
npm run visual         # check the matrix against the local baselines (in Docker)
npm run visual:update  # (re)generate the baselines (eyeball the diffs in test-results/ first)
npm run e2e:docker     # E2E in the same image (CI parity)
```

The canonical environment is `docker/compose.test.yml` (image pinned to the
`@playwright/test` version in `package.json`).

## Notes

- The fake backend (`test/fake-server/`) serves both the built SPA and `/api/*`
  from one origin and is re-seeded before each test. The graph `<canvas>` is
  driven by id through a test hook (`window.__graphTest`, armed in
  `test/e2e/fixtures.ts`) — no pixel-guessing.
- Light theme + more visual cells can be added in `test/visual/visual.spec.ts`;
  regenerate with `visual:update`.
