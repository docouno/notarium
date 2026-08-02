import { describe, expect, it } from 'vitest'

import type { SyncStatus } from '../../libs/wire'
import { searchText, staleDot, syncStateOf } from './SyncIndicator'

// staleDot (#98 item 1): the corner-badge staleness, scaled to the POLL CADENCE
// (`delta.intervalMs`) rather than a fixed 1/5-min wall clock — so the default
// 60s poll stops flickering warn at the tail of every normal cycle, and the
// signal stays honest at any configured interval. warn past 2.5 missed polls,
// danger past 5; null when fresh or when polling is off (intervalMs 0).

const at = (lastPollAtMsAgo: number, intervalMs: number): SyncStatus => ({
  scan: { phase: 'ready', startedAt: null, readyAt: null, error: null },
  delta: {
    cursor: null,
    lastPollAt: new Date(Date.now() - lastPollAtMsAgo).toISOString(),
    lastChangeAt: null,
    intervalMs,
  },
  engine: { indexing: 'idle' },
  counts: null,
})

describe('staleDot', () => {
  it('is null with no status, no last poll, or polling off (intervalMs 0)', () => {
    expect(staleDot(null)).toBeNull()
    expect(staleDot(at(99 * 60_000, 0))).toBeNull() // live/uncached engine — staleness has no meaning
  })

  it('stays clean within a normal cycle (the 60s-poll flicker the fix removes)', () => {
    // The old fixed 1-min threshold lit warn here; scaled to the interval it does not.
    expect(staleDot(at(0, 60_000))).toBeNull() // just polled
    expect(staleDot(at(70_000, 60_000))).toBeNull() // one cycle + jitter, still on cadence
    expect(staleDot(at(120_000, 60_000))).toBeNull() // 2× interval — under the 2.5× warn line
  })

  it('warns past ~2.5 missed polls, danger past ~5 (relative to the interval)', () => {
    expect(staleDot(at(160_000, 60_000))).toBe('warn') // 2.67× interval
    expect(staleDot(at(290_000, 60_000))).toBe('warn') // 4.83× — still warn
    expect(staleDot(at(360_000, 60_000))).toBe('danger') // 6× interval
  })

  it('tracks the interval, not the wall clock — a slow poll widens the grace', () => {
    // At a 10-min interval, 7 min stale is well within one cycle → clean (a fixed
    // 5-min danger would have cried wolf).
    expect(staleDot(at(7 * 60_000, 10 * 60_000))).toBeNull()
    // At a 10s interval, 40s stale is 4 missed polls → warn.
    expect(staleDot(at(40_000, 10_000))).toBe('warn')
  })
})

// The embed-backfill leg (#199): content can be fully synced (scan ready, no delta
// churn) while the semantic index still trickles in behind live FTS. syncStateOf
// surfaces that as a distinct low-key working state, UNDER a real content sync.

const ready = (
  engine: SyncStatus['engine'],
  phase: SyncStatus['scan']['phase'] = 'ready',
): SyncStatus => ({
  scan: { phase, startedAt: null, readyAt: null, error: null },
  delta: { cursor: null, lastPollAt: null, lastChangeAt: null, intervalMs: 0 },
  engine,
  counts: null,
})

describe('syncStateOf — embed backfill (#199)', () => {
  it('is embedding while vectors are pending on an otherwise-ready store', () => {
    expect(
      syncStateOf(ready({ indexing: 'idle', vector: { mode: 'vector', pending: 40, total: 100 } })),
    ).toBe('embedding')
  })

  it('is ok once the backfill drains (pending 0) or the engine reports FTS mode', () => {
    expect(
      syncStateOf(ready({ indexing: 'idle', vector: { mode: 'vector', pending: 0, total: 100 } })),
    ).toBe('ok')
    expect(
      syncStateOf(ready({ indexing: 'idle', vector: { mode: 'fts', pending: 0, total: 100 } })),
    ).toBe('ok')
    expect(syncStateOf(ready({ indexing: 'idle' }))).toBe('ok') // no vector channel
  })

  it('a real content sync (busy) or an unfinished scan outranks embedding', () => {
    const backfilling = { mode: 'vector', pending: 5, total: 100 } as const
    expect(syncStateOf(ready({ indexing: 'busy', vector: backfilling }))).toBe('busy')
    expect(syncStateOf(ready({ indexing: 'idle', vector: backfilling }, 'notes'))).toBe('scanning')
  })
})

describe('searchText — mode + progress copy (#199)', () => {
  it('reads Full-text only when the channel degraded/off', () => {
    expect(searchText({ mode: 'fts', pending: 0, total: 100 })).toBe('Full-text only')
  })

  it('shows the done/total count while embedding, and the mode once settled', () => {
    expect(searchText({ mode: 'vector', pending: 40, total: 100 })).toBe('Indexing 60/100')
    expect(searchText({ mode: 'vector', pending: 0, total: 100 })).toBe('Full-text + vector')
  })

  it('never renders a negative done when a write burst outruns a stale total', () => {
    // total (rescan-fresh) briefly lags pending (live queue) → clamp to pending.
    expect(searchText({ mode: 'vector', pending: 5, total: 3 })).toBe('Indexing 0/5')
  })
})
