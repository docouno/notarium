import {
  RESTORE_OPERATION_PHASE,
  type RestoreOperationPersistence,
  SPACE_LIFECYCLE_PHASE,
} from '@notarium/core'

import { restoreOperationOfRow, type RestoreOperationRow } from '../../causalRows'
import type { SqliteDriverCtx } from './context'

const byReplay = `
  SELECT * FROM restore_operations
   WHERE actor_digest = ? AND endpoint = ? AND idempotency_digest = ?`

export const createRestoreOperationsFacet = (
  ctx: SqliteDriverCtx,
): RestoreOperationPersistence => ({
  init: () => ctx.ensureInit(),
  accept: async (input) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const replay = db
        .prepare(byReplay)
        .get(input.actorDigest, input.endpoint, input.idempotencyDigest) as
        RestoreOperationRow | undefined

      if (replay) {
        const operation = restoreOperationOfRow(replay)
        db.exec('COMMIT')
        return operation.requestFingerprint === input.requestFingerprint
          ? { status: 'replayed', operation }
          : { status: 'idempotency-conflict', operation }
      }
      const lifecycle = db
        .prepare('SELECT phase FROM space_lifecycle WHERE space = ?')
        .get(input.space) as { phase: string } | undefined
      const parent = input.parentOperationId
        ? (db
            .prepare(
              `SELECT id FROM restore_operations
                WHERE id = ? AND space = ?
                  AND endpoint = 'trash-restore-many'
                  AND phase NOT IN ('succeeded', 'rejected')`,
            )
            .get(input.parentOperationId, input.space) as { id: string } | undefined)
        : undefined

      if (
        (input.parentOperationId && !parent) ||
        (!input.parentOperationId && lifecycle?.phase !== SPACE_LIFECYCLE_PHASE.active)
      ) {
        throw new Error(
          `space lifecycle rejects restore admission: ${lifecycle?.phase ?? 'missing'}`,
        )
      }
      db.prepare(
        `INSERT INTO restore_operations
          (id, space, note_id, endpoint, actor_digest, idempotency_digest,
           request_fingerprint, stage_binding, phase, source_revision_id,
           target_path, prepared_evidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.space,
        input.noteId,
        input.endpoint,
        input.actorDigest,
        input.idempotencyDigest,
        input.requestFingerprint,
        input.stageBinding,
        RESTORE_OPERATION_PHASE.staged,
        input.sourceRevisionId,
        input.targetPath,
        input.preparedEvidence,
        input.createdAt,
        input.createdAt,
      )
      const operation = restoreOperationOfRow(
        db
          .prepare('SELECT * FROM restore_operations WHERE id = ?')
          .get(input.id) as RestoreOperationRow,
      )
      const pin = db.prepare(
        `INSERT OR IGNORE INTO restore_operation_notes
          (operation_id, space, note_id) VALUES (?, ?, ?)`,
      )

      for (const noteId of new Set(input.protectedNoteIds ?? [input.noteId])) {
        pin.run(input.id, input.space, noteId)
      }
      db.exec('COMMIT')
      return { status: 'accepted', operation }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  get: async (id) => {
    await ctx.ensureInit()
    const row = ctx.required.prepare('SELECT * FROM restore_operations WHERE id = ?').get(id) as
      RestoreOperationRow | undefined
    return row ? restoreOperationOfRow(row) : null
  },
  getByReplay: async (actorDigest, endpoint, idempotencyDigest) => {
    await ctx.ensureInit()
    const row = ctx.required.prepare(byReplay).get(actorDigest, endpoint, idempotencyDigest) as
      RestoreOperationRow | undefined
    return row ? restoreOperationOfRow(row) : null
  },
  transition: async (input) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT * FROM restore_operations WHERE id = ?').get(input.id) as
        RestoreOperationRow | undefined

      if (!row) {
        db.exec('COMMIT')
        return { status: 'missing' }
      }
      const current = restoreOperationOfRow(row)

      if (
        !input.expectedPhases.includes(current.phase) ||
        (input.expectedPreparedEvidence !== undefined &&
          current.preparedEvidence !== input.expectedPreparedEvidence)
      ) {
        db.exec('COMMIT')
        return { status: 'phase-conflict', operation: current }
      }
      db.prepare(
        `UPDATE restore_operations SET
           phase = ?, updated_at = ?, source_revision_id = ?,
           expected_head_revision_id = ?, target_path = ?, prepared_evidence = ?,
           physical_receipt = ?, terminal_result = ?, failure_code = ?
         WHERE id = ?`,
      ).run(
        input.phase,
        input.updatedAt,
        input.sourceRevisionId === undefined ? current.sourceRevisionId : input.sourceRevisionId,
        input.expectedHeadRevisionId === undefined
          ? current.expectedHeadRevisionId
          : input.expectedHeadRevisionId,
        input.targetPath === undefined ? current.targetPath : input.targetPath,
        input.preparedEvidence === undefined ? current.preparedEvidence : input.preparedEvidence,
        input.physicalReceipt === undefined ? current.physicalReceipt : input.physicalReceipt,
        input.terminalResult === undefined ? current.terminalResult : input.terminalResult,
        input.failureCode === undefined ? current.failureCode : input.failureCode,
        input.id,
      )
      const operation = restoreOperationOfRow(
        db
          .prepare('SELECT * FROM restore_operations WHERE id = ?')
          .get(input.id) as RestoreOperationRow,
      )
      db.exec('COMMIT')
      return { status: 'transitioned', operation }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  listRecoverable: async (space) => {
    await ctx.ensureInit()
    const where = space == null ? '' : 'AND space = ?'
    const rows = ctx.required
      .prepare(
        `SELECT * FROM restore_operations
          WHERE phase NOT IN ('succeeded', 'rejected') ${where}
          ORDER BY created_at, id`,
      )
      .all(...(space == null ? [] : [space])) as RestoreOperationRow[]
    return rows.map(restoreOperationOfRow)
  },
})
