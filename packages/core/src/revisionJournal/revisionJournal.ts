// The revision journal: an append-only history of note states from the read-model layer.
// Appends are queued per note (chaining + dedup read the latest revision, so racing saves must not
// interleave). Recording is fire-and-forget and NEVER fails a write — a lost append degrades the
// history, not the note. canon: docs/note-history.md#model · docs/architecture.md#p2

import {
  type ActivityDayCount,
  type ActivityNoteCount,
  type AuthorFilter,
  type Revision,
  REVISION_KIND,
  type RevisionDetail,
  type RevisionInput,
  type RevisionPersistence,
} from '../knowledgeStore'
import { diffStats } from '../libs/diffStats'
import { sha256Hex } from '../libs/hash'
import type { JournalOptions, JournalRecordInput } from './types'

const sameTags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i])

export class RevisionJournal {
  private readonly persistence: RevisionPersistence
  private readonly space: string
  private readonly now: () => Date
  private initPromise: Promise<void> | null = null
  /** Per-note append chains (same shape as the store's write serialization):
   *  latestFor → dedup → append must never interleave for one note. */
  private chains = new Map<string, Promise<void>>()

  constructor({ persistence, space, now = () => new Date() }: JournalOptions) {
    this.persistence = persistence
    this.space = space
    this.now = now
  }

  /** Queue one state for the journal. Resolves when the append settled (tests
   *  and shutdown await it) with the stored revision — or null when the state
   *  deduped to a no-op (so callers can tell "the note actually changed", the
   *  modifiedAt channel). Callers on the request path fire-and-forget. */
  record(input: JournalRecordInput): Promise<Revision | null> {
    return this.enqueue(input.noteId, async () => {
      try {
        return await this.append(input)
      } catch (err) {
        console.error(
          `[journal] recording ${input.kind} for ${input.noteId} failed:`,
          (err as Error).message,
        )
        return null
      }
    })
  }

  async list(
    noteId: string,
    opts: { offset: number; limit: number },
  ): Promise<{ items: Revision[]; total: number }> {
    await this.ensureInit()
    return this.persistence.listByNote(noteId, opts)
  }

  /** The per-token delta (start_session) for THIS journal's space: notes
   *  changed after revision `sinceRevId` (null = from the start), collapsed to
   *  one entry per note, newest-first, capped at `limit`. See
   *  RevisionPersistence.listBySpaceSince. */
  async listSpaceSince(
    sinceRevId: string | null,
    limit: number,
    excludeClasses?: readonly string[],
  ): Promise<{ items: Revision[]; total: number; maxRevId: string | null }> {
    await this.ensureInit()
    return this.persistence.listBySpaceSince(this.space, sinceRevId, limit, excludeClasses)
  }

  /** Day-bucketed activity for THIS journal's space — the heatmap aggregate.
   *  See RevisionPersistence.activityByDay. */
  async activityByDay(opts: {
    from: string
    to: string
    tzOffsetMinutes: number
    excludeClasses?: readonly string[]
    author?: AuthorFilter
  }): Promise<ActivityDayCount[]> {
    await this.ensureInit()
    return this.persistence.activityByDay(this.space, opts)
  }

  /** A window over THIS journal's space activity events — the "what changed"
   *  feed + the heatmap day-drill. See RevisionPersistence.activityEvents. */
  async activityEvents(opts: {
    from?: string
    to?: string
    offset: number
    limit: number
    excludeClasses?: readonly string[]
    author?: AuthorFilter
  }): Promise<{ items: Revision[]; total: number }> {
    await this.ensureInit()
    return this.persistence.activityEvents(this.space, opts)
  }

  /** Per-note activity counts for THIS journal's space — what the dashboard's
   *  "active projects" block joins to projects. See
   *  RevisionPersistence.activityByNote. */
  async activityByNote(opts: {
    from: string
    to: string
    excludeClasses?: readonly string[]
  }): Promise<ActivityNoteCount[]> {
    await this.ensureInit()
    return this.persistence.activityByNote(this.space, opts)
  }

  /** The trash view for this journal's space: notes whose newest revision
   *  is a delete-tombstone, newest-deleted first, windowed. Class-scoped via
   *  `excludeClasses` (the read-model passes the hidden set). */
  async listTrashed(
    opts: { offset: number; limit: number; q?: string },
    excludeClasses?: readonly string[],
  ): Promise<{ items: Revision[]; total: number; restorableTotal: number }> {
    await this.ensureInit()
    return this.persistence.listTrashed(this.space, opts, excludeClasses)
  }

  /** Permanently erase notes from the journal (purge) + GC their blobs.
   *  Drains the append queue first so an in-flight delete-tombstone for one of
   *  these notes can't land after the rows are gone (resurrecting it in trash). */
  async purge(noteIds: readonly string[]): Promise<void> {
    await this.ensureInit()
    await this.drain()
    return this.persistence.purgeNotes(noteIds)
  }

  /** Whether the note has any journaled state — what gates the pre-edit
   *  baseline capture in the store's write path. */
  async hasHistory(noteId: string): Promise<boolean> {
    await this.ensureInit()
    return (await this.persistence.latestFor(noteId)) != null
  }

  /** The note's newest revision — what tells the trash whether the note is
   *  currently deleted (newest is a delete-tombstone) or live again. */
  async latestFor(noteId: string): Promise<Revision | null> {
    await this.ensureInit()
    return this.persistence.latestFor(noteId)
  }

  /** One revision with its blob, scope-checked against the note id — a
   *  revision is addressable only through its own note. */
  async detail(noteId: string, revisionId: string): Promise<RevisionDetail | null> {
    await this.ensureInit()
    const rev = await this.persistence.get(revisionId)

    if (!rev || rev.noteId !== noteId) {
      return null
    }
    const content = rev.contentHash != null ? await this.persistence.content(rev.contentHash) : null
    return { ...rev, content }
  }

  /** noteId → newest revision timestamp for this journal's space — the boot
   *  bulk read behind the read-model's precise modifiedAt. */
  async latestTimestamps(): Promise<Map<string, string>> {
    await this.ensureInit()
    return this.persistence.latestTimestamps(this.space)
  }

  /** noteId → distinct past titles for this journal's space — the boot bulk read
   *  behind the read-model's alias-history backfill. */
  async historicalNames(): Promise<Map<string, string[]>> {
    await this.ensureInit()
    return this.persistence.historicalNames(this.space)
  }

  /** Settle queued appends. With no argument: EVERY note's chain (graceful
   *  shutdown / tests). With a `noteId`: only THAT note's chain — the
   *  read-after-write settle a per-note revision read needs, so it reflects
   *  writes already returned to a caller WITHOUT waiting on unrelated notes'
   *  pending appends. Grabbing the current tail is enough: the chain is transitive
   *  (each tail awaits its predecessor), so this awaits every append enqueued so
   *  far for the note; appends chained AFTER this call are genuinely later writes
   *  and correctly don't gate the read. */
  async drain(noteId?: string): Promise<void> {
    if (noteId !== undefined) {
      await this.chains.get(noteId)
      return
    }
    await Promise.all([...this.chains.values()])
  }

  private async append(input: JournalRecordInput): Promise<Revision | null> {
    await this.ensureInit()
    let latest = await this.persistence.latestFor(input.noteId)

    // The pre-edit baseline: the very first journaled write of a note captures
    // the state it found (the CAS verify-read had the body in hand anyway).
    if (!latest && input.baseline && input.kind !== REVISION_KIND.external) {
      const baselineInput: JournalRecordInput = {
        noteId: input.noteId,
        kind: REVISION_KIND.external,
        principal: null,
        content: input.baseline.content,
        title: input.baseline.title,
        // The baseline is the SAME note's pre-edit state — class is immutable.
        class: input.class,
        tags: input.baseline.tags,
        // The slug the note already carried before its first journaled edit
        // — so restoring the baseline brings its custom slug back too.
        slug: input.baseline.slug,
      }
      const baselineRev = await this.revisionOf(baselineInput, null)
      await this.stampStats(baselineRev, baselineInput, null)
      latest = await this.persistence.append(baselineRev, input.baseline.content)
    }

    const rev = await this.revisionOf(input, latest)

    if (input.kind === REVISION_KIND.delete) {
      // A delete journals once; the tombstone keeps the last known hash so an
      // undelete can resurrect from the journal.
      if (latest?.kind === REVISION_KIND.delete) {
        return null
      }
    } else if (
      latest &&
      latest.kind !== REVISION_KIND.delete &&
      latest.contentHash === rev.contentHash &&
      latest.title === rev.title &&
      latest.slug === rev.slug &&
      sameTags(latest.tags, rev.tags)
    ) {
      // Same state again — a no-op save, or the delta poll echoing our own
      // write back (a reindex re-surfaces everything we write). Not a revision. Slug is in
      // the key so a slug-only change (e.g. an external clear) still records.
      return null
    }

    await this.stampStats(rev, input, latest)
    return this.persistence.append(rev, input.content)
  }

  /** The "+N −M" counters (timeline): the revision against its chain
   *  parent's blob — one diff at append time, never per list request. A delete
   *  counts the whole parent as removed; no parent blob / no body = honest
   *  null. Failures only cost the stats, never the append. */
  private async stampStats(
    rev: RevisionInput,
    input: JournalRecordInput,
    latest: Revision | null,
  ): Promise<void> {
    try {
      const base =
        latest?.contentHash != null ? await this.persistence.content(latest.contentHash) : null

      if (input.kind === REVISION_KIND.delete) {
        if (base != null) {
          rev.charsAdded = 0
          rev.charsRemoved = base.length
        }

        return
      }
      if (input.content == null) {
        return
      }
      const stats = diffStats(base ?? '', input.content)

      if (stats) {
        rev.charsAdded = stats.charsAdded
        rev.charsRemoved = stats.charsRemoved
      }
    } catch (err) {
      console.error('[journal] diff stats failed:', (err as Error).message)
    }
  }

  private async revisionOf(
    input: JournalRecordInput,
    latest: Revision | null,
  ): Promise<RevisionInput> {
    const carriedTags = input.tags ?? latest?.tags ?? []
    return {
      noteId: input.noteId,
      space: this.space,
      baseRevisionId: latest?.id ?? null,
      theirRevisionId: null,
      sourceRevisionId: input.sourceRevisionId ?? null,
      kind: input.kind,
      principal: input.principal,
      contentHash:
        input.content != null
          ? await sha256Hex(input.content)
          : input.kind === REVISION_KIND.delete
            ? (latest?.contentHash ?? null)
            : null,
      title: input.title,
      // Class is immutable per note — carry the prior revision's forward
      // when this record didn't supply one (a body-less external/delete).
      class: input.class ?? latest?.class ?? null,
      // Slug is MUTABLE, so it can't fold into the `?? `-chain like class:
      // `undefined` means "unknown, carry forward", but `null` is a DEFINITIVE clear
      // that must NOT resurrect the prior slug. Distinguish the two explicitly.
      slug: input.slug !== undefined ? input.slug : (latest?.slug ?? null),
      tags: carriedTags,
      createdAt: this.now().toISOString(),
      charsAdded: null,
      charsRemoved: null,
    }
  }

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.persistence.init().catch((err) => {
        this.initPromise = null
        throw err
      })
    }

    return this.initPromise
  }

  private enqueue<T>(noteId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(noteId) ?? Promise.resolve()
    const run = prev.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(noteId, tail)
    void tail.then(() => {
      if (this.chains.get(noteId) === tail) {
        this.chains.delete(noteId)
      }
    })
    return run
  }
}
