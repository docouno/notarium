import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createNotariumStore } from '@notarium/engine'

import { buildCaseWorld } from '../test/cases/build'
import { graphRevisionCorpusFiles } from '../test/cases/cases/graphRevision'
import {
  graphRevisionCacheDelta,
  type GraphRevisionCacheStats,
  graphRevisionMemoryGateFailures,
  type GraphRevisionMemoryReport,
} from './graphRevisionBenchGates'

const OUTPUT =
  process.env.GRAPH_REVISION_MEMORY_OUTPUT ?? join('test-results', 'graph-revision', 'memory.json')

if (!global.gc) {
  throw new Error('graph revision memory runner requires node --expose-gc')
}

type MemorySample = { heapUsed: number; rss: number }

const samples = (count: number): MemorySample[] => {
  const values: MemorySample[] = []

  for (let index = 0; index < count; index++) {
    global.gc!()
    const usage = process.memoryUsage()
    values.push({ heapUsed: usage.heapUsed, rss: usage.rss })
  }

  return values
}

const percentile = (values: readonly number[], quantile: number): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

const summary = (values: readonly MemorySample[]) => ({
  heapUsed: {
    median: percentile(
      values.map(({ heapUsed }) => heapUsed),
      0.5,
    ),
    p95: percentile(
      values.map(({ heapUsed }) => heapUsed),
      0.95,
    ),
  },
  rss: {
    median: percentile(
      values.map(({ rss }) => rss),
      0.5,
    ),
    p95: percentile(
      values.map(({ rss }) => rss),
      0.95,
    ),
  },
})

const seedFiles = async (root: string): Promise<number> => {
  const world = buildCaseWorld('graph-revision')
  const events = world.events.filter((event) => event.op === 'create')

  for (const event of events) {
    const path = join(root, event.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, event.content ?? '', 'utf8')
  }

  let fillerCount = 0

  for (const file of graphRevisionCorpusFiles()) {
    const path = join(root, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.content, 'utf8')
    fillerCount++
  }

  return events.length + fillerCount
}

const root = await mkdtemp(join(tmpdir(), 'notarium-graph-revision-memory-'))
const indexDb = join(root, '.derived.db')

try {
  const notes = await seedFiles(root)
  let indexer: ReturnType<typeof createNotariumStore> | null = createNotariumStore({
    notesDir: root,
    indexDb,
    integritySweepBatchSize: 0,
  })

  await indexer.list()
  await indexer.stop()
  indexer = null

  const memoryStore = createNotariumStore({
    notesDir: root,
    indexDb,
    integritySweepBatchSize: 0,
  })
  let cache!: GraphRevisionCacheStats
  let baseline!: GraphRevisionMemoryReport['baseline']
  let post!: GraphRevisionMemoryReport['post']

  try {
    await memoryStore.list()
    const baselineRaw = samples(5)
    await memoryStore.graph()
    const postRaw = samples(5)
    cache = memoryStore.wikilinkParseCacheStats()
    baseline = { raw: baselineRaw, ...summary(baselineRaw) }
    post = { raw: postRaw, ...summary(postRaw) }
  } finally {
    await memoryStore.stop()
  }

  const structuralStore = createNotariumStore({
    notesDir: root,
    indexDb,
    integritySweepBatchSize: 0,
  })

  try {
    await structuralStore.list()
    const rebuild = Reflect.get(structuralStore, 'rebuildGraphAdjacency') as () => Promise<void>
    const coldBefore = structuralStore.wikilinkParseCacheStats()

    await Promise.all([structuralStore.graphHealth(), rebuild.call(structuralStore)])
    const coldAfter = structuralStore.wikilinkParseCacheStats()
    const source = await structuralStore.read('source/graph-revision-source.md')
    const mutationBefore = structuralStore.wikilinkParseCacheStats()

    await structuralStore.write({
      originalId: source.filePath,
      title: source.title,
      content: `${source.content}\n\n[[Graph Completion Oracle]]`,
      versionToken: source.versionToken,
    })
    const mutationAfterWrite = structuralStore.wikilinkParseCacheStats()

    await Promise.all([structuralStore.graphHealth(), rebuild.call(structuralStore)])
    const mutationAfterConsumers = structuralStore.wikilinkParseCacheStats()
    const report: GraphRevisionMemoryReport = {
      scenario: 'graph-revision-memory-v1',
      notes,
      cache,
      baseline,
      post,
      structure: {
        coldConcurrent: {
          before: coldBefore,
          after: coldAfter,
          delta: graphRevisionCacheDelta(coldAfter, coldBefore),
        },
        warmMutation: {
          before: mutationBefore,
          afterWrite: mutationAfterWrite,
          afterConsumers: mutationAfterConsumers,
          writeDelta: graphRevisionCacheDelta(mutationAfterWrite, mutationBefore),
          consumersDelta: graphRevisionCacheDelta(mutationAfterConsumers, mutationAfterWrite),
        },
      },
    }
    const failures = graphRevisionMemoryGateFailures(report)

    await mkdir(dirname(OUTPUT), { recursive: true })
    await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify(report, null, 2))
    if (failures.length) {
      throw new Error(`graph revision memory gates failed:\n${failures.join('\n')}`)
    }
  } finally {
    await structuralStore.stop()
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
