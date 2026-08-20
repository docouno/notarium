// NotariumStore — the canonical KnowledgeStore engine (#69): markdown files
// are the truth (P1), the SQLite index (FTS5) is derived and disposable (P2),
// and watcher events are only targeted wake-ups — changes(cursor) still runs a
// full stat-walk plus a bounded rotating source-hash sweep every poll, so
// correctness comes from reconciliation by construction (P3), not from trusting
// filesystem events. Bare on purpose: identity, CAS and
// the journal live in the read-model layer (CachedStore) — this engine speaks
// storage paths and serves honestly from disk.
//
// MOUNTS & CLASS (#74/#78): a space is a SET of typed mounts (notes-mount,
// agent-mount, …) feeding ONE index with a `class` column. The engine MATERIALIZES
// each row's class from the mount it scanned the file out of (enforced — class
// is the mount, not a per-file flag). It does NOT enforce the visibility
// invariant: a bare engine returns the full population (capabilities.visibility
// = false); the read-model (CachedStore) is the single chokepoint that hides
// classes per surface. In production every engine sits behind the read-model.

import { randomUUID } from 'node:crypto'

import type {
  BackgroundGate,
  ExportEntry,
  GhostStub,
  Graph,
  GraphHealth,
  GraphLink,
  KnowledgeStore,
  ListOptions,
  MoveInput,
  MoveResult,
  MutationOptions,
  NoteChange,
  NoteClass,
  NoteContent,
  NoteMeta,
  PhysicalIncarnation,
  Preview,
  ReadOptions,
  ReadScope,
  ResolvedVia,
  SearchOptions,
  SearchResult,
  StoreCapabilities,
  StoreDelta,
  SyncStatus,
  WriteInput,
  WriteResult,
} from '@notarium/core'
import {
  aggregateGraphHealth,
  analyzeDocumentState,
  basenameOf,
  bindStorageOwnerProof,
  boundNameToBytes,
  buildLinkIndex,
  classesForScope,
  collectPreviews,
  decodeWikilinkIdentity,
  DEFAULT_NOTE_TYPE,
  deriveNoteEdges,
  derivePreview,
  destinationOwnerConflict,
  directoryOf,
  DOCUMENT_ROLE,
  DOCUMENT_STATE_FORMAT,
  type DocumentRole,
  documentStateVersionToken,
  effectiveSlug,
  exactOwnerObservation,
  FOLDER_PAGE_BASENAME,
  type FolderAlias,
  freshNoteId,
  frontmatterEntryValue,
  FrontmatterLimitError,
  frontmatterValue,
  type IdentityMaterialization,
  type IdentityMaterializationInput,
  IF_EXISTS,
  isCanonicalInternalRelativeAddress,
  isCanonicalSafeRelativeAddress,
  isDurableFrontmatter,
  isDurableScalar,
  isDurableText,
  isFolderPageNote,
  isImportNoteSourceLocator,
  isLegacyImportDestination,
  isPortableMoveDestination,
  isPortablePathComponent,
  isPortableRelativeDestination,
  isSkillPackageRootPath,
  isValidNoteId,
  isVisibleOn,
  isWikilinkIdentityTarget,
  liveSyncStatus,
  logicalNoteState,
  nextAliasesMulti,
  normalizeWikilinkTarget,
  normTags,
  NOTE_BASENAME_MAX_BYTES,
  NOTE_ID_FRONTMATTER_KEY,
  noteAlreadyExists,
  noteFileBase,
  noteFilePath,
  noteNotFound,
  parseFrontmatterBlock,
  registerLinkIdentity,
  resolveLink,
  sha256Hex,
  shapeGraph,
  skillNameConflict,
  skillPackagePathOf,
  sluggedNoteName,
  STORAGE_OWNER_KEY,
  type StorageOwnerKey,
  type StorageOwnerProof,
  storedSlug,
  StoreError,
  SURFACE,
  uniqueSlug,
  UNNAMED_NOTE_FILENAME,
  upsertFrontmatterKey,
} from '@notarium/core'

import { type Chunker, createHeadingChunker } from '../../libs/chunking'
import type { Embedder } from '../../libs/embedding'
import { exactDirSpellings, type FileClaim, type FileStat } from '../../libs/files'
import {
  type MutationReceipt,
  type ResourceObservation,
  sameFileClaim,
  type SpaceResourceAuthority,
} from '../../libs/resourceAuthority'
import type { SqlDriver } from '../../libs/sql'
import { parseNoteFile, serializeNoteFile } from './noteFile'
import {
  INDEX_MIGRATIONS,
  INDEX_VERSION_KEY,
  type IndexMigration,
  LEGACY_VERSION_KEY,
  META_CHUNKER_VERSION,
  META_EMBEDDER_DIMS,
  META_EMBEDDER_ID,
  META_INTEGRITY_SWEEP_CURSOR,
  META_SCHEMA,
  META_VEC_LAYOUT,
  planIndexMigration,
  TEARDOWN,
  VEC_LAYOUT_VERSION,
  VEC_TEARDOWN,
  vecSchema,
} from './schema'
import type { EngineMount, NotariumStoreOptions, NoteRow, SearchTuning } from './types'

/** The meta columns `metaOf()` projects — everything the read-model's snapshot needs
 *  EXCEPT the note `body`. The whole read/reconcile path (space-open seed, list(),
 *  every poll) runs synchronous `node:sqlite` on the shared loop, so it must SELECT
 *  exactly these, never `SELECT *` (#222): `metaOf` never touches `body`, so pulling
 *  the body column for a metadata projection materializes the entire corpus's bodies
 *  for nothing — O(corpus bytes) of loop-blocking work that stalls every other space.
 *  Bodies are fetched only where genuinely used: the delta's changed upserts and the
 *  graph's wikilink derivation. */
const NOTE_META_COLS =
  'path, title, class, created_at, modified_at, id_claim, source_locator, aliases, slug, tags'
type NoteMetaRow = Pick<
  NoteRow,
  | 'path'
  | 'title'
  | 'class'
  | 'created_at'
  | 'modified_at'
  | 'id_claim'
  | 'source_locator'
  | 'aliases'
  | 'slug'
  | 'tags'
>
type ReconcileRow = Pick<NoteRow, 'path' | 'class' | 'mtime_ms' | 'size' | 'seq'> & {
  rowid: number
  change_token: string | null
  source_hash: string | null
}

/** The engine's ONE way to read a note's bytes as text — the same one
 *  `FileStore.read` already answers with (`Buffer.toString('utf8')`), so a file's
 *  text is the same string whichever door produced it. A default `TextDecoder` is
 *  not that door: it eats a leading U+FEFF, and a vault holds files a Windows
 *  editor (or a restore) wrote with one. The index fingerprints a note through
 *  `FileStore.read`, so a write path that decoded the same bytes without the mark
 *  hashed a DIFFERENT string and the CAS fence refused every save of such a note
 *  forever. Decoding must be the exact inverse of the `TextEncoder` this file
 *  writes back with; `ignoreBOM: true` means "emit the mark", not "skip past it".
 *  Non-strict on purpose: an undecodable byte becomes U+FFFD here exactly as it
 *  does for `FileStore.read`, and this decoder must not disagree with it. */
const NOTE_TEXT_UTF8 = new TextDecoder('utf-8', { ignoreBOM: true })

const RESOURCE_OBSERVATION_CLAIM_KIND = 'resource-observation-v1'

const physicalIncarnationOf = (
  observation: ResourceObservation & { kind: 'present' },
): PhysicalIncarnation => ({
  claim: {
    kind: RESOURCE_OBSERVATION_CLAIM_KIND,
    value: `${observation.adapterId}:${observation.claim.value}`,
  },
  owner: exactOwnerObservation(observation.bytes),
})

const observedFileClaim = (
  incarnation: PhysicalIncarnation,
  observation: ResourceObservation & { kind: 'present' },
): (FileClaim & { kind: 'present' }) | null => {
  if (
    incarnation.claim.kind !== RESOURCE_OBSERVATION_CLAIM_KIND ||
    !incarnation.claim.value.startsWith(`${observation.adapterId}:`)
  ) {
    return null
  }
  const value = incarnation.claim.value.slice(observation.adapterId.length + 1)

  return value ? { kind: 'present', value } : null
}

const sameOwnerObservation = (
  left: PhysicalIncarnation['owner'],
  right: PhysicalIncarnation['owner'],
): boolean =>
  left.kind === right.kind &&
  (left.kind !== 'claimed' || (right.kind === 'claimed' && left.id === right.id))

/** In-memory undirected wikilink adjacency for the graph search channel (#81 Stage
 *  4b), keyed on node id = storage path (the bare-engine identity, same as
 *  shapeGraph). Built lazily from the note bodies via the canon core graph builders
 *  and invalidated on any note mutation — see ensureGraphAdjacency. Weight-INDEPENDENT
 *  (no tuning baked in) so the eval can sweep weights against one cached structure;
 *  the hub blacklist is derived per query from `degree` + the live graphHubPercentile. */
type GraphAdjacency = {
  /** Real-node → set of real-node neighbours (ghosts excluded, undirected). */
  adj: Map<string, Set<string>>
  /** Node id → undirected degree (number of real neighbours). */
  degree: Map<string, number>
  /** Total notes in the corpus (incl. isolated, unlinked ones) — the denominator
   *  the hub percentile is taken over, so "top 1%" means 1% of the corpus, not 1%
   *  of the linked subset. */
  total: number
}

/** Bounded retries for the exact stat→read→stat observation and for the whole
 *  convergence loop: a path someone rewrites in a tight loop must fail closed
 *  rather than spin. */
const STABLE_SNAPSHOT_ATTEMPTS = 8
const MATERIALIZE_ATTEMPTS = 8

/** Same file version: content verification is still the arbiter, this only says
 *  the medium has not published a new generation at that pathname. */
const sameFileGeneration = (left: FileStat, right: FileStat): boolean =>
  left.path === right.path &&
  left.mtimeMs === right.mtimeMs &&
  left.size === right.size &&
  left.changeToken === right.changeToken

/** The global hub blacklist for the graph channel (#81 Stage 4a research): the top
 *  `pct` of the corpus by degree are too generic to carry relevance (hub-flooding) →
 *  excluded as neighbours. The cut is taken over `total` (the whole note population,
 *  not just linked nodes — #81 Stage 4b review): isolated notes can never be hubs
 *  (degree 0, absent from `degree`), but counting them keeps "top 1%" meaning 1% of
 *  the corpus the operator tuned against. Derived per query so it tracks a swept
 *  graphHubPercentile without rebuilding the adjacency.
 *
 *  Returns EMPTY (no hubs) when there is no genuine degree spread — `threshold` at
 *  or below the minimum present degree means a sparse OR a degree-regular graph (a
 *  star's long degree-1 tail, a ring of daily notes): blacklisting on a flat
 *  distribution would catch the WHOLE graph and silently disable the channel, so we
 *  blacklist nobody and let the 1/√deg edge weight do the de-emphasis (#81 Stage 4b
 *  review — fixes both the sparse-corpus and the regular-graph self-disable). */
const computeHubs = (degree: Map<string, number>, pct: number, total: number): Set<string> => {
  const hubs = new Set<string>()

  if (pct <= 0 || !degree.size) {
    return hubs
  }
  const cut = Math.floor(total * pct)

  if (cut < 1) {
    return hubs
  }
  const desc = [...degree.values()].sort((a, b) => b - a)
  const threshold = desc[Math.min(cut, desc.length) - 1] // degree at the cut rank
  const minDegree = desc[desc.length - 1]

  if (threshold <= minDegree) {
    return hubs
  } // no real hubs (flat/regular distribution)
  for (const [id, d] of degree) {
    if (d >= threshold) {
      hubs.add(id)
    }
  }

  return hubs
}

const moveFailed = (detail: string): StoreError => {
  const err = new StoreError(`# Move Failed: ${detail}`)
  err.isToolError = true
  return err
}

const writeFailed = (detail: string): StoreError => {
  const err = new StoreError(`# Write Failed: ${detail}`)
  err.isToolError = true
  return err
}

const isoOrNull = (ms: number | null): string | null => (ms ? new Date(ms).toISOString() : null)

/** Every ancestor of a directory pathname, outermost first — the granularity both
 *  destination fences reason in. */
const ancestorPrefixes = (directory: string): string[] => {
  const parts = directory.split('/').filter(Boolean)

  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

/** Parse a JSON string-array index column (tags/aliases) defensively — a
 *  malformed value degrades to empty rather than crashing the index read. */
const parseJsonArray = (s: string | null | undefined): string[] => {
  if (!s) {
    return []
  }
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const parseStoredOwnerProof = (raw: string): StorageOwnerProof | undefined => {
  try {
    const value: unknown = JSON.parse(raw)

    if (
      typeof value !== 'object' ||
      value === null ||
      (value as { version?: unknown }).version !== 1 ||
      !Array.isArray((value as { claims?: unknown }).claims)
    ) {
      return undefined
    }
    const claims = (value as { claims: unknown[] }).claims

    if (
      claims.some(
        (claim) =>
          typeof claim !== 'object' ||
          claim === null ||
          typeof (claim as { key?: unknown }).key !== 'string' ||
          !['value', 'entry'].includes(String((claim as { ownership?: unknown }).ownership)) ||
          !['mutation-receipt', 'audited-repair'].includes(
            String((claim as { evidence?: { kind?: unknown } }).evidence?.kind),
          ) ||
          typeof (claim as { evidence?: { id?: unknown } }).evidence?.id !== 'string' ||
          typeof (claim as { valueRange?: { start?: unknown } }).valueRange?.start !== 'number' ||
          typeof (claim as { valueRange?: { end?: unknown } }).valueRange?.end !== 'number' ||
          typeof (claim as { entryRange?: { start?: unknown } }).entryRange?.start !== 'number' ||
          typeof (claim as { entryRange?: { end?: unknown } }).entryRange?.end !== 'number',
      )
    ) {
      return undefined
    }

    return value as StorageOwnerProof
  } catch {
    return undefined
  }
}

const ownerValue = (raw: string | null, key: StorageOwnerKey): string | undefined => {
  if (raw == null) {
    return undefined
  }
  const matches = (parseFrontmatterBlock(raw)?.entries ?? []).filter((entry) => entry.key === key)

  if (matches.length !== 1) {
    return undefined
  }
  const value = frontmatterEntryValue(matches[0])

  return typeof value === 'string' ? value : undefined
}

// ── hybrid search (#81 Stage 2 + 4b) ──────────────────────────────────────────

/** Reciprocal-Rank-Fusion smoothing constant — the canonical k=60 from the RRF
 *  paper. A note's fused score is Σ_channels w_c/(k + rank_in_channel): a small k
 *  lets the very top ranks dominate, a large k flattens the curve. Stage 4b moved
 *  the fusion arithmetic OUT of SQL and into JS (so the 1-hop graph channel can be
 *  a peer third channel and the weights are tunable/sweepable) — this is just the
 *  default k that DEFAULT_SEARCH_TUNING carries. */
const RRF_K = 60
/** Per-channel candidate pool fed to the JS fusion. A note must place in one
 *  channel's top-N to earn a reciprocal rank, so the pool sets fusion breadth.
 *  Generous vs a page (pageSize is usually 25) so the merge sees enough of each
 *  channel; the vec0 KNN is exhaustive (brute-force, recall 1.00 — #84 defers
 *  ANN), so this only caps rows examined, not search quality. The fts ∪ vec union
 *  the SQL returns is ≤ 2×pool rows — fused, graph-expanded and page-cut in JS. */
const RRF_POOL = 100

/** Conservative, directional defaults for the hybrid fusion + graph channel (#81
 *  Stage 4b). fts/vec weigh 1.0 (Stage-2 behaviour preserved). The graph channel
 *  is hub-robust: top-1% degree nodes are blacklisted as neighbours and every edge
 *  is down-weighted by 1/√(neighbour degree). wGraph is held SMALL on purpose —
 *  the only corpus we can calibrate on (Stage 4a) is hub-dominated with known-item
 *  gold that structurally can't reward 1-hop expansion, so the swept numbers are
 *  mechanics-validation, not a corpus optimum; the channel's real lift is proven
 *  on a synthetic fixture (vectorIndex.test). A homelab can zero it via
 *  GRAPH_BOOST=off. */
const DEFAULT_SEARCH_TUNING: SearchTuning = {
  rrfK: RRF_K,
  wFts: 1.0,
  wVec: 1.0,
  wGraph: 0.5,
  poolSize: RRF_POOL,
  graphSeedS: 10,
  graphPerSeedL: 5,
  graphHubPercentile: 0.01,
  graphEdgeWeight: 'invsqrtdeg',
}

/** How long a query waits for its embedding before the search degrades to FTS for
 *  that query (#81 P13 — honest FTS, never a multi-second block). A WARM embed is
 *  ~50–85ms; a COLD model load is multi-second (measured ~4.7s); a query queued
 *  behind a backfill batch on the shared ONNX session can take a few hundred ms.
 *  1.5s sits well above the warm/contended latency (no spurious degradation of a
 *  healthy query) yet well below the cold load (the first queries on a warm reboot
 *  fall back to lexical instead of hanging, and pick up the vector channel once the
 *  boot warmup finishes). Per-embed isolation / a dedicated query session is #84. */
const EMBED_QUERY_TIMEOUT_MS = 1_500

/** Index self-compaction thresholds (#198). auto_vacuum=INCREMENTAL (set by the
 *  driver, before WAL) keeps a churned partition's freed pages in the freelist but
 *  never returns them to the OS on its own — the store drives `incremental_vacuum`
 *  after a churn event (a schema teardown+rebuild, a large embed backfill) to
 *  reclaim them. Values are PAGES, not bytes: at the 4 KiB default page size 512
 *  pages ≈ 2 MiB (below this a maintenance pass isn't worth it), 2000 pages ≈ 8 MiB
 *  per chunk (a chunk vacuums in tens of ms — measured — with a scheduler yield
 *  between chunks, so compacting even a multi-GB freelist never freezes the loop). */
const RECLAIM_MIN_FREE_PAGES = 512
const RECLAIM_CHUNK_PAGES = 2_000
/** Files source-verified per reconcile. At the default 120 s backstop this
 *  rechecks a 5k-note corpus in under three hours and a 50k corpus in about a
 *  day, while the measured warm overhead stays in the low milliseconds/poll. */
const INTEGRITY_SWEEP_BATCH_SIZE = 64

/** The hybrid candidate POOL in ONE statement (#81 P11 / Stage 4b): FTS5 and vec0
 *  each rank their pool, chunks collapse to their best note (MIN distance — the
 *  closest chunk speaks for the note; chunk-id never crosses P1), then a FULL OUTER
 *  JOIN unions the two channels by note rowid. Unlike Stage 2 this NO LONGER fuses
 *  in SQL — it returns the raw per-channel ranks (fts_rnk, vec_rnk; NULL on the
 *  missing side) so the JS can RRF-weight them and add the graph channel as a peer.
 *  A note present in only one channel still surfaces (the other rank is NULL → that
 *  channel contributes 0 in JS) — so a purely-semantic hit FTS misses, and a
 *  purely-lexical hit the vector misses, both come through.
 *
 *  Two vec0 gotchas, both proven live (#81 Stage 2):
 *   - the KNN CTE MUST be `MATERIALIZED` with its own `ORDER BY distance`: vec0
 *     rejects a KNN query that sits under an outer ORDER BY on any other column
 *     ("Only a single 'ORDER BY distance' clause is allowed"); materializing it
 *     into a temp b-tree is the barrier that stops the constraint leaking out.
 *   - an empty note_vectors (boot before the backfill embeds anything) makes the
 *     KNN return zero rows, NOT throw — so the union degrades to pure FTS while
 *     vectors trickle in, no special-casing needed.
 *  The matched chunk's TEXT rides along (best_chunk) so a vector-only hit shows the
 *  fragment that matched, not a blind body-head. FTS5 snippet() still can't live in
 *  a CTE feeding a window/outer query, so the lexical snippet rides a separate pass. */
const HYBRID_RRF_SQL = `
WITH fts AS (
  SELECT notes_fts.rowid AS note_rowid,
         row_number() OVER (ORDER BY notes_fts.rank) AS rnk
  FROM notes_fts WHERE notes_fts MATCH ? LIMIT ?
),
knn AS MATERIALIZED (
  SELECT note_rowid, chunk_text, distance FROM note_vectors
  WHERE embedding MATCH ? AND k = ? ORDER BY distance
),
vec AS (
  SELECT note_rowid, best_chunk, row_number() OVER (ORDER BY d) AS rnk
  FROM (
    -- chunk→note collapse: the closest chunk speaks for the note (chunk-id never
    -- crosses P1). SQLite's bare-column + MIN() rule picks chunk_text FROM the
    -- min-distance row, so best_chunk is the matched chunk's text (Stage-3 snippet).
    SELECT note_rowid, MIN(distance) AS d, chunk_text AS best_chunk
    FROM knn GROUP BY note_rowid
  )
)
SELECT COALESCE(fts.note_rowid, vec.note_rowid) AS note_rowid,
       n.path AS path, n.title AS title, n.class AS class, n.note_type AS note_type,
       n.modified_at AS modified_at, n.created_at AS created_at,
       substr(n.body, 1, 200) AS body_head,
       vec.best_chunk AS best_chunk,
       fts.rnk AS fts_rnk,
       vec.rnk AS vec_rnk
FROM fts FULL OUTER JOIN vec ON fts.note_rowid = vec.note_rowid
JOIN notes n ON n.rowid = COALESCE(fts.note_rowid, vec.note_rowid)
`

/** Fetch the rows for graph neighbours that fell OUTSIDE the fts ∪ vec pool (#81
 *  Stage 4b): they have no fts/vec rank but earned a graph reciprocal rank, so they
 *  need a row to surface. WITH class — a class-less hit fails the read-model's
 *  visibility post-filter OPEN and could leak agent-memory (#78). `?ids` is
 *  substituted with one placeholder per missing path at call time. */
const GRAPH_NEIGHBOR_SQL = `
SELECT rowid AS note_rowid, path, title, class, note_type, modified_at, created_at, substr(body, 1, 200) AS body_head
FROM notes WHERE path IN (?ids)
`

/** Real FTS snippets for the fused page's lexical hits (#81 Stage 2): a second
 *  top-level MATCH (the only context FTS5 allows snippet() in) over the same pool,
 *  keyed by rowid so the hybrid path keeps the matched-fragment snippet the
 *  FTS-only path already shows. Vector-only hits aren't here — they fall back to a
 *  body-head prefix (the per-chunk snippet pipeline is Stage 3). */
const FTS_SNIPPET_SQL = `
SELECT notes_fts.rowid AS note_rowid, snippet(notes_fts, 1, '', '', '…', 24) AS snip
FROM notes_fts WHERE notes_fts MATCH ? ORDER BY notes_fts.rank LIMIT ?
`

/** Collapse engine-side snippet text to the wire shape: single-spaced, trimmed,
 *  capped — the same normalisation both search paths apply. */
const toSnippet = (raw: string | null | undefined): string =>
  (raw || '').replace(/\s+/g, ' ').trim().slice(0, 160)

export class NotariumStore implements KnowledgeStore {
  readonly capabilities: StoreCapabilities = {
    // FTS5 — real full-text search, the engine's own index.
    fts: true,
    // vector/hybrid (#81): true ONLY when an embedder is wired in AND its vec0
    // driver loaded — set in the constructor and flipped back to false if the
    // boot-time schema build proves the extension is absent (fail-fast, P13:
    // honest degradation to FTS rather than a hard dependency). The tentative
    // construct-time value is the intent; a genuine infra failure corrects it.
    vector: false,
    hybrid: false,
    graphExpand: false,
    // Bare engine: the identity registry, the
    // CAS arbiter and the revision journal are the read-model's (CachedStore).
    // What the engine owns is the materialization channel (write() lands the
    // id in frontmatter) and surfacing a file's claim on read.
    identity: false,
    cas: false,
    revisions: false,
    // The trash (#79) is a view over the journal — same read-model split.
    trash: false,
    // The engine materializes `class` on every row but does NOT enforce the
    // visibility invariant — it returns the full population; the read-model
    // hides classes per surface (#78).
    visibility: false,
    // External-change watching (#146, P5): a fast-path hint to the read-model
    // that something changed, so it reconciles early instead of waiting out the
    // poll interval. Set true in the constructor when at least one mount's
    // FileStore can watch (localfs can; a future DB-storage mount can't) — the
    // watcher is ONLY an invitation to rescan, the full scan() stays the truth
    // arbiter (P3), so this never weakens correctness, only latency.
    watch: false,
  }

  /** Typed mounts, longest-prefix-first so path→mount matching picks the most
   *  specific (the root mount, prefix '', is the catch-all and sorts last). */
  private readonly mounts: EngineMount[]
  private readonly mountsByPrefix: EngineMount[]
  private readonly resourceAuthority?: SpaceResourceAuthority
  private readonly sql: SqlDriver
  private readonly relationType: string

  /** Hybrid-fusion + graph-channel tuning (#81 Stage 4b): DEFAULT_SEARCH_TUNING
   *  merged with the constructor override. Mutable so the eval harness can sweep
   *  weights against one warm index via setSearchTuning. */
  private searchTuning: SearchTuning
  /** In-memory wikilink adjacency for the graph channel (#81 Stage 4b). The FIRST
   *  build is synchronous (a query awaits it once); after a mutation the LAST-GOOD
   *  cache keeps serving while a background rebuild refreshes it — a full-corpus
   *  re-parse is O(corpus) and scales with note size / link density (measured
   *  ~90ms loop-block on 2k light notes, up to ~seconds on a large or dense one),
   *  too slow to sit on the per-query path after every edit. `graphDirty` marks a pending refresh;
   *  `graphBuilding` is the in-flight rebuild (single-flight). Slight staleness is
   *  fine for a re-ranking signal (a new neighbour misses one cycle, a deleted one is
   *  dropped at the fetch step). */
  private graphCache: GraphAdjacency | null = null
  private graphDirty = true
  private graphBuilding: Promise<void> | null = null
  /** The space's folder path-history (#100 phase 3), fed by the wrapping read-model
   *  (the engine never reads the `.notariummeta` markers it lives in — a server
   *  concern). Used as buildLinkIndex's folder-alias pass so a path-form
   *  `[[oldpath/note]]` resolves to a renamed folder's note even when the filename
   *  is ambiguous. Empty until fed; a refeed marks the graph dirty for a rebuild. */
  private folderAliases: FolderAlias[] = []
  private linkIdentities = new Map<string, { path: string; legacyNameAliases: readonly string[] }>()
  private linkIdentityAliasesByPath = new Map<string, readonly string[]>()
  private linkIdentitiesConfigured = false
  /** Legacy alias compatibility changes invalidate more than ordinary content:
   * a formerly resolved edge can become an intentional ghost. Fence asynchronous
   * adjacency builds so an older resolver generation cannot republish a winner. */
  private linkCompatibilityGeneration = 0

  /** The vector channel (#81), null when disabled. `vecReady` mirrors it but is
   *  cleared if the boot schema build proves vec0 absent — embedNote checks it,
   *  not the option, so a degraded store never touches a vec0 table. */
  private embedder: Embedder | undefined
  private readonly chunker: Chunker
  private vecReady = false
  /** True once the embedder's model is actually loaded (a boot warmup resolved, or
   *  a background embed succeeded). search() takes the hybrid branch ONLY when warm,
   *  so the first queries on a cold/just-rebooted process return FTS INSTANTLY
   *  rather than waiting out the cold model load — honest P13 degradation, never a
   *  block (#81 review). The per-query timeout in embedQuery is the secondary net
   *  for a model that warms then stalls. */
  private vectorWarm = false
  /** Guards against firing more than one concurrent warmup(). Reset on settle so a
   *  FAILED warmup is re-attempted by the next caller (#81 final sweep): the embedder
   *  no longer caches a rejected load, so a boot warmup that fails (then leaves a
   *  quiescent, write-free corpus that never triggers a background embed) is recovered
   *  the next time search() wants the hybrid branch — capabilities.vector stops lying. */
  private warmingVector = false
  /** Background embedding queue: note rowids awaiting (re)embedding. The loop drains
   *  it up to `embedder.concurrency` notes at a time through the worker pool (#197);
   *  a single in-process embedder reports concurrency 1 → the old serial drain. Writes
   *  never wait on it: FTS is live immediately, the vector catches up. */
  private readonly pendingEmbed = new Set<bigint>()
  /** Rowids with an embedNote CURRENTLY in flight (#197): the refill skips these so a
   *  rowid re-enqueued (an edit/rescan) while its prior embed is still running is NOT
   *  embedded a second time concurrently — two overlapping embedNote for one rowid would
   *  interleave their non-transactional DELETE+INSERT+UPDATE on the shared connection and
   *  leave duplicate/stale vectors that the embedded_hash sentinel marks complete. This
   *  keeps the pre-#197 guarantee of at most one embedNote per rowid at a time. */
  private readonly embedding = new Set<bigint>()
  private embedLoop: Promise<void> | null = null
  private stopped = false
  /** Index-progress subscribers (#199): the wrapping read-model registers one so
   *  a fresh `status` SSE frame goes out as the embed backfill drains. Fired after
   *  each note (and on drain); the read-model throttles. A Set so the subscription
   *  composes like watch()'s, though today the read-model is the sole listener. */
  private readonly indexProgressListeners = new Set<() => void>()
  /** Single-flight guard for the index self-compaction pass (#198). A reclaim runs
   *  after a churn event drains (boot teardown+rebuild, an embed backfill); this
   *  keeps two from overlapping and lets stop() proceed without waiting on it. */
  private reclaiming: Promise<void> | null = null
  /** Background-work gate (#192): when paused, enqueued embeds ACCUMULATE in
   *  pendingEmbed but the serial loop won't start (and a running one bows out at
   *  its next note). The host pauses this around a bulk import so the embed
   *  backfill — CPU-heavy ONNX inference on the box's cores, plus per-chunk
   *  sqlite writes on the shared connection — doesn't steal responsiveness from
   *  interactive queries while thousands of notes land. Resumed (and drained,
   *  yielding) once the burst settles; nothing is lost (P2: pendingEmbed holds
   *  the rowids, and the boot backfill is the backstop). */
  private backgroundPaused = false
  /** The process-global cooperative scheduler (#196): the embed loop awaits a turn
   *  from it between notes, so a large boot/lazy-open backfill yields the shared
   *  cores + event loop to interactive traffic (search/nav/health in ANY space)
   *  instead of monopolising them. Null on a bare engine — the loop then yields with
   *  a plain macrotask gap, the pre-#196 behaviour. This is the SOFT gate (yield);
   *  `backgroundPaused` stays the HARD gate (#192 bulk import fully stops the loop). */
  private readonly scheduler?: BackgroundGate
  /** Rotating raw-source verification. The cursor is persisted in index meta;
   *  watcher paths bypass the rotation and are verified on the next reconcile. */
  private readonly integritySweepBatchSize: number
  private readonly forcedReadPaths = new Set<string>()
  private fingerprintsReady = false

  /** The index-schema migration ladder (schema.ts). Injectable so a test can drive
   *  ensureReady through a synthetic APPENDED step; production always uses the
   *  default INDEX_MIGRATIONS. */
  private readonly migrations: readonly IndexMigration[]

  /** Monotonic change stamp; persisted through the rows themselves. */
  private seq = 0
  /** Serialize `seq` allocation with the notes statement it stamps. The current
   *  Node driver executes synchronously behind Promises, but the SqlDriver seam
   *  deliberately admits genuinely async backends (wa-sqlite/pg): without this
   *  gate, a lower-seq delayed UPDATE could publish after a higher-seq one and
   *  become invisible to the already-issued cursor. Hashing stays outside. */
  private publicationTail: Promise<void> = Promise.resolve()
  private ready: Promise<void> | null = null
  private rescanInFlight: Promise<void> | null = null
  private scanning = false
  private lastScanAt: string | null = null
  private noteCount: number | null = null

  constructor({
    mounts,
    resourceAuthority,
    sql,
    relationType = 'links-to',
    embedder,
    chunker,
    searchTuning,
    scheduler,
    integritySweepBatchSize = INTEGRITY_SWEEP_BATCH_SIZE,
    migrations,
  }: NotariumStoreOptions) {
    if (!mounts.length) {
      throw new Error('NotariumStore requires at least one mount')
    }
    // Mounts feed ONE index keyed by full path; they MUST be disjoint or the
    // same physical file gets indexed twice under one PK with a nondeterministic
    // class (last-scanned mount wins). Two invariants make that impossible:
    //  - unique prefixes (no two mounts claim the same index namespace);
    //  - every non-root prefix is a DOT-namespace (e.g. .notarium/memory), so the
    //    root notes-mount's scan — which skips dot-dirs (localFs.hidden) — never
    //    re-indexes a sub-mount's files. A future disjoint-provider mount outside
    //    the root tree could relax the dot rule, but that's a deliberate change.
    const prefixes = mounts.map((m) => m.prefix)

    if (new Set(prefixes).size !== prefixes.length) {
      throw new Error('NotariumStore: duplicate mount prefixes')
    }
    for (const m of mounts) {
      if (m.prefix && !m.prefix.split('/')[0].startsWith('.')) {
        throw new Error(
          `NotariumStore: non-root mount prefix must be a dot-namespace (got "${m.prefix}")`,
        )
      }
    }
    this.mounts = mounts
    this.mountsByPrefix = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length)
    this.resourceAuthority = resourceAuthority
    this.sql = sql
    this.relationType = relationType
    this.searchTuning = { ...DEFAULT_SEARCH_TUNING, ...searchTuning }
    this.scheduler = scheduler
    if (!Number.isSafeInteger(integritySweepBatchSize) || integritySweepBatchSize < 0) {
      throw new Error('NotariumStore: integritySweepBatchSize must be a non-negative integer')
    }
    this.integritySweepBatchSize = integritySweepBatchSize
    this.migrations = migrations ?? INDEX_MIGRATIONS
    // The ladder's step 0 is the baseline that builds notes/FTS/meta — an empty
    // ladder would leave ensureReady with no schema to stand on. Guard the seam.
    if (!this.migrations.length) {
      throw new Error('NotariumStore: migrations ladder must be non-empty')
    }
    this.embedder = embedder
    this.chunker = chunker ?? createHeadingChunker()
    // Intent (corrected at boot if vec0 turns out absent): an embedder means the
    // vector/hybrid channel is on. The driver it's paired with MUST carry vec0 —
    // the composition root guarantees that or omits the embedder (graceful
    // degradation lives there).
    if (embedder) {
      this.capabilities.vector = true
      this.capabilities.hybrid = true
    }
    // Advertise watch when any mount can deliver change events (#146). The actual
    // fs.watch engage can still fail at runtime (inotify exhausted, network
    // mount) — watch() returns null then and the read-model degrades to polling;
    // this capability is the "worth trying" hint, not a guarantee.
    if (this.mounts.some((m) => typeof m.files.watch === 'function')) {
      this.capabilities.watch = true
    }
  }

  /** Active external-change watchers, so stop() releases every inotify handle
   *  even if the read-model never called the returned closer (#146). */
  private readonly watchers = new Set<() => void>()

  /** Override the hybrid-fusion + graph-channel tuning at runtime (#81 Stage 4b):
   *  the eval harness sweeps weights against ONE warm index; tests flip wGraph to
   *  isolate the graph channel. Merged over the current tuning. */
  setSearchTuning(patch: Partial<SearchTuning>): void {
    this.searchTuning = { ...this.searchTuning, ...patch }
  }

  /** Mark the graph adjacency stale on a note mutation (#81 Stage 4b). Keeps the
   *  last-good cache so in-flight/next queries don't block on a ~1.5s full re-parse;
   *  ensureGraphAdjacency refreshes it in the background. */
  private invalidateGraphCache(): void {
    this.graphDirty = true
  }

  // ── mount routing ─────────────────────────────────────────────────────────

  /** The mount an index path belongs to: the longest prefix that contains it,
   *  falling back to the root mount (prefix '' matches everything). */
  private mountForPath(fullPath: string): EngineMount {
    for (const m of this.mountsByPrefix) {
      if (m.prefix === '') {
        return m
      }
      if (fullPath === m.prefix || fullPath.startsWith(`${m.prefix}/`)) {
        return m
      }
    }

    return this.mounts[0]
  }

  /** The mount that owns a class (1:1 in v1). Fail-CLOSED on a requested class
   *  with no mount (#78): a targetClass the space can't place must NOT silently
   *  fall back to the visible user-doc mount — that would land agent-memory as a
   *  visible user-doc (the one lever #21 relies on to keep memory invisible).
   *  An UNSET class is the ordinary create → the default user-doc mount. */
  private mountForClass(cls: NoteClass | undefined): EngineMount {
    if (cls) {
      const m = this.mounts.find((x) => x.class === cls)

      if (!m) {
        throw writeFailed(`no mount for class "${cls}" in this space`)
      }

      return m
    }

    return this.mounts.find((x) => x.class === 'user-doc') ?? this.mounts[0]
  }

  /** Index path → the mount-relative path its FileStore speaks. */
  private relIn(m: EngineMount, fullPath: string): string {
    return m.prefix ? fullPath.slice(m.prefix.length + 1) : fullPath
  }

  /** Mount-relative path → the space-relative index path. */
  private fullIn(m: EngineMount, rel: string): string {
    return m.prefix ? `${m.prefix}/${rel}` : rel
  }

  /** Skill operations join the package hierarchy as well as the exact resource.
   * Personal/space packages are one directory; project packages live below the
   * reserved `_projects/<project>/<package>` namespace. */
  private packagePathFor(mount: EngineMount, rel: string): string | undefined {
    if (mount.class !== 'skill') {
      return undefined
    }
    const packagePath = skillPackagePathOf(rel)

    return packagePath ? this.fullIn(mount, packagePath) : undefined
  }

  /** Which spellings a write's destination needs answered — for BOTH fences, in
   *  ONE question to the medium.
   *
   *  The portability fence asks `hasDir` about a prefix only when that prefix's own
   *  component is not portable ("an existing legacy folder may keep its spelling");
   *  every other component it decides from the string alone. The spelling fence
   *  asks about every ancestor of the destination. The second set contains the
   *  first, so a union costs an adapter with a shallow probe exactly what the
   *  spelling fence already cost it — and saves the adapter WITHOUT one a second
   *  recursive walk of the whole mount for an answer it just produced.
   *
   *  Exact/raw, which is what `isPortableRelativeDestination` documents its
   *  `hasDir` to be: the grandfathered folder is a specific RAW one, and a
   *  case-folded equivalent is not it. `dirExists` (a stat) cannot tell the two
   *  apart on a case-insensitive medium — it would grandfather `FOO:BAR` on the
   *  strength of an existing `foo:bar`, and the write would land in a folder it
   *  never named. */
  private async destinationDirSpellings(
    mount: EngineMount,
    directory: string,
    legacyImportRoot?: string,
  ): Promise<Set<string>> {
    const prefixes = new Set(ancestorPrefixes(directory))

    if (legacyImportRoot !== undefined) {
      for (const prefix of ancestorPrefixes(legacyImportRoot)) {
        if (!isPortablePathComponent(prefix.split('/').pop()!)) {
          prefixes.add(prefix)
        }
      }
    }

    return exactDirSpellings(mount.files, [...prefixes])
  }

  /** Refuse a directory spelling that the medium maps onto an existing RAW
   *  folder with another spelling. Otherwise LocalFS can write into physical
   *  `Empty/` while the derived index records `empty/`, splitting one note across
   *  two path identities until the next scan. New raw-distinct directories remain
   *  legal on a medium that actually distinguishes them.
   *
   *  `spelled` is the answer a caller already asked for (see
   *  {@link destinationDirSpellings}); without one this asks for itself. */
  private async assertDirectorySpelling(
    mount: EngineMount,
    directory: string,
    spelled?: ReadonlySet<string>,
  ): Promise<void> {
    if (!directory) {
      return
    }
    const prefixes = ancestorPrefixes(directory)
    // One question about every ancestor at once. Whether the medium answers it
    // with shallow probes or with a single walk is the port's business, not this
    // one's — see `exactDirSpellings`.
    const present = spelled ?? (await exactDirSpellings(mount.files, prefixes))

    for (const prefix of prefixes) {
      if (present.has(prefix)) {
        continue
      }
      if (await mount.files.dirExists(prefix)) {
        throw writeFailed('directory spelling does not match storage')
      }
      // Once an ancestor truly does not exist, no deeper child can exist either.
      break
    }
  }

  /** Move a note file without ever replacing a different destination pathname.
   *  A same-entry alternate spelling is the case/NFC-only rename exception; every
   *  absent destination must be claimed by the adapter's atomic no-replace primitive. */
  private async renameFileNoReplace(mount: EngineMount, from: string, to: string): Promise<void> {
    const occupied = await mount.files.exists(to)
    const sameSourceEntry =
      occupied && mount.files.sameEntry ? await mount.files.sameEntry(from, to) : false

    if (sameSourceEntry) {
      if (!mount.files.renameIfAbsent) {
        throw moveFailed('storage cannot rename a note without replacing a race')
      }
      if (!(await mount.files.renameIfAbsent(from, to))) {
        throw moveFailed('a note already lives at the destination')
      }

      return
    }
    if (occupied) {
      throw moveFailed('a note already lives at the destination')
    }
    if (!mount.files.renameIfAbsent) {
      throw moveFailed('storage cannot move a note without replacing a concurrent destination')
    }
    if (!(await mount.files.renameIfAbsent(from, to))) {
      throw moveFailed('a note already lives at the destination')
    }
  }

  /** Schema + first full scan, once. Brings the on-disk index up to the current
   *  ladder version (planIndexMigration): additive steps preserve the index (and
   *  its vectors); a version we can't step from tears down and reindexes — it is
   *  derived data (P2), where migration may be rebuild. */
  private ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      // Read the stored version off a minimal `meta` table FIRST. Running the
      // full baseline schema up front would execute the v2 `CREATE INDEX … ON
      // notes(class)` against a stale pre-#78 `notes` table (no `class` column)
      // and throw before we ever reach the teardown — so an unsteppable version
      // must drop BEFORE it rebuilds.
      await this.sql.exec(META_SCHEMA)
      const ladderVer = await this.metaValue(INDEX_VERSION_KEY)
      const legacyVer = await this.metaValue(LEGACY_VERSION_KEY)
      const target = this.migrations.length
      const plan = planIndexMigration({
        ladderVersion: ladderVer,
        legacyVersion: legacyVer,
        target,
      })
      // Only a teardown resets rowids (dropping notes), so only it makes the rowid-
      // keyed vectors stale; ladder steps are additive and rowid-preserving (see
      // IndexMigration), so they ride along untouched. This flag gates whether
      // setupVectorSchema wipes+re-embeds.
      const notesRebuilt = plan.teardown

      if (plan.teardown) {
        await this.sql.exec(TEARDOWN)
      }
      // A teardown always rebuilds from 0 (it dropped `meta` — step 0 recreates it
      // before the version stamp); planIndexMigration guarantees this, the guard just
      // makes the invariant local.
      const startVersion = plan.teardown ? 0 : plan.fromVersion

      // Apply the missing ladder steps in order, EACH in its own transaction that
      // also stamps the version (the meta-DB runner's shape). SQLite DDL is
      // transactional, so a crash mid-step rolls the WHOLE step back and the next
      // boot re-applies it — an `ALTER … ADD COLUMN` (no IF NOT EXISTS) never sticks
      // half-applied to wedge the boot. Step 0 recreates the (fresh/post-teardown)
      // baseline via CREATE IF NOT EXISTS; later steps are additive ALTERs.
      for (let v = startVersion; v < target; v++) {
        await this.sql.exec('BEGIN')
        try {
          await this.sql.exec(this.migrations[v].sql)
          await this.setMeta(INDEX_VERSION_KEY, String(v + 1))
          await this.sql.exec('COMMIT')
        } catch (err) {
          await this.sql.exec('ROLLBACK').catch(() => {})
          throw err
        }
      }
      // Retire the pre-ladder version row once adopted, so the meta table keeps a
      // single source of version truth (no-op when it was never there).
      if (legacyVer != null) {
        await this.sql.run(`DELETE FROM meta WHERE key = ?`, [LEGACY_VERSION_KEY])
      }
      const fingerprintColumns = await this.sql.all<{ name: string }>(
        `PRAGMA table_info(file_fingerprints)`,
      )
      this.fingerprintsReady = fingerprintColumns.some((column) => column.name === 'note_seq')
      // The vector half (#81), only with an embedder: builds note_vectors, wipes
      // a stale partition (model/chunker drift OR a notes rebuild), and may degrade
      // to FTS if vec0 turns out absent. Done before rescan so upsertRow can enqueue
      // embeds.
      if (this.embedder) {
        await this.setupVectorSchema(notesRebuilt)
      }
      // No embedder this boot (degraded, or VECTOR_SEARCH off) but the index was
      // built vec-ON before: the leftover notes_vec_ad trigger references the vec0
      // table, and with the extension unloaded a DELETE FROM notes would throw
      // "no such module: vec0" — breaking EVERY delete and every poll's rescan.
      // Dropping the trigger is safe without the module loaded (its body is never
      // evaluated); the orphan note_vectors table just sits unused until a later
      // vec-ON boot cleans it. (#81 review)
      else {
        await this.sql.exec('DROP TRIGGER IF EXISTS notes_vec_ad')
      }
      const max = await this.sql.get<{ s: number | null }>(`SELECT MAX(seq) AS s FROM notes`)
      this.seq = Number(max?.s ?? 0)
      await this.rescan()
      // Boot backfill (#81): enqueue every note lacking a current-hash vector —
      // covers a fresh index, a wiped partition (embedder/chunker change), and a
      // run interrupted mid-embed. Runtime writes enqueue themselves in upsertRow;
      // this is the catch-up the incremental rescan can't do (it only re-upserts
      // CHANGED files). Fire-and-forget: vectors trickle in behind a live FTS.
      if (this.vecReady) {
        await this.enqueueMissingVectors()
        // Warm the embedder model OFF the request path (#81 P13): the backfill loop
        // only loads the model if some note still needs embedding, so a fully
        // caught-up warm restart would otherwise leave the model cold until the
        // first user query pays the multi-second load. Fire-and-forget — queries
        // arriving before it finishes degrade to FTS, they never block.
        this.warmUpVector()
      }
      // Compact the pages a teardown+rebuild (or past churn) freed (#198). If a
      // vector backfill is PENDING, let the embed loop reclaim when it DRAINS instead
      // (reclaiming now then re-growing the file as it embeds is double work). If
      // NOTHING is pending — an FTS-only boot, OR a vector space that booted already
      // fully embedded but still carrying a bloated freelist (the production case: a
      // caught-up corpus whose file never shrank) — the embed loop will never run, so
      // compact right here once the rescan has settled. Fire-and-forget, no-ops on a
      // small freelist.
      if (!this.pendingEmbed.size) {
        this.scheduleReclaim()
      }
    })()
    return this.ready
  }

  // ── vector channel (#81) ─────────────────────────────────────────────────────

  /** Bring the vector channel WARM off the request path (#81 P13): load the embedder
   *  model so search() can engage the hybrid branch. Idempotent and SELF-HEALING — the
   *  warmingVector guard collapses concurrent calls, and it is reset on settle so a
   *  transient warmup FAILURE is retried by the next caller (boot, or a later search
   *  wanting hybrid) rather than stranding the store on FTS-only forever while
   *  capabilities.vector reads true. A minimal embedder with no lazy init omits
   *  warmup() (optional) — nothing to warm; the background embed loop flips vectorWarm
   *  for it instead. */
  private warmUpVector(): void {
    if (this.vectorWarm || this.warmingVector || !this.embedder?.warmup) {
      return
    }
    this.warmingVector = true
    void this.embedder
      .warmup()
      .then(() => {
        this.vectorWarm = true
      })
      .catch((err: unknown) => console.error('[notarium] embedder warmup failed:', err))
      .finally(() => {
        this.warmingVector = false
      })
  }

  private metaValue(key: string): Promise<string | undefined> {
    return this.sql
      .get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key])
      .then((r) => r?.value)
  }

  private setMeta(key: string, value: string): Promise<{ changes: number }> {
    return this.sql.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [key, value])
  }

  /** The vector-invalidation arbiter (P13): sha-256 over the EXACT text the
   *  chunker feeds the embedder, so the hash changes iff the embed input changes
   *  (a whitespace-only edit the chunker trims away does NOT churn the partition).
   *  Chunks are joined by NUL — a byte that never appears in a markdown note — so
   *  two different splittings can't collide. embedNote re-chunks deterministically,
   *  so what it embeds matches this hash byte-for-byte. */
  private embedContentHash(title: string, body: string): Promise<string> {
    const chunks = this.chunker.chunk({ title, body })
    return sha256Hex(chunks.map((c) => c.text).join('\u0000'))
  }

  /** Build note_vectors and pin the partition's identity (P13). The dimension is
   *  the embedder's, never hardcoded. A drift in embedder_id or chunker_version, the
   *  vec0 table LAYOUT (vec_layout_version, #193), or a schema teardown that reset
   *  rowids makes the existing vectors stale — wipe and let the backfill re-embed. If
   *  vec0 isn't actually loadable, degrade to FTS rather than crash (capabilities
   *  tells the truth). */
  private async setupVectorSchema(notesRebuilt: boolean): Promise<void> {
    const embedder = this.embedder

    if (!embedder) {
      return
    }
    try {
      await this.sql.exec(vecSchema(embedder.dimensions))
      const storedId = await this.metaValue(META_EMBEDDER_ID)
      const storedChunker = await this.metaValue(META_CHUNKER_VERSION)
      const storedDims = await this.metaValue(META_EMBEDDER_DIMS)
      const storedLayout = await this.metaValue(META_VEC_LAYOUT)
      const stale =
        notesRebuilt ||
        storedId !== embedder.id ||
        storedChunker !== this.chunker.version ||
        storedDims !== String(embedder.dimensions) ||
        // A vec0 LAYOUT bump (#193: partition-key → flat) needs the existing table
        // rebuilt even when the embedder identity is unchanged — the DDL shape, not
        // the vectors, changed. An index built before the layout key existed reads
        // undefined here → treated as stale → wiped + re-embedded (P2 derived).
        storedLayout !== VEC_LAYOUT_VERSION

      if (stale) {
        // A base TEARDOWN can't drop a vec0 table (its module may be unloaded),
        // so note_vectors survives a version bump with orphaned vectors keyed to
        // recycled rowids — drop it here, where vec0 is loaded, and rebuild. A
        // dimensions change ALSO needs this: CREATE IF NOT EXISTS above is a no-op
        // against the old float[N] width, so only a drop+recreate gets the new one.
        // The same drop+recreate re-shapes a stale LAYOUT (#193) to the current DDL.
        await this.sql.exec(VEC_TEARDOWN)
        await this.sql.exec(vecSchema(embedder.dimensions))
        // The partition is gone, so the completeness sentinel must reset too:
        // embedded_hash still equal to content_hash from the OLD model/layout would
        // make the backfill think these notes are done and skip re-embedding them.
        // NULL it so every note re-embeds. (No-op when notes is empty — a
        // teardown already emptied it before this ran.)
        //
        // ORDER MATTERS (these are separate autocommits on one connection, not a
        // txn): null the sentinel BEFORE stamping the identity/layout markers. The
        // markers are what flip `stale` back to false next boot, so they must land
        // LAST — after the table is rebuilt AND the sentinel is cleared. A crash
        // before the markers leaves at least one mismatched → next boot is stale
        // again and the whole wipe+re-embed repeats (self-healing). If the markers
        // were stamped first, a crash before the sentinel reset would read as
        // not-stale with embedded_hash==content_hash, and the backfill would skip
        // the now-empty table forever — a silent vectorless index.
        await this.sql.run(`UPDATE notes SET embedded_hash = NULL`)
        await this.setMeta(META_EMBEDDER_ID, embedder.id)
        await this.setMeta(META_CHUNKER_VERSION, this.chunker.version)
        await this.setMeta(META_EMBEDDER_DIMS, String(embedder.dimensions))
        await this.setMeta(META_VEC_LAYOUT, VEC_LAYOUT_VERSION)
      } else {
        // Not stale, but a prior vec-OFF period (trigger dropped) or an interrupted
        // run can leave vectors keyed to rowids no longer in `notes`. Sweep them so
        // a recycled rowid never inherits a dead note's vector/class. (#81 review)
        await this.sql.exec(
          `DELETE FROM note_vectors WHERE note_rowid NOT IN (SELECT rowid FROM notes)`,
        )
      }
      this.vecReady = true
      // Operator visibility: one line confirming the vector channel actually came up
      // (and with which model/version), so a silent FTS-only degradation is obvious
      // by its ABSENCE. The degradation path logs its own error below; the FTS-only
      // (no-embedder) path stays quiet on purpose — that's the unremarkable default.
      const ver = await this.sql
        .get<{ v: string }>(`SELECT vec_version() AS v`)
        .catch(() => undefined)
      console.log(
        `[notarium] vector channel ON — vec_version=${ver?.v ?? '?'}, embedder=${embedder.id}, dims=${embedder.dimensions}, chunker=${this.chunker.version}`,
      )
    } catch (err) {
      console.error('[notarium] vector channel disabled (vec0 unavailable):', err)
      this.embedder = undefined
      this.vecReady = false
      this.capabilities.vector = false
      this.capabilities.hybrid = false
    }
  }

  /** Enqueue every note whose current content has no COMPLETE embedding yet.
   *  Completeness is the `embedded_hash` sentinel, NOT "a vector row exists for
   *  this hash": a multi-chunk embed interrupted mid-loop leaves a partial set all
   *  tagged with the current content_hash, which the latter would mistake for done.
   *  `embedded_hash` is only set after ALL chunks land (embedNote's last step), so
   *  `content_hash != embedded_hash` covers a fresh index, a wiped partition, an
   *  edited note, AND a crash-interrupted embed. */
  private async enqueueMissingVectors(): Promise<void> {
    if (!this.vecReady) {
      return
    }
    const rows = await this.sql.all<{ rowid: number }>(
      `SELECT rowid FROM notes
       WHERE content_hash IS NOT NULL
         AND (embedded_hash IS NULL OR embedded_hash != content_hash)`,
    )

    for (const r of rows) {
      this.enqueueEmbed(BigInt(r.rowid))
    }
  }

  private enqueueEmbed(rowid: bigint): void {
    if (!this.vecReady || this.stopped) {
      return
    }
    this.pendingEmbed.add(rowid)
    this.kickEmbedLoop()
  }

  private kickEmbedLoop(): void {
    if (this.embedLoop || !this.pendingEmbed.size || this.backgroundPaused || this.stopped) {
      return
    }
    this.embedLoop = this.runEmbedLoop().finally(() => {
      this.embedLoop = null
      // A note enqueued in the gap between the loop's last `size` check and this
      // null would see embedLoop truthy and no-op, then sit forever (incremental
      // rescan won't re-touch an unchanged file). Re-kick to absorb it. (#81 review)
      if (this.pendingEmbed.size && !this.stopped) {
        this.kickEmbedLoop()
      }
    })
  }

  /** Yield the shared event loop for one background turn (#196/#198): the process-global
   *  scheduler's cooperative gate when present, else a plain macrotask on a bare engine.
   *  Both the embed loop and the reclaim drain hand control back through this between
   *  work units so a synchronous burst (ONNX inference, incremental_vacuum) can't starve
   *  interactive traffic. Callers re-test their stop/pause gates AFTER awaiting it. */
  private async awaitBackgroundTurn(): Promise<void> {
    if (this.scheduler) {
      await this.scheduler.awaitTurn()
    } else {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /** A time-budgeted cooperative yield for the heavy read passes that parse every note
   *  body in a tight synchronous loop and have NO natural loop boundary of their own —
   *  the wikilink derivation shared by `graph()` and the search channel's
   *  `rebuildGraphAdjacency()` (#222). Unlike the reindex (which yields for free at every
   *  `await mount.files.read()`), these block the shared loop end-to-end (graph() ~270ms
   *  / adjacency rebuild ~1.5s on a big space). This returns a closure that breaks the
   *  loop with a plain macrotask once `budgetMs` of uninterrupted work has elapsed, so
   *  other spaces' navigation and /api/health interleave between chunks.
   *
   *  Deliberately NOT `awaitBackgroundTurn` (the #196 scheduler gate): that gate
   *  DEFERS while any interactive request is in flight, but both callers sit on
   *  interactive paths (/api/graph; the search graph channel awaits the first adjacency
   *  build), where deferring to the drip-floor would stall the very request being
   *  served. This is a fairness break, not a background-priority hold: it yields but
   *  never defers. */
  private coopYielder(budgetMs = 8): () => Promise<void> {
    let last = Date.now()

    return async () => {
      if (Date.now() - last < budgetMs) {
        return
      }
      await new Promise((resolve) => setImmediate(resolve))
      last = Date.now()
    }
  }

  private async runEmbedLoop(): Promise<void> {
    // Embed up to `concurrency` notes AT ONCE (#197): a worker-pool embedder reports
    // its worker count, so a multi-core box parallelises the backfill across the pool
    // instead of embedding one note at a time (the pre-#197 serial drain). A single
    // in-process embedder reports 1 → identical serial behaviour, bit-for-bit. The
    // fan-out is ONLY the inference: each embedNote still does its sqlite writes and
    // its crash-safety re-read on THIS (main) thread, so there is one writer and the
    // single-connection reasoning in embedNote is untouched.
    const concurrency = Math.max(1, this.embedder?.concurrency ?? 1)
    const inFlight = new Set<Promise<void>>()

    while (this.pendingEmbed.size && !this.stopped && !this.backgroundPaused) {
      // Yield to interactive traffic BEFORE refilling the in-flight set (#196). With
      // inference now off the main thread the loop no longer starves the event loop
      // itself, but the pool's workers still consume cores — so the process-global
      // scheduler keeps the backfill deferring to interactive requests (query embeds,
      // nav, health in ANY space): it holds the loop back while the box is busy and
      // releases it when quiet, bounded by the drip floor so a never-idle instance
      // still converges. A bare engine (no scheduler) keeps the plain macrotask gap.
      await this.awaitBackgroundTurn()
      // The turn can be a long wait under load — re-test the gates AFTER it so a
      // stop()/suspendBackground() (or a drained queue) that landed mid-wait is
      // honoured at once, not after one more batch of embeds.
      if (this.stopped || this.backgroundPaused || !this.pendingEmbed.size) {
        break
      }
      // Refill the in-flight set up to the concurrency cap, launching each embedNote
      // without awaiting it here (the pool runs them in parallel).
      while (inFlight.size < concurrency && !this.stopped && !this.backgroundPaused) {
        // Take the first pending rowid that is NOT already being embedded — never launch
        // a second concurrent embedNote for a rowid whose prior embed is still in flight
        // (a re-enqueued edit waits its turn), else their non-transactional vec0 writes
        // interleave into duplicate/stale vectors (#197 review). Leaves such a rowid in
        // the queue; it is re-picked once its in-flight embed settles.
        let rowid: bigint | undefined

        for (const r of this.pendingEmbed) {
          if (!this.embedding.has(r)) {
            rowid = r
            break
          }
        }
        if (rowid === undefined) {
          break
        } // all remaining pending rowids are already in flight
        this.pendingEmbed.delete(rowid)
        this.embedding.add(rowid)
        const p = this.embedNote(rowid)
          .catch((err: unknown) => {
            // One note failing must not stall the queue: FTS still serves it, and the
            // next full-rescan / boot backfill retries (P3, eventual consistency).
            console.error('[notarium] embed failed for note rowid', rowid, err)
          })
          .finally(() => {
            this.embedding.delete(rowid)
            inFlight.delete(p)
            // Progress moved (pendingEmbed shrank, or vectorWarm flipped) — nudge the
            // read-model to push a fresh `status` frame (#199). Fires per note; the
            // read-model throttles the fan-out. The final drain lands the "done" frame.
            this.notifyIndexProgress()
          })
        inFlight.add(p)
      }
      // Wait for at least one in-flight embed to settle before the next scheduler turn,
      // so we re-test the gates and refill promptly without busy-spinning.
      if (inFlight.size) {
        await Promise.race(inFlight)
      }
    }
    // A pause/stop can break the loop while embeds are still in flight — let their
    // sqlite writes land before we treat the drain as done (and before a reclaim).
    if (inFlight.size) {
      await Promise.allSettled(inFlight)
    }
    // Backfill drained on its own (not stopped/paused mid-way): the re-embed churn's
    // DELETE+INSERT freed pages into the freelist — compact them back to the OS
    // (#198). Guarded on an EMPTY queue so a pause/stop exit doesn't reclaim mid-burst;
    // scheduleReclaim no-ops on a small freelist, so an incremental run costs a
    // couple of PRAGMA reads.
    if (!this.stopped && !this.backgroundPaused && !this.pendingEmbed.size) {
      this.scheduleReclaim()
    }
  }

  private notifyIndexProgress(): void {
    for (const listener of this.indexProgressListeners) {
      try {
        listener()
      } catch (err) {
        // A subscriber's throw must not stall the embed loop.
        console.error('[notarium] index-progress listener threw', err)
      }
    }
  }

  /** Subscribe to embed-backfill progress (#199). Returns a closer; null-safe to
   *  call even with no vector channel (the loop simply never ticks then). */
  onIndexProgress(onTick: () => void): (() => void) | null {
    this.indexProgressListeners.add(onTick)
    return () => this.indexProgressListeners.delete(onTick)
  }

  /** Host-side background gate (#192, duck-called like stop()): pause/resume the
   *  embedding backfill so a bulk import doesn't let it steal CPU + sqlite from
   *  interactive traffic. Pausing leaves enqueued rowids intact; resuming re-kicks
   *  the (yielding) drain. No-ops on a vector-less engine — nothing to pause. */
  suspendBackground(): void {
    this.backgroundPaused = true
  }

  resumeBackground(): void {
    if (!this.backgroundPaused) {
      return
    }
    this.backgroundPaused = false
    this.kickEmbedLoop()
  }

  /** Kick a background index self-compaction (#198), single-flight and fire-and-forget.
   *  Compaction is housekeeping, never a correctness path, so a failure is logged and
   *  swallowed and the caller never waits. Called after a churn event settles — an
   *  FTS-only boot's teardown+rebuild, or an embed backfill draining. */
  private scheduleReclaim(): void {
    if (this.reclaiming || this.stopped) {
      return
    }
    this.reclaiming = this.reclaimFreePages()
      .catch((err: unknown) => console.error('[notarium] index reclaim failed:', err))
      .finally(() => {
        this.reclaiming = null
      })
  }

  /** Return freed index pages to the OS (#198). auto_vacuum=INCREMENTAL (driver) keeps
   *  a churned partition's freelist reusable but never shrinks the file itself; this
   *  drains the freelist with `incremental_vacuum` in bounded chunks, yielding the
   *  shared cores to interactive traffic BETWEEN chunks (the same scheduler the embed
   *  loop uses), so reclaiming a multi-GB freelist can't monopolise the event loop.
   *  A no-op unless the DB is actually in INCREMENTAL mode (a pre-existing NONE file
   *  stays put — no legacy in-place VACUUM) and the freelist is large enough to be
   *  worth a pass. Honours stop()/suspendBackground() at every chunk boundary. */
  private async reclaimFreePages(): Promise<void> {
    // Only INCREMENTAL (2) has a manually-drained freelist: NONE (0) / FULL (1) make
    // incremental_vacuum a no-op, so don't even start.
    const mode = await this.sql.get<{ auto_vacuum: number }>(`PRAGMA auto_vacuum`)

    if (mode?.auto_vacuum !== 2) {
      return
    }
    const freeOf = async (): Promise<number> =>
      (await this.sql.get<{ freelist_count: number }>(`PRAGMA freelist_count`))?.freelist_count ?? 0
    let free = await freeOf()

    if (free < RECLAIM_MIN_FREE_PAGES) {
      return
    } // a small freelist isn't worth the churn
    const before = free

    // Drain in chunks so a huge freelist compacts cooperatively — yield to interactive
    // traffic (or a plain macrotask on a bare engine) before each chunk, and re-test
    // the gates AFTER the wait so a stop()/suspendBackground() mid-yield is honoured
    // at once rather than after one more vacuum.
    while (free >= RECLAIM_CHUNK_PAGES && !this.stopped && !this.backgroundPaused) {
      await this.awaitBackgroundTurn()
      if (this.stopped || this.backgroundPaused) {
        break
      }
      await this.sql.exec(`PRAGMA incremental_vacuum(${RECLAIM_CHUNK_PAGES})`)
      free = await freeOf()
    }
    if (this.stopped) {
      return
    } // handle may be closing — don't touch it further
    // The sub-chunk remainder in one final pass (skipped if a bulk import paused us).
    if (free > 0 && !this.backgroundPaused) {
      await this.sql.exec(`PRAGMA incremental_vacuum`)
      free = await freeOf()
    }
    // incremental_vacuum shrinks the main file, but the freed pages linger in the -wal
    // until a checkpoint folds it back — TRUNCATE so the space actually leaves the disk.
    // ONLY when we actually reclaimed something (before !== free): a paused/early bail
    // that vacuumed nothing must not force a checkpoint that would contend with the bulk
    // import it yielded to for zero benefit — the periodic autocheckpoint catches up
    // regardless. Best-effort: a concurrent reader can make TRUNCATE a no-op.
    if (before !== free) {
      await this.sql.exec(`PRAGMA wal_checkpoint(TRUNCATE)`).catch(() => {})
      console.log(`[notarium] index reclaim: freelist ${before} → ${free} pages returned to the OS`)
    }
  }

  /** Compute and persist one note's vectors. The slow part (inference) holds no
   *  lock; the table is touched only AFTER a re-read confirms the row still exists
   *  with the SAME content_hash — the embed await is a multi-second window during
   *  which a concurrent rescan/remove/write (same connection) could delete the
   *  note OR recycle its rowid (notes uses `path` as PK, so SQLite reuses a freed
   *  rowid) to a DIFFERENT note. Writing the pre-await snapshot then would orphan
   *  or mis-class vectors (a Stage-2 visibility leak). Idempotent: skips when the note's
   *  embedded_hash already equals its content_hash (a touch with unchanged content);
   *  a partial (crash-interrupted) set has matching vector rows but a stale
   *  embedded_hash, so it is re-embedded — completeness is the sentinel, not the
   *  mere existence of a current-hash vector row. */
  private async embedNote(rowid: bigint): Promise<void> {
    const embedder = this.embedder

    if (!embedder || !this.vecReady || this.stopped) {
      return
    }
    const row = await this.sql.get<{
      title: string
      body: string
      content_hash: string | null
      embedded_hash: string | null
    }>(`SELECT title, body, content_hash, embedded_hash FROM notes WHERE rowid = ?`, [rowid])

    if (!row || !row.content_hash) {
      return
    } // gone since enqueue, or never hashed
    const hash = row.content_hash

    // The completeness sentinel: a fully-embedded note carries embedded_hash ==
    // content_hash. A partial (crash-interrupted) set has the chunks' content_hash
    // but a stale embedded_hash, so it is NOT skipped here (it gets re-embedded).
    if (row.embedded_hash === hash) {
      return
    } // already current
    const chunks = this.chunker.chunk({ title: row.title, body: row.body })
    // Embed BEFORE touching the table — inference is slow and we hold no lock.
    const vectors = chunks.length
      ? await embedder.embed(
          chunks.map((c) => c.text),
          'passage',
        )
      : []

    // A successful embed means the model is loaded — let search() take the hybrid
    // branch (the boot warmup may not have resolved yet, or there may be no warmup
    // method at all on a minimal embedder). (#81 review)
    if (vectors.length) {
      this.vectorWarm = true
    }
    // Validate the result BEFORE the destructive DELETE: a wrong-count/wrong-dim
    // return (misconfig, or a dimensions change the staleness check somehow missed)
    // must fail closed with the prior vectors intact, not wipe them then throw.
    if (vectors.length !== chunks.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${chunks.length} chunks`)
    }
    for (const vec of vectors) {
      if (vec.length !== embedder.dimensions) {
        throw new Error(`embedder returned ${vec.length} dims, expected ${embedder.dimensions}`)
      }
    }
    // Re-read AFTER the await: bail if the row vanished or its content changed
    // (an edit re-enqueues it), and bind the row's CURRENT class — so a rowid
    // recycled to another note during inference can't inherit this note's class.
    // stop() may also have fired; the index handle could be closing.
    if (this.stopped) {
      return
    }
    const cur = await this.sql.get<{ class: NoteClass; content_hash: string | null }>(
      `SELECT class, content_hash FROM notes WHERE rowid = ?`,
      [rowid],
    )

    if (!cur || cur.content_hash !== hash) {
      return
    } // gone or edited since the snapshot
    // No cross-await transaction (the shared single connection makes BEGIN/COMMIT
    // interleave-unsafe — another coroutine's write would join this txn and commit
    // or roll back with it). Instead the `embedded_hash` sentinel makes the whole
    // write crash-safe: DELETE the old vectors, INSERT every chunk (each carrying
    // its text so a vector-only hit can show the matched fragment), then mark the
    // note complete LAST. A crash/stop before that final UPDATE leaves a partial
    // set with a stale embedded_hash → the boot backfill re-embeds it (the DELETE
    // clears the partial first). For the whole-note chunker this was a single
    // INSERT; the heading-first chunker (Stage 3) makes it 1..N.
    await this.sql.run(`DELETE FROM note_vectors WHERE note_rowid = ?`, [rowid])
    for (let i = 0; i < chunks.length; i++) {
      const vec = vectors[i]
      await this.sql.run(
        `INSERT INTO note_vectors (note_rowid, content_hash, class, chunk_index, chunk_text, embedding)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          rowid,
          hash,
          cur.class,
          BigInt(chunks[i].index),
          chunks[i].text,
          new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength),
        ],
      )
    }
    // Commit point: mark the note embedded for THIS hash, LAST. Guarded on
    // content_hash so a concurrent edit slipping in between the re-read and here
    // can't mark stale vectors complete (0 rows → embedded_hash stays behind →
    // the note re-embeds). This UPDATE fires notes_au (a redundant FTS re-index of
    // unchanged text) — negligible next to inference, and it leaves seq untouched
    // so it never surfaces as a note change in the delta feed.
    await this.sql.run(`UPDATE notes SET embedded_hash = ? WHERE rowid = ? AND content_hash = ?`, [
      hash,
      rowid,
      hash,
    ])
  }

  /** Drain hook (not a port method — tests and graceful shutdown): resolve when
   *  no embedding loop is in flight. The loop absorbs notes enqueued mid-run, so
   *  when it ends the queue is empty; the while guards a fresh enqueue. */
  async whenVectorsSettled(): Promise<void> {
    while (this.embedLoop) {
      await this.embedLoop
    }
  }

  /** Drain hook (not a port method — tests and graceful shutdown): resolve when the
   *  index self-compaction pass (#198) is idle. Fire-and-forget in production; tests
   *  await it to observe the reclaimed file. */
  async whenIndexSettled(): Promise<void> {
    while (this.reclaiming) {
      await this.reclaiming
    }
  }

  /** Full reconciliation, single-flight: stat-walk every mount, reparse cheap
   *  fingerprint changes and watcher paths, source-verify a bounded rotating
   *  batch, and drop what's gone. Called on boot and every changes() poll. */
  private rescan(): Promise<void> {
    this.rescanInFlight ??= this.doRescan().finally(() => {
      this.rescanInFlight = null
    })
    return this.rescanInFlight
  }

  /** Pick the next bounded slice of indexed paths after the persisted cursor.
   *  SQLite's path index supplies deterministic order without materializing and
   *  sorting the full scanned corpus in JS. New files need no sweep slot because
   *  normal reconciliation already reads them; deleted selections are harmless
   *  bounded attempts and disappear from `notes` later in the same pass. */
  private async planIntegritySweep(): Promise<{ paths: Set<string>; cursor: string | null }> {
    if (!this.fingerprintsReady || this.integritySweepBatchSize === 0) {
      return { paths: new Set(), cursor: null }
    }
    const previous = await this.metaValue(META_INTEGRITY_SWEEP_CURSOR)
    const selected =
      previous == null
        ? await this.sql.all<{ path: string }>(`SELECT path FROM notes ORDER BY path LIMIT ?`, [
            this.integritySweepBatchSize,
          ])
        : await this.sql.all<{ path: string }>(
            `SELECT path FROM notes WHERE path > ? ORDER BY path LIMIT ?`,
            [previous, this.integritySweepBatchSize],
          )

    if (previous != null && selected.length < this.integritySweepBatchSize) {
      selected.push(
        ...(await this.sql.all<{ path: string }>(
          `SELECT path FROM notes WHERE path <= ? ORDER BY path LIMIT ?`,
          [previous, this.integritySweepBatchSize - selected.length],
        )),
      )
    }

    return {
      paths: new Set(selected.map((row) => row.path)),
      cursor: selected.at(-1)?.path ?? null,
    }
  }

  private recordFingerprint(
    noteRowid: number,
    noteSeq: number,
    sourceHash: string,
    changeToken: string | undefined,
  ): Promise<{ changes: number }> {
    if (!this.fingerprintsReady) {
      return Promise.resolve({ changes: 0 })
    }

    return this.sql.run(
      `INSERT INTO file_fingerprints (note_rowid, note_seq, source_hash, change_token)
       SELECT rowid, seq, ?, ? FROM notes WHERE rowid = ? AND seq = ?
       ON CONFLICT(note_rowid) DO UPDATE SET
         note_seq = excluded.note_seq,
         source_hash = excluded.source_hash,
         change_token = excluded.change_token
       WHERE file_fingerprints.note_seq IS NOT excluded.note_seq
          OR file_fingerprints.source_hash IS NOT excluded.source_hash
          OR file_fingerprints.change_token IS NOT excluded.change_token`,
      [sourceHash, changeToken ?? null, noteRowid, noteSeq],
    )
  }

  /** Fingerprints are valid only for the exact materialized row version they
   *  describe. This makes a crash between notes UPDATE and fingerprint write,
   *  or two interleaved reconciles, fail safe as a missing fingerprint. */
  private sourceFingerprint(noteRowid: number, noteSeq: number): Promise<string | undefined> {
    if (!this.fingerprintsReady) {
      return Promise.resolve(undefined)
    }

    return this.sql
      .get<{ source_hash: string }>(
        `SELECT source_hash FROM file_fingerprints WHERE note_rowid = ? AND note_seq = ?`,
        [noteRowid, noteSeq],
      )
      .then((row) => row?.source_hash)
  }

  private indexedSourceHash(path: string, expectedSeq: number): Promise<string | undefined> {
    if (!this.fingerprintsReady) {
      return Promise.resolve(undefined)
    }

    return this.sql
      .get<{ source_hash: string }>(
        `SELECT file_fingerprints.source_hash
           FROM notes
           JOIN file_fingerprints ON file_fingerprints.note_rowid = notes.rowid
          WHERE notes.path = ? COLLATE BINARY
            AND notes.seq = ?
            AND file_fingerprints.note_seq = notes.seq`,
        [path, expectedSeq],
      )
      .then((fingerprint) => fingerprint?.source_hash)
  }

  /** Run one cursor-sensitive DB slot after every earlier slot settles. The tail
   *  itself never rejects, so a failed operation always releases the next waiter. */
  private async withPublicationGate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.publicationTail
    let release!: () => void

    this.publicationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  /** Allocate and publish one notes seq in strict completion order across every
   *  async-compatible SQL driver. `this.seq` becomes externally visible only
   *  after the statement settles; rejection still consumes the stamp because the
   *  backend may have committed before reporting an uncertain failure. */
  private publishWithSeq<T>(publish: (seq: number) => Promise<T>): Promise<T> {
    return this.withPublicationGate(async () => {
      const seq = this.seq + 1

      try {
        return await publish(seq)
      } finally {
        this.seq = seq
      }
    })
  }

  /** A pre-fingerprint row can adopt the current raw hash without publishing a
   *  fake external edit when every index-visible projection already matches.
   *  Frontmatter unknown to the index does not block adoption: direct reads
   *  already serve it from disk, while no derived surface is stale. */
  private materializedRowMatches(
    row: NoteRow,
    cls: NoteClass,
    fullPath: string,
    raw: string,
  ): boolean {
    const parsed = parseNoteFile(raw, fullPath)

    return (
      row.class === cls &&
      row.title === parsed.title &&
      row.note_type === (parsed.noteType ?? DEFAULT_NOTE_TYPE) &&
      row.id_claim === parsed.idClaim &&
      row.tags === JSON.stringify(parsed.tags) &&
      row.aliases === JSON.stringify(parsed.aliases) &&
      row.slug === parsed.slug &&
      row.body === parsed.body &&
      (parsed.createdAt == null || row.created_at === parsed.createdAt)
    )
  }

  /** Recover a missing current fingerprint only when the exact indexed row still
   *  describes the bytes the mutation just read. This closes the crash window
   *  between publishing `notes` and its derived fingerprint without weakening
   *  the external-edit fence: a mismatching projection is never adopted. */
  private async verifiedIndexedSourceHash(row: NoteRow, raw: string): Promise<string | undefined> {
    const indexed = await this.indexedSourceHash(row.path, row.seq)

    if (indexed || !this.fingerprintsReady) {
      return indexed
    }
    const materialized = await this.sql.get<NoteRow & { rowid: number }>(
      `SELECT rowid AS rowid, * FROM notes WHERE path = ? COLLATE BINARY AND seq = ?`,
      [row.path, row.seq],
    )

    if (!materialized || !this.materializedRowMatches(materialized, row.class, row.path, raw)) {
      return undefined
    }
    const sourceHash = await sha256Hex(raw)

    await this.recordFingerprint(materialized.rowid, materialized.seq, sourceHash, undefined)
    return (await this.sourceFingerprint(materialized.rowid, materialized.seq)) === sourceHash
      ? sourceHash
      : undefined
  }

  /** Content verification after a stat/watcher/sweep candidate was selected.
   *  A matching raw hash only refreshes the cheap token. A legacy row with no
   *  fingerprint adopts the hash if its materialized projection already matches;
   *  every semantic mismatch goes through the normal upsert/delta path. */
  private async reconcileScannedFile(
    row: ReconcileRow | undefined,
    fullPath: string,
    cls: NoteClass,
    stat: FileStat,
    raw: string,
  ): Promise<void> {
    const sourceHash = await sha256Hex(raw)
    const metadataChanged =
      !row || row.class !== cls || row.mtime_ms !== stat.mtimeMs || row.size !== stat.size

    if (row && !metadataChanged) {
      const indexedSourceHash = await this.sourceFingerprint(row.rowid, row.seq)

      if (indexedSourceHash === sourceHash) {
        await this.recordFingerprint(row.rowid, row.seq, sourceHash, stat.changeToken)
        return
      }
      if (indexedSourceHash != null) {
        await this.upsertRow(fullPath, cls, stat, raw, sourceHash)
        return
      }
      const materialized = await this.sql.get<NoteRow>(`SELECT * FROM notes WHERE rowid = ?`, [
        row.rowid,
      ])

      if (materialized && this.materializedRowMatches(materialized, cls, fullPath, raw)) {
        await this.recordFingerprint(row.rowid, row.seq, sourceHash, stat.changeToken)
        return
      }
    }

    await this.upsertRow(fullPath, cls, stat, raw, sourceHash)
  }

  /** One-shot heal for notes written before the name formula had an id rung (#296):
   *  a title with nothing sluggable in it landed on `<dir>/.md`, a dot-file the scan
   *  used to hide — so the file lived on while the note read as externally deleted.
   *  Renames each onto the name it would get today, IN PLACE (identity is the
   *  `notarium-id` in the frontmatter, P7, so the note keeps its URL, links and
   *  history), before this same pass reconciles — the tombstone never happens.
   *
   *  Best-effort by construction: a heal that cannot pick a free name, or whose rename
   *  loses a race, leaves the entry alone and the file is still indexed (visible under
   *  its odd name beats a tombstone over a live file). Mutates `scanned` so the
   *  reconcile below sees the healed path.
   */
  private async healUnnamedFiles(
    scanned: Array<{ mount: EngineMount; entry: FileStat; fullPath: string }>,
  ): Promise<void> {
    const unnamed = scanned.filter(({ entry }) => basenameOf(entry.path) === UNNAMED_NOTE_FILENAME)

    if (!unnamed.length) {
      return
    }
    const taken = new Set(scanned.map(({ fullPath }) => fullPath))

    for (const item of unnamed) {
      const { mount, entry } = item
      const raw = await mount.files.read(entry.path)

      if (raw == null) {
        continue // vanished mid-heal — the next scan reconverges
      }
      let parsed: ReturnType<typeof parseNoteFile>

      try {
        parsed = parseNoteFile(raw, entry.path)
      } catch (err) {
        if (err instanceof FrontmatterLimitError) {
          continue
        }
        throw err
      }

      // Production writes that suffered the old empty-name bug already carried the
      // stable id claim minted by the read-model. An arbitrary user-owned `.md`
      // without that proof is a hidden file, not ours to rename or index.
      if (!parsed.idClaim) {
        const at = scanned.indexOf(item)

        if (at !== -1) {
          scanned.splice(at, 1)
        }
        continue
      }
      const dir = directoryOf(entry.path)
      // `parseNoteFile` falls back to the FILE NAME for a note carrying neither a
      // `title:` nor an `# H1` — and this file's name is empty, so that fallback hands
      // back the path itself (`journal/.md`). Naming the healed file after that would
      // stamp `journal-md.md` on a note whose title is not a title at all; an untitled
      // note has nothing to be named after but its id.
      const titled = parsed.title === entry.path || parsed.title === UNNAMED_NOTE_FILENAME
      const title = titled ? '' : parsed.title
      // The id fallback only fires when the title has no letters at all; a CJK/Hebrew
      // title now names its own file. Each collision-series candidate is byte-bounded
      // from its WHOLE spelling; ordinary valid names reserve no hypothetical suffix.
      const base = noteFileBase(title, undefined, parsed.idClaim ?? undefined)
      const pathFor = (name: string): string => (dir ? `${dir}/${name}.md` : `${name}.md`)
      const bounded = (name: string): string => boundNameToBytes(name, NOTE_BASENAME_MAX_BYTES)

      // A check followed by ordinary rename is still an overwrite race. Only an
      // adapter's atomic no-replace primitive may heal automatically; on a collision
      // (including a directory invisible to scan) claim the next series member now,
      // rather than waiting forever on the same candidate next boot.
      if (!mount.files.renameIfAbsent) {
        continue
      }
      for (let attempt = 0; attempt < 10_000; attempt++) {
        // Always let the adapter try the canonical first name once. `taken` may
        // contain OUR hard-link publication from a process interruption; only the
        // adapter can distinguish that recoverable same-inode state from a rival.
        const rawName =
          attempt === 0
            ? base
            : uniqueSlug(base, (cand) => !taken.has(this.fullIn(mount, pathFor(bounded(cand)))), {
                maxLength: Number.MAX_SAFE_INTEGER,
              })
        const rel = pathFor(bounded(rawName))
        const full = this.fullIn(mount, rel)
        let moved = false

        try {
          moved = await mount.files.renameIfAbsent(entry.path, rel)
        } catch {
          break // vanished source or permission wall — next scan reconverges
        }
        if (!moved) {
          taken.add(full)
          continue
        }
        const stat = await mount.files.stat(rel)

        // The move already succeeded, so the old path is known dead even when one
        // best-effort stat loses a transient race. Preserve the scan's size/times as
        // a fallback but drop its stale change token; reconcile will source-verify the
        // bytes at the NEW path in this same pass instead of hiding the note until the
        // next poll.
        taken.delete(item.fullPath)
        taken.add(full)
        item.entry = stat ?? { ...item.entry, path: rel, changeToken: undefined }
        item.fullPath = full
        break
      }
    }
  }

  private async doRescan(): Promise<void> {
    this.scanning = true
    const forcedPaths = new Set(this.forcedReadPaths)
    this.forcedReadPaths.clear()
    let completed = false

    try {
      const rows = this.fingerprintsReady
        ? await this.sql.all<ReconcileRow>(
            `SELECT notes.rowid AS rowid, notes.path, notes.class, notes.mtime_ms, notes.size,
                    notes.seq,
                    CASE WHEN file_fingerprints.note_seq = notes.seq
                         THEN file_fingerprints.change_token ELSE NULL END AS change_token,
                    CASE WHEN file_fingerprints.note_seq = notes.seq
                         THEN file_fingerprints.source_hash ELSE NULL END AS source_hash
             FROM notes
             LEFT JOIN file_fingerprints ON file_fingerprints.note_rowid = notes.rowid`,
          )
        : await this.sql.all<ReconcileRow>(
            `SELECT rowid, path, class, mtime_ms, size, seq,
                    NULL AS change_token, NULL AS source_hash
             FROM notes`,
          )
      const known = new Map(rows.map((r) => [r.path, r]))
      const seen = new Set<string>()
      const scanned: Array<{ mount: EngineMount; entry: FileStat; fullPath: string }> = []

      // No explicit cooperative yield here (#222): a cold reindex is already loop-
      // friendly by construction — every changed file passes through `await
      // mount.files.read()` (localfs = threadpool I/O, a macrotask), so the reindex
      // hands the loop back between files and never blocks it for more than one
      // upsertRow (parse + content-hash + INSERT, low single-digit ms). Measured: the
      // cold `changes(null)` loop-block is dominated by the phase-1 seed's metaOf pass,
      // not this loop — adding a yield here moved it &lt;10ms (redundant), so it isn't.
      for (const mount of this.mounts) {
        const entries = await mount.files.scan()

        for (const entry of entries) {
          scanned.push({ mount, entry, fullPath: this.fullIn(mount, entry.path) })
        }
      }
      await this.healUnnamedFiles(scanned)
      const sweep = await this.planIntegritySweep()

      for (const { mount, entry, fullPath } of scanned) {
        seen.add(fullPath)
        const row = known.get(fullPath)
        const tokenChanged =
          row?.change_token != null &&
          entry.changeToken != null &&
          row.change_token !== entry.changeToken
        const shouldRead =
          !row ||
          row.class !== mount.class ||
          row.mtime_ms !== entry.mtimeMs ||
          row.size !== entry.size ||
          tokenChanged ||
          // A migrated row or a crash between row publication and fingerprint
          // publication has no trustworthy delete/edit baseline. Source-verify it
          // once now even when stat metadata is unchanged; reconcileScannedFile
          // adopts the hash only when every materialized projection agrees.
          (this.fingerprintsReady && row.source_hash == null) ||
          forcedPaths.has(fullPath) ||
          sweep.paths.has(fullPath)

        if (!shouldRead) {
          continue
        }
        const raw = await mount.files.read(entry.path)

        if (raw == null) {
          continue
        } // vanished between scan and read — next poll converges
        try {
          await this.reconcileScannedFile(row, fullPath, mount.class, entry, raw)
        } catch (err) {
          // An oversized metadata block belongs to this one file. Keep scanning
          // healthy siblings and retry the bad path on a later rescan; unrelated
          // parser, SQL and filesystem failures must still abort the pass.
          if (err instanceof FrontmatterLimitError) {
            continue
          }
          throw err
        }
      }
      for (const row of rows) {
        if (!seen.has(row.path)) {
          await this.sql.run(`DELETE FROM notes WHERE path = ?`, [row.path])
          this.invalidateGraphCache() // a removed note can change the wikilink graph (#81 Stage 4b)
        }
      }
      // Cursor records a bounded ATTEMPT, not universal read success. A
      // stat-visible but permanently unreadable file must not head-of-line block
      // every later path forever; it is retried on the next rotation. An exact
      // watcher path likewise buys one immediate attempt, then falls back to this
      // bounded rotation instead of growing an unbounded permanent retry-set.
      if (sweep.cursor) {
        await this.setMeta(META_INTEGRITY_SWEEP_CURSOR, sweep.cursor)
      }
      this.lastScanAt = new Date().toISOString()
      this.noteCount = scanned.length
      completed = true
    } finally {
      if (!completed) {
        for (const path of forcedPaths) {
          this.forcedReadPaths.add(path)
        }
      }
      this.scanning = false
    }
  }

  /** Parse a file into its index row. `cls` is the file's mount class (#78).
   *  created_at: an existing row's value survives an overwrite (the atomic
   *  tmp+rename write replaces the inode, so birthtime alone would reset on
   *  every edit); a fresh row takes the file's birthtime or honestly null.
   *  A `created:` frontmatter claim (#11 import / portable dates) OVERRIDES the
   *  birthtime — the file is the creation date's truth, so an imported conversation
   *  is dated by when it happened, not when it landed on disk. `modified` always
   *  tracks the real mtime. `stat.path` is mount-relative; `fullPath` the key. */
  private async upsertRow(
    fullPath: string,
    cls: NoteClass,
    stat: FileStat,
    raw: string,
    knownSourceHash?: string,
  ): Promise<void> {
    this.invalidateGraphCache() // any row change can shift the wikilink graph (#81 Stage 4b)
    const parsed = parseNoteFile(raw, fullPath)
    // `modified` is always the file's real mtime; `created:` frontmatter (an
    // import, #11) overrides birthtime so a note keeps the date it happened.
    const modifiedAt = isoOrNull(stat.mtimeMs)
    const createdAt = parsed.createdAt ?? isoOrNull(stat.birthtimeMs)
    const tags = JSON.stringify(parsed.tags)
    const aliases = JSON.stringify(parsed.aliases)
    const slug = parsed.slug // #100 phase 1: NULL when no custom `slug:` in frontmatter
    // content_hash is computed for EVERY upsert (cheap), not just when an embedder
    // is wired in: it must be present so that adding an embedder on a later boot
    // can backfill vectors for files that didn't change (#81/P13 invalidation
    // arbiter; mtime/size are the cheap pre-filter the rescan already applies).
    const contentHash = await this.embedContentHash(parsed.title, parsed.body)
    const sourceHash = knownSourceHash ?? (await sha256Hex(raw))
    // created_at on UPDATE rides COALESCE(claim, existing): a `created:` frontmatter
    // claim (import #11 / an authored date edit #186) REFRESHES the index so the new
    // date is visible at once; a note with NO claim keeps its first-seen value (NULL
    // param → existing), so a birthtime flap on a re-stat never moves an un-dated
    // note's Feed position. The INSERT branch seeds created_at for a brand-new row.
    const published = await this.publishWithSeq(async (seq) => {
      const updated = await this.sql.run(
        `UPDATE notes SET title = ?, class = ?, mtime_ms = ?, size = ?, modified_at = ?,
                          note_type = ?, created_at = COALESCE(?, created_at),
                          id_claim = ?, source_locator = ?, tags = ?, aliases = ?, slug = ?, body = ?, content_hash = ?, seq = ?
         WHERE path = ?`,
        [
          parsed.title,
          cls,
          stat.mtimeMs,
          stat.size,
          modifiedAt,
          parsed.noteType ?? DEFAULT_NOTE_TYPE,
          parsed.createdAt,
          parsed.idClaim,
          parsed.sourceLocator,
          tags,
          aliases,
          slug,
          parsed.body,
          contentHash,
          seq,
          fullPath,
        ],
      )

      if (updated.changes === 0) {
        await this.sql.run(
          `INSERT INTO notes (path, title, class, mtime_ms, size, created_at, modified_at, note_type, id_claim, source_locator, tags, aliases, slug, body, content_hash, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            fullPath,
            parsed.title,
            cls,
            stat.mtimeMs,
            stat.size,
            createdAt,
            modifiedAt,
            parsed.noteType ?? DEFAULT_NOTE_TYPE,
            parsed.idClaim,
            parsed.sourceLocator,
            tags,
            aliases,
            slug,
            parsed.body,
            contentHash,
            seq,
          ],
        )
      }
      const row = await this.sql.get<{ rowid: number }>(`SELECT rowid FROM notes WHERE path = ?`, [
        fullPath,
      ])

      return { seq, rowid: row?.rowid }
    })

    // Enqueue the (re)embed off the note's rowid — stable across this UPDATE and
    // across renames, the same key FTS and note_vectors ride. The loop dedups by
    // content_hash, so a touch with unchanged content costs only a count query.
    if (published.rowid != null) {
      await this.recordFingerprint(published.rowid, published.seq, sourceHash, stat.changeToken)
      if (this.vecReady) {
        this.enqueueEmbed(BigInt(published.rowid))
      }
    }
  }

  /** One EXACT observation of a file: `stat → read → stat`. `stat` and `read` are
   *  separate storage calls, so a single pair proves nothing — a body that changed
   *  between them would be indexed against the wrong generation. Atomic rename
   *  guarantees each read is COMPLETE, not that it is still current. */
  private async stableSnapshot(
    mount: EngineMount,
    rel: string,
  ): Promise<{ raw: string; hash: string; stat: FileStat } | null> {
    for (let attempt = 0; attempt < STABLE_SNAPSHOT_ATTEMPTS; attempt++) {
      const before = await mount.files.stat(rel)

      if (!before) {
        return null
      }
      const raw = await mount.files.read(rel)

      if (raw == null) {
        return null
      }
      const after = await mount.files.stat(rel)

      if (after && sameFileGeneration(before, after)) {
        return { raw, hash: await sha256Hex(raw), stat: after }
      }
    }

    throw writeFailed('storage kept changing while the note was being observed')
  }

  /** Prove the exact index row describes `snapshot`, repairing at most once. This
   *  is a PREDICATE, not a refresh: an unconditional `reindexPath` would publish a
   *  seq (`upsertRow`) and every consumer would see a phantom external edit on a
   *  file that never changed. `reconcileScannedFile` already encodes the three
   *  cases — fresh row (no seq), missing fingerprint over a matching projection
   *  (adopt at the same seq), stale row (one upsert). */
  private async proveIndexedIdentity(
    fullPath: string,
    cls: NoteClass,
    targetId: string,
    snapshot: { raw: string; hash: string; stat: FileStat },
  ): Promise<boolean> {
    const row = await this.sql.get<NoteRow & { rowid: number }>(
      `SELECT rowid AS rowid, * FROM notes WHERE path = ? COLLATE BINARY`,
      [fullPath],
    )

    await this.reconcileScannedFile(
      row
        ? {
            rowid: row.rowid,
            path: row.path,
            class: row.class,
            mtime_ms: row.mtime_ms,
            size: row.size,
            seq: row.seq,
            change_token: null,
            source_hash: null,
          }
        : undefined,
      fullPath,
      cls,
      snapshot.stat,
      snapshot.raw,
    )

    const proven = await this.sql.get<NoteRow & { rowid: number }>(
      `SELECT rowid AS rowid, * FROM notes WHERE path = ? COLLATE BINARY`,
      [fullPath],
    )

    return (
      proven != null &&
      proven.id_claim === targetId &&
      proven.class === cls &&
      proven.mtime_ms === snapshot.stat.mtimeMs &&
      proven.size === snapshot.stat.size &&
      (await this.sourceFingerprint(proven.rowid, proven.seq)) === snapshot.hash
    )
  }

  /** Bring ONE path onto `targetId` and prove it, without ever publishing an
   *  unproven state (#327). The loop is the point: a body edit landing between the
   *  read and the proof is reconciled HERE, before the caller may publish, while an
   *  edit strictly after the final observation is simply the next external change.
   *  canon: docs/core.md#identity */
  async materializeIdentityAtPath({
    filePath,
    expectedClaimId,
    targetId,
  }: IdentityMaterializationInput): Promise<IdentityMaterialization> {
    await this.ensureReady()
    if (!isValidNoteId(targetId) || !isDurableScalar(filePath)) {
      throw writeFailed('identity materialization needs a durable path and id')
    }
    const mount = this.mountForPath(filePath)
    const rel = this.relIn(mount, filePath)
    let expected = expectedClaimId

    for (let attempt = 0; attempt < MATERIALIZE_ATTEMPTS; attempt++) {
      const snapshot = await this.stableSnapshot(mount, rel)

      if (!snapshot) {
        return { status: 'vanished' }
      }
      const actual = parseNoteFile(snapshot.raw, filePath).idClaim

      if (actual !== targetId) {
        // Only the caller's own observation may be replaced. Anything else on
        // disk is an external writer who must go through the arbiter first.
        if (actual !== expected) {
          return { status: 'claim-changed', observedId: actual }
        }
        if (!mount.files.replaceIfAbsent) {
          throw writeFailed('storage cannot rewrite an identity claim without replacing a race')
        }
        const next = upsertFrontmatterKey(snapshot.raw, NOTE_ID_FRONTMATTER_KEY, targetId)

        if (!(await mount.files.replaceIfAbsent(rel, rel, snapshot.raw, next))) {
          // Someone replaced the file between the snapshot and the swap. That is
          // exactly what the loop exists for: re-observe and classify the winner
          // instead of turning a transient race into a terminal failure.
          continue
        }
        expected = targetId
        continue
      }
      const proven = await this.proveIndexedIdentity(filePath, mount.class, targetId, snapshot)
      // The linearization point: only an observation taken AFTER the proof can
      // say whether what was proven is still what storage holds.
      const final = await this.stableSnapshot(mount, rel)

      if (!final) {
        return { status: 'vanished' }
      }
      if (proven && final.hash === snapshot.hash && sameFileGeneration(final.stat, snapshot.stat)) {
        return { status: 'materialized' }
      }
      const finalClaim = parseNoteFile(final.raw, filePath).idClaim

      if (finalClaim !== null && finalClaim !== targetId) {
        return { status: 'claim-changed', observedId: finalClaim }
      }
      // Same id, different bytes (or a lost claim): no re-arbitration is owed —
      // reconcile the new generation and prove it, still behind the fence.
      expected = finalClaim
    }

    throw writeFailed('identity materialization did not converge')
  }

  /** Refresh one index path from disk (post-mutation write-through). */
  private async reindexPath(fullPath: string): Promise<void> {
    const mount = this.mountForPath(fullPath)
    const rel = this.relIn(mount, fullPath)
    const stat = await mount.files.stat(rel)
    const raw = stat ? await mount.files.read(rel) : null

    if (!stat || raw == null) {
      await this.sql.run(`DELETE FROM notes WHERE path = ?`, [fullPath])
      this.invalidateGraphCache() // a removed note can change the wikilink graph (#81 Stage 4b)
      return
    }
    await this.upsertRow(fullPath, mount.class, stat, raw)
  }

  /** A proof is applicable only to the exact source hash it was adopted with.
   * Corrupt/stale derived rows degrade to authored metadata, never authority. */
  private async ownerProofFor(
    fullPath: string,
    source: Uint8Array,
  ): Promise<StorageOwnerProof | undefined> {
    const sourceHash = await sha256Hex(source)
    const row = await this.sql.get<{ proof_json: string }>(
      `SELECT document_proofs.proof_json
         FROM document_proofs
         JOIN notes ON notes.rowid = document_proofs.note_rowid
        WHERE notes.path = ? AND document_proofs.source_hash = ?`,
      [fullPath, sourceHash],
    )

    return row ? parseStoredOwnerProof(row.proof_json) : undefined
  }

  /** Materialize the receipt's submitted bytes directly. Re-reading the path
   * here would assemble metadata from a later external version and discard the
   * adapter's operation-owned publication proof. */
  private async reindexPublishedPath(
    fullPath: string,
    source: Uint8Array,
    receipt: MutationReceipt,
    proof: StorageOwnerProof,
  ): Promise<void> {
    const mount = this.mountForPath(fullPath)
    const transition = receipt.transitions.find((candidate) => candidate.path === fullPath)
    const sourceHash = await sha256Hex(source)

    if (
      receipt.candidateHash !== sourceHash ||
      !transition ||
      transition.after.kind !== 'present' ||
      transition.mtimeMs == null
    ) {
      throw new Error('mutation receipt does not prove the published note')
    }
    const raw = NOTE_TEXT_UTF8.decode(source)

    await this.upsertRow(
      fullPath,
      mount.class,
      {
        path: this.relIn(mount, fullPath),
        mtimeMs: transition.mtimeMs,
        size: source.byteLength,
        changeToken: transition.after.value,
        // An absent→present receipt is the creation event we just witnessed.
        // Updates preserve the row's existing created_at through COALESCE.
        birthtimeMs:
          transition.before.kind === 'absent' ? Date.parse(receipt.semanticEventTime) : null,
      },
      raw,
      sourceHash,
    )
    const row = await this.sql.get<{ rowid: number }>(`SELECT rowid FROM notes WHERE path = ?`, [
      fullPath,
    ])

    if (row) {
      if (proof.claims.length) {
        await this.sql.run(
          `INSERT INTO document_proofs (note_rowid, source_hash, proof_json, receipt_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(note_rowid) DO UPDATE SET
             source_hash = excluded.source_hash,
             proof_json = excluded.proof_json,
             receipt_id = excluded.receipt_id`,
          [row.rowid, sourceHash, JSON.stringify(proof), receipt.id],
        )
      } else {
        await this.sql.run(`DELETE FROM document_proofs WHERE note_rowid = ?`, [row.rowid])
      }
    }
  }

  /** Resolve an engine read key: exact identity/storage first, then the shared human
   *  resolver. CachedStore normally selects a human winner above this seam and returns
   *  with an identity; bare and degraded paths retain the same fallback.
   *  @see docs/core.md#graph-derivation */
  private async resolveRow(
    rawId: string,
    identityOnly = false,
    storageOnly = false,
  ): Promise<NoteRow | undefined> {
    if (storageOnly) {
      return this.sql.get<NoteRow>(`SELECT * FROM notes WHERE path = ?`, [rawId])
    }
    const identityEnvelope = isWikilinkIdentityTarget(rawId)

    if (identityEnvelope && !identityOnly) {
      const rawRegisteredPath = this.linkIdentitiesConfigured
        ? this.linkIdentities.get(rawId)?.path
        : undefined
      const byRawId = rawRegisteredPath
        ? await this.sql.get<NoteRow>(`SELECT * FROM notes WHERE path = ?`, [rawRegisteredPath])
        : !this.linkIdentitiesConfigured
          ? await this.sql.get<NoteRow>(
              `SELECT * FROM notes WHERE id_claim = ? ORDER BY path LIMIT 1`,
              [rawId],
            )
          : undefined

      if (byRawId) {
        return byRawId
      }
    }
    // Ordinary `read(list().filePath)` is an exact storage lookup, including for
    // legacy POSIX names in the now-reserved envelope namespace. Authored links
    // opt into identity-only resolution through ReadOptions so a filename decoy
    // can never capture a stable-id target.
    if (identityEnvelope && !identityOnly) {
      const byExactEnvelopePath = await this.sql.get<NoteRow>(
        `SELECT * FROM notes WHERE path = ?`,
        [rawId],
      )

      if (byExactEnvelopePath) {
        return byExactEnvelopePath
      }
    }
    const envelopedId = decodeWikilinkIdentity(rawId)
    const identity = identityEnvelope ? envelopedId : rawId
    const registeredPath =
      identity != null && this.linkIdentitiesConfigured
        ? this.linkIdentities.get(identity)?.path
        : undefined
    const byId = registeredPath
      ? await this.sql.get<NoteRow>(`SELECT * FROM notes WHERE path = ?`, [registeredPath])
      : identity != null && !this.linkIdentitiesConfigured
        ? await this.sql.get<NoteRow>(
            `SELECT * FROM notes WHERE id_claim = ? ORDER BY path LIMIT 1`,
            [identity],
          )
        : undefined

    if (byId) {
      return byId
    }
    // A reserved identity target is never a human path/name. On a stale/missing id,
    // stop here so a literal file named like the envelope cannot capture the link.
    if (identityEnvelope) {
      return undefined
    }
    // Preserve the storage contract first: every literal filePath returned by
    // list() must be readable even when its legal filename contains wikilink
    // syntax (`#` / `|`). The HTTP wiki-ref boundary normalizes before store.read.
    const byExactPath = await this.sql.get<NoteRow>(`SELECT * FROM notes WHERE path = ?`, [rawId])

    if (byExactPath) {
      return byExactPath
    }
    // Human convenience/reference resolution starts only after the exact raw
    // storage-key axis, so `Foo#section` targets Foo while `Foo#section.md` can
    // still be addressed internally as a literal listed path.
    const humanTarget = normalizeWikilinkTarget(rawId)

    if (!humanTarget) {
      return undefined
    }
    const candidates = [`${humanTarget}.md`, humanTarget]

    for (const p of candidates) {
      const row = await this.sql.get<NoteRow>(`SELECT * FROM notes WHERE path = ?`, [p])

      if (row) {
        return row
      }
    }
    // Bare/degraded direct reads use the same name algebra as graph derivation.
    // Production CachedStore resolves a human target before its exact-id read; the
    // shared index keeps this fallback from copying the resolver's pass order.
    const all = await this.sql.all<NoteMetaRow>(`SELECT ${NOTE_META_COLS} FROM notes ORDER BY path`)
    const currentFolders = await this.mountForClass(undefined).files.listDirs()
    const index = buildLinkIndex(
      all.map((r) => this.linkMeta(this.metaOf(r))),
      this.folderAliases,
      undefined,
      currentFolders,
    )

    this.registerLinkIdentities(index, all)
    const resolved = resolveLink(humanTarget, index)

    if (resolved.ghost) {
      return undefined
    }

    return this.sql.get<NoteRow>(`SELECT * FROM notes WHERE path = ?`, [resolved.targetId])
  }

  private metaOf(
    row: Pick<NoteRow, 'path' | 'title' | 'class' | 'modified_at' | 'created_at'> & {
      source_locator?: string | null
      aliases?: string
      slug?: string | null
      tags?: string
    },
  ): NoteMeta {
    const aliases = parseJsonArray(row.aliases)
    const tags = parseJsonArray(row.tags) // #109: the tag axis on the snapshot (column already SELECTed)
    return {
      title: row.title,
      class: row.class,
      filePath: row.path,
      ...(row.source_locator ? { sourceLocator: row.source_locator } : {}),
      ...(row.slug ? { slug: row.slug } : {}), // #100 phase 1: custom slug only
      ...(aliases.length ? { aliases } : {}),
      ...(tags.length ? { tags } : {}),
      modifiedAt: row.modified_at,
      createdAt: row.created_at,
    }
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  // A bare engine materializes `class` but does NOT enforce visibility: the
  // ReadScope the port allows here is ignored (the param is omitted, like read's
  // ReadOptions) — the read-model is the visibility chokepoint (#78).
  async list(opts?: ListOptions): Promise<NoteMeta[]> {
    await this.ensureReady()
    const classes = opts?.classes == null ? undefined : [...new Set(opts.classes)]

    if (classes?.length === 0) {
      return []
    }
    // Meta-only projection (#222): list() feeds Feed/tree/buckets, all of which
    // slice metadata — never the body. `SELECT *` here materialized every note's
    // body just to throw it away in metaOf.
    // A class-narrowed list rides idx_notes_class, so a tiny typed mount costs
    // O(mount rows), not O(the whole corpus). Scope remains a read-model concern.
    const where = classes ? ` WHERE class IN (${classes.map(() => '?').join(',')})` : ''
    const rows = await this.sql.all<NoteMetaRow>(
      `SELECT ${NOTE_META_COLS} FROM notes${where} ORDER BY path`,
      classes,
    )
    return rows.map((r) => this.metaOf(r))
  }

  /** The directory channel (#97): every user-visible folder, INCLUDING empty
   *  ones the note index can't see. A separate on-disk walk of the user-doc
   *  mount — never the note FileStat[] (#78 index-isolation). Dot-namespaced
   *  sub-mounts (.notarium/memory) don't surface (the walk skips dot-dirs). */
  async listDirs(): Promise<string[]> {
    await this.ensureReady()
    return this.mountForClass(undefined).files.listDirs()
  }

  /** Create an empty folder (#97 "New folder") — a durable on-disk anchor that
   *  carries no note. Lands in the user-doc mount; a normal non-dot folder path
   *  so it never collides with a sub-mount namespace. */
  async makeDir(path: string): Promise<void> {
    await this.ensureReady()
    const existingDirs = new Set(await this.listDirs())

    if (!isPortableRelativeDestination(path, (prefix) => existingDirs.has(prefix))) {
      throw moveFailed('folder path contains an invalid durable string')
    }
    const clean = path.replace(/^\/+|\/+$/g, '')

    if (!clean) {
      return
    }
    const mount = this.mountForPath(clean)
    const rel = this.relIn(mount, clean)
    await this.assertDirectorySpelling(mount, directoryOf(rel))
    if (!(await mount.files.makeDir(rel))) {
      throw moveFailed('a folder with that name already exists')
    }
    this.invalidateGraphCache()
  }

  /** Delete a folder subtree (#97 folder delete): remove its on-disk tree (any
   *  stray notes, sibling markers, nested empty dirs) and drop the index rows it
   *  covered. CachedStore removes journaled notes first, so by here the subtree is
   *  usually just empty dir shells + markers; this is the wholesale cleanup. */
  async removeDir(path: string, opts?: MutationOptions): Promise<void> {
    await this.ensureReady()
    if (
      !(opts?.internalAddress
        ? isCanonicalInternalRelativeAddress(path)
        : isCanonicalSafeRelativeAddress(path))
    ) {
      throw moveFailed('folder path contains an invalid durable string')
    }
    const clean = path.replace(/^\/+|\/+$/g, '')

    if (!clean) {
      return
    }
    const packageLease =
      opts?.internalAddress && this.resourceAuthority
        ? await this.resourceAuthority.admitSkillPlacement(
            `${clean}/SKILL.md`,
            'exclusive',
            'notarium-remove-skill-package',
          )
        : null

    try {
      const mount = this.mountForPath(clean)
      const rel = this.relIn(mount, clean)

      // Destructive directory sources are RAW identities. On an insensitive medium
      // `docs` may reach a physical `Docs`, while the BINARY index/journal only know
      // `Docs`; accepting that alternate spelling would delete bytes without victims.
      if (!(await mount.files.listDirs()).includes(rel)) {
        return
      }
      if (!opts?.internalAddress) {
        await mount.files.removeDir(rel)
      } else {
        if (!mount.files.renameDirIfAbsent) {
          throw moveFailed('storage cannot atomically detach a skill package')
        }
        const staging = `${directoryOf(rel) ? `${directoryOf(rel)}/` : ''}.${basenameOf(
          rel,
        )}.delete-${randomUUID()}`

        await opts.beforeDetach?.()
        if (!(await mount.files.renameDirIfAbsent(rel, staging))) {
          throw moveFailed('skill package changed during delete')
        }
        try {
          await opts.afterDetach?.()
          await mount.files.removeDir(staging)
        } catch (error) {
          await mount.files.renameDirIfAbsent(staging, rel).catch(() => false)
          throw error
        }
      }
      const prefix = `${clean}/`

      await this.sql.run(
        `DELETE FROM notes
         WHERE path = ? COLLATE BINARY
            OR substr(path, 1, length(?)) = ? COLLATE BINARY`,
        [clean, prefix, prefix],
      )
      this.invalidateGraphCache() // removing notes can change the wikilink graph (#81 Stage 4b)
      // Dropping a whole subtree (a project, a deep folder) can free a lot of index
      // pages at runtime — the one bulk-free path that isn't a boot teardown or an
      // embed re-write (#198). Compact them back to the OS instead of waiting for the
      // next boot; no-ops on a small freelist, so a tiny folder delete costs nothing.
      this.scheduleReclaim()
    } finally {
      packageLease?.settle()
    }
  }

  /** Stream every source file for a base export (#17). Walks the on-disk truth
   *  directly, NOT the index — the export ships the user's actual files, incl.
   *  the `notarium-id` frontmatter and binary package resources, so the archive
   *  round-trips. `scope` reuses the visibility class set: `user`
   *  (default) keeps only user-visible mounts — agent-memory's dot-namespaced
   *  mount falls out, so the personal memory never lands in a "my notes"
   *  download; `all` is the full space-file export, not a host/meta backup. Async + per-file so the host zips and
   *  streams without holding the base in memory (P-scale headroom). Paths carry
   *  the mount prefix (a hidden mount's files surface as `.notarium/memory/...`
   *  under `all`). The engine doesn't enforce visibility (#78) — but export is a
   *  deliberate bulk read, so it honours scope HERE rather than leaning on the
   *  read-model, which never sees the raw files. */
  async *exportNotes(opts?: { scope?: ReadScope }): AsyncIterable<ExportEntry> {
    await this.ensureReady()
    const allowed = classesForScope(opts?.scope ?? 'user')

    for (const mount of this.mounts) {
      if (!allowed.has(mount.class)) {
        continue
      }
      if (mount.class === 'skill' && mount.files.exportFiles) {
        const entries = this.resourceAuthority
          ? this.resourceAuthority.exportAdapter(mount.prefix, { owner: 'notarium-export' })
          : mount.files.exportFiles()

        for await (const entry of entries) {
          yield {
            path: this.resourceAuthority ? entry.path : this.fullIn(mount, entry.path),
            content: entry.content,
            preserveBytes: true,
          }
        }
        continue
      }
      for (const entry of await mount.files.scan()) {
        const raw = await mount.files.read(entry.path)

        // A file that vanished between scan and read (an external delete mid-export)
        // is an honest skip, not a failure — the next export reconverges.
        if (raw == null) {
          continue
        }
        yield { path: this.fullIn(mount, entry.path), content: raw }
      }
    }
  }

  /** Serve the note from disk — the file is the truth, the index only finds
   *  it. A row whose file is gone (external delete since the last poll) is an
   *  honest miss, and the stale row is dropped on the spot. */
  // Most ReadOptions are scheduling hints for engines that serialize remote calls;
  // this local engine only consumes the identity-axis discriminator.
  async read(rawId: string, opts?: ReadOptions): Promise<NoteContent> {
    await this.ensureReady()
    const row = await this.resolveRow(rawId, opts?.identityOnly, opts?.storageOnly)

    if (!row) {
      throw noteNotFound(rawId)
    }
    const mount = this.mountForPath(row.path)
    const relativePath = this.relIn(mount, row.path)
    const fileName = basenameOf(row.path)
    const packagePath = this.packagePathFor(mount, relativePath)
    const skillRoot = mount.class === 'skill' && isSkillPackageRootPath(relativePath)
    let role: DocumentRole =
      row.class === 'skill' && skillRoot ? DOCUMENT_ROLE.skillRoot : DOCUMENT_ROLE.generic
    let observation: ResourceObservation | undefined

    if (this.resourceAuthority && row.class === 'skill' && !skillRoot) {
      if (packagePath) {
        const validateTarget = (target: ResourceObservation & { kind: 'present' }): boolean =>
          analyzeDocumentState({
            source: target.bytes,
            role: DOCUMENT_ROLE.skillRoot,
            skillDirectoryName: basenameOf(packagePath),
          }).format === DOCUMENT_STATE_FORMAT.skill
        const linked = opts?.resourceAdmitted
          ? await this.resourceAuthority.observeLinkedAdmitted(
              row.path,
              `${packagePath}/SKILL.md`,
              validateTarget,
            )
          : await this.resourceAuthority.observeLinked(
              row.path,
              `${packagePath}/SKILL.md`,
              validateTarget,
              { owner: 'notarium-read-skill-auxiliary' },
            )

        if (linked) {
          observation = linked.source
          role = DOCUMENT_ROLE.skillAuxiliary
        }
      }
    }
    observation ??= this.resourceAuthority
      ? opts?.resourceAdmitted
        ? await this.resourceAuthority.observeStrictAdmitted(row.path)
        : await this.resourceAuthority.observe(row.path, { owner: 'notarium-read' })
      : undefined

    if (observation?.kind === 'unavailable' || observation?.kind === 'occupied') {
      const err = new StoreError(`resource is not stably readable: ${row.path}`)
      err.isUnavailable = true
      err.reason = 'resource_observation_unavailable'
      throw err
    }
    const exactSource = observation
      ? observation.kind === 'present'
        ? observation.bytes
        : null
      : mount.files.readBytes
        ? await mount.files.readBytes(relativePath)
        : undefined
    const raw =
      exactSource !== undefined
        ? exactSource == null
          ? null
          : NOTE_TEXT_UTF8.decode(exactSource)
        : await mount.files.read(relativePath)

    if (raw == null) {
      await this.sql.run(`DELETE FROM notes WHERE path = ?`, [row.path])
      this.invalidateGraphCache() // dropping a stale row can change the wikilink graph (#81 Stage 4b)
      throw noteNotFound(rawId)
    }
    const source = exactSource ?? new TextEncoder().encode(raw)
    const parsed = parseNoteFile(raw, row.path)
    const ownerProof = await this.ownerProofFor(row.path, source)
    const documentState = analyzeDocumentState({
      source,
      role,
      pathFallbackTitle: fileName.replace(/\.md$/i, ''),
      ownerProof,
      ...(role === DOCUMENT_ROLE.skillRoot
        ? { skillDirectoryName: basenameOf(directoryOf(row.path)) }
        : {}),
    })
    const projection = documentState.projection
    return {
      id: parsed.idClaim ?? undefined,
      title: projection?.title ?? parsed.title,
      class: row.class,
      filePath: row.path,
      content: projection?.body ?? parsed.body,
      // Keep storage-owner projections on the ordinary read surface: the
      // identity decorator adopts an external file's notarium-id from here.
      // DocumentState keeps the authored-only projection separately.
      frontmatter: parsed.frontmatter,
      ...(parsed.sourceLocator ? { sourceLocator: parsed.sourceLocator } : {}),
      logicalState: logicalNoteState({
        title: parsed.title,
        body: parsed.body,
        frontmatter: parsed.frontmatterEntries,
      }),
      documentState,
      ...(observation?.kind === 'present'
        ? { physicalIncarnation: physicalIncarnationOf(observation) }
        : {}),
      ...(parsed.slug ? { slug: parsed.slug } : {}), // #100 phase 1: custom slug only
      ...(parsed.aliases.length ? { aliases: parsed.aliases } : {}),
      modifiedAt: row.modified_at,
      // The resolved creation instant (#186): the file's `created:` claim wins (the
      // freshest truth — read re-parses the file, so an authored edit shows at once
      // even before the index UPDATE settles), falling back to the row's value (the
      // birthtime-derived date for an un-dated note). What the editor prefills from.
      createdAt: parsed.createdAt ?? row.created_at,
      versionToken: documentStateVersionToken(documentState),
    }
  }

  async preview(id: string): Promise<Preview> {
    const detail = await this.read(id)
    return derivePreview(detail.content, detail.frontmatter?.tags)
  }

  async previews(ids: readonly string[], opts?: ReadOptions): Promise<Record<string, Preview>> {
    return collectPreviews(ids, opts, (id) => this.preview(id))
  }

  /** Cache-only peek is the read-model's game (sync surface, async index) —
   *  an honest null. */
  previewPeek(): Preview | null {
    return null
  }

  /** Search the index. Hybrid (FTS5 + vector, fused by RRF) when the vector
   *  channel is live, plain FTS5 otherwise — the switch is by CAPABILITY, never a
   *  caller-supplied mode (#81 P13): a degraded store and a vector-off deployment
   *  serve the same shape, just lexical-only. The class-visibility post-filter is
   *  the read-model's (#78) — this engine returns the full population either way,
   *  every hit carrying its class so the chokepoint can drop hidden ones. */
  async search(
    q: string,
    { pageSize = 25, scope, lexicalOnly }: SearchOptions = {},
  ): Promise<SearchResult[]> {
    await this.ensureReady()
    const tokens = q.split(/\s+/).filter(Boolean)

    if (!tokens.length) {
      return []
    }
    // Every token as a quoted prefix phrase: user input never reaches the
    // MATCH grammar raw (quotes/operators in a query are content, not syntax).
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ')

    // Membership mode (#190): the Feed q-filter wants CONTAINMENT, not vector
    // similarity — answer from FTS alone (and never warm/fuse the vector channel
    // for it), so a "filter" never admits a neighbour sharing no term.
    if (lexicalOnly) {
      return this.ftsSearch(match, q, pageSize)
    }
    if (this.vecReady && this.embedder && this.vectorWarm) {
      // Hybrid — but only once the model is WARM (vectorWarm), so a cold/just-booted
      // process answers from FTS INSTANTLY instead of waiting out the multi-second
      // model load; the boot warmup flips vectorWarm and subsequent queries fuse.
      // null = the query couldn't embed in time or the fused SQL errored — degrade
      // to FTS for THIS query (never 500). FTS is always available. (#81 P13)
      //
      // The graph channel fires ONLY for the user surface (scope 'user' or
      // undefined): agentRecall runs its OWN 1-hop planNeighbours expansion, so
      // adding the engine graph channel there would double-count the same neighbour
      // (#81 Stage 4b).
      const graphOn = scope === undefined || scope === 'user'
      const fused = await this.hybridSearch(match, q, pageSize, graphOn)

      if (fused) {
        return fused
      }
    } else if (this.vecReady && this.embedder) {
      // Cold (just booted) or a boot warmup that FAILED: answer from FTS now —
      // instant, never blocks — but kick a warmup so a LATER query fuses. This
      // self-heals a failed boot warmup on a quiescent (write-free) corpus, where no
      // background embed would ever re-trigger it (#81 final sweep). No-op once warm.
      this.warmUpVector()
    }

    return this.ftsSearch(match, q, pageSize)
  }

  /** Lexical-only path: bm25-ranked FTS5 with a matched-fragment snippet. */
  private async ftsSearch(
    match: string,
    _rawQuery: string,
    pageSize: number,
  ): Promise<SearchResult[]> {
    type Hit = {
      path: string
      title: string
      class: NoteClass
      note_type: string
      modified_at: string | null
      created_at: string | null
      snip: string | null
      rank: number
    }
    let hits: Hit[]

    try {
      hits = await this.sql.all<Hit>(
        `SELECT n.path AS path, n.title AS title, n.class AS class, n.note_type AS note_type,
                n.modified_at AS modified_at, n.created_at AS created_at,
                snippet(notes_fts, 1, '', '', '…', 24) AS snip,
                notes_fts.rank AS rank
         FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ? ORDER BY notes_fts.rank LIMIT ?`,
        [match, pageSize],
      )
    } catch {
      return [] // a query FTS5 still rejects is "nothing matched", not a 500
    }

    return hits.map((h) => ({
      title: h.title,
      class: h.class,
      filePath: h.path,
      modifiedAt: h.modified_at,
      createdAt: h.created_at,
      noteType: h.note_type || DEFAULT_NOTE_TYPE,
      type: 'note',
      // bm25 rank is negative-is-better; flip so a bigger score wins, the
      // shape search consumers already expect.
      score: -h.rank,
      snippet: toSnippet(h.snip),
    }))
  }

  /** Hybrid path: embed the query, pull the fts ∪ vec candidate POOL with per-channel
   *  ranks, fuse them in JS by RRF, optionally add the hub-robust 1-hop graph channel
   *  (#81 Stage 4b), then patch real FTS snippets onto the lexical hits. Returns null
   *  on any failure so the caller can fall back to FTS — embeddings are an optional
   *  capability, never a hard dependency (P13). The graph channel is BEST-EFFORT: an
   *  adjacency or expansion failure degrades to fts+vec only, it never sinks the
   *  search. The fused score is RRF-scale (~0.01–0.03), not the bm25-flip the FTS path
   *  emits; consumers compare scores WITHIN a hit set, and the host runs one engine
   *  kind so cross-space scores stay comparable (the documented recall/gateway
   *  assumption). Every returned hit carries its CLASS so the read-model's visibility
   *  post-filter (#78) can drop hidden ones — including graph neighbours fetched from
   *  outside the pool. */
  private async hybridSearch(
    match: string,
    queryText: string,
    pageSize: number,
    graphOn: boolean,
  ): Promise<SearchResult[] | null> {
    if (!this.embedder) {
      return null
    }
    let queryVec: Float32Array | undefined

    try {
      queryVec = await this.embedQuery(queryText)
    } catch (err) {
      console.error('[notarium] query embed failed — falling back to FTS:', err)
      return null
    }
    if (!queryVec) {
      return null
    } // model still cold within the timeout — FTS for now
    const blob = new Uint8Array(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength)
    const t = this.searchTuning
    const pool = Math.max(pageSize, t.poolSize)
    type Ranked = {
      note_rowid: number
      path: string
      title: string
      class: NoteClass
      note_type: string
      modified_at: string | null
      created_at: string | null
      body_head: string | null
      best_chunk: string | null
      fts_rnk: number | null
      vec_rnk: number | null
    }
    let ranked: Ranked[]

    try {
      ranked = await this.sql.all<Ranked>(HYBRID_RRF_SQL, [match, pool, blob, pool])
    } catch (err) {
      // A malformed FTS query, or a vec0 hiccup — degrade to FTS for this query.
      console.error('[notarium] hybrid search failed — falling back to FTS:', err)
      return null
    }

    // Per-channel reciprocal-rank fusion of the fts ∪ vec pool (the SQL no longer
    // pre-fuses): base = w_fts/(k+fts_rnk) + w_vec/(k+vec_rnk), a missing rank → 0.
    type Fused = Ranked & { base: number; graph: number }
    const byPath = new Map<string, Fused>()

    for (const r of ranked) {
      const base =
        (r.fts_rnk != null ? t.wFts / (t.rrfK + r.fts_rnk) : 0) +
        (r.vec_rnk != null ? t.wVec / (t.rrfK + r.vec_rnk) : 0)
      byPath.set(r.path, { ...r, base, graph: 0 })
    }

    // Graph channel (#81 Stage 4b): hub-robust 1-hop expansion of the top fused
    // hits. Best-effort — an adjacency build or expansion failure must not sink the
    // search (the fts+vec fusion still stands), so it's wrapped and logged.
    if (graphOn && t.wGraph > 0) {
      try {
        const g = await this.ensureGraphAdjacency()

        if (!g) {
          throw new Error('adjacency not ready')
        } // first build in flight → fts+vec for now
        const hubs = computeHubs(g.degree, t.graphHubPercentile, g.total)
        // Seeds = the top fused fts+vec hits (query-relevant notes only, #81 Stage
        // 4a: seeding from non-relevant notes is pure noise).
        const seeds = [...byPath.values()]
          // The bare engine indexes every class, but the USER graph channel must
          // never let a hidden hit influence a visible result. A final CachedStore
          // class filter is too late: a hidden seed can already have boosted its
          // visible neighbour into the page, leaking that the hidden body matched.
          .filter((r) => r.base > 0 && isVisibleOn(SURFACE.graph, r.class))
          .sort((a, b) => b.base - a.base || a.path.localeCompare(b.path))
          .slice(0, t.graphSeedS)
        // The graph channel is a 1-hop EXPANSION: it scores the FRONTIER (notes one
        // hop from a strong hit), not the seeds themselves — a seed's relevance is
        // already in its fts+vec base. Excluding seeds as boost RECIPIENTS prevents
        // two mutually-linked top hits from inflating each other for linking (the
        // same signal counted twice, #81 Stage 4b review). Seeds still ACT as
        // sources of strength to their non-seed neighbours.
        const seedSet = new Set(seeds.map((s) => s.path))
        // Accumulate neighbour strength = Σ_seed seed.base × edge_weight(neighbour),
        // hubs + seeds excluded, capped to each seed's top-L neighbours so one
        // densely-linked seed can't flood the pool.
        const strength = new Map<string, number>()

        for (const seed of seeds) {
          const nbs = g.adj.get(seed.path)

          if (!nbs) {
            continue
          }
          const cand: Array<{ id: string; w: number }> = []

          for (const nb of nbs) {
            if (hubs.has(nb) || seedSet.has(nb)) {
              continue
            }
            const deg = g.degree.get(nb) ?? 1
            const ew = t.graphEdgeWeight === 'invdeg' ? 1 / deg : 1 / Math.sqrt(deg)
            cand.push({ id: nb, w: seed.base * ew })
          }
          cand.sort((a, b) => b.w - a.w || a.id.localeCompare(b.id))
          for (const c of cand.slice(0, t.graphPerSeedL)) {
            strength.set(c.id, (strength.get(c.id) ?? 0) + c.w)
          }
        }
        if (strength.size) {
          // Rank neighbours by accumulated strength → graph reciprocal rank.
          const rankedNbs = [...strength.entries()].sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
          )
          const graphRrf = new Map<string, number>()
          rankedNbs.forEach(([id], i) => graphRrf.set(id, t.wGraph / (t.rrfK + (i + 1))))
          // Neighbours outside the fts ∪ vec pool need a row to surface — fetched
          // WITH class (a class-less hit fails the read-model's post-filter open and
          // could leak agent-memory, #78). A neighbour that no longer resolves
          // (deleted under a stale cache) simply isn't returned → it vanishes.
          const missing = [...graphRrf.keys()].filter((id) => !byPath.has(id))

          if (missing.length) {
            const placeholders = missing.map(() => '?').join(',')
            const rows = await this.sql.all<{
              note_rowid: number
              path: string
              title: string
              class: NoteClass
              note_type: string
              modified_at: string | null
              created_at: string | null
              body_head: string | null
            }>(GRAPH_NEIGHBOR_SQL.replace('?ids', placeholders), missing)

            for (const r of rows) {
              byPath.set(r.path, {
                ...r,
                best_chunk: null,
                fts_rnk: null,
                vec_rnk: null,
                base: 0,
                graph: 0,
              })
            }
          }
          for (const [id, rrf] of graphRrf) {
            const row = byPath.get(id)

            if (row) {
              row.graph = rrf
            }
          }
        }
      } catch (err) {
        console.error('[notarium] graph channel failed — fts+vec only:', err)
      }
    }

    // Real snippets for the lexical hits (best-effort: a snippet failure must not
    // sink the search — body-head covers every hit anyway).
    const snipByRowid = new Map<number, string>()

    try {
      const snips = await this.sql.all<{ note_rowid: number; snip: string | null }>(
        FTS_SNIPPET_SQL,
        [match, pool],
      )

      for (const s of snips) {
        if (s.snip) {
          snipByRowid.set(s.note_rowid, s.snip)
        }
      }
    } catch {
      /* snippets are decorative; the body-head fallback below still applies */
    }

    // The pool/graph union sorted by fused score, then page-cut in JS (the graph
    // channel can pull notes from outside the SQL pool, so the cut can't be in SQL).
    return [...byPath.values()]
      .sort((a, b) => b.base + b.graph - (a.base + a.graph) || a.path.localeCompare(b.path))
      .slice(0, pageSize)
      .map((h) => ({
        title: h.title,
        class: h.class,
        filePath: h.path,
        modifiedAt: h.modified_at,
        createdAt: h.created_at,
        noteType: h.note_type || DEFAULT_NOTE_TYPE,
        type: 'note',
        score: h.base + h.graph,
        // Snippet preference: the FTS matched-fragment for a lexical hit, else the
        // matched CHUNK's text for a vector-only hit (Stage 3 per-chunk snippet), else
        // the body-head as a last resort (a vector-less note, or a graph-only neighbour).
        snippet: toSnippet(snipByRowid.get(h.note_rowid) ?? h.best_chunk ?? h.body_head),
      }))
  }

  /** Embed one query, but give up after EMBED_QUERY_TIMEOUT_MS so a still-cold
   *  model never blocks the request — the caller falls back to FTS (#81 P13). The
   *  in-flight embed keeps running (it warms the model for the next query); only
   *  THIS call abandons it. Returns undefined on timeout, the vector otherwise; a
   *  genuine embed error propagates (the caller logs + degrades). */
  private async embedQuery(queryText: string): Promise<Float32Array | undefined> {
    const embedder = this.embedder

    if (!embedder) {
      return undefined
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), EMBED_QUERY_TIMEOUT_MS)
    })

    try {
      return await Promise.race([
        embedder.embed([queryText], 'query').then((vecs) => vecs[0]),
        timeout,
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  /** The best-available adjacency for the graph channel (#81 Stage 4b). The first
   *  call (no cache) builds synchronously so the very first query has the channel;
   *  afterwards it returns the LAST-GOOD cache immediately and kicks a background
   *  refresh when stale — a full-corpus re-parse (O(corpus): ~90ms loop-block on 2k
   *  light notes, more on a large or dense one) must NOT sit on the per-query path
   *  after every edit. Returns null only while the first build is
   *  in flight or after a build failure (the caller skips the graph channel; fts+vec
   *  stands). */
  private async ensureGraphAdjacency(): Promise<GraphAdjacency | null> {
    if (this.graphCache) {
      // Have a (possibly one-mutation-stale) cache: refresh in the background, serve now.
      if (this.graphDirty && !this.graphBuilding && !this.stopped) {
        this.graphBuilding = this.rebuildGraphAdjacency().finally(() => {
          this.graphBuilding = null
        })
      }

      return this.graphCache
    }
    // First use: build once, synchronously, so the first query gets the channel.
    if (!this.graphBuilding && !this.stopped) {
      this.graphBuilding = this.rebuildGraphAdjacency().finally(() => {
        this.graphBuilding = null
      })
    }
    if (this.graphBuilding) {
      await this.graphBuilding
    }

    return this.graphCache
  }

  /** #100 phase 3: receive the folder path-history hint from the wrapping read-model.
   *  A CHANGE re-marks the graph dirty so the next query rebuilds with the new
   *  aliases (so a path-form `[[oldpath/note]]` resolves after a folder rename).
   *  The read-model re-feeds on EVERY poll; this short-circuits an unchanged list
   *  so a quiet base never re-parses the whole corpus each cycle (the search-graph
   *  cache only invalidates on a real row change otherwise). */
  setFolderAliases(aliases: ReadonlyArray<{ current: string; alias: string }>): void {
    const next = aliases.map((a) => ({ current: a.current, alias: a.alias }))

    if (JSON.stringify(next) === JSON.stringify(this.folderAliases)) {
      return
    }
    this.folderAliases = next
    this.graphDirty = true
  }

  setLinkIdentities(
    identities: ReadonlyArray<{
      id: string
      path: string
      legacyNameAliases?: readonly string[]
    }>,
  ): void {
    const next = new Map(
      identities.map(({ id, path, legacyNameAliases }) => [
        id,
        { path, legacyNameAliases: [...(legacyNameAliases ?? [])] },
      ]),
    )
    const previousAliases = new Map(
      [...this.linkIdentities].flatMap(([id, identity]) =>
        identity.legacyNameAliases.length ? [[id, identity.legacyNameAliases] as const] : [],
      ),
    )
    const nextAliases = new Map(
      [...next].flatMap(([id, identity]) =>
        identity.legacyNameAliases.length ? [[id, identity.legacyNameAliases] as const] : [],
      ),
    )
    const aliasesChanged =
      nextAliases.size !== previousAliases.size ||
      [...nextAliases].some(([id, aliases]) => {
        const previous = previousAliases.get(id)

        return (
          previous == null ||
          previous.length !== aliases.length ||
          previous.some((alias, index) => alias !== aliases[index])
        )
      })

    if (
      this.linkIdentitiesConfigured &&
      next.size === this.linkIdentities.size &&
      [...next].every(([id, identity]) => {
        const previous = this.linkIdentities.get(id)

        return (
          previous?.path === identity.path &&
          previous.legacyNameAliases.length === identity.legacyNameAliases.length &&
          previous.legacyNameAliases.every(
            (alias, index) => alias === identity.legacyNameAliases[index],
          )
        )
      })
    ) {
      return
    }
    this.linkIdentitiesConfigured = true
    this.linkIdentities = next
    this.linkIdentityAliasesByPath = new Map(
      [...next.values()].map(({ path, legacyNameAliases }) => [path, [...legacyNameAliases]]),
    )
    if (aliasesChanged) {
      this.graphCache = null
      this.linkCompatibilityGeneration++
    }
    this.graphDirty = true
  }

  private linkMeta(meta: NoteMeta): NoteMeta {
    const legacyNameAliases = this.linkIdentityAliasesByPath.get(meta.filePath)

    return legacyNameAliases?.length ? { ...meta, legacyNameAliases: [...legacyNameAliases] } : meta
  }

  /** Register exact id addresses onto a path-keyed bare-engine link index. Once an
   *  identity owner feeds the authoritative registry, raw copied frontmatter claims
   *  are no longer allowed to compete with it. */
  private registerLinkIdentities(
    index: ReturnType<typeof buildLinkIndex>,
    rows: ReadonlyArray<Pick<NoteRow, 'path' | 'id_claim'>>,
  ): void {
    if (this.linkIdentitiesConfigured) {
      const admittedPaths = new Set(rows.map((row) => row.path))

      for (const [id, { path }] of this.linkIdentities) {
        // `rows` is the caller's resolver population. graph() deliberately passes
        // only graph-visible rows; admitting a hidden authoritative id here would
        // resolve the edge to a private path and lose its non-creatable ghost.
        if (admittedPaths.has(path)) {
          registerLinkIdentity(index, id, path)
        }
      }

      return
    }
    for (const row of rows) {
      if (row.id_claim) {
        registerLinkIdentity(index, row.id_claim, row.path)
      }
    }
  }

  /** Rebuild the undirected wikilink adjacency from the current note set, reusing the
   *  SAME core derivation graph() uses (one parser, one ghost algebra — slug/rename/
   *  ghost resolution stays canonical, not reimplemented in SQL). Node ids are storage
   *  paths; edges to unresolved (ghost) targets are dropped — a graph neighbour must
   *  resolve to a real, fetchable, class-bearing note. Degree = undirected
   *  real-neighbour count (the hub blacklist is derived from it per query — see
   *  computeHubs). `graphDirty` is cleared BEFORE the await so a mutation during the
   *  rebuild re-marks it and the next ensureGraphAdjacency refreshes again (the
   *  just-built cache may be one mutation stale, healed next cycle). */
  private async rebuildGraphAdjacency(): Promise<void> {
    const compatibilityGeneration = this.linkCompatibilityGeneration

    this.graphDirty = false
    try {
      const rows = await this.sql.all<{
        path: string
        title: string
        class: NoteClass
        id_claim: string | null
        aliases: string
        slug: string | null
        body: string
      }>(
        // ORDER BY path: a deterministic row order so the buildLinkIndex collision
        // tie-break (two live notes sharing a slugified name) is stable run-to-run
        // and matches list()/changes() — an unordered SELECT let the boot graph and a
        // read-refresh disagree on which same-named note an edge points at (#100).
        `SELECT path, title, class, id_claim, aliases, slug, body FROM notes ORDER BY path`,
      )
      const graphRows = rows.filter((row) => isVisibleOn(SURFACE.graph, row.class))
      const metas = graphRows.map((r) =>
        this.linkMeta(
          this.metaOf({
            path: r.path,
            title: r.title,
            class: r.class,
            aliases: r.aliases,
            slug: r.slug,
            modified_at: null,
            created_at: null,
          }),
        ),
      )
      const currentFolders = await this.mountForClass(undefined).files.listDirs()
      const index = buildLinkIndex(metas, this.folderAliases, undefined, currentFolders)

      this.registerLinkIdentities(index, graphRows)
      const realIds = new Set(graphRows.map((r) => r.path))
      const adj = new Map<string, Set<string>>()

      const link = (a: string, b: string): void => {
        let s = adj.get(a)

        if (!s) {
          s = new Set<string>()
          adj.set(a, s)
        }
        s.add(b)
      }
      // Same cooperative fairness break as graph() (#222): this re-parses every body
      // in a tight synchronous loop (O(corpus); measured ~90ms loop-block on 2k light
      // notes, more on a large or dense one), and it runs on the search read path —
      // first query awaits it, and any edit kicks a background
      // rebuild — so left ungated it monopolizes the shared loop and starves every other
      // space. `graphDirty` was cleared before the await, so yielding here is safe: a
      // mutation mid-rebuild re-marks it and the next ensureGraphAdjacency refreshes.
      const coopYield = this.coopYielder()

      for (const row of graphRows) {
        const { edges } = deriveNoteEdges(row.path, row.body, index, this.relationType)

        for (const e of edges) {
          if (!realIds.has(e.target)) {
            continue
          } // ghost / unresolved → not a real neighbour
          link(e.source, e.target)
          link(e.target, e.source) // undirected
        }
        await coopYield()
      }
      const degree = new Map<string, number>()

      for (const [id, nbs] of adj) {
        degree.set(id, nbs.size)
      }
      if (compatibilityGeneration !== this.linkCompatibilityGeneration) {
        this.graphDirty = true
        return
      }
      this.graphCache = { adj, degree, total: realIds.size }
    } catch (err) {
      console.error('[notarium] graph adjacency rebuild failed:', err)
      this.graphDirty = true // leave it dirty so the next query retries
    }
  }

  /** Boot-time graph through the SAME derivation the read-model patches with
   *  (`core/referenceResolver` for the resolve index, `core/graph` for the edge
   *  derivation — one parser, one ghost algebra, #55 settled): node ids are
   *  storage paths (bare engine), unresolved targets become ghosts. */
  async graph(): Promise<Graph> {
    await this.ensureReady()
    // Meta + body only (#222): graph() is the one read path that genuinely needs
    // bodies (wikilink derivation), but not the vector/hash/mtime columns `SELECT *`
    // dragged along.
    const rows = await this.sql.all<NoteMetaRow & { body: string }>(
      `SELECT ${NOTE_META_COLS}, body FROM notes ORDER BY path`,
    )
    const metas = rows.map((r) => this.linkMeta(this.metaOf(r)))
    const graphRows = rows.filter((row) => isVisibleOn(SURFACE.graph, row.class))
    const graphMetas = graphRows.map((row) => this.linkMeta(this.metaOf(row)))
    // A provenance map (#100 phase 5) so each edge records HOW its [[wikilink]] resolved
    // (current name / custom slug / former note name / former folder path). It rides
    // the FRESH derivation only; the read-model's incremental cache never gets it.
    const provenance = new Map<string, ResolvedVia>()
    const currentFolders = await this.mountForClass(undefined).files.listDirs()
    const index = buildLinkIndex(graphMetas, this.folderAliases, provenance, currentFolders)

    this.registerLinkIdentities(index, graphRows)
    const edgesBySource = new Map<string, GraphLink[]>()
    const ghosts = new Map<string, GhostStub>()
    // Cooperative fairness break (#222): deriving edges re-parses every note body for
    // wikilinks — a heavy synchronous pass (bootScan runs it on every open; its search-
    // channel twin rebuildGraphAdjacency() gets the same break). Yield every ~8ms so it
    // can't monopolize the shared loop.
    const coopYield = this.coopYielder()

    for (const row of graphRows) {
      const { edges, ghosts: stubs } = deriveNoteEdges(
        row.path,
        row.body,
        index,
        this.relationType,
        provenance,
      )

      if (edges.length) {
        edgesBySource.set(row.path, edges)
      }
      for (const g of stubs) {
        if (!ghosts.has(g.id)) {
          ghosts.set(g.id, g)
        }
      }
      await coopYield()
    }

    return shapeGraph(metas, edgesBySource, ghosts)
  }

  /** Read-only grooming health (#100 phase 5): folds the FRESH graph (whose links carry
   *  `resolvedVia`) into the count of links resolving through a former name + the
   *  broken (ghost) links. The bare engine has no visibility scope — the read-model
   *  decorator filters hidden classes before aggregating. */
  async graphHealth(): Promise<GraphHealth> {
    return aggregateGraphHealth(await this.graph())
  }

  // ── mutations ───────────────────────────────────────────────────────────────

  /** Create or update; with originalId — rename-in-place (#8) only when the title,
   *  folder or explicit fileName changes; a content save preserves the current path.
   *  Frontmatter is
   *  merged, never regenerated (the notarium-id claim and foreign keys
   *  survive); the id parameter is the identity materialization channel.
   *  The destination MOUNT is chosen by `targetClass` on create (default
   *  user-doc); on edit it stays in the note's existing mount — class doesn't
   *  change under an edit (#78). */
  async write({
    title,
    content = '',
    directory,
    noteType,
    tags,
    slug,
    summary,
    muted,
    originalId,
    identityOnly,
    id,
    targetClass,
    ifExists,
    fileName,
    legacyImportRoot,
    createdAt,
    frontmatter,
    frontmatterMode,
    preservePath,
    preserveAliases,
    restorePath,
    expectedSource,
    expectedDestinationId,
    sourceLocator,
  }: WriteInput): Promise<WriteResult> {
    await this.ensureReady()
    const scalarInputs = [
      title,
      directory,
      noteType,
      slug,
      summary,
      fileName,
      createdAt,
      sourceLocator,
    ]
    const tagInputs = Array.isArray(tags) ? tags : tags != null ? [tags] : []

    if (
      scalarInputs.some((value) => value != null && !isDurableScalar(value)) ||
      tagInputs.some((value) => !isDurableScalar(value)) ||
      !isDurableText(content) ||
      !isDurableFrontmatter(frontmatter) ||
      (restorePath != null &&
        (!isDurableText(restorePath) ||
          !isCanonicalInternalRelativeAddress(restorePath) ||
          !restorePath.endsWith('.md'))) ||
      (id != null && !isValidNoteId(id)) ||
      (originalId != null &&
        !isValidNoteId(originalId) &&
        decodeWikilinkIdentity(originalId) == null) ||
      (sourceLocator != null && !isImportNoteSourceLocator(sourceLocator))
    ) {
      throw writeFailed('input contains an invalid durable string')
    }
    let sourceRow: NoteRow | undefined

    if (originalId) {
      const row = await this.resolveRow(originalId, identityOnly)

      // A dead reference falls through to a plain create at the destination —
      // a bare engine's behaviour; the CAS layer above is what turns
      // "edited a deleted note" into an honest 404 before it gets here.
      if (row) {
        sourceRow = row
      }
    }
    // Edit keeps the note in its current mount; create picks by targetClass.
    const mount = sourceRow ? this.mountForPath(sourceRow.path) : this.mountForClass(targetClass)
    const restoreRel = restorePath ? this.relIn(mount, restorePath) : undefined

    if (
      restorePath &&
      (this.fullIn(mount, restoreRel!) !== restorePath ||
        !isCanonicalInternalRelativeAddress(restoreRel!) ||
        !restoreRel!.endsWith('.md'))
    ) {
      throw writeFailed('restore path is outside the writable mount')
    }
    // `directory` is MOUNT-relative (a category within the mount); fullIn
    // prepends the mount prefix exactly once, so a note in a prefixed mount
    // (agent-memory) never double-prefixes. On an EDIT with no directory given
    // (the restore path passes none) keep the note in its CURRENT folder — the
    // source's mount-relative dir — rather than moving it to the mount root (#78).
    const dir =
      restoreRel != null
        ? directoryOf(restoreRel)
        : (directory ?? (sourceRow ? directoryOf(this.relIn(mount, sourceRow.path)) : ''))
    // What the destination's own ancestry looks like on the medium — asked once,
    // for both fences below. This used to be a full recursive `listDirs()` of the
    // whole mount on EVERY write: O(tree) per note, which is O(N²) over an import
    // and the reason a 10 000-note archive never finished.
    // canon: docs/import.md#importing-a-markdown-tree-302
    const existingDirs = await this.destinationDirSpellings(mount, dir, legacyImportRoot)

    const validDirectory =
      legacyImportRoot !== undefined
        ? !sourceRow &&
          Boolean(fileName) &&
          isLegacyImportDestination(dir, legacyImportRoot, (prefix) => existingDirs.has(prefix))
        : isPortableRelativeDestination(dir, (prefix) => existingDirs.has(prefix))

    if (!validDirectory) {
      throw writeFailed('directory must be safe with portable new components')
    }
    await this.assertDirectorySpelling(mount, dir, existingDirs)
    // fileName overrides slug(title) on a CREATE (import #11) and is honoured on an
    // EDIT as explicit storage intent. A save with no title/folder/fileName change
    // preserves the current basename below, including seeded/imported files.
    // Folder-page edits stay pinned to the reserved `index.md` basename.
    const sourceRel = sourceRow ? this.relIn(mount, sourceRow.path) : ''
    const preservedFileName =
      sourceRow && isFolderPageNote(sourceRel) ? FOLDER_PAGE_BASENAME : fileName
    // The id joins the name formula as its LAST rung: a title with no sluggable
    // character at all (emoji only) names its file after the NOTE instead of writing
    // the dot-file `.md` (#296). An edit keeps the note's own id; a create takes the
    // one the read-model settled. A BARE engine has no registry above it, so it mints
    // its own here — otherwise every such note would pile onto `note.md` and the
    // second create would be refused as a duplicate. Minted only in that case, so an
    // ordinary bare create still writes no `notarium-id` it did not ask for; and the
    // id MUST reach the file, or the next rename would mint a different one and the
    // note would walk from name to name.
    const mintedNameId =
      !sourceRow && !id && !sluggedNoteName(title, preservedFileName) ? freshNoteId() : undefined
    const noteId = id ?? mintedNameId
    // A save with the same title and effective directory carries no move intent.
    // Preserve the current basename verbatim — especially a recovered legacy `.md`
    // or deterministic importer pin. This also keeps an ordinary content save away
    // from the overwrite-capable rename path; only an explicit title/folder/fileName
    // change may move storage.
    const preserveCurrentPath =
      sourceRow != null &&
      (preservePath ||
        (mount.class === 'skill' && isSkillPackageRootPath(sourceRel)) ||
        (title === sourceRow.title && fileName == null && dir === directoryOf(sourceRel)))
    // The id the READ-MODEL settled comes first, and the file's own claim is only the
    // fallback: the mutation fence (`WriteEngine.predictedPath`) predicts with that same
    // settled id, so reading the claim first would let the two disagree about the
    // destination whenever a file carries an id the registry has re-keyed away from.
    const dest = restorePath
      ? restorePath
      : preserveCurrentPath
        ? sourceRow!.path
        : this.fullIn(
            mount,
            noteFilePath(
              title,
              dir,
              preservedFileName,
              noteId ?? sourceRow?.id_claim ?? undefined,
              legacyImportRoot !== undefined,
            ),
          )

    // Class integrity (#78): the dest MUST live in the mount we resolved. A
    // stray directory like '.notarium/memory' on a user-doc write would otherwise
    // route into the agent-mount's namespace (agent-memory poisoning) — the
    // shared physical root makes the file land there and reindexPath would
    // reclassify it. The host rejects dot-dirs too (safeRelPath); this is the
    // engine's own belt, since a class invariant must not rest on the caller (P8).
    if (this.mountForPath(dest) !== mount) {
      throw writeFailed('directory is outside the writable mount')
    }
    const sourcePath = sourceRow?.path
    const renameSource = sourcePath && sourcePath !== dest ? sourcePath : undefined

    if (renameSource) {
      // Rename-in-place must never silently swallow a different note that
      // already lives at the destination (P3: no silent data loss).
      const occupied = await this.sql.get<{ path: string }>(
        `SELECT path FROM notes WHERE path = ?`,
        [dest],
      )

      if (occupied) {
        throw moveFailed('a note already lives at the destination')
      }
    }
    const destRel = this.relIn(mount, dest)
    const guarded = expectedDestinationId !== undefined

    if (guarded && renameSource) {
      // A planned import write never moves an existing note: it creates one, or
      // refreshes the one already at its destination. Refusing the combination
      // keeps the guard's single-destination reasoning true by construction
      // rather than by assumption.
      throw writeFailed('a planned destination write cannot also rename a note')
    }
    // The guard judges DISK, inside the same operation that publishes and against
    // the very bytes the compare-and-swap will replace — ONE observation, one
    // truth. A caller-side check would prove nothing (the note it inspected can be
    // replaced in between), and a second independent read here would be a second
    // truth to keep in sync — including the authority's claim, which is what the
    // publish compares against. canon: docs/import.md#importing-a-markdown-tree-302
    let mutationObservation: ResourceObservation | undefined
    let targetObservation: ResourceObservation | undefined

    if (guarded && this.resourceAuthority) {
      mutationObservation = await this.resourceAuthority.observe(dest, {
        owner: 'notarium-write-plan',
      })
      if (mutationObservation.kind === 'unavailable') {
        throw writeFailed('note is not stably readable during write')
      }
      if (mutationObservation.kind === 'occupied') {
        // `occupied` is a CONTRADICTION, not a silence: a directory, a symlink or a
        // FIFO owns this pathname, and none of them is a note whose identity could
        // ever match the plan's. Folding it into the `absent` branch below made the
        // guard answer "the path is free" two lines above the collision policy
        // answering "the path is taken" — one engine, two answers about one path,
        // and the weaker one is the one that reached the caller (a skip under
        // `skipExisting`, a clobbered symlink under `overwrite`).
        // canon: docs/import.md#importing-a-markdown-tree-302
        throw destinationOwnerConflict(
          dest,
          `is held by a ${mutationObservation.entryType}, which is not a note`,
        )
      }
    }
    const guardedRaw = guarded
      ? mutationObservation
        ? mutationObservation.kind === 'present'
          ? NOTE_TEXT_UTF8.decode(mutationObservation.bytes)
          : null
        : await mount.files.read(destRel)
      : null

    if (guarded) {
      // Who this medium can SEE holding the destination — a FILE, since anything
      // that is not one was already refused above. A file states its owner in its
      // own frontmatter and nowhere else, so a file without that claim states
      // NOTHING — it is not the expected note and it is not a stranger either.
      // (An identity-keyed engine has no such state: every note it holds carries an
      // id, so its `occupantId` is always an answer. That is the whole difference
      // between the two engines here — the rule below is one rule.)
      const occupantId =
        guardedRaw == null ? null : frontmatterValue(guardedRaw, NOTE_ID_FRONTMATTER_KEY) || null

      if (expectedDestinationId === null) {
        // The plan expected a free path. An occupant carrying the planned id is
        // this very plan replaying after a crash — converge. Anything else is a
        // note that appeared after the plan was made, and overwriting it would
        // take its identity away.
        if (guardedRaw != null && occupantId !== (noteId ?? null)) {
          throw destinationOwnerConflict(
            dest,
            occupantId
              ? `is owned by ${occupantId}; the import planned to create it`
              : 'was created by someone else since the import was planned',
          )
        }
      } else if (guardedRaw == null) {
        throw destinationOwnerConflict(dest, 'no longer exists')
      } else if (occupantId !== null && occupantId !== expectedDestinationId) {
        // Refuse on a CONTRADICTION, not on a silence. A vault imported before
        // identities were written is full of unclaimed files, and a claim-less file
        // is the ordinary state of the note the read-model's registry maps this path
        // to — refusing there would fail every overwrite into such a vault. The
        // physical swap below still fences the bytes changing under this write; what
        // no engine can supply from a claim-less file is WHOSE note it is, and the
        // layer that knows (the read-model, which owns the path→id registry) has
        // already checked. A bare engine with no such layer above it therefore has
        // exactly one guard here, and this is its honest reach.
        // canon: docs/import.md#importing-a-markdown-tree-302
        throw destinationOwnerConflict(
          dest,
          `is owned by ${occupantId}, not ${expectedDestinationId}`,
        )
      }
    }
    const createWithoutOverwrite = ifExists !== IF_EXISTS.overwrite && !sourceRow

    // Create-collision policy: refuse unless the caller explicitly asked to
    // clobber — the rename guard above only fences RENAMES, so this is what keeps a
    // create from replacing a stranger's body. Disk truth (existingRaw) catches an
    // unindexed external file the index never saw.
    // canon: docs/note-model.md#create-collisions
    // Check pathname occupancy BEFORE reading it: a symlink/FIFO/device is already
    // a conclusive refusal and must never be followed or blocked on merely to learn
    // that it is occupied. writeIfAbsent below remains the final race arbiter.
    if (createWithoutOverwrite && (await mount.files.exists(destRel))) {
      throw noteAlreadyExists(title)
    }
    if (this.resourceAuthority && !mutationObservation) {
      mutationObservation = await this.resourceAuthority.observe(renameSource ?? dest, {
        owner: 'notarium-write-plan',
      })
      if (mutationObservation.kind === 'unavailable') {
        throw writeFailed('note is not stably readable during write')
      }
      if (renameSource) {
        targetObservation = await this.resourceAuthority.observe(dest, {
          owner: 'notarium-write-target',
        })
        if (targetObservation.kind !== 'absent') {
          throw moveFailed('a note already lives at the destination')
        }
      }
    }
    if (expectedSource) {
      if (!sourceRow || mutationObservation?.kind !== 'present') {
        throw writeFailed('note changed during write')
      }
      const expectedClaim = observedFileClaim(expectedSource, mutationObservation)
      const observedOwner = exactOwnerObservation(mutationObservation.bytes)

      if (
        !expectedClaim ||
        !sameFileClaim(expectedClaim, mutationObservation.claim) ||
        !sameOwnerObservation(expectedSource.owner, observedOwner)
      ) {
        throw writeFailed('note changed during write')
      }
    }
    const existingSource = mutationObservation
      ? mutationObservation.kind === 'present'
        ? mutationObservation.bytes
        : null
      : undefined
    const existingRaw = guarded
      ? guardedRaw
      : existingSource !== undefined
        ? existingSource == null
          ? null
          : NOTE_TEXT_UTF8.decode(existingSource)
        : await mount.files.read(renameSource ? sourceRel : destRel)

    if (createWithoutOverwrite && existingRaw != null) {
      throw noteAlreadyExists(title)
    }
    if (sourceRow) {
      if (existingRaw == null) {
        throw writeFailed('note changed during write')
      }
      const indexedHash = await this.verifiedIndexedSourceHash(sourceRow, existingRaw)

      // The index version read by resolveRow is the CAS baseline. Reading the
      // filesystem later must not silently adopt an external replacement as the
      // bytes our edit is allowed to replace.
      if (!indexedHash || (await sha256Hex(existingRaw)) !== indexedHash) {
        throw writeFailed('note changed during write')
      }
    }
    const priorOwnerProof =
      sourceRow && existingRaw != null
        ? await this.ownerProofFor(
            sourceRow.path,
            existingSource ?? new TextEncoder().encode(existingRaw),
          )
        : undefined
    // The slug to persist (#100 phase 1, lazy): cleaned + kept only when it diverges
    // from slug(title). undefined = not addressed (slug stays as the file has it),
    // '' = clear back to the implicit default, a value = a custom slug.
    const slugChannel = storedSlug(slug, title)
    // The slug the note WILL carry after this write — to detect a slug rename for
    // the alias-history below. undefined channel keeps the source's stored slug.
    const finalSlug = slugChannel === undefined ? (sourceRow?.slug ?? null) : slugChannel || null
    // Alias-history (#100): renaming a note (its title OR its slug changed)
    // records the OLD names as aliases on the note ITSELF, so inbound [[Old Name]]
    // / [[old-slug]] keep resolving — we never touch the linking notes' bodies.
    // nextAliasesMulti dedups and drops the now-current names (A→B→A leaves no
    // stale self-alias). On a non-rename write `undefined` leaves the file's
    // `aliases:` block untouched. Names are compared by EFFECTIVE slug (custom or
    // title-derived), so a title rename with no custom slug retires the old title
    // exactly as phase 0 did (the old slug-form dedups against the old-title alias).
    const prevEffSlug = sourceRow ? effectiveSlug(sourceRow.slug, sourceRow.title) : undefined
    const newEffSlug = effectiveSlug(finalSlug, title)
    const aliases =
      frontmatterMode !== 'replace' &&
      !preserveAliases &&
      sourceRow &&
      (sourceRow.title !== title || prevEffSlug !== newEffSlug)
        ? nextAliasesMulti(
            parseJsonArray(sourceRow.aliases),
            [sourceRow.title, prevEffSlug!],
            [title, newEffSlug],
          )
        : undefined
    const bytes = serializeNoteFile({
      title,
      noteType,
      tags: normTags(tags),
      aliases,
      slug: slugChannel,
      summary,
      muted,
      id: noteId,
      sourceLocator,
      createdAt,
      frontmatter,
      frontmatterMode,
      body: content,
      existingRaw,
    })

    const candidateSource = new TextEncoder().encode(bytes)
    const candidateSkillRoot =
      mount.class === 'skill' && isSkillPackageRootPath(this.relIn(mount, dest))

    if (candidateSkillRoot) {
      const packagePath = skillPackagePathOf(this.relIn(mount, dest))!
      const candidateState = analyzeDocumentState({
        source: candidateSource,
        role: DOCUMENT_ROLE.skillRoot,
        skillDirectoryName: basenameOf(packagePath),
      })

      if (candidateState.format !== DOCUMENT_STATE_FORMAT.skill) {
        throw writeFailed('invalid Agent Skill manifest')
      }
    }
    let mutationReceipt: MutationReceipt | undefined

    if (this.resourceAuthority) {
      if (!mutationObservation || mutationObservation.kind === 'unavailable') {
        throw writeFailed('storage did not provide a mutation observation')
      }
      const packagePath = this.packagePathFor(mount, renameSource ? sourceRel : destRel)
      const placementLease = candidateSkillRoot
        ? await this.resourceAuthority.admitSkillPlacement(
            dest,
            'exclusive',
            'notarium-skill-write',
          )
        : null
      let publication

      try {
        if (placementLease) {
          try {
            await this.resourceAuthority.assertSkillManifestNameAvailableAdmitted(
              dest,
              candidateSource,
            )
          } catch (error) {
            if ((error as { code?: string }).code === 'SKILL_NAME_CONFLICT') {
              const state = analyzeDocumentState({
                source: candidateSource,
                role: DOCUMENT_ROLE.skillRoot,
                skillDirectoryName: basenameOf(skillPackagePathOf(destRel)!),
              })
              throw skillNameConflict(state.projection?.skill?.name ?? title)
            }
            throw error
          }
        }
        const publish = placementLease
          ? this.resourceAuthority.publishAdmitted.bind(this.resourceAuthority)
          : (request: Parameters<SpaceResourceAuthority['publish']>[0]) =>
              this.resourceAuthority!.publish(request, { owner: 'notarium-write' })
        publication = renameSource
          ? mutationObservation.kind === 'present' && targetObservation?.kind === 'absent'
            ? await publish({
                kind: 'move-put',
                sourcePath: renameSource,
                targetPath: dest,
                content: candidateSource,
                expectedSource: mutationObservation.claim,
                expectedTarget: targetObservation.claim,
                ...(packagePath ? { packagePath } : {}),
              })
            : ({ status: 'conflict' } as const)
          : await publish({
              kind: 'put',
              path: dest,
              content: candidateSource,
              expected: mutationObservation.claim,
              ...(packagePath ? { packagePath } : {}),
            })
      } finally {
        placementLease?.settle()
      }

      if (publication.status === 'conflict') {
        if (renameSource) {
          throw moveFailed('source or destination changed during write')
        }
        if (guarded && expectedDestinationId === null && guardedRaw == null) {
          // The guard PROVED this destination free, in this same operation, and the
          // swap it just lost was one that publishes only into an absent pathname.
          // So the loser here is not our own bytes moving under us — something was
          // CREATED at a path the plan owns, between the observation and the
          // publication. That newcomer is a stranger by construction (our own replay
          // would have been the occupant the guard converged on above), which is
          // exactly what the plan's caller must hear: `note_already_exists` here made
          // a `skipExisting` import count a note it never wrote as skipped.
          throw destinationOwnerConflict(
            dest,
            'was created by someone else since the import was planned',
          )
        }
        if (!sourceRow && createWithoutOverwrite) {
          throw noteAlreadyExists(title)
        }
        // Deliberately NOT a destination-owner conflict, even for a planned write.
        // The owner was proved above and matched; what this swap compares is BYTES,
        // so losing it means the expected note's content moved under us, not that the
        // path changed hands. Calling it an owner conflict made an import that had
        // written 9 999 notes end terminally because the 10 000th raced one edit.
        throw writeFailed('note changed during write')
      }
      mutationReceipt = publication.receipt
    } else if (renameSource) {
      if (!mount.files.replaceIfAbsent) {
        throw moveFailed('storage cannot publish a renamed note without replacing a race')
      }
      if (!(await mount.files.replaceIfAbsent(sourceRel, destRel, existingRaw!, bytes))) {
        throw moveFailed('a note already lives at the destination')
      }
    } else if (sourceRow) {
      if (!mount.files.replaceIfAbsent) {
        throw writeFailed('storage cannot update a note without replacing a race')
      }
      if (!(await mount.files.replaceIfAbsent(sourceRel, destRel, existingRaw!, bytes))) {
        throw writeFailed('note changed during write')
      }
    } else if (createWithoutOverwrite) {
      if (!mount.files.writeIfAbsent) {
        throw writeFailed('storage cannot create a note without replacing a race')
      }
      if (!(await mount.files.writeIfAbsent(destRel, bytes))) {
        // Same reading as the authority's lost swap above: a plan that proved this
        // path free and then lost the no-clobber create lost it to a newcomer.
        if (guarded && expectedDestinationId === null && guardedRaw == null) {
          throw destinationOwnerConflict(
            dest,
            'was created by someone else since the import was planned',
          )
        }
        throw noteAlreadyExists(title)
      }
    } else if (guarded) {
      // A guarded write NEVER publishes with a plain overwrite, even though the
      // caller asked for one: the bytes verified above are the compare baseline,
      // so anything that changed the destination in between loses the swap
      // instead of being silently replaced.
      //
      // Unreachable wherever a resource authority is configured — which is every
      // deployment — because the authority publishes above. It stays because the
      // branch it guards against is the one below: without it a guarded write on an
      // authority-less engine would fall through to a plain overwrite, which is
      // precisely the publish this channel exists to forbid.
      if (!mount.files.writeIfAbsent || !mount.files.replaceIfAbsent) {
        throw writeFailed('storage cannot publish a planned write without replacing a race')
      }
      const published =
        guardedRaw == null
          ? await mount.files.writeIfAbsent(destRel, bytes)
          : await mount.files.replaceIfAbsent(destRel, destRel, guardedRaw, bytes)

      if (!published) {
        throw destinationOwnerConflict(dest, 'changed while the planned write was publishing')
      }
    } else {
      await mount.files.write(destRel, bytes)
    }
    const ownerShapes = new Map<StorageOwnerKey, 'value' | 'entry'>()

    for (const claim of priorOwnerProof?.claims ?? []) {
      const before = ownerValue(existingRaw, claim.key)
      const after = ownerValue(bytes, claim.key)

      if (before != null && before === after) {
        ownerShapes.set(claim.key, claim.ownership)
      }
    }
    if (noteId && ownerValue(bytes, STORAGE_OWNER_KEY.id) === noteId) {
      ownerShapes.set(
        STORAGE_OWNER_KEY.id,
        ownerValue(existingRaw, STORAGE_OWNER_KEY.id) == null ? 'entry' : 'value',
      )
    }
    if (createdAt && ownerValue(bytes, STORAGE_OWNER_KEY.created) != null) {
      ownerShapes.set(
        STORAGE_OWNER_KEY.created,
        ownerValue(existingRaw, STORAGE_OWNER_KEY.created) == null ? 'entry' : 'value',
      )
    }
    const ownerProof = mutationReceipt
      ? bindStorageOwnerProof({
          source: candidateSource,
          owners: [...ownerShapes].map(([key, ownership]) => ({ key, ownership })),
          evidence: { kind: 'mutation-receipt', id: mutationReceipt.id },
          generatedContainer:
            ownerShapes.size > 0 && parseFrontmatterBlock(existingRaw ?? '') == null,
        })
      : { version: 1 as const, claims: [] }

    if (renameSource) {
      await this.sql.run(`DELETE FROM notes WHERE path = ? AND seq = ?`, [
        renameSource,
        sourceRow!.seq,
      ])
    }
    if (mutationReceipt) {
      await this.reindexPublishedPath(dest, candidateSource, mutationReceipt, ownerProof)
    } else {
      await this.reindexPath(dest)
    }
    const writtenFileName = basenameOf(dest)
    const writtenPackagePath = this.packagePathFor(mount, this.relIn(mount, dest))
    const writtenSkillRoot =
      mount.class === 'skill' && isSkillPackageRootPath(this.relIn(mount, dest))
    const role =
      mount.class === 'skill'
        ? writtenSkillRoot
          ? DOCUMENT_ROLE.skillRoot
          : DOCUMENT_ROLE.skillAuxiliary
        : DOCUMENT_ROLE.generic
    const writtenState = analyzeDocumentState({
      source: candidateSource,
      role,
      ownerProof,
      pathFallbackTitle: writtenFileName.replace(/\.md$/i, ''),
      ...(role === DOCUMENT_ROLE.skillRoot
        ? { skillDirectoryName: basenameOf(writtenPackagePath!) }
        : {}),
    })
    // An auxiliary role exists only while a same-claim valid direct SKILL.md is
    // present. Publication proves the helper bytes, not that linked package
    // predicate, so shape this write result through the exact read classifier.
    // The receipt remains the physical ownership proof used by compensation.
    const writtenVersionToken =
      role === DOCUMENT_ROLE.skillAuxiliary
        ? (await this.read(dest, { storageOnly: true })).versionToken
        : documentStateVersionToken(writtenState)
    // The authoritative class (the mount we landed in) — lets the read-model
    // stamp the snapshot without optimistically guessing (#78).
    return {
      id: noteId,
      filePath: dest,
      class: mount.class,
      versionToken: writtenVersionToken,
      ...(mutationReceipt
        ? {
            physicalWriteClaim: {
              kind: 'resource-publication-v1',
              value: `${mutationReceipt.adapterId}:${mutationReceipt.transitions.find(({ path }) => path === dest)?.after.value ?? ''}`,
            },
          }
        : {}),
      ...(mutationReceipt ? { result: { mutationReceipt } } : {}),
    }
  }

  /** Move a note (id channel) or a whole folder (path channel, isDirectory).
   *  Same failure surface as every engine: "# Move Failed" as a tool error.
   *  Moves stay within a mount (no cross-mount/class change in v1). */
  async move({
    id,
    destinationPath,
    isDirectory = false,
    identityOnly,
    expectedSource,
  }: MoveInput): Promise<MoveResult> {
    await this.ensureReady()
    if (
      (!isDirectory && !isValidNoteId(id) && decodeWikilinkIdentity(id) == null) ||
      !isDurableScalar(destinationPath) ||
      (isDirectory && !isCanonicalSafeRelativeAddress(id))
    ) {
      throw moveFailed('path or identity contains an invalid durable string')
    }
    this.invalidateGraphCache() // a rename shifts node ids in the wikilink graph (#81 Stage 4b)
    if (isDirectory) {
      const src = id.replace(/^\/+|\/+$/g, '')
      const dest = destinationPath.replace(/^\/+|\/+$/g, '')

      if (!src || !dest) {
        throw moveFailed('a folder path is required')
      }
      if (dest === src || dest.startsWith(`${src}/`)) {
        throw moveFailed('cannot move a folder into itself')
      }
      const mount = this.mountForPath(src)
      const existingDirs = new Set(await mount.files.listDirs())

      if (
        !isPortableMoveDestination(destinationPath, src, (prefix) =>
          existingDirs.has(this.relIn(mount, prefix)),
        )
      ) {
        throw moveFailed('destination must be safe with portable new components')
      }

      if (this.mountForPath(dest) !== mount) {
        throw moveFailed('cannot move a folder across mounts')
      }
      if (!(await mount.files.listDirs()).includes(this.relIn(mount, src))) {
        throw moveFailed('folder source spelling does not match storage')
      }
      const sourcePrefix = `${src}/`
      const destinationPrefix = `${dest}/`
      const rows = await this.sql.all<Pick<NoteRow, 'path'>>(
        `SELECT path FROM notes
         WHERE path = ? COLLATE BINARY
            OR substr(path, 1, length(?)) = ? COLLATE BINARY`,
        [src, sourcePrefix, sourcePrefix],
      )
      const occupied = await this.sql.get<{ path: string }>(
        `SELECT path FROM notes
         WHERE substr(path, 1, length(?)) = ? COLLATE BINARY
         LIMIT 1`,
        [destinationPrefix, destinationPrefix],
      )
      const sourceRel = this.relIn(mount, src)
      const destinationRel = this.relIn(mount, dest)
      const destinationOnDisk = await mount.files.dirExists(destinationRel)
      const sameSourceDirectory =
        destinationOnDisk && mount.files.sameEntry
          ? await mount.files.sameEntry(sourceRel, destinationRel)
          : false

      // On an insensitive medium a non-existent descendant spelling can still
      // have the source directory as an existing ancestor (`Docs` → `docs/sub`).
      // Refuse that actual self-move while still permitting direct `Docs` → `docs`.
      if (mount.files.sameEntry) {
        for (let parent = directoryOf(destinationRel); parent; parent = directoryOf(parent)) {
          if (await mount.files.sameEntry(sourceRel, parent)) {
            throw moveFailed('cannot move a folder into itself')
          }
        }
      }
      await this.assertDirectorySpelling(mount, directoryOf(destinationRel))

      // Occupancy is the on-disk truth, not just the index (#97): an EMPTY folder
      // at dest carries no notes but renameDir would still clobber it. The one
      // exception is an alternate case/NFC spelling of the source entry itself.
      if (occupied || (destinationOnDisk && !sameSourceDirectory)) {
        throw moveFailed('destination folder is occupied')
      }

      // #97: a folder with no INDEXED notes (an empty project — only a
      // `.notariummeta` marker — or a freshly-created "New folder") is still a
      // real folder if it exists on disk. Ask the directory channel, not the
      // index: present ⇒ renameDir the whole subtree (the marker travels with the
      // fs.rename); absent ⇒ genuinely not found. `rows` may be empty here.
      if (!rows.length && !(await mount.files.dirExists(this.relIn(mount, src)))) {
        throw moveFailed('folder not found')
      }
      if (!mount.files.renameDirIfAbsent) {
        throw moveFailed('storage cannot move a folder without replacing a race')
      }
      if (!(await mount.files.renameDirIfAbsent(sourceRel, destinationRel))) {
        throw moveFailed('destination folder is occupied')
      }
      for (const r of rows) {
        const next = dest + r.path.slice(src.length)
        await this.publishWithSeq((seq) =>
          this.sql.run(`UPDATE notes SET path = ?, seq = ? WHERE path = ?`, [next, seq, r.path]),
        )
        // A path-only UPDATE advances the row version, so its old source
        // fingerprint is intentionally no longer valid. Re-materialize the moved
        // path now; otherwise the first conditional delete after a move would fail
        // closed despite the bytes being untouched.
        await this.reindexPath(next)
      }

      return {}
    }
    const row = await this.resolveRow(id, identityOnly)

    if (!row) {
      throw moveFailed('note not found')
    }
    const dest = destinationPath

    if (dest !== row.path) {
      const mount = this.mountForPath(row.path)
      const existingDirs = new Set(await mount.files.listDirs())

      if (
        !isPortableMoveDestination(dest, row.path, (prefix) =>
          existingDirs.has(this.relIn(mount, prefix)),
        )
      ) {
        throw moveFailed('destination must be safe with portable new components')
      }

      if (this.mountForPath(dest) !== mount) {
        throw moveFailed('cannot move a note across mounts')
      }
      await this.assertDirectorySpelling(mount, directoryOf(this.relIn(mount, dest)))
      const occupied = await this.sql.get<{ path: string }>(
        `SELECT path FROM notes WHERE path = ?`,
        [dest],
      )

      if (occupied) {
        throw moveFailed('a note already lives at the destination')
      }
      if (expectedSource) {
        if (!this.resourceAuthority) {
          throw moveFailed('storage cannot prove the exact source incarnation')
        }
        const source = await this.resourceAuthority.observe(row.path, {
          owner: 'notarium-move-source',
        })
        const target = await this.resourceAuthority.observe(dest, {
          owner: 'notarium-move-target',
        })

        if (source.kind !== 'present' || target.kind !== 'absent') {
          throw moveFailed('source or destination changed during move')
        }
        const expectedClaim = observedFileClaim(expectedSource, source)
        const observedOwner = exactOwnerObservation(source.bytes)

        if (
          !expectedClaim ||
          !sameFileClaim(expectedClaim, source.claim) ||
          !sameOwnerObservation(expectedSource.owner, observedOwner)
        ) {
          throw moveFailed('source changed during move')
        }
        const publication = await this.resourceAuthority.publish(
          {
            kind: 'move-put',
            sourcePath: row.path,
            targetPath: dest,
            content: source.bytes,
            expectedSource: source.claim,
            expectedTarget: target.claim,
          },
          { owner: 'notarium-move' },
        )

        if (publication.status === 'conflict') {
          throw moveFailed('source or destination changed during move')
        }
        const transition = publication.receipt.transitions.find(({ path }) => path === dest)

        if (!transition || transition.after.kind !== 'present') {
          throw moveFailed('storage returned an invalid move receipt')
        }
      } else {
        await this.renameFileNoReplace(mount, this.relIn(mount, row.path), this.relIn(mount, dest))
      }
      await this.publishWithSeq((seq) =>
        this.sql.run(`UPDATE notes SET path = ?, seq = ? WHERE path = ?`, [dest, seq, row.path]),
      )
      await this.reindexPath(dest)
      const current = await this.read(dest, { storageOnly: true })

      return {
        id: current.id,
        filePath: dest,
        versionToken: current.versionToken,
      }
    }

    const current = await this.read(row.path, { storageOnly: true })
    return { id: current.id, filePath: row.path, versionToken: current.versionToken }
  }

  async remove(
    rawId: string,
    opts?: {
      identityOnly?: boolean
      versionToken?: string
      physicalWriteClaim?: { kind: string; value: string }
      expectedSource?: PhysicalIncarnation
    },
  ): Promise<void> {
    await this.ensureReady()
    const row = await this.resolveRow(rawId, opts?.identityOnly)

    if (!row) {
      return
    } // removing what's already gone is a no-op, every engine agrees
    const mount = this.mountForPath(row.path)
    const rel = this.relIn(mount, row.path)
    let expected = await mount.files.read(rel)

    if (opts?.expectedSource) {
      if (!this.resourceAuthority) {
        throw writeFailed('storage cannot prove the exact source incarnation')
      }
      const observation = await this.resourceAuthority.observe(row.path, {
        owner: 'notarium-remove-source',
      })

      if (observation.kind !== 'present') {
        throw writeFailed('note physical incarnation changed during delete')
      }
      const expectedClaim = observedFileClaim(opts.expectedSource, observation)
      const observedOwner = exactOwnerObservation(observation.bytes)

      if (
        !expectedClaim ||
        !sameFileClaim(expectedClaim, observation.claim) ||
        !sameOwnerObservation(opts.expectedSource.owner, observedOwner)
      ) {
        throw writeFailed('note physical incarnation changed during delete')
      }
      expected = NOTE_TEXT_UTF8.decode(observation.bytes)
    }

    if (opts?.physicalWriteClaim && !opts.expectedSource) {
      if (opts.physicalWriteClaim.kind !== 'resource-publication-v1' || !this.resourceAuthority) {
        throw writeFailed('note physical incarnation changed during delete')
      }
      if (expected == null) {
        throw writeFailed('note physical incarnation changed during delete')
      }
    }

    if (expected != null && opts?.versionToken) {
      const current = await this.read(row.path, { storageOnly: true })

      if (current.versionToken !== opts.versionToken) {
        throw writeFailed('note changed during delete')
      }
    }
    const indexedHash =
      expected == null ? undefined : await this.verifiedIndexedSourceHash(row, expected)

    if (opts?.expectedSource) {
      if (
        expected == null ||
        !(await this.resourceAuthority!.removeClaimed(
          row.path,
          opts.expectedSource.claim.value,
          expected,
        ))
      ) {
        throw writeFailed('note physical incarnation changed during delete')
      }
    } else if (opts?.physicalWriteClaim) {
      if (
        expected == null ||
        !indexedHash ||
        (await sha256Hex(expected)) !== indexedHash ||
        !(await this.resourceAuthority!.removeClaimed(
          row.path,
          opts.physicalWriteClaim.value,
          expected,
        ))
      ) {
        throw writeFailed('note physical incarnation changed during delete')
      }
    } else if (mount.files.removeIfUnchanged) {
      if (expected == null && (await mount.files.exists(rel))) {
        throw writeFailed('note changed during delete')
      }
      if (expected != null) {
        if (!indexedHash || (await sha256Hex(expected)) !== indexedHash) {
          throw writeFailed('note changed during delete')
        }
        if (!(await mount.files.removeIfUnchanged(rel, expected))) {
          throw writeFailed('note changed during delete')
        }
      }
    } else {
      if (await mount.files.exists(rel)) {
        throw writeFailed('storage cannot delete a note without replacing a race')
      }
    }
    // The row resolved above is part of the delete claim. A concurrent reconcile
    // may have published another version at the same path while filesystem awaits
    // were in flight; never erase that newer index row by pathname alone.
    await this.sql.run(`DELETE FROM notes WHERE path = ? AND seq = ?`, [row.path, row.seq])
    this.invalidateGraphCache() // a removed note can change the wikilink graph (#81 Stage 4b)
  }

  // ── sync surface ────────────────────────────────────────────────────────────

  /** Subscribe to external-change hints (#146, P5 capability). Exact markdown
   *  paths are retained as force-read candidates before the signal is forwarded;
   *  a pathless event still triggers stat reconciliation + the bounded integrity
   *  sweep, never a full-corpus read cliff. Coalescing/debounce stays the caller's
   *  policy. Returns null when no mount could engage a watcher. */
  watch(onChange: () => void): (() => void) | null {
    const closers: Array<() => void> = []

    for (const mount of this.mounts) {
      const unwatch = mount.files.watch?.((path) => {
        if (path?.endsWith('.md')) {
          this.forcedReadPaths.add(this.fullIn(mount, path))
        }
        onChange()
      })

      if (unwatch) {
        closers.push(unwatch)
      }
    }
    if (!closers.length) {
      return null
    }
    const closeAll = (): void => {
      for (const c of closers) {
        c()
      }
      this.watchers.delete(closeAll)
    }
    this.watchers.add(closeAll)
    return closeAll
  }

  /** The whole external-change story: reconcile (full stat inventory + bounded
   *  source verification), then report
   *  rows stamped after the cursor WITH their bodies (local index — bodies are
   *  already in hand, no per-note read budget needed), plus the full inventory
   *  for deletion diffing. The cursor is this store's seq stamp. Inventory and
   *  upserts carry ALL classes (the read-model needs the full population for its
   *  snapshot — it hides classes per surface, not in the delta feed).
   *
   *  Body materialization is scoped to the delta (#222): the full inventory needs
   *  only metadata (metaOf ignores `body`), and only rows `seq > since` carry a
   *  body. The boot seed (`cursor == null`) is therefore meta-only — zero bodies —
   *  and a poll pulls bodies for the CHANGED rows alone (a no-change poll: none).
   *  Pre-#222 this ran `SELECT *`, materializing every note's body on every poll
   *  and on the phase-1 seed the client's `notesBarrier` waits on — O(corpus bytes)
   *  of synchronous, ungated, shared-loop work. */
  async changes(cursor: string | null): Promise<StoreDelta> {
    await this.ensureReady()
    await this.rescan()
    // The cursor cut and its SQL snapshot share the writer publication gate.
    // A genuinely async driver can otherwise expose `this.seq` before (or a row
    // after) the matching statement, letting a delta consumer skip that row.
    return this.withPublicationGate(async () => {
      const next = String(this.seq)
      const since = cursor == null ? NaN : Number(cursor)

      // Boot seed: inventory only, no upserts — so never touch the body column.
      if (Number.isNaN(since)) {
        const rows = await this.sql.all<NoteMetaRow>(
          `SELECT ${NOTE_META_COLS} FROM notes ORDER BY path`,
        )
        return { cursor: next, upserts: [], inventory: rows.map((r) => this.metaOf(r)) }
      }
      // Delta poll: ONE atomic snapshot. The CASE keeps the body blob out of the
      // result set for unchanged rows (SQLite decodes `body` only where seq > since),
      // so a big space's poll stops re-reading its whole corpus every interval.
      const rows = await this.sql.all<NoteMetaRow & { seq: number; body: string }>(
        `SELECT ${NOTE_META_COLS}, seq, CASE WHEN seq > ? THEN body ELSE '' END AS body FROM notes ORDER BY path`,
        [since],
      )
      const inventory: NoteMeta[] = []
      const upserts: NoteChange[] = []

      for (const r of rows) {
        const meta = this.metaOf(r)
        inventory.push(meta)
        if (r.seq > since) {
          upserts.push({ meta, content: r.body, tags: parseJsonArray(r.tags) })
        }
      }

      return { cursor: next, upserts, inventory }
    })
  }

  async syncStatus(): Promise<SyncStatus> {
    const status = liveSyncStatus()
    status.engine.indexing = this.scanning ? 'busy' : 'idle'
    if (this.noteCount != null) {
      status.engine.indexed = this.noteCount
      status.engine.total = this.noteCount
    }
    if (this.lastScanAt) {
      status.engine.lastIndexedAt = this.lastScanAt
    }
    // Semantic (vector) index state for this space (#199): the honest live search
    // mode + embed-backfill progress. Cheap in-memory counters — pendingEmbed IS
    // the live queue (seeded by the boot backfill scan, kept live by upsert/embed),
    // noteCount the eligible population, so this is never a per-request table scan.
    // `mode` mirrors capabilities.vector (fail-fast by fact: vec0 loaded AND model
    // loadable), so a degraded/off deployment honestly reports 'fts' → the UI shows
    // "Full-text only". done = total - pending; the badge clears when pending hits 0.
    status.engine.vector = {
      mode: this.capabilities.vector ? 'vector' : 'fts',
      pending: this.pendingEmbed.size,
      total: this.noteCount ?? 0,
    }
    return status
  }

  /** Host-side lifecycle (not a port method — same convention the space layer
   *  and CachedStore.stop duck-call): release the index handle. Awaitable so a
   *  graceful shutdown lets the index DB checkpoint and close before the host
   *  tears its files down (the read-model awaits this in settle()). */
  async stop(): Promise<void> {
    // Signal the embed loop to quit and close the index handle WITHOUT waiting for
    // it: an in-flight embed can be a multi-second cold model load, and a graceful
    // shutdown mustn't block on inference. `stopped` is checked at the top of each
    // note and again right before the DELETE+INSERT, so the loop won't START a
    // vector write after this. It is best-effort, NOT a full fence: if close()
    // lands in the single await gap between an in-flight DELETE and its INSERT, the
    // INSERT throws (swallowed by the loop) and that note is left vectorless until
    // the next boot's backfill re-embeds it (P2 — derived data, no truth lost).
    // Our SQL driver runs each statement synchronously between awaits, so no query
    // is mid-execution when close() runs.
    this.stopped = true
    // Release any external-change watchers (#146) the read-model didn't close —
    // an unref'd inotify handle would otherwise outlive an evicted space.
    for (const close of [...this.watchers]) {
      close()
    }
    await this.sql.close()
  }
}
