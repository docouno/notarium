// SpaceManager: id-keyed registry of lazily-booted per-space stores. Resolving
// "which store to open" is the isolation boundary, and the slug↔id (+ alias)
// resolution lives here so a rename never ripples past it.
// canon: docs/spaces.md#model · docs/spaces.md#server

import {
  asciiSlug,
  freshNoteId,
  type IdentityRecord,
  noteFileBase,
  READ_SCOPE,
  type StoreEvent,
} from '@notarium/core'

import type { SpaceRecord } from '../metaDb'
import { provisionSpaceIdentity } from '../projects/spaceIdentity'
import { spaceNotFound } from './errors'
import { buildSpaceSlugIndex, resolvableSpaceAliases } from './spaceResolver'
import type { SpaceDef, SpaceManagerOptions, SpaceStore } from './types'

const EVICT_SWEEP_MS = 60_000

/** Space-lifecycle error; the wire layer maps `reason` to an HTTP status. */
const spaceError = (message: string, reason: string): Error & { reason: string } => {
  const err = new Error(message) as Error & { reason: string }
  err.reason = reason
  return err
}

type SpaceEntry = {
  rec: SpaceRecord
  /** Config-pinned (slug frozen by env, rename/archive refused) vs runtime-minted. */
  config: boolean
  storePromise: Promise<SpaceStore> | null
  store: SpaceStore | null
  lastAccess: number
  sseRefs: number
  /** A meta-DB global-id lookup selected this live space. The next post-auth
   * store handoff must wait for its authoritative duplicate-owner registry. */
  identityReadyRequired: boolean
}

export class SpaceManager {
  private readonly entries = new Map<string, SpaceEntry>()
  /** current slug + slugified aliases → id; current wins over an alias. */
  private readonly bySlug = new Map<string, string>()
  private readonly configDefs: SpaceDef[]
  private readonly createStore: SpaceManagerOptions['createStore']
  private readonly mintSpace?: SpaceManagerOptions['createSpace']
  private readonly mintEnabled?: () => boolean
  private readonly metaDb?: SpaceManagerOptions['metaDb']
  private readonly onProvision?: SpaceManagerOptions['onProvision']
  private readonly onPurge?: SpaceManagerOptions['onPurge']
  private readonly readSpaceFacet?: SpaceManagerOptions['readSpaceFacet']
  private readonly discoverDiskSpaces?: SpaceManagerOptions['discoverDiskSpaces']
  private readonly adoptLegacyInto?: string
  private readonly isPersonalSpace?: SpaceManagerOptions['isPersonalSpace']
  private readonly idleEvictMs: number
  private readonly now: () => Date
  private evictTimer: ReturnType<typeof setInterval> | null = null
  private readonly settling = new Set<Promise<void>>()
  private checkpointing = false

  constructor({
    spaces,
    createStore,
    createSpace,
    spaceCreateEnabled,
    metaDb,
    onProvision,
    onPurge,
    readSpaceFacet,
    discoverDiskSpaces,
    adoptLegacyInto,
    isPersonalSpace,
    idleEvictMs = 0,
    now = () => new Date(),
  }: SpaceManagerOptions) {
    // With a meta-DB, entries are built in init() (the opaque id needs an async
    // resolve-or-mint). A zero-space host is valid — no length guard.
    this.configDefs = spaces
    this.createStore = createStore
    this.mintSpace = createSpace
    this.mintEnabled = spaceCreateEnabled
    this.metaDb = metaDb
    this.onProvision = onProvision
    this.onPurge = onPurge
    this.readSpaceFacet = readSpaceFacet
    this.discoverDiskSpaces = discoverDiskSpaces
    this.adoptLegacyInto = adoptLegacyInto
    this.isPersonalSpace = isPersonalSpace
    this.idleEvictMs = idleEvictMs
    this.now = now
    // meta-DB-less (e2e fake / none-mode): id ≡ slug, no async resolve, so register
    // synchronously — callers expect list()/has()/store() to work before init().
    if (!metaDb) {
      for (const def of spaces) {
        if (this.resolveId(def.slug)) {
          throw new Error(`duplicate space slug: ${def.slug}`)
        }
        this.register(this.recordForSlug(def.slug, def.displayName), true)
      }
    }
  }

  /** Fire the first-provision hook. Best-effort — a hook failure must never wedge
   *  boot or a space mint. */
  private async provision(rec: SpaceRecord): Promise<void> {
    try {
      await this.onProvision?.(rec)
    } catch (err) {
      console.error('[spaces] provision hook ->', (err as Error).message)
    }
  }

  get capabilities(): { spaceCreate: boolean } {
    return { spaceCreate: Boolean(this.mintSpace) && (this.mintEnabled?.() ?? true) }
  }

  /** Boot: provision config spaces, recover runtime spaces, adopt legacy rows,
   *  start the eviction sweep. */
  async init(): Promise<void> {
    if (this.metaDb) {
      // adoptDiscovered runs BEFORE provision/recovery so re-cloned runtime folders
      // keep their marker-borne id instead of minting fresh.
      await this.adoptDiscovered()
      const list = await this.metaDb.spaces.list()
      const known = new Set(list.map((s) => s.slug))
      const configSlugs = new Set(this.configDefs.map((d) => d.slug))

      // onProvision fires only on the first-ever boot (no registry row yet), never
      // on a restart — so a human's unmark of the root survives.
      for (const def of this.configDefs) {
        const markerFacet = await this.readSpaceFacet?.(def)
        const rec = await provisionSpaceIdentity(
          { spaces: this.metaDb.spaces, now: this.now },
          { slug: def.slug, displayName: def.displayName, markerFacet },
        )
        this.register(rec, true)
        if (!known.has(def.slug)) {
          await this.provision(rec)
        }
      }
      // Recover runtime-created spaces (registry-only, not in SPACES_CONFIG).
      // canon: docs/spaces.md#deployment-notarium-engine-69
      for (const rec of list) {
        if (configSlugs.has(rec.slug) || this.entries.has(rec.id)) {
          continue
        }
        this.register(rec, false)
      }
      // Adopt legacy rows AFTER spaces exist (adoptLegacyRows resolves legacy slug →
      // id). Idempotent; a no-op on modern deploys.
      if (this.adoptLegacyInto) {
        await this.metaDb.adoptLegacyRows(this.adoptLegacyInto)
      }
    }
    if (this.idleEvictMs > 0) {
      this.evictTimer = setInterval(() => this.evictIdle(), EVICT_SWEEP_MS)
      this.evictTimer.unref?.()
    }
  }

  /** Adopt re-cloned runtime space folders by seeding their marker-borne id into
   *  the registry (cross-host continuity).
   *  Gotchas: idempotency keys on the PHYSICAL folder (`notes_dir`), not the marker
   *  id — a row already covering this folder is authoritative, so a failed marker
   *  heal can't accumulate a duplicate row every boot. Runs BEFORE the config
   *  provision loop → on a runtime↔config id clash the runtime folder wins the id
   *  (first-seen-wins). Best-effort: a discovery failure never wedges boot. */
  private async adoptDiscovered(): Promise<void> {
    if (!this.metaDb || !this.discoverDiskSpaces) {
      return
    }
    let discovered: Awaited<ReturnType<NonNullable<typeof this.discoverDiskSpaces>>>

    try {
      discovered = await this.discoverDiskSpaces()
    } catch (err) {
      console.error('[spaces] disk discovery ->', (err as Error).message)
      return
    }
    const configSlugs = new Set(this.configDefs.map((d) => d.slug))
    const knownDirs = new Set((await this.metaDb.spaces.list()).map((r) => r.notesDir))

    for (const d of discovered) {
      if (knownDirs.has(d.notesDir)) {
        continue
      }
      const holder = await this.metaDb.spaces.getById(d.id)

      if (holder) {
        console.warn(
          `[spaces] disk space ${d.notesDir}: marker id ${d.id} already held by ${holder.slug} (${holder.notesDir}) — minting fresh`,
        )
      }
      const id = holder ? freshNoteId() : d.id
      let slug = d.slug
      const taken = async (s: string): Promise<boolean> =>
        configSlugs.has(s) || (await this.metaDb!.spaces.getBySlug(s)) !== null

      for (let n = 2; await taken(slug); n++) {
        slug = `${d.slug}-${n}`
      }
      const aliases = [...d.aliases]

      if (slug !== d.slug && !aliases.includes(d.slug)) {
        aliases.push(d.slug)
      }
      await this.metaDb.spaces.upsert({
        id,
        slug,
        displayName: d.displayName.trim() || slug,
        notesDir: d.notesDir,
        aliases,
        createdAt: this.now().toISOString(),
        archivedAt: null,
        archivedBy: null,
      })
      knownDirs.add(d.notesDir)
    }
  }

  /** Every SERVED space's record; archived spaces are excluded (registered but not
   *  served). canon: docs/spaces.md#deleting-a-space-soft-archive-110 */
  list(): SpaceRecord[] {
    return [...this.entries.values()].filter((e) => !e.rec.archivedAt).map((e) => e.rec)
  }

  /** Every ARCHIVED space's record; membership-filtering is the caller's job. */
  listArchived(): SpaceRecord[] {
    return [...this.entries.values()].filter((e) => e.rec.archivedAt).map((e) => e.rec)
  }

  recOf(id: string): SpaceRecord | undefined {
    return this.entries.get(id)?.rec
  }

  slugOf(id: string): string | undefined {
    return this.entries.get(id)?.rec.slug
  }

  /** Past slugs that still resolve to this exact space. Durable history also
   *  retains shadowed/ambiguous aliases, but those are intentionally not wire
   *  capabilities. */
  resolvableAliasesOf(id: string): string[] {
    return resolvableSpaceAliases(
      [...this.entries.values()].map((entry) => entry.rec),
      id,
    )
  }

  /** Resolve a slug or past-slug alias → the stable id (current wins over alias);
   *  null on an unknown slug. */
  resolveId(slugOrAlias: string): string | null {
    return this.bySlug.get(slugOrAlias) ?? this.bySlug.get(asciiSlug(slugOrAlias)) ?? null
  }

  /** Is this a config-pinned space (slug frozen by env — rename/archive refused)? */
  isConfigPinned(id: string): boolean {
    return this.entries.get(id)?.config ?? false
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** The id's live store, booting it on first touch. Unknown/archived space →
   *  a typed not-found (mapped to 404). */
  async store(id: string): Promise<SpaceStore> {
    const entry = this.entries.get(id)

    // Archived space: fail-closed 404 (data intact for restore).
    if (!entry || entry.rec.archivedAt) {
      throw spaceNotFound(id)
    }
    entry.lastAccess = Date.now()
    if (!entry.storePromise) {
      const rec = entry.rec
      const booting: Promise<SpaceStore> = Promise.resolve()
        .then(() => this.createStore(rec))
        .then((store) => {
          // Evicted/archived WHILE booting: a concurrent archive()/idle-eviction nulled
          // storePromise. Don't install this now-stale store — it would leak a started
          // store on an archived space and double-open its .db on restore. Tear it down.
          if (entry.storePromise !== booting || entry.rec.archivedAt) {
            store.stop?.()
            this.trackSettle(store, 'stale boot')
            return store
          }
          entry.store = store
          void store.start?.()
          return store
        })
      entry.storePromise = booting
      booting.catch(() => {
        // A failed boot must not wedge the space forever — next access retries.
        if (entry.storePromise === booting) {
          entry.storePromise = null
        }
        entry.store = null
      })
    }

    const store = await entry.storePromise

    if (entry.identityReadyRequired) {
      // resolveNote runs before resource auth. Defer the potentially expensive
      // boot/readiness barrier to the later store() handoff so an inaccessible
      // note cannot warm its space; a rejection keeps the latch set for retry.
      await store.identityReady?.()
      entry.identityReadyRequired = false
    }

    return store
  }

  /** Per-space SSE subscription; holds an eviction guard (sseRefs) for the socket's
   *  lifetime so the store isn't evicted under a live subscriber. */
  async subscribe(id: string, listener: (event: StoreEvent) => void): Promise<() => void> {
    const entry = this.entries.get(id)

    if (!entry) {
      throw spaceNotFound(id)
    }
    const store = await this.store(id)
    entry.sseRefs++
    const unsubscribe = store.subscribe?.(listener)
    let released = false

    return () => {
      if (released) {
        return
      }
      released = true
      entry.sseRefs--
      unsubscribe?.()
    }
  }

  /** Global id → space resolution: the registry arbitrates; a meta-DB-less host
   *  falls back to polling each live store.
   *  Tombstoned ids resolve too — the read path decides what a deleted note answers. */
  async resolveNote(id: string): Promise<{ space: string; deletedAt: string | null } | null> {
    const findById = this.metaDb?.identity.findById

    if (findById) {
      const rec: IdentityRecord | null = await findById(id)

      if (!rec) {
        return null
      }
      // resolveNote precedes resource auth and archived routes deliberately
      // remain resolvable. Arm only a known LIVE space; its later store() handoff
      // waits for duplicate ownership without warming inaccessible/archived data.
      const entry = this.entries.get(rec.space)

      if (entry && !entry.rec.archivedAt) {
        entry.identityReadyRequired = true
      }

      return { space: rec.space, deletedAt: rec.deletedAt }
    }
    for (const [spaceId, entry] of this.entries) {
      if (entry.rec.archivedAt) {
        continue
      }
      const store = await this.store(spaceId)
      // scope:'all' — id resolution must cover the FULL population, including
      // hidden-class (agent-memory) notes, so a user can reach their own memory by id.
      const notes = await store.list({ scope: READ_SCOPE.all })

      if (notes.some((n) => n.id === id)) {
        return { space: spaceId, deletedAt: null }
      }
    }

    return null
  }

  /** Mint a new space (capability-gated); recovers an existing registry row instead
   *  of duplicating it (a restart re-mint of a personal space). */
  async create(input: SpaceDef): Promise<SpaceRecord> {
    if (!this.mintSpace || !this.capabilities.spaceCreate) {
      throw spaceNotFound(input.slug)
    }
    if (this.resolveId(input.slug)) {
      const err = new Error(`space already exists: ${input.slug}`) as Error & {
        isToolError: boolean
        reason: string
      }
      err.isToolError = true
      err.reason = 'space_exists'
      throw err
    }
    // Only a genuinely new space fires onProvision — a recovery must not re-mark a
    // root the user unmarked.
    const existing = this.metaDb ? await this.metaDb.spaces.getBySlug(input.slug) : null

    // An archived space holds its slug: creating "into" it would silently un-archive
    // and adopt its data. Refuse — restore is the deliberate way back.
    if (existing?.archivedAt) {
      const err = new Error(`space already exists: ${input.slug}`) as Error & {
        isToolError: boolean
        reason: string
      }
      err.isToolError = true
      err.reason = 'space_exists'
      throw err
    }
    const seed: SpaceRecord = existing
      ? { ...existing, displayName: input.displayName }
      : this.recordForSlug(input.slug, input.displayName)
    // The engine mints the physical folder and may suffix its name on a collision
    // (notes_dir is decoupled from slug); the returned name is the durable notes_dir.
    const actualDir = await this.mintSpace(seed)
    const rec: SpaceRecord = {
      ...seed,
      notesDir:
        existing?.notesDir ??
        (typeof actualDir === 'string' && actualDir ? actualDir : seed.notesDir),
    }
    await this.metaDb?.spaces.upsert(rec)
    this.register(rec, false)
    if (!existing) {
      await this.provision(rec)
    }

    return rec
  }

  /** Apply a committed rename to in-memory state only — persistence + marker write
   *  are the caller's (recordSpaceRename). Re-keys the slug index; id unchanged. */
  applyRename(rec: SpaceRecord): void {
    const entry = this.entries.get(rec.id)

    if (!entry) {
      return
    }
    entry.rec = rec
    this.rebuildSlugIndex()
  }

  /** Forget a space: evict its store, drop the entry. A personal space is NOT
   *  removable; engine-side deletion deliberately lives elsewhere. */
  async remove(id: string): Promise<void> {
    if (await this.isPersonalSpace?.(id)) {
      throw new Error('cannot remove a personal space')
    }
    const entry = this.entries.get(id)

    if (!entry) {
      return
    }
    this.entries.delete(id)
    this.rebuildSlugIndex()
    if (entry.store) {
      entry.store.stop?.()
      await entry.store.settle?.()
    }
  }

  /** Archive a space (soft-delete): mark it archived, evict its live store; it stops
   *  being served while its data/journal/index stay whole. Personal and
   *  config-pinned spaces are NOT archivable.
   */
  async archive(id: string, by?: string | null): Promise<SpaceRecord> {
    if (!this.metaDb) {
      throw spaceError('archiving needs a space registry', 'unsupported')
    }
    if (await this.isPersonalSpace?.(id)) {
      throw spaceError('cannot archive a personal space', 'personal_space')
    }
    if (this.isConfigPinned(id)) {
      throw spaceError('cannot archive a config-pinned space', 'config_pinned')
    }
    const entry = this.entries.get(id)

    if (!entry || entry.rec.archivedAt) {
      throw spaceNotFound(id)
    }
    // archivedBy = raw actor attribution; resolved to an Author on the wire.
    const rec: SpaceRecord = {
      ...entry.rec,
      archivedAt: this.now().toISOString(),
      archivedBy: by ?? null,
    }
    await this.metaDb.spaces.upsert(rec)
    entry.rec = rec
    this.evictStore(entry)
    return rec
  }

  /** Restore an archived space: clear the mark; the store boots lazily on next
   *  touch, reopening its kept index file (no reindex). */
  async restore(id: string): Promise<SpaceRecord> {
    if (!this.metaDb) {
      throw spaceError('restoring needs a space registry', 'unsupported')
    }
    const entry = this.entries.get(id)

    if (!entry || !entry.rec.archivedAt) {
      throw spaceNotFound(id)
    }
    const rec: SpaceRecord = { ...entry.rec, archivedAt: null, archivedBy: null }
    await this.metaDb.spaces.upsert(rec)
    entry.rec = rec
    return rec
  }

  /** Permanently purge an archived space (hard-delete): erase its meta-DB rows and
   *  on-disk artefacts, drop the entry. ONLY an already-archived space is purgeable
   *  (archive is the mandatory safety stop); a personal space never.
   */
  async purge(id: string): Promise<void> {
    if (!this.metaDb) {
      throw spaceError('purging needs a space registry', 'unsupported')
    }
    if (await this.isPersonalSpace?.(id)) {
      throw spaceError('cannot purge a personal space', 'personal_space')
    }
    const entry = this.entries.get(id)

    if (!entry) {
      throw spaceNotFound(id)
    }
    if (!entry.rec.archivedAt) {
      throw spaceError('archive the space before purging it', 'not_archived')
    }
    const rec = entry.rec
    this.evictStore(entry)
    await this.metaDb.purgeSpace(id)
    try {
      await this.onPurge?.(rec)
    } catch (err) {
      // Registry rows are already gone; orphaned files are harmless and reclaimable —
      // never wedge the purge on cleanup.
      console.error(`[spaces] purge on-disk cleanup ${rec.slug} ->`, (err as Error).message)
    }
    this.entries.delete(id)
    this.rebuildSlugIndex()
  }

  /** Stop + settle + drop the live store while KEEPING the entry (so the slug stays
   *  reserved). Idempotent — a no-op when nothing is booted. */
  private evictStore(entry: SpaceEntry): void {
    const store = entry.store
    entry.store = null
    entry.storePromise = null
    if (store) {
      store.stop?.()
      this.trackSettle(store, 'archive')
    }
  }

  async stopAll(): Promise<void> {
    if (this.evictTimer) {
      clearInterval(this.evictTimer)
      this.evictTimer = null
    }
    for (const entry of this.entries.values()) {
      if (!entry.store) {
        continue
      }
      entry.store.stop?.()
      await entry.store.settle?.()
    }
    await this.drainSettling()
  }

  /** Flush every currently live/booting store without warming untouched spaces. */
  async checkpointAll(): Promise<void> {
    this.checkpointing = true
    try {
      await this.drainSettling()
      const stores = await Promise.all(
        [...this.entries.values()]
          .map((entry) => entry.storePromise)
          .filter((store): store is Promise<SpaceStore> => store !== null),
      )
      await Promise.all(stores.map((store) => store.checkpoint?.()))
      await this.drainSettling()
    } finally {
      this.checkpointing = false
    }
  }

  /** Register an already-existing space in memory (no engine-side effect — that is
   *  create()'s job). Idempotent on the slug. */
  add(def: SpaceDef): void {
    if (this.resolveId(def.slug)) {
      return
    }
    this.register(this.recordForSlug(def.slug, def.displayName), false)
  }

  /** A fresh record for a new space: an opaque id where a registry persists one,
   *  else the slug itself (a meta-DB-less host has id ≡ slug). */
  private recordForSlug(slug: string, displayName: string): SpaceRecord {
    const id = this.metaDb ? freshNoteId() : slug

    return {
      id,
      slug,
      displayName,
      // Handle syntax is URL-safe but still contains Windows device names.
      // Physical runtime-space components use the shared portable-name fence;
      // ordinary handles remain byte-for-byte unchanged.
      notesDir: noteFileBase(slug, undefined, id),
      aliases: [],
      createdAt: this.now().toISOString(),
      archivedAt: null,
      archivedBy: null,
    }
  }

  private register(rec: SpaceRecord, config: boolean): void {
    this.entries.set(rec.id, {
      rec,
      config,
      storePromise: null,
      store: null,
      lastAccess: 0,
      sseRefs: 0,
      identityReadyRequired: false,
    })
    this.rebuildSlugIndex()
  }

  /** Rebuild slug→id: all CURRENT slugs first, then only uniquely-owned aliases —
   *  current > alias and ambiguous alias > fail closed. Few spaces per host, so a
   *  full rebuild per change is cheap. */
  private rebuildSlugIndex(): void {
    const next = buildSpaceSlugIndex([...this.entries.values()].map((entry) => entry.rec))
    this.bySlug.clear()
    for (const [slug, id] of next) {
      this.bySlug.set(slug, id)
    }
  }

  private evictIdle(): void {
    if (this.checkpointing) {
      return
    }
    const cutoff = Date.now() - this.idleEvictMs

    for (const entry of this.entries.values()) {
      if (!entry.store || entry.sseRefs > 0 || entry.lastAccess > cutoff) {
        continue
      }
      const store = entry.store
      entry.store = null
      entry.storePromise = null
      store.stop?.()
      this.trackSettle(store, 'evict')
    }
  }

  private trackSettle(store: SpaceStore, operation: string): void {
    const task = Promise.resolve(store.settle?.()).then(
      () => undefined,
      (err) => console.error(`[spaces] ${operation} settle ->`, (err as Error).message),
    )
    this.settling.add(task)
    void task.finally(() => this.settling.delete(task))
  }

  private async drainSettling(): Promise<void> {
    while (this.settling.size > 0) {
      await Promise.all([...this.settling])
    }
  }
}
