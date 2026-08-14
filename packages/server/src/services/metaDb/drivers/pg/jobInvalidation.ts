// The two ways a run is invalidated from OUTSIDE it (#302): a cancel, and a
// reaper deciding its worker stalled.
//
// Both take the per-job fence first, and that is the whole point. A fenced import
// write proves its premise — this job is running, under this lease — and then
// publishes bytes, holding the fence throughout. An invalidation that skipped the
// fence could commit in exactly that window, and the write would land for a job
// that had already been canceled. Taking it makes the transition WAIT for an
// entered write instead of tearing it in half; the next write cannot start,
// because its own premise is then false.
//
// Deliberately NOT here: `release`, `succeed` and `fail`. A run performs those on
// itself, so there is nothing to interleave with — and routing them through the
// fence would only make a worker wait for its own lock.
// canon: docs/import.md#who-owns-a-destination-while-the-import-runs

import type pg from 'pg'

import { jobOfRow, type JobRow } from '../../rows'
import type { JobRecord } from '../../types'
import { lockImportJobAdvisory } from './lockOrder'

type FencedTask<T> = (client: pg.PoolClient) => Promise<T>

/** One transaction per job, because the fence is per job: a single statement over
 *  many rows cannot hold a lock that only exists per candidate.
 *
 *  Exported, and the callback's type is an alias rather than an inline signature,
 *  because the transaction register names a transaction after the method enclosing
 *  its `BEGIN` — an inline `task: (…) =>` reads to that scan exactly like a method
 *  head, and the transaction would be registered under a parameter's name. */
export const withJobFence = async <T>(
  pool: pg.Pool,
  jobId: string,
  task: FencedTask<T>,
): Promise<T> => {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await lockImportJobAdvisory(client, jobId)
    const result = await task(client)

    await client.query('COMMIT')

    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export const cancelJobFenced = async (pool: pg.Pool, id: string, now: string): Promise<boolean> =>
  await withJobFence(pool, id, async (client) => {
    const res = await client.query(
      `UPDATE jobs SET status = 'canceled', completed_at = $2, updated_at = $2,
           locked_at = NULL, locked_by = NULL
         WHERE id = $1 AND status IN ('pending', 'running')`,
      [id, now],
    )

    return (res.rowCount ?? 0) > 0
  })

export const reapStaleFenced = async (
  pool: pg.Pool,
  staleBefore: string,
  now: string,
): Promise<JobRecord[]> => {
  // Candidates are READ without a lock and re-checked under each job's fence. A
  // heartbeat that arrives in between revives its job, and the re-check is what
  // notices: a worker holding the fence through a long member keeps refreshing
  // `locked_at`, and must not be reaped for taking its time.
  const candidates = await pool.query(
    `SELECT id FROM jobs WHERE status = 'running' AND locked_at < $1 ORDER BY id`,
    [staleBefore],
  )
  const reaped: JobRecord[] = []

  for (const { id } of candidates.rows as Array<{ id: string }>) {
    const row = await withJobFence(pool, id, async (client) => {
      const reopened = await client.query(
        `UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL,
             error = 'reopened after stalled worker', updated_at = $1
           WHERE id = $3 AND status = 'running' AND locked_at < $2 AND attempts < max_attempts
           RETURNING *`,
        [now, staleBefore, id],
      )

      if (reopened.rows.length) {
        return reopened.rows[0] as JobRow
      }
      const failed = await client.query(
        `UPDATE jobs SET status = 'failed', completed_at = $1, locked_at = NULL,
             locked_by = NULL, error = 'stalled (max attempts reached)', updated_at = $1
           WHERE id = $3 AND status = 'running' AND locked_at < $2 AND attempts >= max_attempts
           RETURNING *`,
        [now, staleBefore, id],
      )

      return (failed.rows[0] as JobRow | undefined) ?? null
    })

    if (row) {
      reaped.push(jobOfRow(row))
    }
  }

  return reaped
}
