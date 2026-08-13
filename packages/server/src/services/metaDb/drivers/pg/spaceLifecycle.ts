import { CAUSAL_BARRIER_KIND, type SpaceLifecyclePersistence } from '@notarium/core'

import { spaceLifecycleOfRow, type SpaceLifecycleRow } from '../../causalRows'
import { lockCausalBarriers } from './causalBarriers'
import type { PgDriverCtx } from './context'
import { lockSpaceLifecycleRow } from './lockOrder'

export const createSpaceLifecycleFacet = (ctx: PgDriverCtx): SpaceLifecyclePersistence => ({
  init: () => ctx.ensureInit(),
  ensure: async (space, phase, now) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `INSERT INTO space_lifecycle
        (space, phase, generation, cleanup_manifest, changed_at, changed_by)
       VALUES ($1, $2, 1, NULL, $3, NULL)
       ON CONFLICT (space) DO UPDATE SET space = EXCLUDED.space
       RETURNING *`,
      [space, phase, now],
    )
    return spaceLifecycleOfRow(result.rows[0] as SpaceLifecycleRow)
  },
  get: async (space) => {
    await ctx.ensureInit()
    const result = await ctx.required.query('SELECT * FROM space_lifecycle WHERE space = $1', [
      space,
    ])
    const row = result.rows[0] as SpaceLifecycleRow | undefined
    return row ? spaceLifecycleOfRow(row) : null
  },
  transition: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockCausalBarriers(client, [
        {
          kind: CAUSAL_BARRIER_KIND.spaceLifecycle,
          space: input.space,
          key: input.space,
        },
      ])
      const row = await lockSpaceLifecycleRow<SpaceLifecycleRow>(client, input.space)

      if (!row) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      const current = spaceLifecycleOfRow(row)

      if (!input.expectedPhases.includes(current.phase)) {
        await client.query('COMMIT')
        return { status: 'phase-conflict', lifecycle: current }
      }
      const updated = await client.query(
        `UPDATE space_lifecycle SET
           phase = $2, generation = generation + 1, cleanup_manifest = $3,
           changed_at = $4, changed_by = $5
         WHERE space = $1
         RETURNING *`,
        [
          input.space,
          input.phase,
          input.cleanupManifest === undefined ? current.cleanupManifest : input.cleanupManifest,
          input.changedAt,
          input.changedBy ?? null,
        ],
      )
      const lifecycle = spaceLifecycleOfRow(updated.rows[0] as SpaceLifecycleRow)
      await client.query('COMMIT')
      return { status: 'transitioned', lifecycle }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  listUnfinished: async () => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT * FROM space_lifecycle
        WHERE phase NOT IN ('active', 'archived', 'purged')
        ORDER BY space`,
    )
    return (result.rows as SpaceLifecycleRow[]).map(spaceLifecycleOfRow)
  },
})
