import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  type GraphRevisionBenchReport,
  type GraphRevisionCacheStats,
  graphRevisionGateFailures,
  graphRevisionMemoryGateFailures,
  type GraphRevisionMemoryReport,
} from '../../scripts/graphRevisionBenchGates'

const report = (): GraphRevisionBenchReport => ({
  scenario: 'graph-revision-v2',
  provenance: {
    commit: 'a'.repeat(40),
    image: `sha256:${'b'.repeat(64)}`,
    imageRevision: 'a'.repeat(40),
    container: 'graph-revision-gate',
  },
  capabilities: { vector: true, graphBoost: true, vectorMode: 'vector' },
  corpus: {
    indexedNotes: 1_357,
    observedNotes: 1_357,
    observedBytes: Math.ceil(20.3 * 1024 * 1024),
  },
  mutation: {
    graphHealthMs: 299,
    adjacencyRefreshMs: 999,
    unrelatedNoteMs: 999,
    adjacency: {
      source: 'source/graph-revision-source.md',
      target: 'target/adjacency-target.md',
      beforeGeneration: 1,
      afterGeneration: 2,
      beforeHasEdge: false,
      afterHasEdge: true,
    },
    heartbeat: {
      samples: 4,
      blocksOverOneSecond: 0,
      totalLatenessMs: 2_999,
      maxResponseMs: 250,
    },
  },
})

const cacheStats = (overrides: Partial<GraphRevisionCacheStats> = {}): GraphRevisionCacheStats => ({
  enabled: true,
  entries: 0,
  labelOccurrences: 0,
  labelCodeUnits: 0,
  inFlight: 0,
  hits: 0,
  misses: 0,
  joins: 0,
  loads: 0,
  rejectedLoads: 0,
  evictions: 0,
  pruned: 0,
  metadataRows: 0,
  bodyReads: 0,
  parserCalls: 0,
  retries: 0,
  fallbacks: 0,
  ...overrides,
})

const memoryReport = (): GraphRevisionMemoryReport => {
  const notes = 1_357
  const summary = {
    raw: Array.from({ length: 5 }, () => ({ heapUsed: 1, rss: 1 })),
    heapUsed: { median: 1, p95: 1 },
    rss: { median: 1, p95: 1 },
  }
  const settled = cacheStats({ entries: notes, labelOccurrences: 2_013 })
  const coldDelta = cacheStats({
    entries: notes,
    labelOccurrences: 2_013,
    labelCodeUnits: 34_221,
    misses: notes * 2,
    joins: notes,
    loads: notes,
    metadataRows: notes * 2,
    bodyReads: notes,
    parserCalls: notes,
  })
  const coldAfter = cacheStats(coldDelta)
  const writeDelta = cacheStats({ misses: 1, parserCalls: 1 })
  const consumersDelta = cacheStats({ hits: notes * 2, metadataRows: notes * 2 })

  return {
    scenario: 'graph-revision-memory-v1',
    notes,
    cache: settled,
    baseline: summary,
    post: summary,
    structure: {
      coldConcurrent: { before: cacheStats(), after: coldAfter, delta: coldDelta },
      warmMutation: {
        before: coldAfter,
        afterWrite: cacheStats({
          ...coldAfter,
          misses: coldAfter.misses + 1,
          parserCalls: notes + 1,
        }),
        afterConsumers: cacheStats({
          ...coldAfter,
          hits: notes * 2,
          misses: coldAfter.misses + 1,
          metadataRows: coldAfter.metadataRows + notes * 2,
          parserCalls: notes + 1,
        }),
        writeDelta,
        consumersDelta,
      },
    },
  }
}

describe('graph revision production gate', () => {
  it('accepts the exact production-shaped boundary', () => {
    expect(graphRevisionGateFailures(report())).toEqual([])
  })

  it('fails closed on disabled channels and malformed provenance', () => {
    const value = report()
    value.provenance.image = 'local-tag'
    value.provenance.imageRevision = 'different'
    value.capabilities.vector = false
    value.capabilities.graphBoost = false
    value.capabilities.vectorMode = 'fts'

    expect(graphRevisionGateFailures(value)).toEqual(
      expect.arrayContaining([
        'graph revision image must be an observed sha256 digest',
        'graph revision OCI revision must match the requested commit',
        'graph revision stand must enable vector search and graph boost',
        'graph revision mutation must run after the vector channel is live',
      ]),
    )
  })

  it('rejects a smaller corpus, latency regressions, missing edge proof and blocked heartbeat', () => {
    const value = report()
    value.corpus = { indexedNotes: 1_356, observedNotes: 1_355, observedBytes: 20 * 1024 * 1024 }
    value.mutation = {
      graphHealthMs: 301,
      adjacencyRefreshMs: 1_001,
      unrelatedNoteMs: 1_001,
      adjacency: {
        source: 'wrong.md',
        target: 'wrong-target.md',
        beforeGeneration: 2,
        afterGeneration: 2,
        beforeHasEdge: true,
        afterHasEdge: false,
      },
      heartbeat: {
        samples: 0,
        blocksOverOneSecond: 1,
        totalLatenessMs: 3_000,
        maxResponseMs: 1_001,
      },
    }

    const failures = graphRevisionGateFailures(value)
    expect(failures).toHaveLength(13)
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('index must contain 1357 notes'),
        expect.stringContaining('volume must contain 1357 notes'),
        expect.stringContaining('indexed and observed note counts must match'),
        expect.stringContaining('observed corpus is below 20.3 MiB'),
        expect.stringContaining('graph health exceeded 300 ms'),
        expect.stringContaining('adjacency refresh exceeded 1000 ms'),
        expect.stringContaining('unrelated note exceeded 1000 ms'),
        expect.stringContaining('wrong edge'),
        expect.stringContaining('advance generation'),
        expect.stringContaining('new source→target edge'),
        expect.stringContaining('heartbeat has no samples'),
        expect.stringContaining('heartbeat blocks >1 s'),
        expect.stringContaining('heartbeat lateness'),
      ]),
    )
  })

  it('fails closed when the corpus byte observation is absent', () => {
    const value = report()
    value.corpus.observedBytes = Number.NaN

    expect(graphRevisionGateFailures(value)).toContain(
      'graph revision observed corpus is below 20.3 MiB: NaN bytes',
    )
  })
})

describe('graph revision structural memory gate', () => {
  it('accepts one cold load joined by both consumers and a metadata-only warm mutation', () => {
    expect(graphRevisionMemoryGateFailures(memoryReport())).toEqual([])
  })

  it('rejects cache bypass, lost single-flight, full-corpus warm parsing and leaked entries', () => {
    const value = memoryReport()
    value.structure.coldConcurrent.after.enabled = false
    value.structure.coldConcurrent.delta.joins = 0
    value.structure.warmMutation.consumersDelta.bodyReads = value.notes
    value.structure.warmMutation.consumersDelta.parserCalls = value.notes
    value.structure.warmMutation.afterConsumers.entries = value.notes + 1

    expect(graphRevisionMemoryGateFailures(value)).toEqual(
      expect.arrayContaining([
        'cold concurrent cache must be enabled',
        expect.stringContaining('cold concurrent joins'),
        expect.stringContaining('warm consumer body reads'),
        expect.stringContaining('warm consumer parser calls'),
        expect.stringContaining('warm settled entries'),
      ]),
    )
  })
})

describe('graph revision dind adapter', () => {
  it('moves runner inputs and reports through the Docker API without client bind mounts', () => {
    const makefile = readFileSync('Makefile', 'utf8')
    const pipeline = readFileSync('.gitlab-ci.yml', 'utf8')
    const target = makefile.slice(
      makefile.indexOf('graph-revision-gate:'),
      makefile.indexOf('# --- session activity read-model benchmark'),
    )

    expect(target).not.toContain('type=bind')
    expect(makefile).toContain('git status --porcelain --untracked-files=normal')
    expect(target.split('docker cp ./scripts/.')).toHaveLength(3)
    expect(target).toContain(':/tmp/graph-revision-memory.json')
    expect(target).toContain(':/tmp/graph-revision-runtime.json')
    expect(target).toContain('GRAPH_REVISION_CORPUS_REPORT=/benchmark-data/')
    expect(makefile).toContain(
      'GRAPH_REVISION_DOCKER_CPU_ARGS = $(if $(strip $(CHECKUP_CPUSET)),--cpuset-cpus "$(CHECKUP_CPUSET)")',
    )
    expect(
      target.match(/docker (?:run|create) \$\(GRAPH_REVISION_DOCKER_CPU_ARGS\)/gu),
    ).toHaveLength(6)
    expect(pipeline).toContain('make graph-revision-gate GRAPH_REVISION_COMMIT="$CI_COMMIT_SHA"')
  })
})
