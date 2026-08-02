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
