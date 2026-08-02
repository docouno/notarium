import { describe, expect, it } from 'vitest'

import {
  type KnowledgeStore,
  liveSyncStatus,
  type StoreDelta,
  type SyncStatus,
} from '../knowledgeStore'
import { CachedStore } from './cachedStore'

// The read-model turns the engine's embed-backfill nudges into `status` SSE frames
// : it subscribes to inner.onIndexProgress and, on a tick, pushes a fresh
// status carrying the live `engine.vector` counters — throttled so the loop's
// many-per-second ticks coalesce, and always reading the LATEST counters.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const waitFor = async (pred: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const start = Date.now()

  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout')
    }
    await sleep(15)
  }
}

/** A bare engine stub with a vector channel: exposes the progress callback so a
 *  test can fire a tick by hand, and a mutable vector block syncStatus reflects. */
const makeInner = () => {
  let progressCb: (() => void) | null = null
  let closed = false
  const vector: NonNullable<SyncStatus['engine']['vector']> = {
    mode: 'vector',
    pending: 5,
    total: 10,
  }
  const inner: Partial<KnowledgeStore> = {
    capabilities: {
      fts: true,
      vector: true,
      hybrid: true,
      graphExpand: false,
      identity: false,
      cas: false,
      revisions: false,
      trash: false,
      visibility: false,
      watch: false,
    },
    changes: async (): Promise<StoreDelta> => ({ cursor: '0', upserts: [], inventory: [] }),
    list: async () => [],
    graph: async () => ({ nodes: [], links: [] }),
    search: async () => [],
    syncStatus: async (): Promise<SyncStatus> => ({
      ...liveSyncStatus(),
      engine: { indexing: 'idle', vector: { ...vector } },
    }),
    onIndexProgress: (cb: () => void) => {
      progressCb = cb
      return () => {
        closed = true
        progressCb = null
      }
    },
  }
  return {
    inner: inner as KnowledgeStore,
    tick: () => progressCb?.(),
    setVector: (patch: Partial<typeof vector>) => Object.assign(vector, patch),
    get engaged() {
      return progressCb != null
    },
    get closed() {
      return closed
    },
  }
}

describe('CachedStore embed-backfill progress → status (#199)', () => {
  it('emits a status frame carrying the live vector block on a progress tick', async () => {
    const h = makeInner()
    const cs = new CachedStore({ inner: h.inner, space: 't', pollIntervalMs: 1_000_000 })
    const frames: SyncStatus[] = []
    cs.subscribe((e) => {
      if (e.type === 'status') {
        frames.push(e.status)
      }
    })
    await cs.start()
    expect(h.engaged).toBe(true)
    await sleep(30) // let the boot scan's status frames settle
    frames.length = 0

    // A drain step: pending 5 → 2. The tick (not a scan/poll) drives the frame.
    h.setVector({ pending: 2 })
    h.tick()
    await waitFor(() => frames.some((f) => f.engine.vector?.pending === 2))
    expect(frames.at(-1)?.engine.vector).toEqual({ mode: 'vector', pending: 2, total: 10 })

    cs.stop()
    expect(h.closed).toBe(true)
  })

  it('coalesces a burst of ticks into a single throttled frame with the latest counters', async () => {
    const h = makeInner()
    const cs = new CachedStore({ inner: h.inner, space: 't', pollIntervalMs: 1_000_000 })
    const frames: SyncStatus[] = []
    cs.subscribe((e) => {
      if (e.type === 'status') {
        frames.push(e.status)
      }
    })
    await cs.start()
    await sleep(30)
    frames.length = 0

    // Fire several ticks in quick succession, each advancing the queue. The
    // trailing throttle must collapse them into ONE frame that reads the FINAL
    // (pending 0 = done) counters, not one frame per tick.
    for (const pending of [4, 3, 2, 1, 0]) {
      h.setVector({ pending })
      h.tick()
    }
    await sleep(600) // > INDEX_PROGRESS_THROTTLE_MS
    expect(frames.length).toBe(1)
    expect(frames[0].engine.vector).toEqual({ mode: 'vector', pending: 0, total: 10 })

    cs.stop()
  })
})
