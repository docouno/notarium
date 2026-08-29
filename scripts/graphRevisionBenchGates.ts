export type GraphRevisionBenchReport = {
  scenario: 'graph-revision-v2'
  provenance: {
    commit: string
    image: string
    imageRevision: string
    container: string
  }
  capabilities: { vector: boolean; graphBoost: boolean; vectorMode: string }
  corpus: { indexedNotes: number; observedNotes: number; observedBytes: number }
  mutation: {
    graphHealthMs: number
    adjacencyRefreshMs: number
    unrelatedNoteMs: number
    adjacency: {
      source: string
      target: string
      beforeGeneration: number
      afterGeneration: number
      beforeHasEdge: boolean
      afterHasEdge: boolean
    }
    heartbeat: {
      samples: number
      blocksOverOneSecond: number
      totalLatenessMs: number
      maxResponseMs: number
    }
  }
}

export type GraphRevisionCacheStats = {
  enabled: boolean
  entries: number
  labelOccurrences: number
  labelCodeUnits: number
  inFlight: number
  hits: number
  misses: number
  joins: number
  loads: number
  rejectedLoads: number
  evictions: number
  pruned: number
  metadataRows: number
  bodyReads: number
  parserCalls: number
  retries: number
  fallbacks: number
}

type MemorySummary = {
  raw: Array<{ heapUsed: number; rss: number }>
  heapUsed: { median: number; p95: number }
  rss: { median: number; p95: number }
}

export type GraphRevisionMemoryReport = {
  scenario: 'graph-revision-memory-v1'
  notes: number
  cache: GraphRevisionCacheStats
  baseline: MemorySummary
  post: MemorySummary
  structure: {
    coldConcurrent: {
      before: GraphRevisionCacheStats
      after: GraphRevisionCacheStats
      delta: GraphRevisionCacheStats
    }
    warmMutation: {
      before: GraphRevisionCacheStats
      afterWrite: GraphRevisionCacheStats
      afterConsumers: GraphRevisionCacheStats
      writeDelta: GraphRevisionCacheStats
      consumersDelta: GraphRevisionCacheStats
    }
  }
}

const CACHE_COUNTERS = [
  'entries',
  'labelOccurrences',
  'labelCodeUnits',
  'inFlight',
  'hits',
  'misses',
  'joins',
  'loads',
  'rejectedLoads',
  'evictions',
  'pruned',
  'metadataRows',
  'bodyReads',
  'parserCalls',
  'retries',
  'fallbacks',
] as const

export const graphRevisionCacheDelta = (
  after: GraphRevisionCacheStats,
  before: GraphRevisionCacheStats,
): GraphRevisionCacheStats => {
  const delta = { enabled: after.enabled } as GraphRevisionCacheStats

  for (const field of CACHE_COUNTERS) {
    delta[field] = after[field] - before[field]
  }

  return delta
}

export const graphRevisionGateFailures = (report: GraphRevisionBenchReport): string[] => {
  const failures: string[] = []

  if (report.scenario !== 'graph-revision-v2') {
    failures.push(`unknown graph revision scenario: ${report.scenario}`)
  }
  for (const field of ['commit', 'image', 'imageRevision', 'container'] as const) {
    if (!report.provenance[field]?.trim()) {
      failures.push(`graph revision provenance.${field} is required`)
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(report.provenance.image)) {
    failures.push('graph revision image must be an observed sha256 digest')
  }
  if (report.provenance.imageRevision !== report.provenance.commit) {
    failures.push('graph revision OCI revision must match the requested commit')
  }
  if (!report.capabilities.vector || !report.capabilities.graphBoost) {
    failures.push('graph revision stand must enable vector search and graph boost')
  }
  if (report.capabilities.vectorMode !== 'vector') {
    failures.push('graph revision mutation must run after the vector channel is live')
  }
  if (report.corpus.indexedNotes !== 1_357) {
    failures.push(`graph revision index must contain 1357 notes, got ${report.corpus.indexedNotes}`)
  }
  if (report.corpus.observedNotes !== 1_357) {
    failures.push(
      `graph revision volume must contain 1357 notes, got ${report.corpus.observedNotes}`,
    )
  }
  if (report.corpus.indexedNotes !== report.corpus.observedNotes) {
    failures.push('graph revision indexed and observed note counts must match')
  }
  if (
    !Number.isFinite(report.corpus.observedBytes) ||
    report.corpus.observedBytes < Math.ceil(20.3 * 1024 * 1024)
  ) {
    failures.push(
      `graph revision observed corpus is below 20.3 MiB: ${report.corpus.observedBytes} bytes`,
    )
  }
  if (!Number.isFinite(report.mutation.graphHealthMs) || report.mutation.graphHealthMs > 300) {
    failures.push(`fresh graph health exceeded 300 ms: ${report.mutation.graphHealthMs}`)
  }
  if (
    !Number.isFinite(report.mutation.adjacencyRefreshMs) ||
    report.mutation.adjacencyRefreshMs > 1_000
  ) {
    failures.push(`fresh adjacency refresh exceeded 1000 ms: ${report.mutation.adjacencyRefreshMs}`)
  }
  if (
    !Number.isFinite(report.mutation.unrelatedNoteMs) ||
    report.mutation.unrelatedNoteMs > 1_000
  ) {
    failures.push(`unrelated note exceeded 1000 ms: ${report.mutation.unrelatedNoteMs}`)
  }
  const adjacency = report.mutation.adjacency

  if (
    adjacency.source !== 'source/graph-revision-source.md' ||
    adjacency.target !== 'target/adjacency-target.md'
  ) {
    failures.push('graph revision adjacency observation names the wrong edge')
  }
  if (adjacency.beforeGeneration < 1 || adjacency.afterGeneration <= adjacency.beforeGeneration) {
    failures.push('graph revision adjacency observation did not advance generation')
  }
  if (adjacency.beforeHasEdge || !adjacency.afterHasEdge) {
    failures.push('graph revision adjacency observation did not prove the new source→target edge')
  }
  const heartbeat = report.mutation.heartbeat

  if (heartbeat.samples < 1) {
    failures.push('graph revision heartbeat has no samples')
  }
  if (heartbeat.blocksOverOneSecond !== 0) {
    failures.push(`graph revision observed ${heartbeat.blocksOverOneSecond} heartbeat blocks >1 s`)
  }
  if (heartbeat.totalLatenessMs >= 3_000) {
    failures.push(`graph revision heartbeat lateness reached ${heartbeat.totalLatenessMs} ms`)
  }

  return failures
}

export const graphRevisionMemoryGateFailures = (report: GraphRevisionMemoryReport): string[] => {
  const failures: string[] = []

  const expectCount = (actual: number, expected: number, label: string): void => {
    if (actual !== expected) {
      failures.push(`${label}: expected ${expected}, got ${actual}`)
    }
  }

  if (report.scenario !== 'graph-revision-memory-v1') {
    failures.push(`unknown graph revision memory scenario: ${report.scenario}`)
  }
  expectCount(report.notes, 1_357, 'memory corpus notes')
  if (!report.cache.enabled) {
    failures.push('memory cache must be enabled')
  }
  expectCount(report.cache.entries, report.notes, 'memory settled entries')
  expectCount(report.cache.labelOccurrences, 2_013, 'memory label occurrences')
  expectCount(report.cache.inFlight, 0, 'memory settled in-flight loads')

  const cold = report.structure.coldConcurrent
  const coldDelta = cold.delta

  if (!cold.after.enabled) {
    failures.push('cold concurrent cache must be enabled')
  }
  expectCount(cold.before.entries, 0, 'cold concurrent starting entries')
  expectCount(coldDelta.metadataRows, report.notes * 2, 'cold concurrent metadata rows')
  expectCount(coldDelta.hits, 0, 'cold concurrent cache hits')
  expectCount(coldDelta.misses, report.notes * 2, 'cold concurrent cache misses')
  expectCount(coldDelta.bodyReads, report.notes, 'cold concurrent body reads')
  expectCount(coldDelta.parserCalls, report.notes, 'cold concurrent parser calls')
  expectCount(coldDelta.loads, report.notes, 'cold concurrent loads')
  expectCount(coldDelta.joins, report.notes, 'cold concurrent joins')
  expectCount(coldDelta.retries, 0, 'cold concurrent retries')
  expectCount(coldDelta.fallbacks, 0, 'cold concurrent fallbacks')
  expectCount(cold.after.entries, report.notes, 'cold concurrent settled entries')
  expectCount(cold.after.inFlight, 0, 'cold concurrent settled in-flight loads')

  const warm = report.structure.warmMutation

  if (!warm.afterConsumers.enabled) {
    failures.push('warm mutation cache must be enabled')
  }
  expectCount(warm.writeDelta.bodyReads, 0, 'warm write body reads')
  expectCount(warm.writeDelta.parserCalls, 1, 'warm write parser calls')
  expectCount(warm.writeDelta.misses, 1, 'warm write cache misses')
  expectCount(warm.writeDelta.loads, 0, 'warm write cache loads')
  expectCount(warm.writeDelta.fallbacks, 0, 'warm write fallbacks')
  expectCount(warm.consumersDelta.metadataRows, report.notes * 2, 'warm consumer metadata rows')
  expectCount(warm.consumersDelta.hits, report.notes * 2, 'warm consumer cache hits')
  expectCount(warm.consumersDelta.misses, 0, 'warm consumer cache misses')
  expectCount(warm.consumersDelta.joins, 0, 'warm consumer cache joins')
  expectCount(warm.consumersDelta.bodyReads, 0, 'warm consumer body reads')
  expectCount(warm.consumersDelta.parserCalls, 0, 'warm consumer parser calls')
  expectCount(warm.consumersDelta.loads, 0, 'warm consumer cache loads')
  expectCount(warm.consumersDelta.retries, 0, 'warm consumer retries')
  expectCount(warm.consumersDelta.fallbacks, 0, 'warm consumer fallbacks')
  expectCount(warm.afterConsumers.entries, report.notes, 'warm settled entries')
  expectCount(warm.afterConsumers.inFlight, 0, 'warm settled in-flight loads')

  return failures
}
