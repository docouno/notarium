// The Node build profile (#69): localfs storage + node:sqlite index. Other
// profiles (browser: OPFS + wa-sqlite; cloud scale-out: pg) compose the same
// NotariumStore with different adapters — profiles are compositions, never
// forks (P9).

import { resolve } from 'node:path'
import type { BackgroundGate, MountConfig } from '@notarium/core'

import type { Chunker } from '../../libs/chunking'
import type { Embedder } from '../../libs/embedding'
import { createLocalFsFiles, type FileStoreAssembly } from '../../libs/files'
import {
  type ResourceAuthorityAdapter,
  resourceAuthorityAdapterOf,
  type ResourceAuthorityOwner,
  SpaceResourceAuthority,
  type SpaceResourceAuthorityRegistry,
} from '../../libs/resourceAuthority'
import { createNodeSqliteDriver, type SqlDriver } from '../../libs/sql'
import { NotariumStore } from './notariumStore'
import {
  type EngineMount,
  engineMountOf,
  type GraphAdjacencyBuildObservation,
  type SearchTuning,
} from './types'

type CreateNotariumStoreCommonOptions = {
  /** Stable space identity used by the shared resource authority. */
  spaceId?: string
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
  /** Exact-generation in-memory wikilink parser cache. Default true; false is
   * the schema-free operational rollback to reference derivation. */
  wikilinkParseCache?: boolean
  /** Optional private observer for successful adjacency publications. */
  onGraphAdjacencyBuilt?: (observation: GraphAdjacencyBuildObservation) => void | Promise<void>
  /** Process-global background scheduler (#196): the shared cooperative gate the
   *  embed backfill yields to. The composition root builds one and hands the SAME
   *  instance to every space's store. Absent → the loop yields with a plain
   *  macrotask gap (pre-#196 behaviour), no cross-space coordination. */
  scheduler?: BackgroundGate
  /** Bounded source-integrity reads per reconcile. Defaults inside the store.
   *  Zero is reserved for deterministic tests. */
  integritySweepBatchSize?: number
}

type OwnedNotariumStoreOptions = {
  /** Process-owned authority registry. Sharing it requires sharing the physical
   * composition too; accepting inline mounts here could recreate the exact cold
   * authority/warm store split this boundary prevents. */
  resourceAuthorityRegistry?: SpaceResourceAuthorityRegistry
  /** Physical storage composition built once for this space. A host that can
   * construct an authority while the derived store is cold must cache this with
   * NotariumStoreCompositionOwner and pass the same object to both entrypoints. */
  composition: NotariumStoreComposition
  mounts?: never
  notesDir?: never
}

type StandaloneNotariumStoreOptions = {
  resourceAuthorityRegistry?: never
  composition?: never
  /** The space's typed mounts (#74/#78): each is a directory whose notes take
   *  one class. The FIRST is the notes-mount (user-doc) and the default write
   *  target. A mount's `prefix` is its space-relative namespace in the index
   *  ('' = the space root); defaults to '' so a single notes-mount round-trips
   *  paths exactly as before. Mutually exclusive with `notesDir`. */
  mounts?: MountConfig[]
  /** Back-compat / single-mount shorthand: the space's notes directory as the
   *  sole user-doc mount at the space root. The files ARE the base (P1). */
  notesDir?: string
}

export type CreateNotariumStoreOptions = CreateNotariumStoreCommonOptions &
  (OwnedNotariumStoreOptions | StandaloneNotariumStoreOptions)

/** One adapter per mount, built once and then PROJECTED — the note store and the
 *  resource authority are two consumers of the same physical assembly, each
 *  granted its own named view of it. Building the assembly twice would give one
 *  root two independent lock/recovery contexts. */
const mountAssembliesOf = (configs: readonly MountConfig[]): readonly FileStoreAssembly[] =>
  Object.freeze(
    configs.map((mount) => {
      const assembly = createLocalFsFiles(mount.dir)

      Object.freeze(assembly.base)
      for (const capability of Object.values(assembly.capabilities)) {
        if (capability) {
          Object.freeze(capability)
        }
      }
      for (const accelerator of Object.values(assembly.accelerators)) {
        if (accelerator) {
          Object.freeze(accelerator)
        }
      }

      return Object.freeze({
        base: assembly.base,
        capabilities: Object.freeze({ ...assembly.capabilities }),
        accelerators: Object.freeze({ ...assembly.accelerators }),
      })
    }),
  )

const frozenEngineMountOf = (config: MountConfig, assembly: FileStoreAssembly): EngineMount => {
  const mount = engineMountOf({ class: config.class, prefix: config.prefix ?? '' }, assembly)

  return Object.freeze({
    ...mount,
    fileCapabilities: Object.freeze(mount.fileCapabilities),
    fileAccelerators: Object.freeze(mount.fileAccelerators),
  })
}

const engineMountsOf = (
  configs: readonly MountConfig[],
  assemblies: readonly FileStoreAssembly[],
): readonly EngineMount[] =>
  Object.freeze(configs.map((config, index) => frozenEngineMountOf(config, assemblies[index])))

const frozenAuthorityAdapterOf = (
  config: MountConfig,
  index: number,
  assembly: FileStoreAssembly,
): ResourceAuthorityAdapter => {
  const adapter = resourceAuthorityAdapterOf(
    {
      id: `mount-${index}:${config.class}`,
      prefix: config.prefix ?? '',
      physicalRoot: config.dir,
    },
    assembly,
  )

  return Object.freeze({
    ...adapter,
    capabilities: Object.freeze(adapter.capabilities),
  })
}

const authorityAdaptersOf = (
  configs: readonly MountConfig[],
  assemblies: readonly FileStoreAssembly[],
): readonly ResourceAuthorityAdapter[] =>
  Object.freeze(
    configs.map((config, index) => frozenAuthorityAdapterOf(config, index, assemblies[index])),
  )

/** The explicit owner-to-consumer handoff for one space's physical adapters.
 * It retains the assembly privately and exposes only the two named projections:
 * neither the store nor the authority can receive the aggregate capability set.
 * Every call returns detached frozen views over the same frozen implementations. */
declare const notariumStoreCompositionType: unique symbol

export type NotariumStoreComposition = Readonly<{
  mountsForStore: () => readonly EngineMount[]
  adaptersForAuthority: () => readonly ResourceAuthorityAdapter[]
  readonly [notariumStoreCompositionType]: true
}> &
  ResourceAuthorityOwner

/** Runtime provenance is deliberately weaker than ownership: it remembers no
 * space key and retains no composition. It only proves that this exact object
 * crossed the factory boundary, which a frozen structural lookalike cannot do. */
const authenticNotariumStoreCompositions = new WeakSet<object>()

const assertAuthenticNotariumStoreComposition: (
  composition: unknown,
) => asserts composition is NotariumStoreComposition = (composition) => {
  if (
    (typeof composition !== 'object' && typeof composition !== 'function') ||
    composition === null ||
    !authenticNotariumStoreCompositions.has(composition)
  ) {
    throw new Error('notarium store composition must be created by its factory')
  }
}

const mountConfigSnapshotsOf = (mounts: readonly MountConfig[]): readonly Readonly<MountConfig>[] =>
  Object.freeze(
    mounts.map((mount) => {
      const mountClass = mount.class
      const dir = mount.dir
      const prefix = mount.prefix

      return Object.freeze({
        class: mountClass,
        dir,
        ...(prefix === undefined ? {} : { prefix }),
      })
    }),
  )

const createNotariumStoreCompositionFromSnapshot = (
  configs: readonly Readonly<MountConfig>[],
): NotariumStoreComposition => {
  if (!configs.length) {
    throw new Error('notarium store composition requires at least one mount')
  }
  const assemblies = mountAssembliesOf(configs)

  const composition = Object.freeze({
    mountsForStore: Object.freeze(() => engineMountsOf(configs, assemblies)),
    adaptersForAuthority: Object.freeze(() => authorityAdaptersOf(configs, assemblies)),
  }) as NotariumStoreComposition

  authenticNotariumStoreCompositions.add(composition)
  return composition
}

export const createNotariumStoreComposition = (
  mounts: readonly MountConfig[],
): NotariumStoreComposition =>
  createNotariumStoreCompositionFromSnapshot(mountConfigSnapshotsOf(mounts))

const mountTopologyOf = (mounts: readonly MountConfig[]): string =>
  JSON.stringify(
    mounts.map((mount) => ({
      class: mount.class,
      prefix: mount.prefix ?? '',
      physicalRoot: resolve(mount.dir),
    })),
  )

type OwnedNotariumStoreComposition = {
  composition: NotariumStoreComposition
  topology: string
}

/** A process owner for physical storage compositions. It is deliberately an
 * ordinary instance created by the host composition root, not a module-global
 * cache or a lookup available to runtime consumers. */
export class NotariumStoreCompositionOwner {
  private readonly entries = new Map<string, OwnedNotariumStoreComposition>()

  getOrCreate(spaceId: string, mounts: readonly MountConfig[]): NotariumStoreComposition {
    const configs = mountConfigSnapshotsOf(mounts)
    const topology = mountTopologyOf(configs)
    const existing = this.entries.get(spaceId)

    if (existing) {
      if (existing.topology !== topology) {
        throw new Error(`notarium store composition changed for space ${spaceId}`)
      }

      return existing.composition
    }
    const composition = createNotariumStoreCompositionFromSnapshot(configs)

    this.entries.set(spaceId, { composition, topology })
    return composition
  }

  remove(spaceId: string): void {
    this.entries.delete(spaceId)
  }
}

export type EnsureNotariumResourceAuthorityOptions = {
  spaceId: string
  resourceAuthorityRegistry: SpaceResourceAuthorityRegistry
  composition: NotariumStoreComposition
}

/** Register the physical authority without opening the derived SQLite index.
 * Startup restore recovery needs disk truth for closing/archived spaces, while
 * keeping the ordinary read model cold until a projection is actually needed. */
export const ensureNotariumResourceAuthority = (
  input: EnsureNotariumResourceAuthorityOptions,
): SpaceResourceAuthority => {
  assertAuthenticNotariumStoreComposition(input.composition)

  return input.resourceAuthorityRegistry.getOrCreateOwned({
    spaceId: input.spaceId,
    owner: input.composition,
  })
}

export const createNotariumStore = ({
  spaceId = 'default',
  resourceAuthorityRegistry,
  composition,
  mounts,
  notesDir,
  indexDb,
  relationType,
  embedder,
  chunker,
  searchTuning,
  wikilinkParseCache,
  onGraphAdjacencyBuilt,
  scheduler,
  integritySweepBatchSize,
}: CreateNotariumStoreOptions): NotariumStore => {
  if (composition !== undefined) {
    assertAuthenticNotariumStoreComposition(composition)
  }
  if (composition !== undefined && (mounts !== undefined || notesDir !== undefined)) {
    throw new Error(
      'createNotariumStore composition is mutually exclusive with `mounts`/`notesDir`',
    )
  }
  if (resourceAuthorityRegistry && !composition) {
    throw new Error('createNotariumStore shared authority registry requires `composition`')
  }
  const configs: MountConfig[] =
    mounts && mounts.length
      ? mounts
      : notesDir != null
        ? [{ class: 'user-doc', dir: notesDir }]
        : []

  if (!composition && !configs.length) {
    throw new Error('createNotariumStore requires `mounts` or `notesDir`')
  }
  const resolvedComposition = composition ?? createNotariumStoreComposition(configs)
  const engineMounts = resolvedComposition.mountsForStore()
  const resourceAuthority = resourceAuthorityRegistry
    ? resourceAuthorityRegistry.getOrCreateOwned({
        spaceId,
        owner: resolvedComposition,
      })
    : new SpaceResourceAuthority(spaceId, resolvedComposition.adaptersForAuthority())
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
    resourceAuthority,
    sql,
    relationType,
    embedder: resolvedEmbedder,
    chunker,
    searchTuning,
    wikilinkParseCache,
    onGraphAdjacencyBuilt,
    scheduler,
    integritySweepBatchSize,
  })
}
