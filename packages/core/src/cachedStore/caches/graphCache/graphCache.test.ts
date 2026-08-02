import { describe, expect, it, vi } from 'vitest'

import type { Graph } from '../../../knowledgeStore'
import { GraphCache } from './graphCache'

// A cold 350-node force layout deliberately yields across many macrotasks. V8
// coverage instrumentation can stretch one lifecycle case just past Vitest's
// 5s default even though the same workload completes normally without coverage.
vi.setConfig({ testTimeout: 20_000 })

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return
    }
    await nextTurn()
  }
  throw new Error('condition did not become true')
}

const chain = (size: number): Graph => ({
  nodes: Array.from({ length: size }, (_, index) => ({
    id: `n${index}`,
    title: `Note ${index}`,
    filePath: `n${index}.md`,
    folder: '',
    ghost: false,
    degree: index === 0 || index === size - 1 ? 1 : 2,
  })),
  links: Array.from({ length: size - 1 }, (_, index) => ({
    source: `n${index}`,
    target: `n${index + 1}`,
    type: 'links_to',
  })),
})

type GraphCacheState = {
  enriching: { promise: Promise<Graph> } | null
  layoutPositions: ReadonlyMap<string, { x: number; y: number }>
  layoutLinks: number
}

const stateOf = (cache: GraphCache): GraphCacheState => cache as unknown as GraphCacheState

describe('GraphCache lifecycle', () => {
  it('uses the shared gate before Louvain and at every layout yield boundary', async () => {
    let turns = 0
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstTurn = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondTurn = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    let emits = 0
    let shaped!: Graph
    const cache = new GraphCache({
      shape: () => {
        shaped = chain(350)
        return shaped
      },
      emitGraph: () => {
        emits++
      },
      debounceMs: 0,
      canSchedule: () => true,
      scheduler: {
        awaitTurn: () => {
          turns++
          return turns === 1 ? firstTurn : turns === 2 ? secondTurn : Promise.resolve()
        },
      },
    })

    cache.read()
    await nextTurn()
    expect(turns).toBe(1)
    expect(shaped.nodes.every((node) => node.ghost || node.community == null)).toBe(true)
    expect(emits).toBe(0)

    releaseFirst()
    await waitUntil(() => turns === 2)
    expect(shaped.nodes.every((node) => node.ghost || node.community != null)).toBe(true)
    expect(shaped.nodes.every((node) => node.x == null && node.y == null)).toBe(true)
    expect(emits).toBe(0)

    releaseSecond()
    await cache.settle()

    expect(turns).toBeGreaterThan(1)
    expect(emits).toBe(1)
    expect(stateOf(cache).layoutPositions.size).toBe(350)
  })

  it.each(['reset', 'dispose'] as const)(
    'cancels a layout parked at the shared gate after %s',
    async (action) => {
      let turns = 0
      let emits = 0
      const cache = new GraphCache({
        shape: () => chain(350),
        emitGraph: () => {
          emits++
        },
        debounceMs: 0,
        canSchedule: () => true,
        scheduler: {
          awaitTurn: async (signal) => {
            turns++
            if (turns === 1) {
              return
            }
            await new Promise<void>((resolve) => {
              signal?.addEventListener('abort', () => resolve(), { once: true })
            })
          },
        },
      })

      cache.read()
      await waitUntil(() => turns === 2)
      const stale = stateOf(cache).enriching?.promise

      expect(stale).toBeTruthy()
      cache[action]()
      await stale
      await cache.settle()

      expect(turns).toBe(2)
      expect(emits).toBe(0)
      expect(stateOf(cache).layoutPositions.size).toBe(0)
    },
  )

  it('cancels a bare-host layout at its next local yield after reset', async () => {
    vi.useFakeTimers()
    try {
      const cache = new GraphCache({
        shape: () => chain(350),
        emitGraph: () => {},
        debounceMs: 0,
        canSchedule: () => true,
      })

      cache.read()
      await vi.advanceTimersToNextTimerAsync() // start enrich, park at layout's first local yield
      const stale = stateOf(cache).enriching?.promise

      expect(stale).toBeTruthy()
      cache.reset()
      await vi.advanceTimersToNextTimerAsync() // release that yield; signal stops the next tick
      await stale

      expect(stateOf(cache).layoutPositions.size).toBe(0)
      expect(stateOf(cache).enriching).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('joins an active enrichment without publishing after dispose', async () => {
    let emits = 0
    const cache = new GraphCache({
      shape: () => chain(350),
      emitGraph: () => {
        emits++
      },
      debounceMs: 0,
      canSchedule: () => true,
    })

    cache.read()
    await nextTurn()
    const emitsAtDispose = emits

    cache.dispose()
    await cache.settle()

    expect(emits).toBe(emitsAtDispose)
  })

  it('does not publish enrichment from the graph that existed before a reset', async () => {
    let size = 350
    const cache = new GraphCache({
      shape: () => chain(size),
      emitGraph: () => {},
      debounceMs: 0,
      canSchedule: () => true,
    })

    cache.read()
    await nextTurn()
    size = 1
    cache.reset()
    cache.read()
    await nextTurn()
    await cache.settle()

    expect(cache.read().nodes.map((node) => node.id)).toEqual(['n0'])
    expect([...stateOf(cache).layoutPositions.keys()]).toEqual(['n0'])
    expect(stateOf(cache).layoutLinks).toBe(0)
  })

  it('does not let an invalidated pass clear the newer active pass', async () => {
    const cache = new GraphCache({
      shape: () => chain(350),
      emitGraph: () => {},
      debounceMs: 0,
      canSchedule: () => true,
    })

    cache.read()
    await nextTurn()
    const stale = stateOf(cache).enriching?.promise

    expect(stale).toBeTruthy()
    cache.reset()
    cache.read()
    await nextTurn()
    const current = stateOf(cache).enriching?.promise

    expect(current).toBeTruthy()
    expect(current).not.toBe(stale)
    await stale
    expect(stateOf(cache).enriching?.promise).toBe(current)
    await cache.settle()
    expect(stateOf(cache).enriching).toBeNull()
  })
})
