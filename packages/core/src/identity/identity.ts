// In-memory registry of note identity: filePath ↔ internal note-id, with
// write-behind persistence (synchronous lookups/mutations, batched async
// flushes). Losing the tail of a flush degrades softly: auto-ids regenerate on
// the next boot, materialized ids re-adopt from the files themselves.
// canon: docs/core.md#identity · docs/architecture.md#p7

import { DEFAULT_SPACE } from '../knowledgeStore'
import type { IdentityPersistence, IdentityRecord } from '../knowledgeStore'
import { freshNoteId, isValidNoteId } from '../libs/id'
import type { AdoptResult } from './types'

const FLUSH_DELAY_MS = 500

export class IdentityRegistry {
  private byPath = new Map<string, IdentityRecord>()
  private byId = new Map<string, IdentityRecord>()
  private dirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** The one persistence writer. A timer flush, an explicit create flush and
   *  graceful settle may arrive together; all of them join this tail so an
   *  older batch can never commit after a newer one. */
  private flushTask: Promise<void> | null = null
  private persistence?: IdentityPersistence
  /** Timer retries must cross the owning read-model's publication checkpoint.
   *  Falling back to flush() keeps the registry useful as a standalone unit,
   *  while CachedStore injects its durability + repair completion hook. */
  private readonly requestFlush: () => Promise<void>
  private readonly now: () => Date
  /** The space this registry's engine serves. Today
   *  one registry = one space; multi-space wiring is deferred design work. */
  private readonly space: string

  constructor({
    persistence,
    space = DEFAULT_SPACE,
    now = () => new Date(),
    requestFlush,
  }: {
    persistence?: IdentityPersistence
    space?: string
    now?: () => Date
    requestFlush?: () => Promise<void>
  } = {}) {
    this.persistence = persistence
    this.space = space
    this.now = now
    this.requestFlush = requestFlush ?? (() => this.flush())
  }

  /** Load the persisted registry — strictly this space's rows (the
   *  persistence filters; legacy '' rows are adopted into the legacy
   *  single-space's slug at host boot, before any registry loads). Without
   *  persistence this is a no-op and ids live for the process lifetime
   *  (honest degradation, P5). */
  async load(): Promise<void> {
    if (!this.persistence) {
      return
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.persistence.init()
    const loadedByPath = new Map<string, IdentityRecord>()
    const loadedById = new Map<string, IdentityRecord>()
    const canonicalized: IdentityRecord[] = []

    // Build a completely detached image. A retry after a failed load must
    // never combine a partial/ephemeral ownership map with the authoritative
    // rows it is about to install.
    for (const raw of await this.persistence.loadAll(this.space)) {
      const rec = { ...raw }

      if (!isValidNoteId(rec.id)) {
        continue
      }
      // Legacy rows carry the engine's native timestamp form
      // ("+00:00" offset, microseconds) — canonicalise so one shape reaches
      // the wire; the write-behind flush makes it durable.
      if (rec.createdAt && !rec.createdAt.endsWith('Z')) {
        const t = Date.parse(rec.createdAt)

        if (!Number.isNaN(t)) {
          rec.createdAt = new Date(t).toISOString()
          canonicalized.push(rec)
        }
      }
      loadedById.set(rec.id, rec)
      if (!rec.deletedAt) {
        loadedByPath.set(rec.filePath, rec)
      }
    }
    this.byPath = loadedByPath
    this.byId = loadedById
    this.dirty.clear()
    this.dropped.clear()
    for (const rec of canonicalized) {
      this.markDirty(rec)
    }
  }

  idFor(filePath: string): string | undefined {
    return this.byPath.get(filePath)?.id
  }

  pathFor(id: string): string | undefined {
    const rec = this.byId.get(id)
    return rec && !rec.deletedAt ? rec.filePath : undefined
  }

  recordFor(id: string): IdentityRecord | undefined {
    return this.byId.get(id)
  }

  /** Read-only authoritative probe used only while the full per-space load is
   *  unavailable. It distinguishes a plain stable-id spelling from a human
   *  name without installing or dirtying any registry state. */
  async persistedRecordFor(id: string): Promise<IdentityRecord | null | undefined> {
    return this.persistence?.findById ? this.persistence.findById(id) : undefined
  }

  /** Overwrite a record's persisted creation date. `ensure` only fills a
   *  NULL date (first-sight pinning, so a birthtime flap never moves the Feed); an
   *  authored edit is the one path that deliberately RESETS it, so the new date
   *  survives a restart (the registry is the Feed-date authority for a bare engine,
   *  adoptMeta reads it back). No-op when the id is unknown (an identity-capable
   *  inner engine owns its own dates — adoptMeta passes those through untouched). */
  setCreatedAt(id: string, createdAt: string): void {
    const rec = this.byId.get(id)

    if (!rec || rec.createdAt === createdAt) {
      return
    }
    rec.createdAt = createdAt
    this.markDirty(rec)
  }

  /** The live path's record, minting a fresh id when the path is new. The
   *  registry IS the id authority — frontmatter refines it via adoptFileId. */
  ensure(filePath: string, createdAt?: string | null): IdentityRecord {
    const existing = this.byPath.get(filePath)

    if (existing) {
      if (existing.createdAt == null && createdAt) {
        existing.createdAt = createdAt
        this.markDirty(existing)
      }

      return existing
    }
    const rec: IdentityRecord = {
      id: freshNoteId(),
      // null stays null on purpose: the boot inventory doesn't know creation
      // dates, and stamping "now" there would persist a lie for the whole
      // base. Callers that genuinely create the note pass the date explicitly.
      createdAt: createdAt ?? null,
      filePath,
      space: this.space,
      materialized: false,
      deletedAt: null,
    }
    this.byPath.set(filePath, rec)
    this.byId.set(rec.id, rec)
    this.markDirty(rec)
    return rec
  }

  /** Reconcile a file's frontmatter id claim with the registry. The file wins
   *  except when its id already belongs to another live path (a copied file).
   *  `createdAt` (an import) seeds a NEW record's birth date with the note's
   *  true creation instant instead of "now" — so an imported conversation keeps
   *  the date it actually happened across the registry persistence + a restart. */
  adoptFileId(filePath: string, fileId: string, createdAt?: string | null): AdoptResult {
    const current = this.byPath.get(filePath)

    if (current?.id === fileId) {
      if (!current.materialized) {
        current.materialized = true
        this.markDirty(current)
      }

      return { kind: 'noop' }
    }
    const owner = this.byId.get(fileId)

    if (owner && !owner.deletedAt && owner.filePath !== filePath) {
      return { kind: 'duplicate', ownerPath: owner.filePath }
    }
    // The claim is free (unknown id) or a tombstone (external move re-adopts).
    const previousId = current?.id ?? null

    if (current) {
      // The path's auto-id loses to the file's materialized claim.
      this.byId.delete(current.id)
      this.persistDrop(current)
    }
    const rec: IdentityRecord = {
      id: fileId,
      filePath,
      space: this.space,
      createdAt: owner?.createdAt ?? current?.createdAt ?? createdAt ?? this.iso(),
      materialized: true,
      deletedAt: null,
    }
    this.byPath.set(filePath, rec)
    this.byId.set(fileId, rec)
    this.markDirty(rec)
    return { kind: 'adopted', previousId }
  }

  /** A move/rename through us: the id follows the note to its new path. */
  rename(oldPath: string, newPath: string): IdentityRecord | undefined {
    const rec = this.byPath.get(oldPath)

    if (!rec || oldPath === newPath) {
      return rec
    }
    const occupant = this.byPath.get(newPath)

    if (occupant && occupant.id !== rec.id) {
      occupant.deletedAt = this.iso()
      this.markDirty(occupant)
    }
    this.byPath.delete(oldPath)
    rec.filePath = newPath
    this.byPath.set(newPath, rec)
    this.markDirty(rec)
    return rec
  }

  /** A folder move/rename through us: every binding under the prefix follows
   *  its file, so a subtree drag never orphans the subtree's identity. */
  renamePrefix(oldPrefix: string, newPrefix: string): void {
    if (oldPrefix === newPrefix) {
      return
    }
    const prefix = oldPrefix.endsWith('/') ? oldPrefix : oldPrefix + '/'

    for (const path of [...this.byPath.keys()]) {
      if (!path.startsWith(prefix)) {
        continue
      }
      this.rename(path, newPrefix.replace(/\/$/, '') + '/' + path.slice(prefix.length))
    }
  }

  /** The path disappeared from the inventory. Returns the tombstoned id. */
  markDeleted(filePath: string): string | undefined {
    const rec = this.byPath.get(filePath)

    if (!rec) {
      return undefined
    }
    this.byPath.delete(filePath)
    rec.deletedAt = this.iso()
    this.markDirty(rec)
    return rec.id
  }

  /** Reconcile live bindings against an authoritative storage inventory.
   *  Tombstones stay in byId for history/restore, while stale path lookups stop
   *  routing mutations to files that disappeared before this process saw them. */
  reconcileLivePaths(filePaths: Iterable<string>): void {
    const live = new Set(filePaths)

    for (const path of [...this.byPath.keys()]) {
      if (!live.has(path)) {
        this.markDeleted(path)
      }
    }
  }

  markMaterialized(id: string): void {
    const rec = this.byId.get(id)

    if (!rec || rec.materialized) {
      return
    }
    rec.materialized = true
    this.markDirty(rec)
  }

  /** Push pending changes to persistence now (boot sweep end, host shutdown). */
  async flush(): Promise<void> {
    if (!this.persistence) {
      return
    }

    for (;;) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer)
        this.flushTimer = null
      }
      if (!this.flushTask) {
        if (!this.dirty.size) {
          return
        }
        const drain = this.flushDirty()
        const tracked = drain.finally(() => {
          if (this.flushTask !== tracked) {
            return
          }
          this.flushTask = null
          if (this.dirty.size) {
            this.scheduleFlush()
          }
        })
        this.flushTask = tracked
      }
      await this.flushTask
      // Dirt can land after flushDirty observed an empty set but before its
      // tracked promise settles. An explicit caller that joined that tail must
      // include such work rather than merely leave it to the debounce timer.
      if (!this.dirty.size) {
        return
      }
    }
  }

  /** Drain strictly one batch at a time. Mutations that land while persistence
   *  is awaiting keep their id dirty and become the next batch. On failure the
   *  failed ids are merged back without replacing any newer in-memory record. */
  private async flushDirty(): Promise<void> {
    while (this.dirty.size) {
      const ids = [...this.dirty]
      const batch: IdentityRecord[] = []
      const droppedInBatch = new Map<string, IdentityRecord>()

      this.dirty.clear()
      for (const id of ids) {
        const live = this.byId.get(id)
        const dropped = this.dropped.get(id)
        const rec = live ?? dropped

        if (rec) {
          batch.push({ ...rec })
          if (!live && dropped) {
            droppedInBatch.set(id, { ...dropped })
          }
        }
        // A newer mutation of this id will put its current record back while
        // this batch is in flight. Removing only this id preserves unrelated
        // dropped records accumulated after the snapshot.
        this.dropped.delete(id)
      }

      try {
        await this.persistence!.upsertMany(batch)
      } catch (err) {
        for (const rec of batch) {
          this.dirty.add(rec.id)
        }
        for (const [id, rec] of droppedInBatch) {
          if (!this.byId.has(id) && !this.dropped.has(id)) {
            this.dropped.set(id, rec)
          }
        }
        throw err
      }
    }
  }

  /** Records whose id was superseded (adoptFileId) still need their tombstone
   *  persisted — they are no longer reachable via byId. */
  private dropped = new Map<string, IdentityRecord>()

  private persistDrop(rec: IdentityRecord): void {
    rec.deletedAt = this.iso()
    this.dropped.set(rec.id, rec)
    this.dirty.add(rec.id)
    this.scheduleFlush()
  }

  private markDirty(rec: IdentityRecord): void {
    this.dirty.add(rec.id)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (!this.persistence || this.flushTimer || this.flushTask) {
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.requestFlush().catch((err) =>
        console.error('[identity] flush failed:', (err as Error).message),
      )
    }, FLUSH_DELAY_MS)
    this.flushTimer.unref?.()
  }

  private iso(): string {
    return this.now().toISOString()
  }
}
