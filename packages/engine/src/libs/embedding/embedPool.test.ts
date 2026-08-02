// Embed-pool orchestration (#197): the queueing/priority/lifecycle logic, exercised
// with a FAKE worker factory — no worker_threads, no onnxruntime, so it's fast and
// hermetic. The real worker (embedWorker + a real ONNX session) is proven live on the
// stand; here we pin the pool's contract: it never runs more than `workers` embeds at
// once (even after a respawn — no leaked corpse), interactive `query` embeds jump the
// backfill `passage` queue, a worker that dies MID-EMBED rejects its in-flight task and
// is replaced, a persistent crash-loop is bounded (guard) and degrades embeds instead of
// storming, warmup/close fan out to every worker, and close rejects what's still queued.

import { describe, expect, it } from 'vitest'

import { createEmbedPool, type PoolWorker } from './embedPool'
import type { EmbedKind } from './types'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A fake pool whose embed() blocks on a per-call gate the test releases, so we can
 *  freeze the pool mid-flight and observe how many embeds run at once and in what order.
 *  Faithful to the real worker on death: markDead REJECTS the worker's in-flight embed
 *  (mirroring spawnRealWorker.fail) so the busy-death path is actually exercised. */
const fakeSpawn = () => {
  const state = {
    spawned: 0,
    warmups: 0,
    terminated: 0,
    inFlight: 0,
    maxInFlight: 0,
    order: [] as EmbedKind[],
    gates: [] as Array<{ resolve: () => void }>,
    deaths: [] as Array<() => void>,
  }

  const spawn = (): PoolWorker => {
    state.spawned++
    let inflightReject: ((e: unknown) => void) | null = null
    let markDead!: () => void
    const dead = new Promise<void>((res) => {
      markDead = () => {
        // Model the real worker: a death rejects its currently in-flight embed.
        if (inflightReject) {
          state.inFlight--
          inflightReject(new Error('worker died'))
          inflightReject = null
        }
        res()
      }
    })
    state.deaths.push(markDead)
    return {
      warmup: async () => {
        state.warmups++
      },
      embed: (texts, kind, dim) =>
        new Promise<Float32Array[]>((resolve, reject) => {
          state.inFlight++
          state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
          state.order.push(kind)
          inflightReject = reject
          state.gates.push({
            resolve: () => {
              if (!inflightReject) {
                return
              } // already died
              state.inFlight--
              inflightReject = null
              resolve(texts.map(() => new Float32Array(dim)))
            },
          })
        }),
      terminate: async () => {
        state.terminated++
      },
      dead,
    }
  }

  return { state, spawn }
}

/** Keep releasing gates (across the dispatch waves a freed worker triggers) until all
 *  the given promises settle — so a K-capped drain of N>K tasks runs to completion. */
const drain = async (
  state: { gates: Array<{ resolve: () => void }> },
  ...promises: Promise<unknown>[]
): Promise<void> => {
  let settled = false
  void Promise.allSettled(promises).then(() => {
    settled = true
  })
  while (!settled) {
    while (state.gates.length) {
      state.gates.shift()!.resolve()
    }
    await tick()
  }
}

const opts = {
  model: 'Xenova/multilingual-e5-small',
  dimensions: 8,
  prefixes: { query: 'query: ', passage: 'passage: ' },
  workers: 3,
}

describe('createEmbedPool (#197)', () => {
  it('reports id/dimensions/concurrency from the same options as a single embedder', () => {
    const { spawn } = fakeSpawn()
    const pool = createEmbedPool({ ...opts, spawn })
    expect(pool.dimensions).toBe(8)
    expect(pool.concurrency).toBe(3)
    // id folds model@dtype+prefixes — identical to createLocalOnnxEmbedder's, so a
    // single↔pool swap keeps the SAME vector-partition identity (no spurious re-embed).
    expect(pool.id).toContain('Xenova/multilingual-e5-small')
    return pool.close()
  })

  it('never runs more than `workers` embeds at once; the rest queue', async () => {
    const { state, spawn } = fakeSpawn()
    const pool = createEmbedPool({ ...opts, spawn })
    // Fire 7 embeds against a 3-worker pool. Everything up to each worker's gate runs
    // synchronously, so exactly 3 are in flight and 4 are parked.
    const done = Array.from({ length: 7 }, (_, i) => pool.embed([`t${i}`], 'passage'))
    expect(state.inFlight).toBe(3)
    expect(state.maxInFlight).toBe(3)
    // Release every gate across all dispatch waves (7 = 3+3+1) — the cap must hold throughout.
    await drain(state, ...done)
    expect(state.maxInFlight).toBe(3)
    return pool.close()
  })

  it('interactive query embeds jump ahead of backfill passage embeds', async () => {
    const { state, spawn } = fakeSpawn()
    const pool = createEmbedPool({ ...opts, workers: 1, spawn }) // single worker → strict ordering
    const p1 = pool.embed(['a'], 'passage') // dispatched immediately (worker was idle)
    const p2 = pool.embed(['b'], 'passage') // queued (low)
    const p3 = pool.embed(['c'], 'query') //   queued (high) AFTER p2 but must run BEFORE it
    expect(state.order).toEqual(['passage']) // only the first is in flight
    state.gates.shift()!.resolve() // free the worker
    await tick()
    state.gates.shift()!.resolve()
    await tick()
    state.gates.shift()!.resolve()
    await Promise.all([p1, p2, p3])
    expect(state.order).toEqual(['passage', 'query', 'passage']) // query overtook the 2nd passage
    return pool.close()
  })

  it('warmup fans out to every worker', async () => {
    const { state, spawn } = fakeSpawn()
    const pool = createEmbedPool({ ...opts, spawn })
    await pool.warmup()
    expect(state.warmups).toBe(3)
    return pool.close()
  })

  it('replaces a dead worker and keeps EXACTLY `workers` concurrency (no leaked corpse)', async () => {
    const { state, spawn } = fakeSpawn()
    const pool = createEmbedPool({ ...opts, spawn })
    expect(state.spawned).toBe(3)
    state.deaths[0]!() // kill an idle worker
    await tick()
    expect(state.spawned).toBe(4) // a replacement was spawned
    // Fire MORE than `workers` tasks: if the corpse leaked back into idle the pool would
    // run 4 at once; the guard (workers.has) must hold it to exactly 3.
    const done = Array.from({ length: 6 }, (_, i) => pool.embed([`x${i}`], 'passage'))
    await tick()
    expect(state.inFlight).toBe(3)
    expect(state.maxInFlight).toBe(3)
    await drain(state, ...done)
    expect(state.maxInFlight).toBe(3)
    return pool.close()
  })

  it('a worker that dies MID-embed rejects its in-flight task and is replaced', async () => {
    const { state, spawn } = fakeSpawn()
    const pool = createEmbedPool({ ...opts, workers: 1, spawn })
    const p = pool.embed(['a'], 'passage') // dispatched to the sole worker, gated
    expect(state.inFlight).toBe(1)
    const rejected = expect(p).rejects.toThrow(/died/)
    state.deaths[0]!() // kill the BUSY worker
    await rejected
    expect(state.spawned).toBe(2) // replacement spawned
    expect(state.inFlight).toBe(0) // the dead worker's in-flight slot was released
    // Fire TWO follow-ups on the 1-worker pool: width must stay 1. If the .finally re-add
    // guard regressed and the corpse leaked back into idle, both would dispatch → 2.
    const done = [pool.embed(['b'], 'passage'), pool.embed(['c'], 'passage')]
    await drain(state, ...done)
    expect(state.maxInFlight).toBe(1)
    return pool.close()
  })

  it('degrades to a rejection (not a hang) when a respawn throws synchronously and empties the pool', async () => {
    // The round-2 hole in the crash-loop guard: a SYNCHRONOUS spawn failure (new Worker()
    // throwing on resource exhaustion) adds no worker and no new `dead` promise, so the
    // death counter can't climb to trip `broken` — without the empty-pool trip the queue
    // would hang forever. Here the initial spawn succeeds and the respawn throws.
    const { state, spawn } = fakeSpawn()
    let allow = 1 // only the initial worker spawns; the respawn throws

    const throwingSpawn = (): ReturnType<typeof spawn> => {
      if (allow-- <= 0) {
        throw new Error('EAGAIN: worker init failed')
      }

      return spawn()
    }
    const pool = createEmbedPool({ ...opts, workers: 1, spawn: throwingSpawn })
    expect(state.spawned).toBe(1)
    state.deaths[0]!() // kill the sole worker → respawn throws → pool empty
    await tick()
    // Must NOT hang: a standing/subsequent embed rejects so embedNote degrades to FTS.
    await expect(pool.embed(['x'], 'passage')).rejects.toThrow(/no live workers/)
    return pool.close()
  })

  it('bounds a persistent crash-loop and then degrades embeds to a rejection', async () => {
    const { state, spawn } = fakeSpawn()
    const pool = createEmbedPool({ ...opts, workers: 1, spawn }) // guard cap = 1*2+2 = 4

    // Kill the (idle) worker repeatedly with no embed succeeding in between — each death
    // respawns until the guard trips, then respawns STOP (bounded, no infinite storm).
    for (let i = 0; i < 6; i++) {
      state.deaths[state.deaths.length - 1]!()
      await tick()
    }
    // Bounded: not an unbounded spawn count (cap 4 → 5 total spawns), and no live worker left.
    expect(state.spawned).toBeLessThanOrEqual(6)
    // With no live workers, embeds reject so embedNote degrades to FTS instead of hanging.
    await expect(pool.embed(['x'], 'passage')).rejects.toThrow(/no live workers/)
    return pool.close()
  })

  it('close rejects queued work and terminates every worker', async () => {
    const { state, spawn } = fakeSpawn()
    const pool = createEmbedPool({ ...opts, workers: 1, spawn }) // single worker so 'b' truly queues
    pool.embed(['a'], 'passage') // dispatched, gated (left hanging — close terminates it)
    const queued = pool.embed(['b'], 'passage') // still queued behind 'a'
    const rejected = expect(queued).rejects.toThrow(/closed/)
    await pool.close()
    await rejected
    expect(state.terminated).toBe(1)
    // After close, further embeds reject rather than silently hang.
    await expect(pool.embed(['c'], 'passage')).rejects.toThrow(/closed/)
  })
})
