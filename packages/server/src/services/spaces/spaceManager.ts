// SpaceManager: id-keyed registry of lazily-booted per-space stores. Resolving
// "which store to open" is the isolation boundary, and the slug↔id (+ alias)
// resolution lives here so a rename never ripples past it.
// canon: docs/spaces.md#model · docs/spaces.md#server

import {
  asciiSlug,
  type DocumentState,
  freshNoteId,
  type IdentityRecord,
  noteFileBase,
  type PublishedResourceEvidence,
  READ_SCOPE,
  SPACE_LIFECYCLE_PHASE,
  type SpaceLifecyclePhase,
  type StoreEvent,
} from '@notarium/core'

import type { SpaceRecord } from '../metaDb'
import { provisionSpaceIdentity } from '../projects/spaceIdentity'
import { spaceNotFound } from './errors'
import { decodeSpaceCleanupManifest, encodeSpaceCleanupManifest } from './spaceCleanupManifest'
import { buildSpaceSlugIndex, resolvableSpaceAliases } from './spaceResolver'
import type { SpaceDef, SpaceManagerOptions, SpaceStore } from './types'

const EVICT_SWEEP_MS = 60_000
const DEFAULT_LIFECYCLE_DRAIN_MS = 30_000

/** Space-lifecycle error; the wire layer maps `reason` to an HTTP status. */
const spaceError = (message: string, reason: string): Error & { reason: string } => {
  const err = new Error(message) as Error & { reason: string }
  err.reason = reason
  return err
}

type SpaceEntry = {
  rec: SpaceRecord
  lifecycle: SpaceLifecyclePhase
  /** Config-pinned (slug frozen by env, rename/archive refused) vs runtime-minted. */
  config: boolean
  storePromise: Promise<SpaceStore> | null
  store: SpaceStore | null
  lastAccess: number
  sseRefs: number
  causalPublicationRefs: number
  /** A meta-DB global-id lookup selected this live space. The next post-auth
   * store handoff must wait for its authoritative duplicate-owner registry. */
  identityReadyRequired: boolean
}

type AcceptedCausalPublication = {
  kind: 'ability-create' | 'restore'
  operationId: string
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
  private readonly closeResourceAdmission?: SpaceManagerOptions['closeResourceAdmission']
  private readonly reopenResourceAdmission?: SpaceManagerOptions['reopenResourceAdmission']
  private readonly readSpaceFacet?: SpaceManagerOptions['readSpaceFacet']
  private readonly discoverDiskSpaces?: SpaceManagerOptions['discoverDiskSpaces']
  private readonly adoptLegacyInto?: string
  private readonly isPersonalSpace?: SpaceManagerOptions['isPersonalSpace']
  private readonly idleEvictMs: number
  private readonly lifecycleDrainMs: number
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
    closeResourceAdmission,
    reopenResourceAdmission,
    readSpaceFacet,
    discoverDiskSpaces,
    adoptLegacyInto,
    isPersonalSpace,
    idleEvictMs = 0,
    lifecycleDrainMs = DEFAULT_LIFECYCLE_DRAIN_MS,
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
    this.closeResourceAdmission = closeResourceAdmission
    this.reopenResourceAdmission = reopenResourceAdmission
    this.readSpaceFacet = readSpaceFacet
    this.discoverDiskSpaces = discoverDiskSpaces
    this.adoptLegacyInto = adoptLegacyInto
    this.isPersonalSpace = isPersonalSpace
    this.idleEvictMs = idleEvictMs
    if (!Number.isFinite(lifecycleDrainMs) || lifecycleDrainMs < 0) {
      throw new Error('lifecycleDrainMs must be a non-negative number')
    }
    this.lifecycleDrainMs = lifecycleDrainMs
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
      // Durable lifecycle recovery runs before disk discovery. A leftover purged
      // marker is cleanup input, never a new registry candidate.
      await this.metaDb.spaceLifecycle.init()
      await this.recoverLifecycleSagas()
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
        const lifecycle = await this.lifecycleForRecord(rec)
        this.register(rec, true, lifecycle)
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
        const lifecycle = await this.lifecycleForRecord(rec)
        this.register(rec, false, lifecycle)
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

  /** Resume registry-owned lifecycle work without exposing the space through the
   * served registry. Busy accepted restore operations keep `closing`/`purge-intent`
   * durable for the later recovery coordinator. */
  private async recoverLifecycleSagas(): Promise<void> {
    if (!this.metaDb) {
      return
    }
    for (const lifecycle of await this.metaDb.spaceLifecycle.listUnfinished()) {
      try {
        await this.resumeLifecycle(lifecycle.space)
      } catch (error) {
        if ((error as { reason?: string }).reason === 'space_busy') {
          console.warn(`[spaces] lifecycle ${lifecycle.space} remains ${lifecycle.phase}`)
          continue
        }
        throw error
      }
    }
  }

  /** Recovery hook for startup and for the restore coordinator after it settles
   * an operation that pinned closing/purge. */
  async resumeLifecycle(space: string): Promise<void> {
    if (!this.metaDb) {
      return
    }
    const lifecycle = await this.metaDb.spaceLifecycle.get(space)

    if (!lifecycle) {
      return
    }
    if (lifecycle.phase === SPACE_LIFECYCLE_PHASE.closing) {
      const rec = await this.metaDb.spaces.getById(space)

      if (!rec) {
        throw new Error(`closing space is missing its registry row: ${space}`)
      }
      await this.completeArchive(rec, lifecycle.changedBy)
      return
    }
    if (
      lifecycle.phase === SPACE_LIFECYCLE_PHASE.purgeIntent ||
      lifecycle.phase === SPACE_LIFECYCLE_PHASE.metadataCleaned ||
      lifecycle.phase === SPACE_LIFECYCLE_PHASE.physicalCleaned
    ) {
      await this.completePurge(space)
    }
  }

  private async lifecycleForRecord(rec: SpaceRecord): Promise<SpaceLifecyclePhase> {
    const db = this.metaDb!
    let lifecycle = await db.spaceLifecycle.ensure(
      rec.id,
      rec.archivedAt ? SPACE_LIFECYCLE_PHASE.archived : SPACE_LIFECYCLE_PHASE.active,
      rec.archivedAt ?? rec.createdAt,
    )

    // Repair only the two safe commit-order cuts. Archive writes the row while
    // lifecycle is closing; restore clears the row before reopening lifecycle.
    if (rec.archivedAt && lifecycle.phase === SPACE_LIFECYCLE_PHASE.active) {
      const closing = await db.spaceLifecycle.transition({
        space: rec.id,
        expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
        phase: SPACE_LIFECYCLE_PHASE.closing,
        changedAt: rec.archivedAt,
        changedBy: rec.archivedBy,
      })
      lifecycle =
        closing.status === 'transitioned' || closing.status === 'phase-conflict'
          ? closing.lifecycle
          : lifecycle
      if (lifecycle.phase === SPACE_LIFECYCLE_PHASE.closing) {
        const archived = await db.spaceLifecycle.transition({
          space: rec.id,
          expectedPhases: [SPACE_LIFECYCLE_PHASE.closing],
          phase: SPACE_LIFECYCLE_PHASE.archived,
          changedAt: rec.archivedAt,
          changedBy: rec.archivedBy,
        })

        if (archived.status === 'transitioned' || archived.status === 'phase-conflict') {
          lifecycle = archived.lifecycle
        }
      }
    } else if (!rec.archivedAt && lifecycle.phase === SPACE_LIFECYCLE_PHASE.archived) {
      const active = await db.spaceLifecycle.transition({
        space: rec.id,
        expectedPhases: [SPACE_LIFECYCLE_PHASE.archived],
        phase: SPACE_LIFECYCLE_PHASE.active,
        changedAt: this.now().toISOString(),
      })

      if (active.status === 'transitioned' || active.status === 'phase-conflict') {
        lifecycle = active.lifecycle
      }
    }

    return lifecycle.phase
  }

  private async completeArchive(rec: SpaceRecord, changedBy: string | null): Promise<SpaceRecord> {
    const db = this.metaDb!
    const now = this.now().toISOString()
    const jobs = await db.jobs.list(rec.id, { statuses: ['pending', 'running'] })

    await Promise.all(jobs.map((job) => db.jobs.cancel(job.id, now)))

    try {
      await this.closeResourceAdmission?.(rec.id, this.lifecycleDrainMs)
    } catch (cause) {
      const error = spaceError(
        'space still has active resource operations',
        'space_busy',
      ) as Error & {
        cause?: unknown
      }
      error.cause = cause
      throw error
    }
    const [restoreBlockers, abilityBlockers] = await Promise.all([
      db.restoreOperations.listRecoverable(rec.id),
      db.abilityCreate ? db.abilityCreate.listRecoverable() : Promise.resolve([]),
    ])
    const blockers = [
      ...restoreBlockers.map((operation) => ({ kind: 'restore', operation })),
      ...abilityBlockers
        .filter((operation) => operation.space === rec.id)
        .map((operation) => ({ kind: 'ability-create', operation })),
    ]

    if (blockers.length) {
      throw spaceError(
        `space lifecycle is pinned by ${blockers[0].kind} operation ${blockers[0].operation.id}`,
        'space_busy',
      )
    }
    const entry = this.entries.get(rec.id)

    if (entry) {
      await this.evictStoreAndSettle(entry, 'archive')
    }
    const archivedAt = rec.archivedAt ?? this.now().toISOString()
    const archived: SpaceRecord = {
      ...rec,
      archivedAt,
      archivedBy: rec.archivedAt ? rec.archivedBy : changedBy,
    }

    await db.spaces.upsert(archived)
    const transition = await db.spaceLifecycle.transition({
      space: rec.id,
      expectedPhases: [SPACE_LIFECYCLE_PHASE.closing],
      phase: SPACE_LIFECYCLE_PHASE.archived,
      changedAt: archivedAt,
      changedBy: archived.archivedBy,
    })

    if (
      transition.status !== 'transitioned' &&
      !(
        transition.status === 'phase-conflict' &&
        transition.lifecycle.phase === SPACE_LIFECYCLE_PHASE.archived
      )
    ) {
      throw new Error(`space archive lifecycle changed concurrently: ${rec.id}`)
    }
    if (entry) {
      entry.rec = archived
      entry.lifecycle = SPACE_LIFECYCLE_PHASE.archived
    }

    return archived
  }

  private async completePurge(space: string): Promise<SpaceRecord> {
    const db = this.metaDb!
    let lifecycle = await db.spaceLifecycle.get(space)

    if (!lifecycle) {
      throw new Error(`purging space is missing lifecycle state: ${space}`)
    }
    if (lifecycle.phase === SPACE_LIFECYCLE_PHASE.purgeIntent) {
      const blockers = await db.restoreOperations.listRecoverable(space)

      if (blockers.length) {
        throw spaceError(
          `space purge is pinned by restore operation ${blockers[0].id}`,
          'space_busy',
        )
      }
      await db.purgeSpace(space)
      const cleaned = await db.spaceLifecycle.get(space)

      if (!cleaned) {
        throw new Error(`purging space lost lifecycle state: ${space}`)
      }
      lifecycle = cleaned
    }
    const manifest = decodeSpaceCleanupManifest(lifecycle.cleanupManifest)

    if (manifest.space.id !== space) {
      throw new Error(`space cleanup manifest id mismatch: ${space}`)
    }
    if (lifecycle.phase === SPACE_LIFECYCLE_PHASE.metadataCleaned) {
      await this.onPurge?.(manifest.space)
      const physical = await db.spaceLifecycle.transition({
        space,
        expectedPhases: [SPACE_LIFECYCLE_PHASE.metadataCleaned],
        phase: SPACE_LIFECYCLE_PHASE.physicalCleaned,
        changedAt: this.now().toISOString(),
      })

      if (physical.status === 'transitioned') {
        lifecycle = physical.lifecycle
      } else if (
        physical.status === 'phase-conflict' &&
        (physical.lifecycle.phase === SPACE_LIFECYCLE_PHASE.physicalCleaned ||
          physical.lifecycle.phase === SPACE_LIFECYCLE_PHASE.purged)
      ) {
        lifecycle = physical.lifecycle
      } else {
        throw new Error(`space physical cleanup lifecycle changed concurrently: ${space}`)
      }
    }
    if (lifecycle.phase === SPACE_LIFECYCLE_PHASE.physicalCleaned) {
      const purged = await db.spaceLifecycle.transition({
        space,
        expectedPhases: [SPACE_LIFECYCLE_PHASE.physicalCleaned],
        phase: SPACE_LIFECYCLE_PHASE.purged,
        changedAt: this.now().toISOString(),
      })

      if (
        purged.status !== 'transitioned' &&
        !(
          purged.status === 'phase-conflict' &&
          purged.lifecycle.phase === SPACE_LIFECYCLE_PHASE.purged
        )
      ) {
        throw new Error(`space purge lifecycle changed concurrently: ${space}`)
      }
    }

    return manifest.space
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
      const lifecycle = await this.metaDb.spaceLifecycle.get(d.id)

      if (lifecycle && lifecycle.phase !== SPACE_LIFECYCLE_PHASE.active) {
        console.warn(
          `[spaces] disk space ${d.notesDir}: marker id ${d.id} is fenced by lifecycle ${lifecycle.phase} — skipping adoption`,
        )
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
    return [...this.entries.values()]
      .filter((entry) => entry.lifecycle === SPACE_LIFECYCLE_PHASE.active)
      .map((entry) => entry.rec)
  }

  /** Every ARCHIVED space's record; membership-filtering is the caller's job. */
  listArchived(): SpaceRecord[] {
    return [...this.entries.values()]
      .filter((entry) => entry.lifecycle === SPACE_LIFECYCLE_PHASE.archived)
      .map((entry) => entry.rec)
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
    if (!entry || entry.lifecycle !== SPACE_LIFECYCLE_PHASE.active) {
      throw spaceNotFound(id)
    }

    return this.loadStore(entry, false)
  }

  /** Boot or reuse the projection owned by one admitted durable operation. The
   * public store door remains active-only; only a verified operation may keep its
   * private projection alive while archive is draining in `closing`. */
  private async loadStore(
    entry: SpaceEntry,
    allowClosing: boolean,
    primeIdentity?: IdentityRecord,
  ): Promise<SpaceStore> {
    const lifecycleAllowed = () =>
      entry.lifecycle === SPACE_LIFECYCLE_PHASE.active ||
      (allowClosing && entry.lifecycle === SPACE_LIFECYCLE_PHASE.closing)

    if (!lifecycleAllowed()) {
      throw spaceNotFound(entry.rec.id)
    }
    entry.lastAccess = Date.now()
    if (!entry.storePromise) {
      const rec = entry.rec
      const booting: Promise<SpaceStore> = Promise.resolve()
        .then(() => this.createStore(rec))
        .then(async (store) => {
          // Evicted/archived WHILE booting: a concurrent archive()/idle-eviction nulled
          // storePromise. Don't install this now-stale store — it would leak a started
          // store on an archived space and double-open its .db on restore. Tear it down.
          if (entry.storePromise !== booting || !lifecycleAllowed()) {
            store.stop?.()
            return store
          }
          entry.store = store
          if (primeIdentity) {
            if (!store.primeCommittedIdentity) {
              throw new Error(`space ${rec.id} cannot prime a causal identity before boot`)
            }
            await store.primeCommittedIdentity(primeIdentity)
          }
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

    if (primeIdentity) {
      if (!store.primeCommittedIdentity) {
        throw new Error(`space ${entry.rec.id} cannot prime a causal identity`)
      }
      await store.primeCommittedIdentity(primeIdentity)
    }

    if (entry.identityReadyRequired) {
      // resolveNote runs before resource auth. Defer the potentially expensive
      // boot/readiness barrier to the later store() handoff so an inaccessible
      // note cannot warm its space; a rejection keeps the latch set for retry.
      await store.identityReady?.()
      entry.identityReadyRequired = false
    }

    return store
  }

  private async acceptedCausalPublication(
    space: string,
    accepted: AcceptedCausalPublication,
  ): Promise<{ valid: boolean; identity?: IdentityRecord }> {
    if (!this.metaDb) {
      return { valid: false }
    }
    if (accepted.kind === 'restore') {
      const operation = await this.metaDb.restoreOperations.get(accepted.operationId)

      return {
        valid:
          operation?.space === space &&
          operation.phase !== 'succeeded' &&
          operation.phase !== 'rejected',
      }
    }
    const operation = await this.metaDb.abilityCreate?.get(accepted.operationId)
    const valid =
      operation?.space === space &&
      operation.phase !== 'succeeded' &&
      operation.phase !== 'rejected'

    return {
      valid,
      ...(valid && operation
        ? {
            identity: {
              id: operation.noteId,
              filePath: operation.targetPath,
              space: operation.space,
              createdAt: operation.createdAt,
              materialized: false,
              deletedAt: null,
              addressRevision: 1,
              legacyNameAliases: [],
            },
          }
        : {}),
    }
  }

  /** Outbox recovery for this replica. An inactive space has no live projection
   * to repair; its next activation cold-boots from physical truth. */
  async reconcileCausalProjection(space: string, resourceId?: string): Promise<void> {
    const entry = this.entries.get(space)

    if (!entry || entry.lifecycle !== SPACE_LIFECYCLE_PHASE.active) {
      return
    }
    const store = await this.store(space)

    if (!store.reconcile) {
      throw new Error(`space ${space} cannot reconcile causal outbox events`)
    }
    if (this.metaDb?.identity.findById) {
      const noteIds = resourceId ? [resourceId] : []

      for (const noteId of noteIds) {
        await store.adoptCausalIdentity?.(noteId)
      }
    }
    await store.identityReady?.()
    await store.reconcile()
  }

  async beginCausalPublication(
    space: string,
    accepted?: AcceptedCausalPublication,
  ): Promise<() => void> {
    const entry = this.entries.get(space)

    if (
      !entry ||
      (entry.lifecycle !== SPACE_LIFECYCLE_PHASE.active &&
        entry.lifecycle !== SPACE_LIFECYCLE_PHASE.closing)
    ) {
      throw spaceNotFound(space)
    }
    const acceptedState = accepted
      ? await this.acceptedCausalPublication(space, accepted)
      : { valid: false }
    const acceptedVerified = acceptedState.valid

    if (entry.lifecycle === SPACE_LIFECYCLE_PHASE.closing && !acceptedVerified) {
      throw spaceNotFound(space)
    }
    entry.causalPublicationRefs++

    try {
      const store = await this.loadStore(entry, acceptedVerified, acceptedState.identity)

      if (!store.beginCausalPublication) {
        throw new Error(`space ${space} cannot fence a causal publication`)
      }
      const releaseStore = await store.beginCausalPublication()
      let held = true

      return () => {
        if (!held) {
          return
        }
        held = false
        releaseStore()
        entry.causalPublicationRefs--
      }
    } catch (error) {
      entry.causalPublicationRefs--
      throw error
    }
  }

  async primeWarmCausalIdentity(space: string, record: IdentityRecord): Promise<void> {
    const entry = this.entries.get(space)

    if (!entry?.storePromise) {
      return
    }
    const store = await entry.storePromise

    if (!store.primeCommittedIdentity) {
      throw new Error(`space ${space} cannot prime a causal identity`)
    }
    await store.primeCommittedIdentity(record)
  }

  async confirmCausalIdentity(space: string, noteId: string): Promise<void> {
    await (await this.causalProjectionStore(space)).confirmCommittedIdentity?.(noteId)
  }

  async releasePrimedIdentity(space: string, noteId: string): Promise<void> {
    await (await this.causalProjectionStore(space)).releasePrimedIdentity?.(noteId)
  }

  async adoptCausalPublication(
    space: string,
    evidence: PublishedResourceEvidence,
  ): Promise<DocumentState> {
    const store = await this.causalProjectionStore(space)

    if (!store.adoptPublishedResource) {
      throw new Error(`space ${space} cannot adopt a durable publication`)
    }
    if (evidence.identity) {
      await store.primeCommittedIdentity?.(evidence.identity)
    }

    return store.adoptPublishedResource(evidence)
  }

  private causalProjectionStore(space: string): Promise<SpaceStore> {
    const entry = this.entries.get(space)

    if (!entry || entry.causalPublicationRefs === 0) {
      throw spaceNotFound(space)
    }

    return this.loadStore(entry, true)
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

      if (entry?.lifecycle === SPACE_LIFECYCLE_PHASE.active) {
        entry.identityReadyRequired = true
      }

      return { space: rec.space, deletedAt: rec.deletedAt }
    }
    for (const [spaceId, entry] of this.entries) {
      if (entry.lifecycle !== SPACE_LIFECYCLE_PHASE.active) {
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
    await this.metaDb?.spaceLifecycle.ensure(rec.id, SPACE_LIFECYCLE_PHASE.active, rec.createdAt)
    this.register(rec, false, SPACE_LIFECYCLE_PHASE.active)
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
    await this.evictStore(entry, 'remove')
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

    if (!entry || entry.lifecycle === SPACE_LIFECYCLE_PHASE.archived) {
      throw spaceNotFound(id)
    }
    if (entry.lifecycle !== SPACE_LIFECYCLE_PHASE.closing) {
      const transition = await this.metaDb.spaceLifecycle.transition({
        space: id,
        expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
        phase: SPACE_LIFECYCLE_PHASE.closing,
        changedAt: this.now().toISOString(),
        changedBy: by ?? null,
      })

      if (transition.status !== 'transitioned') {
        throw spaceError('space lifecycle changed concurrently', 'space_busy')
      }
      entry.lifecycle = SPACE_LIFECYCLE_PHASE.closing
    }

    const lifecycle = await this.metaDb.spaceLifecycle.get(id)
    return this.completeArchive(entry.rec, lifecycle?.changedBy ?? by ?? null)
  }

  /** Restore an archived space: clear the mark; the store boots lazily on next
   *  touch, reopening its kept index file (no reindex). */
  async restore(id: string): Promise<SpaceRecord> {
    if (!this.metaDb) {
      throw spaceError('restoring needs a space registry', 'unsupported')
    }
    const entry = this.entries.get(id)

    if (!entry || entry.lifecycle !== SPACE_LIFECYCLE_PHASE.archived || !entry.rec.archivedAt) {
      throw spaceNotFound(id)
    }
    const rec: SpaceRecord = { ...entry.rec, archivedAt: null, archivedBy: null }

    this.reopenResourceAdmission?.(id)
    await this.metaDb.spaces.upsert(rec)
    const transition = await this.metaDb.spaceLifecycle.transition({
      space: id,
      expectedPhases: [SPACE_LIFECYCLE_PHASE.archived],
      phase: SPACE_LIFECYCLE_PHASE.active,
      changedAt: this.now().toISOString(),
    })

    if (
      transition.status !== 'transitioned' &&
      !(
        transition.status === 'phase-conflict' &&
        transition.lifecycle.phase === SPACE_LIFECYCLE_PHASE.active
      )
    ) {
      throw spaceError('space lifecycle changed concurrently', 'space_busy')
    }
    entry.rec = rec
    entry.lifecycle = SPACE_LIFECYCLE_PHASE.active
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
    if (
      entry.lifecycle !== SPACE_LIFECYCLE_PHASE.archived &&
      entry.lifecycle !== SPACE_LIFECYCLE_PHASE.purgeIntent &&
      entry.lifecycle !== SPACE_LIFECYCLE_PHASE.metadataCleaned &&
      entry.lifecycle !== SPACE_LIFECYCLE_PHASE.physicalCleaned
    ) {
      throw spaceError('archive the space before purging it', 'not_archived')
    }
    if (entry.lifecycle === SPACE_LIFECYCLE_PHASE.archived) {
      const transition = await this.metaDb.spaceLifecycle.transition({
        space: id,
        expectedPhases: [SPACE_LIFECYCLE_PHASE.archived],
        phase: SPACE_LIFECYCLE_PHASE.purgeIntent,
        changedAt: this.now().toISOString(),
        cleanupManifest: encodeSpaceCleanupManifest(entry.rec),
      })

      if (transition.status !== 'transitioned') {
        throw spaceError('space purge lifecycle changed concurrently', 'space_busy')
      }
      entry.lifecycle = SPACE_LIFECYCLE_PHASE.purgeIntent
    }
    await this.evictStoreAndSettle(entry, 'purge')
    await this.completePurge(id)
    this.entries.delete(id)
    this.rebuildSlugIndex()
  }

  /** Stop + settle + drop the live store while KEEPING the entry (so the slug stays
   *  reserved). Idempotent — a no-op when nothing is booted. */
  private evictStore(entry: SpaceEntry, operation = 'evict'): Promise<void> {
    const booting = entry.storePromise
    const store = entry.store
    entry.store = null
    entry.storePromise = null
    if (store) {
      store.stop?.()
      return this.trackSettle(store, operation)
    }

    return booting
      ? booting.then(
          (booted) => this.trackSettle(booted, operation),
          () => undefined,
        )
      : Promise.resolve()
  }

  private async evictStoreAndSettle(entry: SpaceEntry, operation: string): Promise<void> {
    const store = entry.store
    const booting = entry.storePromise

    try {
      await this.evictStore(entry, operation)
    } catch (error) {
      const retryable = store ?? (await booting?.catch(() => null))

      if (retryable && !entry.store && !entry.storePromise) {
        entry.store = retryable
        entry.storePromise = Promise.resolve(retryable)
      }
      throw error
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

  private register(
    rec: SpaceRecord,
    config: boolean,
    lifecycle: SpaceLifecyclePhase = rec.archivedAt
      ? SPACE_LIFECYCLE_PHASE.archived
      : SPACE_LIFECYCLE_PHASE.active,
  ): void {
    this.entries.set(rec.id, {
      rec,
      lifecycle,
      config,
      storePromise: null,
      store: null,
      lastAccess: 0,
      sseRefs: 0,
      causalPublicationRefs: 0,
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
      if (
        !entry.store ||
        entry.sseRefs > 0 ||
        entry.causalPublicationRefs > 0 ||
        entry.lastAccess > cutoff
      ) {
        continue
      }
      const store = entry.store
      entry.store = null
      entry.storePromise = null
      store.stop?.()
      void this.trackSettle(store, 'evict')
    }
  }

  private trackSettle(store: SpaceStore, operation: string): Promise<void> {
    const task = Promise.resolve(store.settle?.())
    this.settling.add(task)
    void task.then(
      () => this.settling.delete(task),
      (err) => {
        this.settling.delete(task)
        console.error(`[spaces] ${operation} settle ->`, (err as Error).message)
      },
    )
    return task
  }

  private async drainSettling(): Promise<void> {
    while (this.settling.size > 0) {
      await Promise.all([...this.settling])
    }
  }
}
