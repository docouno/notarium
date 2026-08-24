// The ONE question both ability facets ask before they write owner state: is the
// ability this state is ABOUT still there? Availability keys a policy by the package
// directory inside a home Space; preferences key an override by the
// owner and the canonical locator. Different tables, different owners — but one
// lifecycle, because both die of the same two events: the registry note purged for
// good, or the whole Space purged for good.
//
// It lives here rather than in either driver because a fence re-derived per facet is
// how two of them come to disagree: availability shipped with `SELECT 1 FROM spaces`
// alone, which is true of a Space in `purge-intent` and true again the moment after a
// note purge swept the row — so the next write PUT the row back, pointing at a note
// that is gone, on a `package_id` the next package installed in that directory
// inherits. Nothing sweeps it a second time: the note whose purge would have is the
// one that is gone.
//
// Both dialects ask it as one statement, inside the transaction that writes, so a
// purge that committed is visible here and one that has not cannot start (PostgreSQL
// takes the Space and note revision stripes first; SQLite has a single writer).
// canon: docs/meta-db.md#source-of-truth

import { SPACE_LIFECYCLE_PHASE } from '@notarium/core'

import { abilityTargetPurgedError } from './types'

/** The phases a Space never comes back from. `closing` and `archived` are absent on
 *  purpose: an archived Space is reopened, and owner state written while it is closed
 *  is exactly what a reopen expects to find. */
const ENDED_PHASES: readonly string[] = [
  SPACE_LIFECYCLE_PHASE.purgeIntent,
  SPACE_LIFECYCLE_PHASE.metadataCleaned,
  SPACE_LIFECYCLE_PHASE.physicalCleaned,
  SPACE_LIFECYCLE_PHASE.purged,
]

const ENDED_PHASES_SQL = ENDED_PHASES.map((phase) => `'${phase}'`).join(', ')

/** The same list, asked the way a host that keeps its lifecycle journal in a Map has
 *  to ask it: of the record, not of a `WHERE` clause. Exported because the twins'
 *  `spaceEnded` is this predicate and nothing else — a host that spells it out again
 *  is how the fence comes to mean one thing in the drivers and another in the fake,
 *  which is the divergence this module exists to prevent. */
export const spaceLifecycleHasEnded = (record: { phase: string } | null | undefined): boolean =>
  record != null && ENDED_PHASES.includes(record.phase)

/** A statement and the values it binds, in the order it binds them. */
export type AbilityTargetQuery = { text: string; params: readonly (string | null)[] }

/** The predicate, spelled once. `space` and `note` are called in the order their
 *  placeholders appear, which is the order a positional dialect must bind them in.
 *
 *  A NULL note is not a hole: `entity_id = NULL` is never true, so a caller that does
 *  not know its registry note is fenced by its Space alone — the same asymmetry the
 *  purge sweep already makes, read from the writing side. The fence is the NOTE's and
 *  never the package directory's: a directory name is reusable by construction, and
 *  refusing every write under one whose name a purged note happened to share would
 *  bury the next package installed there. */
const liveSql = (space: () => string, note: () => string): string =>
  `SELECT 1 FROM spaces
     WHERE id = ${space()}
       AND NOT EXISTS (
         SELECT 1 FROM space_lifecycle
          WHERE space = ${space()} AND phase IN (${ENDED_PHASES_SQL})
       )
       AND NOT EXISTS (
         SELECT 1 FROM revision_purge_fences
          WHERE (kind = 'space' AND entity_id = ${space()} AND space = ${space()})
             OR (kind = 'note' AND entity_id = ${note()} AND space = ${space()})
       )`

export const abilityTargetLivePgQuery = (
  spaceId: string,
  registryNoteId: string | null,
): AbilityTargetQuery => ({
  text: liveSql(
    () => '$1',
    () => '$2',
  ),
  params: [spaceId, registryNoteId],
})

export const abilityTargetLiveSqliteQuery = (
  spaceId: string,
  registryNoteId: string | null,
): AbilityTargetQuery => {
  const params: (string | null)[] = []

  const bind = (value: string | null): string => {
    params.push(value)

    return '?'
  }

  return {
    text: liveSql(
      () => bind(spaceId),
      () => bind(registryNoteId),
    ),
    params,
  }
}

/** The refusal, in the machine-readable shape every implementation of these facets
 *  owes a route (`ABILITY_TARGET_PURGED`). One message for one fence: the predicate
 *  is a single statement and cannot say which of its three clauses answered, and a
 *  caller that could tell them apart would have nothing different to do. */
export const abilityTargetPurged = (spaceId: string, registryNoteId: string | null): Error =>
  abilityTargetPurgedError(
    registryNoteId == null
      ? `ability target in space ${spaceId} is gone for good`
      : `ability target ${registryNoteId} in space ${spaceId} is gone for good`,
  )
