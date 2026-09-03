import {
  contextSetAttachmentOfRow,
  type ContextSetAttachmentRow,
  contextSetOfRow,
  type ContextSetRow,
  orderItems,
} from '../../rows'
import type {
  ContextSetAttachmentRecord,
  ContextSetItemRef,
  ContextSetRecord,
  ContextSetsPersistence,
  ContextSetTargetKind,
} from '../../types'
import type { PgDriverCtx } from './context'
import { enterIdentityTierForReferences } from './liveIdentity'
import { lockContextSetRow, lockLiveRoleContextTarget } from './lockOrder'

const ROLE_TARGET = 'role'

const attach = async (
  db: Pick<PgDriverCtx['required'], 'query'>,
  r: ContextSetAttachmentRecord,
) => {
  await db.query(
    `INSERT INTO context_set_attachments
      (set_id, target_kind, target_id, target_space, created_at, home_space)
     SELECT $1, $2, $3, $4, $5, home_space FROM context_sets WHERE id = $1
       ON CONFLICT (set_id, target_kind, target_id) DO UPDATE SET
         target_space = EXCLUDED.target_space,
         created_at = EXCLUDED.created_at,
         home_space = EXCLUDED.home_space`,
    [r.setId, r.targetKind, r.targetId, r.targetSpace, r.createdAt],
  )
}

export const createContextSetsFacet = (ctx: PgDriverCtx): ContextSetsPersistence => ({
  createSet: async (r: ContextSetRecord) => {
    await ctx.ensureInit()
    await ctx.required.query(
      'INSERT INTO context_sets (id, home_space, name, items, created_at) VALUES ($1, $2, $3, $4, $5)',
      [r.id, r.homeSpace, r.name, JSON.stringify(r.items ?? []), r.createdAt],
    )
  },
  getSet: async (id: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT id, home_space, name, items, created_at FROM context_sets WHERE id = $1',
      [id],
    )
    const row = res.rows[0] as ContextSetRow | undefined
    return row ? contextSetOfRow(row) : null
  },
  listSetsForSpace: async (homeSpace: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT id, home_space, name, items, created_at FROM context_sets WHERE home_space = $1 ORDER BY created_at DESC',
      [homeSpace],
    )
    return (res.rows as ContextSetRow[]).map(contextSetOfRow)
  },
  renameSet: async (id: string, name: string) => {
    await ctx.ensureInit()
    await ctx.required.query('UPDATE context_sets SET name = $1 WHERE id = $2', [name, id])
  },
  // SELECT … FOR UPDATE inside a txn locks the row, so a concurrent add/remove blocks
  // until commit instead of both reading the same base array and clobbering (lost update).
  addItem: async (id: string, ref: ContextSetItemRef) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      // Identity row before the set row — the settlement's order. Locking the set
      // first and reaching for identity second deadlocks against a settlement that
      // holds identity and is reaching for this very set (#327).
      const identity = await enterIdentityTierForReferences(client, [ref.noteId])
      const noteId = identity.canonical(ref.space, ref.noteId)
      const { row } = await lockContextSetRow(client, id)

      if (!row) {
        await client.query('ROLLBACK')
        return null
      }
      const rec = contextSetOfRow(row)

      if (rec.items.some((r) => r.noteId === noteId)) {
        await client.query('COMMIT')
        return rec
      }
      const items = [...rec.items, { ...ref, noteId }]
      await client.query('UPDATE context_sets SET items = $1 WHERE id = $2', [
        JSON.stringify(items),
        id,
      ])
      await client.query('COMMIT')
      return { ...rec, items }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  addItems: async (id: string, refs: readonly ContextSetItemRef[]) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const identity = await enterIdentityTierForReferences(client, refs)
      const canonicalIds: string[] = []
      const conflicts: string[] = []

      for (const [index, ref] of refs.entries()) {
        try {
          canonicalIds[index] = identity.canonical(ref.space, ref.noteId)
        } catch (error) {
          const referenceId = (error as { referenceId?: unknown }).referenceId

          if (typeof referenceId !== 'string') {
            throw error
          }
          conflicts.push(referenceId)
        }
      }
      if (conflicts.length > 0) {
        await client.query('ROLLBACK')
        return { set: null, added: [], conflicts: [...new Set(conflicts)] }
      }
      const { row } = await lockContextSetRow(client, id)

      if (!row) {
        await client.query('ROLLBACK')
        return { set: null, added: [], conflicts: [] }
      }
      const rec = contextSetOfRow(row)
      const seen = new Set<string>()

      rec.items.forEach((item) => seen.add(item.noteId))
      const added: string[] = []
      const next = [...rec.items]

      for (const [index, ref] of refs.entries()) {
        const noteId = canonicalIds[index]

        if (seen.has(noteId)) {
          continue
        }
        seen.add(noteId)
        added.push(noteId)
        next.push(noteId === ref.noteId ? ref : { ...ref, noteId })
      }
      if (added.length > 0) {
        await client.query('UPDATE context_sets SET items = $1 WHERE id = $2', [
          JSON.stringify(next),
          id,
        ])
      }
      await client.query('COMMIT')
      return { set: { ...rec, items: next }, added, conflicts: [] }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  removeItem: async (id: string, ref: ContextSetItemRef) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const identity = await enterIdentityTierForReferences(client, [ref.noteId])
      const noteId = identity.canonical(ref.space, ref.noteId)
      const { row } = await lockContextSetRow(client, id)

      if (!row) {
        await client.query('ROLLBACK')
        return null
      }
      const rec = contextSetOfRow(row)
      const items = rec.items.filter((r) => r.noteId !== noteId)

      if (items.length !== rec.items.length) {
        await client.query('UPDATE context_sets SET items = $1 WHERE id = $2', [
          JSON.stringify(items),
          id,
        ])
      }
      await client.query('COMMIT')
      return { ...rec, items }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  reorderItems: async (id: string, refs: readonly ContextSetItemRef[]) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const identity = await enterIdentityTierForReferences(
        client,
        refs.map((ref) => ref.noteId),
      )
      const noteIds = refs.map((ref) => identity.canonical(ref.space, ref.noteId))
      const { row } = await lockContextSetRow(client, id)

      if (!row) {
        await client.query('ROLLBACK')
        return null
      }
      const rec = contextSetOfRow(row)
      const items = orderItems(rec.items, noteIds)
      await client.query('UPDATE context_sets SET items = $1 WHERE id = $2', [
        JSON.stringify(items),
        id,
      ])
      await client.query('COMMIT')
      return { ...rec, items }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  deleteSet: async (id: string) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM context_set_attachments WHERE set_id = $1', [id])
      await client.query('DELETE FROM context_sets WHERE id = $1', [id])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  attach: async (r: ContextSetAttachmentRecord) => {
    await ctx.ensureInit()
    if (r.targetKind !== ROLE_TARGET) {
      await attach(ctx.required, r)
      return
    }
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const { live } = await lockLiveRoleContextTarget(client, {
        targetId: r.targetId,
        targetSpace: r.targetSpace,
      })
      await attach(client, {
        ...r,
        targetId: live.target.targetId,
        targetSpace: live.target.targetSpace,
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  detach: async (
    setId: string,
    targetKind: ContextSetTargetKind,
    targetId: string,
    targetSpace: string,
  ) => {
    await ctx.ensureInit()
    if (targetKind !== ROLE_TARGET) {
      await ctx.required.query(
        'DELETE FROM context_set_attachments WHERE set_id = $1 AND target_kind = $2 AND target_id = $3',
        [setId, targetKind, targetId],
      )
      return
    }
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const { live } = await lockLiveRoleContextTarget(client, { targetId, targetSpace })
      await client.query(
        'DELETE FROM context_set_attachments WHERE set_id = $1 AND target_kind = $2 AND target_id = $3',
        [setId, targetKind, live.target.targetId],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  attachmentsForSet: async (setId: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT set_id, target_kind, target_id, target_space, created_at FROM context_set_attachments WHERE set_id = $1 ORDER BY created_at ASC',
      [setId],
    )
    return (res.rows as ContextSetAttachmentRow[]).map(contextSetAttachmentOfRow)
  },
  setsForTarget: async (targetKind: ContextSetTargetKind, targetId: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT s.id, s.home_space, s.name, s.items, s.created_at
         FROM context_set_attachments a JOIN context_sets s ON s.id = a.set_id
         WHERE a.target_kind = $1 AND a.target_id = $2
         ORDER BY a.created_at ASC`,
      [targetKind, targetId],
    )
    return (res.rows as ContextSetRow[]).map(contextSetOfRow)
  },
})
