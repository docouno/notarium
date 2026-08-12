import type { FavoriteEntityKind, FavoriteRecord, FavoritesPersistence } from '../../types'
import type { SqliteDriverCtx } from './context'
import { resolveLiveIdentityForWrite } from './liveIdentity'

export const createFavoritesFacet = (ctx: SqliteDriverCtx): FavoritesPersistence => ({
  list: async (owner: string, space: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT owner, space, kind, entity_id, created_at, rank
           FROM favorites
           WHERE owner = ? AND space = ?
           ORDER BY rank IS NULL, rank ASC, created_at DESC`,
      )
      .all(owner, space) as Array<{
      owner: string
      space: string
      kind: FavoriteEntityKind
      entity_id: string
      created_at: string
      rank: number | bigint | null
    }>
    return rows.map((r) => ({
      owner: r.owner,
      space: r.space,
      kind: r.kind,
      entityId: r.entity_id,
      createdAt: r.created_at,
      rank: r.rank == null ? null : Number(r.rank),
    }))
  },
  ids: async (owner: string, space: string, kind: FavoriteEntityKind) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT entity_id FROM favorites
           WHERE owner = ? AND space = ? AND kind = ?
           ORDER BY rank IS NULL, rank ASC, created_at DESC`,
      )
      .all(owner, space, kind) as Array<{ entity_id: string }>
    return rows.map((r) => r.entity_id)
  },
  has: async (owner: string, space: string, kind: FavoriteEntityKind, entityId: string) => {
    await ctx.ensureInit()
    return Boolean(
      ctx.required
        .prepare(
          'SELECT 1 FROM favorites WHERE owner = ? AND space = ? AND kind = ? AND entity_id = ?',
        )
        .get(owner, space, kind, entityId),
    )
  },
  add: async (f: FavoriteRecord) => {
    await ctx.ensureInit()
    const db = ctx.required

    // IMMEDIATE so the identity revalidation and the row land as one writer: a
    // settlement committing in between would leave a favourite on a retired id.
    db.exec('BEGIN IMMEDIATE')
    try {
      const entityId =
        f.kind === 'note' ? resolveLiveIdentityForWrite(db, f.space, f.entityId) : f.entityId

      db.prepare(
        'DELETE FROM favorites WHERE owner = ? AND space = ? AND entity_id = ? AND kind <> ?',
      ).run(f.owner, f.space, entityId, f.kind)
      db.prepare(
        `INSERT INTO favorites (owner, space, kind, entity_id, created_at, rank)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner, space, kind, entity_id) DO UPDATE SET
             created_at = excluded.created_at,
             rank = excluded.rank`,
      ).run(f.owner, f.space, f.kind, entityId, f.createdAt, f.rank)
      db.exec('COMMIT')
      return { ...f, entityId }
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  remove: async (owner: string, space: string, kind: FavoriteEntityKind, entityId: string) => {
    await ctx.ensureInit()
    ctx.required
      .prepare('DELETE FROM favorites WHERE owner = ? AND space = ? AND kind = ? AND entity_id = ?')
      .run(owner, space, kind, entityId)
  },
  removeByEntity: async (owner: string, space: string, entityId: string) => {
    await ctx.ensureInit()
    const db = ctx.required
    // The caller's id is a pre-resolve like `add`'s, and a settlement may have moved
    // the row onto its successor since. Both spellings are removed: an unfavorite
    // must not leave the row it was aimed at, and it must not fail closed either —
    // a conflict here would strand exactly the favourite the user asked to drop.
    let successor: string | null = null

    try {
      const canonical = resolveLiveIdentityForWrite(db, space, entityId)

      successor = canonical === entityId ? null : canonical
    } catch {
      successor = null
    }
    db.prepare('DELETE FROM favorites WHERE owner = ? AND space = ? AND entity_id IN (?, ?)').run(
      owner,
      space,
      entityId,
      successor ?? entityId,
    )
  },
})
