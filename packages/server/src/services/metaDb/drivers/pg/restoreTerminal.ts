import { Buffer } from 'node:buffer'

import {
  CAUSAL_BARRIER_KIND,
  DOCUMENT_STATE_FORMAT,
  LOGICAL_NOTE_STATE_FORMAT,
  RESTORE_OPERATION_PHASE,
  RESTORE_TERMINAL_CONFLICT,
  type RestoreTerminalPersistence,
  REVISION_INTEGRITY,
} from '@notarium/core'

import { restoreOperationOfRow, type RestoreOperationRow } from '../../causalRows'
import {
  assertRestoreTerminalCommitShape,
  parsedTerminalResult,
  RESTORE_TERMINAL_LIFECYCLE_PHASES,
} from '../restoreTerminal'
import { lockCausalBarriers } from './causalBarriers'
import type { PgDriverCtx } from './context'
import {
  lockIdentityRows,
  lockOwnerProofRow,
  lockRestoreOperationRow,
  lockSpaceLifecycleRow,
  readLiveIdentityAtPaths,
} from './lockOrder'
import { lockRevisionKeys } from './revisionLocks'

type ProofRow = {
  note_id: string
  space: string
  address_revision: string | number
  proof_revision: string | number
  source_hash: string
  proof_json: string
  receipt_id: string
  updated_at: string
}

export const createRestoreTerminalFacet = (ctx: PgDriverCtx): RestoreTerminalPersistence => ({
  init: () => ctx.ensureInit(),
  commit: async (input) => {
    assertRestoreTerminalCommitShape(input)
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const lookup = await client.query(
        'SELECT space, note_id FROM restore_operations WHERE id = $1',
        [input.operationId],
      )
      const lookupRow = lookup.rows[0] as { space: string; note_id: string } | undefined

      if (!lookupRow) {
        await client.query('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.operationMissing,
          operation: null,
        }
      }
      const probedOccupants = await readLiveIdentityAtPaths(client, [
        { space: lookupRow.space, filePath: input.identity.filePath },
      ])
      const identityHold = await lockIdentityRows(client, [
        lookupRow.note_id,
        ...probedOccupants.map((row) => row.id),
      ])
      const declaredIdentityIds = new Set(identityHold.lock.declared)
      const identity = identityHold.rows.find((row) => row.id === lookupRow.note_id)
      const occupied = (
        await readLiveIdentityAtPaths(client, [
          { space: lookupRow.space, filePath: input.identity.filePath },
        ])
      ).filter((row) => row.id !== lookupRow.note_id)

      if (occupied.some((row) => !declaredIdentityIds.has(row.id))) {
        await client.query('ROLLBACK')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.targetOccupied,
          operation: null,
        }
      }
      await lockCausalBarriers(
        client,
        [
          {
            kind: CAUSAL_BARRIER_KIND.installationGeneration,
            space: null,
            key: 'active',
          },
          {
            kind: CAUSAL_BARRIER_KIND.spaceLifecycle,
            space: lookupRow.space,
            key: lookupRow.space,
          },
          { kind: CAUSAL_BARRIER_KIND.note, space: lookupRow.space, key: lookupRow.note_id },
          {
            kind: CAUSAL_BARRIER_KIND.address,
            space: lookupRow.space,
            key: lookupRow.note_id,
          },
          {
            kind: CAUSAL_BARRIER_KIND.address,
            space: lookupRow.space,
            key: input.targetPath,
          },
          {
            kind: CAUSAL_BARRIER_KIND.ownerProof,
            space: lookupRow.space,
            key: lookupRow.note_id,
          },
          {
            kind: CAUSAL_BARRIER_KIND.operation,
            space: lookupRow.space,
            key: input.operationId,
          },
          {
            kind: CAUSAL_BARRIER_KIND.blob,
            space: lookupRow.space,
            key: input.revision.contentHash!,
          },
          {
            kind: CAUSAL_BARRIER_KIND.outbox,
            space: lookupRow.space,
            key: `${input.outboxKind}:${lookupRow.note_id}`,
          },
        ],
        (kind) =>
          kind === CAUSAL_BARRIER_KIND.installationGeneration ||
          kind === CAUSAL_BARRIER_KIND.spaceLifecycle
            ? 'shared'
            : 'exclusive',
      )
      const operationRow = await lockRestoreOperationRow<RestoreOperationRow>(
        client,
        input.operationId,
      )

      if (!operationRow) {
        await client.query('ROLLBACK')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.operationMissing,
          operation: null,
        }
      }
      const operation = restoreOperationOfRow(operationRow)

      if (
        operation.phase === RESTORE_OPERATION_PHASE.metadataCommitted ||
        operation.phase === RESTORE_OPERATION_PHASE.succeeded
      ) {
        await client.query('ROLLBACK')
        return { status: 'replayed', operation, result: parsedTerminalResult(operation) }
      }
      if (operation.phase !== RESTORE_OPERATION_PHASE.physicalPublished) {
        await client.query('ROLLBACK')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.operationPhase,
          operation,
        }
      }
      if (
        operation.space !== input.revision.space ||
        operation.noteId !== input.revision.noteId ||
        operation.sourceRevisionId !== input.sourceRevisionId ||
        operation.expectedHeadRevisionId !== input.expectedHeadRevisionId ||
        operation.targetPath !== input.targetPath ||
        operation.preparedEvidence !== input.preparedEvidence ||
        operation.physicalReceipt !== input.physicalReceipt
      ) {
        await client.query('ROLLBACK')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.operationEvidence,
          operation,
        }
      }
      const lifecycle = await lockSpaceLifecycleRow<{
        phase: string
        generation: string | number
      }>(client, operation.space, 'share')

      if (!lifecycle || !RESTORE_TERMINAL_LIFECYCLE_PHASES.includes(lifecycle.phase)) {
        await client.query('ROLLBACK')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.lifecycle,
          operation,
        }
      }
      if (
        !identity ||
        identity.space !== operation.space ||
        Number(identity.address_revision) !== input.expectedIdentity.addressRevision ||
        identity.file_path !== input.expectedIdentity.filePath ||
        identity.deleted_at !== input.expectedIdentity.deletedAt
      ) {
        await client.query('ROLLBACK')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.identity,
          operation,
        }
      }
      if (occupied.length) {
        await client.query('ROLLBACK')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.targetOccupied,
          operation,
        }
      }
      const proofRow = await lockOwnerProofRow<ProofRow>(client, operation.noteId)

      if (
        (proofRow == null ? null : Number(proofRow.proof_revision)) !==
        input.proof.expectedProofRevision
      ) {
        await client.query('ROLLBACK')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.proof,
          operation,
        }
      }
      const receipt = await client.query(
        'SELECT * FROM owner_proof_receipts WHERE space = $1 AND receipt_id = $2',
        [operation.space, input.proof.receiptId],
      )

      if (receipt.rows.length) {
        await client.query('ROLLBACK')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.receipt,
          operation,
        }
      }
      const addressChanged =
        identity.file_path !== input.identity.filePath ||
        identity.space !== input.identity.space ||
        identity.deleted_at !== input.identity.deletedAt
      const addressRevision = Number(identity.address_revision) + (addressChanged ? 1 : 0)

      // Finish every tier-1 write while the transaction is still at tier 1. The
      // source/head checks below may still reject the restore, but rollback then
      // restores this row together with all later journal/proof writes.
      await client.query(
        `UPDATE note_identity SET
           file_path = $2, space = $3, created_at = $4, materialized = $5,
           deleted_at = $6, address_revision = $7
         WHERE id = $1`,
        [
          input.identity.id,
          input.identity.filePath,
          input.identity.space,
          input.identity.createdAt,
          input.identity.materialized,
          input.identity.deletedAt,
          addressRevision,
        ],
      )
      // Match ordinary revision writers: CAS bytes are inserted before any
      // advisory revision lock, then reasserted under the legacy blob-GC lock.
      await client.query(
        'INSERT INTO revision_blobs (hash, content) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING',
        [
          input.revision.contentHash,
          typeof input.content === 'string'
            ? Buffer.from(input.content, 'utf8')
            : Buffer.from(input.content),
        ],
      )
      await lockRevisionKeys(client, 'space', [lookupRow.space], 'shared')
      await lockRevisionKeys(client, 'note', [lookupRow.note_id])
      await lockRevisionKeys(client, 'blob', [input.revision.contentHash!])
      await client.query(
        'INSERT INTO revision_blobs (hash, content) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING',
        [
          input.revision.contentHash,
          typeof input.content === 'string'
            ? Buffer.from(input.content, 'utf8')
            : Buffer.from(input.content),
        ],
      )
      const sourceResult = await client.query(
        `SELECT id FROM note_revisions
          WHERE id = $1 AND note_id = $2 AND space = $3 AND integrity = $4`,
        [input.sourceRevisionId, operation.noteId, operation.space, REVISION_INTEGRITY.trusted],
      )
      const headResult = await client.query(
        'SELECT revision_id FROM revision_heads WHERE note_id = $1 AND space = $2',
        [operation.noteId, operation.space],
      )

      if (!sourceResult.rows.length) {
        await client.query('ROLLBACK')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.operationEvidence,
          operation,
        }
      }
      if (String(headResult.rows[0]?.revision_id ?? '') !== input.expectedHeadRevisionId) {
        await client.query('ROLLBACK')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.revisionHead,
          operation,
        }
      }
      const revision = input.revision
      const inserted = await client.query(
        `INSERT INTO note_revisions
           (note_id, space, base_rev, their_rev, source_rev, kind, principal,
            agent_owner, agent_name, session_id, session_name, session_attach,
            content_hash, semantic_fingerprint, restore_safety, snapshot_format, document_format,
            title, class, slug, tags, created_at, chars_added, chars_removed,
            entry_role, integrity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
         RETURNING id`,
        [
          revision.noteId,
          revision.space,
          revision.baseRevisionId,
          revision.theirRevisionId,
          revision.sourceRevisionId,
          revision.kind,
          revision.principal,
          revision.agent?.owner ?? null,
          revision.agent?.agent ?? null,
          revision.agent?.session?.id ?? null,
          revision.agent?.session?.name ?? null,
          revision.agent?.session?.attach ?? null,
          revision.contentHash,
          revision.semanticFingerprint ?? null,
          revision.restoreSafety ?? null,
          revision.stateFormat === LOGICAL_NOTE_STATE_FORMAT ? revision.stateFormat : null,
          revision.stateFormat === DOCUMENT_STATE_FORMAT.markdown ||
          revision.stateFormat === DOCUMENT_STATE_FORMAT.skill ||
          revision.stateFormat === DOCUMENT_STATE_FORMAT.opaque
            ? revision.stateFormat
            : null,
          revision.title,
          revision.class,
          revision.slug,
          JSON.stringify(revision.tags),
          revision.createdAt,
          revision.charsAdded,
          revision.charsRemoved,
          revision.entryRole,
          REVISION_INTEGRITY.trusted,
        ],
      )
      const proofRevision = (proofRow == null ? 0 : Number(proofRow.proof_revision)) + 1

      await client.query(
        `INSERT INTO note_owner_proofs
          (note_id, space, address_revision, proof_revision, source_hash,
           proof_json, receipt_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (note_id) DO UPDATE SET
           space = EXCLUDED.space,
           address_revision = EXCLUDED.address_revision,
           proof_revision = EXCLUDED.proof_revision,
           source_hash = EXCLUDED.source_hash,
           proof_json = EXCLUDED.proof_json,
           receipt_id = EXCLUDED.receipt_id,
           updated_at = EXCLUDED.updated_at`,
        [
          operation.noteId,
          operation.space,
          addressRevision,
          proofRevision,
          input.proof.sourceHash,
          input.proof.proofJson,
          input.proof.receiptId,
          input.committedAt,
        ],
      )
      await client.query(
        `INSERT INTO owner_proof_receipts
          (space, receipt_id, note_id, address_revision, proof_revision,
           source_hash, proof_json, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          operation.space,
          input.proof.receiptId,
          operation.noteId,
          addressRevision,
          proofRevision,
          input.proof.sourceHash,
          input.proof.proofJson,
          input.committedAt,
        ],
      )
      const result = { ...input.result, revisionId: String(inserted.rows[0].id) }

      const completedResult = await client.query(
        `UPDATE restore_operations SET
           phase = $2, terminal_result = $3, failure_code = NULL, updated_at = $4
         WHERE id = $1
         RETURNING *`,
        [
          operation.id,
          RESTORE_OPERATION_PHASE.metadataCommitted,
          JSON.stringify(result),
          input.committedAt,
        ],
      )
      const completed = restoreOperationOfRow(completedResult.rows[0] as RestoreOperationRow)
      await client.query('COMMIT')
      return { status: 'committed', operation: completed, result }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  finalize: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const lookup = await client.query(
        'SELECT space, note_id FROM restore_operations WHERE id = $1',
        [input.operationId],
      )
      const lookupRow = lookup.rows[0] as { space: string; note_id: string } | undefined

      if (!lookupRow) {
        await client.query('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.operationMissing,
          operation: null,
        }
      }
      await lockCausalBarriers(
        client,
        [
          {
            kind: CAUSAL_BARRIER_KIND.spaceLifecycle,
            space: lookupRow.space,
            key: lookupRow.space,
          },
          {
            kind: CAUSAL_BARRIER_KIND.operation,
            space: lookupRow.space,
            key: input.operationId,
          },
          {
            kind: CAUSAL_BARRIER_KIND.outbox,
            space: lookupRow.space,
            key: `${input.outboxKind}:${lookupRow.note_id}`,
          },
        ],
        (kind) => (kind === CAUSAL_BARRIER_KIND.spaceLifecycle ? 'shared' : 'exclusive'),
      )
      const row = await lockRestoreOperationRow<RestoreOperationRow>(client, input.operationId)

      if (!row) {
        await client.query('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.operationMissing,
          operation: null,
        }
      }
      const operation = restoreOperationOfRow(row)

      if (operation.phase === RESTORE_OPERATION_PHASE.succeeded) {
        await client.query('COMMIT')
        return { status: 'replayed', operation, result: parsedTerminalResult(operation) }
      }
      if (
        operation.phase !== RESTORE_OPERATION_PHASE.metadataCommitted ||
        operation.preparedEvidence !== input.preparedEvidence ||
        operation.physicalReceipt !== input.physicalReceipt
      ) {
        await client.query('COMMIT')
        return {
          status: 'conflict',
          conflict:
            operation.phase === RESTORE_OPERATION_PHASE.metadataCommitted
              ? RESTORE_TERMINAL_CONFLICT.operationEvidence
              : RESTORE_TERMINAL_CONFLICT.operationPhase,
          operation,
        }
      }
      const lifecycle = await lockSpaceLifecycleRow<{ generation: string | number }>(
        client,
        operation.space,
        'share',
      )
      const generation = lifecycle?.generation

      if (generation == null) {
        await client.query('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.lifecycle,
          operation,
        }
      }
      await client.query(
        `INSERT INTO causal_outbox
          (space, generation, kind, operation_id, resource_id, created_at, acknowledged_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
        [
          operation.space,
          Number(generation),
          input.outboxKind,
          operation.id,
          operation.noteId,
          input.finalizedAt,
        ],
      )
      const completedResult = await client.query(
        `UPDATE restore_operations SET phase = $2, failure_code = NULL, updated_at = $3
          WHERE id = $1 RETURNING *`,
        [operation.id, RESTORE_OPERATION_PHASE.succeeded, input.finalizedAt],
      )
      const completed = restoreOperationOfRow(completedResult.rows[0] as RestoreOperationRow)
      await client.query('COMMIT')
      return { status: 'committed', operation: completed, result: parsedTerminalResult(completed) }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
