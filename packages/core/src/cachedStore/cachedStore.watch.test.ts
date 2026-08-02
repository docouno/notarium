import { describe, expect, it } from 'vitest'

import { type KnowledgeStore, liveSyncStatus, type StoreDelta } from '../knowledgeStore'
import { CachedStore } from './cachedStore'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const waitFor = async (pred: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const start = Date.now()

  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout waiting for reconcile')
    }
    await sleep(15)
  }
}

/** A bare-engine stub that records how often changes() was pulled and exposes the
 *  watch callback, so a test can fire an external-change signal by hand. */
const makeInner = (canWatch: boolean) => {
  let changesCalls = 0
  let watchCb: (() => void) | null = null
  let closed = false
  const inner: Partial<KnowledgeStore> = {
    capabilities: {
      fts: true,
      vector: false,
      hybrid: false,
      graphExpand: false,
      identity: false,
      cas: false,
      revisions: false,
      trash: false,
      visibility: false,
      watch: canWatch,
    },
    changes: async (): Promise<StoreDelta> => {
      changesCalls++
      return { cursor: '0', upserts: [], inventory: [] }
    },
    list: async () => [],
    graph: async () => ({ nodes: [], links: [] }),
    search: async () => [],
    syncStatus: async () => liveSyncStatus(),
  }

  if (canWatch) {
    inner.watch = (cb: () => void) => {
      watchCb = cb
      return () => {
        closed = true
      }
    }
  }

  return {
    inner: inner as KnowledgeStore,
    get changesCalls() {
      return changesCalls
    },
    get engaged() {
      return watchCb != null
    },
    get closed() {
      return closed
    },
    trigger: () => {
      watchCb?.()
    },
  }
}

describe('CachedStore external-change watcher (#146)', () => {
  it('engages the watcher, reconciles early on a signal, and reports the backstop', async () => {
    const h = makeInner(true)
    // A huge poll interval: any reconcile within the test window can ONLY have
    // come from the watcher fast path, never the periodic timer.
    const cs = new CachedStore({ inner: h.inner, space: 't', pollIntervalMs: 1_000_000 })
    await cs.start()
    expect(h.engaged).toBe(true)

    const status = await cs.syncStatus()
    expect(status.delta.watch).toBe(true)
    // Backstop = max(pollIntervalMs, 5min floor); here the operator's value wins.
    expect(status.delta.intervalMs).toBe(1_000_000)

    const before = h.changesCalls
    h.trigger()
    await waitFor(() => h.changesCalls > before)

    cs.stop()
    expect(h.closed).toBe(true)
  })

  it('degrades to polling when the engine cannot watch', async () => {
    const h = makeInner(false)
    const cs = new CachedStore({ inner: h.inner, space: 't', pollIntervalMs: 50_000 })
    await cs.start()
    expect(h.engaged).toBe(false)

    const status = await cs.syncStatus()
    expect(status.delta.watch).toBe(false)
    // No watcher → no backstop stretch: the responsive poll interval stands.
    expect(status.delta.intervalMs).toBe(50_000)

    cs.stop()
  })

  it('caps the unwatched poll interval at the responsive floor (no regression)', async () => {
    // The operator raised SYNC_POLL_SECONDS to make the WATCHED backstop rare, but
    // this host cannot watch — it must still poll responsively (≤60s), not crawl.
    const h = makeInner(false)
    const cs = new CachedStore({ inner: h.inner, space: 't', pollIntervalMs: 600_000 })
    await cs.start()
    const status = await cs.syncStatus()
    expect(status.delta.watch).toBe(false)
    expect(status.delta.intervalMs).toBe(60_000)
    cs.stop()
  })

  it('honors pollIntervalMs=0 as watch-only (no periodic backstop) when watched', async () => {
    const h = makeInner(true)
    const cs = new CachedStore({ inner: h.inner, space: 't', pollIntervalMs: 0 })
    await cs.start()
    expect(h.engaged).toBe(true)
    const status = await cs.syncStatus()
    expect(status.delta.watch).toBe(true)
    // 0 stays 0 in both regimes — the operator turned the periodic reconcile off.
    expect(status.delta.intervalMs).toBe(0)

    // The watcher still works: a signal reconciles even with no periodic timer.
    const before = h.changesCalls
    h.trigger()
    await waitFor(() => h.changesCalls > before)
    cs.stop()
  })
})
