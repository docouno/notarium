import {
  canonicalLegacyNameAliases,
  RESTORE_OPERATION_PHASE,
  RESTORE_TERMINAL_CONFLICT,
  type RestoreTerminalPersistence,
  REVISION_INTEGRITY,
  unionLegacyNameAliases,
} from '@notarium/core'

import { restoreOperationOfRow, type RestoreOperationRow } from '../../causalRows'
import {
  assertRestoreTerminalCommitShape,
  parsedTerminalResult,
  RESTORE_TERMINAL_LIFECYCLE_PHASES,
} from '../restoreTerminal'
import type { SqliteDriverCtx } from './context'

type IdentityRow = {
  id: string
  file_path: string
  space: string
  created_at: string | null
  materialized: number
  deleted_at: string | null
  address_revision: number | bigint
  legacy_name_aliases: string | null
  settlement_successor_id: string | null
}

const parsedAliases = (raw: string | null): readonly string[] => {
  try {
    return canonicalLegacyNameAliases(raw == null ? [] : JSON.parse(raw))
  } catch {
    return []
  }
}

type ProofRow = {
  note_id: string
  space: string
  address_revision: number | bigint
  proof_revision: number | bigint
  source_hash: string
  proof_json: string
  receipt_id: string
  updated_at: string
}

export const createRestoreTerminalFacet = (ctx: SqliteDriverCtx): RestoreTerminalPersistence => ({
  init: () => ctx.ensureInit(),
  commit: async (input) => {
    assertRestoreTerminalCommitShape(input)
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const operationRow = db
        .prepare('SELECT * FROM restore_operations WHERE id = ?')
        .get(input.operationId) as RestoreOperationRow | undefined

      if (!operationRow) {
        db.exec('COMMIT')
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
        db.exec('COMMIT')
        return { status: 'replayed', operation, result: parsedTerminalResult(operation) }
      }
      if (operation.phase !== RESTORE_OPERATION_PHASE.physicalPublished) {
        db.exec('COMMIT')
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
        db.exec('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.operationEvidence,
          operation,
        }
      }
      const lifecycle = db
        .prepare('SELECT phase, generation FROM space_lifecycle WHERE space = ?')
        .get(operation.space) as { phase: string; generation: number | bigint } | undefined

      if (!lifecycle || !RESTORE_TERMINAL_LIFECYCLE_PHASES.includes(lifecycle.phase)) {
        db.exec('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.lifecycle,
          operation,
        }
      }
      const source = db
        .prepare(
          `SELECT id FROM note_revisions
            WHERE id = ? AND note_id = ? AND space = ? AND integrity = ?`,
        )
        .get(
          Number(input.sourceRevisionId),
          operation.noteId,
          operation.space,
          REVISION_INTEGRITY.trusted,
        ) as { id: number | bigint } | undefined
      const head = db
        .prepare('SELECT revision_id FROM revision_heads WHERE note_id = ? AND space = ?')
        .get(operation.noteId, operation.space) as { revision_id: number | bigint } | undefined

      if (!source) {
        db.exec('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.operationEvidence,
          operation,
        }
      }
      if (String(head?.revision_id ?? '') !== input.expectedHeadRevisionId) {
        db.exec('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.revisionHead,
          operation,
        }
      }
      const identity = db
        .prepare('SELECT * FROM note_identity WHERE id = ?')
        .get(operation.noteId) as IdentityRow | undefined

      if (
        !identity ||
        identity.space !== operation.space ||
        Number(identity.address_revision) !== input.expectedIdentity.addressRevision ||
        identity.file_path !== input.expectedIdentity.filePath ||
        identity.deleted_at !== input.expectedIdentity.deletedAt
      ) {
        db.exec('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.identity,
          operation,
        }
      }
      const occupied = db
        .prepare(
          `SELECT id FROM note_identity
            WHERE space = ? AND file_path = ? AND deleted_at IS NULL AND id <> ?`,
        )
        .get(operation.space, input.identity.filePath, operation.noteId) as
        { id: string } | undefined

      if (occupied) {
        db.exec('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.targetOccupied,
          operation,
        }
      }
      const proofRow = db
        .prepare('SELECT * FROM note_owner_proofs WHERE note_id = ?')
        .get(operation.noteId) as ProofRow | undefined

      if (
        (proofRow == null ? null : Number(proofRow.proof_revision)) !==
        input.proof.expectedProofRevision
      ) {
        db.exec('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.proof,
          operation,
        }
      }
      const receipt = db
        .prepare('SELECT * FROM owner_proof_receipts WHERE space = ? AND receipt_id = ?')
        .get(operation.space, input.proof.receiptId) as ProofRow | undefined

      if (receipt) {
        db.exec('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.receipt,
          operation,
        }
      }
      const revision = input.revision

      db.prepare('INSERT OR IGNORE INTO revision_blobs (hash, content) VALUES (?, ?)').run(
        revision.contentHash,
        input.content,
      )
      const inserted = db
        .prepare(
          `INSERT INTO note_revisions
             (note_id, space, base_rev, their_rev, source_rev, kind, principal,
              agent_owner, agent_name, session_id, session_name, session_attach,
              content_hash, semantic_fingerprint, restore_safety, state_format,
              title, class, slug, tags, created_at, chars_added, chars_removed,
              entry_role, integrity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision.noteId,
          revision.space,
          Number(revision.baseRevisionId),
          revision.theirRevisionId == null ? null : Number(revision.theirRevisionId),
          Number(revision.sourceRevisionId),
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
          revision.stateFormat ?? null,
          revision.title,
          revision.class,
          revision.slug,
          JSON.stringify(revision.tags),
          revision.createdAt,
          revision.charsAdded,
          revision.charsRemoved,
          revision.entryRole,
          REVISION_INTEGRITY.trusted,
        )
      const addressChanged =
        identity.file_path !== input.identity.filePath ||
        identity.space !== input.identity.space ||
        identity.deleted_at !== input.identity.deletedAt
      const addressRevision = Number(identity.address_revision) + (addressChanged ? 1 : 0)
      const legacyNameAliases = unionLegacyNameAliases(
        parsedAliases(identity.legacy_name_aliases),
        input.identity.legacyNameAliases,
      )

      db.prepare(
        `UPDATE note_identity SET
           file_path = ?, space = ?, created_at = ?, materialized = ?, deleted_at = ?,
           address_revision = ?, legacy_name_aliases = ?, settlement_successor_id = NULL
         WHERE id = ?`,
      ).run(
        input.identity.filePath,
        input.identity.space,
        input.identity.createdAt,
        input.identity.materialized ? 1 : 0,
        input.identity.deletedAt,
        addressRevision,
        JSON.stringify(legacyNameAliases),
        input.identity.id,
      )
      const proofRevision = (proofRow == null ? 0 : Number(proofRow.proof_revision)) + 1

      db.prepare(
        `INSERT INTO note_owner_proofs
          (note_id, space, address_revision, proof_revision, source_hash,
           proof_json, receipt_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET
           space = excluded.space,
           address_revision = excluded.address_revision,
           proof_revision = excluded.proof_revision,
           source_hash = excluded.source_hash,
           proof_json = excluded.proof_json,
           receipt_id = excluded.receipt_id,
           updated_at = excluded.updated_at`,
      ).run(
        operation.noteId,
        operation.space,
        addressRevision,
        proofRevision,
        input.proof.sourceHash,
        input.proof.proofJson,
        input.proof.receiptId,
        input.committedAt,
      )
      db.prepare(
        `INSERT INTO owner_proof_receipts
          (space, receipt_id, note_id, address_revision, proof_revision,
           source_hash, proof_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        operation.space,
        input.proof.receiptId,
        operation.noteId,
        addressRevision,
        proofRevision,
        input.proof.sourceHash,
        input.proof.proofJson,
        input.committedAt,
      )
      const result = {
        ...input.result,
        revisionId: String(inserted.lastInsertRowid),
      }
      db.prepare(
        `UPDATE restore_operations SET
           phase = ?, terminal_result = ?, failure_code = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(
        RESTORE_OPERATION_PHASE.metadataCommitted,
        JSON.stringify(result),
        input.committedAt,
        operation.id,
      )
      const completed = restoreOperationOfRow(
        db
          .prepare('SELECT * FROM restore_operations WHERE id = ?')
          .get(operation.id) as RestoreOperationRow,
      )
      db.exec('COMMIT')
      return { status: 'committed', operation: completed, result }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  finalize: async (input) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db
        .prepare('SELECT * FROM restore_operations WHERE id = ?')
        .get(input.operationId) as RestoreOperationRow | undefined

      if (!row) {
        db.exec('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.operationMissing,
          operation: null,
        }
      }
      const operation = restoreOperationOfRow(row)

      if (operation.phase === RESTORE_OPERATION_PHASE.succeeded) {
        db.exec('COMMIT')
        return { status: 'replayed', operation, result: parsedTerminalResult(operation) }
      }
      if (
        operation.phase !== RESTORE_OPERATION_PHASE.metadataCommitted ||
        operation.preparedEvidence !== input.preparedEvidence ||
        operation.physicalReceipt !== input.physicalReceipt
      ) {
        db.exec('COMMIT')
        return {
          status: 'conflict',
          conflict:
            operation.phase === RESTORE_OPERATION_PHASE.metadataCommitted
              ? RESTORE_TERMINAL_CONFLICT.operationEvidence
              : RESTORE_TERMINAL_CONFLICT.operationPhase,
          operation,
        }
      }
      const lifecycle = db
        .prepare('SELECT generation FROM space_lifecycle WHERE space = ?')
        .get(operation.space) as { generation: number | bigint } | undefined

      if (!lifecycle) {
        db.exec('COMMIT')
        return {
          status: 'conflict',
          conflict: RESTORE_TERMINAL_CONFLICT.lifecycle,
          operation,
        }
      }
      db.prepare(
        `INSERT INTO causal_outbox
          (space, generation, kind, operation_id, resource_id, created_at, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        operation.space,
        Number(lifecycle.generation),
        input.outboxKind,
        operation.id,
        operation.noteId,
        input.finalizedAt,
      )
      db.prepare(
        `UPDATE restore_operations SET phase = ?, failure_code = NULL, updated_at = ? WHERE id = ?`,
      ).run(RESTORE_OPERATION_PHASE.succeeded, input.finalizedAt, operation.id)
      const completed = restoreOperationOfRow(
        db
          .prepare('SELECT * FROM restore_operations WHERE id = ?')
          .get(operation.id) as RestoreOperationRow,
      )
      db.exec('COMMIT')
      return { status: 'committed', operation: completed, result: parsedTerminalResult(completed) }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
})
