import type {
  ActivityProjectionGcMaintenance,
  ActivityProjectionLease,
  ActivityProjectionMaintenance,
  ActivityProjectionPreparation,
} from '@notarium/core'
import { activityProjectionRebuilding, activityProjectionStale } from '@notarium/core'

import { readSqliteBigInts, type SqliteDriverCtx } from './context'

const INTERACTIVE_WRITE_BATCH_SIZE = 10
const CHECKPOINT_SOURCE_INTERVAL = 10_000n

const isSqliteBusy = (error: unknown): boolean => {
  const errcode =
    typeof error === 'object' && error != null && 'errcode' in error
      ? (error as { errcode?: unknown }).errcode
      : undefined

  return typeof errcode === 'number' && (errcode & 0xff) === 5
}

type ProjectionStatusRow = {
  state: 'ready' | 'rebuilding'
  legacy_through_revision_id: number | bigint | null
  next_source_ordinal: number | bigint
  generation_counter: number | bigint
  active_generation: number | bigint | null
  active_through: number | bigint | null
  build_generation: number | bigint | null
  rebuild_cursor: number | bigint | null
  source_generation: number | bigint
  build_source_generation: number | bigint | null
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

const assertActivityProjectionTargetExists = (ctx: SqliteDriverCtx, space: string): void => {
  const purged = ctx.required
    .prepare(
      `SELECT 1 FROM revision_purge_fences
        WHERE kind = 'space' AND entity_id = ? LIMIT 1`,
    )
    .get(space)

  if (purged) {
    throw new Error(`activity projection target was permanently purged: ${space}`)
  }
}

export const sqliteActivityProjectionLease = (
  ctx: SqliteDriverCtx,
  space: string,
  requested?: ActivityProjectionLease,
): ActivityProjectionLease => {
  const status = readSqliteBigInts(
    ctx.required.prepare('SELECT * FROM activity_projection_status WHERE space = ?'),
  ).get(space) as ProjectionStatusRow | undefined

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

const initialize = (ctx: SqliteDriverCtx, space: string): ProjectionStatusRow => {
  const db = ctx.required
  // BEGIN IMMEDIATE in both callers makes the durable Space fence and status
  // initialization one winner: maintenance that starts after purge cannot
  // resurrect the derived carrier after purge deleted it.
  assertActivityProjectionTargetExists(ctx, space)
  let status = readSqliteBigInts(
    db.prepare('SELECT * FROM activity_projection_status WHERE space = ?'),
  ).get(space) as ProjectionStatusRow | undefined

  if (!status) {
    db.prepare(
      `INSERT INTO activity_projection_status (
       space, state, legacy_through_revision_id, next_source_ordinal,
       generation_counter, active_generation, active_through,
       build_generation, rebuild_cursor, rebuild_target,
       source_generation, build_source_generation, last_error_code, updated_at
     )
     SELECT
       ?,
       CASE WHEN legacy.max_id IS NULL THEN 'ready' ELSE 'rebuilding' END,
       legacy.max_id,
       COALESCE(legacy.max_id, 0),
       1,
       CASE WHEN legacy.max_id IS NULL THEN 1 ELSE NULL END,
       NULL,
       CASE WHEN legacy.max_id IS NULL THEN NULL ELSE 1 END,
       CASE WHEN legacy.max_id IS NULL THEN NULL ELSE 0 END,
       legacy.max_id,
       1,
       CASE WHEN legacy.max_id IS NULL THEN NULL ELSE 1 END,
       NULL,
       CURRENT_TIMESTAMP
     FROM (
       SELECT MAX(revisions.id) AS max_id
         FROM note_revisions AS revisions
        WHERE revisions.space = ?
          AND NOT EXISTS (
            SELECT 1 FROM activity_revision_order AS ordered
             WHERE ordered.revision_id = revisions.id
          )
     ) AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM activity_projection_status AS status WHERE status.space = ?
     )
       ON CONFLICT(space) DO NOTHING`,
    ).run(space, space, space)
    status = readSqliteBigInts(
      db.prepare('SELECT * FROM activity_projection_status WHERE space = ?'),
    ).get(space) as ProjectionStatusRow | undefined
  }

  if (!status) {
    throw new Error(`activity projection status was not initialized for ${space}`)
  }
  if (status.state === 'rebuilding' && status.build_generation == null) {
    db.prepare(
      `UPDATE activity_projection_status
        SET generation_counter = generation_counter + 1,
            build_generation = generation_counter + 1,
            rebuild_cursor = 0,
            rebuild_target = next_source_ordinal,
            build_source_generation = source_generation,
            last_error_code = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE space = ? AND state = 'rebuilding' AND build_generation IS NULL`,
    ).run(space)
    status = readSqliteBigInts(
      db.prepare('SELECT * FROM activity_projection_status WHERE space = ?'),
    ).get(space) as ProjectionStatusRow
  }

  return status
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
   WHERE revisions.space = ?
     AND revisions.id > ?
     AND revisions.id <= ?
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
   WHERE ordered.space = ?
     AND ordered.source_ordinal > ?
     AND ordered.source_ordinal <= ?`

const applyBatch = (
  ctx: SqliteDriverCtx,
  space: string,
  status: ProjectionStatusRow,
  fromExclusive: string,
  throughInclusive: string,
): void => {
  const db = ctx.required
  const generation = String(status.build_generation)
  const legacy =
    status.legacy_through_revision_id == null ? null : String(status.legacy_through_revision_id)
  const legacyUpper =
    legacy == null || BigInt(legacy) > BigInt(throughInclusive) ? throughInclusive : legacy
  const sourceParams = [
    space,
    fromExclusive,
    legacy == null ? '0' : legacyUpper,
    space,
    fromExclusive,
    throughInclusive,
  ]

  const stateCtes = `source AS (${sourceSql}),
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
           ON heads.space = ?
          AND heads.generation = ?
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
     )`
  const stateSql = `WITH ${stateCtes}
     INSERT INTO activity_note_actor_states (
       space, generation, source_ordinal, revision_id, note_id,
       actor_kind, actor_key, class_key,
       event_count, chars_added_sum, chars_added_known,
       chars_removed_sum, chars_removed_known
     )
     SELECT ?, ?, source_ordinal, revision_id, note_id,
            actor_kind, actor_key, class_key,
            event_count, chars_added_sum, chars_added_known,
            chars_removed_sum, chars_removed_known
       FROM cumulative`
  const stateParams = [...sourceParams, space, generation, space, generation]

  db.prepare(stateSql).run(...stateParams)

  db.prepare(
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
          WHERE space = ? AND generation = ?
            AND source_ordinal > ? AND source_ordinal <= ?
          GROUP BY note_id, actor_kind, actor_key, class_key
       ) AS latest
         ON latest.note_id = states.note_id
        AND latest.actor_kind = states.actor_kind
        AND latest.actor_key = states.actor_key
        AND latest.class_key = states.class_key
        AND latest.source_ordinal = states.source_ordinal
      WHERE states.space = ? AND states.generation = ?
     ON CONFLICT(space, generation, note_id, actor_kind, actor_key, class_key)
     DO UPDATE SET source_ordinal = excluded.source_ordinal, revision_id = excluded.revision_id`,
  ).run(space, generation, fromExclusive, throughInclusive, space, generation)
}

export const prepareSqliteActivityProjection = async (
  ctx: SqliteDriverCtx,
  space: string,
): Promise<ActivityProjectionPreparation> => {
  await ctx.ensureInit()
  const db = ctx.required

  try {
    db.exec('BEGIN IMMEDIATE')
    const status = initialize(ctx, space)
    db.exec('COMMIT')
    return preparationOf(status)
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }
}

export const maintainSqliteActivityProjection = async (
  ctx: SqliteDriverCtx,
  space: string,
  batchSize = INTERACTIVE_WRITE_BATCH_SIZE,
): Promise<ActivityProjectionMaintenance> => {
  await ctx.ensureInit()
  const db = ctx.required

  try {
    db.exec('BEGIN IMMEDIATE')
    const status = initialize(ctx, space)

    if (status.state === 'ready') {
      db.exec('COMMIT')
      return { state: 'ready', processed: 0, published: false }
    }
    const cursor = String(status.rebuild_cursor ?? 0)
    const legacy =
      status.legacy_through_revision_id == null ? null : String(status.legacy_through_revision_id)
    const ordinals = readSqliteBigInts(
      db.prepare(
        `WITH source AS (${sourceSql})
         SELECT source_ordinal FROM source ORDER BY source_ordinal LIMIT ?`,
      ),
    ).all(
      space,
      cursor,
      legacy ?? '0',
      space,
      cursor,
      String(status.next_source_ordinal),
      batchSize + 1,
    ) as Array<{
      source_ordinal: number | bigint
    }>
    const page = ordinals.slice(0, batchSize)
    const boundary = page.at(-1)?.source_ordinal

    if (boundary != null) {
      applyBatch(ctx, space, status, cursor, String(boundary))
      db.prepare(
        `UPDATE activity_projection_status
            SET rebuild_cursor = ?, rebuild_target = next_source_ordinal,
                last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE space = ? AND build_generation = ? AND build_source_generation = ?`,
      ).run(
        String(boundary),
        space,
        String(status.build_generation),
        String(status.build_source_generation),
      )
    }

    if (ordinals.length > batchSize) {
      db.exec('COMMIT')
      if (BigInt(String(boundary)) % CHECKPOINT_SOURCE_INTERVAL < BigInt(page.length)) {
        void ctx.checkpointWal().catch((error) => {
          console.error('[activity-projection] SQLite WAL checkpoint failed:', error)
        })
      }

      return { state: 'rebuilding', processed: page.length, published: false }
    }
    const finalCursor = boundary == null ? cursor : String(boundary)

    if (
      status.active_generation != null &&
      String(status.active_generation) !== String(status.build_generation)
    ) {
      db.prepare(
        `INSERT OR IGNORE INTO activity_projection_gc (space, generation, phase, updated_at)
         VALUES (?, ?, 'states', CURRENT_TIMESTAMP)`,
      ).run(space, String(status.active_generation))
    }
    const published = db
      .prepare(
        `UPDATE activity_projection_status
          SET state = 'ready', active_generation = build_generation,
              active_through = CASE WHEN ? = '0' THEN NULL ELSE ? END,
              build_generation = NULL, rebuild_cursor = NULL, rebuild_target = NULL,
              build_source_generation = NULL, last_error_code = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE space = ? AND state = 'rebuilding'
          AND build_generation = ? AND build_source_generation = source_generation`,
      )
      .run(finalCursor, finalCursor, space, String(status.build_generation))

    if (Number(published.changes) !== 1) {
      throw new Error(`activity projection publication lost its generation for ${space}`)
    }
    db.exec('COMMIT')
    await ctx.checkpointWal().catch((error) => {
      console.error('[activity-projection] SQLite WAL checkpoint failed:', error)
    })
    return { state: 'ready', processed: page.length, published: true }
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    if (isSqliteBusy(error)) {
      return { state: 'rebuilding', processed: 0, published: false }
    }
    db.prepare(
      `UPDATE activity_projection_status
          SET last_error_code = 'rebuild_failed', updated_at = CURRENT_TIMESTAMP
        WHERE space = ? AND state = 'rebuilding'`,
    ).run(space)
    throw error
  }
}

export const maintainSqliteActivityProjectionGc = async (
  ctx: SqliteDriverCtx,
  space: string,
): Promise<ActivityProjectionGcMaintenance> => {
  await ctx.ensureInit()
  const db = ctx.required

  try {
    db.exec('BEGIN IMMEDIATE')
    const queued = readSqliteBigInts(
      db.prepare(
        `SELECT generation, phase FROM activity_projection_gc
          WHERE space = ? ORDER BY generation LIMIT 1`,
      ),
    ).get(space) as { generation: number | bigint; phase: 'states' | 'heads' } | undefined

    if (!queued) {
      db.exec('COMMIT')
      return { deleted: 0, pending: false }
    }
    const generation = String(queued.generation)
    let deleted = 0
    let phase = queued.phase

    if (phase === 'states') {
      const result = db
        .prepare(
          `DELETE FROM activity_note_actor_states
            WHERE rowid IN (
              SELECT rowid FROM activity_note_actor_states
               WHERE space = ? AND generation = ? LIMIT ?
            )`,
        )
        .run(space, generation, INTERACTIVE_WRITE_BATCH_SIZE)
      deleted = Number(result.changes)

      if (deleted === 0) {
        db.prepare(
          `UPDATE activity_projection_gc SET phase = 'heads', updated_at = CURRENT_TIMESTAMP
            WHERE space = ? AND generation = ?`,
        ).run(space, generation)
        phase = 'heads'
      }
    }

    if (phase === 'heads' && deleted === 0) {
      const result = db
        .prepare(
          `DELETE FROM activity_note_actor_heads
            WHERE rowid IN (
              SELECT rowid FROM activity_note_actor_heads
               WHERE space = ? AND generation = ? LIMIT ?
            )`,
        )
        .run(space, generation, INTERACTIVE_WRITE_BATCH_SIZE)
      deleted = Number(result.changes)

      if (deleted === 0) {
        db.prepare('DELETE FROM activity_projection_gc WHERE space = ? AND generation = ?').run(
          space,
          generation,
        )
      }
    }
    const pending = db
      .prepare('SELECT 1 FROM activity_projection_gc WHERE space = ? LIMIT 1')
      .get(space)
    db.exec('COMMIT')
    return { deleted, pending: pending != null }
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    if (isSqliteBusy(error)) {
      return { deleted: 0, pending: true }
    }
    throw error
  }
}
