import type { FavoriteEntityKind, FavoriteRecord, FavoritesPersistence } from '../../types'
import type { PgDriverCtx } from './context'
import { enterIdentityTierForReferences } from './liveIdentity'

export const createFavoritesFacet = (ctx: PgDriverCtx): FavoritesPersistence => ({
  list: async (owner: string, space: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT owner, space, kind, entity_id, created_at, rank
         FROM favorites
         WHERE owner = $1 AND space = $2
         ORDER BY rank IS NULL, rank ASC, created_at DESC`,
      [owner, space],
    )
    return (
      res.rows as Array<{
        owner: string
        space: string
        kind: FavoriteEntityKind
        entity_id: string
        created_at: string
        rank: string | number | null
      }>
    ).map((r) => ({
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
    const res = await ctx.required.query(
      `SELECT entity_id FROM favorites
         WHERE owner = $1 AND space = $2 AND kind = $3
         ORDER BY rank IS NULL, rank ASC, created_at DESC`,
      [owner, space, kind],
    )
    return (res.rows as Array<{ entity_id: string }>).map((r) => r.entity_id)
  },
  has: async (owner: string, space: string, kind: FavoriteEntityKind, entityId: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT 1 FROM favorites WHERE owner = $1 AND space = $2 AND kind = $3 AND entity_id = $4',
      [owner, space, kind, entityId],
    )
    return Boolean(res.rows.length)
  },
  add: async (f: FavoriteRecord) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    // One transaction so the identity revalidation and the row land together: a
    // settlement committing in between would leave a favourite on a retired id.
    try {
      await client.query('BEGIN')
      const identity = await enterIdentityTierForReferences(
        client,
        f.kind === 'note' ? [f.entityId] : [],
      )
      const entityId = f.kind === 'note' ? identity.canonical(f.space, f.entityId) : f.entityId

      await client.query(
        'DELETE FROM favorites WHERE owner = $1 AND space = $2 AND entity_id = $3 AND kind <> $4',
        [f.owner, f.space, entityId, f.kind],
      )
      await client.query(
        `INSERT INTO favorites (owner, space, kind, entity_id, created_at, rank)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (owner, space, kind, entity_id) DO UPDATE SET
             created_at = EXCLUDED.created_at,
             rank = EXCLUDED.rank`,
        [f.owner, f.space, f.kind, entityId, f.createdAt, f.rank],
      )
      await client.query('COMMIT')
      return { ...f, entityId }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  remove: async (owner: string, space: string, kind: FavoriteEntityKind, entityId: string) => {
    await ctx.ensureInit()
    await ctx.required.query(
      'DELETE FROM favorites WHERE owner = $1 AND space = $2 AND kind = $3 AND entity_id = $4',
      [owner, space, kind, entityId],
    )
  },
  removeByEntity: async (owner: string, space: string, entityId: string) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    // The caller's id is a pre-resolve like `add`'s, and a settlement may have moved
    // the row onto its successor since. Both spellings are removed: an unfavorite must
    // not leave the row it was aimed at, and it must not fail closed either — a
    // conflict here would strand exactly the favourite the user asked to drop.
    try {
      await client.query('BEGIN')
      const identity = await enterIdentityTierForReferences(client, [entityId])
      let successor: string | null = null

      try {
        const canonical = identity.canonical(space, entityId)

        successor = canonical === entityId ? null : canonical
      } catch {
        successor = null
      }
      await client.query(
        'DELETE FROM favorites WHERE owner = $1 AND space = $2 AND entity_id = ANY($3)',
        [owner, space, successor ? [entityId, successor] : [entityId]],
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
})
