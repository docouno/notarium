// One executable contract for import path reservations (#302), held by both
// dialects. They reach it by opposite means — SQLite by a process-owned per-job
// ordering, PostgreSQL by the L0j advisory and the L1r/L1p tiers — so a behaviour
// asserted here is the only thing a caller may rely on.
//
// The invariants under test are all about the WINDOW between planning an import and
// its last write: who may claim a destination, who may still write under a lease
// that was taken away, and what happens to the claims when the run ends however it
// ends. What this facet arbitrates is a PATH — the ids are the planner's, and a
// colliding one is refused where the bytes land, not here.

import { describe, expect, it } from 'vitest'

import { ImportFenceError } from '../../packages/server/src/services/metaDb/importFence'
import type {
  ImportReservationEntryInput,
  ImportReservationsPersistence,
  JobsPersistence,
} from '../../packages/server/src/services/metaDb/types'

export type ImportReservationsContractFactory = () => Promise<{
  reservations: ImportReservationsPersistence
  jobs: JobsPersistence
  /** The whole-space erase, so the contract can hold it to the claims too: a purge
   *  that leaves them behind holds destinations in a space that no longer exists. */
  purgeSpace: (space: string) => Promise<void>
  teardown?: () => Promise<void>
}>

const T = (n: number): string => `2026-08-14T00:${String(n).padStart(2, '0')}:00.000Z`

const entry = (over: Partial<ImportReservationEntryInput> = {}): ImportReservationEntryInput => ({
  entryKey: 'vault/a.md',
  destinationPath: 'imported/vault/a.md',
  targetId: 'target-a',
  expectedId: null,
  ownership: 'fresh-owned',
  ...over,
})

type FencedInput = Parameters<ImportReservationsPersistence['withFencedWrite']>[0]

/** Long enough for a statement that is NOT blocked to have reached the database and
 *  come back — including one that crosses a container boundary. It bounds nothing:
 *  every case below states its own outcome, and this only decides when to look. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

/** A write the fence must refuse — asserted on the CALLBACK, not only on the
 *  rejection. "The premise is proved before the bytes" is the whole invariant of
 *  this facet, and a driver that ran `mutate` first and threw afterwards satisfies
 *  every `rejects.toBeInstanceOf` in this file while publishing the note. */
const refusedWrite = async (
  reservations: ImportReservationsPersistence,
  input: FencedInput,
  reason?: string,
): Promise<void> => {
  let entered = false
  // Resolved OR rejected, then judged: `rejects.toBeInstanceOf` alone reports a write
  // that WENT THROUGH as "expected a rejection", which reads like a flake rather than
  // like bytes on disk.
  const outcome: unknown = await reservations
    .withFencedWrite(input, async () => {
      entered = true

      return 'published' as const
    })
    .then(
      (value) => value,
      (error: unknown) => error,
    )

  expect(outcome).toBeInstanceOf(ImportFenceError)
  if (reason !== undefined) {
    expect((outcome as ImportFenceError).reason).toBe(reason)
  }
  expect(entered, 'the refused write entered its mutation').toBe(false)
}

export const describeImportReservationsContract = (
  name: string,
  factory: ImportReservationsContractFactory,
): void => {
  describe(`import reservations (${name})`, () => {
    /** A running job under a known lease — the premise every path below proves. */
    const running = async (
      jobs: JobsPersistence,
      id: string,
      lease: string,
      space = 'main',
    ): Promise<void> => {
      await jobs.enqueue({
        id,
        space,
        kind: 'import',
        principal: 'user:al',
        createdAt: T(0),
      })
      const claimed = await jobs.claimNext(lease, ['import'], T(1))

      expect(claimed?.id).toBe(id)
    }

    it('claims the batch, and reads it back for the same upload', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        const first = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry(), entry({ entryKey: 'vault/b.md', destinationPath: 'imported/b.md' })],
          now: T(2),
        })

        expect(first.ok).toBe(true)
        // Idempotent by upload: a retry that already planned must not arbitrate
        // twice, or the second pass would mint a second set of claims.
        const again = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(3),
        })

        expect(again.ok && again.reservation.id).toBe(first.ok && first.reservation.id)
        expect(again.ok && again.reservation.entries).toHaveLength(2)
      } finally {
        await teardown?.()
      }
    })

    it('refuses a second import that wants a destination this one holds', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        await running(jobs, 'job-2', 'lease-2')
        await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(2),
        })
        const rival = await reservations.reserve({
          space: 'main',
          jobId: 'job-2',
          workerLease: 'lease-2',
          uploadRef: 'upload-2',
          entries: [entry({ entryKey: 'other/a.md' })],
          now: T(3),
        })

        expect(rival).toMatchObject({ ok: false, reason: 'path_conflict' })
        // Refused BEFORE any of its own claims survive: a half-created reservation
        // would hold paths for an import that never starts.
        expect(await reservations.forJob('job-2')).toBeNull()
      } finally {
        await teardown?.()
      }
    })

    it('refuses every path to a job that is not running under this lease', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        await jobs.cancel('job-1', T(2))
        const late = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(3),
        })

        expect(late).toMatchObject({ ok: false, reason: 'job_not_current' })
        // A terminal job may not leave a reservation behind for cleanup to find.
        expect(await reservations.forJob('job-1')).toBeNull()
      } finally {
        await teardown?.()
      }
    })

    it('hands the write the PLAN it must land, under the current fence', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        const taken = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(2),
        })

        expect(taken.ok).toBe(true)
        if (!taken.ok) {
          return
        }
        const wrote = await reservations.withFencedWrite(
          {
            reservationId: taken.reservation.id,
            fence: taken.reservation.fence,
            jobId: 'job-1',
            workerLease: 'lease-1',
            space: 'main',
            destinationPath: 'imported/vault/a.md',
          },
          async (fenced) => {
            // What the caller is handed is the PLAN, not a lookup it repeats: the
            // id it must write and the owner it must expect on disk.
            expect(fenced.targetId).toBe('target-a')
            expect(fenced.expectedId).toBeNull()

            return 'published' as const
          },
        )

        expect(wrote).toBe('published')
        const after = await reservations.forJob('job-1')

        // The claim is unchanged by the write. Recording "it landed" would be a
        // second write with a crash window of its own, and it could never say more
        // than the plan already does — the destination itself is the arbiter.
        expect(after?.entries).toEqual(taken.reservation.entries)
      } finally {
        await teardown?.()
      }
    })

    it('hands the write the claim of the DESTINATION it asked for, not the first one', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        const taken = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [
            entry({ entryKey: 'vault/a.md', destinationPath: 'imported/a.md', targetId: 'id-a' }),
            entry({ entryKey: 'vault/b.md', destinationPath: 'imported/b.md', targetId: 'id-b' }),
            entry({
              entryKey: 'vault/c.md',
              destinationPath: 'imported/c.md',
              targetId: 'id-c',
              expectedId: 'id-c',
              ownership: 'existing-reference',
            }),
          ],
          now: T(2),
        })

        expect(taken.ok).toBe(true)
        if (!taken.ok) {
          return
        }
        // Every claim of the batch, addressed one at a time and out of entry order: a
        // lookup that ignored `destinationPath` and took whatever row the reservation
        // yields first passes a one-claim fixture and lands the WRONG plan on every
        // note of a real import.
        for (const want of taken.reservation.entries.slice().reverse()) {
          const handed = await reservations.withFencedWrite(
            {
              reservationId: taken.reservation.id,
              fence: taken.reservation.fence,
              jobId: 'job-1',
              workerLease: 'lease-1',
              space: 'main',
              destinationPath: want.destinationPath,
            },
            async (fenced) => fenced,
          )

          expect(handed).toEqual({ ...want, reservationId: taken.reservation.id })
        }
      } finally {
        await teardown?.()
      }
    })

    it('refuses a write into a destination this import never claimed', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        const taken = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry(), entry({ entryKey: 'vault/b.md', destinationPath: 'imported/b.md' })],
          now: T(2),
        })

        expect(taken.ok).toBe(true)
        if (!taken.ok) {
          return
        }
        // The premise a fenced write sells is "this reservation owns THIS path". A
        // path nobody reserved is the case that proves the premise is checked at all
        // — every other refusal here is about the header, which is found by id.
        await refusedWrite(
          reservations,
          {
            reservationId: taken.reservation.id,
            fence: taken.reservation.fence,
            jobId: 'job-1',
            workerLease: 'lease-1',
            space: 'main',
            destinationPath: 'imported/never-planned.md',
          },
          'path_conflict',
        )
      } finally {
        await teardown?.()
      }
    })

    it('refuses a write into a destination another live import holds', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        await running(jobs, 'job-2', 'lease-2')
        const mine = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(2),
        })
        const rival = await reservations.reserve({
          space: 'main',
          jobId: 'job-2',
          workerLease: 'lease-2',
          uploadRef: 'upload-2',
          entries: [entry({ entryKey: 'other/r.md', destinationPath: 'imported/rival.md' })],
          now: T(3),
        })

        expect(mine.ok && rival.ok).toBe(true)
        if (!mine.ok) {
          return
        }
        // A claim STANDS at this destination — it is simply not this import's. The
        // path is arbitrated by (space, destination_path), so a lookup keyed on it
        // finds the rival's row; handing that row over would let one import write the
        // other's plan under its own fence.
        await refusedWrite(
          reservations,
          {
            reservationId: mine.reservation.id,
            fence: mine.reservation.fence,
            jobId: 'job-1',
            workerLease: 'lease-1',
            space: 'main',
            destinationPath: 'imported/rival.md',
          },
          'path_conflict',
        )
      } finally {
        await teardown?.()
      }
    })

    it('stops a reaped worker that still holds the CURRENT fence', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        const first = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(2),
        })

        expect(first.ok).toBe(true)
        if (!first.ok) {
          return
        }
        // Reclaimed, and NOT yet adopted: the fence in the database is still the one
        // the old worker holds, so nothing but the lease can tell them apart. This is
        // the real shape of the race — a reaped worker resumes before its successor
        // has taken the reservation over.
        await jobs.release('job-1', 'lease-1', T(3))
        const reclaimed = await jobs.claimNext('lease-2', ['import'], T(4))

        expect(reclaimed?.id).toBe('job-1')
        expect((await reservations.forJob('job-1'))?.fence).toBe(first.reservation.fence)
        await refusedWrite(reservations, {
          reservationId: first.reservation.id,
          fence: first.reservation.fence,
          jobId: 'job-1',
          workerLease: 'lease-1',
          space: 'main',
          destinationPath: 'imported/vault/a.md',
        })
        // The successor adopts and gets a fence of its own; the old one is now stale
        // twice over.
        const adopted = await reservations.adopt({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-2',
          uploadRef: 'upload-1',
          now: T(5),
        })

        expect(adopted.ok).toBe(true)
        expect(adopted.ok && adopted.reservation.fence).not.toBe(first.reservation.fence)
      } finally {
        await teardown?.()
      }
    })

    it('refuses a write under a superseded fence even when the lease is still ours', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        const first = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(2),
        })

        expect(first.ok).toBe(true)
        if (!first.ok) {
          return
        }
        // Adopted by the SAME worker: the lease never changes, so nothing but the
        // fence can tell the two runs apart. Without this the zombie case below
        // would pass on the lease check alone and prove nothing about fencing.
        const again = await reservations.adopt({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          now: T(3),
        })

        expect(again.ok && again.reservation.fence).not.toBe(first.reservation.fence)
        await refusedWrite(reservations, {
          reservationId: first.reservation.id,
          fence: first.reservation.fence,
          jobId: 'job-1',
          workerLease: 'lease-1',
          space: 'main',
          destinationPath: 'imported/vault/a.md',
        })
        // And the current fence still writes: the refusal is about the fence, not
        // about the reservation having become unusable.
        await expect(
          reservations.withFencedWrite(
            {
              reservationId: first.reservation.id,
              fence: (again.ok && again.reservation.fence) as string,
              jobId: 'job-1',
              workerLease: 'lease-1',
              space: 'main',
              destinationPath: 'imported/vault/a.md',
            },
            async () => 'published' as const,
          ),
        ).resolves.toBe('published')
      } finally {
        await teardown?.()
      }
    })

    it('makes a cancel wait for the member being written, not tear it in half', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        const taken = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry(), entry({ entryKey: 'vault/b.md', destinationPath: 'imported/b.md' })],
          now: T(2),
        })

        expect(taken.ok).toBe(true)
        if (!taken.ok) {
          return
        }
        const order: string[] = []
        let releaseWrite!: () => void
        const inFlight = new Promise<void>((resolve) => {
          releaseWrite = resolve
        })
        const write = reservations.withFencedWrite(
          {
            reservationId: taken.reservation.id,
            fence: taken.reservation.fence,
            jobId: 'job-1',
            workerLease: 'lease-1',
            space: 'main',
            destinationPath: 'imported/vault/a.md',
          },
          async () => {
            order.push('write:start')
            await inFlight
            order.push('write:end')
          },
        )

        // The cancel arrives with the member still open. It must not commit until
        // the bytes are done: an invalidation that landed here would leave a write
        // that proved a premise the row no longer holds.
        const canceled = jobs.cancel('job-1', T(3)).then(() => order.push('cancel'))

        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(order).toEqual(['write:start'])
        releaseWrite()
        await write
        await canceled

        expect(order).toEqual(['write:start', 'write:end', 'cancel'])
        // And the NEXT write cannot start: its premise is now false.
        await refusedWrite(reservations, {
          reservationId: taken.reservation.id,
          fence: taken.reservation.fence,
          jobId: 'job-1',
          workerLease: 'lease-1',
          space: 'main',
          destinationPath: 'imported/b.md',
        })
      } finally {
        await teardown?.()
      }
    })

    it('frees every destination it held, whoever owned the identity behind it', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        const taken = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [
            entry(),
            entry({ entryKey: 'vault/b.md', destinationPath: 'imported/b.md' }),
            // Pointed at, never owned. Dropping its CLAIM frees the path and says
            // nothing about the note standing there — this layer holds paths.
            entry({
              entryKey: 'vault/c.md',
              destinationPath: 'imported/c.md',
              ownership: 'existing-reference',
              expectedId: 'existing-c',
              targetId: 'existing-c',
            }),
          ],
          now: T(2),
        })

        expect(taken.ok).toBe(true)
        if (!taken.ok) {
          return
        }
        await reservations.withFencedWrite(
          {
            reservationId: taken.reservation.id,
            fence: taken.reservation.fence,
            jobId: 'job-1',
            workerLease: 'lease-1',
            space: 'main',
            destinationPath: 'imported/vault/a.md',
          },
          async () => undefined,
        )
        await reservations.closeForJob({ jobId: 'job-1', now: T(6) })

        expect(await reservations.forJob('job-1')).toBeNull()
        expect(await reservations.activeJobIds()).not.toContain('job-1')
        // Every path is claimable again — the written one, the never-written one
        // and the one that pointed at somebody else's note alike.
        await running(jobs, 'job-2', 'lease-2')
        const next = await reservations.reserve({
          space: 'main',
          jobId: 'job-2',
          workerLease: 'lease-2',
          uploadRef: 'upload-2',
          entries: [
            entry({ entryKey: 'again/a.md' }),
            entry({ entryKey: 'again/b.md', destinationPath: 'imported/b.md' }),
            entry({ entryKey: 'again/c.md', destinationPath: 'imported/c.md' }),
          ],
          now: T(7),
        })

        expect(next.ok).toBe(true)
      } finally {
        await teardown?.()
      }
    })

    it('closes the claims of a space that is being erased', async () => {
      const { reservations, jobs, purgeSpace, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        await running(jobs, 'job-2', 'lease-2', 'other')
        await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(2),
        })
        await reservations.reserve({
          space: 'other',
          jobId: 'job-2',
          workerLease: 'lease-2',
          uploadRef: 'upload-2',
          entries: [entry()],
          now: T(2),
        })
        // The purge takes the job rows of that space with it, so a claim left behind
        // would hold a destination in a space that no longer exists AND keep terminal
        // cleanup circling a job row it can never find.
        await purgeSpace('main')

        expect(await reservations.forJob('job-1')).toBeNull()
        expect(await reservations.activeJobIds()).toEqual(['job-2'])
        // The neighbour space keeps its claims: a purge is scoped, not a sweep.
        expect((await reservations.forJob('job-2'))?.entries).toHaveLength(1)
      } finally {
        await teardown?.()
      }
    })

    it('makes a whole-space erase wait for the member being written', async () => {
      const { reservations, jobs, purgeSpace, teardown } = await factory()

      let releaseWrite = (): void => {}

      try {
        await running(jobs, 'job-1', 'lease-1')
        const taken = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry(), entry({ entryKey: 'vault/b.md', destinationPath: 'imported/b.md' })],
          now: T(2),
        })

        expect(taken.ok).toBe(true)
        if (!taken.ok) {
          return
        }
        const order: string[] = []
        const inFlight = new Promise<void>((resolve) => {
          releaseWrite = resolve
        })
        const write = reservations.withFencedWrite(
          {
            reservationId: taken.reservation.id,
            fence: taken.reservation.fence,
            jobId: 'job-1',
            workerLease: 'lease-1',
            space: 'main',
            destinationPath: 'imported/vault/a.md',
          },
          async () => {
            order.push('write:start')
            await inFlight
            order.push('write:end')
          },
        )

        await settle()
        // The erase drops the claims of every import into this space — including the
        // one the open member is publishing against. Pulling that row out mid-write
        // would leave a note landing under a premise the database no longer holds, so
        // the erase is an invalidation like a cancel and queues behind the bytes.
        const erased = purgeSpace('main').then(() => order.push('purge'))

        await settle()
        expect(order, 'the erase went ahead of the member being written').toEqual(['write:start'])
        releaseWrite()
        await write
        await erased

        expect(order).toEqual(['write:start', 'write:end', 'purge'])
        expect(await reservations.forJob('job-1')).toBeNull()
      } finally {
        releaseWrite()
        await teardown?.()
      }
    })

    it('keeps retention from deleting the row a live claim points at', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(2),
        })
        await jobs.fail('job-1', 'lease-1', { error: 'plan conflict', now: T(3) })
        // Old enough to prune by any policy — and still referenced, which is the
        // whole point: the terminal row is the evidence cleanup runs on, so the
        // guard lives in the delete itself rather than in the order of callers.
        await jobs.prune(T(59))

        expect(await jobs.get('job-1')).not.toBeNull()

        await reservations.closeForJob({ jobId: 'job-1', now: T(4) })
        await jobs.prune(T(59))

        expect(await jobs.get('job-1')).toBeNull()
      } finally {
        await teardown?.()
      }
    })

    it('refuses to hand this upload to a job that does not already hold it', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        await running(jobs, 'job-2', 'lease-2')
        const first = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(2),
        })

        expect(first.ok).toBe(true)
        if (!first.ok) {
          return
        }
        // The same upload, a DIFFERENT job. Reading the row back would hand job-2 a
        // fence over destinations that closing job-2 never finds — the claims live
        // under job-1, so nothing would ever release them.
        const stranger = await reservations.reserve({
          space: 'main',
          jobId: 'job-2',
          workerLease: 'lease-2',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(3),
        })

        expect(stranger).toMatchObject({ ok: false, reason: 'path_conflict' })
        expect((await reservations.forJob('job-1'))?.id).toBe(first.reservation.id)
        expect(await reservations.forJob('job-2')).toBeNull()
        // Nor may it write under the fence it was handed for another job's row.
        await refusedWrite(reservations, {
          reservationId: first.reservation.id,
          fence: first.reservation.fence,
          jobId: 'job-2',
          workerLease: 'lease-2',
          space: 'main',
          destinationPath: 'imported/vault/a.md',
        })
        // Taking it over is `adopt`, and that one is allowed — it re-fences.
        const adopted = await reservations.adopt({
          space: 'main',
          jobId: 'job-2',
          workerLease: 'lease-2',
          uploadRef: 'upload-1',
          now: T(4),
        })

        expect(adopted.ok && adopted.reservation.jobId).toBe('job-2')
      } finally {
        await teardown?.()
      }
    })

    it('keeps a live member alive: the heartbeat is outside the fence, the reaper inside it', async () => {
      const { reservations, jobs, teardown } = await factory()

      let releaseWrite = (): void => {}

      try {
        await running(jobs, 'job-1', 'lease-1')
        const taken = await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry(), entry({ entryKey: 'vault/b.md', destinationPath: 'imported/b.md' })],
          now: T(2),
        })

        expect(taken.ok).toBe(true)
        if (!taken.ok) {
          return
        }
        const order: string[] = []
        const inFlight = new Promise<void>((resolve) => {
          releaseWrite = resolve
        })
        // A member that takes longer than the whole stale window. This is the shape
        // the two mechanisms exist for, and they must not cancel each other out.
        const write = reservations.withFencedWrite(
          {
            reservationId: taken.reservation.id,
            fence: taken.reservation.fence,
            jobId: 'job-1',
            workerLease: 'lease-1',
            space: 'main',
            destinationPath: 'imported/vault/a.md',
          },
          async () => {
            order.push('write:start')
            await inFlight
            order.push('write:end')
          },
        )

        await settle()
        // The reaper reads its candidates FIRST — the lease is stale by the clock,
        // and by that clock alone this job is dead — and then waits for the fence.
        const reaping = jobs.reapStale(T(5), T(6)).then((reaped) => {
          order.push('reap')

          return reaped
        })

        await settle()
        // The heartbeat does NOT queue behind the write. A lease that can only be
        // renewed between members is no lease for a job whose member IS the slow
        // part: the renewal would arrive after the reaper had already decided.
        const beat = await Promise.race([
          jobs.heartbeat('job-1', 'lease-1', { done: 1, now: T(9) }),
          new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 500)),
        ])

        expect(beat, 'the heartbeat queued behind the fenced write').toBe(true)
        order.push('heartbeat')

        await settle()
        // Still nothing decided: the reaper is holding at the fence, which is what
        // gives the heartbeat above a window to land in at all.
        expect(order).toEqual(['write:start', 'heartbeat'])
        releaseWrite()
        await write

        // And now it re-reads: a candidate list is a guess taken outside the
        // exclusion, so the decision is made again inside it, on a fresh row.
        expect(await reaping).toEqual([])
        expect(order).toEqual(['write:start', 'heartbeat', 'write:end', 'reap'])
        const alive = await jobs.get('job-1')

        expect(alive?.status).toBe('running')
        expect(alive?.lockedBy).toBe('lease-1')
        expect(alive?.lockedAt).toBe(T(9))
        // And the invalidation that is NOT about staleness still lands, through the
        // same fence: cancel waits for the member, then terminalizes the run.
        expect(await jobs.cancel('job-1', T(10))).toBe(true)
        expect((await jobs.get('job-1'))?.status).toBe('canceled')
        await refusedWrite(reservations, {
          reservationId: taken.reservation.id,
          fence: taken.reservation.fence,
          jobId: 'job-1',
          workerLease: 'lease-1',
          space: 'main',
          destinationPath: 'imported/b.md',
        })
      } finally {
        // A failed expectation must not strand the in-flight member: the guard it
        // holds would outlive the test and hang the teardown.
        releaseWrite()
        await teardown?.()
      }
    })

    it('is idempotent at the terminal edge: closing twice is not an error', async () => {
      const { reservations, jobs, teardown } = await factory()

      try {
        await running(jobs, 'job-1', 'lease-1')
        await reservations.reserve({
          space: 'main',
          jobId: 'job-1',
          workerLease: 'lease-1',
          uploadRef: 'upload-1',
          entries: [entry()],
          now: T(2),
        })
        await reservations.closeForJob({ jobId: 'job-1', now: T(3) })
        await expect(
          reservations.closeForJob({ jobId: 'job-1', now: T(4) }),
        ).resolves.toBeUndefined()
      } finally {
        await teardown?.()
      }
    })
  })
}
