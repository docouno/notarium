import type { BackgroundGate, NoteClass } from '@notarium/core'

import type { Chunker } from '../../libs/chunking'
import type { Embedder } from '../../libs/embedding'
import type {
  FileConditionalMutation,
  FileDirectoryNoReplaceMove,
  FileEntryIdentity,
  FileExactDirectorySpelling,
  FileExactRead,
  FileNoReplaceMove,
  FileResourceExport,
  FileStore,
  FileStoreAssembly,
  FileWatch,
} from '../../libs/files'
import type { SpaceResourceAuthority } from '../../libs/resourceAuthority'
import type { SqlDriver } from '../../libs/sql'
import type { IndexMigration } from './schema'

/** A typed mount (#74/#78): a storage adapter plus the class every file under it
 *  takes (enforced — class is the mount, not a per-file flag) and the
 *  space-relative `prefix` its paths carry in the index. A space is a SET of
 *  mounts feeding one index; mounts have DISJOINT roots (the root notes-mount,
 *  prefix '', never descends into a sub-mount — dot-named sub-mounts like
 *  `.notarium/memory` fall out of its scan for free). Adapters may differ per
 *  mount (P5) — today all localfs, but the seam is the FileStore, not a path. */
/** Exactly the semantics the note store degrades around — publication,
 *  observation and claimed removal answer to the resource authority instead and
 *  are therefore not reachable from here. */
export type EngineMountFileCapabilities = {
  exactRead?: FileExactRead
  resourceExport?: FileResourceExport
  conditionalFileMutation?: FileConditionalMutation
  entryIdentity?: FileEntryIdentity
  fileNoReplaceMove?: FileNoReplaceMove
  directoryNoReplaceMove?: FileDirectoryNoReplaceMove
  watch?: FileWatch
}

export type EngineMountFileAccelerators = {
  exactDirectorySpelling?: FileExactDirectorySpelling
}

export type EngineMount = {
  class: NoteClass
  /** Space-relative namespace for this mount's index paths ('' = the space
   *  root / notes-mount). A row's `path` is `prefix ? prefix/rel : rel`. */
  prefix: string
  files: FileStore
  /** What this mount's adapter declared it can do. A missing entry is a refusal
   *  the store honours; it never probes `files` for an operation. */
  fileCapabilities: EngineMountFileCapabilities
  /** Cheaper routes to answers the store can always reach without them. */
  fileAccelerators: EngineMountFileAccelerators
}

/** Project one adapter assembly onto one mount. The store never sees the
 *  aggregate: it gets the base port under the name it has always used, plus the
 *  two named views above — so which facets this consumer may reach is settled
 *  here, in the wiring, and not by whatever the adapter happens to carry. */
export const engineMountOf = (
  mount: { class: NoteClass; prefix: string },
  assembly: FileStoreAssembly,
): EngineMount => ({
  class: mount.class,
  prefix: mount.prefix,
  files: assembly.base,
  fileCapabilities: {
    ...(assembly.capabilities.exactRead ? { exactRead: assembly.capabilities.exactRead } : {}),
    ...(assembly.capabilities.resourceExport
      ? { resourceExport: assembly.capabilities.resourceExport }
      : {}),
    ...(assembly.capabilities.conditionalFileMutation
      ? { conditionalFileMutation: assembly.capabilities.conditionalFileMutation }
      : {}),
    ...(assembly.capabilities.entryIdentity
      ? { entryIdentity: assembly.capabilities.entryIdentity }
      : {}),
    ...(assembly.capabilities.fileNoReplaceMove
      ? { fileNoReplaceMove: assembly.capabilities.fileNoReplaceMove }
      : {}),
    ...(assembly.capabilities.directoryNoReplaceMove
      ? { directoryNoReplaceMove: assembly.capabilities.directoryNoReplaceMove }
      : {}),
    ...(assembly.capabilities.watch ? { watch: assembly.capabilities.watch } : {}),
  },
  fileAccelerators: {
    ...(assembly.accelerators.exactDirectorySpelling
      ? { exactDirectorySpelling: assembly.accelerators.exactDirectorySpelling }
      : {}),
  },
})

export type NotariumStoreOptions = {
  /** The space's typed mounts (#78). The FIRST is the default write target /
   *  notes-mount (user-doc, prefix ''); further mounts (agent-mount) are hidden
   *  typed placements in the same space. Must be non-empty. */
  mounts: readonly EngineMount[]
  /** One physical-byte/admission authority shared by every mount and sidecar in
   * this space. Optional only for low-level tests that construct the engine
   * directly; production composition always supplies it. */
  resourceAuthority?: SpaceResourceAuthority
  /** Index driver (P9 seam): where the derived index lives. */
  sql: SqlDriver
  /** Edge type for derived wikilink edges. MUST match the read-model's
   *  relationType (both default 'links-to'): boot graph and post-edit patches
   *  go through the same derivation, so the graph never flaps between them. */
  relationType?: string
  /** The vector channel (#81), optional capability (P13). When present, the
   *  store embeds notes in the background and reports vector/hybrid true; the
   *  `sql` driver MUST have been built with the vec0 extension loaded (the
   *  composition root pairs them — see createNotariumStore's graceful
   *  degradation). Absent → no vectors, capabilities honestly false, FTS only. */
  embedder?: Embedder
  /** How notes are split into embeddable units (#81). Defaults to the heading-first
   *  chunker (createHeadingChunker, 'heading-v1'). Only consulted when `embedder` is set. */
  chunker?: Chunker
  /** Hybrid-search fusion tuning (#81 Stage 4b): per-channel RRF weights and the
   *  graph-channel knobs. Merged over DEFAULT_SEARCH_TUNING; the composition root
   *  sets it once (env), the eval harness sweeps it via setSearchTuning. Absent →
   *  the conservative defaults. */
  searchTuning?: Partial<SearchTuning>
  /** The process-global background scheduler (#196): the embed backfill awaits a
   *  turn from it between notes so it yields the cores/event-loop to interactive
   *  traffic (in ANY space) instead of starving it on a large first index. Absent
   *  (a bare engine / test) → the loop falls back to a plain macrotask yield between
   *  notes, exactly as before #196 — the gate is an optional cooperative capability,
   *  never a hard dependency. One instance is shared by every space (the composition
   *  root builds it once). */
  scheduler?: BackgroundGate
  /** Number of unchanged files source-verified on each reconcile. The rotating
   *  cursor is persisted in the derived index, so every positive value guarantees
   *  convergence across restarts while bounding per-poll I/O. Defaults to 64.
   *  Zero is a test escape hatch; production composition leaves it on. */
  integritySweepBatchSize?: number
  /** The index-schema migration ladder (schema.ts INDEX_MIGRATIONS). A TEST SEAM:
   *  a test can inject a synthetic ladder with an APPENDED step to drive
   *  ensureReady's apply-loop through a real migration. Absent → the canonical
   *  INDEX_MIGRATIONS. */
  migrations?: readonly IndexMigration[]
}

/** Reciprocal-Rank-Fusion + graph-channel knobs (#81 Stage 4b). All channels fuse
 *  in JS over per-channel ranks (RRF, k = rrfK): score = Σ w_c/(k + rank_c). The
 *  graph channel is a hub-robust 1-hop expansion of the top fused fts+vec hits —
 *  see NotariumStore.hybridSearch. Defaults are CONSERVATIVE and directional: the
 *  only corpus available to calibrate (#81 Stage 4a) is hub-dominated and its
 *  known-item gold can't reward graph expansion, so absolute weights are
 *  mechanics-validated, not corpus-optimal (the channel's quality is proven on a
 *  synthetic fixture instead). */
export type SearchTuning = {
  /** RRF smoothing constant k (the canonical 60 from the RRF paper). */
  rrfK: number
  /** Lexical (FTS5) channel weight. */
  wFts: number
  /** Vector (vec0) channel weight. */
  wVec: number
  /** Graph (1-hop wikilink) channel weight. 0 disables the channel entirely. */
  wGraph: number
  /** Per-channel candidate pool size — how many fts and vec hits are fused before
   *  the graph expansion and the page cut. Defaults to RRF_POOL (100); a small value
   *  is mainly a test seam (force a graph neighbour outside the pool). */
  poolSize: number
  /** How many top fused fts+vec hits seed the graph expansion. */
  graphSeedS: number
  /** Per-seed cap: at most this many neighbours per seed contribute (the highest
   *  seed_score × edge_weight ones), so one densely-linked seed can't flood. */
  graphPerSeedL: number
  /** Global hub blacklist: nodes in the top fraction by degree are EXCLUDED as
   *  neighbours (they're too generic to carry relevance — hub-flooding, #81 Stage
   *  4a research). 0.01 = top 1%. 0 disables the blacklist. */
  graphHubPercentile: number
  /** Edge down-weight by neighbour degree (hub-robustness): 'invdeg' = 1/deg,
   *  'invsqrtdeg' = 1/√deg (on a wiki df≈in-degree, so 1/√deg ≈ SPRIG df^-0.5). */
  graphEdgeWeight: 'invdeg' | 'invsqrtdeg'
}

/** One index row — the engine's entire knowledge about a note between reads.
 *  `class` is derived from the mount the file was scanned out of (#78). `body`
 *  is the normalised read() view (frontmatter object split off, title heading
 *  stripped); `seq` is the monotonic change stamp changes() cursors ride on. */
export type NoteRow = {
  path: string
  title: string
  class: NoteClass
  mtime_ms: number
  size: number
  created_at: string | null
  modified_at: string | null
  note_type: string
  id_claim: string | null
  source_locator: string | null
  tags: string
  /** Alias-history (#100) as a JSON string array — past human names the link
   *  resolver still honours, parsed from frontmatter `aliases:`. Defaults '[]'. */
  aliases: string
  /** The editable display slug (#100 phase 1) from frontmatter `slug:`, NULL when the
   *  note has no custom slug (the implicit slug(title) default is not stored). */
  slug: string | null
  body: string
  /** sha-256 over the chunker OUTPUT (per-chunk text joined by NUL) at last index —
   *  the vector-invalidation arbiter (#81/P13); changes iff the embed input changes
   *  (a whitespace-only edit the chunker trims does NOT churn it). Null on a row never
   *  seen by a hashing build (can't happen on a content-hashing index: every upsert sets it). */
  content_hash: string | null
  /** sha-256 of the source whose vectors are FULLY embedded (#81 Stage 3) — the
   *  multi-chunk completeness sentinel, set as the last step of a successful embed.
   *  Null until first embedded; `content_hash != embedded_hash` ⇒ (re)embed needed. */
  embedded_hash: string | null
  seq: number
}
