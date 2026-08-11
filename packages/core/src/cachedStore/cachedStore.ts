// Read-model decorator over any KnowledgeStore: serves list/recent/graph
// from an in-memory snapshot, kept fresh by write-through + read-refresh + delta
// poll. Search stays a passthrough on purpose — caching FTS would make this a
// shadow engine, the boundary the issue draws. Boot is phased so a cold start
// never hangs (cheap inventory answers first, later sweeps fill dates and edges).
// canon: docs/core.md#read-model · docs/core.md#phased-boot

import {
  aggregateGraphHealth,
  buildLinkIndex,
  type FolderAlias,
  resolveLink,
  shapeGraph,
} from '../graph'
import { IdentityRegistry } from '../identity'
import type {
  AgentWriteAttribution,
  ExportEntry,
  Graph,
  GraphHealth,
  KnowledgeStore,
  ListOptions,
  MoveInput,
  MutationOptions,
  NoteContent,
  NoteMeta,
  Preview,
  ReadOptions,
  ReadScope,
  RestoreInput,
  ScanPhase,
  SearchOptions,
  SearchResult,
  StoreCapabilities,
  StoreDelta,
  StoreEvent,
  SyncStatus,
  WriteInput,
  WriteResult,
} from '../knowledgeStore'
import {
  DEFAULT_SPACE,
  noteNotFound,
  READ_SCOPE,
  REVISION_KIND,
  SCAN_PHASE,
  StoreError,
} from '../knowledgeStore'
import type { AuthorFilter } from '../knowledgeStore'
import { isValidNoteId, NOTE_ID_FRONTMATTER_KEY } from '../libs/id'
import {
  decodeWikilinkIdentity,
  encodeWikilinkIdentity,
  FrontmatterLimitError,
  frontmatterValue,
  isWikilinkIdentityTarget,
  normalizeWikilinkTarget,
} from '../libs/markdown'
import { MutationCoordinator } from '../libs/mutationCoordinator'
import { directoryOf, isPathUnder } from '../libs/path'
import { normTags } from '../libs/tags'
import { computeVersionToken } from '../libs/versionToken'
import { InMemoryRevisionPersistence, RevisionJournal } from '../revisionJournal'
import { derivePreview } from '../snippet'
import { classesForScope, DEFAULT_NOTE_CLASS, isVisibleOn, SURFACE } from '../visibility'
import { GraphCache } from './caches/graphCache'
import { PreviewCache } from './caches/previewCache'
import {
  GRAPH_REFRESH_DEBOUNCE_MS,
  INDEX_PROGRESS_THROTTLE_MS,
  RECONCILE_DELAY_MS,
  RESPONSIVE_POLL_MS,
  TRASH_MUTATION_PREFIX,
  trashMutationPath,
} from './consts'
import { BulkController } from './controllers/bulkController'
import { WatchController } from './controllers/watchController'
import { DirectoryIndex } from './helpers/directoryIndex'
import { filterGraphForUser } from './helpers/filterGraph'
import { HistorySurface } from './helpers/historySurface'
import { supportsExactIdentityAddress } from './helpers/innerIdentity'
import { PhaseGate } from './helpers/phaseGate'
import { Snapshot } from './helpers/snapshot'
import { WriteEngine } from './helpers/writeEngine'
import type { CachedStoreOptions, StoreEventListener, Unsubscribe } from './types'

/** What emit() accepts: a `changed` event may omit `folders` (emit fills it from
 *  the snapshot); every other event is passed through unchanged. Read-model-internal
 *  — kept unexported so the module's `export *` barrel can't leak it onto the @core
 *  public surface (only the private emit() consumes it). */
type EmitInput =
  | Exclude<StoreEvent, { type: 'changed' }>
  | { type: 'changed'; upserts: string[]; removed: string[]; folders?: string[] }

type ExternalObservation = {
  noteId: string
  filePath: string
  title: string
  content: string | undefined
  tags: string[] | undefined
  transition: number
  meta: NoteMeta
}

type ExternalAdmission = {
  identityResolution?: Promise<void>
}

type ReadAttempt = { kind: 'complete'; content: NoteContent } | { kind: 'expand'; noteId: string }

type ReadEffects = {
  rekeyed: Array<[string, string]>
  changedIds: Set<string>
}

export class CachedStore implements KnowledgeStore {
  private readonly inner: KnowledgeStore

  /** Base export: a PURE passthrough — export reads raw on-disk files, never this layer's
   *  snapshot. Assigned ONLY when the engine can export, so a falsy `exportNotes` is the signal the
   *  host's endpoint 404s on (never a silent empty zip). */
  exportNotes?: (opts?: { scope?: ReadScope }) => AsyncIterable<ExportEntry>
  /** Optional directory mutations mirror the underlying engine honestly. */
  makeDir?: (path: string, opts?: MutationOptions) => Promise<void>
  removeDir?: (path: string, opts?: MutationOptions & { principal?: string }) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly now: () => Date
  /** This store's space. The journal/CAS tables are SHARED across spaces (partitioned by a `space`
   *  column), so a trash op by raw note-id must verify the tombstone's `space` matches — else a
   *  caller could restore/purge another space's note. */
  private readonly space: string

  /** The identity registry (P7): note-id ↔ filePath, first-seen created
   *  dates, materialization state. The snapshot below keys on ITS ids, so a
   *  rename/move never re-keys a note — the id is the identity. */
  private readonly identity: IdentityRegistry

  /** The revision journal: every note state passing through this layer. Always on — without
   *  a meta-DB it runs over the in-memory driver (history for the process lifetime). */
  private readonly journal: RevisionJournal
  /** Shared by delete, restore, purge and external tombstone admission. */
  private readonly trashMutations = new MutationCoordinator()
  /** Shared storage/path coordinator. Boot and delta reconciliation take its
   *  global claim so snapshot rebuilds cannot cross an admitted mutation. */
  private readonly mutations = new MutationCoordinator()
  /** Monotonic per-note token for asynchronous external journal work. A later
   *  reconcile invalidates an older queued body chase/tombstone before it can
   *  describe state that is no longer current. */
  private readonly externalTransitions = new Map<string, number>()
  private externalTransitionSequence = 0
  /** Temporary ids can be visible to a phase-1 reader. Keep their stable
   *  successor so an operation queued on boot resolves after the id sweep. */
  private readonly supersededIds = new Map<string, string>()

  /** The read-model's derived state: notes/edges/ghosts maps + edge-derivation
   *  primitives. The class orchestrates mutations; this object owns the maps and the
   *  graph-derivation over them (see {@link Snapshot}). */
  private readonly snap: Snapshot
  private readonly folderAliasesPort?: () => Promise<FolderAlias[]>
  /** The directory channel — empty-folder-aware tree source; the class
   *  seeds/patches it and serves listDirs() from it (see {@link DirectoryIndex}). */
  private readonly dirs = new DirectoryIndex()

  /** Preview cache — LRU read-through; the class delegates every preview
   *  read/invalidation to it (see {@link PreviewCache}). */
  private readonly previewCache: PreviewCache
  /** Raw-body reader (P5): shared with sweepFileIds' frontmatter id sweep, so it
   *  stays on the class and is handed to the preview cache too. */
  private readonly readBody?: (filePath: string) => Promise<string | null>

  /** Graph enrichment cache + SWR — owns the revision counter,
   *  enriched/stale maps and the debounced background recompute; the class feeds
   *  it a shaped snapshot and forwards mutation ticks (see {@link GraphCache}). */
  private readonly graphCache: GraphCache

  private phase: ScanPhase = SCAN_PHASE.cold
  /** True once inventory + the full metadata merge + frontmatter id sweep
   *  established stable mutation resources. Later graph/meta enrichment
   *  failures may degrade reads but do not erase those resources. */
  private mutationInventoryReady = false
  /** Persisted duplicate ownership is required only at the host's global-id
   * boundary. Ordinary reads may keep the documented soft degradation after a
   * failed registry load, but identityReady() must fail closed rather than let a
   * bare engine arbitrate duplicate frontmatter claims by file order. */
  private identityLoadError: string | null = null
  /** The sole load/retry flight. Registry load is a prerequisite of boot, so
   *  no boot generation can arbitrate file claims against an empty map while
   *  a retry is installing authoritative ownership. */
  private identityLoadTask: Promise<void> | null = null
  /** Snapshot rekeys may run ahead of the global id→space persistence write.
   * Every public id-producing read waits until this revision is durable, so a
   * transient meta-DB failure can never expose an id the next request cannot
   * route back to this store. */
  private identityPublicationRevision = 0
  private durableIdentityPublicationRevision = 0
  /** A revision says persistence still owes work; this barrier says a producer
   *  may not have put that work in the registry yet. Public reads join both. */
  private activeIdentityPublications = 0
  private identityPublicationsSettled: Promise<void> = Promise.resolve()
  private openIdentityPublicationsSettled: (() => void) | null = null
  /** Earliest snapshot axis affected by a poll whose identity flush failed.
   * Once durability recovers, one broad changed event repairs every client
   * window the failed poll deliberately did not announce. */
  private pendingIdentityChangeBefore: Set<string> | null = null
  /** Invalidates an older boot's graph completion when a newer authoritative
   *  rebuild wins the main checkpoint first. */
  private bootGeneration = 0
  /** Empty-folder truth joins the cache later than note identity. Until it has
   *  landed, listDirs() reads the engine so folder preconditions stay honest. */
  private directoryInventoryReady = false
  private startedAt: string | null = null
  private readyAt: string | null = null
  private scanError: string | null = null
  private cursor: string | null = null
  private lastPollAt: string | null = null
  private lastChangeAt: string | null = null
  /** When a delta poll last brought changes — drives the engine-busy heuristic
   *  (write-through and read-refresh changes don't count: they're our own
   *  mutations, not evidence the engine is indexing). */
  private lastPollChangeAt: string | null = null
  /** Last engine block the inner store reported (indexed/lastIndexedAt…) —
   *  cached so the sync emitStatus path doesn't have to await the engine. */
  private engineStatus: SyncStatus['engine'] | null = null

  private started = false
  private stopped = false
  private polling = false
  private bootTask: Promise<void> = Promise.resolve()
  private pollDone: Promise<void> = Promise.resolve()
  private openPollDone: () => void = () => undefined
  private bootRetryDelayMs = 2_000
  private identityRetryTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null
  /** External-change watcher — owns the engine's watch handle + the
   *  burst-coalescing timers; the class keeps only the derived cadence (see
   *  effectiveIntervalMs). Wired in the constructor (see {@link WatchController}). */
  private readonly watcher: WatchController
  /** History + trash surface — revision reads, activity feed, restore/
   *  purge, deleted-note banner; the class delegates (see {@link HistorySurface}). */
  private readonly trash: HistorySurface
  /** Embed-backfill progress subscription: the closer the engine's
   *  onIndexProgress() handed back (null when it has no vector channel), plus a
   *  trailing-throttle timer so the loop's many-per-second ticks coalesce into at
   *  most one `status` frame per INDEX_PROGRESS_THROTTLE_MS. */
  private unindexProgress: (() => void) | null = null
  private indexProgressTimer: ReturnType<typeof setTimeout> | null = null
  private notesBarrier!: Promise<void>
  private openNotesBarrier!: () => void
  private mutationBarrier!: Promise<void>
  private openMutationBarrier!: () => void
  private mutationBarrierInitialized = false
  /** Fair hand-off for the coarse bare-engine identity admission gate.
   *  Reconcile/direct raw reads share one phase; mutations share the other only
   *  until they have joined the normal resource queues. Opposite waiters close
   *  the active cohort, so neither a read stream nor a mutation stream can
   *  starve the other while actual engine I/O keeps narrow-claim parallelism. */
  private readonly mutationAdmission = new PhaseGate()
  /** Coordinator-queued external journal work is part of graceful durability,
   *  even while it is waiting behind a trash lease. */
  private readonly externalTasks = new Set<Promise<void>>()
  private listeners = new Set<StoreEventListener>()
  private graphTransitions = 0
  private graphTransitionDone: Promise<void> = Promise.resolve()
  private openGraphTransition: (() => void) | null = null
  /** setLinkIdentities replaces the whole authoritative map. Snapshot writes mark
   *  it dirty; exact consumers and bulk broadcasts publish it lazily so a large
   *  create-only import stays O(N), while mid-import interactive reads are exact. */
  private innerLinkIdentitiesDirty = true

  /** Bulk-write mode, entered by a streaming import (beginBulk/endBulk) —
   *  coalesces `changed` broadcasts and yields background work (see
   *  {@link BulkController}). Its `isActive` is the mode flag emit/poll/graph-refresh
   *  consult. */
  private readonly bulk: BulkController
  /** Directory/folder-alias changes can retarget old wikilinks. During a bulk
   *  import coalesce that corpus-wide repair and keep graph reads behind one
   *  transition barrier until the outer bracket drains. */
  private readonly bulkGraphContextSources = new Set<string>()
  private releaseBulkGraphTransition: (() => void) | null = null
  /** The write path — the CAS chokepoint + optimistic snapshot mirror +
   *  journal + trash tombstoning; the class delegates write/move/remove (see
   *  {@link WriteEngine}). */
  private readonly writes: WriteEngine

  constructor({
    inner,
    identityPersistence,
    revisionPersistence,
    space,
    pollIntervalMs = 60_000,
    graphDebounceMs = GRAPH_REFRESH_DEBOUNCE_MS,
    relationType = 'links-to',
    previewCacheSize = 20_000,
    readBody,
    folderAliases,
    scheduler,
    now = () => new Date(),
  }: CachedStoreOptions) {
    this.inner = inner
    // Expose export only when the engine backs it: bind the passthrough so
    // a non-exporting engine leaves store.exportNotes undefined → host 404.
    if (inner.exportNotes) {
      this.exportNotes = (opts) => inner.exportNotes!(opts)
    }
    this.identity = new IdentityRegistry({
      persistence: identityPersistence,
      space,
      now,
      requestFlush: () => this.flushIdentityPublication(),
    })
    this.space = space ?? DEFAULT_SPACE
    this.journal = new RevisionJournal({
      persistence: revisionPersistence ?? new InMemoryRevisionPersistence(),
      space: this.space,
      now,
    })
    this.pollIntervalMs = pollIntervalMs
    this.readBody = readBody
    this.snap = new Snapshot(relationType, () => this.dirs.list())
    this.previewCache = new PreviewCache({
      maxSize: previewCacheSize,
      readBody,
      getMeta: (id) => this.snap.notes.get(id),
      innerPeek: (id) => {
        const currentId = this.canonicalMutationId(id)

        if (!supportsExactIdentityAddress(this.inner) || !this.snap.notes.has(currentId)) {
          return null
        }
        this.syncInnerLinkIdentities()
        return this.inner.previewPeek(currentId)
      },
    })
    this.watcher = new WatchController({
      watch: inner.watch?.bind(inner),
      reconcile: () => void this.poll(),
      reconcileReady: () =>
        !this.polling && this.phase !== SCAN_PHASE.cold && this.phase !== SCAN_PHASE.notes,
      stopped: () => this.stopped,
    })
    this.graphCache = new GraphCache({
      shape: () =>
        shapeGraph(this.snap.graphVisibleNotes(), this.snap.edgesBySource, this.snap.ghosts),
      emitGraph: () => this.emit({ type: 'graph' }),
      debounceMs: graphDebounceMs,
      canSchedule: () => !this.stopped && this.phase === SCAN_PHASE.ready && !this.bulk.isActive,
      scheduler,
    })
    this.trash = new HistorySurface(
      {
        journal: this.journal,
        identity: this.identity,
        space: this.space,
        write: (input) => this.write(input),
        // Trash restores enter an outer mutation scope before acquiring their
        // trash lease. Avoid reacquiring the phase gate while that scope owns
        // trash and an opposite read phase is already waiting.
        writeAdmitted: (input) => this.writeAdmitted(input),
        emitChanged: (upserts, removed) => {
          this.markInnerLinkIdentitiesDirty()
          if (!this.bulk.isActive) {
            this.syncInnerLinkIdentities()
          }
          this.emit({ type: 'changed', upserts, removed })
        },
        reloadHistoricalNames: () => this.reloadHistoricalNames(),
        reresolveGhostsFromIndex: () => this.snap.reresolveGhosts(this.snap.buildIndex()),
        beginBulk: () => this.beginBulk(),
        endBulk: () => this.endBulk(),
      },
      this.trashMutations,
    )
    this.bulk = new BulkController({
      scheduler,
      suspendBackground: () =>
        (this.inner as { suspendBackground?: () => void }).suspendBackground?.(),
      resumeBackground: () =>
        (this.inner as { resumeBackground?: () => void }).resumeBackground?.(),
      flushIdentity: () => this.flushIdentityPublication(),
      syncLinkIdentities: () => this.syncInnerLinkIdentities(),
      dispatchChanged: (upserts, removed, folders) =>
        this.dispatch({ type: 'changed', upserts, removed, folders }),
      foldersOf: (ids) => this.foldersOf(ids),
      poll: () => void this.poll(),
      refreshGraph: () => this.graphCache.refreshSoon(),
      flushGraphContext: () => this.flushBulkGraphContext(),
      abandonGraphContext: () => this.abandonBulkGraphContext(),
    })
    this.writes = new WriteEngine(
      {
        inner: this.inner,
        snap: this.snap,
        identity: this.identity,
        journal: this.journal,
        previewCache: this.previewCache,
        dirs: this.dirs,
        iso: () => this.iso(),
        reconcileSoon: () => this.reconcileSoon(),
        afterNotesReady: (patch) => this.afterNotesReady(patch),
        rederiveSources: (sourceIds) => this.rederiveSourceEdges(sourceIds),
        rederiveGraphContext: () => this.rederiveGraphContext(),
        refreshFolderAliases: () => this.refreshFolderAliases(),
        beginGraphTransition: () => this.beginGraphTransition(),
        markInnerLinkIdentitiesDirty: () => this.markInnerLinkIdentitiesDirty(),
        syncInnerLinkIdentities: () => this.syncInnerLinkIdentities(),
        beginIdentityPublication: () => this.beginIdentityPublication(),
        markIdentityPublicationPending: () => this.markIdentityPublicationPending(),
        flushIdentityPublication: () => this.flushIdentityPublication(),
        rememberIdentityRepair: (before) => this.rememberIdentityRepair(before),
        emitChanged: (upserts, removed) => {
          this.markInnerLinkIdentitiesDirty()
          if (!this.bulk.isActive) {
            this.syncInnerLinkIdentities()
          }
          this.invalidateExternalTransitions([...upserts, ...removed])
          this.lastChangeAt = this.iso()
          this.emit({ type: 'changed', upserts, removed })
        },
        isBulkActive: () => this.bulk.isActive,
      },
      { mutations: this.mutations, trashMutations: this.trashMutations },
    )
    if (this.inner.makeDir) {
      this.makeDir = (path, opts) => this.runMutation(() => this.writes.makeDir(path, opts))
    }
    if (this.inner.removeDir) {
      this.removeDir = (path, opts) => this.runMutation(() => this.writes.removeDir(path, opts))
    }
    this.folderAliasesPort = folderAliases
    this.now = now
    this.resetBarrier()
    this.resetMutationBarrier()
  }

  /** Pull the latest folder path-history from the server registry into the cached
   *  list buildLinkIndex reads. Best-effort — a fetch error keeps the
   *  last good list (a stale folder-alias only delays a heal, never breaks one). */
  private async refreshFolderAliases(): Promise<boolean> {
    if (!this.folderAliasesPort) {
      return false
    }
    try {
      const next = await this.folderAliasesPort()
      const before = new Set(
        this.snap.folderAliases.map(({ current, alias }) => `${current}\u0000${alias}`),
      )
      const after = new Set(next.map(({ current, alias }) => `${current}\u0000${alias}`))
      const changed = before.size !== after.size || [...after].some((claim) => !before.has(claim))

      this.snap.folderAliases = next
      // Feed the engine too: its boot/rebuild graph then resolves a
      // path-form `[[oldpath/note]]` to a renamed folder's note even when the
      // filename is ambiguous — the read-model alone can only heal GHOSTS (it has
      // no link label to re-resolve an already-resolved-but-wrong edge), so the
      // engine must derive correctly at the source. No-op on an engine that can't
      // (the bare fake — folder identity is server-side, harmless there).
      this.inner.setFolderAliases?.(this.snap.folderAliases)
      return changed
    } catch {
      // keep the last good list
      return false
    }
  }

  /** Refresh the complete directory channel from storage. Notes contribute
   *  their ancestors, while listDirs supplies the empty folders no note
   *  inventory can reveal. Publish only a complete successful snapshot; on a
   *  failed walk listDirs() falls back to the engine instead of trusting stale
   *  cache state. */
  private async refreshDirectoryInventory(): Promise<boolean> {
    let stored: string[]

    try {
      stored = (await this.inner.listDirs?.()) ?? []
    } catch (err) {
      this.directoryInventoryReady = false
      console.error('[cached-store] directory inventory failed:', (err as Error).message)
      return false
    }

    const next = new DirectoryIndex()

    for (const meta of this.snap.notes.values()) {
      next.add(directoryOf(meta.filePath))
    }
    for (const dir of stored) {
      next.add(dir)
    }

    const before = new Set(this.dirs.list())
    const after = next.list()
    const changed = before.size !== after.length || after.some((dir) => !before.has(dir))

    if (changed) {
      this.dirs.clear()
      for (const dir of after) {
        this.dirs.add(dir)
      }
    }
    this.directoryInventoryReady = true
    return changed
  }

  /** Feed the identity-owning snapshot into a path-keyed bare engine. Raw
   *  frontmatter claims are only hints (external files may be unclaimed or copied);
   *  this registry mapping is the authority for exact `[[note-id]]` resolution. */
  private markInnerLinkIdentitiesDirty(): void {
    if (this.inner.setLinkIdentities) {
      this.innerLinkIdentitiesDirty = true
    }
  }

  private syncInnerLinkIdentities(): void {
    if (!this.inner.setLinkIdentities || !this.innerLinkIdentitiesDirty) {
      return
    }
    // An empty/phase-1 snapshot is not an authoritative registry projection.
    // Publishing it would disable the bare engine's frontmatter-id fallback and
    // make the first cold-start exact read miss until the boot sweep finishes.
    if (!this.mutationInventoryReady) {
      return
    }
    this.inner.setLinkIdentities(
      [...this.snap.notes].map(([id, meta]) => ({ id, path: meta.filePath })),
    )
    this.innerLinkIdentitiesDirty = false
  }

  get capabilities(): StoreCapabilities {
    // Equip a bare engine with identity (P7), optimistic writes and the
    // revision journal; ALSO the single enforcer of class-visibility,
    // so the read-model reports visibility:true regardless of the engine.
    // canon: docs/core.md#read-model · docs/architecture.md#p11
    return {
      ...this.inner.capabilities,
      identity: true,
      cas: true,
      revisions: true,
      trash: true,
      visibility: true,
    }
  }

  // ── class visibility ─────────────────────────────────────────────────────────
  // The single chokepoint: discovery surfaces admit only their scope's classes; direct id read()
  // isn't gated. canon: docs/note-model.md#note-classes · docs/core.md#read-model

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /** Kick the boot scan and the poll loop. Idempotent; returns the boot
   *  promise so hosts/tests may await warm-up, but nothing requires it. */
  start(): Promise<void> {
    if (this.started) {
      return Promise.resolve()
    }
    this.started = true
    // The persisted registry loads before the boot scan so inventory adoption
    // hands out the SAME ids as last run. On failure, keep non-identity engine
    // degradation available but do not let an empty registry sweep/flush choose
    // new owners over durable rows. identityReady()/poll retry this checkpoint.
    const boot = this.loadIdentityAndBoot(false)
    this.bootTask = boot

    // Engage the external-change watcher BEFORE arming the periodic timer:
    // whether the watcher took decides the cadence. The watcher is independent of
    // the boot scan — an event arriving mid-boot is held (re-armed) until the
    // snapshot is ready, then reconciled, so nothing lands in the boot-window gap.
    this.watcher.engage()
    // Subscribe to embed-backfill progress: the engine nudges us as its
    // vector queue drains so we push a fresh `status` frame with the live
    // pending/total — no polling of the engine's counters. Independent of the
    // watcher/poll cadence (embedding advances between polls). Null on a
    // non-vector engine — the badge simply never shows the search-mode leg.
    if (this.inner.onIndexProgress) {
      this.unindexProgress = this.inner.onIndexProgress(() => this.onIndexProgressTick())
    }
    if (this.effectiveIntervalMs > 0) {
      this.pollTimer = setInterval(() => void this.poll(), this.effectiveIntervalMs)
      this.pollTimer.unref?.()
    }

    return boot
  }

  private loadIdentityAndBoot(retry: boolean): Promise<void> {
    if (this.identityLoadTask) {
      return this.identityLoadTask
    }
    const task = (async () => {
      try {
        await this.identity.load()
      } catch (err) {
        this.failIdentityLoad(err)
        return
      }
      if (this.stopped) {
        return
      }
      if (this.identityRetryTimer) {
        clearTimeout(this.identityRetryTimer)
        this.identityRetryTimer = null
      }
      this.identityLoadError = null
      if (retry) {
        // A failed load never booted, but degraded name reads may have touched
        // engine caches. Reset every read-model axis before the first
        // authoritative generation; IdentityRegistry.load() itself installed a
        // detached map atomically.
        this.resetBarrier()
        this.mutationInventoryReady = false
        this.directoryInventoryReady = false
        this.resetMutationBarrier()
        this.snap.clear()
        this.previewCache.clear()
        this.graphCache.reset()
        this.dirs.clear()
        this.supersededIds.clear()
        this.externalTransitions.clear()
        this.cursor = null
      }
      await this.bootScan()
    })()
    const tracked = task.finally(() => {
      if (this.identityLoadTask === tracked) {
        this.identityLoadTask = null
      }
    })

    this.identityLoadTask = tracked
    this.bootTask = tracked
    return tracked
  }

  private failIdentityLoad(err: unknown): void {
    this.identityLoadError = (err as Error).message || String(err)
    this.phase = SCAN_PHASE.error
    this.scanError = this.identityLoadError
    this.openNotesBarrier()
    this.openMutationBarrier()
    this.emitStatus()
    console.error('[cached-store] identity load failed:', this.identityLoadError)
    if (!this.stopped && !this.identityRetryTimer) {
      const delay = this.bootRetryDelayMs

      this.bootRetryDelayMs = Math.min(delay * 2, 30_000)
      this.identityRetryTimer = setTimeout(() => {
        this.identityRetryTimer = null
        void this.poll()
      }, delay)

      this.identityRetryTimer.unref?.()
    }
  }

  /** Wait until the persisted identity registry and the boot inventory's
   * frontmatter reconciliation agree. SpaceManager calls this only after its
   * global id registry selected this space: an ordinary path/title read keeps the
   * cheap phase-1 behaviour, while the first id read after lazy boot/eviction can
   * never reach a bare engine before setLinkIdentities has its authoritative map. */
  async identityReady(): Promise<void> {
    if (!this.started) {
      void this.start()
    }
    await this.bootTask
    if (this.identityLoadError) {
      await this.loadIdentityAndBoot(true)
    }
    await this.ensureIdentityReady()
    if (this.identityLoadError || !this.mutationInventoryReady || this.stopped) {
      throw this.identityUnavailable()
    }
    try {
      await this.ensureIdentityPublished()
    } catch {
      throw this.identityUnavailable()
    }
  }

  /** The periodic reconcile cadence, derived so it can't drift from watchActive. Watched → the
   *  interval verbatim (the rare backstop; the watcher is the fast path). Unwatched → capped at
   *  RESPONSIVE_POLL_MS so a host that can't watch never polls slower than before. `0` stays off. */
  private get effectiveIntervalMs(): number {
    if (this.pollIntervalMs <= 0) {
      return 0
    }

    return this.watcher.isActive
      ? this.pollIntervalMs
      : Math.min(this.pollIntervalMs, RESPONSIVE_POLL_MS)
  }

  stop(): void {
    this.stopped = true
    // Wake operations that were admitted only as waiters. ensureMutationReady
    // observes stopped and fails them closed before they can queue storage work.
    this.openNotesBarrier()
    this.openMutationBarrier()
    // Release the external-change watcher first so an evicted space drops
    // its inotify handle promptly; the engine's stop() is a second safety net.
    this.watcher.disengage()
    // Release the embed-progress subscription so an evicted space's engine
    // stops nudging a torn-down read-model, and drop its pending throttle frame.
    this.unindexProgress?.()
    this.unindexProgress = null
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
    }
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer)
    }
    if (this.identityRetryTimer) {
      clearTimeout(this.identityRetryTimer)
      this.identityRetryTimer = null
    }
    this.graphCache.dispose()
    if (this.indexProgressTimer) {
      clearTimeout(this.indexProgressTimer)
    }
    // Bulk-mode teardown: a stop mid-import (idle eviction, shutdown)
    // must not leave a pending coalesce timer/buffer that dispatches to torn-down
    // listeners, nor strand the shared scheduler's interactive count above 0.
    this.bulk.teardown()
    this.pollTimer = null
    this.reconcileTimer = null
    // Lifecycle rides the decorator chain: an engine holding real handles (the
    // notarium index DB) releases them when its read-model goes away.
    // Duck-typed on purpose — lifecycle is a host concern, the port stays
    // free of it. The close may be async (the notarium index checkpoints its
    // WAL) — captured so settle() can await it, otherwise a graceful shutdown
    // would return with index files still flushing under the host's teardown.
    this.innerStopped = this.drainBeforeInnerStop().then(() =>
      (this.inner as { stop?: () => unknown }).stop?.(),
    )
    void this.settle()
  }

  private innerStopped: unknown

  /** Flush the write-behind tails (identity registry, journal queue) AND let the
   *  inner engine finish releasing its handles — what a graceful shutdown awaits
   *  before closing the meta-DB and tearing files down underneath. */
  async settle(): Promise<void> {
    await Promise.all([this.bootTask.catch(() => {}), this.pollDone.catch(() => {})])
    // On shutdown, innerStopped first crosses every pre-stop mutation and the
    // external queues. Only then snapshot the write-behind tails: a mutation
    // released by that checkpoint may have just enqueued its journal append.
    await Promise.resolve(this.innerStopped).catch(() => {})
    await this.drainExternalTasks()
    await Promise.all([this.identity.flush().catch(() => {}), this.journal.drain().catch(() => {})])
  }

  /** Force file-truth reconciliation and settle every meta-DB write caused by
   *  it without stopping the live store. Used by the process-local backup barrier. */
  async checkpoint(): Promise<void> {
    await this.bootTask
    await this.poll(true)
    await this.drainExternalTasks()
    await this.journal.drain()
    await this.identity.flush()
  }

  subscribe(listener: StoreEventListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ── bulk bracket — delegated to BulkController ─────────────────────────

  beginBulk(): void {
    this.bulk.begin()
  }

  endBulk(): Promise<void> {
    return this.bulk.end()
  }

  private resetBarrier(): void {
    this.notesBarrier = new Promise((resolve) => {
      this.openNotesBarrier = resolve
    })
  }

  private resetMutationBarrier(): void {
    if (this.mutationBarrierInitialized) {
      this.openMutationBarrier()
    }
    this.mutationBarrier = new Promise((resolve) => {
      this.openMutationBarrier = resolve
    })
    this.mutationBarrierInitialized = true
  }

  private acquireMutationAdmissionBlock(): Promise<() => void> {
    return this.mutationAdmission.acquire('read')
  }

  /** Boot: cursor + inventory first (cheap — list()/graph() answer right
   *  after), then the engine's full list for created dates, then the edge
   *  sweep. Any failure parks the store in 'error'; reads fall back to the
   *  engine and the poll loop keeps retrying the scan. */
  private async bootScan(): Promise<void> {
    const generation = ++this.bootGeneration
    let inventoryReady = false

    await this.mutations.run({ global: true }, async () => {
      if (generation !== this.bootGeneration || this.stopped) {
        return
      }
      this.beginBootClaimed()
      try {
        inventoryReady = await this.scanBootInventoryClaimed(generation)
      } catch (err) {
        this.failBoot(err, generation)
      }
    })
    if (inventoryReady && !this.stopped) {
      await this.finishBootGraph(generation)
    }
  }

  private async finishBootGraph(generation = this.bootGeneration, retry = false): Promise<void> {
    await this.mutations.run({ global: true }, async () => {
      if (generation !== this.bootGeneration || this.stopped) {
        return
      }
      if (retry) {
        this.phase = SCAN_PHASE.notes
        this.scanError = null
        this.emitStatus()
      }
      try {
        await this.finishBootGraphClaimed(generation)
      } catch (err) {
        this.failBoot(err, generation)
      }
    })
  }

  private beginBootClaimed(): void {
    this.phase = SCAN_PHASE.cold
    this.scanError = null
    this.startedAt = this.iso()
    this.emitStatus()
  }

  /** The authoritative inventory checkpoint. Caller holds the main global
   *  claim through the complete metadata/id/directory publication. */
  private async scanBootInventoryClaimed(generation: number): Promise<boolean> {
    const seed = await this.inner.changes(null)

    if (generation !== this.bootGeneration || this.stopped) {
      return false
    }
    this.cursor = seed.cursor
    this.identity.reconcileLivePaths(seed.inventory.map((meta) => meta.filePath))
    for (const meta of seed.inventory) {
      const adopted = this.adoptMeta(meta)

      if (!this.snap.notes.has(adopted.id)) {
        this.snap.notes.set(adopted.id, adopted)
      }
    }
    // Phase one exposes provisional ids through list/tree. Global id routes
    // resolve through persistence, not this process-local registry, so publish the
    // barrier only after the whole inventory batch is routable. A failed flush
    // leaves the scan in honest error mode instead of emitting ids that 404.
    await this.identity.flush()
    this.phase = SCAN_PHASE.notes
    this.openNotesBarrier()
    this.emitStatus()

    const full = await this.inner.list()

    if (generation !== this.bootGeneration || this.stopped) {
      return false
    }
    for (const meta of full) {
      const adopted = this.adoptMeta(meta)
      const prev = this.snap.notes.get(adopted.id)
      this.snap.notes.set(adopted.id, {
        ...adopted,
        createdAt: adopted.createdAt ?? prev?.createdAt ?? null,
      })
    }
    // Reconcile frontmatter id claims before admitting mutations. A phase-1
    // reader may have seen a temporary id; rekeySnapshot records its stable
    // successor so an already-queued mutation follows the durable identity.
    await this.sweepFileIds([...this.snap.notes.values()].map((m) => m.filePath))

    if (generation !== this.bootGeneration || this.stopped) {
      return false
    }

    try {
      const journalTimes = await this.journal.latestTimestamps()

      for (const [id, meta] of this.snap.notes) {
        const ts = journalTimes.get(id)

        if (ts && (!meta.modifiedAt || ts >= meta.modifiedAt)) {
          this.snap.notes.set(id, { ...meta, modifiedAt: ts })
        }
      }
      await this.reloadHistoricalNames()
    } catch (err) {
      console.error('[cached-store] boot journal enrichment failed:', (err as Error).message)
    }
    await this.refreshFolderAliases()

    if (generation !== this.bootGeneration || this.stopped) {
      return false
    }

    await this.refreshDirectoryInventory()

    if (generation !== this.bootGeneration || this.stopped) {
      return false
    }

    // Reads/mutations released by the inventory barrier may immediately address
    // an idless external note by the provisional/durable id settled above. Feed
    // that final map into a path-keyed exact-address engine before waking them;
    // waiting for the later graph phase leaves a deterministic not-found window.
    this.mutationInventoryReady = true
    this.markInnerLinkIdentitiesDirty()
    this.syncInnerLinkIdentities()
    // Wake waiters while the global lease remains held. They canonicalize only
    // after this callback publishes the stable inventory and releases it.
    this.openMutationBarrier()
    this.emit({ type: 'changed', upserts: [...this.snap.notes.keys()], removed: [] })
    return true
  }

  private async finishBootGraphClaimed(generation: number): Promise<void> {
    this.syncInnerLinkIdentities()
    const graph = await this.inner.graph()

    if (generation !== this.bootGeneration || this.stopped) {
      return
    }
    this.adoptGraph(graph)
    this.snap.reresolveGhosts(this.snap.buildIndex())
    this.phase = SCAN_PHASE.ready
    this.readyAt = this.iso()
    this.scanError = null
    this.emitStatus()
    void this.graph().catch(() => {})
  }

  private failBoot(err: unknown, generation = this.bootGeneration): void {
    if (generation !== this.bootGeneration) {
      return
    }
    this.phase = SCAN_PHASE.error
    this.scanError = (err as Error).message
    this.openNotesBarrier()
    this.openMutationBarrier()
    this.emitStatus()
    console.error('[cached-store] boot scan failed:', this.scanError)
    if (!this.readyAt && !this.stopped) {
      const delay = this.bootRetryDelayMs
      this.bootRetryDelayMs = Math.min(delay * 2, 30_000)
      const timer = setTimeout(() => void this.poll(), delay)
      timer.unref?.()
    }
  }

  /** Stamp engine metadata with its identity: the registry id (minted on
   *  first sight of the path) and the persisted first-seen created date —
   *  what makes Feed dates survive a restart. An identity-capable engine
   *  (InMemoryStore, a future lite engine) is its own registry — its ids pass
   *  through untouched. */
  private adoptMeta(meta: NoteMeta): NoteMeta & { id: string } {
    if (meta.id) {
      return meta as NoteMeta & { id: string }
    }
    const rec = this.identity.ensure(meta.filePath, meta.createdAt)
    return { ...meta, id: rec.id, createdAt: rec.createdAt ?? meta.createdAt ?? null }
  }

  /** Reload the journal's past-title backfill into `pastNames` and re-merge it into
   *  every snapshot meta's alias set. Run once at boot, and AGAIN after a
   *  trash restore: `pastNames` is a boot snapshot, so a note created,
   *  renamed, deleted and restored WITHIN one session would otherwise wait for a
   *  reboot before its journal-only past titles re-derive into aliases and inbound
   *  [[Old Title]] resolve again. Reusing the durable journal (rare, explicit op —
   *  the bulk query is the same one boot pays once). */
  private async reloadHistoricalNames(): Promise<void> {
    this.snap.pastNames = await this.journal.historicalNames()
    for (const [id, meta] of this.snap.notes) {
      const merged = this.snap.aliasesFor(id, meta.aliases, meta.title)

      if (merged !== meta.aliases) {
        this.snap.notes.set(id, { ...meta, aliases: merged })
      }
    }
  }

  /** Reconcile frontmatter id claims for the given paths: read each file via
   *  the storage capability (P5), adopt its `notarium-id`, re-key the snapshot
   *  where the file's claim beats a minted id. This is what lets a note whose
   *  id IS materialized survive an external move (the inventory diff sees
   *  remove+add; the new file's claim re-adopts the tombstoned id). Without
   *  the capability there's no sweep — claims still adopt lazily via read(). */
  private async sweepFileIds(paths: readonly string[]): Promise<{
    unresolvedPaths: Set<string>
    rekeyed: Array<[string, string]>
  }> {
    const unresolvedPaths = new Set(paths)
    const rekeyed: Array<[string, string]> = []

    if (!this.readBody || !paths.length) {
      return { unresolvedPaths, rekeyed }
    }
    let identityPublicationPending = false
    const CHUNK = 64

    for (let i = 0; i < paths.length; i += CHUNK) {
      // Read the slow storage leg concurrently, then fold claims in the caller's
      // deterministic inventory/path order. Adopting inside Promise callbacks made
      // duplicate-claim ownership depend on filesystem completion timing.
      const batch = await Promise.all(
        paths.slice(i, i + CHUNK).map(async (path) => {
          try {
            return { path, raw: await this.readBody!(path) }
          } catch {
            return { path, raw: null }
          }
        }),
      )

      for (const { path, raw } of batch) {
        if (raw == null) {
          continue
        }
        let claim: string | null

        try {
          claim = frontmatterValue(raw, NOTE_ID_FRONTMATTER_KEY)
        } catch (err) {
          if (err instanceof FrontmatterLimitError) {
            continue
          }
          throw err
        }
        // A successful raw read is authoritative even when the file has no
        // materialized claim. Failed/null reads stay unresolved so the
        // observation falls back to an engine read before journaling.
        unresolvedPaths.delete(path)

        if (!claim || !isValidNoteId(claim)) {
          continue
        }
        if (!identityPublicationPending) {
          this.markIdentityPublicationPending()
          identityPublicationPending = true
        }
        const res = this.identity.adoptFileId(path, claim)

        if (res.kind === 'duplicate') {
          // A user-copied file: two files claiming one id. The original
          // keeps it; this copy lives under its registry id until a save
          // through us rewrites its frontmatter.
          console.warn(
            `[cached-store] duplicate ${NOTE_ID_FRONTMATTER_KEY} "${claim}" in ${path} (owned by ${res.ownerPath}) — keeping the copy's registry id`,
          )
        } else if (res.kind === 'adopted' && res.previousId) {
          rekeyed.push([res.previousId, claim])
        }
      }
    }
    for (const [oldId, newId] of rekeyed) {
      this.rekeySnapshot(oldId, newId)
    }
    if (identityPublicationPending) {
      await this.flushIdentityPublication()
    }

    return { unresolvedPaths, rekeyed }
  }

  /** Move everything keyed under a superseded id to the note's real id. */
  private rekeySnapshot(oldId: string, newId: string): void {
    this.supersededIds.set(oldId, newId)
    const meta = this.snap.notes.get(oldId)

    if (meta) {
      this.snap.notes.delete(oldId)
      this.snap.notes.set(newId, { ...meta, id: newId })
    }
    const preview = this.previewCache.get(oldId)

    if (preview) {
      this.previewCache.delete(oldId)
      this.previewCache.set(newId, preview)
    }
    this.snap.renameEdges(oldId, newId)
  }

  /** Take the engine-built graph as the edge baseline: group its links by
   *  source and remember each ghost's prefill payload. Body-derived patches
   *  refine from here. The engine speaks storage ids (file paths) — its
   *  edges are remapped onto our note-ids; ghost targets pass through. */
  private adoptGraph(graph: Graph): void {
    this.graphCache.resetBaseline()
    this.snap.adoptEdgeBaseline(graph, this.inner.capabilities.identity)
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  private get isServingLive(): boolean {
    return this.phase === SCAN_PHASE.error
  }

  /** Wait until the snapshot can answer (the cheap phase-1 inventory — seconds
   *  on a cold start, instant afterwards). Never an indefinite hang: a failed
   *  boot opens the barrier too and flips reads to engine passthrough. */
  private async ensureNotes(): Promise<void> {
    if (this.phase !== SCAN_PHASE.cold) {
      return
    }
    await this.notesBarrier
  }

  private markIdentityPublicationPending(): void {
    this.identityPublicationRevision++
  }

  /** Close the public-read side before a producer can publish identity-bearing
   *  state. The producer marks a durable revision immediately before its first
   *  synchronous registry/snapshot mutation, then releases this lease on every
   *  success/failure path. */
  private beginIdentityPublication(): () => void {
    if (this.activeIdentityPublications++ === 0) {
      this.identityPublicationsSettled = new Promise<void>((resolve) => {
        this.openIdentityPublicationsSettled = resolve
      })
    }
    let released = false

    return () => {
      if (released) {
        return
      }
      released = true
      this.activeIdentityPublications--
      if (this.activeIdentityPublications === 0) {
        this.openIdentityPublicationsSettled?.()
        this.openIdentityPublicationsSettled = null
        this.publishPendingIdentityRepair()
      }
    }
  }

  private rememberIdentityRepair(before: ReadonlySet<string>): void {
    this.pendingIdentityChangeBefore ??= new Set(before)
    for (const id of before) {
      this.pendingIdentityChangeBefore.add(id)
    }
  }

  private publishPendingIdentityRepair(): void {
    if (
      this.activeIdentityPublications !== 0 ||
      !this.pendingIdentityChangeBefore ||
      this.durableIdentityPublicationRevision < this.identityPublicationRevision
    ) {
      return
    }
    const before = this.pendingIdentityChangeBefore

    this.pendingIdentityChangeBefore = null
    const current = new Set(this.snap.notes.keys())

    this.emit({
      type: 'changed',
      upserts: [...current],
      removed: [...before].filter((id) => !current.has(id)),
    })
  }

  /** Flush every identity mutation known at call time and advance the local
   * publication fence only after persistence confirms it. IdentityRegistry
   * retains failed dirty rows, so the next reader retries safely. */
  private async flushIdentityPublication(): Promise<void> {
    const revision = this.identityPublicationRevision

    await this.identity.flush()
    this.durableIdentityPublicationRevision = Math.max(
      this.durableIdentityPublicationRevision,
      revision,
    )
    this.publishPendingIdentityRepair()
  }

  private async ensureIdentityPublished(): Promise<void> {
    for (;;) {
      const barrier = this.identityPublicationsSettled

      await barrier
      if (barrier !== this.identityPublicationsSettled) {
        continue
      }
      while (this.durableIdentityPublicationRevision < this.identityPublicationRevision) {
        await this.flushIdentityPublication()
        // A producer can start while persistence is awaiting. It may not have
        // dirtied the registry yet, so never accept that flush as the final cut.
        if (barrier !== this.identityPublicationsSettled) {
          break
        }
      }
      if (
        barrier === this.identityPublicationsSettled &&
        this.activeIdentityPublications === 0 &&
        this.durableIdentityPublicationRevision >= this.identityPublicationRevision
      ) {
        return
      }
    }
  }

  /** Exact-id reads need the boot inventory's final frontmatter reconciliation,
   *  while list/tree reads may keep serving from the earlier cheap phase. This
   *  is not mutation admission: a failed boot opens the barrier and the live
   *  engine fallback still gets a chance. */
  private async ensureIdentityReady(): Promise<void> {
    for (;;) {
      if (this.mutationInventoryReady || this.phase === SCAN_PHASE.error || this.stopped) {
        return
      }
      const barrier = this.mutationBarrier

      await barrier
      if (barrier === this.mutationBarrier) {
        return
      }
    }
  }

  /** Mutations need stable inventory, metadata and durable ids, not merely a
   *  live engine: their id/path/prefix claims and optimistic patches are
   *  derived from this snapshot. If that boot checkpoint fails, fail closed
   *  instead of mutating without the state required to journal and linearize
   *  the operation honestly. */
  private async ensureMutationReady(): Promise<void> {
    for (;;) {
      if (this.stopped) {
        const err = new StoreError('store is stopping; mutation was not attempted')
        err.isUnavailable = true
        err.reason = 'engine_unavailable'
        throw err
      }
      if (this.mutationInventoryReady) {
        return
      }
      const barrier = this.mutationBarrier

      await barrier
      if (barrier !== this.mutationBarrier) {
        continue
      }
      if (this.mutationInventoryReady) {
        continue
      }
      const err = new StoreError('note inventory is unavailable; mutation was not attempted')
      err.isUnavailable = true
      err.reason = 'engine_unavailable'
      throw err
    }
  }

  private identityUnavailable(): StoreError {
    const err = new StoreError('note identity registry is unavailable')

    err.isUnavailable = true
    err.reason = 'engine_unavailable'
    return err
  }

  private async recoverIdentityForSurface(): Promise<void> {
    // The load error can appear while a caller is waiting on the cold notes
    // barrier. Check only after that barrier opens; checking before it creates
    // the exact load-failure race this guard exists to close.
    await this.ensureNotes()
    if (!this.identityLoadError) {
      return
    }
    await this.identityReady()
  }

  async list(opts?: ListOptions): Promise<NoteMeta[]> {
    await this.recoverIdentityForSurface()
    await this.ensureNotes()
    const scope: ReadScope = opts?.scope ?? READ_SCOPE.user
    const admitted = classesForScope(scope)
    const requested = opts?.classes == null ? undefined : new Set(opts.classes)

    if (requested?.size === 0) {
      return []
    }
    // Project-subtree narrowing rides alongside the class axis: a project
    // handle resolves to `pathPrefix`, and the list scopes to that subtree here, in
    // the read-model query (absent = the whole space).
    const prefix = opts?.pathPrefix
    const visible = (n: NoteMeta): boolean =>
      admitted.has(n.class ?? DEFAULT_NOTE_CLASS) &&
      (requested === undefined || requested.has(n.class ?? DEFAULT_NOTE_CLASS)) &&
      (prefix === undefined || isPathUnder(n.filePath, prefix))

    // The list-driven user surfaces (Feed/tree/buckets) all slice this, so the
    // hidden-class exclusion lives HERE, once. NB: `user` scope admits a class
    // visible on feed OR tree (coarse) — it does NOT enforce the per-surface
    // feed≠tree split. Moot in v1 (the only feed-hidden/tree-visible class is
    // attachment, which the engine never indexes as a note row); when an
    // attachment-style indexed class appears, the Feed must additionally filter
    // by isVisibleOn('feed', class).
    const fromSnapshot = (): NoteMeta[] => [...this.snap.notes.values()].filter(visible)
    const projectEngineRows = (rows: readonly NoteMeta[], preferSnapshot: boolean): NoteMeta[] =>
      rows.map((meta) => {
        // An identity-capable engine owns its id. A bare engine speaks storage
        // paths, so adopt the same provisional/durable registry identity the
        // boot inventory uses. A healthy selective read prefers the snapshot's
        // richer projection; error-mode passthrough keeps fresh engine metadata.
        const adopted = this.adoptMeta(meta)
        return preferSnapshot ? (this.snap.notes.get(adopted.id) ?? adopted) : adopted
      })

    const servingLive = this.isServingLive

    if (servingLive || requested) {
      try {
        const classes = requested ? [...requested] : opts?.classes
        const projected = projectEngineRows(
          await this.inner.list({ classes }),
          !servingLive,
        ).filter(visible)

        // A degraded/selective live read may discover paths outside the snapshot.
        // Do not expose their newly minted ids before global id→space resolution
        // can route the very next request back to this store.
        if (!this.inner.capabilities.identity) {
          await this.flushIdentityPublication()
        }

        await this.ensureIdentityPublished()

        return projected
      } catch (err) {
        // A graph-only boot failure and a transient derived-index failure both
        // leave a complete authoritative inventory behind. Preserve the
        // read-model's soft degradation: the exceptional path may pay O(N),
        // while the healthy selective path remains indexed by class.
        if (this.mutationInventoryReady) {
          console.error(
            '[cached-store] selective list failed; serving snapshot:',
            (err as Error).message,
          )
          const projected = fromSnapshot()

          await this.ensureIdentityPublished()
          return projected
        }
        throw err
      }
    }

    const projected = fromSnapshot()

    await this.ensureIdentityPublished()
    return projected
  }

  async graph(): Promise<Graph> {
    await this.recoverIdentityForSurface()
    await this.ensureNotes()
    return this.readAcrossStableGraphTransition(async () => {
      // The graph is a user surface: agent-memory (and any non-graph class) is
      // excluded as nodes AND link targets, always — there is no user scope
      // that puts memory in the graph in v1, so this surface takes no scope.
      if (this.isServingLive) {
        this.syncInnerLinkIdentities()
        const graph = this.remapBareGraph(filterGraphForUser(await this.inner.graph()))

        await this.flushIdentityPublication()
        return graph
      }

      const graph = await this.graphCache.read()

      await this.ensureIdentityPublished()
      return graph
    })
  }

  /** Read-only grooming health. Bypasses the incremental edge cache graph() serves (a cached
   *  inbound edge isn't re-resolved when its target is renamed, so its `resolvedVia` would
   *  undercount): folds the engine's FRESH derivation after the SAME hidden-class filter, so the
   *  metric is honest and visibility holds. One fresh derivation per call (a maintenance surface). */
  async graphHealth(): Promise<GraphHealth> {
    await this.recoverIdentityForSurface()
    await this.ensureNotes()
    return this.readAcrossStableGraphTransition(async () => {
      this.syncInnerLinkIdentities()
      const graph = this.remapBareGraph(filterGraphForUser(await this.inner.graph()))

      await this.flushIdentityPublication()
      await this.ensureIdentityPublished()
      return aggregateGraphHealth(graph)
    })
  }

  /** Put a bare engine's live graph onto the same note-id axis as the snapshot.
   *  Error-mode graph/health cannot return storage paths as ids: navigation and
   *  backlinks consume them as durable resource identities. The registry may only
   *  know provisional ids after a pre-inventory boot failure; those are still an
   *  honest identity axis and re-key when a later exact read discovers a claim. */
  private remapBareGraph(graph: Graph): Graph {
    if (this.inner.capabilities.identity) {
      return graph
    }
    const ids = new Map<string, string>()

    for (const node of graph.nodes) {
      if (node.ghost) {
        continue
      }
      const meta = this.adoptMeta({
        title: node.title,
        class: node.class,
        filePath: node.filePath,
        tags: node.tags,
        modifiedAt: null,
        createdAt: null,
      })
      ids.set(node.id, meta.id)
    }
    const idFor = (id: string): string => ids.get(id) ?? id
    const links = graph.links.map((link) => ({
      ...link,
      source: idFor(link.source),
      target: idFor(link.target),
    }))
    const nodes = graph.nodes.map((node) =>
      node.ghost
        ? {
            ...node,
            sources: node.sources?.map((source) => ({
              ...source,
              id: source.id ? idFor(source.id) : source.id,
            })),
          }
        : { ...node, id: idFor(node.id) },
    )
    return { nodes, links }
  }

  async search(q: string, opts?: SearchOptions): Promise<SearchResult[]> {
    await this.recoverIdentityForSurface()
    await this.ensureNotes()
    this.syncInnerLinkIdentities()
    const results = await this.inner.search(q, opts)
    // Search stays a passthrough (boundary) — but every hit must map onto a note-id (the wire
    // has no path channel). A hit the registry can't place is an engine-index artifact (or one poll
    // behind): dropped, with a log. The engine FTS indexes hidden classes too, so the read-model is
    // what drops them from user search here (scope `user` = userSearch-visible; `agentRecall` admits
    // memory; `all` filters nothing).
    const scope: ReadScope = opts?.scope ?? READ_SCOPE.user
    // Project-subtree narrowing: when a project handle resolved to a
    // pathPrefix, drop hits outside that subtree IN-QUERY (before the gateway's
    // limit cut, so the narrowed search stays limit-correct). The snapshot owns the
    // authoritative filePath (the engine hit may omit it).
    const prefix = opts?.pathPrefix
    const out: SearchResult[] = []

    for (const r of results) {
      const id =
        r.id ??
        (r.filePath
          ? (this.identity.idFor(r.filePath) ??
            (this.isServingLive
              ? this.adoptMeta({
                  title: r.title ?? r.filePath,
                  class: r.class,
                  filePath: r.filePath,
                  modifiedAt: r.modifiedAt ?? null,
                  createdAt: r.createdAt ?? null,
                }).id
              : undefined))
          : undefined)

      if (!id) {
        console.error(
          `[cached-store] search hit without a known note dropped: ${r.filePath ?? r.title ?? '?'}`,
        )
        continue
      }
      const cls = r.class ?? this.snap.notes.get(id)?.class

      if (
        scope !== READ_SCOPE.all &&
        !isVisibleOn(
          scope === READ_SCOPE.agentRecall ? SURFACE.agentRecall : SURFACE.userSearch,
          cls,
        )
      ) {
        continue
      }
      if (prefix !== undefined) {
        const fp = this.snap.notes.get(id)?.filePath ?? r.filePath

        // No known path under a narrowing request → can't prove it's in-subtree: drop.
        if (fp == null || !isPathUnder(fp, prefix)) {
          continue
        }
      }
      const meta = this.snap.notes.get(id)
      out.push({
        ...r,
        id,
        class: cls,
        modifiedAt: r.modifiedAt ?? meta?.modifiedAt ?? null,
        createdAt: r.createdAt ?? meta?.createdAt ?? null,
      })
    }

    if (this.isServingLive && !this.inner.capabilities.identity) {
      await this.flushIdentityPublication()
    }

    await this.ensureIdentityPublished()
    return out
  }

  /** Read resolves a note-id through the registry (falling through to the
   *  engine's own keys — wiki-link resolution by path/title keeps working),
   *  then the note's outbound edges are re-derived from the live body it just
   *  returned — opening a note heals its part of the graph (the engine's
   *  relation index may lag or lie). */
  async read(id: string, opts?: ReadOptions): Promise<NoteContent> {
    await this.recoverIdentityForSurface()
    const content = await this.readInternal(id, opts, false)

    await this.ensureIdentityPublished()
    return content
  }

  /** Resolve an authored wikilink on the user-graph namespace. Unlike read(), a
   *  plain spelling is not permanently captured by a tombstoned stable id: only a
   *  live graph-visible id wins directly, then the shared human-name index gets a
   *  chance. Reserved identity envelopes remain exact and never fall back. */
  async resolveWikilink(rawRef: string): Promise<NoteContent> {
    const content = await this.resolveWikilinkInternal(rawRef)

    await this.ensureIdentityPublished()
    return content
  }

  private async resolveWikilinkInternal(rawRef: string): Promise<NoteContent> {
    await this.ensureNotes()
    const ref = normalizeWikilinkTarget(rawRef)

    if (!ref) {
      throw noteNotFound(rawRef)
    }
    if (this.identityLoadError) {
      let exactIdentity = isWikilinkIdentityTarget(ref)

      if (!exactIdentity) {
        try {
          exactIdentity = (await this.identity.persistedRecordFor(ref))?.space === this.space
        } catch {
          throw this.identityUnavailable()
        }
      }
      if (exactIdentity) {
        await this.identityReady()
        // A successful retry rebuilt the snapshot; continue through the normal
        // exact resolver below. A failed retry throws unavailable here.
      } else {
        return this.resolveHumanWithoutIdentity(rawRef, ref)
      }
    }
    // A plain spelling may itself be a stable id. Do not choose a human-name
    // target from the provisional phase-1 index and only then wait inside the
    // exact read: the frontmatter sweep can re-key that decision underneath it.
    await this.ensureIdentityReady()
    if (this.isServingLive) {
      return this.resolveLiveWikilink(rawRef, ref)
    }
    if (isWikilinkIdentityTarget(ref)) {
      // The cheap inventory becomes readable before the frontmatter-id sweep is
      // complete. An exact identity must wait for that authoritative map; otherwise
      // the first cold-start click can miss a live materialized id deterministically.
      const id = decodeWikilinkIdentity(ref)
      const canonical = id == null ? null : this.canonicalMutationId(id)

      // Exact identity changes name lookup semantics, not visibility. Wikilinks
      // live on the user-graph namespace, where memory/profile stay private.
      if (
        canonical == null ||
        !this.snap.notes.has(canonical) ||
        !this.snap.isGraphVisibleId(canonical)
      ) {
        throw noteNotFound(rawRef)
      }

      return this.readInternal(ref, { identityOnly: true }, false)
    }
    const directId = this.canonicalMutationId(ref)
    const direct = this.snap.notes.get(directId)

    if (direct && this.snap.isGraphVisibleId(directId)) {
      return this.readInternal(encodeWikilinkIdentity(directId), { identityOnly: true }, false)
    }
    const resolved = resolveLink(ref, this.snap.buildIndex())

    if (resolved.ghost) {
      throw noteNotFound(rawRef)
    }

    return this.readInternal(
      encodeWikilinkIdentity(resolved.targetId),
      { identityOnly: true },
      false,
    )
  }

  /** Identity-load degradation for the explicitly human scoped resolver.
   *  Build a one-call path/name index from engine rows and read the selected
   *  storage path exactly. No adoptMeta/finalizeRead call is allowed here: a
   *  transient meta failure must not create dirty rows that can overwrite the
   *  durable duplicate owner before retry. */
  private async resolveHumanWithoutIdentity(rawRef: string, ref: string): Promise<NoteContent> {
    const rows = (await this.inner.list({ scope: READ_SCOPE.all })).filter((meta) =>
      isVisibleOn(SURFACE.graph, meta.class),
    )
    let currentFolders: string[] = []

    try {
      currentFolders = (await this.inner.listDirs?.()) ?? []
    } catch {
      // Note-derived ancestors are sufficient for note targets.
    }
    const localRows = rows.map((meta) => ({ ...meta, id: meta.id ?? meta.filePath }))
    const resolved = resolveLink(
      ref,
      buildLinkIndex(localRows, this.snap.folderAliases, undefined, currentFolders),
    )

    if (resolved.ghost) {
      throw noteNotFound(rawRef)
    }
    const selected = localRows.find((meta) => meta.id === resolved.targetId)

    if (!selected) {
      throw noteNotFound(rawRef)
    }
    const detail = await this.inner.read(selected.filePath, { storageOnly: true })

    if (detail.filePath !== selected.filePath || !isVisibleOn(SURFACE.graph, detail.class)) {
      throw noteNotFound(rawRef)
    }
    if (!detail.id) {
      throw this.identityUnavailable()
    }
    let owner: Awaited<ReturnType<IdentityRegistry['persistedRecordFor']>>

    try {
      owner = await this.identity.persistedRecordFor(detail.id)
    } catch {
      throw this.identityUnavailable()
    }
    if (
      !owner ||
      owner.space !== this.space ||
      owner.deletedAt != null ||
      owner.filePath !== selected.filePath
    ) {
      throw this.identityUnavailable()
    }

    return {
      ...detail,
      // Point-probed above: useful scoped degradation without inventing a
      // path-shaped id or mutating the unavailable full registry.
      id: detail.id,
      versionToken: detail.versionToken ?? computeVersionToken(detail.content),
    }
  }

  /** Resolve against a fresh visible inventory when boot has degraded before it
   *  could publish an authoritative snapshot. Exact-id probes stay on the identity
   *  axis; human lookup is built only from graph-visible rows, so passthrough never
   *  turns a hidden memory/profile namesake into a user wikilink target. */
  private async resolveLiveWikilink(rawRef: string, ref: string): Promise<NoteContent> {
    const readVisibleIdentity = async (id: string): Promise<NoteContent> => {
      const expectedId = this.canonicalMutationId(id)
      const detail = await this.readInternal(
        encodeWikilinkIdentity(expectedId),
        { identityOnly: true },
        false,
      )
      const returnedId = detail.id ? this.canonicalMutationId(detail.id) : expectedId

      if (returnedId !== expectedId || !isVisibleOn(SURFACE.graph, detail.class)) {
        throw noteNotFound(rawRef)
      }

      return detail
    }

    if (isWikilinkIdentityTarget(ref)) {
      const id = decodeWikilinkIdentity(ref)

      if (id == null) {
        throw noteNotFound(rawRef)
      }

      return readVisibleIdentity(this.canonicalMutationId(id))
    }

    // A live graph-visible stable id has the same priority as it does in the
    // healthy snapshot path. A hidden exact hit deliberately falls through to
    // human lookup, where a visible namesake may still win.
    try {
      return await readVisibleIdentity(this.canonicalMutationId(ref))
    } catch (err) {
      if (!(err as StoreError).isNotFound) {
        throw err
      }
    }

    // A live file read can be fresher than a degraded engine index. Feed those
    // observed rows back into subsequent resolver decisions so a same-path
    // replacement cannot satisfy the stale title/id that selected its predecessor.
    const observed = new Map<string, NoteMeta & { id: string }>()

    const selectLive = async (): Promise<NoteMeta & { id: string }> => {
      const notes = (await this.inner.list({ scope: READ_SCOPE.all }))
        .map((meta) => observed.get(meta.filePath) ?? this.adoptMeta(meta))
        .filter((meta) => isVisibleOn(SURFACE.graph, meta.class))
      let currentFolders: string[] = []

      try {
        currentFolders = (await this.inner.listDirs?.()) ?? []
      } catch {
        // Note-derived ancestors still make a complete index for note targets.
      }
      const resolved = resolveLink(
        ref,
        buildLinkIndex(notes, this.snap.folderAliases, undefined, currentFolders),
      )

      if (resolved.ghost) {
        throw noteNotFound(rawRef)
      }
      const selected = notes.find((meta) => meta.id === resolved.targetId)

      if (!selected) {
        throw noteNotFound(rawRef)
      }

      return selected
    }

    // A path-keyed engine may not know a provisional registry id when boot
    // failed before the frontmatter sweep. Prefer the exact id; on its miss read
    // the selected live path and re-resolve once so a list/read replacement race
    // cannot return a different note that merely occupied the same lookup slot.
    for (let attempt = 0; attempt < 2; attempt++) {
      const selected = await selectLive()

      let detail: NoteContent

      try {
        detail = await readVisibleIdentity(selected.id)
      } catch (err) {
        if (!(err as StoreError).isNotFound) {
          throw err
        }
        detail = await this.readInternal(selected.filePath, undefined, false)
      }

      if (detail.filePath !== selected.filePath || !isVisibleOn(SURFACE.graph, detail.class)) {
        throw noteNotFound(rawRef)
      }
      observed.set(detail.filePath, {
        id: detail.id ?? selected.id,
        title: detail.title ?? selected.title,
        class: detail.class,
        filePath: detail.filePath,
        ...(detail.slug ? { slug: detail.slug } : {}),
        ...(detail.aliases?.length ? { aliases: detail.aliases } : {}),
        modifiedAt: detail.modifiedAt ?? null,
        createdAt: detail.createdAt ?? null,
      })
      const current = await selectLive()
      const currentId = this.canonicalMutationId(current.id)
      const returnedId = detail.id ? this.canonicalMutationId(detail.id) : currentId

      if (current.filePath === detail.filePath && currentId === returnedId) {
        return detail
      }
    }
    throw noteNotFound(rawRef)
  }

  /** Same read finalization when the caller already owns the relevant main
   *  claim (delta reconciliation / external body chase). */
  private readClaimed(
    id: string,
    opts?: ReadOptions,
    effects?: ReadEffects,
    admissionHeld = false,
  ): Promise<NoteContent> {
    return this.readInternal(id, opts, true, effects, admissionHeld)
  }

  private async readInternal(
    rawId: string,
    opts: ReadOptions | undefined,
    mainClaimed: boolean,
    effects?: ReadEffects,
    admissionHeld = false,
  ): Promise<NoteContent> {
    const identityTarget = normalizeWikilinkTarget(rawId)
    const identityEnvelopeSyntax = isWikilinkIdentityTarget(identityTarget)

    if (identityEnvelopeSyntax) {
      await this.ensureNotes()
      await this.ensureIdentityReady()
    }
    const rawEnvelopeIdentityOwner =
      identityEnvelopeSyntax &&
      !opts?.identityOnly &&
      (this.snap.notes.has(rawId) || this.identity.recordFor(rawId) !== undefined)
        ? rawId
        : undefined
    // A public storage read must round-trip every literal path returned by list(),
    // including a legacy root file whose name occupies the reserved envelope
    // namespace. Authored links set identityOnly and deliberately skip this axis.
    const exactEnvelopePathOwner =
      identityEnvelopeSyntax && !opts?.identityOnly && rawEnvelopeIdentityOwner === undefined
        ? (this.identity.idFor(rawId) ??
          [...this.snap.notes].find(([, meta]) => meta.filePath === rawId)?.[0])
        : undefined
    const identityEnvelope =
      identityEnvelopeSyntax &&
      rawEnvelopeIdentityOwner === undefined &&
      exactEnvelopePathOwner === undefined
    const envelopedId = decodeWikilinkIdentity(identityTarget)

    // The namespace is reserved even when its payload is malformed. Treating the
    // literal spelling as an ordinary opaque id would make direct read open a note
    // which graph resolution correctly keeps as a non-creatable tombstone.
    if (identityEnvelope && envelopedId == null) {
      throw noteNotFound(rawId)
    }
    const requestedId = identityEnvelope && envelopedId != null ? envelopedId : rawId
    const initialDirectId = this.canonicalMutationId(requestedId)
    // A stable id keeps denoting that note even if its old path is reused. A
    // path/title/permalink is a resolver instead and is deliberately resolved
    // again after a preceding mutation has finished.
    const stableIdRequest =
      exactEnvelopePathOwner === undefined &&
      (initialDirectId !== rawId ||
        this.snap.notes.has(initialDirectId) ||
        this.identity.recordFor(initialDirectId) !== undefined)

    const target = (): {
      id: string
      path: string | undefined
      storageKey: string
      needsGlobalClaim: boolean
    } => {
      const directId = this.canonicalMutationId(requestedId)
      let owner: string | undefined

      if (exactEnvelopePathOwner !== undefined) {
        owner = exactEnvelopePathOwner
      } else if (stableIdRequest) {
        owner = directId
      } else {
        // Exact path is an identity hint. A title is not: choosing a unique exact
        // title here can bypass a higher-priority filename in the inner store and
        // make CachedStore resolve a different note than graph/client. Name lookup
        // belongs to the shared resolver below the cache.
        const matches = [...this.snap.notes].filter(([, meta]) => meta.filePath === requestedId)

        owner =
          this.identity.idFor(requestedId) ?? (matches.length === 1 ? matches[0][0] : undefined)
      }
      const id = this.canonicalMutationId(owner ?? directId)
      const path = this.identity.pathFor(id) ?? this.snap.notes.get(id)?.filePath

      return {
        id,
        path,
        storageKey: path ?? (owner ? id : requestedId),
        needsGlobalClaim: owner === undefined && path === undefined,
      }
    }

    const perform = async (claimedIds?: ReadonlySet<string>): Promise<ReadAttempt> => {
      const current = target()
      let detail: NoteContent

      // A bare engine has no id channel: handing a deleted stable id to its
      // generic resolver could open an unrelated note whose path/title/slug
      // happens to equal that id. Only the explicit trash view may answer it.
      if (
        stableIdRequest &&
        !supportsExactIdentityAddress(this.inner) &&
        current.path === undefined
      ) {
        if (opts?.deletedView) {
          const gone = await this.trash.deletedNoteView(current.id)

          if (gone) {
            return { kind: 'complete', content: gone }
          }
        }
        throw noteNotFound(current.id)
      }

      try {
        // Preserve every RECOGNISED stable-id request all the way into an
        // identity-capable engine, even when the public caller used the ordinary raw
        // id form. Passing its snapshot path after an external delete would let the
        // engine's human resolver fall through from that missing path onto a namesake.
        const useAuthoritativePath =
          stableIdRequest && current.path !== undefined && !this.inner.capabilities.identity
        const innerKey = useAuthoritativePath
          ? current.path!
          : supportsExactIdentityAddress(this.inner) && stableIdRequest
            ? identityEnvelope
              ? identityTarget
              : encodeWikilinkIdentity(current.id)
            : current.storageKey

        if (supportsExactIdentityAddress(this.inner) && stableIdRequest) {
          this.syncInnerLinkIdentities()
        }
        detail = await this.inner.read(
          innerKey,
          useAuthoritativePath
            ? { ...opts, identityOnly: false, storageOnly: true }
            : supportsExactIdentityAddress(this.inner) && stableIdRequest
              ? { ...opts, identityOnly: true }
              : opts,
        )
      } catch (err) {
        // A trashed note has no live file — serve its last journaled state so
        // the reader can open it by /n/<id> under a "deleted" banner instead of a
        // bare 404. ONLY when the caller opted in (the explicit /api/note read):
        // discovery reads (preview/previews/delta) must miss on a deleted note, not
        // resurrect its snippet. Genuinely-trashed only; otherwise the real error wins.
        if (opts?.deletedView) {
          const gone = await this.trash.deletedNoteView(current.id)

          if (gone) {
            return { kind: 'complete', content: gone }
          }
        }
        throw err
      }
      // A persisted registry path is the stable id's authoritative owner. A
      // degraded inner resolver that crosses from that missing/ambiguous path to a
      // duplicate claim or namesake must fail closed, never have finalizeRead stamp
      // the requested id onto the wrong body.
      if (stableIdRequest && current.path !== undefined && detail.filePath !== current.path) {
        throw noteNotFound(current.id)
      }
      const bodyClaim = detail.frontmatter?.[NOTE_ID_FRONTMATTER_KEY]

      if (
        claimedIds &&
        !this.inner.capabilities.identity &&
        typeof bodyClaim === 'string' &&
        isValidNoteId(bodyClaim)
      ) {
        const claimedId = this.canonicalMutationId(bodyClaim)

        if (claimedId !== current.id && !claimedIds.has(claimedId)) {
          // The body disclosed a resource the first claim could not know. Do
          // not patch any state yet: release, expand the stable claim and read
          // again so an already-admitted forced-id operation orders first.
          return { kind: 'expand', noteId: claimedId }
        }
      }
      // Exact-path reads are expected to answer the claimed path. An engine
      // resolver that unexpectedly crossed onto another path can still serve
      // the body, but must not patch identity/preview/edges outside the lease.
      const allowSideEffects = current.path === undefined || detail.filePath === current.path

      // A direct read owns its event publication. Keep every snapshot side-effect
      // buffered until the identity flush below succeeds; callers such as poll()
      // pass their own accumulator and publish at their wider checkpoint.
      const readEffects = effects ?? { rekeyed: [], changedIds: new Set<string>() }
      const mayRekey =
        !effects &&
        !this.inner.capabilities.identity &&
        typeof bodyClaim === 'string' &&
        isValidNoteId(bodyClaim) &&
        this.canonicalMutationId(bodyClaim) !== current.id
      // Snapshotting the corpus is only needed on the rare lazy-adoption path,
      // never on an ordinary hot read.
      const identityBefore = mayRekey ? new Set(this.snap.notes.keys()) : undefined
      const content = this.finalizeRead(
        current.id,
        current.path,
        detail,
        allowSideEffects,
        readEffects,
      )

      // A lazy frontmatter adoption can re-key a phase-one provisional id. The
      // returned durable id is immediately used by URL replacement and later API
      // calls, whose global resolver reads persistence; settle it before exposure.
      try {
        if (!this.inner.capabilities.identity) {
          await this.flushIdentityPublication()
        }
      } catch (err) {
        // The snapshot already carries the new axis, but no client has heard it.
        // Retain the pre-read population so the first later successful flush emits
        // one broad repair; never announce an id its global route cannot resolve.
        if (readEffects.rekeyed.length > 0 || readEffects.changedIds.size > 0) {
          const before = identityBefore ?? new Set(this.snap.notes.keys())

          this.pendingIdentityChangeBefore ??= before
          for (const id of before) {
            this.pendingIdentityChangeBefore.add(id)
          }
        }
        throw err
      }

      if (!effects) {
        this.emitReadEffects(readEffects)
      }

      return { kind: 'complete', content }
    }

    const needsIdentityAdmission = !this.inner.capabilities.identity && !admissionHeld
    const releaseAdmission = needsIdentityAdmission
      ? await this.acquireMutationAdmissionBlock()
      : undefined

    try {
      // A public read may have been queued behind a pre-stop mutation intent.
      // Do not let it reach the inner engine after shutdown's queue checkpoint.
      // Reconcile/body-chase reads are lifecycle-tracked separately.
      if (this.stopped && !mainClaimed) {
        const err = new StoreError('store is stopping; read was not attempted')

        err.isUnavailable = true
        err.reason = 'engine_unavailable'
        throw err
      }
      if (mainClaimed) {
        const attempt = await perform()

        if (attempt.kind === 'complete') {
          return attempt.content
        }
        throw new Error('claimed read unexpectedly requested a claim expansion')
      }
      const claimedIds = new Set<string>()

      for (;;) {
        const attempt = await this.mutations.runStable(
          () => {
            const current = target()
            const paths = [...claimedIds].map(
              (id) => this.identity.pathFor(id) ?? this.snap.notes.get(id)?.filePath,
            )

            return current.needsGlobalClaim
              ? { global: true }
              : {
                  noteIds: [current.id, ...claimedIds],
                  paths: [current.path, ...paths],
                }
          },
          () => perform(claimedIds),
        )

        if (attempt.kind === 'complete') {
          return attempt.content
        }
        claimedIds.add(attempt.noteId)
      }
    } finally {
      releaseAdmission?.()
    }
  }

  private finalizeRead(
    id: string,
    expectedPath: string | undefined,
    detail: NoteContent,
    allowSideEffects = true,
    effects?: ReadEffects,
  ): NoteContent {
    // Only an identity-capable engine owns its returned id. A bare engine may
    // parse the frontmatter claim into detail.id as a convenience, but the
    // decorator must still adopt/rekey its registry before exposing that id.
    let sourceId = this.inner.capabilities.identity ? detail.id : undefined

    if (!sourceId && detail.filePath && allowSideEffects) {
      const currentOwner = this.liveOwnerAtPath(detail.filePath)
      const expectedOwner = this.canonicalMutationId(id)
      const stillOwnsPath = currentOwner === id || currentOwner === expectedOwner

      // The I/O may have completed before a queued delete, while finalization
      // runs after it. Do not resurrect a deleted binding — or replace the
      // owner of a new file that appeared at the same path — from stale bytes.
      if (expectedPath && expectedPath === detail.filePath && !stillOwnsPath) {
        sourceId = id
      } else {
        let rec = this.identity.ensure(detail.filePath)
        // Lazy claim adoption — the no-files-capability channel: any body
        // passing through may carry a frontmatter id the sweep never saw.
        const claim = detail.frontmatter?.[NOTE_ID_FRONTMATTER_KEY]

        if (typeof claim === 'string' && isValidNoteId(claim)) {
          const res = this.identity.adoptFileId(detail.filePath, claim)

          if (res.kind === 'adopted') {
            if (res.previousId) {
              this.markIdentityPublicationPending()
              this.rekeySnapshot(res.previousId, claim)
              this.markInnerLinkIdentitiesDirty()
              this.syncInnerLinkIdentities()
              if (effects) {
                effects.rekeyed.push([res.previousId, claim])
              } else {
                this.lastChangeAt = this.iso()
                this.emit({ type: 'changed', upserts: [claim], removed: [res.previousId] })
              }
            }
            rec = this.identity.recordFor(claim) ?? rec
          }
        }
        sourceId = rec?.id
      }
    } else if (!sourceId) {
      sourceId = id
    }
    if (
      allowSideEffects &&
      sourceId &&
      this.snap.notes.has(sourceId) &&
      typeof detail.content === 'string'
    ) {
      // The body is in hand anyway — refresh the preview alongside the edges.
      this.previewCache.set(sourceId, derivePreview(detail.content, detail.frontmatter?.tags))
      const changed = this.snap.patchNoteEdges(sourceId, detail.content)

      if (changed) {
        if (effects) {
          effects.changedIds.add(sourceId)
        } else {
          this.lastChangeAt = this.iso()
          this.emit({ type: 'changed', upserts: [sourceId], removed: [] })
        }
      }
    }

    // The version token rides every read: what the editor will echo back
    // on save. A CAS-enforcing inner store already answered it; for a bare
    // engine we hash the body as served — same normalisation both sides.
    return {
      ...detail,
      id: sourceId,
      versionToken: detail.versionToken ?? computeVersionToken(detail.content),
    }
  }

  /** Publish snapshot effects accumulated by one direct read. The caller invokes
   * this only after identity durability succeeds, so an SSE consumer can route
   * every upsert immediately. */
  private emitReadEffects(effects: ReadEffects): void {
    const rekeyedRemoved = new Set(effects.rekeyed.map(([oldId]) => oldId))
    const upserts = [
      ...new Set([
        ...effects.rekeyed.map(([, newId]) => newId),
        ...[...effects.changedIds].map((id) => this.canonicalMutationId(id)),
      ]),
    ].filter((id) => this.snap.notes.has(id))
    const removed = [...rekeyedRemoved]

    if (!upserts.length && !removed.length) {
      return
    }
    this.lastChangeAt = this.iso()
    this.emit({ type: 'changed', upserts, removed })
  }

  private liveOwnerAtPath(filePath: string): string | undefined {
    return (
      this.identity.idFor(filePath) ??
      [...this.snap.notes].find(([, meta]) => meta.filePath === filePath)?.[0]
    )
  }

  /** Read-through preview: a hit answers from memory (<1ms); a cold one
   *  prefers the storage fast path (readBody capability — a file read, ~ms)
   *  and only falls back to an engine read (which itself caches under the
   *  note's id, so requests by title/path warm the same entry) when the host
   *  has no local files or the file read fails. */
  async preview(id: string, opts?: ReadOptions): Promise<Preview> {
    await this.recoverIdentityForSurface()
    await this.ensureIdentityPublished()
    const hit = this.previewPeek(id)

    if (hit) {
      return hit
    }
    const fromFile = await this.mutations.runStable(
      () => {
        const currentId = this.canonicalMutationId(id)

        return {
          noteIds: [currentId],
          paths: [this.snap.notes.get(currentId)?.filePath],
        }
      },
      () => this.previewCache.fromFile(this.canonicalMutationId(id)),
    )

    if (fromFile) {
      await this.ensureIdentityPublished()
      return fromFile
    }
    const detail = await this.read(id, opts)
    const key = detail.id || id
    const preview =
      this.previewCache.get(key) ?? derivePreview(detail.content, detail.frontmatter?.tags)

    await this.ensureIdentityPublished()
    return preview
  }

  /** One batch (POST /api/previews): warm hits answer inline, cold ones derive
   *  sequentially, and the caller's abort stops the sweep between items — a
   *  request the client walked away from stops costing engine time. */
  async previews(ids: readonly string[], opts?: ReadOptions): Promise<Record<string, Preview>> {
    const out: Record<string, Preview> = {}

    for (const id of ids) {
      if (opts?.signal?.aborted) {
        break
      }
      const hit = this.previewPeek(id)

      if (hit) {
        out[id] = hit
        continue
      }
      try {
        out[id] = await this.preview(id, opts)
      } catch {
        // an unresolvable id must not sink the batch — absence is the answer
      }
    }

    return out
  }

  /** Cache-only peek (the inline `?preview=1` decoration of a notes window):
   *  warm value or null, never an engine read. A hit refreshes LRU recency. */
  previewPeek(id: string): Preview | null {
    if (
      this.activeIdentityPublications !== 0 ||
      this.durableIdentityPublicationRevision < this.identityPublicationRevision
    ) {
      return null
    }

    return this.previewCache.peek(id)
  }

  // ── directory channel — folders are first-class, even empty ones ──────

  /** Pass-through to the engine's directory walk: the tree skeleton unions this
   *  with the note-derived folders so empty folders (a marked-but-empty project,
   *  a "New folder") show. Not snapshot-cached — folders change rarely and the
   *  /tree surface is not a per-keystroke path. */
  async listDirs(): Promise<string[]> {
    // Serve the cached set — never the engine — so /tree (and every /tree/children
    // expand) is a memory read, not an FS walk awaiting the scan (cold-boot
    // stall). Wait only for the cheap phase-1 barrier, like list(); a failed boot
    // falls back to the engine.
    await this.ensureNotes()
    if (this.isServingLive || !this.directoryInventoryReady) {
      return (await this.inner.listDirs?.()) ?? []
    }

    return this.dirs.list()
  }

  /** Run a snapshot patch as soon as phase 1 has data to patch. Mutations are
   *  never delayed by this — the engine call already finished; only the
   *  snapshot bookkeeping waits for the inventory to exist. */
  private afterNotesReady(patch: () => void): void {
    if (this.phase !== SCAN_PHASE.cold) {
      patch()
      return
    }
    void this.notesBarrier.then(() => {
      if (!this.isServingLive) {
        patch()
      }
    })
  }

  /** Re-resolve every user-graph source after directory inventory or folder
   *  aliases change. Hidden classes never participate in this resolver context,
   *  so reading their bodies is both wasted work and a visibility footgun. A bulk
   *  bracket defers the corpus pass and holds graph readers behind one transition
   *  barrier; endBulk publishes exactly one coherent repair. */
  private async rederiveGraphContext(): Promise<void> {
    if (this.bulk.isActive) {
      for (const id of this.snap.notes.keys()) {
        if (this.snap.isGraphVisibleId(id)) {
          this.bulkGraphContextSources.add(id)
        }
      }
      if (this.bulkGraphContextSources.size) {
        this.releaseBulkGraphTransition ??= this.beginGraphTransition()
      }

      return
    }

    await this.rederiveSourceEdges(
      [...this.snap.notes.keys()].filter((id) => this.snap.isGraphVisibleId(id)),
    )
  }

  private async flushBulkGraphContext(): Promise<void> {
    if (!this.bulkGraphContextSources.size) {
      return
    }

    try {
      await this.mutations.run({ global: true }, async () => {
        while (this.bulkGraphContextSources.size) {
          const sourceIds = [...this.bulkGraphContextSources]
          this.bulkGraphContextSources.clear()
          await this.rederiveSourceEdges(sourceIds)
        }
      })
    } catch (err) {
      console.error('[cached-store] bulk graph-context rebuild failed:', (err as Error).message)
      this.reconcileSoon()
    } finally {
      this.releaseBulkGraphTransition?.()
      this.releaseBulkGraphTransition = null
      this.bulkGraphContextSources.clear()
    }
  }

  private abandonBulkGraphContext(): void {
    this.bulkGraphContextSources.clear()
    this.releaseBulkGraphTransition?.()
    this.releaseBulkGraphTransition = null
  }

  /** Re-derive the selected source notes from their live bodies after a target
   *  disappears. The edge cache is intentionally lossy (duplicate target edges are
   *  collapsed), so it cannot reconstruct whether the author wrote a human forward
   *  reference, a stable-id envelope, or both. A source-body read is the smallest
   *  authoritative repair; if one cannot be read, repair only that source from the
   *  engine's fresh graph so unrelated writers remain concurrent. */
  private async rederiveSourceEdges(rawSourceIds: readonly string[]): Promise<void> {
    const sourceIds = [
      ...new Set(rawSourceIds.map((sourceId) => this.canonicalMutationId(sourceId))),
    ].filter((sourceId) => this.snap.notes.has(sourceId))

    if (!sourceIds.length) {
      return
    }
    this.syncInnerLinkIdentities()
    const index = this.snap.buildIndex()
    const baselineSources: string[] = []

    for (const sourceId of sourceIds) {
      const meta = this.snap.notes.get(sourceId)

      if (!meta) {
        continue
      }
      const storageKey = supportsExactIdentityAddress(this.inner)
        ? encodeWikilinkIdentity(sourceId)
        : (this.identity.pathFor(sourceId) ?? meta.filePath)

      try {
        const detail = await this.inner.read(
          storageKey,
          supportsExactIdentityAddress(this.inner) ? { identityOnly: true } : undefined,
        )

        this.snap.patchNoteEdges(sourceId, detail.content, {
          index,
          deferReresolve: true,
        })
      } catch {
        // Never retain an edge whose meaning changed with the vanished target.
        // The fresh graph below can restore this bucket without guessing.
        this.snap.edgesBySource.delete(sourceId)
        baselineSources.push(sourceId)
      }
    }

    if (!baselineSources.length) {
      this.snap.reresolveGhosts(index)
      return
    }

    try {
      // The removed id must leave the bare engine's exact-link registry BEFORE it
      // derives the fallback graph; otherwise a stable envelope still resolves to
      // the vanished path and is downgraded to a creatable human ghost.
      this.syncInnerLinkIdentities()
      this.snap.adoptSourceEdgeBaseline(
        await this.inner.graph(),
        baselineSources,
        this.inner.capabilities.identity,
      )
      this.snap.reresolveGhosts(this.snap.buildIndex())
    } catch (err) {
      console.error(
        '[cached-store] graph re-derivation after target removal failed:',
        (err as Error).message,
      )
      this.reconcileSoon()
    }
  }

  /** A physical delete and its async inbound-edge re-derivation publish as one
   *  graph transition. Concurrent transitions share the barrier; the last one
   *  opens it. Snapshot reads are synchronous after their await, so a transition
   *  cannot interleave between the barrier check and graph shaping. */
  private beginGraphTransition(): () => void {
    if (this.graphTransitions++ === 0) {
      this.graphTransitionDone = new Promise<void>((resolve) => {
        this.openGraphTransition = resolve
      })
    }
    let released = false

    return () => {
      if (released) {
        return
      }
      released = true
      this.graphTransitions--
      if (this.graphTransitions === 0) {
        this.openGraphTransition?.()
        this.openGraphTransition = null
      }
    }
  }

  /** Run an async fresh-graph read against one stable transition generation.
   *  Waiting only once is insufficient: a delete can start while inner.graph()
   *  itself is awaiting. In that case discard the hybrid result, join the new
   *  barrier and retry from the coherent post-state. */
  private async readAcrossStableGraphTransition<T>(read: () => Promise<T>): Promise<T> {
    for (;;) {
      const barrier = this.graphTransitionDone

      await barrier
      if (barrier !== this.graphTransitionDone) {
        continue
      }
      const result = await read()

      if (barrier === this.graphTransitionDone && this.graphTransitions === 0) {
        return result
      }
    }
  }

  // ── revision journal surface ──────────────────────────────────────────

  // ── history + trash — delegated to HistorySurface ────────────────────

  private async readIdentitySurface<T>(read: () => Promise<T>): Promise<T> {
    await this.recoverIdentityForSurface()
    await this.ensureIdentityPublished()
    const result = await read()

    await this.ensureIdentityPublished()
    return result
  }

  revisions(noteId: string, opts: { offset: number; limit: number }) {
    return this.readIdentitySurface(() => this.trash.revisions(noteId, opts))
  }

  latestRevisions(noteIds: readonly string[]) {
    return this.readIdentitySurface(() => this.trash.latestRevisions(noteIds))
  }

  revision(noteId: string, revisionId: string) {
    return this.readIdentitySurface(() => this.trash.revision(noteId, revisionId))
  }

  revisionsSince(sinceRevId: string | null, limit: number) {
    return this.readIdentitySurface(() => this.trash.revisionsSince(sinceRevId, limit))
  }

  activity(opts: {
    from: string
    to: string
    tzOffsetMinutes: number
    scope?: ReadScope
    author?: AuthorFilter
  }) {
    return this.readIdentitySurface(() => this.trash.activity(opts))
  }

  activityEvents(opts: {
    from?: string
    to?: string
    offset: number
    limit: number
    scope?: ReadScope
    author?: AuthorFilter
  }) {
    return this.readIdentitySurface(() => this.trash.activityEvents(opts))
  }

  activityByNote(opts: { from: string; to: string; scope?: ReadScope }) {
    return this.readIdentitySurface(() => this.trash.activityByNote(opts))
  }

  restore(input: RestoreInput) {
    return this.trash.restore(input)
  }

  listTrashed(opts: { offset: number; limit: number; q?: string; scope?: ReadScope }) {
    return this.readIdentitySurface(() => this.trash.listTrashed(opts))
  }

  restoreFromTrash(id: string, opts?: { principal?: string }) {
    return this.runMutationScope(() => this.trash.restoreFromTrash(id, opts))
  }

  restoreTrash(opts: {
    ids?: readonly string[]
    all?: boolean
    q?: string
    onlyRestorable?: boolean
    scope?: ReadScope
    principal?: string
  }) {
    return this.runMutationScope(() => this.trash.restoreTrash(opts))
  }

  purgeTrash(opts: { ids?: readonly string[]; all?: boolean; q?: string; scope?: ReadScope }) {
    return this.trash.purgeTrash(opts)
  }

  // ── mutations — delegated to WriteEngine ───────────────────────

  write(input: WriteInput, opts?: MutationOptions): Promise<WriteResult> {
    return this.runMutation(() => this.writes.write(this.canonicalWriteInput(input), opts))
  }

  private writeAdmitted(input: WriteInput, opts?: MutationOptions): Promise<WriteResult> {
    return this.writes.write(this.canonicalWriteInput(input), opts)
  }

  private async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const releaseIntent = await this.mutationAdmission.acquire('mutation')
    let intentReleased = false

    try {
      await this.ensureMutationReady()
      const pending = operation()

      // WriteEngine registers its storage/trash claim synchronously before the
      // returned promise yields. Hand admission to the waiting read/reconcile
      // cohort now; the fair resource coordinator, not this coarse identity
      // gate, orders the actual I/O and preserves independent-note throughput.
      releaseIntent()
      intentReleased = true
      return await pending
    } finally {
      if (!intentReleased) {
        releaseIntent()
      }
    }
  }

  /** Trash restore performs journal work before it reaches the nested storage
   *  write. Keep its mutation intent for the whole trash lease so a background
   *  raw-body read cannot take admission and then wait on that lease while the
   *  restore waits to enter its write path (admission → trash → storage). */
  private async runMutationScope<T>(operation: () => Promise<T>): Promise<T> {
    const releaseIntent = await this.mutationAdmission.acquire('mutation')

    try {
      await this.ensureMutationReady()
      return await operation()
    } finally {
      releaseIntent()
    }
  }

  private canonicalWriteInput(input: WriteInput): WriteInput {
    return {
      ...input,
      id: input.id ? this.canonicalMutationId(input.id) : input.id,
      originalId: input.originalId ? this.canonicalMutationId(input.originalId) : input.originalId,
    }
  }

  move(input: MoveInput, opts?: MutationOptions): Promise<void> {
    return this.runMutation(() =>
      this.writes.move({ ...input, id: this.canonicalMutationId(input.id) }, opts),
    )
  }

  remove(
    id: string,
    opts?: {
      principal?: string
      agent?: AgentWriteAttribution
    },
  ): Promise<void> {
    return this.runMutation(() => this.writes.remove(this.canonicalMutationId(id), opts))
  }

  private canonicalMutationId(id: string): string {
    const seen = new Set<string>()
    let current = id

    while (!seen.has(current)) {
      seen.add(current)
      const next = this.supersededIds.get(current)

      if (!next) {
        return current
      }
      current = next
    }

    return current
  }

  // ── delta feed ──────────────────────────────────────────────────────────────

  async changes(cursor: string | null): Promise<StoreDelta> {
    return this.inner.changes(cursor)
  }

  /** Run one delta poll now (or a boot-scan retry when the store is in
   *  'error'). The periodic timer calls this; hosts and tests may too. */
  reconcile(): Promise<void> {
    return this.poll()
  }

  /** One-shot near-future reconcile, for mutations whose snapshot effect we
   *  don't model precisely (directory moves, writes with no reported path). */
  private reconcileSoon(): void {
    if (this.reconcileTimer || this.stopped) {
      return
    }
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      void this.poll()
    }, RECONCILE_DELAY_MS)
    this.reconcileTimer.unref?.()
  }

  /** Periodic tick: pull the engine's delta and reconcile the snapshot. While
   *  the store is in 'error' the tick retries the whole boot scan instead.
   *  A strict caller joins any active best-effort pass, then performs its own
   *  delta cut and propagates failure — the online-backup checkpoint contract. */
  private async poll(strict = false): Promise<void> {
    if (this.polling) {
      await this.pollDone
      if (strict) {
        await this.poll(true)
      }

      return
    }
    if (this.stopped) {
      if (strict) {
        throw new Error('cannot checkpoint a stopped store')
      }

      return
    }
    // Bulk import: our own write-through already keeps the snapshot live, so the delta poll
    // is pure (and expensive) redundant work during a bulk run — suspend it; endBulk fires one
    // catch-up poll. Tradeoff: an external edit during a huge import is observed only after it ends.
    if (this.bulk.isActive) {
      if (strict) {
        throw new Error('cannot checkpoint while a bulk mutation is active')
      }

      return
    }
    this.polling = true
    this.pollDone = new Promise((resolve) => {
      this.openPollDone = resolve
    })
    let releaseMutationAdmission: (() => void) | undefined
    let releaseIdentityPublication: (() => void) | undefined
    let identityBefore: Set<string> | null = null

    try {
      if (this.phase === SCAN_PHASE.error) {
        if (this.identityLoadError) {
          await this.loadIdentityAndBoot(true)
          if (!strict || this.identityLoadError) {
            return
          }
        }
        // A late graph failure did not invalidate the already-quiesced
        // inventory. Retry only enrichment: do not reblock writes or merge a
        // second full-list snapshot over admitted mutations.
        if (this.mutationInventoryReady) {
          if (!strict) {
            await this.finishBootGraph(this.bootGeneration, true)

            return
          }
          // A backup does not need the derived graph, but it DOES need one fresh
          // delta cut. Fall through with the last authoritative inventory.
        } else {
          this.resetBarrier()
          this.mutationInventoryReady = false
          this.directoryInventoryReady = false
          this.resetMutationBarrier()
          // A failed phase-1/full-list attempt may already have populated part
          // of the derived snapshot. The new seed is authoritative; rebuild from
          // empty or a deletion during the error interval can survive forever.
          this.snap.clear()
          this.previewCache.clear()
          this.graphCache.reset()
          this.dirs.clear()
          this.supersededIds.clear()
          this.externalTransitions.clear()
          this.cursor = null
          await this.bootScan()
          if (!strict) {
            return
          }
          if (!this.mutationInventoryReady) {
            throw new Error(`file-truth reconciliation unavailable: ${this.scanError ?? 'unknown'}`)
          }
        }
      }
      if (this.phase === SCAN_PHASE.cold || this.phase === SCAN_PHASE.notes) {
        if (strict) {
          throw new Error(`file-truth reconciliation unavailable during ${this.phase} scan`)
        }

        return
      } // boot owns the snapshot now
      // Close admission before the first reconcile await. Operations already
      // admitted have synchronously queued their main claim and run first;
      // later callers wait until provisional ids have been swept and published.
      releaseMutationAdmission = await this.acquireMutationAdmissionBlock()
      if (this.stopped) {
        if (strict) {
          throw new Error('cannot checkpoint a stopped store')
        }

        return
      }
      identityBefore = new Set(this.snap.notes.keys())
      const changed = await this.mutations.run({ global: true }, async () => {
        // Pull path-history only after the global claim has waited for an older
        // folder move's storage/finalize lease. Reading it before the claim can
        // cache the pre-move aliases and then apply the post-move delta with
        // stale resolution state.
        const aliasesChanged = await this.refreshFolderAliases()

        if (this.stopped) {
          if (strict) {
            throw new Error('cannot checkpoint a stopped store')
          }

          return false
        }
        const delta = await this.inner.changes(this.cursor)

        if (this.stopped) {
          if (strict) {
            throw new Error('cannot checkpoint a stopped store')
          }

          return false
        }
        const releaseGraphTransition = this.beginGraphTransition()

        try {
          // applyDelta is the first synchronous point that can put an external
          // provisional id into the snapshot. Close the producer lease and
          // register its durable cut before that mutation — in particular before
          // the following listDirs await.
          releaseIdentityPublication = this.beginIdentityPublication()
          this.markIdentityPublicationPending()
          const result = this.applyDelta(delta)
          const directoriesChanged = await this.refreshDirectoryInventory()

          if (result.changed) {
            this.markInnerLinkIdentitiesDirty()
          }

          this.cursor = delta.cursor
          this.lastPollAt = this.iso()
          // The provisional post-delta axis is now complete. Make it durable
          // before opening the listDirs window's producer lease; the slower
          // body sweep may then expose this old-but-routable P while it reads,
          // and closes a new revision synchronously if it actually adopts D.
          await this.flushIdentityPublication()
          releaseIdentityPublication()
          releaseIdentityPublication = undefined
          // Do not admit a mutation or publish a changed event while an external
          // file still has its provisional registry id. The frontmatter sweep
          // and all journal/trash claims below use the final identity.
          const identitySweep = await this.sweepFileIds(result.sweepPaths)

          const identityResolutions: Promise<void>[] = []
          const readEffects: ReadEffects = { rekeyed: [], changedIds: new Set() }

          for (const observation of result.externalObservations) {
            const { identityResolution } = await this.admitExternalObservation(
              observation,
              identitySweep.unresolvedPaths.has(observation.filePath),
              readEffects,
            )

            if (identityResolution) {
              identityResolutions.push(identityResolution)
            }
          }
          const rederiveSources =
            directoriesChanged || aliasesChanged
              ? [...this.snap.notes.keys()].filter((id) => this.snap.isGraphVisibleId(id))
              : result.rederiveSources

          if (rederiveSources.length) {
            await this.rederiveSourceEdges(rederiveSources)
          }
          for (const [rawId, title, filePath] of result.removedTitles) {
            this.scheduleExternalDelete(rawId, title, filePath, identityResolutions)
          }

          const rekeyed = [...identitySweep.rekeyed, ...readEffects.rekeyed]
          const didChange =
            result.changed ||
            directoriesChanged ||
            aliasesChanged ||
            rekeyed.length > 0 ||
            readEffects.changedIds.size > 0

          if (didChange) {
            this.markInnerLinkIdentitiesDirty()
            this.syncInnerLinkIdentities()
            const newlyAdded = new Set(result.newlyAdded)
            const rekeyedRemoved = rekeyed
              .map(([oldId]) => oldId)
              .filter((oldId) => !newlyAdded.has(oldId))
            const rekeyedRemovedSet = new Set(rekeyedRemoved)
            const upserts = [
              ...new Set([
                ...result.upserted.map((id) => this.canonicalMutationId(id)),
                ...rekeyed.map(([, newId]) => newId),
                ...[...readEffects.changedIds].map((id) => this.canonicalMutationId(id)),
              ]),
            ].filter((id) => this.snap.notes.has(id))
            const upsertSet = new Set(upserts)
            const removed = [
              ...new Set([
                ...result.removed.map((id) => this.canonicalMutationId(id)),
                ...rekeyedRemoved,
              ]),
            ].filter((id) => !upsertSet.has(id) || rekeyedRemovedSet.has(id))

            this.lastChangeAt = this.iso()
            this.emit({ type: 'changed', upserts, removed })
          }

          return didChange
        } finally {
          releaseGraphTransition()
        }
      })

      if (changed) {
        this.lastPollChangeAt = this.iso()
      }
      await this.refreshEngineStatus()
      if (this.stopped && strict) {
        throw new Error('cannot checkpoint a stopped store')
      }
      this.emitStatus()
    } catch (err) {
      if (
        identityBefore &&
        this.durableIdentityPublicationRevision < this.identityPublicationRevision
      ) {
        this.rememberIdentityRepair(identityBefore)
      }
      console.error('[cached-store] delta poll failed:', (err as Error).message)
      if (strict) {
        throw err
      }
    } finally {
      releaseIdentityPublication?.()
      releaseMutationAdmission?.()
      this.polling = false
      this.openPollDone()
    }
  }

  /** Returns whether the delta actually moved the snapshot, which paths
   *  deserve a frontmatter id sweep (new or externally edited files), and the
   *  removed notes' titles (poll journals them as deletes after the sweep
   *  rules out external moves). */
  private applyDelta(delta: StoreDelta): {
    changed: boolean
    upserted: string[]
    removed: string[]
    sweepPaths: string[]
    removedTitles: Array<[string, string, string]>
    externalObservations: ExternalObservation[]
    newlyAdded: string[]
    rederiveSources: string[]
  } {
    const upserted = new Set<string>()
    const removed: string[] = []
    const sweepPaths = new Set<string>()
    const removedTitles: Array<[string, string, string]> = []
    const externalObservations: ExternalObservation[] = []
    const newlyAdded = new Set<string>()
    const rederiveSources = new Set<string>()

    const inventory = new Map<string, NoteMeta & { id: string }>()

    for (const m of delta.inventory) {
      const adopted = this.adoptMeta(m)
      inventory.set(adopted.id, adopted)
    }
    for (const [id, meta] of [...this.snap.notes]) {
      if (inventory.has(id)) {
        continue
      }
      for (const sourceId of this.snap.sourceIdsTargeting([id])) {
        rederiveSources.add(sourceId)
      }
      this.snap.notes.delete(id)
      this.snap.edgesBySource.delete(id)
      this.previewCache.delete(id)
      // Tombstoned, not forgotten: if this was an external move, the new
      // path's frontmatter claim re-adopts the id in the sweep that follows.
      this.identity.markDeleted(meta.filePath)
      removed.push(id)
      removedTitles.push([id, meta.title, meta.filePath])
    }
    for (const [id, meta] of inventory) {
      const prev = this.snap.notes.get(id)
      // The snapshot's modifiedAt may be precise (a write stamp or a journal
      // upgrade) while the engine's is day-granular — compare days, or every
      // poll would look like a change and downgrade the precision.
      const sameDay = (prev?.modifiedAt ?? '').slice(0, 10) === (meta.modifiedAt ?? '').slice(0, 10)
      const changed = !prev || prev.title !== meta.title || !sameDay

      if (!prev) {
        newlyAdded.add(id)
      }
      if (changed) {
        upserted.add(id)
        sweepPaths.add(meta.filePath)
        // An external add/move into a new folder joins the directory channel.
        // (External folder DELETEs that leave no note ghost until the next boot —
        // the same eventual-to-boot cadence as the marker reconcile; never-prune
        // makes "emptied" vs "removed" indistinguishable without a re-walk.)
        this.dirs.add(directoryOf(meta.filePath))
      }
      this.snap.notes.set(id, {
        ...meta,
        // Union the engine's file-truth aliases with the journal backfill:
        // a bare `{ ...meta }` would drop a legacy note's snapshot-only aliases
        // every poll (the engine's inventory omits them), re-ghosting the heal.
        aliases: this.snap.aliasesFor(id, meta.aliases, meta.title),
        modifiedAt: changed ? this.preciseStamp(meta.modifiedAt) : (prev?.modifiedAt ?? null),
        // Keep the first-seen creation date: the engine may bump its createdAt
        // on a reindex, and "when was this written" shouldn't move because the
        // note got edited.
        createdAt: prev?.createdAt ?? meta.createdAt ?? null,
      })
    }

    // Build the link index ONCE for the whole batch: every note is already
    // in this.snap.notes (the inventory loop above set them), so a single index serves
    // all upserts — patchNoteEdges per note then costs O(content), not O(N), and
    // ghosts re-resolve once after the loop. This is what keeps a large delta (a
    // post-import catch-up, a cold reconcile) from being an O(N²) freeze.
    const batchIndex = this.snap.buildIndex()

    for (const { meta, content, tags } of delta.upserts) {
      const adopted = this.adoptMeta(meta)
      const id = adopted.id
      const prev = this.snap.notes.get(id)

      if (!inventory.has(id) && !prev) {
        continue
      } // already gone again
      // The upsert itself is the exact external-change signal. Sweep identity
      // even when day-granular modifiedAt and title look unchanged: same-day
      // frontmatter edits must not be journaled under the previous id.
      sweepPaths.add(adopted.filePath)
      // An external change invalidates the preview rather than updating it:
      // the delta body lacks the frontmatter tags, and a half-fresh snippet
      // (new text, stale chips) is worse than a lazy recompute on next view.
      this.previewCache.delete(id)
      this.snap.notes.set(id, {
        ...(this.snap.notes.get(id) ?? adopted),
        title: adopted.title,
        filePath: adopted.filePath,
        slug: adopted.slug, // track an external slug change (file-truth)
        aliases: this.snap.aliasesFor(id, adopted.aliases, adopted.title),
        createdAt: prev?.createdAt ?? adopted.createdAt ?? null,
      })
      const observed = this.snap.notes.get(id)!
      const transition = this.nextExternalTransition(id)

      if (typeof content === 'string') {
        // A removal may have queued this source for a live-body re-derivation,
        // but an explicit body in the same delta is newer and authoritative.
        // Letting the later re-derive read the engine here can resurrect its
        // pre-delta body and overwrite the edge patch we are about to apply.
        rederiveSources.delete(id)
        if (this.snap.patchNoteEdges(id, content, { index: batchIndex, deferReresolve: true })) {
          upserted.add(id)
        }
        // The external state goes to the journal as observed. The
        // journal dedupes by content identity, so the delta echoing our own
        // write back (a reindex re-surfaces everything we touch) records nothing.
        externalObservations.push({
          noteId: id,
          filePath: adopted.filePath,
          title: adopted.title,
          content,
          tags,
          transition,
          meta: observed,
        })
      } else {
        upserted.add(id)
        // The engine couldn't hand the body over cheaply — fetch it on the
        // background lane so the history stays full; only a failed read
        // leaves an honest gap marker.
        externalObservations.push({
          noteId: id,
          filePath: adopted.filePath,
          title: adopted.title,
          content: undefined,
          tags: undefined,
          transition,
          meta: observed,
        })
      }
    }

    // Re-resolve ghosts ONCE for the whole batch (the per-note patchNoteEdges
    // deferred it): a forward [[link]] to a note that landed later in this same
    // delta now retargets, in one O(ghosts) pass instead of one per note.
    const ghostsResolved = this.snap.reresolveGhosts(batchIndex)

    if (upserted.size || removed.length || ghostsResolved) {
      this.lastChangeAt = this.iso()
      return {
        changed: true,
        upserted: [...upserted],
        removed,
        sweepPaths: [...sweepPaths],
        removedTitles,
        externalObservations,
        newlyAdded: [...newlyAdded],
        rederiveSources: [...rederiveSources],
      }
    }

    return {
      changed: false,
      upserted: [],
      removed: [],
      sweepPaths: [...sweepPaths],
      removedTitles,
      externalObservations,
      newlyAdded: [...newlyAdded],
      rederiveSources: [...rederiveSources],
    }
  }

  private async admitExternalObservation(
    observation: ExternalObservation,
    identityUnchecked = false,
    readEffects?: ReadEffects,
  ): Promise<ExternalAdmission> {
    let title = observation.title
    let content = observation.content
    let tags = observation.tags
    let identityUnresolved = false

    // If the raw-body sweep could not materialize this identity, read once
    // while the poll still owns the main checkpoint. Besides obtaining history
    // content, this adopts frontmatter identity before choosing a trash resource.
    const unresolvedId = this.canonicalMutationId(observation.noteId)

    if (
      !this.inner.capabilities.identity &&
      (identityUnchecked ||
        (unresolvedId === observation.noteId &&
          this.identity.recordFor(unresolvedId)?.materialized !== true))
    ) {
      try {
        const detail = await this.readClaimed(
          observation.noteId,
          { background: true },
          readEffects,
          true,
        )

        title = detail.title ?? title
        content ??= detail.content
        tags ??= normTags(detail.frontmatter?.tags) ?? undefined
      } catch {
        identityUnresolved = true
      }
    }
    const noteId = this.canonicalMutationId(observation.noteId)

    if (
      !this.promoteExternalTransition(observation.noteId, noteId, observation.transition) ||
      this.snap.notes.get(noteId)?.filePath !== observation.filePath
    ) {
      return {}
    }
    const meta = { ...(this.snap.notes.get(noteId) ?? observation.meta), id: noteId }

    if (identityUnresolved) {
      return {
        identityResolution: this.fetchExternalBody(
          noteId,
          title,
          meta,
          observation.transition,
          content,
          tags,
        ),
      }
    }
    if (content !== undefined) {
      this.journalExternal(noteId, title, content, meta, observation.transition, tags)
      return {}
    }
    this.fetchExternalBody(noteId, title, meta, observation.transition)
    return {}
  }

  private scheduleExternalDelete(
    rawId: string,
    title: string,
    filePath: string,
    identityResolutions: readonly Promise<void>[],
  ): void {
    this.trackExternalTask(
      Promise.all(identityResolutions).then(async () => {
        const id = this.canonicalMutationId(rawId)

        if (this.identity.pathFor(id) || this.snap.notes.has(id)) {
          return
        }
        const transition = this.nextExternalTransition(id)

        await this.trashMutations.run({ paths: [trashMutationPath(id)] }, () =>
          this.mutations.run({ noteIds: [id], paths: [filePath] }, async () => {
            if (
              !this.isCurrentExternalTransition(id, transition) ||
              this.identity.pathFor(id) ||
              this.snap.notes.has(id)
            ) {
              return
            }
            await this.journal.record({
              noteId: id,
              kind: REVISION_KIND.delete,
              principal: null,
              content: null,
              title,
            })
          }),
        )
      }),
    )
  }

  private journalExternal(
    noteId: string,
    title: string,
    content: string | null,
    observed: NoteMeta,
    transition: number,
    tags?: string[],
  ): void {
    this.trackExternalTask(
      this.trashMutations.run({ paths: [trashMutationPath(noteId)] }, () =>
        this.mutations.run({ noteIds: [noteId], paths: [observed.filePath] }, () =>
          this.recordExternalClaimed(noteId, title, content, observed, transition, tags),
        ),
      ),
    )
  }

  private async recordExternalClaimed(
    noteId: string,
    title: string,
    content: string | null,
    observed: NoteMeta,
    transition: number,
    tags?: string[],
  ): Promise<void> {
    const live = this.snap.notes.get(noteId)

    if (
      !this.isCurrentExternalTransition(noteId, transition) ||
      !live ||
      live.filePath !== observed.filePath
    ) {
      return
    }
    // A stored (non-deduped) revision proves the content really changed —
    // that's the precise-modifiedAt channel for same-day external edits the
    // day-granular inventory diff can't see. Reindex echoes of our own
    // writes dedupe inside the journal and bump nothing.
    const rev = await this.journal.record({
      noteId,
      kind: REVISION_KIND.external,
      principal: null,
      content,
      title,
      class: observed.class,
      // The observed snapshot entry is file-truth for this transition: record
      // its slug definitively (null = no custom slug), including clears.
      slug: observed.slug ?? null,
      tags,
    })

    if (
      rev &&
      this.isCurrentExternalTransition(noteId, transition) &&
      this.snap.notes.get(noteId)?.filePath === observed.filePath
    ) {
      this.bumpModified(noteId, rev.createdAt)
    }
  }

  /** Body chase for a delta upsert that arrived content-less: a background
   *  read (it also heals edges/preview via the normal read path), then the
   *  journal; a failure records the gap explicitly — "external change, body
   *  unknown" — instead of silently dropping the event. */
  private fetchExternalBody(
    noteId: string,
    title: string,
    observed: NoteMeta,
    transition: number,
    preferredContent?: string,
    preferredTags?: string[],
  ): Promise<void> {
    const trashClaim = !this.inner.capabilities.identity
      ? { prefixes: [TRASH_MUTATION_PREFIX] }
      : { paths: [trashMutationPath(noteId)] }

    const task = async () => {
      const releaseAdmission = !this.inner.capabilities.identity
        ? await this.acquireMutationAdmissionBlock()
        : undefined

      try {
        await this.trashMutations.run(trashClaim, () =>
          this.mutations.runStable(
            () => {
              const currentId = this.canonicalMutationId(noteId)

              return !this.inner.capabilities.identity
                ? { global: true }
                : { noteIds: [currentId], paths: [observed.filePath] }
            },
            async () => {
              let currentId = this.canonicalMutationId(noteId)

              if (
                currentId !== noteId &&
                !this.promoteExternalTransition(noteId, currentId, transition)
              ) {
                return
              }
              if (
                !this.isCurrentExternalTransition(currentId, transition) ||
                this.snap.notes.get(currentId)?.filePath !== observed.filePath
              ) {
                return
              }
              try {
                const detail = await this.readClaimed(
                  currentId,
                  { background: true },
                  undefined,
                  true,
                )
                const finalId = this.canonicalMutationId(currentId)

                if (finalId !== currentId) {
                  if (this.promoteExternalTransition(currentId, finalId, transition)) {
                    const live = this.snap.notes.get(finalId)

                    if (live?.filePath === observed.filePath) {
                      this.journalExternal(
                        finalId,
                        detail.title ?? title,
                        preferredContent ?? detail.content,
                        live,
                        transition,
                        preferredTags ?? normTags(detail.frontmatter?.tags) ?? undefined,
                      )
                    }
                  }

                  return
                }
                currentId = finalId
                await this.recordExternalClaimed(
                  currentId,
                  detail.title ?? title,
                  preferredContent ?? detail.content,
                  this.snap.notes.get(currentId) ?? observed,
                  transition,
                  preferredTags ?? normTags(detail.frontmatter?.tags) ?? undefined,
                )
              } catch {
                await this.recordExternalClaimed(
                  currentId,
                  title,
                  preferredContent ?? null,
                  this.snap.notes.get(currentId) ?? observed,
                  transition,
                  preferredTags,
                )
              }
            },
          ),
        )
      } finally {
        releaseAdmission?.()
      }
    }

    return this.trackExternalTask(task())
  }

  private trackExternalTask(task: Promise<unknown>): Promise<void> {
    const tracked = task
      .then(
        () => undefined,
        (err) =>
          console.error('[cached-store] external journal task failed:', (err as Error).message),
      )
      .finally(() => this.externalTasks.delete(tracked))
    this.externalTasks.add(tracked)
    return tracked
  }

  private async drainExternalTasks(): Promise<void> {
    while (this.externalTasks.size) {
      await Promise.all([...this.externalTasks])
    }
  }

  /** Freeze current trash producers, then cross the main queue. An active poll
   *  has either stopped before its checkpoint or registered every external task
   *  by the time this returns. Release the prefix before awaiting those tasks,
   *  because they themselves need exact trash leases. */
  private async drainBeforeInnerStop(): Promise<void> {
    await Promise.all([this.bootTask.catch(() => {}), this.pollDone.catch(() => {})])
    await this.mutationAdmission.settle()
    await this.trashMutations.run({ prefixes: [TRASH_MUTATION_PREFIX] }, () =>
      this.mutations.run({ global: true }, async () => undefined),
    )
    await this.drainExternalTasks()
    await this.graphCache.settle()
  }

  private nextExternalTransition(noteId: string): number {
    const next = ++this.externalTransitionSequence
    this.externalTransitions.set(noteId, next)
    return next
  }

  private promoteExternalTransition(from: string, to: string, transition: number): boolean {
    if (this.externalTransitions.get(from) !== transition) {
      return false
    }
    if ((this.externalTransitions.get(to) ?? 0) > transition) {
      return false
    }
    if (from !== to) {
      this.externalTransitions.delete(from)
      this.externalTransitions.set(to, transition)
    }

    return true
  }

  private invalidateExternalTransitions(noteIds: Iterable<string>): void {
    for (const id of noteIds) {
      this.nextExternalTransition(id)
    }
  }

  private isCurrentExternalTransition(noteId: string, transition: number): boolean {
    return this.externalTransitions.get(noteId) === transition
  }

  /** Drop the whole snapshot and rebuild it from the engine. Test/host hook
   *  (the e2e fake's reset re-seeds the inner store and rescans); production
   *  never needs it — the delta feed reconciles. */
  async rescan(): Promise<void> {
    await this.trashMutations.run({ prefixes: [TRASH_MUTATION_PREFIX] }, async () => {
      // Acquire the trash prefix before closing write admission. A restore
      // already holding an exact trash lease must be allowed to reach its
      // storage write and release; reversing these two steps deadlocks on the
      // mutation barrier. Once the prefix is ours, later trash work waits here.
      const generation = ++this.bootGeneration

      this.mutationInventoryReady = false
      this.directoryInventoryReady = false
      this.resetMutationBarrier()
      let inventoryReady = false

      await this.mutations.run({ global: true }, async () => {
        if (generation !== this.bootGeneration) {
          return
        }
        // Repeat inside the authoritative main checkpoint: an older boot may
        // have held the claim when this rescan reserved its generation.
        this.mutationInventoryReady = false
        this.directoryInventoryReady = false
        this.resetBarrier()
        this.snap.clear()
        this.previewCache.clear()
        this.graphCache.reset()
        this.supersededIds.clear()
        this.externalTransitions.clear()
        this.cursor = null
        this.beginBootClaimed()
        try {
          inventoryReady = await this.scanBootInventoryClaimed(generation)
        } catch (err) {
          this.failBoot(err, generation)
        }
      })
      if (inventoryReady && !this.stopped) {
        await this.finishBootGraph(generation)
      }
    })
  }

  // ── status / events ─────────────────────────────────────────────────────────

  async syncStatus(): Promise<SyncStatus> {
    await this.refreshEngineStatus()
    return this.buildStatus()
  }

  /** Re-pull the inner store's engine block (indexed count etc.). Cached so
   *  buildStatus stays synchronous; a failure keeps the last known values —
   *  /api/status must answer from our own state even with the engine down. */
  private async refreshEngineStatus(): Promise<void> {
    try {
      this.engineStatus = (await this.inner.syncStatus()).engine
    } catch (err) {
      console.error('[cached-store] engine status failed:', (err as Error).message)
    }
  }

  /** The variant-A activity heuristic: with no files→index progress to
   *  read, "delta polls keep bringing upserts" IS the engine-busy signal. Until
   *  the first poll there's nothing to infer from — defer to the engine's own
   *  answer (honest 'unknown' when the engine can't say). */
  private engineIndexing(): SyncStatus['engine']['indexing'] {
    if (!this.lastPollAt) {
      return this.engineStatus?.indexing ?? 'unknown'
    }
    if (!this.lastPollChangeAt) {
      return 'idle'
    }
    const busyWindowMs = Math.max(2 * this.pollIntervalMs, 150_000)
    return this.now().getTime() - Date.parse(this.lastPollChangeAt) < busyWindowMs ? 'busy' : 'idle'
  }

  private buildStatus(): SyncStatus {
    // Counts are a user-facing surface — report the VISIBLE population so the
    // status number can't be differenced against /api/tree's filtered total to
    // reveal how many hidden agent-memory notes exist (count side-channel).
    const admitted = classesForScope(READ_SCOPE.user)
    const visibleIds = new Set<string>()

    for (const [id, meta] of this.snap.notes) {
      if (admitted.has(meta.class ?? DEFAULT_NOTE_CLASS)) {
        visibleIds.add(id)
      }
    }
    let links = 0

    for (const [source, edges] of this.snap.edgesBySource) {
      if (visibleIds.has(source)) {
        links += edges.length
      }
    }

    return {
      scan: {
        phase: this.phase,
        startedAt: this.startedAt,
        readyAt: this.readyAt,
        error: this.scanError,
      },
      delta: {
        cursor: this.cursor,
        lastPollAt: this.lastPollAt,
        lastChangeAt: this.lastChangeAt,
        // The effective periodic cadence: the rare backstop while watched,
        // the responsive poll interval otherwise — `watch` says which.
        intervalMs: this.effectiveIntervalMs,
        watch: this.watcher.isActive,
      },
      // Driver-supplied counters ride along; the indexing verdict is ours.
      engine: { ...this.engineStatus, indexing: this.engineIndexing() },
      counts: { notes: visibleIds.size, links },
    }
  }

  private emitStatus(): void {
    this.emit({ type: 'status', status: this.buildStatus() })
  }

  /** An embed-backfill progress tick: trailing-throttle a `status` emit so
   *  a burst of per-note ticks collapses to one frame per INDEX_PROGRESS_THROTTLE_MS.
   *  The first tick schedules; ticks within the window are dropped (the scheduled
   *  emit reads the LATEST engine counters). refreshEngineStatus re-pulls the
   *  cheap in-memory vector block before building the frame. */
  private onIndexProgressTick(): void {
    if (this.stopped || this.indexProgressTimer) {
      return
    }
    this.indexProgressTimer = setTimeout(() => {
      this.indexProgressTimer = null
      void this.refreshEngineStatus().then(() => {
        if (!this.stopped) {
          this.emitStatus()
        }
      })
    }, INDEX_PROGRESS_THROTTLE_MS)
    this.indexProgressTimer.unref?.()
  }

  // Call sites emit `changed` without `folders`; we fill it here from the
  // snapshot so it's computed in ONE place (the upserted notes' current
  // server-truth folders — what a client needs to refresh the destination of a
  // move it can't see in its own cache, multi-client sync).
  private emit(event: EmitInput): void {
    const out: StoreEvent =
      event.type === 'changed'
        ? { ...event, folders: event.folders ?? this.foldersOf(event.upserts) }
        : event

    // Any 'changed' means the snapshot moved — the enriched graph for the
    // previous revision is stale from here on; the background recompute
    // chases it (debounced) so the request path never has to.
    if (out.type === 'changed') {
      this.graphCache.onSnapshotChanged()
      // Bulk import: buffer the ids and broadcast one merged `changed` on a
      // short timer instead of fanning every note out to every subscriber. The
      // graph-refresh debounce above is already re-armed (cheap); only the
      // subscriber fan-out is deferred. Absorbed ⇒ the coalesced flush dispatches later.
      if (this.bulk.absorb(out.upserts, out.removed)) {
        return
      }
    }
    this.dispatch(out)
  }

  /** Fan one event out to every subscriber (the SSE bridge, providers). Separated
   *  from emit so the bulk path can coalesce before reaching it. */
  private dispatch(out: StoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(out)
      } catch (err) {
        console.error('[cached-store] event listener failed:', (err as Error).message)
      }
    }
  }

  /** Distinct current folders of the given note-ids (those still in the
   *  snapshot) — the destinations a `changed` event advertises. */
  private foldersOf(ids: readonly string[]): string[] {
    const set = new Set<string>()

    for (const id of ids) {
      const meta = this.snap.notes.get(id)

      if (meta) {
        set.add(directoryOf(meta.filePath))
      }
    }

    return [...set]
  }

  private iso(): string {
    return this.now().toISOString()
  }

  /** The honest modifiedAt for an engine-signalled change: the engine's
   *  inventory only knows the day, so when that day is today the poll clock is
   *  the better truth (the change happened on our watch, within a poll
   *  interval); an older day — an edit that happened while we were down —
   *  keeps the engine's (midnight) date rather than claiming "now". */
  private preciseStamp(engineModifiedAt: string | null): string | null {
    const now = this.iso()

    if (engineModifiedAt && engineModifiedAt.slice(0, 10) === now.slice(0, 10)) {
      return now
    }

    return engineModifiedAt
  }

  /** Upgrade a note's modifiedAt from a journal append: the journal
   *  deduped reindex echoes away, so a stored revision IS a real change. */
  private bumpModified(noteId: string, at: string): void {
    const meta = this.snap.notes.get(noteId)

    if (!meta || (meta.modifiedAt && meta.modifiedAt >= at)) {
      return
    }
    this.snap.notes.set(noteId, { ...meta, modifiedAt: at })
    this.emit({ type: 'changed', upserts: [noteId], removed: [] })
  }
}
