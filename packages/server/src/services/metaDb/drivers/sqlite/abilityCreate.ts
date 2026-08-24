import { ABILITY_AVAILABILITY_MODE } from '@notarium/contract'
import {
  DOCUMENT_STATE_FORMAT,
  LOGICAL_NOTE_STATE_FORMAT,
  REVISION_INTEGRITY,
  SPACE_LIFECYCLE_PHASE,
} from '@notarium/core'

import { abilityCreateOperationOfRow, type AbilityCreateOperationRow } from '../../causalRows'
import {
  ABILITY_CREATE_PHASE,
  type AbilityAvailability,
  type AbilityCreateOperationRecord,
  type AbilityCreatePersistence,
  type AbilityCreateTerminalResult,
} from '../../types'
import { assertAbilityTargetLive } from './abilityLifecycle'
import type { SqliteDriverCtx } from './context'

const operation = (
  db: SqliteDriverCtx['required'],
  id: string,
): AbilityCreateOperationRecord | null => {
  const row = db.prepare('SELECT * FROM ability_create_operations WHERE id = ?').get(id) as
    AbilityCreateOperationRow | undefined

  return row ? abilityCreateOperationOfRow(row) : null
}

const resultOf = (record: AbilityCreateOperationRecord): AbilityCreateTerminalResult => {
  const parsed = record.terminalResult ? (JSON.parse(record.terminalResult) as unknown) : null

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as AbilityCreateTerminalResult).packageId !== 'string' ||
    typeof (parsed as AbilityCreateTerminalResult).noteId !== 'string' ||
    typeof (parsed as AbilityCreateTerminalResult).versionToken !== 'string' ||
    typeof (parsed as AbilityCreateTerminalResult).revisionId !== 'string'
  ) {
    throw new Error(`ability create operation ${record.id} has no valid terminal result`)
  }

  return parsed as AbilityCreateTerminalResult
}

const projectIdsOf = (availability: AbilityAvailability | null): string[] =>
  availability?.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
    ? [...new Set(availability.projectIds)].sort()
    : []

const assertProjects = (
  db: SqliteDriverCtx['required'],
  homeSpace: string,
  projectIds: readonly string[],
): void => {
  if (!projectIds.length) {
    return
  }
  const placeholders = projectIds.map(() => '?').join(', ')
  const found = new Set(
    (
      db
        .prepare(
          `SELECT id FROM folders
            WHERE type = 'project' AND space = ? AND id IN (${placeholders})`,
        )
        .all(homeSpace, ...projectIds) as Array<{ id: string }>
    ).map(({ id }) => id),
  )

  if (projectIds.some((id) => !found.has(id))) {
    throw new Error('ability create availability contains a missing or foreign project')
  }
}

export const createAbilityCreateFacet = (ctx: SqliteDriverCtx): AbilityCreatePersistence => ({
  findReplay: async (input) => {
    await ctx.ensureInit()
    const replay = ctx.required
      .prepare(
        `SELECT * FROM ability_create_operations
          WHERE actor_digest = ? AND idempotency_digest = ? AND phase <> 'rejected'`,
      )
      .get(input.actorDigest, input.idempotencyDigest) as AbilityCreateOperationRow | undefined

    if (!replay) {
      return { status: 'missing' }
    }
    const current = abilityCreateOperationOfRow(replay)

    return current.requestFingerprint === input.requestFingerprint
      ? { status: 'replayed', operation: current }
      : { status: 'idempotency-conflict', operation: current }
  },

  accept: async (input) => {
    await ctx.ensureInit()
    const db = ctx.required
    const projectIds = projectIdsOf(input.availability)

    if (input.availabilityRequired !== (input.availability != null)) {
      throw new Error('ability create availability evidence is inconsistent')
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      if (input.idempotencyDigest) {
        const replay = db
          .prepare(
            `SELECT * FROM ability_create_operations
              WHERE actor_digest = ? AND idempotency_digest = ? AND phase <> 'rejected'`,
          )
          .get(input.actorDigest, input.idempotencyDigest) as AbilityCreateOperationRow | undefined

        if (replay) {
          const current = abilityCreateOperationOfRow(replay)
          db.exec('COMMIT')
          return current.requestFingerprint === input.requestFingerprint
            ? { status: 'replayed' as const, operation: current }
            : { status: 'idempotency-conflict' as const, operation: current }
        }
      }
      assertAbilityTargetLive(db, input.space, null)
      const idOwner = db.prepare('SELECT 1 FROM note_identity WHERE id = ?').get(input.noteId)

      if (idOwner) {
        db.exec('COMMIT')
        return { status: 'identity-conflict' as const }
      }
      const pathOwner = db
        .prepare(
          `SELECT 1 FROM note_identity
            WHERE space = ? AND file_path = ? AND deleted_at IS NULL`,
        )
        .get(input.space, input.targetPath)

      if (pathOwner) {
        db.exec('COMMIT')
        return { status: 'path-conflict' as const }
      }
      const packageOwner = db
        .prepare('SELECT 1 FROM ability_create_operations WHERE space = ? AND package_id = ?')
        .get(input.space, input.packageId)

      if (packageOwner) {
        db.exec('COMMIT')
        return { status: 'package-conflict' as const }
      }
      db.prepare(
        `INSERT INTO note_identity
          (id, file_path, created_at, materialized, deleted_at, space,
           address_revision, legacy_name_aliases, settlement_successor_id)
         VALUES (?, ?, ?, 0, NULL, ?, 1, '[]', NULL)`,
      ).run(input.noteId, input.targetPath, input.identity.createdAt, input.space)
      if (input.availability) {
        assertProjects(db, input.space, projectIds)
        db.prepare(
          `INSERT INTO ability_availability
            (home_space, package_id, mode, registry_note_id)
           VALUES (?, ?, ?, NULL)`,
        ).run(input.space, input.packageId, input.availability.mode)
        const bind = db.prepare(
          `INSERT INTO ability_project_bindings
            (home_space, package_id, project_id) VALUES (?, ?, ?)`,
        )

        for (const projectId of projectIds) {
          bind.run(input.space, input.packageId, projectId)
        }
      }
      db.prepare(
        `INSERT INTO ability_create_operations
          (id, actor_digest, idempotency_digest, request_fingerprint, space,
           package_id, note_id, target_path, availability_required, stage_binding,
           phase, prepared_evidence, physical_receipt, terminal_result, failure_code,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      ).run(
        input.id,
        input.actorDigest,
        input.idempotencyDigest,
        input.requestFingerprint,
        input.space,
        input.packageId,
        input.noteId,
        input.targetPath,
        input.availabilityRequired ? 1 : 0,
        input.stageBinding,
        ABILITY_CREATE_PHASE.accepted,
        input.preparedEvidence,
        input.createdAt,
        input.createdAt,
      )
      const accepted = operation(db, input.id)!
      db.exec('COMMIT')
      return { status: 'accepted' as const, operation: accepted }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },

  get: async (id) => {
    await ctx.ensureInit()
    return operation(ctx.required, id)
  },

  listRecoverable: async () => {
    await ctx.ensureInit()
    return (
      ctx.required
        .prepare(
          `SELECT * FROM ability_create_operations
            WHERE phase NOT IN ('succeeded', 'rejected')
            ORDER BY created_at, id`,
        )
        .all() as AbilityCreateOperationRow[]
    ).map(abilityCreateOperationOfRow)
  },

  markPhysical: async (id, preparedEvidence, physicalReceipt, updatedAt) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `UPDATE ability_create_operations
            SET phase = ?, physical_receipt = ?, failure_code = NULL, updated_at = ?
          WHERE id = ? AND prepared_evidence = ?
            AND phase IN ('accepted', 'failed-recoverable')`,
      )
      .run(ABILITY_CREATE_PHASE.physicalPublished, physicalReceipt, updatedAt, id, preparedEvidence)
    return operation(ctx.required, id)
  },

  markRecoverable: async (id, failureCode, updatedAt) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `UPDATE ability_create_operations
            SET phase = ?, failure_code = ?, updated_at = ?
          WHERE id = ? AND phase IN ('accepted', 'physical-published', 'failed-recoverable')`,
      )
      .run(ABILITY_CREATE_PHASE.failedRecoverable, failureCode, updatedAt, id)
    return operation(ctx.required, id)
  },

  reject: async (id, failureCode, updatedAt) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = operation(db, id)

      if (!current) {
        db.exec('COMMIT')
        return null
      }
      if (
        current.phase === ABILITY_CREATE_PHASE.metadataCommitted ||
        current.phase === ABILITY_CREATE_PHASE.succeeded
      ) {
        db.exec('COMMIT')
        return current
      }
      if (current.physicalReceipt) {
        throw new Error('a physically published ability create cannot be rejected')
      }
      db.prepare(
        `DELETE FROM ability_availability
          WHERE home_space = ? AND package_id = ? AND registry_note_id IS NULL`,
      ).run(current.space, current.packageId)
      db.prepare(
        `DELETE FROM note_identity
          WHERE id = ? AND space = ? AND file_path = ? AND materialized = 0
            AND NOT EXISTS (SELECT 1 FROM note_revisions WHERE note_id = ? AND space = ?)`,
      ).run(current.noteId, current.space, current.targetPath, current.noteId, current.space)
      db.prepare(
        `UPDATE ability_create_operations
            SET phase = ?, failure_code = ?, updated_at = ? WHERE id = ?`,
      ).run(ABILITY_CREATE_PHASE.rejected, failureCode, updatedAt, id)
      const rejected = operation(db, id)
      db.exec('COMMIT')
      return rejected
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },

  commit: async (input) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = operation(db, input.operationId)

      if (!current) {
        db.exec('COMMIT')
        return { status: 'conflict' as const, operation: null }
      }
      if (
        current.phase === ABILITY_CREATE_PHASE.metadataCommitted ||
        current.phase === ABILITY_CREATE_PHASE.succeeded
      ) {
        const result = resultOf(current)
        db.exec('COMMIT')
        return { status: 'replayed' as const, operation: current, result }
      }
      if (
        current.phase !== ABILITY_CREATE_PHASE.physicalPublished ||
        current.preparedEvidence !== input.preparedEvidence ||
        current.physicalReceipt !== input.physicalReceipt ||
        current.noteId !== input.identity.id ||
        current.targetPath !== input.identity.filePath ||
        current.space !== input.identity.space ||
        current.packageId !== input.result.packageId ||
        current.noteId !== input.result.noteId ||
        input.identity.materialized !== true ||
        input.identity.deletedAt !== null ||
        input.revision.noteId !== current.noteId ||
        input.revision.space !== current.space ||
        input.revision.kind !== 'write' ||
        input.revision.entryRole !== 'origin'
      ) {
        db.exec('COMMIT')
        return { status: 'conflict' as const, operation: current }
      }
      const lifecycle = db
        .prepare('SELECT phase, generation FROM space_lifecycle WHERE space = ?')
        .get(current.space) as { phase: string; generation: number | bigint } | undefined

      if (
        !lifecycle ||
        (lifecycle.phase !== SPACE_LIFECYCLE_PHASE.active &&
          lifecycle.phase !== SPACE_LIFECYCLE_PHASE.closing)
      ) {
        db.exec('COMMIT')
        return { status: 'conflict' as const, operation: current }
      }
      const identity = db
        .prepare(
          `SELECT id, file_path, space, materialized, deleted_at
             FROM note_identity WHERE id = ?`,
        )
        .get(current.noteId) as
        | {
            id: string
            file_path: string
            space: string
            materialized: number
            deleted_at: string | null
          }
        | undefined
      const head = db
        .prepare('SELECT 1 FROM revision_heads WHERE space = ? AND note_id = ?')
        .get(current.space, current.noteId)

      if (
        !identity ||
        identity.space !== current.space ||
        identity.file_path !== current.targetPath ||
        identity.materialized !== 0 ||
        identity.deleted_at !== null ||
        head
      ) {
        db.exec('COMMIT')
        return { status: 'conflict' as const, operation: current }
      }
      const availability = db
        .prepare(
          `SELECT registry_note_id FROM ability_availability
            WHERE home_space = ? AND package_id = ?`,
        )
        .get(current.space, current.packageId) as { registry_note_id: string | null } | undefined

      if (
        (current.availabilityRequired && availability?.registry_note_id !== null) ||
        (!current.availabilityRequired && availability)
      ) {
        db.exec('COMMIT')
        return { status: 'conflict' as const, operation: current }
      }
      db.prepare('INSERT OR IGNORE INTO revision_blobs (hash, content) VALUES (?, ?)').run(
        input.revision.contentHash,
        input.content,
      )
      const revision = input.revision
      const inserted = db
        .prepare(
          `INSERT INTO note_revisions
             (note_id, space, base_rev, their_rev, source_rev, kind, principal,
              agent_owner, agent_name, session_id, session_name, session_attach,
              content_hash, semantic_fingerprint, restore_safety, snapshot_format, document_format,
              title, class, slug, tags, created_at, chars_added, chars_removed,
              entry_role, integrity)
           VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision.noteId,
          revision.space,
          revision.kind,
          revision.principal,
          revision.agent?.owner ?? null,
          revision.agent?.agent ?? null,
          revision.agent?.session?.id ?? null,
          revision.agent?.session?.name ?? null,
          revision.agent?.session?.attach ?? null,
          revision.contentHash,
          revision.semanticFingerprint,
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
        )
      db.prepare(
        `UPDATE note_identity
            SET materialized = 1, created_at = ?, legacy_name_aliases = ?
          WHERE id = ? AND materialized = 0`,
      ).run(
        input.identity.createdAt,
        JSON.stringify(input.identity.legacyNameAliases),
        current.noteId,
      )
      db.prepare(
        `INSERT INTO note_owner_proofs
          (note_id, space, address_revision, proof_revision, source_hash,
           proof_json, receipt_id, updated_at)
         VALUES (?, ?, 1, 1, ?, ?, ?, ?)`,
      ).run(
        current.noteId,
        current.space,
        input.ownerProof.sourceHash,
        input.ownerProof.proofJson,
        input.ownerProof.receiptId,
        input.committedAt,
      )
      db.prepare(
        `INSERT INTO owner_proof_receipts
          (space, receipt_id, note_id, address_revision, proof_revision,
           source_hash, proof_json, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?, ?)`,
      ).run(
        current.space,
        input.ownerProof.receiptId,
        current.noteId,
        input.ownerProof.sourceHash,
        input.ownerProof.proofJson,
        input.committedAt,
      )
      if (current.availabilityRequired) {
        const updated = db
          .prepare(
            `UPDATE ability_availability SET registry_note_id = ?
              WHERE home_space = ? AND package_id = ? AND registry_note_id IS NULL`,
          )
          .run(current.noteId, current.space, current.packageId).changes

        if (updated !== 1) {
          throw new Error('ability create availability reservation changed before commit')
        }
      }
      const result = {
        ...input.result,
        revisionId: String(inserted.lastInsertRowid),
      }
      db.prepare(
        `INSERT INTO causal_outbox
          (space, generation, kind, operation_id, resource_id, created_at, acknowledged_at)
         VALUES (?, ?, 'ability-create-committed', ?, ?, ?, NULL)`,
      ).run(
        current.space,
        Number(lifecycle.generation),
        current.id,
        current.noteId,
        input.committedAt,
      )
      db.prepare(
        `UPDATE ability_create_operations
            SET phase = ?, terminal_result = ?, failure_code = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(
        ABILITY_CREATE_PHASE.metadataCommitted,
        JSON.stringify(result),
        input.committedAt,
        current.id,
      )
      const committed = operation(db, current.id)!
      db.exec('COMMIT')
      return { status: 'committed' as const, operation: committed, result }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },

  finalize: async (id, preparedEvidence, physicalReceipt, updatedAt) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = operation(db, id)

      if (!current) {
        db.exec('COMMIT')
        return null
      }
      if (current.phase === ABILITY_CREATE_PHASE.succeeded) {
        db.exec('COMMIT')
        return current
      }
      if (
        current.phase !== ABILITY_CREATE_PHASE.metadataCommitted ||
        current.preparedEvidence !== preparedEvidence ||
        current.physicalReceipt !== physicalReceipt
      ) {
        db.exec('COMMIT')
        return current
      }
      db.prepare(
        `UPDATE ability_create_operations
            SET phase = ?, failure_code = NULL, updated_at = ? WHERE id = ?`,
      ).run(ABILITY_CREATE_PHASE.succeeded, updatedAt, current.id)
      const finalized = operation(db, id)
      db.exec('COMMIT')
      return finalized
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
})
