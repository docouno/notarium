import { serializeAbilityLocator } from '@notarium/core'

import {
  type AbilityPreferenceLocator,
  type AbilityPreferencesPersistence,
  type AbilityPreferenceTarget,
} from '../../types'
import { assertAbilityTargetLive } from './abilityLifecycle'
import type { PgDriverCtx } from './context'
import { lockAbilityPreferencePackages } from './lockOrder'

const locatorKey = (locator: AbilityPreferenceLocator): string => serializeAbilityLocator(locator)

/** The address these keys stand at NOW. A placement move rewrites the locator column
 *  of this table and records the hop it made (`ability_placement_trail`, 0016), so an
 *  address computed before that commit is not wrong — it is one hop behind, and the
 *  hop is written down. Resolving it is what makes an owner's choice survive a move it
 *  raced: the write lands where the package is, and a read holding the old spelling
 *  gets the same answer instead of "enabled".
 *
 *  One lookup, never a walk: the trail is kept one hop deep by the move itself. A
 *  caller inside the L4p advisory of these very packages reads a mapping no move can
 *  change under it; a plain read is a snapshot like any other read here. */
const liveLocators = async (
  query: (text: string, params: readonly unknown[]) => Promise<{ rows: unknown[] }>,
  keys: readonly string[],
): Promise<Map<string, string>> => {
  if (!keys.length) {
    return new Map()
  }
  const result = await query(
    'SELECT from_locator, to_locator FROM ability_placement_trail WHERE from_locator = ANY($1)',
    [[...keys]],
  )

  return new Map(
    (result.rows as Array<{ from_locator: string; to_locator: string }>).map((row) => [
      row.from_locator,
      row.to_locator,
    ]),
  )
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

export const createAbilityPreferencesFacet = (ctx: PgDriverCtx): AbilityPreferencesPersistence => ({
  isEnabled: async (owner, locator) => {
    await ctx.ensureInit()
    const key = locatorKey(locator)
    const live = (await liveLocators(ctx.required.query.bind(ctx.required), [key])).get(key) ?? key
    const result = await ctx.required.query(
      'SELECT 1 FROM ability_preferences WHERE owner = $1 AND locator = $2',
      [owner, live],
    )
    return result.rows.length === 0
  },

  disabled: async (owner, locators) => {
    await ctx.ensureInit()
    const keys = [...new Set(locators.map(locatorKey))]

    if (!keys.length) {
      return new Set()
    }
    const moved = await liveLocators(ctx.required.query.bind(ctx.required), keys)
    const result = await ctx.required.query(
      'SELECT locator FROM ability_preferences WHERE owner = $1 AND locator = ANY($2)',
      [owner, keys.map((key) => moved.get(key) ?? key)],
    )
    const found = new Set((result.rows as Array<{ locator: string }>).map(({ locator }) => locator))

    // Answered in the CALLER's spelling: it asked about the addresses it holds, and a
    // set keyed by anything else is a set it cannot look anything up in.
    return new Set(keys.filter((key) => found.has(moved.get(key) ?? key)))
  },

  setEnabled: async (owner, target, enabled, updatedAt) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()
    const key = locatorKey(target.locator)
    const lifecycle = lifecycleOf(target)

    try {
      await client.query('BEGIN')
      if (target.locator.source === 'owned') {
        // Asked BEFORE the branch below, because a re-enable of an ability that is
        // gone for good has nothing to turn on: answering "done" tells the caller it
        // is back. The fence itself belongs to neither facet — `abilityLifecycle`
        // owns it, and availability asks the same question of the same tables.
        await assertAbilityTargetLive(client, lifecycle.spaceId!, lifecycle.registryNoteId)
      }
      // L4p, and the reason it is an advisory on the PACKAGE rather than a lock on the
      // row below: the row need not exist yet, and the other writer of this table — a
      // placement move — rewrites the locator for every owner at once and can name no
      // prefix of the `(owner, locator)` key. Without a key both sides can name, the
      // move's range UPDATE and this INSERT pass straight through each other under READ
      // COMMITTED and the disable is silently lost. See `lockOrder`.
      await lockAbilityPreferencePackages(client, [key])
      // …and under that lock, the address. Serializing the two writers decides WHICH
      // goes first and nothing else: when the move goes first, this caller still names
      // the address the package has left, and a row written there is a choice nothing
      // will ever read. The move recorded the hop, so the row goes where the package
      // is. Read inside the lock, which is what makes the answer hold to COMMIT.
      const live = (await liveLocators(client.query.bind(client), [key])).get(key) ?? key

      if (enabled) {
        await client.query('DELETE FROM ability_preferences WHERE owner = $1 AND locator = $2', [
          owner,
          live,
        ])
      } else {
        await client.query(
          `INSERT INTO ability_preferences
             (owner, locator, space_id, registry_note_id, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT(owner, locator) DO UPDATE SET
             space_id = excluded.space_id,
             registry_note_id = excluded.registry_note_id,
             updated_at = excluded.updated_at`,
          [owner, live, lifecycle.spaceId, lifecycle.registryNoteId, updatedAt],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
