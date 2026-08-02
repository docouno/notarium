// The seed-case catalog (#175): one declarative source, two appliers.
//  - fake backend (e2e/visual): caseToFixture → the fake's Fixture + reset.
//  - real engine (manual QA): scripts/seed.ts replays the timeline in-process.
// See docs/seeds.md.

export * from './types'
export * from './axes'
export * from './corpus'
export { makeRng } from './rng'
export { CASES, getCase, listCases } from './registry'
export { axisCoverage, featureCoverage, coverageGaps, renderCoverage } from './coverage'
export { caseToFixture } from './toFixture'
export { buildCaseWorld, buildCasesWorld, mergeWorlds, DEFAULT_NOW } from './build'
