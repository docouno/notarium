import {
  CAUSAL_BARRIER_KIND,
  RESTORE_OPERATION_PHASE,
  type RestoreOperationPersistence,
  SPACE_LIFECYCLE_PHASE,
} from '@notarium/core'

import { restoreOperationOfRow, type RestoreOperationRow } from '../../causalRows'
import { lockCausalBarriers } from './causalBarriers'
import type { PgDriverCtx } from './context'
import { lockRestoreOperationRow, lockRestoreParentRow, lockSpaceLifecycleRow } from './lockOrder'
import { lockRevisionKeys } from './revisionLocks'

export const createRestoreOperationsFacet = (ctx: PgDriverCtx): RestoreOperationPersistence => ({
  init: () => ctx.ensureInit(),
  accept: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const protectedNoteIds = [...new Set(input.protectedNoteIds ?? [input.noteId])].sort()
      await lockCausalBarriers(
        client,
        [
          {
            kind: CAUSAL_BARRIER_KIND.spaceLifecycle,
            space: input.space,
            key: input.space,
          },
          {
            kind: CAUSAL_BARRIER_KIND.operation,
            space: input.space,
            key: `${input.actorDigest}:${input.endpoint}:${input.idempotencyDigest}`,
          },
        ],
        (kind) => (kind === CAUSAL_BARRIER_KIND.spaceLifecycle ? 'shared' : 'exclusive'),
      )
      await lockRevisionKeys(client, 'note', protectedNoteIds)
      const replayResult = await client.query(
        `SELECT * FROM restore_operations
          WHERE actor_digest = $1 AND endpoint = $2 AND idempotency_digest = $3`,
        [input.actorDigest, input.endpoint, input.idempotencyDigest],
      )
      const replay = replayResult.rows[0] as RestoreOperationRow | undefined

      if (replay) {
        const operation = restoreOperationOfRow(replay)
        await client.query('COMMIT')
        return operation.requestFingerprint === input.requestFingerprint
          ? { status: 'replayed', operation }
          : { status: 'idempotency-conflict', operation }
      }
      const lifecycle = await lockSpaceLifecycleRow<{ phase: string }>(client, input.space, 'share')
      const phase = lifecycle?.phase
      const parent = input.parentOperationId
        ? await lockRestoreParentRow(client, input.parentOperationId, input.space)
        : false

      if (
        (input.parentOperationId && !parent) ||
        (!input.parentOperationId && phase !== SPACE_LIFECYCLE_PHASE.active)
      ) {
        throw new Error(`space lifecycle rejects restore admission: ${phase ?? 'missing'}`)
      }
      const inserted = await client.query(
        `INSERT INTO restore_operations
          (id, space, note_id, endpoint, actor_digest, idempotency_digest,
           request_fingerprint, stage_binding, phase, source_revision_id,
           target_path, prepared_evidence, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
         RETURNING *`,
        [
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
        ],
      )
      const operation = restoreOperationOfRow(inserted.rows[0] as RestoreOperationRow)
      await client.query(
        `INSERT INTO restore_operation_notes (operation_id, space, note_id)
         SELECT $1, $2, value FROM unnest($3::text[]) AS input(value)
         ON CONFLICT (operation_id, note_id) DO NOTHING`,
        [input.id, input.space, protectedNoteIds],
      )
      await client.query('COMMIT')
      return { status: 'accepted', operation }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  get: async (id) => {
    await ctx.ensureInit()
    const result = await ctx.required.query('SELECT * FROM restore_operations WHERE id = $1', [id])
    const row = result.rows[0] as RestoreOperationRow | undefined
    return row ? restoreOperationOfRow(row) : null
  },
  getByReplay: async (actorDigest, endpoint, idempotencyDigest) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT * FROM restore_operations
        WHERE actor_digest = $1 AND endpoint = $2 AND idempotency_digest = $3`,
      [actorDigest, endpoint, idempotencyDigest],
    )
    const row = result.rows[0] as RestoreOperationRow | undefined
    return row ? restoreOperationOfRow(row) : null
  },
  transition: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const lookup = await client.query('SELECT space FROM restore_operations WHERE id = $1', [
        input.id,
      ])
      const space = lookup.rows[0]?.space as string | undefined

      if (!space) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      await lockCausalBarriers(
        client,
        [
          { kind: CAUSAL_BARRIER_KIND.spaceLifecycle, space, key: space },
          { kind: CAUSAL_BARRIER_KIND.operation, space, key: input.id },
        ],
        (kind) => (kind === CAUSAL_BARRIER_KIND.spaceLifecycle ? 'shared' : 'exclusive'),
      )
      const row = await lockRestoreOperationRow<RestoreOperationRow>(client, input.id)

      if (!row) {
        await client.query('COMMIT')
        return { status: 'missing' }
      }
      const current = restoreOperationOfRow(row)

      if (
        !input.expectedPhases.includes(current.phase) ||
        (input.expectedPreparedEvidence !== undefined &&
          current.preparedEvidence !== input.expectedPreparedEvidence)
      ) {
        await client.query('COMMIT')
        return { status: 'phase-conflict', operation: current }
      }
      const updated = await client.query(
        `UPDATE restore_operations SET
           phase = $2, updated_at = $3, source_revision_id = $4,
           expected_head_revision_id = $5, target_path = $6, prepared_evidence = $7,
           physical_receipt = $8, terminal_result = $9, failure_code = $10
         WHERE id = $1
         RETURNING *`,
        [
          input.id,
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
        ],
      )
      const operation = restoreOperationOfRow(updated.rows[0] as RestoreOperationRow)
      await client.query('COMMIT')
      return { status: 'transitioned', operation }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  listRecoverable: async (space) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT * FROM restore_operations
        WHERE phase NOT IN ('succeeded', 'rejected')
          AND ($1::text IS NULL OR space = $1)
        ORDER BY created_at, id`,
      [space ?? null],
    )
    return (result.rows as RestoreOperationRow[]).map(restoreOperationOfRow)
  },
})
