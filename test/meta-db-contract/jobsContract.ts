// The terminal edge of the durable job queue, held by BOTH dialects.
//
// WHY it exists as a contract rather than as SQLite unit tests. The two drivers write
// this edge differently — SQLite runs `fail` as one statement, PostgreSQL runs the
// reaper through the per-job advisory of `jobInvalidation` — so a case proved on
// SQLite says nothing about the path Postgres actually takes. `fail(result)` and
// `reapStale` were exactly that: covered under `describe('SqliteMetaDb')` and
// unexercised against a live Postgres.
//
// Deliberately minimal. The whole lifecycle is exercised in the SQLite unit suite;
// what belongs HERE is the part where the two dialects could silently disagree — a
// terminal outcome, a lease that is no longer ours, and a stalled worker.
// canon: docs/jobs.md#delivery-and-recovery

import { describe, expect, it } from 'vitest'

import type { JobsPersistence } from '../../packages/server/src/services/metaDb/types'

export type JobsContractFactory = () => Promise<{
  jobs: JobsPersistence
  teardown?: () => Promise<void>
}>

const T = (n: number): string => `2026-08-14T00:${String(n).padStart(2, '0')}:00.000Z`

export const describeJobsContract = (name: string, factory: JobsContractFactory): void => {
  describe(`jobs lifecycle (${name})`, () => {
    const enqueue = async (
      jobs: JobsPersistence,
      id: string,
      over: { maxAttempts?: number } = {},
    ): Promise<void> => {
      await jobs.enqueue({
        id,
        space: 'main',
        kind: 'export',
        principal: 'user:al',
        createdAt: T(0),
        ...over,
      })
    }

    it('carries a bounded result out of a TERMINAL failure, and never out of a retry', async () => {
      const { jobs, teardown } = await factory()

      try {
        await enqueue(jobs, 'job-1')
        expect((await jobs.claimNext('lease-1', ['export'], T(1)))?.id).toBe('job-1')
        // A retryable failure is an attempt, not an outcome: the run will happen
        // again, so publishing a partial summary now would publish a lie.
        expect(
          await jobs.fail('job-1', 'lease-1', {
            error: 'transient',
            retryAt: T(30),
            now: T(2),
            result: { imported: 7 },
          }),
        ).toBe(true)
        const retrying = await jobs.get('job-1')

        expect(retrying?.status).toBe('pending')
        expect(retrying?.runAt).toBe(T(30))
        expect(retrying?.result).toBeNull()

        expect((await jobs.claimNext('lease-2', ['export'], T(31)))?.id).toBe('job-1')
        // A terminal one is the last word this row will ever have, so what the run
        // did manage to do travels with it (an import's partial summary).
        expect(
          await jobs.fail('job-1', 'lease-2', {
            error: 'plan conflict',
            now: T(32),
            result: { imported: 7, failed: 1 },
          }),
        ).toBe(true)
        const failed = await jobs.get('job-1')

        expect(failed?.status).toBe('failed')
        expect(failed?.error).toBe('plan conflict')
        expect(failed?.result).toEqual({ imported: 7, failed: 1 })
        expect(failed?.completedAt).toBe(T(32))
      } finally {
        await teardown?.()
      }
    })

    it('refuses a terminal write from a lease that is no longer ours', async () => {
      const { jobs, teardown } = await factory()

      try {
        await enqueue(jobs, 'job-1')
        await jobs.claimNext('lease-1', ['export'], T(1))
        // The reaped-and-reclaimed worker reviving: its `fail` must not overwrite the
        // peer that now owns the row, nor a cancel that already landed.
        expect(await jobs.fail('job-1', 'stale-lease', { error: 'boom', now: T(2) })).toBe(false)
        expect(await jobs.succeed('job-1', 'stale-lease', { now: T(2) })).toBe(false)
        const untouched = await jobs.get('job-1')

        expect(untouched?.status).toBe('running')
        expect(untouched?.lockedBy).toBe('lease-1')
        expect(untouched?.error).toBeNull()
      } finally {
        await teardown?.()
      }
    })

    it('reaps a stalled worker: retries left reopen it, an exhausted budget fails it', async () => {
      const { jobs, teardown } = await factory()

      try {
        await enqueue(jobs, 'live')
        await enqueue(jobs, 'dead', { maxAttempts: 1 })
        await jobs.claimNext('lease-1', ['export'], T(1))
        await jobs.claimNext('lease-2', ['export'], T(1))
        const reaped = await jobs.reapStale(T(50), T(51))

        expect(Object.fromEntries(reaped.map((job) => [job.id, job.status]))).toEqual({
          live: 'pending',
          dead: 'failed',
        })
        const live = await jobs.get('live')

        // Reopened means claimable again, by anyone: the lease is gone with it.
        expect(live?.status).toBe('pending')
        expect(live?.lockedBy).toBeNull()
        expect(live?.lockedAt).toBeNull()
        expect((await jobs.get('dead'))?.status).toBe('failed')
        // A fresh lease is nothing to reap: staleness is read off the row, not off
        // the fact that this candidate was stale a moment ago.
        expect((await jobs.claimNext('lease-3', ['export'], T(55)))?.id).toBe('live')
        expect(await jobs.reapStale(T(50), T(56))).toEqual([])
        expect((await jobs.get('live'))?.lockedBy).toBe('lease-3')
      } finally {
        await teardown?.()
      }
    })
  })
}
