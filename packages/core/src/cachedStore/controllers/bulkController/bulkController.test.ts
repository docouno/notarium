// Coalescing is the hot path: a bulk import must fan out ONE merged `changed`
// per window, not one per note. These exercise absorb()'s netting/dedup and the
// flush (both the 300ms timer and the end() drain) directly on the module — the
// depth/interactive-mark accounting is covered by cachedStore.scheduler.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BulkController } from './bulkController'
import type { BulkHost } from './types'

const makeHost = () => {
  const dispatched: { upserts: string[]; removed: string[]; folders: string[] }[] = []
  const host: BulkHost = {
    suspendBackground: () => {},
    resumeBackground: () => {},
    flushIdentity: async () => {},
    dispatchChanged: (upserts, removed, folders) => {
      dispatched.push({ upserts, removed, folders })
    },
    foldersOf: (ids) => ids.map((id) => `dir/${id}`),
    poll: () => {},
    refreshGraph: () => {},
  }
  return { host, dispatched }
}

describe('BulkController coalescing', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('collapses a duplicate upsert to one id and flushes once on the outer end', async () => {
    const { host, dispatched } = makeHost()
    const bulk = new BulkController(host)

    bulk.begin()
    expect(bulk.isActive).toBe(true)
    bulk.absorb(['a', 'b'], [])
    bulk.absorb(['a'], []) // duplicate 'a' — the Set dedups
    expect(dispatched).toHaveLength(0) // buffered, not fanned out

    await bulk.end()
    expect(bulk.isActive).toBe(false)
    expect(dispatched).toHaveLength(1)
    expect([...dispatched[0].upserts].sort()).toEqual(['a', 'b'])
    expect(dispatched[0].removed).toEqual([])
    // folders are recomputed fresh over the merged upserts at flush time.
    expect(dispatched[0].folders).toEqual(['dir/a', 'dir/b'])
  })

  it('nets an upsert against a later removal within the window, both directions', async () => {
    const { host, dispatched } = makeHost()
    const bulk = new BulkController(host)

    bulk.begin()
    bulk.absorb(['a'], []) // upsert a …
    bulk.absorb([], ['a']) // … then delete a → nets to removed
    bulk.absorb([], ['c']) // delete c …
    bulk.absorb(['c'], []) // … then upsert c → nets to upsert
    await bulk.end()

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].upserts).toEqual(['c'])
    expect(dispatched[0].removed).toEqual(['a'])
  })

  it('flushes the coalesced buffer on the 300ms timer without an end()', async () => {
    const { host, dispatched } = makeHost()
    const bulk = new BulkController(host)

    bulk.begin()
    bulk.absorb(['a'], [])
    bulk.absorb(['b'], [])
    expect(dispatched).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(300)
    expect(dispatched).toHaveLength(1)
    expect([...dispatched[0].upserts].sort()).toEqual(['a', 'b'])
    expect(bulk.isActive).toBe(true) // still bracketed, buffer reset for the next window

    await bulk.end()
    expect(dispatched).toHaveLength(1) // nothing left to flush
  })

  it('returns false and buffers nothing when not in a bulk bracket', () => {
    const { host, dispatched } = makeHost()
    const bulk = new BulkController(host)

    expect(bulk.absorb(['a'], [])).toBe(false)
    expect(dispatched).toHaveLength(0)
  })

  it('coalesces across a nested bracket and flushes once at the outer end', async () => {
    const { host, dispatched } = makeHost()
    const bulk = new BulkController(host)

    bulk.begin()
    bulk.begin() // depth 2
    bulk.absorb(['a'], [])
    await bulk.end() // inner: depth → 1, no flush yet
    expect(dispatched).toHaveLength(0)

    bulk.absorb(['b'], [])
    await bulk.end() // outer: depth → 0, flush the merged window
    expect(dispatched).toHaveLength(1)
    expect([...dispatched[0].upserts].sort()).toEqual(['a', 'b'])
  })
})
