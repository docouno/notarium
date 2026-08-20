import { jobOfRow, type JobRow } from '../../rows'
import type { JobsPersistence } from '../../types'
import type { SqliteDriverCtx } from './context'
import { withJobGuard } from './importReservations'

export const createJobsFacet = (ctx: SqliteDriverCtx): JobsPersistence => ({
  enqueue: async (input) => {
    await ctx.ensureInit()
    const runAt = input.runAt ?? input.createdAt
    const row = ctx.required
      .prepare(
        `INSERT INTO jobs (id, space, kind, status, principal, params, progress_total,
             max_attempts, run_at, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
      )
      .get(
        input.id,
        input.space,
        input.kind,
        input.principal,
        input.params === undefined ? null : JSON.stringify(input.params),
        input.progressTotal ?? null,
        input.maxAttempts ?? 3,
        runAt,
        input.createdAt,
        input.createdAt,
      ) as JobRow
    return jobOfRow(row)
  },

  claimNext: async (workerId, kinds, now) => {
    await ctx.ensureInit()
    if (!kinds.length) {
      return null
    }
    const placeholders = kinds.map(() => '?').join(', ')
    const row = ctx.required
      .prepare(
        `UPDATE jobs SET
             status = 'running',
             locked_by = ?,
             locked_at = ?,
             started_at = COALESCE(started_at, ?),
             attempts = attempts + 1,
             updated_at = ?
           WHERE id = (
             SELECT id FROM jobs
             WHERE status = 'pending' AND run_at <= ? AND kind IN (${placeholders})
             ORDER BY run_at, created_at
             LIMIT 1
           )
           RETURNING *`,
      )
      .get(workerId, now, now, now, now, ...kinds) as JobRow | undefined
    return row ? jobOfRow(row) : null
  },

  heartbeat: async (id, workerId, p) => {
    await ctx.ensureInit()
    const res = ctx.required
      .prepare(
        `UPDATE jobs SET
             locked_at = ?,
             progress_done = ?,
             progress_total = CASE WHEN ? THEN ? ELSE progress_total END,
             phase = CASE WHEN ? THEN ? ELSE phase END,
             updated_at = ?
           WHERE id = ? AND locked_by = ? AND status = 'running'`,
      )
      .run(
        p.now,
        p.done,
        p.total !== undefined ? 1 : 0,
        p.total ?? null,
        p.phase !== undefined ? 1 : 0,
        p.phase ?? null,
        p.now,
        id,
        workerId,
      )
    return res.changes > 0
  },

  // Lease-guarded terminal write; returns false = row no longer ours → abort.
  // progress_done stays the handler's last report — NOT snapped to progress_total,
  // a whole-space estimate that would misreport a scope-narrowed export.
  // canon: docs/jobs.md#single-flight-the-hard-part
  succeed: async (id, workerId, out) => {
    await ctx.ensureInit()
    const res = ctx.required
      .prepare(
        `UPDATE jobs SET
             status = 'succeeded',
             result = ?,
             artifact_ref = ?,
             artifact_bytes = ?,
             artifact_name = ?,
             expires_at = ?,
             completed_at = ?,
             updated_at = ?,
             locked_at = NULL,
             locked_by = NULL,
             error = NULL
           WHERE id = ? AND locked_by = ? AND status = 'running'`,
      )
      .run(
        out.result === undefined ? null : JSON.stringify(out.result),
        out.artifactRef ?? null,
        out.artifactBytes ?? null,
        out.artifactName ?? null,
        out.expiresAt ?? null,
        out.now,
        out.now,
        id,
        workerId,
      )
    return res.changes > 0
  },

  fail: async (id, workerId, f) => {
    await ctx.ensureInit()
    const res = f.retryAt
      ? ctx.required
          .prepare(
            `UPDATE jobs SET status = 'pending', run_at = ?, error = ?,
                 locked_at = NULL, locked_by = NULL, updated_at = ?
               WHERE id = ? AND locked_by = ? AND status = 'running'`,
          )
          .run(f.retryAt, f.error, f.now, id, workerId)
      : ctx.required
          .prepare(
            `UPDATE jobs SET status = 'failed', error = ?, completed_at = ?,
                 result = COALESCE(?, result),
                 locked_at = NULL, locked_by = NULL, updated_at = ?
               WHERE id = ? AND locked_by = ? AND status = 'running'`,
          )
          .run(
            f.error,
            f.now,
            f.result === undefined ? null : JSON.stringify(f.result),
            f.now,
            id,
            workerId,
          )
    return res.changes > 0
  },

  // Invalidation from OUTSIDE the run queues behind that job's guard — the same
  // one its fenced import writes hold. A cancel arriving mid-member therefore
  // waits for that member instead of landing between its premise and its bytes;
  // the next write cannot start, because its premise is then false. The heartbeat
  // stays outside the guard, so a slow member can still keep its lease alive.
  cancel: async (id, now) =>
    await withJobGuard(id, async () => {
      await ctx.ensureInit()
      const res = ctx.required
        .prepare(
          `UPDATE jobs SET status = 'canceled', completed_at = ?, updated_at = ?,
               locked_at = NULL, locked_by = NULL
             WHERE id = ? AND status IN ('pending', 'running')`,
        )
        .run(now, now, id)

      return res.changes > 0
    }),

  release: async (id, workerId, now) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `UPDATE jobs SET status = 'pending', attempts = MAX(attempts - 1, 0),
             locked_at = NULL, locked_by = NULL, updated_at = ?
           WHERE id = ? AND locked_by = ? AND status = 'running'`,
      )
      .run(now, id, workerId)
  },

  get: async (id) => {
    await ctx.ensureInit()
    const row = ctx.required.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
      JobRow | undefined
    return row ? jobOfRow(row) : null
  },

  list: async (space, opts) => {
    await ctx.ensureInit()
    const where: string[] = ['space = ?']
    const args: string[] = [space]

    if (opts?.principal) {
      where.push('principal = ?')
      args.push(opts.principal)
    }
    if (opts?.kind) {
      where.push('kind = ?')
      args.push(opts.kind)
    }
    if (opts?.statuses?.length) {
      where.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`)
      args.push(...opts.statuses)
    }
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500))
    const rows = ctx.required
      .prepare(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, limit) as JobRow[]
    return rows.map(jobOfRow)
  },

  reapStale: async (staleBefore, now) => {
    await ctx.ensureInit()
    const db = ctx.required
    // Candidates are read first and re-checked under each job's guard: a heartbeat
    // arriving in between revives its job, and a worker that holds the guard
    // through a long member is exactly the job that must NOT be reaped.
    // canon: docs/jobs.md#delivery-and-recovery
    const candidates = db
      .prepare(`SELECT id FROM jobs WHERE status = 'running' AND locked_at < ? ORDER BY id`)
      .all(staleBefore) as Array<{ id: string }>
    const reaped: JobRow[] = []

    for (const { id } of candidates) {
      const row = await withJobGuard(id, async () => {
        const reopened = db
          .prepare(
            `UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL,
                 error = 'reopened after stalled worker', updated_at = ?
               WHERE id = ? AND status = 'running' AND locked_at < ? AND attempts < max_attempts
               RETURNING *`,
          )
          .all(now, id, staleBefore) as JobRow[]

        if (reopened.length) {
          return reopened[0]
        }
        const failed = db
          .prepare(
            `UPDATE jobs SET status = 'failed', completed_at = ?, locked_at = NULL,
                 locked_by = NULL, error = 'stalled (max attempts reached)', updated_at = ?
               WHERE id = ? AND status = 'running' AND locked_at < ? AND attempts >= max_attempts
               RETURNING *`,
          )
          .all(now, now, id, staleBefore) as JobRow[]

        return failed[0] ?? null
      })

      if (row) {
        reaped.push(row)
      }
    }

    return reaped.map(jobOfRow)
  },

  findExpired: async (now, limit) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT * FROM jobs WHERE artifact_ref IS NOT NULL AND expires_at IS NOT NULL
             AND expires_at < ? ORDER BY expires_at LIMIT ?`,
      )
      .all(now, Math.max(1, Math.min(limit ?? 100, 1000))) as JobRow[]
    return rows.map(jobOfRow)
  },

  clearArtifact: async (id, now) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `UPDATE jobs SET artifact_ref = NULL, artifact_bytes = NULL, expires_at = NULL,
             updated_at = ? WHERE id = ?`,
      )
      .run(now, id)
  },

  prune: async (before) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `DELETE FROM jobs WHERE status IN ('succeeded', 'failed', 'canceled')
             AND artifact_ref IS NULL AND updated_at < ?
    -- Fail-closed against retention deleting the evidence a live import still
    -- points at: while a reservation references this job, its terminal row is the
    -- only thing that can prove what the run had already done.
    -- canon: docs/import.md#importing-a-markdown-tree-302
             AND NOT EXISTS (SELECT 1 FROM import_reservations r WHERE r.job_id = jobs.id)`,
      )
      .run(before)
  },
})
