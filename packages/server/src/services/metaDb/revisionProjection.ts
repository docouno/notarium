// Effective-field SQL for the journal's integrity axis: the predicates every query
// must classify, filter, collapse and count on, built once because the two dialects
// differ only in placeholder syntax.
// canon: docs/note-history.md#model · docs/core.md#identity

import { REVISION_ENTRY_ROLE, REVISION_INTEGRITY } from '@notarium/core'

/** Rows whose payload can still be believed. */
export const TRUSTED_ONLY = `integrity = '${REVISION_INTEGRITY.trusted}'`

/** Rows served as a gap. */
export const QUARANTINED = `integrity = '${REVISION_INTEGRITY.quarantined}'`

/** Class exclusion on the EFFECTIVE class. A gap's class is null, so it is never
 *  excluded by a hidden-class filter — and its real class is never consulted. */
export const effectiveClassClause = (placeholders: readonly string[]): string =>
  placeholders.length
    ? ` AND (${QUARANTINED} OR class IS NULL OR class NOT IN (${placeholders.join(',')}))`
    : ''

/** Author scope on the EFFECTIVE principal. A gap's principal is null, so it
 *  belongs to nobody: `author=mine` excludes it, and so does any other author. */
export const effectiveAuthorClause = (parts: readonly string[]): string =>
  parts.length ? ` AND (${TRUSTED_ONLY} AND (${parts.join(' OR ')}))` : ' AND FALSE'

/** The synthetic pre-edit baseline suppression, read off the row the WRITER stamped.
 *
 *  The disjunct is what makes a gap immune, and it is not decoration: quarantine does
 *  not touch `entry_role`, so a contaminated row can perfectly well BE a baseline, and
 *  shortening this to its second half would drop that row out of the `unavailable`
 *  bucket. No test would notice today — every row in the quarantine fixture is a
 *  `write` — which is exactly why the reason is written here (#327).
 *
 *  What used to stand here was `kind = 'external' AND base_rev IS NULL` plus a
 *  correlated probe for the note's first entry. It stopped meaning "first entry" the
 *  moment this same task introduced quarantine: after it, a note's next genuine edit
 *  finds no trusted parent either. The probe was also quadratic on stock SQLite, and
 *  two of the four consumers never got it at all.
 *  canon: docs/note-history.md#model */
export const notSyntheticBaselineClause = `(${QUARANTINED} OR entry_role <> '${REVISION_ENTRY_ROLE.baseline}')`

/** A note's own first state, written through us — the `created` bucket and the wire's
 *  `created` kind. Not "has no parent": an edit that follows a quarantine has none. */
export const ORIGIN_ONLY = `entry_role = '${REVISION_ENTRY_ROLE.origin}'`

/** After a re-key, ONE note holds two chains — and each may have brought its own
 *  `origin`. A note is born once: the earliest origin keeps the role and every later
 *  one becomes a `change`, or Activity reports the note as created twice (measured:
 *  `created: 2` for a single note after a foreign settlement, and the predicate this
 *  axis replaced had exactly the same effect). Stated once, so both dialects demote
 *  identically. `%1`/`%2` are the two binds, spelled per dialect by the caller —
 *  the drivers disagree on placeholder syntax and nothing else here.
 *  canon: docs/note-history.md#model */
export const ORIGINS_OF_NOTE_SQL = `SELECT id FROM note_revisions
    WHERE space = %1 AND note_id = %2 AND entry_role = '${REVISION_ENTRY_ROLE.origin}'
    ORDER BY id`

/** The origins that lose the role: every one but the earliest. */
export const laterOrigins = (ids: readonly string[]): string[] => ids.slice(1)
