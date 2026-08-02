import type { AuthorFilter, Revision, RevisionInput, RevisionPersistence } from '@notarium/core'

import type { SqliteDriverCtx } from './context'

type RevisionRow = {
  id: number | bigint
  note_id: string
  space: string
  base_rev: number | bigint | null
  their_rev: number | bigint | null
  source_rev: number | bigint | null
  kind: string
  principal: string | null
  content_hash: string | null
  title: string
  class: string | null
  slug: string | null
  tags: string
  created_at: string
  chars_added: number | bigint | null
  chars_removed: number | bigint | null
}

const revisionOfRow = (r: RevisionRow): Revision => ({
  id: String(r.id),
  noteId: r.note_id,
  space: r.space,
  baseRevisionId: r.base_rev == null ? null : String(r.base_rev),
  theirRevisionId: r.their_rev == null ? null : String(r.their_rev),
  sourceRevisionId: r.source_rev == null ? null : String(r.source_rev),
  kind: r.kind as Revision['kind'],
  principal: r.principal,
  contentHash: r.content_hash,
  title: r.title,
  class: r.class ?? null,
  slug: r.slug ?? null,
  tags: JSON.parse(r.tags) as string[],
  createdAt: r.created_at,
  charsAdded: r.chars_added == null ? null : Number(r.chars_added),
  charsRemoved: r.chars_removed == null ? null : Number(r.chars_removed),
})

/** Author-scope predicate as `?` SQL. A present-but-empty filter → ` AND 0`
 *  (matches nothing, not everything). Usernames carry no LIKE wildcard, so no
 *  ESCAPE is needed. */
const authorClauseSqlite = (author?: AuthorFilter): { clause: string; params: string[] } => {
  if (!author) {
    return { clause: '', params: [] }
  }
  const parts: string[] = []
  const params: string[] = []

  if (author.exact.length) {
    parts.push(`principal IN (${author.exact.map(() => '?').join(',')})`)
    params.push(...author.exact)
  }
  for (const p of author.prefixes) {
    parts.push('principal LIKE ?')
    params.push(`${p}%`)
  }

  return { clause: parts.length ? ` AND (${parts.join(' OR ')})` : ' AND 0', params }
}

export const createRevisionsFacet = (ctx: SqliteDriverCtx): RevisionPersistence => ({
  init: () => ctx.ensureInit(),
  append: async (rev: RevisionInput, content: string | null) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN')
    try {
      const fence = db
        .prepare(
          `SELECT kind FROM revision_purge_fences
            WHERE (kind = 'space' AND entity_id = ?)
               OR (kind = 'note' AND entity_id = ?)
            LIMIT 1`,
        )
        .get(rev.space, rev.noteId) as { kind: string } | undefined

      if (fence) {
        throw new Error(`revision target was permanently purged: ${fence.kind}`)
      }
      if (rev.contentHash != null && content != null) {
        db.prepare('INSERT OR IGNORE INTO revision_blobs (hash, content) VALUES (?, ?)').run(
          rev.contentHash,
          content,
        )
      }
      const res = db
        .prepare(
          `INSERT INTO note_revisions
               (note_id, space, base_rev, their_rev, source_rev, kind, principal, content_hash, title, class, slug, tags, created_at, chars_added, chars_removed)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rev.noteId,
          rev.space,
          rev.baseRevisionId == null ? null : Number(rev.baseRevisionId),
          rev.theirRevisionId == null ? null : Number(rev.theirRevisionId),
          rev.sourceRevisionId == null ? null : Number(rev.sourceRevisionId),
          rev.kind,
          rev.principal,
          rev.contentHash,
          rev.title,
          rev.class,
          rev.slug,
          JSON.stringify(rev.tags),
          rev.createdAt,
          rev.charsAdded,
          rev.charsRemoved,
        )
      db.exec('COMMIT')
      return { ...rev, tags: [...rev.tags], id: String(res.lastInsertRowid) }
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  listByNote: async (noteId, { offset, limit }) => {
    await ctx.ensureInit()
    const db = ctx.required
    const items = (
      db
        .prepare('SELECT * FROM note_revisions WHERE note_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(noteId, limit, offset) as RevisionRow[]
    ).map(revisionOfRow)
    const total = (
      db.prepare('SELECT COUNT(*) AS n FROM note_revisions WHERE note_id = ?').get(noteId) as {
        n: number
      }
    ).n
    return { items, total }
  },
  listBySpaceSince: async (space, sinceRevId, limit, excludeClasses = []) => {
    await ctx.ensureInit()
    const db = ctx.required
    const since = sinceRevId == null ? 0 : Number(sinceRevId)
    // Exclude hidden classes INSIDE the query so the window, the distinct total
    // and the max id are all post-filter; a null class is kept.
    const exFilter = excludeClasses.length
      ? ` AND (class IS NULL OR class NOT IN (${excludeClasses.map(() => '?').join(',')}))`
      : ''
    const exArgs = [...excludeClasses]
    const items = (
      db
        .prepare(
          `SELECT * FROM (
               SELECT *, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
               FROM note_revisions WHERE space = ? AND id > ?${exFilter}
             ) WHERE rn = 1 ORDER BY id DESC LIMIT ?`,
        )
        .all(space, since, ...exArgs, limit) as RevisionRow[]
    ).map(revisionOfRow)
    const agg = db
      .prepare(
        `SELECT COUNT(DISTINCT note_id) AS n, MAX(id) AS m FROM note_revisions WHERE space = ? AND id > ?${exFilter}`,
      )
      .get(space, since, ...exArgs) as { n: number; m: number | bigint | null }
    return { items, total: agg.n, maxRevId: agg.m == null ? null : String(agg.m) }
  },
  activityByDay: async (space, { from, to, tzOffsetMinutes, excludeClasses = [], author }) => {
    await ctx.ensureInit()
    const db = ctx.required
    const exFilter = excludeClasses.length
      ? ` AND (class IS NULL OR class NOT IN (${excludeClasses.map(() => '?').join(',')}))`
      : ''
    const au = authorClauseSqlite(author)
    // Exclude the synthetic pre-edit baseline (`external` with no chain parent)
    // so a pre-existing note's first edit isn't double-counted.
    // canon: docs/note-history.md#model
    const shift = `${tzOffsetMinutes >= 0 ? '+' : ''}${tzOffsetMinutes} minutes`
    const rows = db
      .prepare(
        `SELECT date(created_at, ?) AS day,
                  SUM(CASE WHEN kind = 'delete' THEN 1 ELSE 0 END) AS deleted,
                  SUM(CASE WHEN kind <> 'delete' AND base_rev IS NULL THEN 1 ELSE 0 END) AS created,
                  SUM(CASE WHEN kind <> 'delete' AND base_rev IS NOT NULL THEN 1 ELSE 0 END) AS edited
             FROM note_revisions
            WHERE space = ? AND created_at >= ? AND created_at < ?
              AND NOT (kind = 'external' AND base_rev IS NULL)${exFilter}${au.clause}
            GROUP BY day ORDER BY day ASC`,
      )
      .all(shift, space, from, to, ...excludeClasses, ...au.params) as Array<{
      day: string
      created: number
      edited: number
      deleted: number
    }>
    return rows.map((r) => ({
      date: r.day,
      created: r.created,
      edited: r.edited,
      deleted: r.deleted,
    }))
  },
  activityEvents: async (space, { from, to, offset, limit, excludeClasses = [], author }) => {
    await ctx.ensureInit()
    const db = ctx.required
    const where = ['space = ?', "NOT (kind = 'external' AND base_rev IS NULL)"]
    const args: string[] = [space]

    if (from != null) {
      where.push('created_at >= ?')
      args.push(from)
    }
    if (to != null) {
      where.push('created_at < ?')
      args.push(to)
    }
    if (excludeClasses.length) {
      where.push(`(class IS NULL OR class NOT IN (${excludeClasses.map(() => '?').join(',')}))`)
      args.push(...excludeClasses)
    }
    if (author) {
      const au = authorClauseSqlite(author)
      // `au.clause` already leads with ' AND ' — strip it: this list is AND-joined.
      where.push(au.clause.replace(/^ AND /, ''))
      args.push(...au.params)
    }
    const whereSql = where.join(' AND ')
    const items = (
      db
        .prepare(`SELECT * FROM note_revisions WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(...args, limit, offset) as RevisionRow[]
    ).map(revisionOfRow)
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM note_revisions WHERE ${whereSql}`).get(...args) as {
        n: number
      }
    ).n
    return { items, total }
  },
  activityByNote: async (space, { from, to, excludeClasses = [] }) => {
    await ctx.ensureInit()
    const exFilter = excludeClasses.length
      ? ` AND (class IS NULL OR class NOT IN (${excludeClasses.map(() => '?').join(',')}))`
      : ''
    const rows = ctx.required
      .prepare(
        `SELECT note_id, COUNT(*) AS n, MAX(created_at) AS last
             FROM note_revisions
            WHERE space = ? AND created_at >= ? AND created_at < ?
              AND NOT (kind = 'external' AND base_rev IS NULL)${exFilter}
            GROUP BY note_id`,
      )
      .all(space, from, to, ...excludeClasses) as Array<{
      note_id: string
      n: number
      last: string
    }>
    return rows.map((r) => ({ noteId: r.note_id, count: r.n, lastAt: r.last }))
  },
  get: async (revisionId) => {
    await ctx.ensureInit()
    if (!/^\d+$/.test(revisionId)) {
      return null
    }
    const row = ctx.required
      .prepare('SELECT * FROM note_revisions WHERE id = ?')
      .get(Number(revisionId)) as RevisionRow | undefined
    return row ? revisionOfRow(row) : null
  },
  latestFor: async (noteId) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare('SELECT * FROM note_revisions WHERE note_id = ? ORDER BY id DESC LIMIT 1')
      .get(noteId) as RevisionRow | undefined
    return row ? revisionOfRow(row) : null
  },
  listTrashed: async (space, { offset, limit, q }, excludeClasses = []) => {
    await ctx.ensureInit()
    const db = ctx.required
    // Drop hidden classes BEFORE the per-note collapse, so a hidden class can't
    // become the surviving newest row or skew the total; a null class is kept.
    const exFilter = excludeClasses.length
      ? ` AND (class IS NULL OR class NOT IN (${excludeClasses.map(() => '?').join(',')}))`
      : ''
    const exArgs = [...excludeClasses]
    // Title search runs AFTER the collapse (title lives on the surviving tombstone
    // row); LIKE wildcards in the needle are escaped so a literal %/_ can't match-all.
    const needle = q?.trim().toLowerCase()
    const qFilter = needle ? " AND lower_u(title) LIKE ? ESCAPE '\\'" : ''
    const qArgs = needle ? [`%${needle.replace(/[\\%_]/g, (c) => '\\' + c)}%`] : []
    // Trash = notes whose newest revision is a delete-tombstone; a later
    // restore/save makes the newest a write, so the note drops out.
    // canon: docs/trash.md#model
    const items = (
      db
        .prepare(
          `SELECT * FROM (
               SELECT *, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
               FROM note_revisions WHERE space = ?${exFilter}
             ) WHERE rn = 1 AND kind = 'delete'${qFilter} ORDER BY id DESC LIMIT ? OFFSET ?`,
        )
        .all(space, ...exArgs, ...qArgs, limit, offset) as RevisionRow[]
    ).map(revisionOfRow)
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
               SELECT note_id, kind, title, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
               FROM note_revisions WHERE space = ?${exFilter}
             ) WHERE rn = 1 AND kind = 'delete'${qFilter}`,
        )
        .get(space, ...exArgs, ...qArgs) as { n: number }
    ).n
    const restorableTotal = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
               SELECT note_id, kind, title, content_hash, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
               FROM note_revisions WHERE space = ?${exFilter}
             ) WHERE rn = 1 AND kind = 'delete' AND content_hash IS NOT NULL${qFilter}`,
        )
        .get(space, ...exArgs, ...qArgs) as { n: number }
    ).n
    return { items, total, restorableTotal }
  },
  purgeNotes: async (noteIds) => {
    await ctx.ensureInit()
    if (!noteIds.length) {
      return
    }
    const db = ctx.required
    const CHUNK = 400 // keep the IN-list well under SQLite's variable cap
    db.exec('BEGIN')
    try {
      const fenceNote = db.prepare(
        "INSERT OR IGNORE INTO revision_purge_fences (kind, entity_id) VALUES ('note', ?)",
      )

      for (const noteId of new Set(noteIds)) {
        fenceNote.run(noteId)
      }
      const stillUsed = db.prepare('SELECT 1 FROM note_revisions WHERE content_hash = ? LIMIT 1')
      const dropBlob = db.prepare('DELETE FROM revision_blobs WHERE hash = ?')

      for (let i = 0; i < noteIds.length; i += CHUNK) {
        const batch = noteIds.slice(i, i + CHUNK)
        const ph = batch.map(() => '?').join(',')
        const hashes = (
          db
            .prepare(
              `SELECT DISTINCT content_hash AS h FROM note_revisions WHERE note_id IN (${ph}) AND content_hash IS NOT NULL`,
            )
            .all(...batch) as Array<{ h: string }>
        ).map((r) => r.h)
        db.prepare(`DELETE FROM note_revisions WHERE note_id IN (${ph})`).run(...batch)
        // GC each blob whose last referrer just went away (the CAS is shared).
        for (const h of hashes) {
          if (!stillUsed.get(h)) {
            dropBlob.run(h)
          }
        }
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  latestTimestamps: async (space) => {
    await ctx.ensureInit()
    // Bare-column semantics: with MAX(id) in the select list, SQLite serves
    // the other columns from that max row — the newest revision per note.
    const rows = ctx.required
      .prepare(
        'SELECT note_id, created_at, MAX(id) FROM note_revisions WHERE space = ? GROUP BY note_id',
      )
      .all(space) as Array<{ note_id: string; created_at: string }>
    return new Map(rows.map((r) => [r.note_id, r.created_at]))
  },
  historicalNames: async (space) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare("SELECT DISTINCT note_id, title FROM note_revisions WHERE space = ? AND title <> ''")
      .all(space) as Array<{ note_id: string; title: string }>
    const map = new Map<string, string[]>()

    for (const r of rows) {
      const list = map.get(r.note_id)

      if (list) {
        list.push(r.title)
      } else {
        map.set(r.note_id, [r.title])
      }
    }

    return map
  },
  content: async (contentHash) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare('SELECT content FROM revision_blobs WHERE hash = ?')
      .get(contentHash) as { content: string } | undefined
    return row?.content ?? null
  },
  close: () => ctx.close(),
})
