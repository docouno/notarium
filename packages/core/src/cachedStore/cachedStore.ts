// Read-model decorator over any KnowledgeStore: serves list/recent/graph
// from an in-memory snapshot, kept fresh by write-through + read-refresh + delta
// poll. Search stays a passthrough on purpose — caching FTS would make this a
// shadow engine, the boundary the issue draws. Boot is phased so a cold start
// never hangs (cheap inventory answers first, later sweeps fill dates and edges).
// canon: docs/core.md#read-model · docs/core.md#phased-boot

import { aggregateGraphHealth, type FolderAlias, shapeGraph } from '../graph'
import { IdentityRegistry } from '../identity'
import type {
  ExportEntry,
  Graph,
  GraphHealth,
  KnowledgeStore,
  MoveInput,
  MutationOptions,
  NoteContent,
  NoteMeta,
  Preview,
  ReadOptions,
  ReadScope,
  ReadSurfaceOptions,
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
import { NOTE_ID_FRONTMATTER_KEY } from '../libs/id'
import { frontmatterValue } from '../libs/markdown'
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
} from './consts'
import { BulkController } from './controllers/bulkController'
import { WatchController } from './controllers/watchController'
import { DirectoryIndex } from './helpers/directoryIndex'
import { filterGraphForUser } from './helpers/filterGraph'
import { HistorySurface } from './helpers/historySurface'
import {
  MutationCoordinator,
  TRASH_MUTATION_PREFIX,
  trashMutationPath,
} from './helpers/mutationCoordinator'
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

  /** Bulk-write mode, entered by a streaming import (beginBulk/endBulk) —
   *  coalesces `changed` broadcasts and yields background work (see
   *  {@link BulkController}). Its `isActive` is the mode flag emit/poll/graph-refresh
   *  consult. */
  private readonly bulk: BulkController
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
    this.identity = new IdentityRegistry({ persistence: identityPersistence, space, now })
    this.space = space ?? DEFAULT_SPACE
    this.journal = new RevisionJournal({
      persistence: revisionPersistence ?? new InMemoryRevisionPersistence(),
      space: this.space,
      now,
    })
    this.pollIntervalMs = pollIntervalMs
    this.readBody = readBody
    this.snap = new Snapshot(relationType)
    this.previewCache = new PreviewCache({
      maxSize: previewCacheSize,
      readBody,
      getMeta: (id) => this.snap.notes.get(id),
      innerPeek: (id) => this.inner.previewPeek(id),
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
        emitChanged: (upserts, removed) => this.emit({ type: 'changed', upserts, removed }),
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
      flushIdentity: () => this.identity.flush().catch(() => {}),
      dispatchChanged: (upserts, removed, folders) =>
        this.dispatch({ type: 'changed', upserts, removed, folders }),
      foldersOf: (ids) => this.foldersOf(ids),
      poll: () => void this.poll(),
      refreshGraph: () => this.graphCache.refreshSoon(),
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
        emitChanged: (upserts, removed) => {
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
  private async refreshFolderAliases(): Promise<void> {
    if (!this.folderAliasesPort) {
      return
    }
    try {
      this.snap.folderAliases = await this.folderAliasesPort()
      // Feed the engine too: its boot/rebuild graph then resolves a
      // path-form `[[oldpath/note]]` to a renamed folder's note even when the
      // filename is ambiguous — the read-model alone can only heal GHOSTS (it has
      // no link label to re-resolve an already-resolved-but-wrong edge), so the
      // engine must derive correctly at the source. No-op on an engine that can't
      // (the bare fake — folder identity is server-side, harmless there).
      this.inner.setFolderAliases?.(this.snap.folderAliases)
    } catch {
      // keep the last good list
    }
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
    // hands out the SAME ids as last run. A failed meta-DB degrades to an
    // ephemeral registry (P2: losing meta is soft), never a dead store.
    const boot = this.identity
      .load()
      .catch((err) => console.error('[cached-store] identity load failed:', (err as Error).message))
      .then(() => this.bootScan())
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

    this.dirs.clear()
    for (const meta of this.snap.notes.values()) {
      this.dirs.add(directoryOf(meta.filePath))
    }
    try {
      for (const d of (await this.inner.listDirs?.()) ?? []) {
        this.dirs.add(d)
      }
      this.directoryInventoryReady = true
    } catch (err) {
      this.directoryInventoryReady = false
      console.error('[cached-store] boot directory inventory failed:', (err as Error).message)
    }

    if (generation !== this.bootGeneration || this.stopped) {
      return false
    }

    // Wake waiters while the global lease remains held. They canonicalize only
    // after this callback publishes the stable inventory and releases it.
    this.mutationInventoryReady = true
    this.openMutationBarrier()
    this.emit({ type: 'changed', upserts: [...this.snap.notes.keys()], removed: [] })
    return true
  }

  private async finishBootGraphClaimed(generation: number): Promise<void> {
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
    const CHUNK = 64

    for (let i = 0; i < paths.length; i += CHUNK) {
      await Promise.all(
        paths.slice(i, i + CHUNK).map(async (path) => {
          let raw: string | null = null

          try {
            raw = await this.readBody!(path)
          } catch {
            return
          }
          if (!raw) {
            return
          }
          // A successful raw read is authoritative even when the file has no
          // materialized claim. Failed/null reads stay unresolved so the
          // observation falls back to an engine read before journaling.
          unresolvedPaths.delete(path)
          const claim = frontmatterValue(raw, NOTE_ID_FRONTMATTER_KEY)

          if (!claim) {
            return
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
        }),
      )
    }
    for (const [oldId, newId] of rekeyed) {
      this.rekeySnapshot(oldId, newId)
    }
    await this.identity.flush().catch(() => {})
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
    this.snap.adoptEdgeBaseline(graph)
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

  async list(opts?: ReadSurfaceOptions): Promise<NoteMeta[]> {
    await this.ensureNotes()
    const scope: ReadScope = opts?.scope ?? READ_SCOPE.user
    const admitted = classesForScope(scope)
    // Project-subtree narrowing rides alongside the class axis: a project
    // handle resolves to `pathPrefix`, and the list scopes to that subtree here, in
    // the read-model query (absent = the whole space).
    const prefix = opts?.pathPrefix
    const visible = (n: NoteMeta): boolean =>
      admitted.has(n.class ?? DEFAULT_NOTE_CLASS) &&
      (prefix === undefined || isPathUnder(n.filePath, prefix))

    // The list-driven user surfaces (Feed/tree/buckets) all slice this, so the
    // hidden-class exclusion lives HERE, once. NB: `user` scope admits a class
    // visible on feed OR tree (coarse) — it does NOT enforce the per-surface
    // feed≠tree split. Moot in v1 (the only feed-hidden/tree-visible class is
    // attachment, which the engine never indexes as a note row); when an
    // attachment-style indexed class appears, the Feed must additionally filter
    // by isVisibleOn('feed', class).
    if (this.isServingLive) {
      return (await this.inner.list()).filter(visible)
    }

    return [...this.snap.notes.values()].filter(visible)
  }

  async graph(): Promise<Graph> {
    await this.ensureNotes()
    // The graph is a user surface: agent-memory (and any non-graph class) is
    // excluded as nodes AND link targets, always — there is no user scope
    // that puts memory in the graph in v1, so this surface takes no scope.
    if (this.isServingLive) {
      return filterGraphForUser(await this.inner.graph())
    }

    return this.graphCache.read()
  }

  /** Read-only grooming health. Bypasses the incremental edge cache graph() serves (a cached
   *  inbound edge isn't re-resolved when its target is renamed, so its `resolvedVia` would
   *  undercount): folds the engine's FRESH derivation after the SAME hidden-class filter, so the
   *  metric is honest and visibility holds. One fresh derivation per call (a maintenance surface). */
  async graphHealth(): Promise<GraphHealth> {
    await this.ensureNotes()
    const health = aggregateGraphHealth(filterGraphForUser(await this.inner.graph()))
    // The engine is identity-agnostic: its graph keys real nodes by STORAGE
    // PATH. Every other surface speaks note-ids, so adopt path→id here — the SAME remap
    // the snapshot graph applies when it ingests the engine's links (a card link must
    // navigate to /n/<id>, not /n/<path>). A note-id-keyed inner (the e2e fake / a bare
    // engine with no registry) has no path to match, so idFor returns undefined and the
    // id passes through; ghost ids (`ghost:…`) are synthetic, not paths — they pass too.
    const idFor = (x: string): string => this.identity.idFor(x) ?? x
    return {
      ...health,
      edges: health.edges.map((e) => ({
        source: { id: idFor(e.source.id), title: e.source.title },
        target: { id: idFor(e.target.id), title: e.target.title },
        via: e.via,
      })),
      ghosts: health.ghosts.map((g) => ({
        ...g,
        sources: g.sources.map((s) => ({ ...s, id: s.id ? idFor(s.id) : s.id })),
      })),
    }
  }

  async search(q: string, opts?: SearchOptions): Promise<SearchResult[]> {
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
      const id = r.id ?? (r.filePath ? this.identity.idFor(r.filePath) : undefined)

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

    return out
  }

  /** Read resolves a note-id through the registry (falling through to the
   *  engine's own keys — wiki-link resolution by path/title keeps working),
   *  then the note's outbound edges are re-derived from the live body it just
   *  returned — opening a note heals its part of the graph (the engine's
   *  relation index may lag or lie). */
  async read(id: string, opts?: ReadOptions): Promise<NoteContent> {
    return this.readInternal(id, opts, false)
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
    const initialDirectId = this.canonicalMutationId(rawId)
    // A stable id keeps denoting that note even if its old path is reused. A
    // path/title/permalink is a resolver instead and is deliberately resolved
    // again after a preceding mutation has finished.
    const stableIdRequest =
      initialDirectId !== rawId ||
      this.snap.notes.has(initialDirectId) ||
      this.identity.recordFor(initialDirectId) !== undefined

    const target = (): {
      id: string
      path: string | undefined
      storageKey: string
      needsGlobalClaim: boolean
    } => {
      const directId = this.canonicalMutationId(rawId)
      let owner: string | undefined

      if (stableIdRequest) {
        owner = directId
      } else {
        const matches = [...this.snap.notes].filter(
          ([, meta]) => meta.filePath === rawId || meta.title === rawId,
        )

        owner = this.identity.idFor(rawId) ?? (matches.length === 1 ? matches[0][0] : undefined)
      }
      const id = this.canonicalMutationId(owner ?? directId)
      const path = this.identity.pathFor(id) ?? this.snap.notes.get(id)?.filePath

      return {
        id,
        path,
        storageKey: path ?? (owner ? id : rawId),
        needsGlobalClaim: owner === undefined && path === undefined,
      }
    }

    const perform = async (claimedIds?: ReadonlySet<string>): Promise<ReadAttempt> => {
      const current = target()
      let detail: NoteContent

      // A bare engine has no id channel: handing a deleted stable id to its
      // generic resolver could open an unrelated note whose path/title/slug
      // happens to equal that id. Only the explicit trash view may answer it.
      if (stableIdRequest && !this.inner.capabilities.identity && current.path === undefined) {
        if (opts?.deletedView) {
          const gone = await this.trash.deletedNoteView(current.id)

          if (gone) {
            return { kind: 'complete', content: gone }
          }
        }
        throw noteNotFound(current.id)
      }

      try {
        detail = await this.inner.read(current.storageKey, opts)
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
      const bodyClaim = detail.frontmatter?.[NOTE_ID_FRONTMATTER_KEY]

      if (
        claimedIds &&
        !this.inner.capabilities.identity &&
        typeof bodyClaim === 'string' &&
        bodyClaim
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

      return {
        kind: 'complete',
        content: this.finalizeRead(current.id, current.path, detail, allowSideEffects, effects),
      }
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

        if (typeof claim === 'string' && claim) {
          const res = this.identity.adoptFileId(detail.filePath, claim)

          if (res.kind === 'adopted') {
            if (res.previousId) {
              this.rekeySnapshot(res.previousId, claim)
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
      return fromFile
    }
    const detail = await this.read(id, opts)
    const key = detail.id || id
    return this.previewCache.get(key) ?? derivePreview(detail.content, detail.frontmatter?.tags)
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

  // ── revision journal surface ──────────────────────────────────────────

  // ── history + trash — delegated to HistorySurface ────────────────────

  revisions(noteId: string, opts: { offset: number; limit: number }) {
    return this.trash.revisions(noteId, opts)
  }

  revision(noteId: string, revisionId: string) {
    return this.trash.revision(noteId, revisionId)
  }

  revisionsSince(sinceRevId: string | null, limit: number) {
    return this.trash.revisionsSince(sinceRevId, limit)
  }

  activity(opts: {
    from: string
    to: string
    tzOffsetMinutes: number
    scope?: ReadScope
    author?: AuthorFilter
  }) {
    return this.trash.activity(opts)
  }

  activityEvents(opts: {
    from?: string
    to?: string
    offset: number
    limit: number
    scope?: ReadScope
    author?: AuthorFilter
  }) {
    return this.trash.activityEvents(opts)
  }

  activityByNote(opts: { from: string; to: string; scope?: ReadScope }) {
    return this.trash.activityByNote(opts)
  }

  restore(input: RestoreInput) {
    return this.trash.restore(input)
  }

  listTrashed(opts: { offset: number; limit: number; q?: string; scope?: ReadScope }) {
    return this.trash.listTrashed(opts)
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

  remove(id: string, opts?: { principal?: string }): Promise<void> {
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

    try {
      if (this.phase === SCAN_PHASE.error) {
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
      const changed = await this.mutations.run({ global: true }, async () => {
        // Pull path-history only after the global claim has waited for an older
        // folder move's storage/finalize lease. Reading it before the claim can
        // cache the pre-move aliases and then apply the post-move delta with
        // stale resolution state.
        await this.refreshFolderAliases()
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
        const result = this.applyDelta(delta)

        this.cursor = delta.cursor
        this.lastPollAt = this.iso()
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
        for (const [rawId, title, filePath] of result.removedTitles) {
          this.scheduleExternalDelete(rawId, title, filePath, identityResolutions)
        }

        const rekeyed = [...identitySweep.rekeyed, ...readEffects.rekeyed]
        const didChange = result.changed || rekeyed.length > 0 || readEffects.changedIds.size > 0

        if (didChange) {
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
      console.error('[cached-store] delta poll failed:', (err as Error).message)
      if (strict) {
        throw err
      }
    } finally {
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
  } {
    const upserted = new Set<string>()
    const removed: string[] = []
    const sweepPaths = new Set<string>()
    const removedTitles: Array<[string, string, string]> = []
    const externalObservations: ExternalObservation[] = []
    const newlyAdded = new Set<string>()

    const inventory = new Map<string, NoteMeta & { id: string }>()

    for (const m of delta.inventory) {
      const adopted = this.adoptMeta(m)
      inventory.set(adopted.id, adopted)
    }
    for (const [id, meta] of [...this.snap.notes]) {
      if (inventory.has(id)) {
        continue
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
