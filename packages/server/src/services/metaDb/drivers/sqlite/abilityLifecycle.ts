import type { DatabaseSync } from 'node:sqlite'

import { abilityTargetLiveSqliteQuery, abilityTargetPurged } from '../../abilityLifecycle'

/** The shared ability fence, taken the SQLite way: no locks to order, because there is
 *  one writer. The caller runs this inside its own `BEGIN IMMEDIATE`, which is what
 *  makes the answer hold to COMMIT — a purge that already committed is visible here,
 *  and one that has not cannot interleave. */
export const assertAbilityTargetLive = (
  db: DatabaseSync,
  spaceId: string,
  registryNoteId: string | null,
): void => {
  const { text, params } = abilityTargetLiveSqliteQuery(spaceId, registryNoteId)

  if (db.prepare(text).get(...params) == null) {
    throw abilityTargetPurged(spaceId, registryNoteId)
  }
}
