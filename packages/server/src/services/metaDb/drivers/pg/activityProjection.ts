import type { PoolClient } from 'pg'

import type {
  ActivityProjectionGcMaintenance,
  ActivityProjectionLease,
  ActivityProjectionMaintenance,
  ActivityProjectionPreparation,
} from '@notarium/core'
import { activityProjectionRebuilding, activityProjectionStale } from '@notarium/core'

import type { PgDriverCtx } from './context'
import { lockActivityProjectionGcRow, lockActivityProjectionStatus } from './lockOrder'
import { lockRevisionKeys } from './revisionLocks'

const REBUILD_BATCH_SIZE = 10
const GC_BATCH_SIZE = 10

type ProjectionStatusRow = {
  state: 'ready' | 'rebuilding'
  legacy_through_revision_id: string | number | null
  next_source_ordinal: string | number
  generation_counter: string | number
  active_generation: string | number | null
  active_through: string | number | null
  build_generation: string | number | null
  rebuild_cursor: string | number | null
  source_generation: string | number
  build_source_generation: string | number | null
}

const preparationOf = (row: ProjectionStatusRow): ActivityProjectionPreparation =>
  row.state === 'ready'
    ? {
        state: 'ready',
        lease: {
          through: row.active_through == null ? null : String(row.active_through),
          activeGeneration: String(row.active_generation),
          sourceGeneration: String(row.source_generation),
        },
      }
    : { state: 'rebuilding' }

export const pgActivityProjectionLease = async (
  client: PoolClient,
  space: string,
  requested?: ActivityProjectionLease,
): Promise<ActivityProjectionLease> => {
  const result = await client.query('SELECT * FROM activity_projection_status WHERE space = $1', [
    space,
  ])
  const status = result.rows[0] as ProjectionStatusRow | undefined

  if (!status || status.state !== 'ready' || status.active_generation == null) {
    throw activityProjectionRebuilding()
  }
  const current: ActivityProjectionLease = {
    through: status.active_through == null ? null : String(status.active_through),
    activeGeneration: String(status.active_generation),
    sourceGeneration: String(status.source_generation),
  }

  if (!requested) {
    return current
  }
  if (
    requested.activeGeneration !== current.activeGeneration ||
    requested.sourceGeneration !== current.sourceGeneration ||
    (requested.through == null) !== (current.through == null) ||
    (requested.through != null &&
      current.through != null &&
      BigInt(requested.through) > BigInt(current.through))
  ) {
    throw activityProjectionStale()
  }

  return { ...current, through: requested.through }
}

const sourceSql = `
  SELECT revisions.id AS revision_id,
         revisions.note_id,
         revisions.principal,
         revisions.class,
         revisions.chars_added,
         revisions.chars_removed,
         revisions.integrity,
         revisions.entry_role,
         revisions.id AS source_ordinal
    FROM note_revisions AS revisions
   WHERE revisions.space = $1
     AND $2::bigint IS NOT NULL
     AND revisions.id <= $2::bigint
     AND revisions.id > $3::bigint
     AND revisions.id <= $4::bigint
     AND NOT EXISTS (
       SELECT 1 FROM activity_revision_order AS ordered
        WHERE ordered.revision_id = revisions.id
     )
  UNION ALL
  SELECT revisions.id AS revision_id,
         revisions.note_id,
         revisions.principal,
         revisions.class,
         revisions.chars_added,
         revisions.chars_removed,
         revisions.integrity,
         revisions.entry_role,
         ordered.source_ordinal
    FROM activity_revision_order AS ordered
    JOIN note_revisions AS revisions ON revisions.id = ordered.revision_id
   WHERE ordered.space = $1
     AND ordered.source_ordinal > $3::bigint
     AND ordered.source_ordinal <= $4::bigint`

const lockStatus = async (
  client: PoolClient,
  space: string,
): Promise<ProjectionStatusRow | undefined> => {
  return (await lockActivityProjectionStatus<ProjectionStatusRow>(client, space)).row
}

const readStatus = async (
  client: PoolClient,
  space: string,
): Promise<ProjectionStatusRow | undefined> => {
  const result = await client.query('SELECT * FROM activity_projection_status WHERE space = $1', [
    space,
  ])
  return result.rows[0] as ProjectionStatusRow | undefined
}

const assertActivityProjectionTargetExists = async (
  client: PoolClient,
  space: string,
): Promise<void> => {
  const purged = await client.query(
    `SELECT 1 FROM revision_purge_fences
      WHERE kind = 'space' AND entity_id = $1 LIMIT 1`,
    [space],
  )

  if (purged.rows.length) {
    throw new Error(`activity projection target was permanently purged: ${space}`)
  }
}

const initialize = async (client: PoolClient, space: string): Promise<ProjectionStatusRow> => {
  // Callers hold a revision-Space lock before reaching here. The purge marker
  // therefore either follows this transaction and removes its status, or
  // precedes it and rejects initialization without leaving residue.
  await assertActivityProjectionTargetExists(client, space)
  let status = await lockStatus(client, space)

  if (!status) {
    const legacy = await client.query(
      `SELECT MAX(revisions.id) AS max_id
         FROM note_revisions AS revisions
        WHERE revisions.space = $1
          AND NOT EXISTS (
            SELECT 1 FROM activity_revision_order AS ordered
             WHERE ordered.revision_id = revisions.id
          )`,
      [space],
    )
    const legacyMax = legacy.rows[0]?.max_id as string | number | null

    const inserted = await client.query(
      `INSERT INTO activity_projection_status (
         space, state, legacy_through_revision_id, next_source_ordinal,
         generation_counter, active_generation, active_through,
         build_generation, rebuild_cursor, rebuild_target,
         source_generation, build_source_generation, last_error_code, updated_at
       )
       VALUES (
         $1,
         CASE WHEN $2::bigint IS NULL THEN 'ready' ELSE 'rebuilding' END,
         $2, COALESCE($2, 0), 1,
         CASE WHEN $2::bigint IS NULL THEN 1 ELSE NULL END,
         NULL,
         CASE WHEN $2::bigint IS NULL THEN NULL ELSE 1 END,
         CASE WHEN $2::bigint IS NULL THEN NULL ELSE 0 END,
         $2, 1,
         CASE WHEN $2::bigint IS NULL THEN NULL ELSE 1 END,
         NULL, CURRENT_TIMESTAMP::text
       )
       ON CONFLICT (space) DO NOTHING
       RETURNING *`,
      [space, legacyMax],
    )
    status = inserted.rows[0] as ProjectionStatusRow | undefined

    if (!status) {
      status = await lockStatus(client, space)
    }
  }

  if (!status) {
    throw new Error(`activity projection status was not initialized for ${space}`)
  }

  if (status.state === 'rebuilding' && status.build_generation == null) {
    const allocated = await client.query(
      `UPDATE activity_projection_status
          SET generation_counter = generation_counter + 1,
              build_generation = generation_counter + 1,
              rebuild_cursor = 0,
              rebuild_target = next_source_ordinal,
              build_source_generation = source_generation,
              last_error_code = NULL,
              updated_at = CURRENT_TIMESTAMP::text
        WHERE space = $1
        RETURNING *`,
      [space],
    )
    status = allocated.rows[0] as ProjectionStatusRow
  }

  return status
}

const ordinalsAfter = async (
  client: PoolClient,
  space: string,
  status: ProjectionStatusRow,
  limit: number,
): Promise<string[]> => {
  const result = await client.query(
    `WITH source AS (${sourceSql})
     SELECT source_ordinal FROM source ORDER BY source_ordinal LIMIT $5`,
    [
      space,
      status.legacy_through_revision_id,
      status.rebuild_cursor ?? 0,
      status.next_source_ordinal,
      limit,
    ],
  )
  return (result.rows as Array<{ source_ordinal: string | number }>).map((row) =>
    String(row.source_ordinal),
  )
}

const applyBatch = async (
  client: PoolClient,
  space: string,
  status: ProjectionStatusRow,
  fromExclusive: string,
  throughInclusive: string,
): Promise<boolean> => {
  const generation = String(status.build_generation)

  await client.query(
    `WITH source AS (${sourceSql}),
     bucketed AS (
       SELECT source.*,
              CASE
                WHEN integrity = 'quarantined' THEN 'gap'
                WHEN principal IS NULL THEN 'external'
                ELSE 'principal'
              END AS actor_kind,
              CASE
                WHEN integrity = 'trusted' AND principal IS NOT NULL THEN principal
                ELSE ''
              END AS actor_key,
              CASE WHEN integrity = 'quarantined' THEN '' ELSE COALESCE(class, '') END AS class_key
         FROM source
        WHERE integrity = 'quarantined' OR entry_role <> 'baseline'
     ),
     seeded AS (
       SELECT bucketed.*,
              COALESCE(previous.event_count, 0) AS seed_event_count,
              COALESCE(previous.chars_added_sum, 0) AS seed_chars_added_sum,
              COALESCE(previous.chars_added_known, 0) AS seed_chars_added_known,
              COALESCE(previous.chars_removed_sum, 0) AS seed_chars_removed_sum,
              COALESCE(previous.chars_removed_known, 0) AS seed_chars_removed_known
         FROM bucketed
         LEFT JOIN activity_note_actor_heads AS heads
           ON heads.space = $1
          AND heads.generation = $5::bigint
          AND heads.note_id = bucketed.note_id
          AND heads.actor_kind = bucketed.actor_kind
          AND heads.actor_key = bucketed.actor_key
          AND heads.class_key = bucketed.class_key
         LEFT JOIN activity_note_actor_states AS previous
           ON previous.space = heads.space
          AND previous.generation = heads.generation
          AND previous.source_ordinal = heads.source_ordinal
     ),
     cumulative AS (
       SELECT *,
              seed_event_count + COUNT(*) OVER bucket_rows AS event_count,
              seed_chars_added_sum + SUM(
                CASE WHEN integrity = 'trusted' AND chars_added IS NOT NULL THEN chars_added ELSE 0 END
              ) OVER bucket_rows AS chars_added_sum,
              seed_chars_added_known + SUM(
                CASE WHEN integrity = 'trusted' AND chars_added IS NOT NULL THEN 1 ELSE 0 END
              ) OVER bucket_rows AS chars_added_known,
              seed_chars_removed_sum + SUM(
                CASE WHEN integrity = 'trusted' AND chars_removed IS NOT NULL THEN chars_removed ELSE 0 END
              ) OVER bucket_rows AS chars_removed_sum,
              seed_chars_removed_known + SUM(
                CASE WHEN integrity = 'trusted' AND chars_removed IS NOT NULL THEN 1 ELSE 0 END
              ) OVER bucket_rows AS chars_removed_known
         FROM seeded
       WINDOW bucket_rows AS (
         PARTITION BY note_id, actor_kind, actor_key, class_key
         ORDER BY source_ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       )
     )
     INSERT INTO activity_note_actor_states (
       space, generation, source_ordinal, revision_id, note_id,
       actor_kind, actor_key, class_key,
       event_count, chars_added_sum, chars_added_known,
       chars_removed_sum, chars_removed_known
     )
     SELECT $1, $5, source_ordinal, revision_id, note_id,
            actor_kind, actor_key, class_key,
            event_count, chars_added_sum, chars_added_known,
            chars_removed_sum, chars_removed_known
       FROM cumulative`,
    [space, status.legacy_through_revision_id, fromExclusive, throughInclusive, generation],
  )

  await client.query(
    `INSERT INTO activity_note_actor_heads (
       space, generation, note_id, actor_kind, actor_key, class_key,
       source_ordinal, revision_id
     )
     SELECT states.space, states.generation, states.note_id,
            states.actor_kind, states.actor_key, states.class_key,
            states.source_ordinal, states.revision_id
       FROM activity_note_actor_states AS states
       JOIN (
         SELECT note_id, actor_kind, actor_key, class_key, MAX(source_ordinal) AS source_ordinal
           FROM activity_note_actor_states
          WHERE space = $1 AND generation = $2::bigint
            AND source_ordinal > $3::bigint AND source_ordinal <= $4::bigint
          GROUP BY note_id, actor_kind, actor_key, class_key
       ) AS latest
         ON latest.note_id = states.note_id
        AND latest.actor_kind = states.actor_kind
        AND latest.actor_key = states.actor_key
        AND latest.class_key = states.class_key
        AND latest.source_ordinal = states.source_ordinal
      WHERE states.space = $1 AND states.generation = $2::bigint
     ON CONFLICT (space, generation, note_id, actor_kind, actor_key, class_key)
     DO UPDATE SET source_ordinal = EXCLUDED.source_ordinal, revision_id = EXCLUDED.revision_id`,
    [space, generation, fromExclusive, throughInclusive],
  )

  const advanced = await client.query(
    `UPDATE activity_projection_status
        SET rebuild_cursor = $2, rebuild_target = next_source_ordinal,
            last_error_code = NULL, updated_at = CURRENT_TIMESTAMP::text
      WHERE space = $1 AND build_generation = $3 AND build_source_generation = $4`,
    [space, throughInclusive, generation, status.build_source_generation],
  )

  // A source invalidation can retire this generation while the non-locking batch
  // is building. The caller must roll the WHOLE transaction back when the cursor
  // loses that race; committing the inserts would let GC remove its queue row
  // before these old-generation rows become visible.
  return advanced.rowCount === 1
}

export const preparePgActivityProjection = async (
  ctx: PgDriverCtx,
  space: string,
): Promise<ActivityProjectionPreparation> => {
  await ctx.ensureInit()
  const client = await ctx.required.connect()

  try {
    await client.query('BEGIN')
    await lockRevisionKeys(client, 'space', [space], 'shared')
    const status = await initialize(client, space)
    await client.query('COMMIT')
    return preparationOf(status)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export const maintainPgActivityProjectionProgressBatch = async (
  client: PoolClient,
  space: string,
  // Production omits this override and keeps the interactive batch. The offline
  // benchmark snapshot builder may enlarge it only before traffic is admitted.
  batchSize = REBUILD_BATCH_SIZE,
): Promise<ActivityProjectionMaintenance | null> => {
  await client.query('BEGIN')
  // Shared with appends, exclusive against Space purge/final publication. If
  // progress wins, purge subsequently removes the whole batch; if purge wins,
  // the durable fence below rejects the stale turn without leaving residue.
  await lockRevisionKeys(client, 'space', [space], 'shared')
  await assertActivityProjectionTargetExists(client, space)
  // The set-oriented progress query must not hold the status-row tail lock: the
  // append trigger uses that row only to allocate commit order. Publication still
  // enters the revision-Space fence below; a missing/unallocated build falls through
  // to that locked path once, then later progress turns use this non-locking snapshot.
  const status = await readStatus(client, space)

  if (!status || (status.state === 'rebuilding' && status.build_generation == null)) {
    await client.query('ROLLBACK')
    return null
  }

  if (status.state === 'ready') {
    await client.query('COMMIT')
    return { state: 'ready', processed: 0, published: false }
  }
  const ordinals = await ordinalsAfter(client, space, status, batchSize + 1)

  if (ordinals.length <= batchSize) {
    await client.query('ROLLBACK')
    return null
  }
  const page = ordinals.slice(0, batchSize)
  const boundary = page.at(-1)!

  const advanced = await applyBatch(
    client,
    space,
    status,
    String(status.rebuild_cursor ?? 0),
    boundary,
  )

  if (!advanced) {
    await client.query('ROLLBACK')
    return { state: 'rebuilding', processed: 0, published: false }
  }
  await client.query('COMMIT')
  return { state: 'rebuilding', processed: page.length, published: false }
}

export const maintainPgActivityProjectionFinalBatch = async (
  client: PoolClient,
  space: string,
  // Paired with the progress override above; production callers omit it.
  batchSize = REBUILD_BATCH_SIZE,
): Promise<ActivityProjectionMaintenance> => {
  await client.query('BEGIN')
  await lockRevisionKeys(client, 'space', [space])
  const status = await initialize(client, space)

  if (status.state === 'ready') {
    await client.query('COMMIT')
    return { state: 'ready', processed: 0, published: false }
  }
  const ordinals = await ordinalsAfter(client, space, status, batchSize + 1)

  if (ordinals.length > batchSize) {
    await client.query('ROLLBACK')
    return { state: 'rebuilding', processed: 0, published: false }
  }
  const boundary = ordinals.at(-1)
  const initialCursor = String(status.rebuild_cursor ?? 0)

  if (boundary != null) {
    const advanced = await applyBatch(client, space, status, initialCursor, boundary)

    if (!advanced) {
      throw new Error(`activity projection final batch lost its generation for ${space}`)
    }
  }
  const finalCursor = boundary ?? initialCursor

  if (
    status.active_generation != null &&
    String(status.active_generation) !== String(status.build_generation)
  ) {
    await client.query(
      `INSERT INTO activity_projection_gc (space, generation, phase, updated_at)
       VALUES ($1, $2, 'states', CURRENT_TIMESTAMP::text)
       ON CONFLICT (space, generation) DO NOTHING`,
      [space, status.active_generation],
    )
  }
  const published = await client.query(
    `UPDATE activity_projection_status
        SET state = 'ready', active_generation = build_generation,
            active_through = NULLIF($2::bigint, 0),
            build_generation = NULL, rebuild_cursor = NULL, rebuild_target = NULL,
            build_source_generation = NULL, last_error_code = NULL,
            updated_at = CURRENT_TIMESTAMP::text
      WHERE space = $1 AND state = 'rebuilding'
        AND build_generation = $3 AND build_source_generation = source_generation`,
    [space, finalCursor, status.build_generation],
  )

  if (published.rowCount !== 1) {
    throw new Error(`activity projection publication lost its generation for ${space}`)
  }
  await client.query('COMMIT')
  return { state: 'ready', processed: ordinals.length, published: true }
}

export const maintainPgActivityProjection = async (
  ctx: PgDriverCtx,
  space: string,
): Promise<ActivityProjectionMaintenance> => {
  await ctx.ensureInit()
  const client = await ctx.required.connect()

  try {
    const progress = await maintainPgActivityProjectionProgressBatch(client, space)
    return progress ?? (await maintainPgActivityProjectionFinalBatch(client, space))
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    await client
      .query(
        `UPDATE activity_projection_status
            SET last_error_code = 'rebuild_failed', updated_at = CURRENT_TIMESTAMP::text
          WHERE space = $1 AND state = 'rebuilding'`,
        [space],
      )
      .catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export const maintainPgActivityProjectionGc = async (
  ctx: PgDriverCtx,
  space: string,
): Promise<ActivityProjectionGcMaintenance> => {
  await ctx.ensureInit()
  const client = await ctx.required.connect()

  try {
    await client.query('BEGIN')
    const queued = (
      await lockActivityProjectionGcRow<{
        generation: string | number
        phase: 'states' | 'heads'
      }>(client, space)
    ).row

    if (!queued) {
      await client.query('COMMIT')
      return { deleted: 0, pending: false }
    }
    let deleted = 0
    let phase = queued.phase

    if (phase === 'states') {
      const result = await client.query(
        `WITH doomed AS (
           SELECT ctid FROM activity_note_actor_states
            WHERE space = $1 AND generation = $2
            LIMIT $3
         )
         DELETE FROM activity_note_actor_states AS states
          USING doomed WHERE states.ctid = doomed.ctid
         RETURNING 1`,
        [space, queued.generation, GC_BATCH_SIZE],
      )
      deleted = result.rowCount ?? 0

      if (deleted === 0) {
        await client.query(
          `UPDATE activity_projection_gc
              SET phase = 'heads', updated_at = CURRENT_TIMESTAMP::text
            WHERE space = $1 AND generation = $2`,
          [space, queued.generation],
        )
        phase = 'heads'
      }
    }

    if (phase === 'heads' && deleted === 0) {
      const result = await client.query(
        `WITH doomed AS (
           SELECT ctid FROM activity_note_actor_heads
            WHERE space = $1 AND generation = $2
            LIMIT $3
         )
         DELETE FROM activity_note_actor_heads AS heads
          USING doomed WHERE heads.ctid = doomed.ctid
         RETURNING 1`,
        [space, queued.generation, GC_BATCH_SIZE],
      )
      deleted = result.rowCount ?? 0

      if (deleted === 0) {
        await client.query(
          'DELETE FROM activity_projection_gc WHERE space = $1 AND generation = $2',
          [space, queued.generation],
        )
      }
    }
    const pending = await client.query(
      'SELECT 1 FROM activity_projection_gc WHERE space = $1 LIMIT 1',
      [space],
    )
    await client.query('COMMIT')
    return { deleted, pending: pending.rows.length > 0 }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
