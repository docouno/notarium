import type { SpaceLifecyclePersistence } from '@notarium/core'

import { spaceLifecycleOfRow, type SpaceLifecycleRow } from '../../causalRows'
import type { SqliteDriverCtx } from './context'

export const createSpaceLifecycleFacet = (ctx: SqliteDriverCtx): SpaceLifecyclePersistence => ({
  init: () => ctx.ensureInit(),
  ensure: async (space, phase, now) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT OR IGNORE INTO space_lifecycle
          (space, phase, generation, cleanup_manifest, changed_at, changed_by)
         VALUES (?, ?, 1, NULL, ?, NULL)`,
      )
      .run(space, phase, now)
    return spaceLifecycleOfRow(
      ctx.required
        .prepare('SELECT * FROM space_lifecycle WHERE space = ?')
        .get(space) as SpaceLifecycleRow,
    )
  },
  get: async (space) => {
    await ctx.ensureInit()
    const row = ctx.required.prepare('SELECT * FROM space_lifecycle WHERE space = ?').get(space) as
      SpaceLifecycleRow | undefined
    return row ? spaceLifecycleOfRow(row) : null
  },
  transition: async (input) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT * FROM space_lifecycle WHERE space = ?').get(input.space) as
        SpaceLifecycleRow | undefined

      if (!row) {
        db.exec('COMMIT')
        return { status: 'missing' }
      }
      const current = spaceLifecycleOfRow(row)

      if (!input.expectedPhases.includes(current.phase)) {
        db.exec('COMMIT')
        return { status: 'phase-conflict', lifecycle: current }
      }
      db.prepare(
        `UPDATE space_lifecycle SET
           phase = ?, generation = generation + 1, cleanup_manifest = ?,
           changed_at = ?, changed_by = ?
         WHERE space = ?`,
      ).run(
        input.phase,
        input.cleanupManifest === undefined ? current.cleanupManifest : input.cleanupManifest,
        input.changedAt,
        input.changedBy ?? null,
        input.space,
      )
      const lifecycle = spaceLifecycleOfRow(
        db
          .prepare('SELECT * FROM space_lifecycle WHERE space = ?')
          .get(input.space) as SpaceLifecycleRow,
      )
      db.exec('COMMIT')
      return { status: 'transitioned', lifecycle }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  listUnfinished: async () => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT * FROM space_lifecycle
          WHERE phase NOT IN ('active', 'archived', 'purged')
          ORDER BY space`,
      )
      .all() as SpaceLifecycleRow[]
    return rows.map(spaceLifecycleOfRow)
  },
})
