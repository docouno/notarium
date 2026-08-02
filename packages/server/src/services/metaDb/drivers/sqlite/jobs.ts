import { jobOfRow, type JobRow } from '../../rows'
import type { JobsPersistence } from '../../types'
import type { SqliteDriverCtx } from './context'

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
             progress_total = COALESCE(?, progress_total),
             phase = COALESCE(?, phase),
             updated_at = ?
           WHERE id = ? AND locked_by = ? AND status = 'running'`,
      )
      .run(p.now, p.done, p.total ?? null, p.phase ?? null, p.now, id, workerId)
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
                 locked_at = NULL, locked_by = NULL, updated_at = ?
               WHERE id = ? AND locked_by = ? AND status = 'running'`,
          )
          .run(f.error, f.now, f.now, id, workerId)
    return res.changes > 0
  },

  cancel: async (id, now) => {
    await ctx.ensureInit()
    const res = ctx.required
      .prepare(
        `UPDATE jobs SET status = 'canceled', completed_at = ?, updated_at = ?,
             locked_at = NULL, locked_by = NULL
           WHERE id = ? AND status IN ('pending', 'running')`,
      )
      .run(now, now, id)
    return res.changes > 0
  },

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
    // canon: docs/jobs.md#delivery-and-recovery
    const reopened = db
      .prepare(
        `UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL,
             error = 'reopened after stalled worker', updated_at = ?
           WHERE status = 'running' AND locked_at < ? AND attempts < max_attempts
           RETURNING *`,
      )
      .all(now, staleBefore) as JobRow[]
    const failed = db
      .prepare(
        `UPDATE jobs SET status = 'failed', completed_at = ?, locked_at = NULL,
             locked_by = NULL, error = 'stalled (max attempts reached)', updated_at = ?
           WHERE status = 'running' AND locked_at < ? AND attempts >= max_attempts
           RETURNING *`,
      )
      .all(now, now, staleBefore) as JobRow[]
    return [...reopened, ...failed].map(jobOfRow)
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
             AND artifact_ref IS NULL AND updated_at < ?`,
      )
      .run(before)
  },
})
