// A streaming import marks the process-global scheduler busy for its whole bracket
// , so the embed backfill in OTHER spaces yields to it — not just this space's
// (which suspendBackground already pauses). The enter/exit must balance 1:1 with the
// re-entrant beginBulk/endBulk depth, and a stop() mid-import must release every mark.

import { describe, expect, it } from 'vitest'

import { type KnowledgeStore, liveSyncStatus, type StoreDelta } from '../knowledgeStore'
import { CachedStore } from './cachedStore'

const makeInner = (): KnowledgeStore => {
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
      watch: false,
    },
    changes: async (): Promise<StoreDelta> => ({ cursor: '0', upserts: [], inventory: [] }),
    list: async () => [],
    graph: async () => ({ nodes: [], links: [] }),
    search: async () => [],
    syncStatus: async () => liveSyncStatus(),
  }
  return inner as KnowledgeStore
}

const spyScheduler = () => {
  let count = 0
  let enters = 0
  let exits = 0
  return {
    signal: {
      awaitTurn: async () => {},
      enterInteractive: () => {
        enters++
        count++
      },
      exitInteractive: () => {
        exits++
        count--
      },
    },
    get count() {
      return count
    },
    get enters() {
      return enters
    },
    get exits() {
      return exits
    },
  }
}

describe('CachedStore bulk marks the shared scheduler (#196)', () => {
  it('enters on beginBulk and exits on endBulk', async () => {
    const spy = spyScheduler()
    const cs = new CachedStore({
      inner: makeInner(),
      space: 't',
      pollIntervalMs: 0,
      scheduler: spy.signal,
    })
    await cs.start()
    cs.beginBulk()
    expect(spy.count).toBe(1)
    await cs.endBulk()
    expect(spy.count).toBe(0)
    expect(spy.enters).toBe(1)
    expect(spy.exits).toBe(1)
    cs.stop()
  })

  it('balances 1:1 across a re-entrant bracket', async () => {
    const spy = spyScheduler()
    const cs = new CachedStore({
      inner: makeInner(),
      space: 't',
      pollIntervalMs: 0,
      scheduler: spy.signal,
    })
    await cs.start()
    cs.beginBulk()
    cs.beginBulk() // nested
    expect(spy.count).toBe(2)
    await cs.endBulk()
    expect(spy.count).toBe(1) // still one bracket open
    await cs.endBulk()
    expect(spy.count).toBe(0) // both closed → back to idle
    cs.stop()
  })

  it('a stop() mid-import releases every held mark', async () => {
    const spy = spyScheduler()
    const cs = new CachedStore({
      inner: makeInner(),
      space: 't',
      pollIntervalMs: 0,
      scheduler: spy.signal,
    })
    await cs.start()
    cs.beginBulk()
    cs.beginBulk()
    expect(spy.count).toBe(2)
    cs.stop() // eviction / shutdown mid-import
    expect(spy.count).toBe(0) // no leaked interactive marks on the shared scheduler
  })
})
