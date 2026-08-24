import { serializeAbilityLocator } from '@notarium/core'

import {
  type AbilityPreferenceLocator,
  type AbilityPreferencesPersistence,
  type AbilityPreferenceTarget,
} from '../../types'
import { assertAbilityTargetLive } from './abilityLifecycle'
import type { SqliteDriverCtx } from './context'

const locatorKey = (locator: AbilityPreferenceLocator): string => serializeAbilityLocator(locator)

/** The address these keys stand at NOW — the twin of the PostgreSQL facet's lookup,
 *  reading the same `ability_placement_trail` for the same reason: a
 *  placement move rewrites the locator this table is keyed by, and an override written
 *  at the address the package has just left is a choice nothing will ever read. One
 *  writer here means no advisory is needed to make the answer hold — the move cannot be
 *  running — but the answer itself is the same one. */
const liveLocators = (
  db: SqliteDriverCtx['required'],
  keys: readonly string[],
): Map<string, string> => {
  if (!keys.length) {
    return new Map()
  }
  const rows = db
    .prepare(
      `SELECT from_locator, to_locator FROM ability_placement_trail
        WHERE from_locator IN (${keys.map(() => '?').join(', ')})`,
    )
    .all(...keys) as Array<{ from_locator: string; to_locator: string }>

  return new Map(rows.map((row) => [row.from_locator, row.to_locator]))
}

/** The two keys the row is found again BY — the Space purge sweeps by one, the exact
 *  note purge by both. Everything else the row could say about the ability is already
 *  inside the canonical locator that keys it. */
const lifecycleOf = (target: AbilityPreferenceTarget) =>
  target.locator.source === 'owned'
    ? {
        spaceId: target.locator.location.spaceId,
        registryNoteId: 'registryNoteId' in target ? target.registryNoteId : null,
      }
    : { spaceId: null, registryNoteId: null }

export const createAbilityPreferencesFacet = (
  ctx: SqliteDriverCtx,
): AbilityPreferencesPersistence => ({
  isEnabled: async (owner, locator) => {
    await ctx.ensureInit()
    const key = locatorKey(locator)
    const row = ctx.required
      .prepare('SELECT 1 FROM ability_preferences WHERE owner = ? AND locator = ?')
      .get(owner, liveLocators(ctx.required, [key]).get(key) ?? key)
    return row == null
  },

  disabled: async (owner, locators) => {
    await ctx.ensureInit()
    const keys = [...new Set(locators.map(locatorKey))]

    if (!keys.length) {
      return new Set()
    }
    const moved = liveLocators(ctx.required, keys)
    const placeholders = keys.map(() => '?').join(', ')
    const rows = ctx.required
      .prepare(
        `SELECT locator FROM ability_preferences
          WHERE owner = ? AND locator IN (${placeholders})`,
      )
      .all(owner, ...keys.map((key) => moved.get(key) ?? key)) as Array<{ locator: string }>
    const found = new Set(rows.map(({ locator }) => locator))

    // Answered in the CALLER's spelling, exactly as the PostgreSQL facet answers it.
    return new Set(keys.filter((key) => found.has(moved.get(key) ?? key)))
  },

  setEnabled: async (owner, target, enabled, updatedAt) => {
    await ctx.ensureInit()
    const db = ctx.required
    const key = locatorKey(target.locator)
    const lifecycle = lifecycleOf(target)

    db.exec('BEGIN IMMEDIATE')
    try {
      if (target.locator.source === 'owned') {
        // Asked BEFORE the branch below, and out of the same module the availability
        // facet asks it out of: one lifecycle, one question, one answer.
        assertAbilityTargetLive(db, lifecycle.spaceId!, lifecycle.registryNoteId)
      }
      // The address the package stands at now: the move records where it took each
      // one (`ability_placement_trail`), so a caller one statement behind still writes
      // its choice where the package is rather than where it was.
      const live = liveLocators(db, [key]).get(key) ?? key

      if (enabled) {
        db.prepare('DELETE FROM ability_preferences WHERE owner = ? AND locator = ?').run(
          owner,
          live,
        )
      } else {
        db.prepare(
          `INSERT INTO ability_preferences
             (owner, locator, space_id, registry_note_id, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(owner, locator) DO UPDATE SET
             space_id = excluded.space_id,
             registry_note_id = excluded.registry_note_id,
             updated_at = excluded.updated_at`,
        ).run(owner, live, lifecycle.spaceId, lifecycle.registryNoteId, updatedAt)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
})
