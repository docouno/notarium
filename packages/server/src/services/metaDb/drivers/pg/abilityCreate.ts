import { Buffer } from 'node:buffer'
import type { PoolClient } from 'pg'
import { ABILITY_AVAILABILITY_MODE } from '@notarium/contract'
import { CAUSAL_BARRIER_KIND, REVISION_INTEGRITY, SPACE_LIFECYCLE_PHASE } from '@notarium/core'

import { abilityCreateOperationOfRow, type AbilityCreateOperationRow } from '../../causalRows'
import {
  ABILITY_CREATE_PHASE,
  type AbilityAvailability,
  type AbilityCreateOperationRecord,
  type AbilityCreatePersistence,
  type AbilityCreateTerminalResult,
} from '../../types'
import { assertAbilityTargetLive } from './abilityLifecycle'
import { lockCausalBarriers } from './causalBarriers'
import type { PgDriverCtx } from './context'
import {
  lockAbilityAvailabilityPackage,
  lockAbilityCreateOperationRow,
  lockAbilityHomeProjects,
  lockIdentityRows,
  lockOwnerProofRow,
  lockSpaceLifecycleRow,
} from './lockOrder'
import { lockRevisionKeys } from './revisionLocks'

const recordOf = (
  row: AbilityCreateOperationRow | undefined,
): AbilityCreateOperationRecord | null => (row ? abilityCreateOperationOfRow(row) : null)

const operation = async (
  client: PoolClient,
  id: string,
): Promise<AbilityCreateOperationRecord | null> =>
  recordOf(
    (await client.query('SELECT * FROM ability_create_operations WHERE id = $1', [id])).rows[0] as
      AbilityCreateOperationRow | undefined,
  )

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

export const createAbilityCreateFacet = (ctx: PgDriverCtx): AbilityCreatePersistence => ({
  findReplay: async (input) => {
    await ctx.ensureInit()
    const replay = recordOf(
      (
        await ctx.required.query(
          `SELECT * FROM ability_create_operations
            WHERE actor_digest = $1 AND idempotency_digest = $2 AND phase <> 'rejected'`,
          [input.actorDigest, input.idempotencyDigest],
        )
      ).rows[0] as AbilityCreateOperationRow | undefined,
    )

    if (!replay) {
      return { status: 'missing' }
    }

    return replay.requestFingerprint === input.requestFingerprint
      ? { status: 'replayed', operation: replay }
      : { status: 'idempotency-conflict', operation: replay }
  },

  accept: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()
    const projectIds = projectIdsOf(input.availability)

    if (input.availabilityRequired !== (input.availability != null)) {
      client.release()
      throw new Error('ability create availability evidence is inconsistent')
    }

    try {
      await client.query('BEGIN')
      if (input.idempotencyDigest) {
        const replay = recordOf(
          (
            await client.query(
              `SELECT * FROM ability_create_operations
                WHERE actor_digest = $1 AND idempotency_digest = $2 AND phase <> 'rejected'`,
              [input.actorDigest, input.idempotencyDigest],
            )
          ).rows[0] as AbilityCreateOperationRow | undefined,
        )

        if (replay) {
          await client.query('COMMIT')
          return replay.requestFingerprint === input.requestFingerprint
            ? { status: 'replayed' as const, operation: replay }
            : { status: 'idempotency-conflict' as const, operation: replay }
        }
      }
      const identityHold = await lockIdentityRows(client, [input.noteId])

      if (identityHold.rows.length) {
        await client.query('ROLLBACK')
        return { status: 'identity-conflict' as const }
      }
      await lockCausalBarriers(
        client,
        [
          {
            kind: CAUSAL_BARRIER_KIND.spaceLifecycle,
            space: input.space,
            key: input.space,
          },
          { kind: CAUSAL_BARRIER_KIND.note, space: input.space, key: input.noteId },
          { kind: CAUSAL_BARRIER_KIND.address, space: input.space, key: input.targetPath },
          { kind: CAUSAL_BARRIER_KIND.operation, space: input.space, key: input.id },
        ],
        (kind) => (kind === CAUSAL_BARRIER_KIND.spaceLifecycle ? 'shared' : 'exclusive'),
      )
      const lifecycle = await lockSpaceLifecycleRow<{ phase: string }>(client, input.space, 'share')

      if (!lifecycle || lifecycle.phase !== SPACE_LIFECYCLE_PHASE.active) {
        throw new Error(`space lifecycle rejects ability create: ${lifecycle?.phase ?? 'missing'}`)
      }
      const pathOwner = await client.query(
        `SELECT 1 FROM note_identity
          WHERE space = $1 AND file_path = $2 AND deleted_at IS NULL`,
        [input.space, input.targetPath],
      )

      if (pathOwner.rows.length) {
        await client.query('ROLLBACK')
        return { status: 'path-conflict' as const }
      }
      await client.query(
        `INSERT INTO note_identity
          (id, file_path, created_at, materialized, deleted_at, space,
           address_revision, legacy_name_aliases, settlement_successor_id)
         VALUES ($1, $2, $3, FALSE, NULL, $4, 1, '[]', NULL)`,
        [input.noteId, input.targetPath, input.identity.createdAt, input.space],
      )
      if (input.availability) {
        await assertAbilityTargetLive(client, input.space, null)
        const projects = await lockAbilityHomeProjects(client, input.space, projectIds)

        if (projects.ids.length !== projectIds.length) {
          throw new Error('ability create availability contains a missing or foreign project')
        }
        await lockAbilityAvailabilityPackage(client, input.space, input.packageId)
        const inserted = await client.query(
          `INSERT INTO ability_availability
            (home_space, package_id, mode, registry_note_id)
           VALUES ($1, $2, $3, NULL)
           ON CONFLICT (home_space, package_id) DO NOTHING
           RETURNING package_id`,
          [input.space, input.packageId, input.availability.mode],
        )

        if (inserted.rowCount !== 1) {
          await client.query('ROLLBACK')
          return { status: 'package-conflict' as const }
        }
        if (projectIds.length) {
          await client.query(
            `INSERT INTO ability_project_bindings (home_space, package_id, project_id)
             SELECT $1, $2, unnest($3::text[])`,
            [input.space, input.packageId, projectIds],
          )
        }
      }
      const inserted = await client.query(
        `INSERT INTO ability_create_operations
          (id, actor_digest, idempotency_digest, request_fingerprint, space,
           package_id, note_id, target_path, availability_required, stage_binding,
           phase, prepared_evidence, physical_receipt, terminal_result, failure_code,
           created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 NULL, NULL, NULL, $13, $13)
         RETURNING *`,
        [
          input.id,
          input.actorDigest,
          input.idempotencyDigest,
          input.requestFingerprint,
          input.space,
          input.packageId,
          input.noteId,
          input.targetPath,
          input.availabilityRequired,
          input.stageBinding,
          ABILITY_CREATE_PHASE.accepted,
          input.preparedEvidence,
          input.createdAt,
        ],
      )
      const accepted = abilityCreateOperationOfRow(inserted.rows[0] as AbilityCreateOperationRow)
      await client.query('COMMIT')
      return { status: 'accepted' as const, operation: accepted }
    } catch (error) {
      await client.query('ROLLBACK')
      const code = (error as { code?: string }).code

      if (code === '23505') {
        if (input.idempotencyDigest) {
          const replay = recordOf(
            (
              await client.query(
                `SELECT * FROM ability_create_operations
                  WHERE actor_digest = $1 AND idempotency_digest = $2 AND phase <> 'rejected'`,
                [input.actorDigest, input.idempotencyDigest],
              )
            ).rows[0] as AbilityCreateOperationRow | undefined,
          )

          if (replay) {
            return replay.requestFingerprint === input.requestFingerprint
              ? { status: 'replayed' as const, operation: replay }
              : { status: 'idempotency-conflict' as const, operation: replay }
          }
        }
        const [id, path, pkg] = await Promise.all([
          client.query('SELECT 1 FROM note_identity WHERE id = $1', [input.noteId]),
          client.query(
            `SELECT 1 FROM note_identity
              WHERE space = $1 AND file_path = $2 AND deleted_at IS NULL`,
            [input.space, input.targetPath],
          ),
          client.query(
            'SELECT 1 FROM ability_create_operations WHERE space = $1 AND package_id = $2',
            [input.space, input.packageId],
          ),
        ])
        return id.rows.length
          ? { status: 'identity-conflict' as const }
          : path.rows.length
            ? { status: 'path-conflict' as const }
            : pkg.rows.length
              ? { status: 'package-conflict' as const }
              : Promise.reject(error)
      }
      throw error
    } finally {
      client.release()
    }
  },

  get: async (id) => {
    await ctx.ensureInit()
    return recordOf(
      (await ctx.required.query('SELECT * FROM ability_create_operations WHERE id = $1', [id]))
        .rows[0] as AbilityCreateOperationRow | undefined,
    )
  },

  listRecoverable: async () => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT * FROM ability_create_operations
        WHERE phase NOT IN ('succeeded', 'rejected')
        ORDER BY created_at, id`,
    )
    return (result.rows as AbilityCreateOperationRow[]).map(abilityCreateOperationOfRow)
  },

  markPhysical: async (id, preparedEvidence, physicalReceipt, updatedAt) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `UPDATE ability_create_operations
          SET phase = $2, physical_receipt = $3, failure_code = NULL, updated_at = $4
        WHERE id = $1 AND prepared_evidence = $5
          AND phase IN ('accepted', 'failed-recoverable')`,
      [id, ABILITY_CREATE_PHASE.physicalPublished, physicalReceipt, updatedAt, preparedEvidence],
    )
    return recordOf(
      (await ctx.required.query('SELECT * FROM ability_create_operations WHERE id = $1', [id]))
        .rows[0] as AbilityCreateOperationRow | undefined,
    )
  },

  markRecoverable: async (id, failureCode, updatedAt) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `UPDATE ability_create_operations
          SET phase = $2, failure_code = $3, updated_at = $4
        WHERE id = $1 AND phase IN ('accepted', 'physical-published', 'failed-recoverable')`,
      [id, ABILITY_CREATE_PHASE.failedRecoverable, failureCode, updatedAt],
    )
    return recordOf(
      (await ctx.required.query('SELECT * FROM ability_create_operations WHERE id = $1', [id]))
        .rows[0] as AbilityCreateOperationRow | undefined,
    )
  },

  reject: async (id, failureCode, updatedAt) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const lookup = await operation(client, id)

      if (!lookup) {
        await client.query('COMMIT')
        return null
      }
      if (lookup.phase === ABILITY_CREATE_PHASE.succeeded) {
        await client.query('COMMIT')
        return lookup
      }
      if (lookup.physicalReceipt) {
        throw new Error('a physically published ability create cannot be rejected')
      }
      await lockIdentityRows(client, [lookup.noteId])
      await lockCausalBarriers(client, [
        { kind: CAUSAL_BARRIER_KIND.note, space: lookup.space, key: lookup.noteId },
        { kind: CAUSAL_BARRIER_KIND.operation, space: lookup.space, key: lookup.id },
      ])
      const currentRow = await lockAbilityCreateOperationRow<AbilityCreateOperationRow>(client, id)
      const current = recordOf(currentRow)

      if (!current || current.physicalReceipt) {
        throw new Error('ability create changed before rejection')
      }
      await client.query(
        `DELETE FROM note_identity
          WHERE id = $1 AND space = $2 AND file_path = $3 AND materialized = FALSE
            AND NOT EXISTS (
              SELECT 1 FROM note_revisions WHERE note_id = $1 AND space = $2
            )`,
        [current.noteId, current.space, current.targetPath],
      )
      if (current.availabilityRequired) {
        await lockAbilityAvailabilityPackage(client, current.space, current.packageId)
        await client.query(
          `DELETE FROM ability_availability
            WHERE home_space = $1 AND package_id = $2 AND registry_note_id IS NULL`,
          [current.space, current.packageId],
        )
      }
      const updated = await client.query(
        `UPDATE ability_create_operations
            SET phase = $2, failure_code = $3, updated_at = $4
          WHERE id = $1 RETURNING *`,
        [id, ABILITY_CREATE_PHASE.rejected, failureCode, updatedAt],
      )
      await client.query('COMMIT')
      return recordOf(updated.rows[0] as AbilityCreateOperationRow | undefined)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  commit: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const lookup = await operation(client, input.operationId)

      if (!lookup) {
        await client.query('COMMIT')
        return { status: 'conflict' as const, operation: null }
      }
      const identityHold = await lockIdentityRows(client, [lookup.noteId])
      const row = await lockAbilityCreateOperationRow<AbilityCreateOperationRow>(
        client,
        input.operationId,
      )
      const current = recordOf(row)

      if (!current) {
        await client.query('ROLLBACK')
        return { status: 'conflict' as const, operation: null }
      }
      if (
        current.phase === ABILITY_CREATE_PHASE.metadataCommitted ||
        current.phase === ABILITY_CREATE_PHASE.succeeded
      ) {
        const result = resultOf(current)
        await client.query('ROLLBACK')
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
        await client.query('ROLLBACK')
        return { status: 'conflict' as const, operation: current }
      }
      const identity = identityHold.rows.find((candidate) => candidate.id === current.noteId)

      if (
        !identity ||
        identity.space !== current.space ||
        identity.file_path !== current.targetPath ||
        identity.materialized !== false ||
        identity.deleted_at !== null
      ) {
        await client.query('ROLLBACK')
        return { status: 'conflict' as const, operation: current }
      }
      // Finish the tier-1 mutation before entering the causal/revision tiers.
      // Later conflicts roll it back with the whole terminal transaction. Moving
      // this update below L3 re-enters L1 and inverts whole-Space purge order.
      await client.query(
        `UPDATE note_identity
            SET materialized = TRUE, created_at = $2, legacy_name_aliases = $3
          WHERE id = $1 AND materialized = FALSE`,
        [
          current.noteId,
          input.identity.createdAt,
          JSON.stringify(input.identity.legacyNameAliases),
        ],
      )
      await lockCausalBarriers(
        client,
        [
          {
            kind: CAUSAL_BARRIER_KIND.spaceLifecycle,
            space: lookup.space,
            key: lookup.space,
          },
          { kind: CAUSAL_BARRIER_KIND.note, space: lookup.space, key: lookup.noteId },
          { kind: CAUSAL_BARRIER_KIND.address, space: lookup.space, key: lookup.targetPath },
          { kind: CAUSAL_BARRIER_KIND.ownerProof, space: lookup.space, key: lookup.noteId },
          { kind: CAUSAL_BARRIER_KIND.operation, space: lookup.space, key: lookup.id },
          {
            kind: CAUSAL_BARRIER_KIND.blob,
            space: lookup.space,
            key: input.revision.contentHash,
          },
          {
            kind: CAUSAL_BARRIER_KIND.outbox,
            space: lookup.space,
            key: `ability-create-committed:${lookup.noteId}`,
          },
        ],
        (kind) => (kind === CAUSAL_BARRIER_KIND.spaceLifecycle ? 'shared' : 'exclusive'),
      )
      const lifecycle = await lockSpaceLifecycleRow<{
        phase: string
        generation: string | number
      }>(client, current.space, 'share')

      if (
        !lifecycle ||
        (lifecycle.phase !== SPACE_LIFECYCLE_PHASE.active &&
          lifecycle.phase !== SPACE_LIFECYCLE_PHASE.closing)
      ) {
        await client.query('ROLLBACK')
        return { status: 'conflict' as const, operation: current }
      }
      await client.query(
        'INSERT INTO revision_blobs (hash, content) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING',
        [input.revision.contentHash, Buffer.from(input.content)],
      )
      await lockRevisionKeys(client, 'space', [current.space], 'shared')
      await lockRevisionKeys(client, 'note', [current.noteId])
      await lockRevisionKeys(client, 'blob', [input.revision.contentHash])
      const head = await client.query(
        'SELECT 1 FROM revision_heads WHERE space = $1 AND note_id = $2',
        [current.space, current.noteId],
      )

      if (head.rows.length) {
        await client.query('ROLLBACK')
        return { status: 'conflict' as const, operation: current }
      }
      await client.query(
        'INSERT INTO revision_blobs (hash, content) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING',
        [input.revision.contentHash, Buffer.from(input.content)],
      )
      const proof = await lockOwnerProofRow(client, current.noteId)
      const receipt = await client.query(
        'SELECT 1 FROM owner_proof_receipts WHERE space = $1 AND receipt_id = $2',
        [current.space, input.ownerProof.receiptId],
      )

      if (proof || receipt.rows.length) {
        await client.query('ROLLBACK')
        return { status: 'conflict' as const, operation: current }
      }
      const revision = input.revision
      const inserted = await client.query(
        `INSERT INTO note_revisions
           (note_id, space, base_rev, their_rev, source_rev, kind, principal,
            agent_owner, agent_name, session_id, session_name, session_attach,
            content_hash, semantic_fingerprint, restore_safety, state_format,
            title, class, slug, tags, created_at, chars_added, chars_removed,
            entry_role, integrity)
         VALUES ($1, $2, NULL, NULL, NULL, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
         RETURNING id`,
        [
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
        ],
      )
      await client.query(
        `INSERT INTO note_owner_proofs
          (note_id, space, address_revision, proof_revision, source_hash,
           proof_json, receipt_id, updated_at)
         VALUES ($1, $2, 1, 1, $3, $4, $5, $6)`,
        [
          current.noteId,
          current.space,
          input.ownerProof.sourceHash,
          input.ownerProof.proofJson,
          input.ownerProof.receiptId,
          input.committedAt,
        ],
      )
      await client.query(
        `INSERT INTO owner_proof_receipts
          (space, receipt_id, note_id, address_revision, proof_revision,
           source_hash, proof_json, updated_at)
         VALUES ($1, $2, $3, 1, 1, $4, $5, $6)`,
        [
          current.space,
          input.ownerProof.receiptId,
          current.noteId,
          input.ownerProof.sourceHash,
          input.ownerProof.proofJson,
          input.committedAt,
        ],
      )
      if (current.availabilityRequired) {
        await lockAbilityAvailabilityPackage(client, current.space, current.packageId)
        const updated = await client.query(
          `UPDATE ability_availability SET registry_note_id = $3
            WHERE home_space = $1 AND package_id = $2 AND registry_note_id IS NULL`,
          [current.space, current.packageId, current.noteId],
        )

        if (updated.rowCount !== 1) {
          throw new Error('ability create availability reservation changed before commit')
        }
      } else {
        const unexpected = await client.query(
          `SELECT 1 FROM ability_availability
            WHERE home_space = $1 AND package_id = $2`,
          [current.space, current.packageId],
        )

        if (unexpected.rows.length) {
          await client.query('ROLLBACK')
          return { status: 'conflict' as const, operation: current }
        }
      }
      const result = { ...input.result, revisionId: String(inserted.rows[0].id) }
      await client.query(
        `INSERT INTO causal_outbox
          (space, generation, kind, operation_id, resource_id, created_at, acknowledged_at)
         VALUES ($1, $2, 'ability-create-committed', $3, $4, $5, NULL)`,
        [
          current.space,
          Number(lifecycle.generation),
          current.id,
          current.noteId,
          input.committedAt,
        ],
      )
      const completed = await client.query(
        `UPDATE ability_create_operations
            SET phase = $2, terminal_result = $3, failure_code = NULL, updated_at = $4
          WHERE id = $1 RETURNING *`,
        [
          current.id,
          ABILITY_CREATE_PHASE.metadataCommitted,
          JSON.stringify(result),
          input.committedAt,
        ],
      )
      const committed = abilityCreateOperationOfRow(completed.rows[0] as AbilityCreateOperationRow)
      await client.query('COMMIT')
      return { status: 'committed' as const, operation: committed, result }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  finalize: async (id, preparedEvidence, physicalReceipt, updatedAt) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const lookup = await client.query(
        'SELECT space, note_id FROM ability_create_operations WHERE id = $1',
        [id],
      )
      const found = lookup.rows[0] as { space: string; note_id: string } | undefined

      if (!found) {
        await client.query('COMMIT')
        return null
      }
      await lockCausalBarriers(
        client,
        [
          {
            kind: CAUSAL_BARRIER_KIND.spaceLifecycle,
            space: found.space,
            key: found.space,
          },
          { kind: CAUSAL_BARRIER_KIND.operation, space: found.space, key: id },
          {
            kind: CAUSAL_BARRIER_KIND.outbox,
            space: found.space,
            key: `ability-create-committed:${found.note_id}`,
          },
        ],
        (kind) => (kind === CAUSAL_BARRIER_KIND.spaceLifecycle ? 'shared' : 'exclusive'),
      )
      const row = await lockAbilityCreateOperationRow<AbilityCreateOperationRow>(client, id)
      const current = recordOf(row)

      if (!current) {
        await client.query('COMMIT')
        return null
      }
      if (current.phase === ABILITY_CREATE_PHASE.succeeded) {
        await client.query('COMMIT')
        return current
      }
      if (
        current.phase !== ABILITY_CREATE_PHASE.metadataCommitted ||
        current.preparedEvidence !== preparedEvidence ||
        current.physicalReceipt !== physicalReceipt
      ) {
        await client.query('COMMIT')
        return current
      }
      const updated = await client.query(
        `UPDATE ability_create_operations
            SET phase = $2, failure_code = NULL, updated_at = $3
          WHERE id = $1 RETURNING *`,
        [current.id, ABILITY_CREATE_PHASE.succeeded, updatedAt],
      )
      await client.query('COMMIT')
      return recordOf(updated.rows[0] as AbilityCreateOperationRow | undefined)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
