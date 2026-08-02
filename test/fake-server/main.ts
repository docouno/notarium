// Standalone entry: run the fake backend as a real HTTP process for Playwright
// (#18.3). Vitest tests use createApp(...).inject() instead and never start this.
//
//   PORT=8788 FIXTURE=test/fixtures/base.json npx tsx test/fake-server/main.ts
//   PORT=8790 CASE=demo LOCALE=en npx tsx test/fake-server/main.ts
//
// The world comes from a fixture JSON, or — with `CASE` — straight from the seed
// catalog (#175), the same declaration the real applier seeds a stand from. That
// is what the demo screenshots run against (#256): no generated JSON in between,
// so the pixels and `make seed CASE=demo` can never drift.
//
// When a built SPA exists in packages/web/dist, it is served from the SAME
// origin as /api — so the frontend reaches the fake backend directly, no proxy.
// The Playwright config (#46) builds first, then launches this as its webServer.

import { readFileSync } from 'node:fs'

import { webDist } from '@notarium/server'

import { buildCasesWorld } from '../cases/build.js'
import { caseToFixture } from '../cases/toFixture.js'
import { createApp, type Fixture } from './app.js'

const port = Number(process.env.PORT || 8788)
const caseSpec = process.env.CASE
const fixturePath = process.env.FIXTURE || 'test/fixtures/base.json'
const source = caseSpec ? `case:${caseSpec}` : fixturePath
const fixture = caseSpec
  ? caseToFixture(
      buildCasesWorld(caseSpec, {
        locale: process.env.LOCALE,
        // `NOW` anchors the world's "today". The catalog's default anchor is a fixed
        // past instant (byte-reproducible worlds for visual baselines), but a demo
        // stand is read against the REAL clock — "N this week" and every relative
        // date are computed from it — so a world that ends weeks ago photographs as
        // an abandoned base. The screenshot run passes the day it runs.
        now: process.env.NOW,
      }),
    )
  : (JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture)

const app = await createApp(fixture, { spaDist: webDist() })

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[fake] ${source} on :${port}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
