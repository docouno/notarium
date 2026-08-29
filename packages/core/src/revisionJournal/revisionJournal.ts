// The revision journal: an append-only history of note states from the read-model layer.
// Appends are queued per note (chaining + dedup read the latest revision, so racing saves must not
// interleave). Recording is fire-and-forget and NEVER fails a write — a lost append degrades the
// history, not the note. canon: docs/note-history.md#model · docs/architecture.md#p2

import {
  type ActivityDayCount,
  type ActivityNoteCount,
  type AuthorFilter,
  type Revision,
  REVISION_ENTRY_ROLE,
  REVISION_KIND,
  type RevisionBlob,
  revisionContentUnreadable,
  type RevisionDetail,
  type RevisionEntryRole,
  RevisionHeadConflictError,
  type RevisionInput,
  type RevisionPersistence,
  type TrashAvailabilityFilter,
} from '../knowledgeStore'
import { diffStats, isDiffStatsWithinBudget } from '../libs/diffStats'
import { sha256Hex } from '../libs/hash'
import {
  decodeDocumentState,
  DOCUMENT_STATE_FORMAT,
  documentSourceText,
  type DocumentState,
  encodeDocumentState,
  LOGICAL_NOTE_STATE_FORMAT,
  logicalNoteState,
  type LogicalNoteState,
  parseLogicalNoteState,
} from '../libs/markdown'
import { documentStateSourceByteLength } from '../libs/markdown/documentState/codec'
import type { JournalOptions, JournalRecordInput } from './types'

const sameTags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i])

const stateBlob = (input: JournalRecordInput): RevisionBlob | null =>
  input.documentState != null
    ? encodeDocumentState(input.documentState)
    : (input.logicalState?.markdown ?? input.content)

const textBlob = (blob: RevisionBlob): string =>
  typeof blob === 'string' ? blob : new TextDecoder().decode(blob)

const comparableText = (
  blob: RevisionBlob | null,
  format: Revision['stateFormat'],
): string | null => {
  if (blob == null) {
    return null
  }
  if (format === DOCUMENT_STATE_FORMAT.opaque) {
    return null
  }
  if (format === DOCUMENT_STATE_FORMAT.markdown || format === DOCUMENT_STATE_FORMAT.skill) {
    const bytes = typeof blob === 'string' ? new TextEncoder().encode(blob) : blob
    return documentSourceText(decodeDocumentState(bytes))
  }

  return textBlob(blob)
}

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

  /** Queue a state whose durability is part of the caller's operation. Trash
   * restore uses this path: publishing a live file without the matching row
   * would make a concurrent permanent purge appear to succeed. */
  recordRequired(input: JournalRecordInput): Promise<Revision | null> {
    return this.enqueue(input.noteId, () => this.append(input, true))
  }

  async list(
    noteId: string,
    opts: { offset: number; limit: number },
  ): Promise<{ items: Revision[]; total: number }> {
    await this.ensureInit()
    return this.persistence.listByNote(this.space, noteId, opts)
  }

  /** The cursor-based delta (start_session) for THIS journal's space: notes
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
    opts: {
      offset: number
      limit: number
      q?: string
      availability?: TrashAvailabilityFilter
    },
    excludeClasses?: readonly string[],
  ): Promise<{ items: Revision[]; total: number; restorableTotal: number; partialTotal: number }> {
    await this.ensureInit()
    return this.persistence.listTrashed(this.space, opts, excludeClasses)
  }

  /** Permanently erase notes from the journal (purge) + GC their blobs.
   *  Drains the append queue first so an in-flight delete-tombstone for one of
   *  these notes can't land after the rows are gone (resurrecting it in trash). */
  async purge(
    noteIds: readonly string[],
    expectedLatest?: ReadonlyMap<string, string>,
  ): Promise<readonly string[]> {
    await this.ensureInit()
    await this.drain()
    return this.persistence.purgeNotes(this.space, noteIds, expectedLatest)
  }

  /** Whether the note has any journaled state — what gates the pre-edit
   *  baseline capture in the store's write path. A quarantined chain COUNTS: the
   *  note has a history, it just cannot be read, and capturing a fresh
   *  "baseline" over it would invent one (#327). */
  async hasHistory(noteId: string): Promise<boolean> {
    await this.ensureInit()
    return this.persistence.hasAnyFor(this.space, noteId)
  }

  /** The note's newest revision — what tells the trash whether the note is
   *  currently deleted (newest is a delete-tombstone) or live again. */
  async latestFor(noteId: string): Promise<Revision | null> {
    await this.ensureInit()
    return this.persistence.latestFor(this.space, noteId)
  }

  /** Newest rows for a set of notes after settling only those notes' queued appends. */
  async latestForMany(noteIds: readonly string[]): Promise<Map<string, Revision>> {
    await this.ensureInit()
    const ids = [...new Set(noteIds)]
    await Promise.all(ids.map((noteId) => this.drain(noteId)))
    return this.persistence.latestForMany(this.space, ids)
  }

  /** One revision with its blob, scope-checked against the note id — a
   *  revision is addressable only through its own note. */
  async detail(noteId: string, revisionId: string): Promise<RevisionDetail | null> {
    await this.ensureInit()
    const rev = await this.persistence.get(this.space, revisionId)

    if (!rev || rev.noteId !== noteId) {
      return null
    }
    const stored = rev.contentHash != null ? await this.persistence.content(rev.contentHash) : null

    if (
      stored != null &&
      (rev.stateFormat === DOCUMENT_STATE_FORMAT.markdown ||
        rev.stateFormat === DOCUMENT_STATE_FORMAT.skill ||
        rev.stateFormat === DOCUMENT_STATE_FORMAT.opaque)
    ) {
      const bytes = typeof stored === 'string' ? new TextEncoder().encode(stored) : stored
      let documentState: DocumentState

      try {
        documentState = decodeDocumentState(bytes)
      } catch (error) {
        // The codec proves a stored row against a FRESH reading of its own source,
        // so a refusal here is a statement about THIS reader: an analyzer that has
        // since learned to read those bytes differently no longer reproduces the
        // metadata the writer of the day recorded, and no retry ever will. What the
        // caller can act on is that the body is not obtainable — but NOT that it was
        // never captured: this row's copy exists, and saying otherwise tells a person
        // their content is gone when it is merely unreadable here. Letting the raw
        // codec error escape instead reached the one reader that maps errors to a
        // status — the revision-detail door — as an unclassified fault, so an
        // ordinary request for an old revision answered 500. The cause stays in the
        // log (the server's handler prints it), never on the wire.
        const refusal = revisionContentUnreadable(revisionId)

        refusal.cause = error
        throw refusal
      }
      const sourceText = documentSourceText(documentState)
      const projection = documentState.projection
      return {
        ...rev,
        content: projection?.body ?? null,
        logicalState:
          sourceText == null || projection == null
            ? null
            : logicalNoteState({
                title: projection.title,
                body: projection.body,
                frontmatter: projection.frontmatterEntries,
              }),
        documentState,
      }
    }

    if (stored != null && rev.stateFormat === LOGICAL_NOTE_STATE_FORMAT) {
      const logicalState: LogicalNoteState = {
        format: LOGICAL_NOTE_STATE_FORMAT,
        markdown: textBlob(stored),
      }
      return {
        ...rev,
        content: parseLogicalNoteState(logicalState).body,
        logicalState,
        documentState: null,
      }
    }

    return {
      ...rev,
      content: stored == null ? null : textBlob(stored),
      logicalState: null,
      documentState: null,
    }
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

  private async append(input: JournalRecordInput, required = false): Promise<Revision | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.appendAgainstHead(input, required)
      } catch (error) {
        if (!(error instanceof RevisionHeadConflictError) || attempt >= 3) {
          throw error
        }
      }
    }
  }

  private async appendAgainstHead(
    input: JournalRecordInput,
    required: boolean,
  ): Promise<Revision | null> {
    await this.ensureInit()
    let latest = await this.persistence.latestFor(this.space, input.noteId)

    // The pre-edit baseline: the very first journaled write of a note captures
    // the state it found (the CAS verify-read had the body in hand anyway).
    if (!latest && input.baseline && input.kind !== REVISION_KIND.external) {
      const baselineInput: JournalRecordInput = {
        noteId: input.noteId,
        kind: REVISION_KIND.external,
        principal: null,
        content: input.baseline.content,
        logicalState: input.baseline.logicalState,
        documentState: input.baseline.documentState,
        title: input.baseline.title,
        // The baseline is the SAME note's pre-edit state — class is immutable.
        class: input.class,
        tags: input.baseline.tags,
        // The slug the note already carried before its first journaled edit
        // — so restoring the baseline brings its custom slug back too.
        slug: input.baseline.slug,
      }
      const baselineRev = await this.revisionOf(baselineInput, null, REVISION_ENTRY_ROLE.baseline)
      await this.stampStats(baselineRev, baselineInput, null)
      latest = await this.persistence.append(baselineRev, stateBlob(baselineInput))
    }

    const rev = await this.revisionOf(input, latest, await this.roleOf(input, latest))
    rev.allowSemanticNoop = !required

    if (input.kind === REVISION_KIND.delete) {
      // A delete journals once; the tombstone keeps the last known hash so an
      // undelete can resurrect from the journal.
      if (latest?.kind === REVISION_KIND.delete) {
        return null
      }
    } else if (
      !required &&
      latest &&
      latest.kind !== REVISION_KIND.delete &&
      (await this.isDuplicate(latest, rev, input))
    ) {
      // Same state again — a no-op save, or the delta poll echoing our own
      // write back (a reindex re-surfaces everything we write). Document rows use
      // their semantic fingerprint; only the legacy key includes slug and tags.
      return null
    }

    await this.stampStats(rev, input, latest)
    const stored = await this.persistence.append(rev, stateBlob(input))
    return rev.allowSemanticNoop === true && stored.id === rev.expectedHeadRevisionId
      ? null
      : stored
  }

  private async isDuplicate(
    latest: Revision,
    candidate: RevisionInput,
    input: JournalRecordInput,
  ): Promise<boolean> {
    if (
      input.documentState != null &&
      latest.stateFormat === input.documentState.format &&
      latest.contentHash != null
    ) {
      if (latest.semanticFingerprint != null) {
        return latest.semanticFingerprint === input.documentState.semanticFingerprint
      }
      const blob = await this.persistence.content(latest.contentHash)

      if (blob == null) {
        return false
      }
      try {
        const bytes = typeof blob === 'string' ? new TextEncoder().encode(blob) : blob
        return (
          decodeDocumentState(bytes).semanticFingerprint === input.documentState.semanticFingerprint
        )
      } catch {
        return false
      }
    }
    if (
      latest.stateFormat === LOGICAL_NOTE_STATE_FORMAT &&
      candidate.stateFormat === LOGICAL_NOTE_STATE_FORMAT
    ) {
      return latest.contentHash === candidate.contentHash
    }

    return (
      latest.stateFormat == null &&
      candidate.stateFormat == null &&
      latest.contentHash === candidate.contentHash &&
      latest.title === candidate.title &&
      latest.slug === candidate.slug &&
      sameTags(latest.tags, candidate.tags)
    )
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

      // A legacy body cannot be compared honestly with a complete Markdown
      // snapshot: the missing metadata may or may not have existed. The first
      // full row remains visible, but its counters are explicitly unknown.
      if (latest && latest.stateFormat !== (rev.stateFormat ?? null)) {
        return
      }

      if (input.kind === REVISION_KIND.delete) {
        const baseText = comparableText(base, latest?.stateFormat ?? null)

        if (baseText != null) {
          rev.charsAdded = 0
          rev.charsRemoved = baseText.length
        }

        return
      }
      const format = rev.stateFormat ?? null
      let currentText: string | null

      if (
        input.documentState != null &&
        (format === DOCUMENT_STATE_FORMAT.markdown || format === DOCUMENT_STATE_FORMAT.skill)
      ) {
        currentText = documentSourceText(input.documentState)
      } else {
        const current = stateBlob(input)

        if (current == null) {
          return
        }
        currentText = comparableText(current, format)
      }
      if (currentText == null) {
        return
      }
      if (
        latest &&
        base != null &&
        (latest.stateFormat === DOCUMENT_STATE_FORMAT.markdown ||
          latest.stateFormat === DOCUMENT_STATE_FORMAT.skill)
      ) {
        const baseTextLowerBound =
          typeof base === 'string' ? base.length : documentStateSourceByteLength(base) / 3

        if (!isDiffStatsWithinBudget(baseTextLowerBound, currentText.length)) {
          return
        }
      }
      const baseText = comparableText(base, latest?.stateFormat ?? null)

      if (latest && baseText == null) {
        return
      }
      const stats = diffStats(baseText ?? '', currentText)

      if (stats) {
        rev.charsAdded = stats.charsAdded
        rev.charsRemoved = stats.charsRemoved
      }
    } catch (err) {
      console.error('[journal] diff stats failed:', (err as Error).message)
    }
  }

  /** What this entry IS in the note's life. The WRITER decides it here, once, and
   *  stores it on the row; no reader ever infers it again.
   *
   *  The question is "does the journal hold ANY row for this note", and it is
   *  `hasAnyFor` — trusted AND quarantined — not `latestFor`, which is trusted-only.
   *  The two diverged the moment this task's quarantine landed: after it, a note with
   *  a contaminated past has no trusted latest, and calling its next edit an `origin`
   *  would announce a birth that never happened. The query costs one round trip once
   *  in a note's life: it is asked only when there is no trusted latest at all. */
  private async roleOf(
    input: JournalRecordInput,
    latest: Revision | null,
  ): Promise<RevisionEntryRole> {
    if (latest || (await this.persistence.hasAnyFor(this.space, input.noteId))) {
      return REVISION_ENTRY_ROLE.change
    }

    // First entry ever. Arriving from outside makes it a first sighting of a note
    // that already existed; arriving through us makes it the note's origin.
    return input.kind === REVISION_KIND.external
      ? REVISION_ENTRY_ROLE.baseline
      : REVISION_ENTRY_ROLE.origin
  }

  private async revisionOf(
    input: JournalRecordInput,
    latest: Revision | null,
    entryRole: RevisionEntryRole,
  ): Promise<RevisionInput> {
    const carriedTags = input.tags ?? latest?.tags ?? []
    const blob = stateBlob(input)
    return {
      noteId: input.noteId,
      space: this.space,
      baseRevisionId: latest?.id ?? null,
      theirRevisionId: null,
      sourceRevisionId: input.sourceRevisionId ?? null,
      kind: input.kind,
      entryRole,
      principal: input.principal,
      agent: input.agent ?? null,
      contentHash:
        blob != null
          ? await sha256Hex(blob)
          : input.kind === REVISION_KIND.delete
            ? (latest?.contentHash ?? null)
            : null,
      semanticFingerprint:
        input.documentState?.semanticFingerprint ??
        (input.kind === REVISION_KIND.delete ? (latest?.semanticFingerprint ?? null) : null),
      restoreSafety:
        input.documentState?.restoreSafety.status ??
        (input.kind === REVISION_KIND.delete ? (latest?.restoreSafety ?? null) : null),
      expectedHeadRevisionId: latest?.id ?? null,
      allowSemanticNoop: true,
      stateFormat:
        blob != null && input.documentState != null
          ? input.documentState.format
          : blob != null && input.logicalState?.format === LOGICAL_NOTE_STATE_FORMAT
            ? LOGICAL_NOTE_STATE_FORMAT
            : input.kind === REVISION_KIND.delete && blob == null
              ? (latest?.stateFormat ?? null)
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
