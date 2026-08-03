// In-memory driver of the revision persistence port: the journal's twin of the
// ephemeral identity registry — a host without a meta-DB still journals, the
// history just lives for the process lifetime (honest degradation, P5). Also
// the e2e fake's journal and the reference implementation unit tests pin.

import {
  type ActivityDayCount,
  type ActivityNoteCount,
  type AuthorFilter,
  type Revision,
  REVISION_KIND,
  type RevisionInput,
  type RevisionPersistence,
} from '../knowledgeStore'

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

/** A revision that does NOT count as activity: a synthetic pre-edit
 *  baseline / first-sighting — an `external` row that is a note's very first
 *  journal entry (no chain parent). Counting it would double a pre-existing
 *  note's first edit (the baseline + the write share a day). The SQL drivers
 *  encode the same predicate as `NOT (kind = 'external' AND base_rev IS NULL)`. */
export const isSyntheticBaseline = (r: {
  kind: Revision['kind']
  baseRevisionId: string | null
}): boolean => r.kind === REVISION_KIND.external && r.baseRevisionId == null

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

export class InMemoryRevisionPersistence implements RevisionPersistence {
  private revisions: Revision[] = []
  private blobs = new Map<string, string>()
  private purgedNoteIds = new Set<string>()
  private nextId = 1

  async init(): Promise<void> {}

  async append(rev: RevisionInput, content: string | null): Promise<Revision> {
    if (this.purgedNoteIds.has(rev.noteId)) {
      throw new Error('revision target was permanently purged: note')
    }
    if (rev.contentHash != null && content != null && !this.blobs.has(rev.contentHash)) {
      this.blobs.set(rev.contentHash, content)
    }
    const stored: Revision = { ...rev, tags: [...rev.tags], id: String(this.nextId++) }
    this.revisions.push(stored)
    return stored
  }

  async listByNote(
    noteId: string,
    { offset, limit }: { offset: number; limit: number },
  ): Promise<{ items: Revision[]; total: number }> {
    // Append order IS the timeline; ids are monotonic by construction.
    const all = this.revisions.filter((r) => r.noteId === noteId).reverse()
    return { items: all.slice(offset, offset + limit), total: all.length }
  }

  async listBySpaceSince(
    space: string,
    sinceRevId: string | null,
    limit: number,
    excludeClasses: readonly string[] = [],
  ): Promise<{ items: Revision[]; total: number; maxRevId: string | null }> {
    const since = sinceRevId == null ? 0 : Number(sinceRevId)
    const after = this.revisions.filter(
      (r) =>
        r.space === space &&
        Number(r.id) > since &&
        !(r.class != null && excludeClasses.includes(r.class)),
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
    return { items, total: newestByNote.size, maxRevId: String(maxId) }
  }

  async get(revisionId: string): Promise<Revision | null> {
    return this.revisions.find((r) => r.id === revisionId) ?? null
  }

  async listTrashed(
    space: string,
    { offset, limit, q }: { offset: number; limit: number; q?: string },
    excludeClasses: readonly string[] = [],
  ): Promise<{ items: Revision[]; total: number; restorableTotal: number }> {
    // Newest revision per note (excluded classes dropped BEFORE the collapse, so
    // a hidden class can't become "newest survivor" — mirrors the SQL drivers).
    const newestByNote = new Map<string, Revision>()

    for (const r of this.revisions) {
      if (r.space !== space) {
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
      .sort((a, b) => Number(b.id) - Number(a.id))
    return {
      items: tombstones.slice(offset, offset + limit),
      total: tombstones.length,
      restorableTotal: tombstones.filter((r) => r.contentHash != null).length,
    }
  }

  async purgeNotes(noteIds: readonly string[]): Promise<void> {
    const ids = new Set(noteIds)

    if (!ids.size) {
      return
    }
    for (const id of ids) {
      this.purgedNoteIds.add(id)
    }
    const removed = this.revisions.filter((r) => ids.has(r.noteId))
    this.revisions = this.revisions.filter((r) => !ids.has(r.noteId))
    // GC blobs no surviving revision references (the CAS is shared by hash).
    const surviving = new Set(
      this.revisions.map((r) => r.contentHash).filter((h): h is string => h != null),
    )

    for (const r of removed) {
      if (r.contentHash && !surviving.has(r.contentHash)) {
        this.blobs.delete(r.contentHash)
      }
    }
  }

  async latestFor(noteId: string): Promise<Revision | null> {
    for (let i = this.revisions.length - 1; i >= 0; i--) {
      if (this.revisions[i].noteId === noteId) {
        return this.revisions[i]
      }
    }

    return null
  }

  async latestForMany(noteIds: readonly string[]): Promise<Map<string, Revision>> {
    const wanted = new Set(noteIds)
    const out = new Map<string, Revision>()

    for (let i = this.revisions.length - 1; i >= 0 && out.size < wanted.size; i--) {
      const revision = this.revisions[i]

      if (wanted.has(revision.noteId) && !out.has(revision.noteId)) {
        out.set(revision.noteId, revision)
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
      if (isSyntheticBaseline(r)) {
        continue
      }
      if (r.class != null && excludeClasses.includes(r.class)) {
        continue
      }
      if (author && !matchesAuthor(r.principal, author)) {
        continue
      }
      const t = Date.parse(r.createdAt)

      if (t < fromT || t >= toT) {
        continue
      }
      const date = localDayOf(r.createdAt, tzOffsetMinutes)
      let bucket = byDay.get(date)

      if (!bucket) {
        bucket = { date, created: 0, edited: 0, deleted: 0 }
        byDay.set(date, bucket)
      }
      if (r.kind === REVISION_KIND.delete) {
        bucket.deleted++
      } else if (r.baseRevisionId == null) {
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
    }: {
      from?: string
      to?: string
      offset: number
      limit: number
      excludeClasses?: readonly string[]
      author?: AuthorFilter
    },
  ): Promise<{ items: Revision[]; total: number }> {
    const fromT = from == null ? -Infinity : Date.parse(from)
    const toT = to == null ? Infinity : Date.parse(to)
    const matched = this.revisions.filter((r) => {
      if (r.space !== space) {
        return false
      }
      if (isSyntheticBaseline(r)) {
        return false
      }
      if (r.class != null && excludeClasses.includes(r.class)) {
        return false
      }
      if (author && !matchesAuthor(r.principal, author)) {
        return false
      }
      const t = Date.parse(r.createdAt)
      return t >= fromT && t < toT
    })
    // Append order IS id order — newest first.
    const sorted = matched.sort((a, b) => Number(b.id) - Number(a.id))
    return { items: sorted.slice(offset, offset + limit), total: sorted.length }
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
      if (isSyntheticBaseline(r)) {
        continue
      }
      if (r.class != null && excludeClasses.includes(r.class)) {
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
      if (r.space === space) {
        map.set(r.noteId, r.createdAt)
      }
    }

    return map
  }

  async historicalNames(space: string): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>()

    for (const r of this.revisions) {
      if (r.space !== space || !r.title) {
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

  async content(contentHash: string): Promise<string | null> {
    return this.blobs.get(contentHash) ?? null
  }

  async close(): Promise<void> {}

  /** Test-only: back to an empty journal (the e2e fake's reset). */
  clear(): void {
    this.revisions = []
    this.blobs.clear()
    this.purgedNoteIds.clear()
    this.nextId = 1
  }
}
