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
import type { SqliteDriverCtx } from './context'
import { resolveLiveIdentityForWrite } from './liveIdentity'

export const createContextSetsFacet = (ctx: SqliteDriverCtx): ContextSetsPersistence => ({
  createSet: async (r: ContextSetRecord) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        'INSERT INTO context_sets (id, home_space, name, items, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(r.id, r.homeSpace, r.name, JSON.stringify(r.items ?? []), r.createdAt)
  },
  getSet: async (id: string) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare('SELECT id, home_space, name, items, created_at FROM context_sets WHERE id = ?')
      .get(id) as ContextSetRow | undefined
    return row ? contextSetOfRow(row) : null
  },
  listSetsForSpace: async (homeSpace: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        'SELECT id, home_space, name, items, created_at FROM context_sets WHERE home_space = ? ORDER BY created_at DESC',
      )
      .all(homeSpace) as ContextSetRow[]
    return rows.map(contextSetOfRow)
  },
  renameSet: async (id: string, name: string) => {
    await ctx.ensureInit()
    ctx.required.prepare('UPDATE context_sets SET name = ? WHERE id = ?').run(name, id)
  },
  // No await between SELECT and UPDATE: node:sqlite runs them synchronously on the event
  // loop, so a concurrent read-mutate-write can't interleave — no lost update.
  addItem: async (id: string, ref: ContextSetItemRef) => {
    await ctx.ensureInit()
    const db = ctx.required

    // IMMEDIATE so the identity revalidation and the membership write land as
    // one writer — a settlement between them would add a retired id to the set.
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db
        .prepare('SELECT id, home_space, name, items, created_at FROM context_sets WHERE id = ?')
        .get(id) as ContextSetRow | undefined

      if (!row) {
        db.exec('COMMIT')
        return null
      }
      const rec = contextSetOfRow(row)
      const noteId = resolveLiveIdentityForWrite(db, ref.space, ref.noteId)

      if (rec.items.some((r) => r.noteId === noteId)) {
        db.exec('COMMIT')
        return rec
      }
      const items = [...rec.items, { ...ref, noteId }]

      db.prepare('UPDATE context_sets SET items = ? WHERE id = ?').run(JSON.stringify(items), id)
      db.exec('COMMIT')
      return { ...rec, items }
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  removeItem: async (id: string, noteId: string) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare('SELECT id, home_space, name, items, created_at FROM context_sets WHERE id = ?')
      .get(id) as ContextSetRow | undefined

    if (!row) {
      return null
    }
    const rec = contextSetOfRow(row)
    const items = rec.items.filter((r) => r.noteId !== noteId)

    if (items.length !== rec.items.length) {
      ctx.required
        .prepare('UPDATE context_sets SET items = ? WHERE id = ?')
        .run(JSON.stringify(items), id)
    }

    return { ...rec, items }
  },
  // Partial noteIds is non-destructive: items not named keep their slot, never dropped or moved
  // to the tail.
  reorderItems: async (id: string, noteIds: readonly string[]) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare('SELECT id, home_space, name, items, created_at FROM context_sets WHERE id = ?')
      .get(id) as ContextSetRow | undefined

    if (!row) {
      return null
    }
    const rec = contextSetOfRow(row)
    const items = orderItems(rec.items, noteIds)
    ctx.required
      .prepare('UPDATE context_sets SET items = ? WHERE id = ?')
      .run(JSON.stringify(items), id)
    return { ...rec, items }
  },
  deleteSet: async (id: string) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM context_set_attachments WHERE set_id = ?').run(id)
      db.prepare('DELETE FROM context_sets WHERE id = ?').run(id)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  },
  attach: async (r: ContextSetAttachmentRecord) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO context_set_attachments
          (set_id, target_kind, target_id, target_space, created_at, home_space)
         SELECT ?, ?, ?, ?, ?, home_space FROM context_sets WHERE id = ?
           ON CONFLICT(set_id, target_kind, target_id) DO UPDATE SET
             target_space = excluded.target_space,
             created_at = excluded.created_at,
             home_space = excluded.home_space`,
      )
      .run(r.setId, r.targetKind, r.targetId, r.targetSpace, r.createdAt, r.setId)
  },
  detach: async (setId: string, targetKind: ContextSetTargetKind, targetId: string) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        'DELETE FROM context_set_attachments WHERE set_id = ? AND target_kind = ? AND target_id = ?',
      )
      .run(setId, targetKind, targetId)
  },
  attachmentsForSet: async (setId: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        'SELECT set_id, target_kind, target_id, target_space, created_at FROM context_set_attachments WHERE set_id = ? ORDER BY created_at ASC',
      )
      .all(setId) as ContextSetAttachmentRow[]
    return rows.map(contextSetAttachmentOfRow)
  },
  setsForTarget: async (targetKind: ContextSetTargetKind, targetId: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT s.id, s.home_space, s.name, s.items, s.created_at
           FROM context_set_attachments a JOIN context_sets s ON s.id = a.set_id
           WHERE a.target_kind = ? AND a.target_id = ?
           ORDER BY a.created_at ASC`,
      )
      .all(targetKind, targetId) as ContextSetRow[]
    return rows.map(contextSetOfRow)
  },
})
