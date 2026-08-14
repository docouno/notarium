// Import path reservations on SQLite (#302).
//
// SQLite has a single writer, so the exclusion this facet needs is not a lock
// hierarchy but an ORDERING: every status-changing job path and every fenced
// import write of one job take the same process-owned guard, and the guard is
// held across the physical file write. That is the whole point — a check that
// releases before the bytes land proves nothing about the bytes.
//
// The heartbeat deliberately does NOT take the guard: a slow write must be able
// to keep its lease alive while it holds the exclusion, or a long member would
// reap the very job that is making progress.
//
// What this facet arbitrates is a DESTINATION PATH — the UNIQUE on
// (space, destination_path) — and never an identity: the ids come from the planner,
// and two runs that settle on the same id are caught where the bytes land, by the
// physical CAS of the write path. The ids ON a claim row describe the batch and are
// read back by nobody here — a claim is a claim on a path.
// canon: docs/import.md#importing-a-markdown-tree-302

import { freshNoteId } from '@notarium/core'

import { ImportFenceError, reservationReuseRefusal } from '../../importFence'
import type {
  ImportReservation,
  ImportReservationEntry,
  ImportReservationsPersistence,
} from '../../types'
import { IMPORT_RESERVATION_REFUSAL } from '../../types'
import type { SqliteDriverCtx } from './context'

type ReservationRow = {
  id: string
  space: string
  job_id: string
  upload_ref: string
  fence: string
  status: 'active' | 'closing'
}

type PathRow = {
  entry_key: string
  destination_path: string
  target_id: string
  expected_id: string | null
  ownership: ImportReservationEntry['ownership']
}

/** Per-job serialization for everything that may change what a write is allowed
 *  to do. Process-owned because SQLite is single-process by deployment; the map
 *  is keyed by job so two unrelated imports still proceed in parallel. */
const jobGuards = new Map<string, Promise<unknown>>()

export const withJobGuard = async <T>(jobId: string, task: () => Promise<T>): Promise<T> => {
  const previous = jobGuards.get(jobId) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })

  // The QUEUED promise, not `held`: the map holds the tail of the chain, so that is
  // what "am I still the last one queued?" has to compare against. Comparing with
  // `held` never matched, and every job id this process ever guarded stayed in the
  // map for the life of the process.
  const queued = previous.then(() => held)

  jobGuards.set(jobId, queued)
  await previous.catch(() => {})
  try {
    return await task()
  } finally {
    release()
    // Drop the entry once this holder was the last one queued, so a long-lived
    // process does not accumulate one promise per job it ever ran.
    void Promise.resolve().then(() => {
      if (jobGuards.get(jobId) === queued) {
        jobGuards.delete(jobId)
      }
    })
  }
}

/** Several guards at once, taken in sorted order so two holders can never take them
 *  in opposite orders. A whole-space erase is the caller: it deletes the claims of
 *  every import into that space, and a fenced write that already entered is holding
 *  one of these guards across its physical write. */
export const withJobGuards = async <T>(
  jobIds: readonly string[],
  task: () => Promise<T>,
): Promise<T> => {
  const ordered = [...new Set(jobIds)].sort()
  const enter = async (index: number): Promise<T> =>
    index === ordered.length
      ? await task()
      : await withJobGuard(ordered[index], async () => await enter(index + 1))

  return await enter(0)
}

const PATH_COLUMNS = 'entry_key, destination_path, target_id, expected_id, ownership'

const entryOf = (row: PathRow): ImportReservationEntry => ({
  entryKey: row.entry_key,
  destinationPath: row.destination_path,
  targetId: row.target_id,
  expectedId: row.expected_id,
  ownership: row.ownership,
})

export const createImportReservationsFacet = (
  ctx: SqliteDriverCtx,
): ImportReservationsPersistence => {
  /** The job row as the reservation must see it: running, and ours. */
  const jobIsCurrent = (jobId: string, workerLease: string): boolean => {
    const row = ctx.required
      .prepare(`SELECT status, locked_by FROM jobs WHERE id = ?`)
      .get(jobId) as { status?: string; locked_by?: string | null } | undefined

    return row?.status === 'running' && row.locked_by === workerLease
  }

  const readReservation = (id: string): ImportReservation | null => {
    const row = ctx.required
      .prepare(
        `SELECT id, space, job_id, upload_ref, fence, status FROM import_reservations WHERE id = ?`,
      )
      .get(id) as ReservationRow | undefined

    if (!row) {
      return null
    }
    const paths = ctx.required
      .prepare(
        `SELECT ${PATH_COLUMNS}
           FROM import_reservation_paths WHERE reservation_id = ? ORDER BY entry_key`,
      )
      .all(row.id) as PathRow[]

    return {
      id: row.id,
      space: row.space,
      jobId: row.job_id,
      uploadRef: row.upload_ref,
      fence: row.fence,
      status: row.status,
      entries: paths.map(entryOf),
    }
  }

  /** The reservation header alone, plus the ONE claim a fenced write is about.
   *  Reading the whole reservation to find one row made every write cost the size
   *  of the import: a 10 000-note tree read 10 000 rows per note.
   *
   *  The claim is addressed by `(space, destination_path)` — the UNIQUE — and NOT by
   *  `(reservation_id, destination_path)`, which no index answers directly: the
   *  leading column of the primary key narrows it to this reservation and the rest
   *  is a walk of the whole batch for one row (10 000 claims: 630 µs per lookup on
   *  average, 1 235 µs on the last one, against 5 µs through the UNIQUE).
   *  The reservation is then a FILTER on the row the index found — a claim held by a
   *  rival import is not this write's, and reads back exactly like an unclaimed one. */
  const readClaim = (
    id: string,
    space: string,
    destinationPath: string,
  ): { header: ReservationRow; entry: ImportReservationEntry | null } | null => {
    const header = ctx.required
      .prepare(
        `SELECT id, space, job_id, upload_ref, fence, status FROM import_reservations WHERE id = ?`,
      )
      .get(id) as ReservationRow | undefined

    if (!header) {
      return null
    }
    const row = ctx.required
      .prepare(
        `SELECT reservation_id, ${PATH_COLUMNS}
           FROM import_reservation_paths
          WHERE space = ? AND destination_path = ?`,
      )
      .get(space, destinationPath) as (PathRow & { reservation_id: string }) | undefined

    return { header, entry: row?.reservation_id === header.id ? entryOf(row) : null }
  }

  const byUpload = (space: string, uploadRef: string): ReservationRow | undefined =>
    ctx.required
      .prepare(
        `SELECT id, space, job_id, upload_ref, fence, status
           FROM import_reservations WHERE space = ? AND upload_ref = ?`,
      )
      .get(space, uploadRef) as ReservationRow | undefined

  return {
    reserve: async ({ space, jobId, workerLease, uploadRef, entries, now }) => {
      await ctx.ensureInit()

      return await withJobGuard(jobId, async () => {
        // The job lease comes FIRST. A canceled or reaped job must not be able to
        // create a reservation it will then never clean up.
        if (!jobIsCurrent(jobId, workerLease)) {
          return {
            ok: false as const,
            reason: IMPORT_RESERVATION_REFUSAL.jobNotCurrent,
            detail: `job ${jobId} is not running under this lease`,
          }
        }
        const existing = byUpload(space, uploadRef)

        if (existing) {
          // Idempotent by upload: the same job reserving twice (a retry that got
          // past the plan) reads back the outcome it already has — and only it.
          return (
            reservationReuseRefusal(existing, jobId) ?? {
              ok: true as const,
              reservation: readReservation(existing.id)!,
            }
          )
        }
        const id = freshNoteId()
        const fence = freshNoteId()

        try {
          ctx.required.exec('BEGIN IMMEDIATE')
          ctx.required
            .prepare(
              `INSERT INTO import_reservations
                 (id, space, job_id, upload_ref, fence, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
            )
            .run(id, space, jobId, uploadRef, fence, now, now)
          const insert = ctx.required.prepare(
            `INSERT INTO import_reservation_paths
               (reservation_id, entry_key, space, destination_path, target_id, expected_id,
                ownership)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )

          for (const entry of entries) {
            insert.run(
              id,
              entry.entryKey,
              space,
              entry.destinationPath,
              entry.targetId,
              entry.expectedId,
              entry.ownership,
            )
          }
          ctx.required.exec('COMMIT')
        } catch (err) {
          ctx.required.exec('ROLLBACK')
          // The UNIQUE on (space, destination_path) IS the conflict: another live
          // import already owns one of these destinations, and it says so before
          // either of them writes a byte.
          if (/UNIQUE constraint failed: import_reservation_paths/.test(String(err))) {
            return {
              ok: false as const,
              reason: IMPORT_RESERVATION_REFUSAL.pathConflict,
              detail: 'another import already reserved one of these destinations',
            }
          }
          throw err
        }

        return { ok: true as const, reservation: readReservation(id)! }
      })
    },

    adopt: async ({ space, jobId, workerLease, uploadRef, now }) => {
      await ctx.ensureInit()

      return await withJobGuard(jobId, async () => {
        if (!jobIsCurrent(jobId, workerLease)) {
          return {
            ok: false as const,
            reason: IMPORT_RESERVATION_REFUSAL.jobNotCurrent,
            detail: `job ${jobId} is not running under this lease`,
          }
        }
        const existing = byUpload(space, uploadRef)

        if (!existing) {
          return {
            ok: false as const,
            reason: IMPORT_RESERVATION_REFUSAL.staleFence,
            detail: 'no reservation to adopt',
          }
        }
        // Taking it from another job is the POINT here, so only its status can
        // refuse: a row cleanup already started closing is not handed on.
        const refusal = reservationReuseRefusal(existing, null)

        if (refusal) {
          return refusal
        }
        // A NEW fence, and the job id moves with it: the previous run's fence is
        // now stale, which is exactly how its in-flight writes are stopped.
        const fence = freshNoteId()

        ctx.required
          .prepare(
            `UPDATE import_reservations SET fence = ?, job_id = ?, status = 'active', updated_at = ?
               WHERE id = ?`,
          )
          .run(fence, jobId, now, existing.id)

        return { ok: true as const, reservation: readReservation(existing.id)! }
      })
    },

    withFencedWrite: async (
      { reservationId, fence, jobId, workerLease, space, destinationPath },
      mutate,
    ) =>
      // The guard spans the premise check AND the caller's physical write. Every
      // status change of this job queues behind it, so a cancel that arrives
      // mid-write waits for that one entry instead of tearing it in half.
      await withJobGuard(jobId, async () => {
        await ctx.ensureInit()
        if (!jobIsCurrent(jobId, workerLease)) {
          throw new ImportFenceError(
            IMPORT_RESERVATION_REFUSAL.jobNotCurrent,
            `job ${jobId} is no longer running under this lease`,
          )
        }
        const claim = readClaim(reservationId, space, destinationPath)

        // `job_id` is checked with the fence, not left to the uniqueness of an
        // upload ref: adopt MOVES the job id, so a header owned by another job is
        // by construction a run this fence no longer belongs to.
        if (
          !claim ||
          claim.header.space !== space ||
          claim.header.job_id !== jobId ||
          claim.header.fence !== fence ||
          claim.header.status !== 'active'
        ) {
          throw new ImportFenceError(
            IMPORT_RESERVATION_REFUSAL.staleFence,
            'the reservation was closed or re-adopted under a newer fence',
          )
        }
        const entry = claim.entry

        // Not reserved by THIS import: either nobody claimed the destination or a
        // rival reservation holds it. Both are the same answer to this write — the
        // path is not its to publish into — and both stop it before the bytes.
        if (!entry) {
          throw new ImportFenceError(
            IMPORT_RESERVATION_REFUSAL.pathConflict,
            `${destinationPath} is not reserved by this import`,
          )
        }

        // Nothing is recorded after the write: the claim says what was PLANNED,
        // and a second row write could only ever repeat the question a crash
        // leaves open. The retry re-proves the destination physically.
        return await mutate({ ...entry, reservationId })
      }),

    forJob: async (jobId) => {
      await ctx.ensureInit()
      const row = ctx.required
        .prepare(
          `SELECT id, space, job_id, upload_ref, fence, status
             FROM import_reservations WHERE job_id = ?`,
        )
        .get(jobId) as ReservationRow | undefined

      return row ? readReservation(row.id) : null
    },

    // Nothing but the job id is needed, and that is the point: cleanup takes no
    // store, reads no file and cannot fail on a space whose store is gone. A claim
    // it cannot close is a destination nothing ever frees again.
    closeForJob: async ({ jobId, now }) => {
      await ctx.ensureInit()
      await withJobGuard(jobId, async () => {
        const row = ctx.required
          .prepare(`SELECT id FROM import_reservations WHERE job_id = ?`)
          .get(jobId) as { id: string } | undefined

        if (!row) {
          return
        }
        // Closing first, under the guard: a late write of this job now fails its
        // fence check instead of racing the cleanup. The two statements are one
        // synchronous step here, so `closing` is only ever observable to a process
        // that DIED between them — and reserve/adopt refuse that row rather than
        // reviving it.
        ctx.required
          .prepare(`UPDATE import_reservations SET status = 'closing', updated_at = ? WHERE id = ?`)
          .run(now, row.id)
        // The rows go together (paths cascade). No identity is touched by this: the
        // reservation only ever held a CLAIM on a path, so an existing-reference
        // destination loses its claim and keeps the note standing at it.
        ctx.required.prepare(`DELETE FROM import_reservations WHERE id = ?`).run(row.id)
      })
    },

    activeJobIds: async () => {
      await ctx.ensureInit()
      const rows = ctx.required
        .prepare(`SELECT DISTINCT job_id FROM import_reservations`)
        .all() as Array<{ job_id: string }>

      return rows.map((row) => row.job_id)
    },
  }
}
