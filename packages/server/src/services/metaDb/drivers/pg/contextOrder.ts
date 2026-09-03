import { serializeAbilityLocator } from '@notarium/core'
import { referenceIdentityConflict } from '../../identityRefs'
import {
  contextOrderOfRow,
  type ContextOrderRow,
  dedupOrderEntries,
  type ScopePinRow,
} from '../../rows'
import type { ContextOrderPersistence, ContextSetTargetKind } from '../../types'
import type { PgDriverCtx } from './context'
import { enterIdentityTierForReferences } from './liveIdentity'
import {
  lockContextOrderScopes,
  lockLiveRoleScopePinsInScope,
  lockRoleContextOrderPackages,
  lockScopePinsInScope,
} from './lockOrder'

const ROLE_TARGET = 'role'

export const createContextOrderFacet = (ctx: PgDriverCtx): ContextOrderPersistence => ({
  orderForTarget: async (targetKind: ContextSetTargetKind, targetId: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT target_kind, target_id, target_space, entry_kind, entry_ref, rank FROM context_order WHERE target_kind = $1 AND target_id = $2 ORDER BY rank ASC',
      [targetKind, targetId],
    )
    return (res.rows as ContextOrderRow[]).map(contextOrderOfRow)
  },
  // Advisory xact lock serializes concurrent reorders of the SAME scope: without it two racing
  // DELETE-then-INSERT txns miss each other's committed rows (READ COMMITTED) → PK unique_violation.
  setOrder: async (targetKind, targetId, targetSpace, entries) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const pinRefs = entries.filter((e) => e.entryKind === 'pin').map((e) => e.entryRef)
      // Tier 1 before tier 2, and the WHOLE list in one entry per level — see
      // `lockOrder`. The settlement enters at identity and reaches this scope's
      // advisory lock later; taking them the other way round is the deadlock this
      // order exists to prevent, and resolving entry by entry re-enters tier 1 in the
      // client's order, which is the same deadlock against another reorder.
      const identity = await enterIdentityTierForReferences(client, pinRefs)
      // The membership rows (tier 2d) come BEFORE the scope advisory (tier 2e), and
      // they are what carries each entry's home space: a scope's space says nothing
      // about where a pinned note lives.
      let liveTargetId = targetId
      let liveTargetSpace = targetSpace
      let pins: ScopePinRow[]

      if (targetKind === ROLE_TARGET) {
        const locked = await lockLiveRoleScopePinsInScope(
          client,
          { targetId, targetSpace },
          pinRefs,
        )
        liveTargetId = locked.live.target.targetId
        liveTargetSpace = locked.live.target.targetSpace
        pins = locked.rows
        await lockRoleContextOrderPackages(client, [serializeAbilityLocator(locked.live.locator)])
      } else {
        pins = (await lockScopePinsInScope(client, targetKind, targetId, pinRefs)).rows
      }
      const spaceOfPin = new Map(pins.map((pin) => [pin.note_id, pin.note_space]))
      const canonical = entries.map((entry) => {
        if (entry.entryKind !== 'pin') {
          return entry
        }
        const noteSpace = spaceOfPin.get(entry.entryRef)

        if (noteSpace != null) {
          return { ...entry, entryRef: identity.canonical(noteSpace, entry.entryRef) }
        }
        if (identity.isRetired(entry.entryRef)) {
          throw referenceIdentityConflict(entry.entryRef)
        }

        // A stale non-member: it ranks nothing, exactly as before.
        return entry
      })

      if (targetKind !== ROLE_TARGET) {
        await lockContextOrderScopes(client, [{ targetKind, targetId }])
      }
      const rows = dedupOrderEntries(canonical)

      await client.query('DELETE FROM context_order WHERE target_kind = $1 AND target_id = $2', [
        targetKind,
        liveTargetId,
      ])
      for (let rank = 0; rank < rows.length; rank++) {
        const e = rows[rank]
        await client.query(
          'INSERT INTO context_order (target_kind, target_id, target_space, entry_kind, entry_ref, rank) VALUES ($1, $2, $3, $4, $5, $6)',
          [targetKind, liveTargetId, liveTargetSpace, e.entryKind, e.entryRef, rank],
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
})
