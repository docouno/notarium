import { rm } from 'node:fs/promises'
import { join } from 'node:path'

// Playwright globalSetup for the demo shoot (#256): wipe the locale's output
// directory before the run.
//
// Not housekeeping — correctness. The output is gitignored and each frame writes
// its own file, so a frame that FAILS leaves the previous run's PNG sitting there.
// The operator then sees twelve files and publishes a set where one image is from
// an older world (a different anchor day, an older copy deck). Starting empty
// makes a partial run look partial.
export default async function cleanOutput() {
  const locale = process.env.LOCALE || 'en'
  await rm(join('test/demo/out', locale), { recursive: true, force: true })
}
