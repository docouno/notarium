import {
  CAUSAL_BARRIER_KIND,
  type OwnerProofPersistence,
  SPACE_LIFECYCLE_PHASE,
} from '@notarium/core'

import { ownerProofOfRow, type OwnerProofRow } from '../../causalRows'
import { lockCausalBarriers } from './causalBarriers'
import type { PgDriverCtx } from './context'
import { lockIdentityRows, lockOwnerProofRow, lockSpaceLifecycleRow } from './lockOrder'

export const createOwnerProofsFacet = (ctx: PgDriverCtx): OwnerProofPersistence => ({
  init: () => ctx.ensureInit(),
  get: async (noteId) => {
    await ctx.ensureInit()
    const result = await ctx.required.query('SELECT * FROM note_owner_proofs WHERE note_id = $1', [
      noteId,
    ])
    const row = result.rows[0] as OwnerProofRow | undefined
    return row ? ownerProofOfRow(row) : null
  },
  getByReceipt: async (space, receiptId) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM owner_proof_receipts WHERE space = $1 AND receipt_id = $2',
      [space, receiptId],
    )
    const row = result.rows[0] as OwnerProofRow | undefined
    return row ? ownerProofOfRow(row) : null
  },
  adopt: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const { rows: identities } = await lockIdentityRows(client, [input.noteId])
      await lockCausalBarriers(
        client,
        [
          {
            kind: CAUSAL_BARRIER_KIND.spaceLifecycle,
            space: input.space,
            key: input.space,
          },
          { kind: CAUSAL_BARRIER_KIND.address, space: input.space, key: input.noteId },
          { kind: CAUSAL_BARRIER_KIND.ownerProof, space: input.space, key: input.noteId },
        ],
        (kind) => (kind === CAUSAL_BARRIER_KIND.spaceLifecycle ? 'shared' : 'exclusive'),
      )
      const receiptResult = await client.query(
        'SELECT * FROM owner_proof_receipts WHERE space = $1 AND receipt_id = $2',
        [input.space, input.receiptId],
      )
      const receiptRow = receiptResult.rows[0] as OwnerProofRow | undefined

      if (receiptRow) {
        const binding = ownerProofOfRow(receiptRow)
        await client.query('COMMIT')
        return binding.noteId === input.noteId &&
          binding.addressRevision === input.addressRevision &&
          binding.sourceHash === input.sourceHash &&
          binding.proofJson === input.proofJson
          ? { status: 'replayed', binding }
          : { status: 'receipt-conflict', binding }
      }
      const lifecycle = await lockSpaceLifecycleRow<{ phase: string }>(client, input.space, 'share')
      const phase = lifecycle?.phase

      if (phase !== SPACE_LIFECYCLE_PHASE.active) {
        throw new Error(`space lifecycle rejects proof adoption: ${phase ?? 'missing'}`)
      }
      const address = identities.find(
        (row) => row.id === input.noteId && row.space === input.space && row.deleted_at == null,
      )

      if (!address) {
        await client.query('COMMIT')
        return { status: 'missing-address' }
      }
      const addressRevision = Number(address.address_revision)

      if (addressRevision !== input.addressRevision) {
        await client.query('COMMIT')
        return { status: 'address-conflict', addressRevision }
      }
      const currentRow = await lockOwnerProofRow<OwnerProofRow>(client, input.noteId)
      const current = currentRow ? ownerProofOfRow(currentRow) : null

      if ((current?.proofRevision ?? null) !== input.expectedProofRevision) {
        await client.query('COMMIT')
        return { status: 'proof-conflict', binding: current }
      }
      const proofRevision = (current?.proofRevision ?? 0) + 1
      const updated = await client.query(
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
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          input.noteId,
          input.space,
          input.addressRevision,
          proofRevision,
          input.sourceHash,
          input.proofJson,
          input.receiptId,
          input.updatedAt,
        ],
      )
      await client.query(
        `INSERT INTO owner_proof_receipts
          (space, receipt_id, note_id, address_revision, proof_revision,
           source_hash, proof_json, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.space,
          input.receiptId,
          input.noteId,
          input.addressRevision,
          proofRevision,
          input.sourceHash,
          input.proofJson,
          input.updatedAt,
        ],
      )
      const binding = ownerProofOfRow(updated.rows[0] as OwnerProofRow)
      await client.query('COMMIT')
      return { status: 'adopted', binding }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
