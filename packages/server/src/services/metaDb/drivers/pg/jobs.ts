import { jobOfRow, type JobRow } from '../../rows'
import type { JobsPersistence, JobStatus } from '../../types'
import type { PgDriverCtx } from './context'
import { cancelJobFenced, reapStaleFenced } from './jobInvalidation'

export const createJobsFacet = (ctx: PgDriverCtx): JobsPersistence => ({
  enqueue: async (input) => {
    await ctx.ensureInit()
    const runAt = input.runAt ?? input.createdAt
    const res = await ctx.required.query(
      `INSERT INTO jobs (id, space, kind, status, principal, params, progress_total,
           max_attempts, run_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $9)
         RETURNING *`,
      [
        input.id,
        input.space,
        input.kind,
        input.principal,
        input.params === undefined ? null : JSON.stringify(input.params),
        input.progressTotal ?? null,
        input.maxAttempts ?? 3,
        runAt,
        input.createdAt,
      ],
    )
    return jobOfRow(res.rows[0] as JobRow)
  },

  claimNext: async (workerId, kinds, now) => {
    await ctx.ensureInit()
    if (!kinds.length) {
      return null
    }
    const res = await ctx.required.query(
      // eslint-disable-next-line no-restricted-syntax -- outside the note-identity hierarchy: a single-statement queue claim, holding nothing else
      `UPDATE jobs SET
           status = 'running',
           locked_by = $1,
           locked_at = $2,
           started_at = COALESCE(started_at, $2),
           attempts = attempts + 1,
           updated_at = $2
         WHERE id = (
           SELECT id FROM jobs
           WHERE status = 'pending' AND run_at <= $2 AND kind = ANY($3::text[])
           ORDER BY run_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`,
      [workerId, now, kinds as string[]],
    )
    const row = res.rows[0] as JobRow | undefined
    return row ? jobOfRow(row) : null
  },

  heartbeat: async (id, workerId, p) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `UPDATE jobs SET
           locked_at = $3,
           progress_done = $4,
           progress_total = COALESCE($5, progress_total),
           phase = COALESCE($6, phase),
           updated_at = $3
         WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [id, workerId, p.now, p.done, p.total ?? null, p.phase ?? null],
    )
    return (res.rowCount ?? 0) > 0
  },

  // Lease-guarded (locked_by + status='running'): a stale worker whose lease was
  // reaped and reclaimed by a peer no-ops here (rowCount 0) instead of clobbering the
  // new owner's row or overwriting a landed cancel. progress_done is left as the
  // handler's last report — no snap to progress_total (a whole-space estimate that
  // would misreport a folder/scope-narrowed export's real count).
  succeed: async (id, workerId, out) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `UPDATE jobs SET
           status = 'succeeded',
           result = $3,
           artifact_ref = $4,
           artifact_bytes = $5,
           artifact_name = $6,
           expires_at = $7,
           completed_at = $8,
           updated_at = $8,
           locked_at = NULL,
           locked_by = NULL,
           error = NULL
         WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [
        id,
        workerId,
        out.result === undefined ? null : JSON.stringify(out.result),
        out.artifactRef ?? null,
        out.artifactBytes ?? null,
        out.artifactName ?? null,
        out.expiresAt ?? null,
        out.now,
      ],
    )
    return (res.rowCount ?? 0) > 0
  },

  fail: async (id, workerId, f) => {
    await ctx.ensureInit()
    const res = f.retryAt
      ? await ctx.required.query(
          `UPDATE jobs SET status = 'pending', run_at = $3, error = $4,
               locked_at = NULL, locked_by = NULL, updated_at = $5
             WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
          [id, workerId, f.retryAt, f.error, f.now],
        )
      : await ctx.required.query(
          `UPDATE jobs SET status = 'failed', error = $3, completed_at = $4,
               result = COALESCE($5, result),
               locked_at = NULL, locked_by = NULL, updated_at = $4
             WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
          [id, workerId, f.error, f.now, f.result === undefined ? null : JSON.stringify(f.result)],
        )
    return (res.rowCount ?? 0) > 0
  },

  // Invalidation from outside the run takes the job's fence first — see
  // `jobInvalidation` for why a transition that skipped it could land between a
  // fenced write's premise and its bytes.
  cancel: async (id, now) => {
    await ctx.ensureInit()

    return await cancelJobFenced(ctx.required, id, now)
  },

  release: async (id, workerId, now) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `UPDATE jobs SET status = 'pending', attempts = GREATEST(attempts - 1, 0),
           locked_at = NULL, locked_by = NULL, updated_at = $3
         WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [id, workerId, now],
    )
  },

  get: async (id) => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT * FROM jobs WHERE id = $1', [id])
    const row = res.rows[0] as JobRow | undefined
    return row ? jobOfRow(row) : null
  },

  list: async (space, opts) => {
    await ctx.ensureInit()
    const where: string[] = ['space = $1']
    const args: unknown[] = [space]
    let n = 1

    if (opts?.principal) {
      where.push(`principal = $${++n}`)
      args.push(opts.principal)
    }
    if (opts?.kind) {
      where.push(`kind = $${++n}`)
      args.push(opts.kind)
    }
    if (opts?.statuses?.length) {
      where.push(`status = ANY($${++n}::text[])`)
      args.push(opts.statuses as JobStatus[])
    }
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500))
    args.push(limit)
    const res = await ctx.required.query(
      `SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${++n}`,
      args,
    )
    return (res.rows as JobRow[]).map(jobOfRow)
  },

  reapStale: async (staleBefore, now) => {
    await ctx.ensureInit()

    return await reapStaleFenced(ctx.required, staleBefore, now)
  },

  findExpired: async (now, limit) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT * FROM jobs WHERE artifact_ref IS NOT NULL AND expires_at IS NOT NULL
           AND expires_at < $1 ORDER BY expires_at LIMIT $2`,
      [now, Math.max(1, Math.min(limit ?? 100, 1000))],
    )
    return (res.rows as JobRow[]).map(jobOfRow)
  },

  clearArtifact: async (id, now) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `UPDATE jobs SET artifact_ref = NULL, artifact_bytes = NULL, expires_at = NULL,
           updated_at = $2 WHERE id = $1`,
      [id, now],
    )
  },

  prune: async (before) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `DELETE FROM jobs WHERE status IN ('succeeded', 'failed', 'canceled')
           AND artifact_ref IS NULL AND updated_at < $1
    -- Fail-closed against retention deleting the evidence a live import still
    -- points at: while a reservation references this job, its terminal row is the
    -- only thing that can prove what the run had already done.
    -- canon: docs/import.md#importing-a-markdown-tree-302
           AND NOT EXISTS (SELECT 1 FROM import_reservations r WHERE r.job_id = jobs.id)`,
      [before],
    )
  },
})
