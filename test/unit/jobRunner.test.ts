// Unit tests for the durable job RUNNER (#105 [JOBS][A]) — the lifecycle/concurrency
// logic that the e2e happy-path fake can't reach: retry-to-fail at the attempts
// boundary, cooperative cancel aborting an in-flight handler, graceful stop() releasing
// (and refunding) a running job, the per-run lease token making a reaped-then-reclaimed
// job's original run self-abort (no same-id double-run / clobber), and the artifact GC
// clearing its pointer ONLY after the file is actually gone.
//
// Driven over a real in-memory SqliteMetaDb jobs facet + an in-memory artifact store, so
// the production runner code runs against the production SQL — nothing is stubbed.

import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createJobRunner,
  JobAbortedError,
  type JobHandler,
} from '../../packages/server/src/apps/server/consumers/jobRunner'
import type { ArtifactStore } from '../../packages/server/src/libs/artifactStore'
import { SqliteMetaDb } from '../../packages/server/src/services/metaDb/sqliteMetaDb'
import type { JobRecord } from '../../packages/server/src/services/metaDb/types'

// These tests drive the runner over REAL timers (poll/heartbeat/backoff), so give the
// whole file headroom above vitest's 5s default — under a fully parallel suite the timers
// slip and a tight budget flakes (e.g. the retry test's jittered backoff, up to ~1s/attempt).
vi.setConfig({ testTimeout: 20_000 })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Generous ceiling: waitFor returns the instant the condition holds, so a large budget
// costs nothing on the happy path — it only avoids a premature timeout when the whole
// suite runs in parallel and starves these real timers.
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const start = Date.now()

  for (;;) {
    if (await cond()) {
      return
    }
    if (Date.now() - start > ms) {
      throw new Error('waitFor timed out')
    }
    await sleep(5)
  }
}

/** An in-memory ArtifactStore — records writes/removes so GC behaviour is observable. */
const makeArtifacts = (opts: { failRemove?: (ref: string) => boolean } = {}) => {
  const files = new Map<string, Buffer>()
  const store: ArtifactStore = {
    createWriteStream: async (ref) => {
      const chunks: Buffer[] = []
      const w = new Writable({
        write: (c, _e, cb) => {
          chunks.push(Buffer.from(c))
          cb()
        },
      })
      w.on('finish', () => files.set(ref, Buffer.concat(chunks)))
      return w
    },
    createReadStream: (ref) => Readable.from([files.get(ref) ?? Buffer.alloc(0)]),
    stat: async (ref) => {
      const f = files.get(ref)
      return f ? { size: f.length, mtimeMs: 0 } : null
    },
    remove: async (ref) => {
      if (opts.failRemove?.(ref)) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      files.delete(ref)
    },
    rename: async (from, to) => {
      const f = files.get(from)

      if (f) {
        files.set(to, f)
        files.delete(from)
      }
    },
    removeSpace: async (prefix) => {
      for (const k of [...files.keys()]) {
        if (k === prefix || k.startsWith(`${prefix}/`)) {
          files.delete(k)
        }
      }
    },
  }
  return Object.assign(store, { files })
}

describe('createJobRunner (#105)', () => {
  const stops: Array<() => Promise<void>> = []
  const dbs: SqliteMetaDb[] = []
  afterEach(async () => {
    while (stops.length) {
      await stops.pop()!()
    }
    while (dbs.length) {
      await dbs.pop()!.close()
    }
  })

  const setup = (
    handlers: Record<string, JobHandler>,
    over: Partial<Parameters<typeof createJobRunner>[0]> = {},
    artifacts = makeArtifacts(),
  ) => {
    const db = new SqliteMetaDb(':memory:')
    dbs.push(db)
    const updates: JobRecord[] = []
    const runner = createJobRunner({
      jobs: db.jobs,
      artifacts,
      handlers,
      onUpdate: (j) => updates.push(j),
      pollIntervalMs: 10,
      maintenanceIntervalMs: 10,
      staleAfterMs: 60_000,
      backoffBaseMs: 5,
      stopTimeoutMs: 500,
      ...over,
    })
    stops.push(() => runner.stop())
    return { db, runner, updates, artifacts }
  }

  const enqueue = (db: SqliteMetaDb, over: Record<string, unknown> = {}) =>
    db.jobs.enqueue({
      id: 'j1',
      space: 'S',
      kind: 'export',
      principal: 'user:a',
      createdAt: new Date().toISOString(),
      ...over,
    })

  it('claims and runs a job to success, recording progress and the artifact', async () => {
    const handler: JobHandler = async (ctx) => {
      await ctx.report({ done: 2, total: 2, phase: 'done' })
      return {
        result: { count: 2 },
        artifactRef: 'S/j1.zip',
        artifactBytes: 9,
        artifactName: 'a.zip',
      }
    }
    const { db, runner, updates } = setup({ export: handler })
    await enqueue(db, { progressTotal: 2 })
    runner.start()
    runner.wake()
    await waitFor(async () => (await db.jobs.get('j1'))?.status === 'succeeded')
    const j = await db.jobs.get('j1')
    expect(j?.progressDone).toBe(2)
    expect(j?.artifactRef).toBe('S/j1.zip')
    expect(j?.lockedBy).toBeNull()
    expect(updates.some((u) => u.status === 'succeeded')).toBe(true)
  })

  it('retries a failing handler and fails terminally at the attempts boundary', async () => {
    let runs = 0

    const handler: JobHandler = async () => {
      runs++
      throw new Error('boom')
    }
    const { db, runner } = setup({ export: handler })
    await enqueue(db) // maxAttempts default 3
    runner.start()
    runner.wake()
    await waitFor(async () => (await db.jobs.get('j1'))?.status === 'failed')
    const j = await db.jobs.get('j1')
    expect(j?.status).toBe('failed')
    expect(j?.attempts).toBe(3) // three claims, then the cap fails it terminally
    expect(runs).toBe(3)
    expect(j?.error).toBe('boom')
  })

  it('cooperative cancel aborts the in-flight handler', async () => {
    const handler: JobHandler = async (ctx) => {
      // Loop reporting; report() throws JobAbortedError the moment the row is canceled.
      for (;;) {
        await ctx.report({ done: 0, phase: 'work' })
        await sleep(5)
      }
    }
    const { db, runner } = setup({ export: handler })
    await enqueue(db)
    runner.start()
    runner.wake()
    await waitFor(async () => (await db.jobs.get('j1'))?.status === 'running')
    await db.jobs.cancel('j1', new Date().toISOString())
    await waitFor(async () => (await db.jobs.get('j1'))?.status === 'canceled')
    // The handler's loop must have unwound (its report threw) — the row stays canceled,
    // never flipped to succeeded/failed by a late write.
    await sleep(30)
    expect((await db.jobs.get('j1'))?.status).toBe('canceled')
  })

  it('graceful stop() releases an in-flight job back to pending and refunds the attempt', async () => {
    const handler: JobHandler = async (ctx) =>
      new Promise((_, rej) => {
        if (ctx.signal.aborted) {
          return rej(new JobAbortedError())
        }
        ctx.signal.addEventListener('abort', () => rej(new JobAbortedError()), { once: true })
      })
    const { db, runner } = setup({ export: handler })
    await enqueue(db)
    runner.start()
    runner.wake()
    await waitFor(async () => (await db.jobs.get('j1'))?.status === 'running')
    expect((await db.jobs.get('j1'))?.attempts).toBe(1)
    await runner.stop()
    stops.length = 0 // already stopped
    const j = await db.jobs.get('j1')
    expect(j?.status).toBe('pending') // handed back for the restart/peer
    expect(j?.attempts).toBe(0) // refunded — a clean shutdown is not a failed attempt
    expect(j?.lockedBy).toBeNull()
  })

  it('bounds shutdown when a broken handler ignores its AbortSignal', async () => {
    const logs: string[] = []
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const handler: JobHandler = async () => new Promise(() => {})
    const { db, runner } = setup(
      { export: handler },
      { stopTimeoutMs: 25, log: (message) => logs.push(message) },
    )
    await enqueue(db)
    runner.start()
    runner.wake()
    await waitFor(async () => (await db.jobs.get('j1'))?.status === 'running')

    const heartbeatCall = setIntervalSpy.mock.calls.find(([, delay]) => delay === 20_000)
    const heartbeatIndex = heartbeatCall ? setIntervalSpy.mock.calls.indexOf(heartbeatCall) : -1
    const heartbeat =
      heartbeatIndex >= 0
        ? (setIntervalSpy.mock.results[heartbeatIndex]?.value as NodeJS.Timeout | undefined)
        : undefined
    expect(heartbeat).toBeDefined()
    // Even before shutdown, a broken handler's heartbeat cannot keep PID 1 alive by
    // itself after every real service handle has closed.
    expect(heartbeat?.hasRef()).toBe(false)

    const startedAt = Date.now()
    await runner.stop()
    stops.length = 0

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(logs).toContain('stop: in-flight drain timed out; proceeding to close')
    // stop() aborts the run before waiting, so no heartbeat keeps touching a DB that
    // the outer lifecycle is now free to close.
    expect(clearIntervalSpy).toHaveBeenCalledWith(heartbeat)
  })

  it('per-run lease token: a reaped-and-reclaimed job self-aborts the original run without clobbering the new owner', async () => {
    const signals: AbortSignal[] = []

    const handler: JobHandler = async (ctx) => {
      signals.push(ctx.signal)
      for (;;) {
        await ctx.report({ done: 0 }) // throws JobAbortedError once our lease is gone
        await sleep(5)
      }
    }
    // No polling/maintenance — we drive the reap+reclaim by hand for determinism.
    const { db, runner } = setup(
      { export: handler },
      { pollIntervalMs: 1_000_000, maintenanceIntervalMs: 1_000_000 },
    )
    await enqueue(db)
    runner.start()
    runner.wake()
    await waitFor(() => signals.length === 1) // the runner claimed & started it (leaseA)
    const leaseA = (await db.jobs.get('j1'))?.lockedBy
    expect(leaseA).toBeTruthy()

    // Simulate a stall+reap: reopen the row and let a PEER re-claim it under a new lease.
    await db.jobs.reapStale(new Date(Date.now() + 10_000).toISOString(), new Date().toISOString())
    const peer = await db.jobs.claimNext('lease-PEER', ['export'], new Date().toISOString())
    expect(peer?.lockedBy).toBe('lease-PEER')

    // The original run's next report() sees the lease is gone and aborts — it must NOT
    // write over the peer's row.
    await waitFor(() => signals[0].aborted === true)
    await sleep(30)
    const j = await db.jobs.get('j1')
    expect(j?.status).toBe('running') // still the peer's
    expect(j?.lockedBy).toBe('lease-PEER') // original run didn't clobber it
  })

  it('artifact GC removes an expired file then clears its pointer', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()

    const handler: JobHandler = async (ctx) => {
      const w = await ctx.artifacts.createWriteStream('S/j1.zip')
      w.end('zipbytes')
      await new Promise((res) => w.on('finish', res))
      return { artifactRef: 'S/j1.zip', artifactBytes: 7, artifactName: 'a.zip', expiresAt: past }
    }
    const { db, runner, artifacts } = setup({ export: handler })
    await enqueue(db)
    runner.start()
    runner.wake()
    await waitFor(async () => (await db.jobs.get('j1'))?.status === 'succeeded')
    await waitFor(
      async () =>
        !artifacts.files.has('S/j1.zip') && (await db.jobs.get('j1'))?.artifactRef === null,
    )
    expect(artifacts.files.has('S/j1.zip')).toBe(false)
    expect((await db.jobs.get('j1'))?.artifactRef).toBeNull()
  })

  it('artifact GC keeps the pointer when the file delete fails (no orphan)', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const artifacts = makeArtifacts({ failRemove: (ref) => ref === 'S/j1.zip' })

    const handler: JobHandler = async (ctx) => {
      const w = await ctx.artifacts.createWriteStream('S/j1.zip')
      w.end('zipbytes')
      await new Promise((res) => w.on('finish', res))
      return { artifactRef: 'S/j1.zip', artifactBytes: 7, artifactName: 'a.zip', expiresAt: past }
    }
    const { db, runner } = setup({ export: handler }, {}, artifacts)
    await enqueue(db)
    runner.start()
    runner.wake()
    await waitFor(async () => (await db.jobs.get('j1'))?.status === 'succeeded')
    // Give the GC several ticks; the failing unlink must leave the pointer intact so a
    // later tick can retry, rather than orphaning the on-disk file.
    await sleep(80)
    expect((await db.jobs.get('j1'))?.artifactRef).toBe('S/j1.zip')
  })

  it('removes the published artifact when a cancel lands after publish but before succeed', async () => {
    const artifacts = makeArtifacts()
    let signalCancel!: () => void
    const readyToCancel = new Promise<void>((res) => (signalCancel = res))
    let release!: () => void
    const proceed = new Promise<void>((res) => (release = res))

    // Simulate exportJob: publish the artifact, report (heartbeat still valid), then stall
    // in the final window while the test cancels the row, then return the artifactRef.
    const handler: JobHandler = async (ctx) => {
      const w = await ctx.artifacts.createWriteStream('S/j1.zip')
      w.end('data')
      await new Promise((res) => w.on('finish', res))
      await ctx.report({ done: 1, total: 1, phase: 'done' })
      signalCancel()
      await proceed
      return { artifactRef: 'S/j1.zip', artifactBytes: 4, artifactName: 'a.zip' }
    }
    const { db, runner } = setup({ export: handler })
    await enqueue(db)
    runner.start()
    runner.wake()
    await readyToCancel // handler has published + reported, still running
    await db.jobs.cancel('j1', new Date().toISOString()) // cancel lands in the final window
    release() // let the handler return → runJob.succeed no-ops (lease guard)
    await waitFor(async () => (await db.jobs.get('j1'))?.status === 'canceled')
    // The published ZIP would be unreachable by the row-driven GC (canceled row has no
    // ref), so the runner must remove it to avoid an orphan.
    await waitFor(() => !artifacts.files.has('S/j1.zip'))
    expect(artifacts.files.has('S/j1.zip')).toBe(false)
  })
})
