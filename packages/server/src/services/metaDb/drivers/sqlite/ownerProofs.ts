import { type OwnerProofPersistence, SPACE_LIFECYCLE_PHASE } from '@notarium/core'

import { ownerProofOfRow, type OwnerProofRow } from '../../causalRows'
import type { SqliteDriverCtx } from './context'

export const createOwnerProofsFacet = (ctx: SqliteDriverCtx): OwnerProofPersistence => ({
  init: () => ctx.ensureInit(),
  get: async (noteId) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare('SELECT * FROM note_owner_proofs WHERE note_id = ?')
      .get(noteId) as OwnerProofRow | undefined
    return row ? ownerProofOfRow(row) : null
  },
  getByReceipt: async (space, receiptId) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare('SELECT * FROM owner_proof_receipts WHERE space = ? AND receipt_id = ?')
      .get(space, receiptId) as OwnerProofRow | undefined
    return row ? ownerProofOfRow(row) : null
  },
  adopt: async (input) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const receiptRow = db
        .prepare('SELECT * FROM owner_proof_receipts WHERE space = ? AND receipt_id = ?')
        .get(input.space, input.receiptId) as OwnerProofRow | undefined

      if (receiptRow) {
        const binding = ownerProofOfRow(receiptRow)
        db.exec('COMMIT')
        return binding.noteId === input.noteId &&
          binding.addressRevision === input.addressRevision &&
          binding.sourceHash === input.sourceHash &&
          binding.proofJson === input.proofJson
          ? { status: 'replayed', binding }
          : { status: 'receipt-conflict', binding }
      }
      const lifecycle = db
        .prepare('SELECT phase FROM space_lifecycle WHERE space = ?')
        .get(input.space) as { phase: string } | undefined

      if (lifecycle?.phase !== SPACE_LIFECYCLE_PHASE.active) {
        throw new Error(`space lifecycle rejects proof adoption: ${lifecycle?.phase ?? 'missing'}`)
      }
      const address = db
        .prepare(
          `SELECT address_revision FROM note_identity
            WHERE id = ? AND space = ? AND deleted_at IS NULL`,
        )
        .get(input.noteId, input.space) as { address_revision: number | bigint } | undefined

      if (!address) {
        db.exec('COMMIT')
        return { status: 'missing-address' }
      }
      const addressRevision = Number(address.address_revision)

      if (addressRevision !== input.addressRevision) {
        db.exec('COMMIT')
        return { status: 'address-conflict', addressRevision }
      }
      const currentRow = db
        .prepare('SELECT * FROM note_owner_proofs WHERE note_id = ?')
        .get(input.noteId) as OwnerProofRow | undefined
      const current = currentRow ? ownerProofOfRow(currentRow) : null

      if ((current?.proofRevision ?? null) !== input.expectedProofRevision) {
        db.exec('COMMIT')
        return { status: 'proof-conflict', binding: current }
      }
      const proofRevision = (current?.proofRevision ?? 0) + 1
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
        input.noteId,
        input.space,
        input.addressRevision,
        proofRevision,
        input.sourceHash,
        input.proofJson,
        input.receiptId,
        input.updatedAt,
      )
      db.prepare(
        `INSERT INTO owner_proof_receipts
          (space, receipt_id, note_id, address_revision, proof_revision,
           source_hash, proof_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.space,
        input.receiptId,
        input.noteId,
        input.addressRevision,
        proofRevision,
        input.sourceHash,
        input.proofJson,
        input.updatedAt,
      )
      const binding = ownerProofOfRow(
        db
          .prepare('SELECT * FROM note_owner_proofs WHERE note_id = ?')
          .get(input.noteId) as OwnerProofRow,
      )
      db.exec('COMMIT')
      return { status: 'adopted', binding }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
})
