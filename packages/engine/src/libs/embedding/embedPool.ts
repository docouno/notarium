// Embed pool (#197): the structural throughput fix for background indexing. A
// single in-process ONNX session pins its inference to the main event loop's
// process and embeds notes ONE AT A TIME — a first-boot backfill of a large corpus
// then holds the box's cores for the whole window and every interactive request
// (search, nav, /api/health, in ANY space) starves behind it (observed live in
// #196 on a 2681-note instance: ~3h, 220% CPU, health stalled). #196 made that
// backfill POLITE (it yields via BackgroundScheduler); this makes it FAST and
// off-thread: a pool of worker_threads, each owning its own ONNX session, embeds
// several notes in parallel across the cores while the main event loop stays free.
//
// Division of labour (approved design, #197): workers do PURE inference. The main
// thread keeps ALL sqlite writes and every crash-safety invariant (the embedded_hash
// sentinel, the re-read-after-await rowid guard) UNCHANGED — so there is one writer,
// no cross-thread partition ownership, and the elegant single-connection reasoning in
// embedNote survives verbatim. Measured (e5-small, 8 cores): main event-loop lag under
// backfill p50/p95 463/1190ms → 0.2/3.7ms, throughput ~3× — see the #197 spike.
//
// It IS the Embedder seam: createLocalOnnxEmbedder wrapped N times. `id`/`dimensions`
// come from the same option normalisation, so swapping single↔pool keeps the SAME
// vector-partition identity (no spurious re-embed). The store reads `concurrency` (=
// the worker count) to launch that many embedNote()s at once.

import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'

import { createLocalOnnxEmbedder, type LocalOnnxEmbedderOptions } from './localOnnxEmbedder'
import type { Embedder, EmbedKind } from './types'

/** One pool member — warms once, embeds one batch at a time. The real one wraps a
 *  worker_thread; a test injects a synchronous fake so the pool's queueing/priority
 *  logic is exercised without spawning OS threads or loading a model. */
export type PoolWorker = {
  warmup(): Promise<void>
  embed(texts: readonly string[], kind: EmbedKind, dim: number): Promise<Float32Array[]>
  terminate(): Promise<void>
  /** Resolves ONCE if the underlying worker dies unexpectedly (crash/OOM) — the pool
   *  drops it and spawns a replacement so a lost worker can't shrink the pool silently
   *  or fast-reject every queued task through a dead member. Never resolves for a
   *  healthy worker (or a fake). */
  readonly dead: Promise<void>
}

export type EmbedPoolOptions = LocalOnnxEmbedderOptions & {
  /** Worker-thread count = the pool's real concurrency (#197). Clamped to ≥1; the
   *  composition root defaults it from the core count with a memory-aware cap (each
   *  worker holds its OWN model copy — K × model RAM). */
  workers: number
  /** Worker-factory seam. Default spawns a real worker_thread running embedWorker;
   *  tests inject a fake. */
  spawn?: (opts: LocalOnnxEmbedderOptions) => PoolWorker
}

/** Resolve the worker entry next to THIS module. In the bundled production build this
 *  file is inlined into dist/main.js, so import.meta.url is dist/main.js and the
 *  sibling entry is dist/embedWorker.js (tsup ships it as its own entry). Under tsx
 *  (dev/test) import.meta.url is this .ts source and the worker is the .ts beside it
 *  (tsx loads TS workers). Probe both so one code path serves both — mirrors app.ts's
 *  webDist() resolve-by-location pattern. */
const resolveWorkerUrl = (): URL => {
  for (const name of ['embedWorker.js', 'embedWorker.ts']) {
    const u = new URL(`./${name}`, import.meta.url)

    if (existsSync(u)) {
      return u
    }
  }
  throw new Error(`embedWorker entry not found next to ${import.meta.url}`)
}

/** The real pool member: a worker_thread with id-correlated request/response so the
 *  wrapper is robust even if a later change pipelines more than one call per worker. */
const spawnRealWorker = (opts: LocalOnnxEmbedderOptions): PoolWorker => {
  const worker = new Worker(resolveWorkerUrl(), { workerData: opts })
  worker.unref() // a parked pool must not keep the process alive on its own (#196 timers do the same)
  let reqId = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let deadErr: Error | null = null
  let markDead!: () => void
  const dead = new Promise<void>((res) => {
    markDead = res
  })

  worker.on(
    'message',
    (m: { t: string; id: number; msg?: string; n?: number; buf?: ArrayBuffer }) => {
      const p = pending.get(m.id)

      if (!p) {
        return
      }
      pending.delete(m.id)
      if (m.t === 'err') {
        p.reject(new Error(m.msg))
      } else if (m.t === 'warm') {
        p.resolve(undefined)
      } else {
        // The transferred buffer now belongs to this thread; slice each row as a VIEW —
        // embedNote copies it into a Uint8Array for the vec0 insert, so a view is enough.
        // Row stride is the worker's ACTUAL output width (buffer length / row count), NOT the
        // configured dimension, so a model/EMBED_DIMENSIONS mismatch reaches embedNote's
        // fail-closed guard at its true width instead of being masked (#197 review).
        const flat = new Float32Array(m.buf!)
        const rowDim = m.n! > 0 ? Math.floor(flat.length / m.n!) : 0
        const rows: Float32Array[] = []

        for (let i = 0; i < m.n!; i++) {
          rows.push(flat.subarray(i * rowDim, (i + 1) * rowDim))
        }
        p.resolve(rows)
      }
    },
  )
  const fail = (err: Error) => {
    if (deadErr) {
      return
    }
    deadErr = err
    for (const p of pending.values()) {
      p.reject(err)
    }
    pending.clear()
    markDead()
  }
  worker.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))))
  // A clean exit (terminate() → code 1 is normal for terminate; 0 for self-exit) only
  // matters when tasks are still pending — treat any exit with pending work as a death.
  worker.on('exit', (code) => fail(new Error(`embed worker exited (code ${code})`)))

  const send = <T>(msg: Record<string, unknown>): Promise<T> => {
    if (deadErr) {
      return Promise.reject(deadErr)
    }
    const id = ++reqId
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      worker.postMessage({ ...msg, id })
    })
  }

  return {
    warmup: () => send<void>({ t: 'warm' }),
    embed: (texts, kind) => send<Float32Array[]>({ t: 'embed', texts, kind }),
    terminate: async () => {
      await worker.terminate()
    },
    dead,
  }
}

/** Build a worker-pool embedder (#197). Process-global, one instance shared by every
 *  space's store — exactly like the single embedder it replaces. */
export const createEmbedPool = (
  opts: EmbedPoolOptions,
): Embedder & { warmup(): Promise<void>; close(): Promise<void> } => {
  const n = Math.max(1, Math.floor(opts.workers))
  const spawn = opts.spawn ?? spawnRealWorker
  // The exact LocalOnnxEmbedderOptions a single embedder would get — copied EXPLICITLY
  // (not spread) so the pool-only fields never reach a worker: `spawn` is a function
  // and would throw DataCloneError as workerData, `workers` is just noise there.
  const localOpts: LocalOnnxEmbedderOptions = {
    model: opts.model,
    dtype: opts.dtype,
    dimensions: opts.dimensions,
    prefixes: opts.prefixes,
    numThreads: opts.numThreads,
    maxBatchSize: opts.maxBatchSize,
    maxBatchChars: opts.maxBatchChars,
    cpuMemArena: opts.cpuMemArena,
  }
  // Template embedder: the SAME option normalisation as a single embedder, purely to
  // read id/dimensions — it NEVER embeds (the workers do), so it never loads a model.
  // This is what keeps the vector-partition identity stable across a single↔pool swap.
  const template = createLocalOnnxEmbedder(localOpts)
  const dim = template.dimensions

  type Task = {
    texts: readonly string[]
    kind: EmbedKind
    resolve: (v: Float32Array[]) => void
    reject: (e: unknown) => void
  }
  const highQ: Task[] = [] // interactive query embeds jump the backfill (kind==='query')
  const lowQ: Task[] = [] //  background passage embeds (backfill)
  const workers = new Set<PoolWorker>()
  const idle: PoolWorker[] = []
  let closed = false
  // Crash-loop guard (#197 review): respawn a dead worker, but STOP if workers keep dying
  // without any embed succeeding in between — an async startup crash (a mis-bundled worker
  // entry, pthread/pids exhaustion in a capped container) would otherwise spawn threads
  // forever, defeating the "a broken pool costs throughput, not correctness" contract. The
  // counter resets on the first successful embed, so genuine transient deaths never trip it.
  const maxDeathsWithoutProgress = n * 2 + 2
  let deathsSinceProgress = 0
  let broken = false // tripped the crash-loop guard → no more respawns; embeds fall back to FTS

  const rejectQueued = (err: Error): void => {
    for (const q of [highQ, lowQ]) {
      for (const t of q) {
        t.reject(err)
      }
      q.length = 0
    }
  }

  const pump = (): void => {
    // A crash-loop drained the pool → fail queued/incoming embeds so embedNote degrades to
    // FTS (P13) instead of hanging forever on a pool that will never have a worker again.
    if (broken && !workers.size) {
      rejectQueued(new Error('embed pool has no live workers'))
      return
    }
    while (idle.length && (highQ.length || lowQ.length)) {
      const task = (highQ.shift() ?? lowQ.shift()) as Task
      const w = idle.pop() as PoolWorker
      w.embed(task.texts, task.kind, dim)
        .then((v) => {
          deathsSinceProgress = 0 // a success proves the pool healthy — reset the guard
          task.resolve(v)
        }, task.reject)
        // Return the worker to the idle set only if it is STILL a live pool member —
        // a death handler may have removed it while its (now-rejected) task settled.
        .finally(() => {
          if (!closed && workers.has(w)) {
            idle.push(w)
            pump()
          }
        })
    }
  }

  const add = (w: PoolWorker): void => {
    workers.add(w)
    idle.push(w)
    // Respawn on unexpected death: drop the corpse and slot a fresh worker so the pool
    // keeps its width. The replacement lazy-loads its model on first embed (a one-off
    // cold load on that worker) — acceptable vs stalling the backfill.
    void w.dead.then(() => {
      if (closed || !workers.has(w)) {
        return
      }
      workers.delete(w)
      const i = idle.indexOf(w)

      if (i >= 0) {
        idle.splice(i, 1)
      }
      deathsSinceProgress++
      // Respawn a replacement UNLESS the crash-loop guard has tripped. A SYNCHRONOUS spawn
      // failure here (new Worker() throwing on pthread/fd/mem exhaustion) runs inside a void
      // .then, so it must NOT escape as an unhandled rejection — log it and fall through.
      if (deathsSinceProgress <= maxDeathsWithoutProgress) {
        try {
          add(spawn(localOpts))
        } catch (err) {
          console.error('[notarium] embed pool: worker respawn failed:', err)
        }
      }
      // Trip the degraded flag when the crash-loop guard is exceeded OR a failed respawn has
      // left the pool with NO live workers. The second case is the one the try/catch alone
      // misses (#197 review r2): a caught synchronous spawn failure adds no worker and no new
      // `dead` promise to retry, so without this pump()'s reject path (gated on `broken`)
      // would never fire and every queued/incoming embed would HANG forever instead of
      // degrading to FTS. Restart recovers; a hung backfill does not.
      if (!broken && (deathsSinceProgress > maxDeathsWithoutProgress || !workers.size)) {
        broken = true
        console.error(
          `[notarium] embed pool degraded — no live workers${deathsSinceProgress > maxDeathsWithoutProgress ? ' (crash-loop guard)' : ' (respawn failed)'}; embeds fall back to FTS (#197)`,
        )
      }
      pump() // once `broken` and the pool is empty, drains the queue as rejections
    })
  }

  try {
    for (let i = 0; i < n; i++) {
      add(spawn(localOpts))
    }
  } catch (err) {
    // A worker failed to spawn (e.g. the worker entry can't be resolved on this
    // build) — tear down any that DID start so we don't leak threads, then rethrow
    // for the composition root to degrade to a single in-process embedder (P13).
    for (const w of workers) {
      void w.terminate().catch(() => {})
    }
    workers.clear()
    idle.length = 0
    throw err
  }

  const embed = (texts: readonly string[], kind: EmbedKind): Promise<Float32Array[]> => {
    if (!texts.length) {
      return Promise.resolve([])
    }
    if (closed) {
      return Promise.reject(new Error('embed pool closed'))
    }
    // A crash-loop that emptied the pool: reject so the caller (embedNote / query embed)
    // degrades to FTS at once instead of queueing work no worker will ever pick up.
    if (broken && !workers.size) {
      return Promise.reject(new Error('embed pool has no live workers'))
    }

    return new Promise<Float32Array[]>((resolve, reject) => {
      ;(kind === 'query' ? highQ : lowQ).push({ texts, kind, resolve, reject })
      pump()
    })
  }

  return {
    id: template.id,
    dimensions: dim,
    // The store's background loop launches up to this many embedNote()s concurrently —
    // this is the whole point of the pool (#197): parallel notes across the cores.
    concurrency: n,
    warmup: async (): Promise<void> => {
      // Warm every worker's model off the request path (#81 P13), in parallel.
      await Promise.all([...workers].map((w) => w.warmup()))
    },
    embed,
    close: async (): Promise<void> => {
      closed = true
      const err = new Error('embed pool closed')

      for (const q of [highQ, lowQ]) {
        for (const t of q) {
          t.reject(err)
        }
        q.length = 0
      }
      await Promise.all([...workers].map((w) => w.terminate().catch(() => {})))
      workers.clear()
      idle.length = 0
    },
  }
}
