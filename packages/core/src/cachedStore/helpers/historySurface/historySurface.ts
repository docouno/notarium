import type {
  BatchFailure,
  NoteClass,
  NoteContent,
  ReadScope,
  RestoreInput,
  TrashEntry,
  WriteResult,
} from '../../../knowledgeStore'
import {
  noteNotInTrash,
  READ_SCOPE,
  revisionHasNoContent,
  revisionNotFound,
} from '../../../knowledgeStore'
import {
  type ActivityDayCount,
  type ActivityNoteCount,
  type AuthorFilter,
  type Revision,
  REVISION_KIND,
  type RevisionDetail,
} from '../../../knowledgeStore'
import { MutationCoordinator } from '../../../libs/mutationCoordinator'
import { directoryOf } from '../../../libs/path'
import { classesForScope, NOTE_CLASSES } from '../../../visibility'
import { TRASH_MUTATION_PREFIX, trashMutationPath } from '../../consts'
import type { HistoryHost } from './types'

/** Scan window for the "select all N" trash sweeps (restore/purge): the count is
 *  stable while paging — nothing is erased until the sweep completes. */
const PAGE = 500
/** The history + trash surface of the read-model: revision reads, the space activity
 *  feed, restore/purge, and the deleted-note banner — all class-scoped at the read-model
 *  chokepoint. Trash is a VIEW over the journal (a note is trashed when its newest revision is a
 *  delete-tombstone). canon: docs/note-history.md#model · docs/trash.md#model */
export class HistorySurface {
  constructor(
    private readonly host: HistoryHost,
    private readonly trashMutations = new MutationCoordinator(),
  ) {}

  async revisions(
    noteId: string,
    opts: { offset: number; limit: number },
  ): Promise<{ items: Revision[]; total: number }> {
    // Read-after-write for a per-note revision read. The write path journals
    // fire-and-forget (`void journal.record` — a save returns 200 before its append
    // settles), so a caller that wrote-then-read the SAME note could observe the
    // PRIOR settled revision: get_note provenance mis-attributing a human's UI save
    // to the agent's earlier create, the memory-category author, the timeline.
    // Drain just THIS note's queue — the hot write path stays fire-and-forget, and
    // other notes' pending appends never gate this read (O(1) when the queue is idle).
    await this.host.journal.drain(noteId)
    return this.host.journal.list(noteId, opts)
  }

  latestRevisions(noteIds: readonly string[]): Promise<Map<string, Revision>> {
    return this.host.journal.latestForMany(noteIds)
  }

  async revision(noteId: string, revisionId: string): Promise<RevisionDetail | null> {
    return this.host.journal.detail(noteId, revisionId)
  }

  /** The cursor-based delta (start_session): what changed in this space after a
   *  revision-id cursor, collapsed to one entry per note. CLASS-SCOPED here at the
   *  read-model chokepoint exactly like the discovery surfaces: it excludes
   *  the classes NOT admitted by scope:'user' (agent-memory, …) — the same set the
   *  index (list({scope:'user'})) carries — so a hidden-class note's CONTENT can
   *  never surface in the delta regardless of which space it is computed over (a
   *  personal domain, a project agent-mount). A journal GAP is the one entry that
   *  survives the class filter: its class is withheld, so there is no raw column to
   *  filter on and nothing readable to leak (#327). The journal filters IN the query, so
   *  `total` and the acknowledge cursor (`maxRevId`) stay accurate. A bare engine
   *  lacks the journal (the wire surface degrades). */
  async revisionsSince(
    sinceRevId: string | null,
    limit: number,
  ): Promise<{ items: Revision[]; total: number; maxRevId: string | null }> {
    const admitted = classesForScope(READ_SCOPE.user)
    const excludeClasses = NOTE_CLASSES.filter((c) => !admitted.has(c))
    return this.host.journal.listSpaceSince(sinceRevId, limit, excludeClasses)
  }

  /** Day-bucketed activity for the dashboard heatmap. Class-scoped at the
   *  read-model like every discovery surface: the hidden set (default
   *  `user` ⇒ agent-memory excluded) is dropped IN the journal query, so the
   *  counts never include a note the viewer can't see. */
  async activity(opts: {
    from: string
    to: string
    tzOffsetMinutes: number
    scope?: ReadScope
    /** Author scope — an opaque principal predicate the server builds from
     *  the viewer identity; the store just forwards it (it owns class-scoping, not
     *  authorship). Absent = every author. */
    author?: AuthorFilter
  }): Promise<ActivityDayCount[]> {
    return this.host.journal.activityByDay({
      from: opts.from,
      to: opts.to,
      tzOffsetMinutes: opts.tzOffsetMinutes,
      excludeClasses: this.hiddenClassesFor(opts.scope ?? READ_SCOPE.user),
      author: opts.author,
    })
  }

  /** A window over the space's activity events — the "what changed" feed +
   *  the heatmap day-drill. Same class-scoping as activity(). */
  async activityEvents(opts: {
    from?: string
    to?: string
    offset: number
    limit: number
    scope?: ReadScope
    /** Author scope, same opaque predicate as activity. Absent = every author. */
    author?: AuthorFilter
  }): Promise<{ items: Revision[]; total: number }> {
    return this.host.journal.activityEvents({
      from: opts.from,
      to: opts.to,
      offset: opts.offset,
      limit: opts.limit,
      excludeClasses: this.hiddenClassesFor(opts.scope ?? READ_SCOPE.user),
      author: opts.author,
    })
  }

  /** Per-note activity counts — the dashboard's "active projects" block joins
   *  these to the note index + project registry at the server. Same class-scoping. */
  async activityByNote(opts: {
    from: string
    to: string
    scope?: ReadScope
  }): Promise<ActivityNoteCount[]> {
    return this.host.journal.activityByNote({
      from: opts.from,
      to: opts.to,
      excludeClasses: this.hiddenClassesFor(opts.scope ?? READ_SCOPE.user),
    })
  }

  /** Roll a journaled revision back over the live note: the revision's whole
   *  state (title + body + tags) through the very same CAS write path a save
   *  takes — a stale token 409s with the live side, nothing is lost
   *  silently. The note keeps its current folder: restore brings content
   *  back, it does not move files. */
  async restore(input: RestoreInput): Promise<WriteResult> {
    const rev = await this.host.journal.detail(input.id, input.revisionId)

    if (!rev) {
      throw revisionNotFound(input.revisionId)
    }
    if (rev.content == null) {
      throw revisionHasNoContent(input.revisionId)
    }
    // No directory: restore keeps the note where it lives — passing directoryOf(filePath) would be
    // space-relative and double-prefix a note in a prefixed mount (e.g. agent-memory). A title
    // change is still an in-folder rename. The revision's CUSTOM slug travels back too (a
    // journal column now): a rollback re-sets that revision's slug so inbound [[old-slug]] resolve
    // again. NON-destructive: a string SETS it, null (no custom slug / a legacy row) LEAVES the
    // live slug untouched — a rollback never silently clears one.
    const result = await this.host.write({
      title: rev.title,
      content: rev.content,
      tags: rev.tags,
      slug: rev.slug ?? undefined,
      originalId: input.id,
      versionToken: input.versionToken,
      principal: input.principal,
      journal: { kind: REVISION_KIND.restore, sourceRevisionId: rev.id },
    })
    // The hot save path journals fire-and-forget, but restore is a rare, explicit
    // action and the caller refetches the timeline the instant we answer — so here
    // we wait for the 'restore' revision to commit, otherwise that refetch races
    // the append and the new entry is missing.
    await this.host.journal.drain()
    return result
  }

  async listTrashed(opts: {
    offset: number
    limit: number
    q?: string
    scope?: ReadScope
  }): Promise<{ items: TrashEntry[]; total: number; restorableTotal: number }> {
    const excludeClasses = this.hiddenClassesFor(opts.scope ?? READ_SCOPE.user)
    const { items, total, restorableTotal } = await this.host.journal.listTrashed(
      { offset: opts.offset, limit: opts.limit, q: opts.q },
      excludeClasses,
    )
    const entries: TrashEntry[] = items.map((rev) => ({
      noteId: rev.noteId,
      title: rev.title,
      // The note's last folder lives in the identity tombstone (durable for a
      // bare engine; seeded on remove() for an identity-capable one).
      filePath: this.host.identity.recordFor(rev.noteId)?.filePath ?? null,
      class: (rev.class ?? undefined) as NoteClass | undefined,
      deletedAt: rev.createdAt,
      principal: rev.principal,
      revisionId: rev.id,
      contentHash: rev.contentHash,
    }))
    return { items: entries, total, restorableTotal }
  }

  async restoreFromTrash(id: string, opts?: { principal?: string }): Promise<WriteResult> {
    return this.trashMutations.run({ paths: [trashMutationPath(id)] }, () =>
      this.restoreClaimed(id, opts),
    )
  }

  private async restoreClaimed(id: string, opts?: { principal?: string }): Promise<WriteResult> {
    const tomb = await this.host.journal.latestFor(id)

    // Space binding: the journal is shared across spaces, so a
    // tombstone from ANOTHER space must read as "not in this trash" — else a
    // caller with write here + read elsewhere could materialize that note's body
    // into this space. Anti-enumeration: same error as a genuinely-absent id.
    if (!tomb || tomb.kind !== REVISION_KIND.delete || tomb.space !== this.host.space) {
      throw noteNotInTrash(id)
    }
    // An external delete with an honest gap (body never passed through us) shows
    // in the trash but has nothing to resurrect — fail honestly, don't fabricate.
    if (tomb.contentHash == null) {
      throw revisionHasNoContent(tomb.id)
    }
    const detail = await this.host.journal.detail(id, tomb.id)

    if (!detail || detail.content == null) {
      throw revisionHasNoContent(tomb.id)
    }

    // Aim restore at the note's last folder (from the identity tombstone).
    // WriteEngine claims the destination path, checks collisions, and revives
    // the forced id inside the same mutation checkpoint.
    const lastPath = this.host.identity.recordFor(id)?.filePath
    const dir = (lastPath ? directoryOf(lastPath) : '').replace(/^\/+|\/+$/g, '')
    const result = await this.host.writeAdmitted({
      title: tomb.title,
      content: detail.content,
      tags: tomb.tags,
      // The note's custom slug at deletion, re-set from the tombstone so an
      // undelete keeps its [[old-slug]] resolving instead of dropping to slug(title).
      // null (legacy / no custom slug) → '' = the title default.
      slug: tomb.slug ?? '',
      directory: dir,
      id, // force the same note-id into the frontmatter
      targetClass: (tomb.class ?? undefined) as NoteClass | undefined,
      principal: opts?.principal,
      journal: { kind: REVISION_KIND.restore, sourceRevisionId: tomb.id },
    })
    // Restore is rare and explicit; the caller refetches the trash the instant
    // we answer — wait for the 'restore' revision so listTrashed no longer
    // shows it (the newest revision is no longer a delete).
    await this.host.journal.drain()
    // Close the within-session alias window: the resurrected note had no
    // snapshot `prev` (it was deleted), so applyWrite couldn't re-derive its rename
    // aliases. Re-pull the journal's past titles NOW and re-resolve ghosts, so a
    // rename→delete→restore in ONE session resolves inbound [[Old Title]] at once,
    // not only after a reboot. (The custom slug already healed via applyWrite's
    // index rebuild above; this covers the title-rename aliases.)
    await this.host.reloadHistoricalNames()
    if (this.host.reresolveGhostsFromIndex()) {
      this.host.emitChanged([id], [])
    }

    return result
  }

  /** Best-effort bulk undelete: restore every named tombstone inside one
   *  bulk-write bracket so identity flushes / changed broadcasts / background
   *  work coalesce the same way a bulk import does. Per-id failures are reported
   *  back to the host; one stale/colliding row must not abort the whole burst.
   *  Mirrors purge's two modes: explicit `ids`, or `all + q` for the existing
   *  "select all N" trash affordance beyond the loaded page. */
  async restoreTrash(opts: {
    ids?: readonly string[]
    all?: boolean
    q?: string
    onlyRestorable?: boolean
    scope?: ReadScope
    principal?: string
  }): Promise<{ restored: WriteResult[]; failed: BatchFailure[] }> {
    if (!opts.ids?.length && !opts.all) {
      return { restored: [], failed: [] }
    }
    const claim = opts.ids?.length
      ? { paths: [...new Set(opts.ids.filter((id): id is string => !!id))].map(trashMutationPath) }
      : { prefixes: [TRASH_MUTATION_PREFIX] }

    return this.trashMutations.run(claim, () => this.restoreTrashClaimed(opts))
  }

  private async restoreTrashClaimed(opts: {
    ids?: readonly string[]
    all?: boolean
    q?: string
    onlyRestorable?: boolean
    scope?: ReadScope
    principal?: string
  }): Promise<{ restored: WriteResult[]; failed: BatchFailure[] }> {
    let ids: string[]

    if (opts.ids?.length) {
      ids = [...new Set(opts.ids.filter((id): id is string => !!id))]
    } else if (opts.all) {
      const excludeClasses = this.hiddenClassesFor(opts.scope ?? READ_SCOPE.user)
      ids = []
      let scanOffset = 0

      for (;;) {
        const { items } = await this.host.journal.listTrashed(
          { offset: scanOffset, limit: PAGE, q: opts.q },
          excludeClasses,
        )

        for (const r of items) {
          if (opts.onlyRestorable && r.contentHash == null) {
            continue
          }
          ids.push(r.noteId)
        }
        scanOffset += items.length
        if (items.length < PAGE) {
          break
        }
      }
    } else {
      return { restored: [], failed: [] }
    }
    if (ids.length === 0) {
      return { restored: [], failed: [] }
    }

    const restored: WriteResult[] = []
    const failed: BatchFailure[] = []
    this.host.beginBulk()
    try {
      for (const id of ids) {
        try {
          restored.push(await this.restoreClaimed(id, { principal: opts.principal }))
        } catch (err) {
          const e = err as { message?: unknown; reason?: string }
          failed.push({
            id,
            error: typeof e.message === 'string' && e.message.trim() ? e.message : 'restore failed',
            ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
          })
        }
      }

      return { restored, failed }
    } finally {
      await this.host.endBulk()
    }
  }

  async purgeTrash(opts: {
    ids?: readonly string[]
    all?: boolean
    q?: string
    scope?: ReadScope
  }): Promise<{ purged: number }> {
    if (!opts.ids?.length && !opts.all) {
      return { purged: 0 }
    }
    const claim = opts.ids?.length
      ? { paths: [...new Set(opts.ids.filter((id): id is string => !!id))].map(trashMutationPath) }
      : { prefixes: [TRASH_MUTATION_PREFIX] }

    return this.trashMutations.run(claim, () => this.purgeClaimed(opts))
  }

  private async purgeClaimed(opts: {
    ids?: readonly string[]
    all?: boolean
    q?: string
    scope?: ReadScope
  }): Promise<{ purged: number }> {
    let ids: string[]

    if (opts.ids?.length) {
      ids = [...new Set(opts.ids.filter((id): id is string => !!id))]
    } else if (opts.all) {
      // "Select all N": every trashed note in scope matching `q`,
      // paged (the count is stable — nothing is erased until the purge below).
      const excludeClasses = this.hiddenClassesFor(opts.scope ?? READ_SCOPE.user)
      ids = []

      for (;;) {
        const { items } = await this.host.journal.listTrashed(
          { offset: ids.length, limit: PAGE, q: opts.q },
          excludeClasses,
        )

        for (const r of items) {
          ids.push(r.noteId)
        }
        if (items.length < PAGE) {
          break
        }
      }
    } else {
      return { purged: 0 } // neither ids nor all → nothing to do
    }
    if (!ids.length) {
      return { purged: 0 }
    }
    // Revalidate under the trash fence. purgeNotes erases a note's whole
    // journal, so a stale selection must never purge a restored note.
    const purgable: string[] = []

    for (const id of ids) {
      const tomb = await this.host.journal.latestFor(id)

      if (tomb && tomb.kind === REVISION_KIND.delete && tomb.space === this.host.space) {
        purgable.push(id)
      }
    }
    if (!purgable.length) {
      return { purged: 0 }
    }
    await this.host.journal.purge(purgable)
    return { purged: purgable.length }
  }

  /** The read-only last state of a DELETED note for the reader's "deleted"
   *  banner: title/body/tags from the delete-tombstone + its CAS blob. null when
   *  the note isn't actually trashed (newest revision isn't a delete) or there is
   *  no journal — the caller then rethrows the real not-found. `restorable` is
   *  false for an honest gap (no body blob); `versionToken` is empty (no live note
   *  to save against — the reader hides editing). */
  async deletedNoteView(id: string): Promise<NoteContent | null> {
    let tomb: Revision | null

    try {
      tomb = await this.host.journal.latestFor(id)
    } catch {
      return null
    }
    if (!tomb || tomb.kind !== REVISION_KIND.delete) {
      return null
    }
    const detail =
      tomb.contentHash != null
        ? await this.host.journal.detail(id, tomb.id).catch(() => null)
        : null
    return {
      id,
      title: tomb.title,
      class: (tomb.class ?? undefined) as NoteClass | undefined,
      filePath: this.host.identity.recordFor(id)?.filePath ?? undefined,
      content: detail?.content ?? '',
      frontmatter: { tags: tomb.tags },
      versionToken: '',
      deleted: true,
      deletedAt: tomb.createdAt,
      deletedByPrincipal: tomb.principal,
      restorable: tomb.contentHash != null,
    }
  }

  /** The classes a discovery scope HIDES — the exclude set the journal's trash
   *  query and activity queries take (the read-model visibility chokepoint). */
  private hiddenClassesFor(scope: ReadScope): string[] {
    const admitted = classesForScope(scope)
    return NOTE_CLASSES.filter((c) => !admitted.has(c))
  }
}
