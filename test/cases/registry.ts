import { agentContext } from './cases/agentContext'
import { dashboardActivity } from './cases/dashboardActivity'
import { demo } from './cases/demo'
import { explorerScroll } from './cases/explorerScroll'
import { externalEdits } from './cases/externalEdits'
import { favorites } from './cases/favorites'
import { feedScroll } from './cases/feedScroll'
import { folderPage } from './cases/folderPage'
import { graph } from './cases/graph'
import { graphLoad } from './cases/graphLoad'
import { historyRich } from './cases/historyRich'
import { importLayout } from './cases/importLayout'
import { importThread } from './cases/importThread'
import { jobs } from './cases/jobs'
import { longDocument } from './cases/longDocument'
import { multiSpace } from './cases/multiSpace'
import { noteClasses } from './cases/noteClasses'
import { readerShowcase } from './cases/readerShowcase'
import { scrollbars } from './cases/scrollbars'
import { searchCorpus } from './cases/searchCorpus'
import { trashEmpty, trashLong, trashMixed } from './cases/trash'
import { wikiWeb } from './cases/wikiWeb'
import type { CaseSpec } from './types'

/** The seed-case catalog (#175) — the single source both appliers read. Add a case =
 *  register its declaration here; nothing else needs touching. Each case declares the
 *  `axes` it drives (see axes.ts); the coverage test asserts every axis is covered. */
export const CASES: readonly CaseSpec[] = [
  // structure / spaces / folders / classes
  multiSpace,
  folderPage,
  noteClasses,
  explorerScroll,
  // navigation / favorites (the merged Files+Feed rail, #245)
  favorites,
  // activity / history / trash
  feedScroll,
  // scroll-surface showcase (auto-hide + glass-inset, #176)
  scrollbars,
  dashboardActivity,
  trashEmpty,
  trashMixed,
  trashLong,
  historyRich,
  // graph / identity / search
  wikiWeb,
  graph,
  graphLoad,
  searchCorpus,
  externalEdits,
  // content / reader
  readerShowcase,
  longDocument,
  // agent memory / context
  agentContext,
  // import
  importThread,
  importLayout,
  // durable jobs / export artifacts
  jobs,
  // the public demo world (#256) — the screenshot source, not a test bed
  demo,
]

const BY_NAME = new Map(CASES.map((c) => [c.name, c]))

export const getCase = (name: string): CaseSpec => {
  const c = BY_NAME.get(name)

  if (!c) {
    throw new Error(`unknown seed case: "${name}". Known: ${CASES.map((x) => x.name).join(', ')}`)
  }

  return c
}

export const listCases = (): Array<{ name: string; description: string }> =>
  CASES.map((c) => ({ name: c.name, description: c.description }))
