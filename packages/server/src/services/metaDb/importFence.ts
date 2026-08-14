// The dialect-neutral refusals of the import fence (#302): the error a fenced write
// raises, and the policy that decides who may pick up a reservation that already
// exists. Both drivers reach the same answer by different mechanisms, so the ANSWER
// lives once — a policy re-derived per dialect is how the two drift apart.
// canon: docs/import.md#importing-a-markdown-tree-302

import { IMPORT_RESERVATION_REFUSAL, type ImportReservationOutcome } from './types'

/** A refusal a caller cannot overlook (#302). The fenced import write THROWS rather
 *  than returning a result, because "the fence was stale" and "the write happened"
 *  must never be confusable at a call site — one of them means bytes are on disk.
 *
 *  Dialect-neutral on purpose: both drivers raise the same error for the same fact,
 *  so the shared reservation contract can assert on it without knowing which
 *  database is underneath. canon: docs/import.md#importing-a-markdown-tree-302 */
export class ImportFenceError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(`import reservation fence refused: ${detail}`)
    this.name = 'ImportFenceError'
  }
}

/** The header of a live reservation, as both dialects spell the row. */
type ReservationOwnerRow = { job_id: string; status: 'active' | 'closing' }

/** May this caller pick up the reservation it just found, or is that a refusal?
 *
 *  `owner` is the job that must already hold it, or `null` where taking it over is
 *  the whole point (`adopt`, which re-fences it). Two facts make it a refusal:
 *
 *  - a DIFFERENT job holds it. An upload belongs to one job, so this is not a
 *    retry of the same run; handing the row back would let a job write under a
 *    reservation that closing its own job never finds, and hold destinations
 *    nothing then releases. It reads as a path conflict because that is what it
 *    is — another import owns these destinations;
 *  - it is `closing`. Cleanup has given up on the row; reviving it would race a
 *    delete that is already committed to happening. Fail closed and let the
 *    terminal observer finish. */
export const reservationReuseRefusal = (
  header: ReservationOwnerRow,
  owner: string | null,
): Extract<ImportReservationOutcome, { ok: false }> | null => {
  if (owner !== null && header.job_id !== owner) {
    return {
      ok: false,
      reason: IMPORT_RESERVATION_REFUSAL.pathConflict,
      detail: `job ${header.job_id} already holds this upload's destinations`,
    }
  }
  if (header.status !== 'active') {
    return {
      ok: false,
      reason: IMPORT_RESERVATION_REFUSAL.staleFence,
      detail: 'the reservation is being closed',
    }
  }

  return null
}
