// The Node build profile (#69): localfs storage + node:sqlite index. Other
// profiles (browser: OPFS + wa-sqlite; cloud scale-out: pg) compose the same
// NotariumStore with different adapters — profiles are compositions, never
// forks (P9).

import type { BackgroundGate, MountConfig } from '@notarium/core'

import type { Chunker } from '../../libs/chunking'
import type { Embedder } from '../../libs/embedding'
import { createLocalFsFiles } from '../../libs/files'
import { createNodeSqliteDriver, type SqlDriver } from '../../libs/sql'
import { NotariumStore } from './notariumStore'
import type { EngineMount, SearchTuning } from './types'

export type CreateNotariumStoreOptions = {
  /** The space's typed mounts (#74/#78): each is a directory whose notes take
   *  one class. The FIRST is the notes-mount (user-doc) and the default write
   *  target. A mount's `prefix` is its space-relative namespace in the index
   *  ('' = the space root); defaults to '' so a single notes-mount round-trips
   *  paths exactly as before. Mutually exclusive with `notesDir`. */
  mounts?: MountConfig[]
  /** Back-compat / single-mount shorthand: the space's notes directory as the
   *  sole user-doc mount at the space root. The files ARE the base (P1). */
  notesDir?: string
  /** Index DB file; ':memory:' (the default) serves tests and throwaway runs —
   *  the index is derived (P2), an ephemeral one just reindexes on boot. */
  indexDb?: string
  relationType?: string
  /** The vector channel (#81), optional capability (P13). When given, the index
   *  driver loads the vec0 extension and the store embeds notes in the
   *  background. If vec0 can't be loaded on this platform (e.g. the musl alpine
   *  image — onnxruntime/vec0 ship glibc binaries), the store DEGRADES to
   *  FTS-only instead of failing: capabilities.vector reports false, the server
   *  stays up. Semantics are a capability, never a hard dependency. */
  embedder?: Embedder
  /** Chunking strategy for embedding (#81). Defaults to the heading-first chunker
   *  (heading-v1; see notariumStore). Only consulted when `embedder` is set. */
  chunker?: Chunker
  /** Hybrid-search fusion tuning (#81 Stage 4b): per-channel RRF weights + graph
   *  channel knobs. Composition root sets it from env; absent → conservative
   *  defaults. */
  searchTuning?: Partial<SearchTuning>
  /** Process-global background scheduler (#196): the shared cooperative gate the
   *  embed backfill yields to. The composition root builds one and hands the SAME
   *  instance to every space's store. Absent → the loop yields with a plain
   *  macrotask gap (pre-#196 behaviour), no cross-space coordination. */
  scheduler?: BackgroundGate
  /** Bounded source-integrity reads per reconcile. Defaults inside the store.
   *  Zero is reserved for deterministic tests. */
  integritySweepBatchSize?: number
}

export const createNotariumStore = ({
  mounts,
  notesDir,
  indexDb,
  relationType,
  embedder,
  chunker,
  searchTuning,
  scheduler,
  integritySweepBatchSize,
}: CreateNotariumStoreOptions): NotariumStore => {
  const configs: MountConfig[] =
    mounts && mounts.length
      ? mounts
      : notesDir != null
        ? [{ class: 'user-doc', dir: notesDir }]
        : []

  if (!configs.length) {
    throw new Error('createNotariumStore requires `mounts` or `notesDir`')
  }
  const engineMounts: EngineMount[] = configs.map((m) => ({
    class: m.class,
    prefix: m.prefix ?? '',
    files: createLocalFsFiles(m.dir),
  }))
  const dbPath = indexDb || ':memory:'
  // Pair the vec0 driver with the embedder, or degrade to FTS together: loading
  // the native vec0 extension can throw on a platform without the binary, and a
  // missing vector backend must not take the whole store down (P13). On failure
  // we drop the embedder too, so the store never tries to embed into a table
  // that isn't there — capabilities then honestly report vector:false.
  let sql: SqlDriver
  let resolvedEmbedder = embedder

  if (embedder) {
    try {
      sql = createNodeSqliteDriver(dbPath, { vec: true })
    } catch (err) {
      console.error('[notarium] vec0 extension unavailable — vector search disabled:', err)
      resolvedEmbedder = undefined
      sql = createNodeSqliteDriver(dbPath)
    }
  } else {
    sql = createNodeSqliteDriver(dbPath)
  }

  return new NotariumStore({
    mounts: engineMounts,
    sql,
    relationType,
    embedder: resolvedEmbedder,
    chunker,
    searchTuning,
    scheduler,
    integritySweepBatchSize,
  })
}
