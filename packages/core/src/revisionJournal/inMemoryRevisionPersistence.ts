// In-memory driver of the revision persistence port: the journal's twin of the
// ephemeral identity registry — a host without a meta-DB still journals, the
// history just lives for the process lifetime (honest degradation, P5). Also
// the e2e fake's journal and the reference implementation unit tests pin.
//
// It never DECIDES a quarantine: the integrity graph is closed inside the meta-DB
// aggregate's settlement transaction, and a host with no shared persistence makes
// no global identity promise to contaminate in the first place (#327). It does
// SERVE the axis, through a test-only injection — otherwise every consumer above
// it (REST, MCP, the session audit) would have no way to see a gap at all, and
// their gap contracts would be untestable rather than merely untested.

import {
  type ActivityDayCount,
  type ActivityNoteCount,
  type ActivityNoteGroupCount,
  type ActivityProjectionGcMaintenance,
  type ActivityProjectionLease,
  type ActivityProjectionMaintenance,
  type ActivityProjectionPreparation,
  activityProjectionStale,
  type AuthorFilter,
  isRevisionRestorable,
  type Revision,
  REVISION_ENTRY_ROLE,
  REVISION_KIND,
  REVISION_RESTORE_AVAILABILITY,
  type RevisionBlob,
  revisionGapOf,
  type RevisionInput,
  type RevisionPersistence,
  revisionRestoreAvailability,
  type TrashAvailabilityFilter,
} from '../knowledgeStore'
import { RevisionHeadConflictError } from '../knowledgeStore/revisionHeadConflictError'

/** The LOCAL calendar day of a UTC instant, shifted east by `tzOffsetMinutes`
 *  (the client's UTC offset, JS `-getTimezoneOffset()`), as YYYY-MM-DD. Shared
 *  by the in-memory driver; the SQL drivers do the same arithmetic in-query. */
export const localDayOf = (iso: string, tzOffsetMinutes: number): string => {
  const shifted = new Date(Date.parse(iso) + tzOffsetMinutes * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** A revision that does NOT count as activity: a synthetic pre-edit baseline or a
 *  first sighting. It is READ off the row — the writer stamped it — because the shape
 *  it used to be inferred from (`external` with no chain parent) stopped meaning
 *  "first entry" once a contaminated chain could leave a note with no trusted parent
 *  at all (#327). The SQL drivers encode the same predicate as
 *  `entry_role <> 'baseline'`. */
export const isSyntheticBaseline = (r: { entryRole: Revision['entryRole'] }): boolean =>
  r.entryRole === REVISION_ENTRY_ROLE.baseline

/** The reference implementation of an AuthorFilter — the exact predicate the
 *  SQL drivers encode as `principal IN (…exact) OR principal LIKE prefix || '%'`. A
 *  null principal (external state) never matches; a filter matches when the principal
 *  is one of `exact` or begins with one of `prefixes`. Used by the in-memory driver
 *  and shared with tests so all three drivers pin the same semantics. */
export const matchesAuthor = (principal: string | null, f: AuthorFilter): boolean => {
  if (principal == null) {
    return false
  }

  return f.exact.includes(principal) || f.prefixes.some((p) => principal.startsWith(p))
}

const revisionIdCompare = (left: string, right: string): number => {
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}

export class InMemoryRevisionPersistence implements RevisionPersistence {
  private revisions: Revision[] = []
  private blobs = new Map<string, RevisionBlob>()
  /** Permanent note fences, keyed `space\u0000noteId` — scoped exactly like the
   *  purge itself, so one space's purge cannot silence a colliding id in another. */
  private purgedNotes = new Set<string>()
  private purgePins = new Map<string, number>()
  /** Revision ids served as a gap. Ids come from one monotonic counter, so they
   *  are unique without a space key and are never reused after a purge. */
  private quarantined = new Set<string>()
  private activityGeneration = new Map<string, number>()
  private nextId = 1

  /** Whether this row's payload can still be believed — the twin of the drivers'
   *  `integrity` column. The queries below must classify, filter and count on the
   *  EFFECTIVE values, which is what the three predicates under it encode. */
  private isGap(r: Revision): boolean {
    return this.quarantined.has(r.id)
  }

  /** The ONE place a stored row becomes a served row (`revisionOfRow` in the drivers). */
  private serve = (r: Revision): Revision => (this.isGap(r) ? revisionGapOf(r) : r)

  /** Class exclusion on the EFFECTIVE class: a gap's class is null, so a hidden-class
   *  filter never excludes it and its real class is never consulted. */
  private classAllows(r: Revision, excludeClasses: readonly string[]): boolean {
    return this.isGap(r) || r.class == null || !excludeClasses.includes(r.class)
  }

  /** Author scope on the EFFECTIVE principal: a gap belongs to nobody, so no filter
   *  ever matches it — not `mine`, not anyone else's. */
  private authorAllows(r: Revision, author?: AuthorFilter): boolean {
    return author == null || (!this.isGap(r) && matchesAuthor(r.principal, author))
  }

  /** Synthetic-baseline suppression on effective fields: a gap has no readable
   *  parent, so the predicate cannot apply — it always emits. */
  private countsAsActivity(r: Revision): boolean {
    return this.isGap(r) || !isSyntheticBaseline(r)
  }

  async init(): Promise<void> {}

  async prepareActivityProjection(space: string): Promise<ActivityProjectionPreparation> {
    const generation = String(this.activityGeneration.get(space) ?? 1)
    const through = this.revisions
      .filter((revision) => revision.space === space)
      .reduce<string | null>(
        (latest, revision) =>
          latest == null || BigInt(revision.id) > BigInt(latest) ? revision.id : latest,
        null,
      )

    return {
      state: 'ready' as const,
      lease: { through, activeGeneration: generation, sourceGeneration: generation },
    }
  }

  async maintainActivityProjection(): Promise<ActivityProjectionMaintenance> {
    return { state: 'ready' as const, processed: 0, published: false }
  }

  async maintainActivityProjectionGc(): Promise<ActivityProjectionGcMaintenance> {
    return { deleted: 0, pending: false }
  }

  protectFromPurge(space: string, noteIds: readonly string[]): void {
    for (const noteId of new Set(noteIds)) {
      const key = `${space}\u0000${noteId}`
      this.purgePins.set(key, (this.purgePins.get(key) ?? 0) + 1)
    }
  }

  releasePurgeProtection(space: string, noteIds: readonly string[]): void {
    for (const noteId of new Set(noteIds)) {
      const key = `${space}\u0000${noteId}`
      const remaining = (this.purgePins.get(key) ?? 0) - 1

      if (remaining > 0) {
        this.purgePins.set(key, remaining)
      } else {
        this.purgePins.delete(key)
      }
    }
  }

  async append(rev: RevisionInput, content: RevisionBlob | null): Promise<Revision> {
    return this.appendForRestoreTerminal(rev, content)
  }

  /** Synchronous aggregate seam used only by the in-memory restore terminal.
   * Keeping the whole terminal transaction in one turn prevents another caller
   * from observing or changing a half-applied journal/proof/operation state. */
  appendForRestoreTerminal(rev: RevisionInput, content: RevisionBlob | null): Revision {
    if (this.purgedNotes.has(`${rev.space}\u0000${rev.noteId}`)) {
      throw new Error('revision target was permanently purged: note')
    }
    const head = this.latestTrusted(rev.space, rev.noteId)

    if (
      rev.expectedHeadRevisionId !== undefined &&
      (head?.id ?? null) !== rev.expectedHeadRevisionId
    ) {
      throw new RevisionHeadConflictError(rev.noteId, rev.expectedHeadRevisionId, head?.id ?? null)
    }
    if (
      rev.expectedHeadRevisionId !== undefined &&
      rev.baseRevisionId !== rev.expectedHeadRevisionId
    ) {
      throw new Error('revision base must equal the expected head')
    }
    const lifecycle = rev.kind === REVISION_KIND.delete ? 'deleted' : 'live'
    const headLifecycle = head?.kind === REVISION_KIND.delete ? 'deleted' : 'live'

    if (
      rev.allowSemanticNoop === true &&
      rev.semanticFingerprint != null &&
      head?.semanticFingerprint === rev.semanticFingerprint &&
      headLifecycle === lifecycle
    ) {
      return { ...head, tags: [...head.tags] }
    }
    if (rev.contentHash != null && content != null && !this.blobs.has(rev.contentHash)) {
      this.blobs.set(
        rev.contentHash,
        typeof content === 'string' ? content : Uint8Array.from(content),
      )
    }
    const storedInput = { ...rev }
    delete storedInput.allowSemanticNoop
    delete storedInput.expectedHeadRevisionId
    const stored: Revision = {
      ...storedInput,
      semanticFingerprint: rev.semanticFingerprint ?? null,
      stateFormat: rev.stateFormat ?? null,
      restoreSafety: rev.restoreSafety ?? null,
      tags: [...rev.tags],
      id: String(this.nextId++),
    }
    this.revisions.push(stored)
    return { ...stored, tags: [...stored.tags] }
  }

  async listByNote(
    space: string,
    noteId: string,
    { offset, limit }: { offset: number; limit: number },
  ): Promise<{ items: Revision[]; total: number }> {
    // Append order IS the timeline; ids are monotonic by construction.
    const all = this.revisions.filter((r) => r.space === space && r.noteId === noteId).reverse()
    return { items: all.slice(offset, offset + limit).map(this.serve), total: all.length }
  }

  async listBySpaceSince(
    space: string,
    sinceRevId: string | null,
    limit: number,
    excludeClasses: readonly string[] = [],
  ): Promise<{ items: Revision[]; total: number; maxRevId: string | null }> {
    const since = sinceRevId == null ? 0 : Number(sinceRevId)
    const after = this.revisions.filter(
      (r) => r.space === space && Number(r.id) > since && this.classAllows(r, excludeClasses),
    )

    if (!after.length) {
      return { items: [], total: 0, maxRevId: null }
    }
    // Collapse to the newest revision per note (append order IS id order).
    const newestByNote = new Map<string, Revision>()
    let maxId = 0

    for (const r of after) {
      const id = Number(r.id)

      if (id > maxId) {
        maxId = id
      }
      const cur = newestByNote.get(r.noteId)

      if (!cur || id > Number(cur.id)) {
        newestByNote.set(r.noteId, r)
      }
    }
    const items = [...newestByNote.values()]
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, limit)
      .map(this.serve)
    return { items, total: newestByNote.size, maxRevId: String(maxId) }
  }

  async get(space: string, revisionId: string): Promise<Revision | null> {
    return this.getForRestoreTerminal(space, revisionId)
  }

  getForRestoreTerminal(space: string, revisionId: string): Revision | null {
    const row = this.revisions.find((r) => r.space === space && r.id === revisionId)
    return row ? this.serve(row) : null
  }

  async listTrashed(
    space: string,
    {
      offset,
      limit,
      q,
      availability,
    }: { offset: number; limit: number; q?: string; availability?: TrashAvailabilityFilter },
    excludeClasses: readonly string[] = [],
  ): Promise<{ items: Revision[]; total: number; restorableTotal: number; partialTotal: number }> {
    // Newest revision per note (excluded classes dropped BEFORE the collapse, so
    // a hidden class can't become "newest survivor" — mirrors the SQL drivers).
    const newestByNote = new Map<string, Revision>()

    for (const r of this.revisions) {
      // Trash is a TRUSTED view: a gap withholds the kind's meaning, so a
      // quarantined row neither becomes a tombstone nor hides the one below it.
      if (r.space !== space || this.isGap(r)) {
        continue
      }
      if (r.class != null && excludeClasses.includes(r.class)) {
        continue
      }
      const cur = newestByNote.get(r.noteId)

      if (!cur || Number(r.id) > Number(cur.id)) {
        newestByNote.set(r.noteId, r)
      }
    }
    const needle = q?.trim().toLowerCase()
    const tombstones = [...newestByNote.values()]
      .filter((r) => r.kind === REVISION_KIND.delete)
      .filter((r) => !needle || r.title.toLowerCase().includes(needle))
      .filter(
        (revision) =>
          availability == null ||
          (availability === 'restorable') === isRevisionRestorable(revision),
      )
      .sort((a, b) => Number(b.id) - Number(a.id))
    return {
      items: tombstones.slice(offset, offset + limit),
      total: tombstones.length,
      restorableTotal: tombstones.filter(isRevisionRestorable).length,
      partialTotal: tombstones.filter(
        (revision) =>
          revisionRestoreAvailability(revision) === REVISION_RESTORE_AVAILABILITY.partial,
      ).length,
    }
  }

  async purgeNotes(
    space: string,
    noteIds: readonly string[],
    expectedLatest?: ReadonlyMap<string, string>,
  ): Promise<readonly string[]> {
    const candidates = new Set(noteIds)

    for (const noteId of candidates) {
      if (this.purgePins.has(`${space}\u0000${noteId}`)) {
        candidates.delete(noteId)
      }
    }

    const ids = new Set(
      expectedLatest
        ? [...candidates].filter((noteId) => {
            const expected = expectedLatest.get(noteId)

            if (expected === undefined) {
              return false
            }

            return this.latestTrusted(space, noteId)?.id === expected
          })
        : candidates,
    )

    if (!ids.size) {
      return []
    }
    for (const id of ids) {
      this.purgedNotes.add(`${space}\u0000${id}`)
    }
    const scoped = (r: Revision): boolean => r.space === space && ids.has(r.noteId)
    const removed = this.revisions.filter(scoped)
    this.revisions = this.revisions.filter((r) => !scoped(r))
    // GC blobs no surviving revision references (the CAS is shared by hash).
    const surviving = new Set(
      this.revisions.map((r) => r.contentHash).filter((h): h is string => h != null),
    )

    for (const r of removed) {
      this.quarantined.delete(r.id)
      if (r.contentHash && !surviving.has(r.contentHash)) {
        this.blobs.delete(r.contentHash)
      }
    }
    this.activityGeneration.set(space, (this.activityGeneration.get(space) ?? 1) + 1)

    return [...ids]
  }

  async hasAnyFor(space: string, noteId: string): Promise<boolean> {
    return this.revisions.some((r) => r.space === space && r.noteId === noteId)
  }

  // The operational latest is the newest TRUSTED state: a gap has no payload to
  // resume from, so it is skipped rather than served as the head of the chain.
  async latestFor(space: string, noteId: string): Promise<Revision | null> {
    return this.latestForRestoreTerminal(space, noteId)
  }

  latestForRestoreTerminal(space: string, noteId: string): Revision | null {
    const revision = this.latestTrusted(space, noteId)
    return revision ? { ...revision, tags: [...revision.tags] } : null
  }

  snapshotForRestoreTerminal() {
    return {
      revisions: this.revisions.map((revision) => ({ ...revision, tags: [...revision.tags] })),
      blobs: new Map(
        [...this.blobs].map(([hash, blob]) => [
          hash,
          blob instanceof Uint8Array ? Uint8Array.from(blob) : blob,
        ]),
      ),
      purgedNotes: new Set(this.purgedNotes),
      purgePins: new Map(this.purgePins),
      quarantined: new Set(this.quarantined),
      activityGeneration: new Map(this.activityGeneration),
      nextId: this.nextId,
    }
  }

  restoreForRestoreTerminal(snapshot: ReturnType<this['snapshotForRestoreTerminal']>): void {
    this.revisions = snapshot.revisions.map((revision) => ({
      ...revision,
      tags: [...revision.tags],
    }))
    this.blobs = new Map(
      [...snapshot.blobs].map(([hash, blob]) => [
        hash,
        blob instanceof Uint8Array ? Uint8Array.from(blob) : blob,
      ]),
    )
    this.purgedNotes = new Set(snapshot.purgedNotes)
    this.purgePins = new Map(snapshot.purgePins)
    this.quarantined = new Set(snapshot.quarantined)
    this.activityGeneration = new Map(snapshot.activityGeneration)
    this.nextId = snapshot.nextId
  }

  private latestTrusted(space: string, noteId: string): Revision | null {
    for (let i = this.revisions.length - 1; i >= 0; i--) {
      const revision = this.revisions[i]

      if (revision.space === space && revision.noteId === noteId && !this.isGap(revision)) {
        return revision
      }
    }

    return null
  }

  async latestForMany(space: string, noteIds: readonly string[]): Promise<Map<string, Revision>> {
    const wanted = new Set(noteIds)
    const out = new Map<string, Revision>()

    for (let i = this.revisions.length - 1; i >= 0; i--) {
      const revision = this.revisions[i]

      if (
        revision.space === space &&
        wanted.has(revision.noteId) &&
        !out.has(revision.noteId) &&
        !this.isGap(revision)
      ) {
        out.set(revision.noteId, { ...revision, tags: [...revision.tags] })
      }
    }

    return out
  }

  async activityByDay(
    space: string,
    {
      from,
      to,
      tzOffsetMinutes,
      excludeClasses = [],
      author,
    }: {
      from: string
      to: string
      tzOffsetMinutes: number
      excludeClasses?: readonly string[]
      author?: AuthorFilter
    },
  ): Promise<ActivityDayCount[]> {
    const fromT = Date.parse(from)
    const toT = Date.parse(to)
    const byDay = new Map<string, ActivityDayCount>()

    for (const r of this.revisions) {
      if (r.space !== space) {
        continue
      }
      if (!this.countsAsActivity(r)) {
        continue
      }
      if (!this.classAllows(r, excludeClasses)) {
        continue
      }
      if (!this.authorAllows(r, author)) {
        continue
      }
      const t = Date.parse(r.createdAt)

      if (t < fromT || t >= toT) {
        continue
      }
      const date = localDayOf(r.createdAt, tzOffsetMinutes)
      let bucket = byDay.get(date)

      if (!bucket) {
        bucket = { date, created: 0, edited: 0, deleted: 0, unavailable: 0 }
        byDay.set(date, bucket)
      }
      // A gap is real activity whose KIND cannot be classified without reading a
      // payload the row withholds — its own bucket, never guessed from raw columns.
      if (this.isGap(r)) {
        bucket.unavailable++
      } else if (r.kind === REVISION_KIND.delete) {
        bucket.deleted++
      } else if (r.entryRole === REVISION_ENTRY_ROLE.origin) {
        bucket.created++
      } else {
        bucket.edited++
      }
    }

    return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  }

  async activityEvents(
    space: string,
    {
      from,
      to,
      offset,
      limit,
      excludeClasses = [],
      author,
      viewerAuthor,
      noteId,
      through,
      activityLease,
      afterId,
    }: {
      from?: string
      to?: string
      offset: number
      limit: number
      excludeClasses?: readonly string[]
      author?: AuthorFilter
      viewerAuthor?: AuthorFilter
      noteId?: string
      through?: string
      activityLease?: ActivityProjectionLease
      afterId?: string
    },
  ): Promise<{
    items: Revision[]
    total: number
    through: string | null
    nextAfterId: string | null
    activityLease?: ActivityProjectionLease
    hasOtherAuthors?: boolean
  }> {
    const fromT = from == null ? -Infinity : Date.parse(from)
    const toT = to == null ? Infinity : Date.parse(to)
    const base = this.revisions.filter((r) => {
      if (r.space !== space) {
        return false
      }
      if (!this.countsAsActivity(r)) {
        return false
      }
      if (!this.classAllows(r, excludeClasses)) {
        return false
      }
      const t = Date.parse(r.createdAt)
      return t >= fromT && t < toT && (noteId == null || r.noteId === noteId)
    })
    const authored = base.filter((r) => this.authorAllows(r, author))
    const needsProjection = noteId != null || (from == null && to == null)
    const preparation = needsProjection ? await this.prepareActivityProjection(space) : undefined
    const currentLease = preparation?.state === 'ready' ? preparation.lease : undefined

    if (
      activityLease &&
      (activityLease.activeGeneration !== currentLease?.activeGeneration ||
        activityLease.sourceGeneration !== currentLease.sourceGeneration ||
        (activityLease.through != null &&
          (currentLease.through == null ||
            revisionIdCompare(activityLease.through, currentLease.through) > 0)))
    ) {
      throw activityProjectionStale()
    }
    const resolvedThrough =
      activityLease?.through ??
      currentLease?.through ??
      through ??
      authored.reduce<string | null>(
        (max, row) => (max == null || revisionIdCompare(row.id, max) > 0 ? row.id : max),
        null,
      )
    const cut =
      resolvedThrough == null
        ? []
        : authored.filter((row) => revisionIdCompare(row.id, resolvedThrough) <= 0)
    const sorted = cut.sort((a, b) => revisionIdCompare(b.id, a.id))
    const after =
      afterId == null ? sorted : sorted.filter((row) => revisionIdCompare(row.id, afterId) < 0)
    const start = afterId == null ? offset : 0
    const page = after.slice(start, start + limit + 1)
    const items = page.slice(0, limit)
    const hasMore = page.length > limit
    const result: {
      items: Revision[]
      total: number
      through: string | null
      nextAfterId: string | null
      activityLease?: ActivityProjectionLease
      hasOtherAuthors?: boolean
    } = {
      items: items.map(this.serve),
      total: sorted.length,
      through: resolvedThrough,
      nextAfterId: hasMore ? (items.at(-1)?.id ?? null) : null,
      ...(currentLease ? { activityLease: { ...currentLease, through: resolvedThrough } } : {}),
    }

    if (viewerAuthor) {
      result.hasOtherAuthors = base.some(
        (row) =>
          !this.isGap(row) &&
          (resolvedThrough == null || revisionIdCompare(row.id, resolvedThrough) <= 0) &&
          !matchesAuthor(row.principal, viewerAuthor),
      )
    }

    return result
  }

  async activityGroupsByNote(
    space: string,
    {
      from,
      to,
      excludeClasses = [],
      author,
      viewerAuthor,
      through,
      activityLease,
    }: {
      from?: string
      to?: string
      excludeClasses?: readonly string[]
      author?: AuthorFilter
      viewerAuthor?: AuthorFilter
      through?: string
      activityLease?: ActivityProjectionLease
    },
  ): Promise<{
    items: ActivityNoteGroupCount[]
    through: string | null
    activityLease: ActivityProjectionLease
    hasOtherAuthors?: boolean
  }> {
    const fromT = from == null ? -Infinity : Date.parse(from)
    const toT = to == null ? Infinity : Date.parse(to)
    const base = this.revisions.filter((row) => {
      if (
        row.space !== space ||
        !this.countsAsActivity(row) ||
        !this.classAllows(row, excludeClasses)
      ) {
        return false
      }
      const at = Date.parse(row.createdAt)
      return at >= fromT && at < toT
    })
    const authored = base.filter((row) => this.authorAllows(row, author))
    const preparation = await this.prepareActivityProjection(space)

    if (preparation.state !== 'ready') {
      throw new Error('in-memory Activity projection must be ready')
    }
    const currentLease = preparation.lease

    if (
      activityLease &&
      (activityLease.activeGeneration !== currentLease.activeGeneration ||
        activityLease.sourceGeneration !== currentLease.sourceGeneration ||
        (activityLease.through != null &&
          (currentLease.through == null ||
            revisionIdCompare(activityLease.through, currentLease.through) > 0)))
    ) {
      throw activityProjectionStale()
    }
    const resolvedThrough =
      activityLease?.through ??
      currentLease.through ??
      through ??
      authored.reduce<string | null>(
        (max, row) => (max == null || revisionIdCompare(row.id, max) > 0 ? row.id : max),
        null,
      )
    const byNote = new Map<
      string,
      {
        count: number
        charsAdded: number
        charsRemoved: number
        knownAdded: boolean
        knownRemoved: boolean
        last: Revision
      }
    >()

    if (resolvedThrough != null) {
      for (const row of authored) {
        if (revisionIdCompare(row.id, resolvedThrough) > 0) {
          continue
        }
        const current = byNote.get(row.noteId)
        const trusted = !this.isGap(row)

        if (!current) {
          byNote.set(row.noteId, {
            count: 1,
            charsAdded: trusted ? (row.charsAdded ?? 0) : 0,
            charsRemoved: trusted ? (row.charsRemoved ?? 0) : 0,
            knownAdded: trusted && row.charsAdded != null,
            knownRemoved: trusted && row.charsRemoved != null,
            last: row,
          })
          continue
        }
        current.count++
        if (trusted && row.charsAdded != null) {
          current.charsAdded += row.charsAdded
          current.knownAdded = true
        }
        if (trusted && row.charsRemoved != null) {
          current.charsRemoved += row.charsRemoved
          current.knownRemoved = true
        }
        if (revisionIdCompare(row.id, current.last.id) > 0) {
          current.last = row
        }
      }
    }
    const result: {
      items: ActivityNoteGroupCount[]
      through: string | null
      activityLease: ActivityProjectionLease
      hasOtherAuthors?: boolean
    } = {
      items: [...byNote].map(([noteId, value]) => ({
        noteId,
        count: String(value.count),
        charsAdded: value.knownAdded ? String(value.charsAdded) : null,
        charsRemoved: value.knownRemoved ? String(value.charsRemoved) : null,
        lastSourceOrdinal: value.last.id,
        lastEvent: this.serve(value.last),
      })),
      through: resolvedThrough,
      activityLease: { ...currentLease, through: resolvedThrough },
    }

    if (viewerAuthor) {
      result.hasOtherAuthors = base.some(
        (row) =>
          !this.isGap(row) &&
          (resolvedThrough == null || revisionIdCompare(row.id, resolvedThrough) <= 0) &&
          !matchesAuthor(row.principal, viewerAuthor),
      )
    }

    return result
  }

  async activityByNote(
    space: string,
    {
      from,
      to,
      excludeClasses = [],
    }: { from: string; to: string; excludeClasses?: readonly string[] },
  ): Promise<ActivityNoteCount[]> {
    const fromT = Date.parse(from)
    const toT = Date.parse(to)
    const byNote = new Map<string, ActivityNoteCount>()

    for (const r of this.revisions) {
      if (r.space !== space) {
        continue
      }
      if (!this.countsAsActivity(r)) {
        continue
      }
      if (!this.classAllows(r, excludeClasses)) {
        continue
      }
      const t = Date.parse(r.createdAt)

      if (t < fromT || t >= toT) {
        continue
      }
      const cur = byNote.get(r.noteId)

      if (!cur) {
        byNote.set(r.noteId, { noteId: r.noteId, count: 1, lastAt: r.createdAt })
      } else {
        cur.count++
        if (r.createdAt > cur.lastAt) {
          cur.lastAt = r.createdAt
        }
      }
    }

    return [...byNote.values()]
  }

  async latestTimestamps(space: string): Promise<Map<string, string>> {
    const map = new Map<string, string>()

    // Append order IS the timeline — later rows overwrite earlier ones.
    for (const r of this.revisions) {
      if (r.space === space && !this.isGap(r)) {
        map.set(r.noteId, r.createdAt)
      }
    }

    return map
  }

  async historicalNames(space: string): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>()

    for (const r of this.revisions) {
      // A gap's title is withheld, so it contributes no historical name.
      if (r.space !== space || !r.title || this.isGap(r)) {
        continue
      }
      const list = map.get(r.noteId)

      if (!list) {
        map.set(r.noteId, [r.title])
      } else if (!list.includes(r.title)) {
        list.push(r.title)
      }
    }

    return map
  }

  async content(contentHash: string): Promise<RevisionBlob | null> {
    const blob = this.blobs.get(contentHash)
    return blob instanceof Uint8Array ? Uint8Array.from(blob) : (blob ?? null)
  }

  async close(): Promise<void> {}

  /** Test-only: serve these rows as gaps from now on. The twin does NOT arbitrate
   *  — which rows a collision contaminates is decided by the meta-DB's settlement
   *  closure, and nothing here can compute it. The caller names the rows; this
   *  class only owes them the same effective-field semantics the drivers give. */
  quarantineForTest(revisionIds: readonly string[]): void {
    const changedSpaces = new Set<string>()

    for (const id of revisionIds) {
      if (!this.quarantined.has(id)) {
        const revision = this.revisions.find((row) => row.id === id)

        if (revision) {
          changedSpaces.add(revision.space)
        }
        this.quarantined.add(id)
      }
    }
    for (const space of changedSpaces) {
      this.activityGeneration.set(space, (this.activityGeneration.get(space) ?? 1) + 1)
    }
  }

  /** Test-only: back to an empty journal (the e2e fake's reset). */
  clear(): void {
    this.revisions = []
    this.blobs.clear()
    this.purgedNotes.clear()
    this.quarantined.clear()
    this.activityGeneration.clear()
    this.purgePins.clear()
    this.nextId = 1
  }
}
