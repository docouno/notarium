// Import path reservations on PostgreSQL (#302) — the twin of the SQLite facet.
//
// The two dialects hold the SAME contract by different means, and that is why this
// is not a copy: SQLite has one writer, so its exclusion is a process-owned
// ORDERING; Postgres has many, so the exclusion is the tiered hierarchy of
// `lockOrder.ts` — L0j (this job's fence), then L1r the reservation header, then
// L1p its destination claims.
//
// What is NOT here: identity. None of these transactions enters L1 `note_identity`,
// and none mints an id — what they arbitrate is a DESTINATION PATH, by the unique
// index on (space, destination_path). The ids come from the planner, and two runs
// that settle on the same id are caught where the bytes land, by the physical CAS of
// the write path. The ids ON a claim row describe the batch and are read back by
// nobody here — a claim is a claim on a path.
//
// What both dialects must guarantee: the premise (this job is running under this
// lease) is proved INSIDE the exclusion the caller's physical write happens under,
// and the exclusion outlives that write. A check that releases before the bytes land
// proves nothing about the bytes.
//
// Every method opens its OWN transaction rather than sharing a `withTx` helper: the
// registry derives a transaction's name from the method enclosing its `BEGIN`, so a
// shared opener would collapse four transactions with four different level sequences
// into one undeclarable name.
// canon: docs/import.md#importing-a-markdown-tree-302

import type { PoolClient } from 'pg'

import { freshNoteId } from '@notarium/core'

import { ImportFenceError, reservationReuseRefusal } from '../../importFence'
import type {
  ImportReservation,
  ImportReservationEntry,
  ImportReservationsPersistence,
} from '../../types'
import { IMPORT_RESERVATION_REFUSAL } from '../../types'
import type { PgDriverCtx } from './context'
import {
  IMPORT_RESERVATION_PATH_COLUMNS,
  type ImportReservationHeaderRow,
  type ImportReservationPathRow,
  insertImportReservationPaths,
  lockImportJobAdvisory,
  lockImportJobFence,
  lockImportReservationById,
  lockImportReservationByJob,
  lockImportReservationByUpload,
  lockImportReservationPath,
  lockImportReservationPaths,
} from './lockOrder'

/** Postgres reports the destination collision as a unique violation — which is the
 *  ANSWER, not a fault: another live import already owns one of these paths. */
const UNIQUE_VIOLATION = '23505'

const entryOf = (row: ImportReservationPathRow): ImportReservationEntry => ({
  entryKey: row.entry_key,
  destinationPath: row.destination_path,
  targetId: row.target_id,
  expectedId: row.expected_id,
  ownership: row.ownership,
})

const reservationOf = (
  header: ImportReservationHeaderRow,
  rows: readonly ImportReservationPathRow[],
): ImportReservation => ({
  id: header.id,
  space: header.space,
  jobId: header.job_id,
  uploadRef: header.upload_ref,
  fence: header.fence,
  status: header.status,
  entries: rows.map(entryOf),
})

/** The claims of one reservation, read WITHOUT locking them. Legitimate only where
 *  the header is already held: a fenced write of this reservation must pass L1r to
 *  touch them, and a competing reserve can only INSERT, where the unique index — not
 *  a row lock — is what refuses it. */
const readPathsUnlocked = async (
  client: PoolClient,
  reservationId: string,
): Promise<ImportReservationPathRow[]> => {
  const res = await client.query(
    `SELECT ${IMPORT_RESERVATION_PATH_COLUMNS}
       FROM import_reservation_paths WHERE reservation_id = $1 ORDER BY entry_key`,
    [reservationId],
  )

  return res.rows as ImportReservationPathRow[]
}

export const createImportReservationsFacet = (ctx: PgDriverCtx): ImportReservationsPersistence => ({
  reserve: async ({ space, jobId, workerLease, uploadRef, entries, now }) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const premise = await lockImportJobFence(client, jobId, workerLease)

      if (!premise.ok) {
        await client.query('ROLLBACK')

        return {
          ok: false as const,
          reason: IMPORT_RESERVATION_REFUSAL.jobNotCurrent,
          detail: premise.detail,
        }
      }
      const existing = await lockImportReservationByUpload(client, space, uploadRef)

      // Idempotent by upload: a retry that already got past the plan reads back the
      // outcome it has instead of arbitrating a second time — and only THIS job's,
      // and only while the row is still live.
      if (existing.row) {
        const refusal = reservationReuseRefusal(existing.row, jobId)

        if (refusal) {
          await client.query('ROLLBACK')

          return refusal
        }
        const paths = await lockImportReservationPaths(client, space, existing.row.id)
        const reservation = reservationOf(existing.row, paths.rows)

        await client.query('COMMIT')

        return { ok: true as const, reservation }
      }
      const id = freshNoteId()
      const fence = freshNoteId()

      await client.query(
        `INSERT INTO import_reservations
           (id, space, job_id, upload_ref, fence, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)`,
        [id, space, jobId, uploadRef, fence, now],
      )
      try {
        await insertImportReservationPaths(client, id, space, entries)
      } catch (err) {
        if ((err as { code?: string }).code !== UNIQUE_VIOLATION) {
          throw err
        }
        // The whole transaction goes back, not just the statement: a header row
        // must never survive a batch that did not get its claims.
        await client.query('ROLLBACK')

        return {
          ok: false as const,
          reason: IMPORT_RESERVATION_REFUSAL.pathConflict,
          detail: 'another import already reserved one of these destinations',
        }
      }
      const reservation = reservationOf(
        { id, space, job_id: jobId, upload_ref: uploadRef, fence, status: 'active' },
        await readPathsUnlocked(client, id),
      )

      await client.query('COMMIT')

      return { ok: true as const, reservation }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },

  adopt: async ({ space, jobId, workerLease, uploadRef, now }) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const premise = await lockImportJobFence(client, jobId, workerLease)

      if (!premise.ok) {
        await client.query('ROLLBACK')

        return {
          ok: false as const,
          reason: IMPORT_RESERVATION_REFUSAL.jobNotCurrent,
          detail: premise.detail,
        }
      }
      const existing = await lockImportReservationByUpload(client, space, uploadRef)

      if (!existing.row) {
        await client.query('ROLLBACK')

        return {
          ok: false as const,
          reason: IMPORT_RESERVATION_REFUSAL.staleFence,
          detail: 'no reservation to adopt',
        }
      }
      // Taking it from another job is the POINT here, so only its status can refuse:
      // a row cleanup already started closing is not handed on.
      const refusal = reservationReuseRefusal(existing.row, null)

      if (refusal) {
        await client.query('ROLLBACK')

        return refusal
      }
      // A NEW fence, and the job id moves with it: the previous run's fence is now
      // stale, which is exactly how its in-flight writes are stopped.
      const fence = freshNoteId()

      await client.query(
        `UPDATE import_reservations SET fence = $1, job_id = $2, status = 'active', updated_at = $3
           WHERE id = $4`,
        [fence, jobId, now, existing.row.id],
      )
      const reservation = reservationOf(
        { ...existing.row, fence, job_id: jobId, status: 'active' },
        await readPathsUnlocked(client, existing.row.id),
      )

      await client.query('COMMIT')

      return { ok: true as const, reservation }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },

  withFencedWrite: async (
    { reservationId, fence, jobId, workerLease, space, destinationPath },
    mutate,
  ) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    // The transaction — and with it the L0j advisory — spans the caller's physical
    // write. That IS the invariant: an invalidation cannot slip between the premise
    // and the bytes, because it cannot enter L0j until this commits.
    try {
      await client.query('BEGIN')
      const premise = await lockImportJobFence(client, jobId, workerLease)

      if (!premise.ok) {
        throw new ImportFenceError(IMPORT_RESERVATION_REFUSAL.jobNotCurrent, premise.detail)
      }
      const header = await lockImportReservationById(client, reservationId)

      // `job_id` is checked with the fence, not left to the uniqueness of an upload
      // ref: adopt MOVES the job id, so a header owned by another job is by
      // construction a run this fence no longer belongs to.
      if (
        !header.row ||
        header.row.space !== space ||
        header.row.job_id !== jobId ||
        header.row.fence !== fence ||
        header.row.status !== 'active'
      ) {
        throw new ImportFenceError(
          IMPORT_RESERVATION_REFUSAL.staleFence,
          'the reservation was closed or re-adopted under a newer fence',
        )
      }
      const claim = await lockImportReservationPath(client, space, reservationId, destinationPath)
      const entry = claim.row ? entryOf(claim.row) : null

      // Not reserved by THIS import: either nobody claimed the destination or a
      // rival reservation holds it. Both are the same answer to this write — the
      // path is not its to publish into — and both stop it before the bytes.
      if (!entry) {
        throw new ImportFenceError(
          IMPORT_RESERVATION_REFUSAL.pathConflict,
          `${destinationPath} is not reserved by this import`,
        )
      }
      // Nothing is recorded after the write: the claim says what was PLANNED, and a
      // second row write could only ever repeat the question a crash leaves open.
      // The retry re-proves the destination physically.
      const result = await mutate({ ...entry, reservationId })

      await client.query('COMMIT')

      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },

  forJob: async (jobId) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT id, space, job_id, upload_ref, fence, status
         FROM import_reservations WHERE job_id = $1 ORDER BY id`,
      [jobId],
    )
    const header = res.rows[0] as ImportReservationHeaderRow | undefined

    if (!header) {
      return null
    }
    const paths = await ctx.required.query(
      `SELECT ${IMPORT_RESERVATION_PATH_COLUMNS}
         FROM import_reservation_paths WHERE reservation_id = $1 ORDER BY entry_key`,
      [header.id],
    )

    return reservationOf(header, paths.rows as ImportReservationPathRow[])
  },

  // Nothing but the job id is needed, and that is the point: cleanup takes no store,
  // reads no file and cannot fail on a space whose store is gone. A claim it cannot
  // close is a destination nothing ever frees again.
  closeForJob: async ({ jobId, now }) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    // One transaction, holding L0j and the header: an in-flight fenced write of this
    // job cannot be inside it, and the next one fails its fence instead of racing
    // the delete. `closing` is therefore never observable here — it is written and
    // dropped in the same transaction, and exists for the dialect that cannot.
    try {
      await client.query('BEGIN')
      await lockImportJobAdvisory(client, jobId)
      const header = await lockImportReservationByJob(client, jobId)

      if (!header.row) {
        await client.query('COMMIT')

        return
      }
      await client.query(
        `UPDATE import_reservations SET status = 'closing', updated_at = $1 WHERE id = $2`,
        [now, header.row.id],
      )
      // The claims go with the header through the table pair's ON DELETE CASCADE —
      // which is what takes L1p here, in the one order the hierarchy allows (the
      // parent's L1r is already held). The register declares that level for this
      // transaction so the cascade is a stated fact rather than an invisible one;
      // deleting the claims by hand would have to run BEFORE the header and would
      // take L1p ahead of L1r, which is the dip the order exists to forbid.
      // canon: packages/server/src/services/metaDb/drivers/pg/lockOrder.ts
      await client.query(`DELETE FROM import_reservations WHERE id = $1`, [header.row.id])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },

  activeJobIds: async () => {
    await ctx.ensureInit()
    const res = await ctx.required.query(`SELECT DISTINCT job_id FROM import_reservations`)

    return (res.rows as Array<{ job_id: string }>).map((row) => row.job_id)
  },
})
