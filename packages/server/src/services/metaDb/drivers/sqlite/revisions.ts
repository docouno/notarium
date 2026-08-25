import {
  AGENT_SESSION_ATTACH,
  type AuthorFilter,
  DOCUMENT_STATE_FORMAT,
  LOGICAL_NOTE_STATE_FORMAT,
  type Revision,
  REVISION_INTEGRITY,
  type RevisionBlob,
  revisionGapOf,
  RevisionHeadConflictError,
  type RevisionInput,
  type RevisionPersistence,
} from '@notarium/core'

import {
  effectiveAuthorClause,
  effectiveClassClause,
  notSyntheticBaselineClause,
  ORIGIN_ONLY,
  QUARANTINED,
  TRUSTED_ONLY,
} from '../../revisionProjection'
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
  agent_owner: string | null
  agent_name: string | null
  session_id: string | null
  session_name: string | null
  session_attach: string | null
  content_hash: string | null
  semantic_fingerprint: string | null
  restore_safety: Revision['restoreSafety']
  state_format: string | null
  title: string
  class: string | null
  slug: string | null
  tags: string
  created_at: string
  chars_added: number | bigint | null
  chars_removed: number | bigint | null
  integrity: string | null
  entry_role: string
}

/** The ONE place a stored row becomes a served row. A contaminated chain is
 *  handed out as a gap here, so no consumer can accidentally read a raw column
 *  off it; the QUERIES above must still classify and filter on effective values,
 *  which is what `revisionProjection` encodes. canon: docs/core.md#identity */
const revisionOfRow = (r: RevisionRow): Revision =>
  r.integrity === REVISION_INTEGRITY.quarantined
    ? revisionGapOf(rawRevisionOfRow(r))
    : rawRevisionOfRow(r)

const rawRevisionOfRow = (r: RevisionRow): Revision => ({
  id: String(r.id),
  noteId: r.note_id,
  space: r.space,
  baseRevisionId: r.base_rev == null ? null : String(r.base_rev),
  theirRevisionId: r.their_rev == null ? null : String(r.their_rev),
  sourceRevisionId: r.source_rev == null ? null : String(r.source_rev),
  kind: r.kind as Revision['kind'],
  entryRole: r.entry_role as Revision['entryRole'],
  principal: r.principal,
  ...(r.agent_owner
    ? {
        agent: {
          owner: r.agent_owner,
          agent: r.agent_name,
          ...(r.session_id &&
          r.session_name &&
          (r.session_attach === AGENT_SESSION_ATTACH.declared ||
            r.session_attach === AGENT_SESSION_ATTACH.inferred)
            ? {
                session: {
                  id: r.session_id,
                  name: r.session_name,
                  attach: r.session_attach,
                },
              }
            : {}),
        },
      }
    : {}),
  contentHash: r.content_hash,
  semanticFingerprint: r.semantic_fingerprint,
  restoreSafety: r.restore_safety,
  stateFormat: r.state_format as Revision['stateFormat'],
  title: r.title,
  class: r.class ?? null,
  slug: r.slug ?? null,
  tags: JSON.parse(r.tags) as string[],
  createdAt: r.created_at,
  charsAdded: r.chars_added == null ? null : Number(r.chars_added),
  charsRemoved: r.chars_removed == null ? null : Number(r.chars_removed),
})

/** Author-scope predicate as `?` SQL. A present-but-empty filter matches nothing,
 *  not everything — `effectiveAuthorClause` encodes that. Usernames carry no LIKE
 *  wildcard, so no ESCAPE is needed. */
const authorClauseSqlite = (author?: AuthorFilter): { clause: string; params: string[] } => {
  if (!author) {
    return { clause: '', params: [] }
  }
  const parts: string[] = []
  const params: string[] = []

  if (author.exact.length) {
    parts.push(`principal IN (${author.exact.map(() => '?').join(',')})`)
    // An author filter names a handful of principals, not a corpus.
    // eslint-disable-next-line no-restricted-syntax
    params.push(...author.exact)
  }
  for (const p of author.prefixes) {
    parts.push('principal LIKE ?')
    params.push(`${p}%`)
  }

  return { clause: effectiveAuthorClause(parts), params }
}

/** Class exclusion over the effective class — see `revisionProjection`. */
const classFilterSqlite = (excludeClasses: readonly string[]): string =>
  effectiveClassClause(excludeClasses.map(() => '?'))

export const createRevisionsFacet = (ctx: SqliteDriverCtx): RevisionPersistence => ({
  init: () => ctx.ensureInit(),
  append: async (rev: RevisionInput, content: RevisionBlob | null) => {
    await ctx.ensureInit()
    const db = ctx.required
    // Pair with conditional purge's BEGIN IMMEDIATE: fence-check + append and
    // latest-compare + purge have a single cross-connection winner.
    db.exec('BEGIN IMMEDIATE')
    try {
      const fence = db
        .prepare(
          `SELECT kind FROM revision_purge_fences
            WHERE (kind = 'space' AND entity_id = ?)
               OR (kind = 'note' AND entity_id = ? AND space IN ('', ?))
            LIMIT 1`,
        )
        .get(rev.space, rev.noteId, rev.space) as { kind: string } | undefined

      if (fence) {
        throw new Error(`revision target was permanently purged: ${fence.kind}`)
      }
      const headRow = db
        .prepare(
          `SELECT revisions.*
             FROM revision_heads AS heads
             JOIN note_revisions AS revisions ON revisions.id = heads.revision_id
            WHERE heads.space = ? AND heads.note_id = ?`,
        )
        .get(rev.space, rev.noteId) as RevisionRow | undefined
      const head = headRow ? revisionOfRow(headRow) : null

      if (
        rev.expectedHeadRevisionId !== undefined &&
        (head?.id ?? null) !== rev.expectedHeadRevisionId
      ) {
        throw new RevisionHeadConflictError(
          rev.noteId,
          rev.expectedHeadRevisionId,
          head?.id ?? null,
        )
      }
      if (
        rev.expectedHeadRevisionId !== undefined &&
        rev.baseRevisionId !== rev.expectedHeadRevisionId
      ) {
        throw new Error('revision base must equal the expected head')
      }
      const lifecycle = rev.kind === 'delete' ? 'deleted' : 'live'
      const headLifecycle = head?.kind === 'delete' ? 'deleted' : 'live'

      if (
        rev.allowSemanticNoop === true &&
        rev.semanticFingerprint != null &&
        head?.semanticFingerprint === rev.semanticFingerprint &&
        headLifecycle === lifecycle
      ) {
        db.exec('COMMIT')
        return head
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
               (note_id, space, base_rev, their_rev, source_rev, kind, entry_role, principal, agent_owner, agent_name, session_id, session_name, session_attach, content_hash, semantic_fingerprint, restore_safety, state_format, title, class, slug, tags, created_at, chars_added, chars_removed, integrity)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rev.noteId,
          rev.space,
          rev.baseRevisionId == null ? null : Number(rev.baseRevisionId),
          rev.theirRevisionId == null ? null : Number(rev.theirRevisionId),
          rev.sourceRevisionId == null ? null : Number(rev.sourceRevisionId),
          rev.kind,
          rev.entryRole,
          rev.principal,
          rev.agent?.owner ?? null,
          rev.agent?.agent ?? null,
          rev.agent?.session?.id ?? null,
          rev.agent?.session?.name ?? null,
          rev.agent?.session?.attach ?? null,
          rev.contentHash,
          rev.semanticFingerprint ?? null,
          rev.restoreSafety ?? null,
          rev.stateFormat ?? null,
          rev.title,
          rev.class,
          rev.slug,
          JSON.stringify(rev.tags),
          rev.createdAt,
          rev.charsAdded,
          rev.charsRemoved,
          REVISION_INTEGRITY.trusted,
        )
      db.prepare(
        `INSERT INTO revision_heads
          (note_id, space, revision_id, semantic_fingerprint, lifecycle)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(space, note_id) DO UPDATE SET
           revision_id = excluded.revision_id,
           semantic_fingerprint = excluded.semantic_fingerprint,
           lifecycle = excluded.lifecycle`,
      ).run(rev.noteId, rev.space, res.lastInsertRowid, rev.semanticFingerprint ?? null, lifecycle)
      db.exec('COMMIT')
      const stored = { ...rev }
      delete stored.allowSemanticNoop
      delete stored.expectedHeadRevisionId
      return {
        ...stored,
        semanticFingerprint: rev.semanticFingerprint ?? null,
        restoreSafety: rev.restoreSafety ?? null,
        stateFormat: rev.stateFormat ?? null,
        tags: [...rev.tags],
        id: String(res.lastInsertRowid),
      }
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  listByNote: async (space, noteId, { offset, limit }) => {
    await ctx.ensureInit()
    const db = ctx.required
    const items = (
      db
        .prepare(
          'SELECT * FROM note_revisions WHERE space = ? AND note_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
        )
        .all(space, noteId, limit, offset) as RevisionRow[]
    ).map(revisionOfRow)
    const total = (
      db
        .prepare('SELECT COUNT(*) AS n FROM note_revisions WHERE space = ? AND note_id = ?')
        .get(space, noteId) as { n: number }
    ).n
    return { items, total }
  },
  listBySpaceSince: async (space, sinceRevId, limit, excludeClasses = []) => {
    await ctx.ensureInit()
    const db = ctx.required
    const since = sinceRevId == null ? 0 : Number(sinceRevId)
    // Exclude hidden classes INSIDE the query so the window, the distinct total
    // and the max id are all post-filter; a null class is kept.
    const exFilter = classFilterSqlite(excludeClasses)
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
    const exFilter = classFilterSqlite(excludeClasses)
    const au = authorClauseSqlite(author)
    // Exclude the rows the writer marked `baseline` so a pre-existing note's first
    // edit isn't double-counted. A gap is NEVER suppressed by that rule — quarantine
    // does not change a row's role, so the immunity comes from the QUARANTINED
    // disjunct in the predicate, not from a missing parent.
    // canon: docs/note-history.md#model · docs/dashboard.md
    const shift = `${tzOffsetMinutes >= 0 ? '+' : ''}${tzOffsetMinutes} minutes`
    const rows = db
      .prepare(
        `SELECT date(created_at, ?) AS day,
                  SUM(CASE WHEN ${QUARANTINED} THEN 1 ELSE 0 END) AS unavailable,
                  SUM(CASE WHEN ${TRUSTED_ONLY} AND kind = 'delete' THEN 1 ELSE 0 END) AS deleted,
                  SUM(CASE WHEN ${TRUSTED_ONLY} AND kind <> 'delete' AND ${ORIGIN_ONLY} THEN 1 ELSE 0 END) AS created,
                  SUM(CASE WHEN ${TRUSTED_ONLY} AND kind <> 'delete' AND NOT (${ORIGIN_ONLY}) THEN 1 ELSE 0 END) AS edited
             FROM note_revisions
            WHERE space = ? AND created_at >= ? AND created_at < ?
              AND ${notSyntheticBaselineClause}${exFilter}${au.clause}
            GROUP BY day ORDER BY day ASC`,
      )
      .all(shift, space, from, to, ...excludeClasses, ...au.params) as Array<{
      day: string
      created: number
      edited: number
      deleted: number
      unavailable: number
    }>
    return rows.map((r) => ({
      date: r.day,
      created: r.created,
      edited: r.edited,
      deleted: r.deleted,
      unavailable: r.unavailable,
    }))
  },
  activityEvents: async (space, { from, to, offset, limit, excludeClasses = [], author }) => {
    await ctx.ensureInit()
    const db = ctx.required
    const where = ['space = ?', notSyntheticBaselineClause]
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
      where.push(classFilterSqlite(excludeClasses).replace(/^ AND /, ''))
      // At most one entry per note class — the enum bounds it.
      // eslint-disable-next-line no-restricted-syntax
      args.push(...excludeClasses)
    }
    if (author) {
      const au = authorClauseSqlite(author)
      // `au.clause` already leads with ' AND ' — strip it: this list is AND-joined.
      where.push(au.clause.replace(/^ AND /, ''))
      // The author clause carries the same handful of principals as its filter.
      // eslint-disable-next-line no-restricted-syntax
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
    const exFilter = classFilterSqlite(excludeClasses)
    const rows = ctx.required
      .prepare(
        `SELECT note_id, COUNT(*) AS n, MAX(created_at) AS last
             FROM note_revisions
            WHERE space = ? AND created_at >= ? AND created_at < ?
              AND ${notSyntheticBaselineClause}${exFilter}
            GROUP BY note_id`,
      )
      .all(space, from, to, ...excludeClasses) as Array<{
      note_id: string
      n: number
      last: string
    }>
    return rows.map((r) => ({ noteId: r.note_id, count: r.n, lastAt: r.last }))
  },
  get: async (space, revisionId) => {
    await ctx.ensureInit()
    if (!/^\d+$/.test(revisionId)) {
      return null
    }
    const row = ctx.required
      .prepare('SELECT * FROM note_revisions WHERE space = ? AND id = ?')
      .get(space, Number(revisionId)) as RevisionRow | undefined
    return row ? revisionOfRow(row) : null
  },
  hasAnyFor: async (space, noteId) => {
    await ctx.ensureInit()
    return Boolean(
      ctx.required
        .prepare('SELECT 1 FROM note_revisions WHERE space = ? AND note_id = ? LIMIT 1')
        .get(space, noteId),
    )
  },
  latestFor: async (space, noteId) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare(
        `SELECT * FROM note_revisions WHERE space = ? AND note_id = ? AND ${TRUSTED_ONLY} ORDER BY id DESC LIMIT 1`,
      )
      .get(space, noteId) as RevisionRow | undefined
    return row ? revisionOfRow(row) : null
  },
  latestForMany: async (space, noteIds) => {
    await ctx.ensureInit()
    const ids = [...new Set(noteIds)]

    if (!ids.length) {
      return new Map()
    }
    // Keep the set in one bound value rather than one placeholder per id:
    // SQLite's host-variable ceiling is finite (32,766 in our runtime), while
    // the port deliberately accepts an unbounded set. json_each is already a
    // required capability of this driver and lets the revision index seek each id
    // without turning a wide category list into "too many SQL variables".
    const rows = ctx.required
      .prepare(
        `SELECT revisions.* FROM note_revisions AS revisions
           JOIN (
             SELECT note_id, MAX(id) AS id
             FROM note_revisions
             WHERE space = ? AND note_id IN (SELECT value FROM json_each(?)) AND ${TRUSTED_ONLY}
             GROUP BY note_id
           ) AS latest ON latest.id = revisions.id`,
      )
      .all(space, JSON.stringify(ids)) as RevisionRow[]
    return new Map(rows.map((row) => [row.note_id, revisionOfRow(row)]))
  },
  listTrashed: async (space, { offset, limit, q, availability }, excludeClasses = []) => {
    await ctx.ensureInit()
    const db = ctx.required
    // Drop hidden classes BEFORE the per-note collapse, so a hidden class can't
    // become the surviving newest row or skew the total; a null class is kept.
    const exFilter = classFilterSqlite(excludeClasses)
    const exArgs = [...excludeClasses]
    // Title search runs AFTER the collapse (title lives on the surviving tombstone
    // row); LIKE wildcards in the needle are escaped so a literal %/_ can't match-all.
    const needle = q?.trim().toLowerCase()
    const qFilter = needle ? " AND lower_u(title) LIKE ? ESCAPE '\\'" : ''
    const qArgs = needle ? [`%${needle.replace(/[\\%_]/g, (c) => '\\' + c)}%`] : []
    const restorableExpr = `CASE WHEN revisions.content_hash IS NOT NULL
      AND (
        revisions.state_format IS NULL
        OR revisions.state_format = '${LOGICAL_NOTE_STATE_FORMAT}'
        OR (
          revisions.state_format <> '${DOCUMENT_STATE_FORMAT.opaque}'
          AND revisions.restore_safety = 'safe'
        )
      ) THEN 1 ELSE 0 END`
    const availabilityFilter =
      availability === 'restorable'
        ? ` AND (${restorableExpr}) = 1`
        : availability === 'unavailable'
          ? ` AND (${restorableExpr}) = 0`
          : ''
    // Trash = notes whose newest revision is a delete-tombstone; a later
    // restore/save makes the newest a write, so the note drops out.
    // canon: docs/trash.md#model
    const items = (
      db
        .prepare(
          `SELECT * FROM (
               SELECT *, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
               FROM note_revisions WHERE space = ? AND ${TRUSTED_ONLY}${exFilter}
             ) AS revisions
            WHERE rn = 1 AND kind = 'delete'${qFilter}${availabilityFilter}
            ORDER BY id DESC LIMIT ? OFFSET ?`,
        )
        .all(space, ...exArgs, ...qArgs, limit, offset) as RevisionRow[]
    ).map(revisionOfRow)
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
               SELECT *, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
               FROM note_revisions WHERE space = ? AND ${TRUSTED_ONLY}${exFilter}
             ) AS revisions
            WHERE rn = 1 AND kind = 'delete'${qFilter}${availabilityFilter}`,
        )
        .get(space, ...exArgs, ...qArgs) as { n: number }
    ).n
    const restorableTotal = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
               SELECT *, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
               FROM note_revisions WHERE space = ? AND ${TRUSTED_ONLY}${exFilter}
             ) AS revisions
            WHERE rn = 1 AND kind = 'delete'
              AND (${restorableExpr}) = 1${qFilter}${availabilityFilter}`,
        )
        .get(space, ...exArgs, ...qArgs) as { n: number }
    ).n
    const partialTotal = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
               SELECT *, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
               FROM note_revisions WHERE space = ? AND ${TRUSTED_ONLY}${exFilter}
             ) AS revisions
            WHERE rn = 1 AND kind = 'delete'
              AND revisions.content_hash IS NOT NULL
              AND (revisions.state_format IS NULL
                   OR revisions.state_format = '${LOGICAL_NOTE_STATE_FORMAT}')${qFilter}${availabilityFilter}`,
        )
        .get(space, ...exArgs, ...qArgs) as { n: number }
    ).n
    return { items, total, restorableTotal, partialTotal }
  },
  purgeNotes: async (space, noteIds, expectedLatest) => {
    await ctx.ensureInit()
    if (!noteIds.length) {
      return []
    }
    const db = ctx.required
    const CHUNK = 400 // keep the IN-list well under SQLite's variable cap
    // Acquire the writer slot before comparing latest ids: another connection's
    // append may be before or after this transaction, never between compare/fence.
    db.exec('BEGIN IMMEDIATE')
    let ids: string[] = []

    try {
      const candidates = [...new Set(noteIds)]
      const latest = expectedLatest
        ? db.prepare('SELECT revision_id AS id FROM revision_heads WHERE space = ? AND note_id = ?')
        : null
      ids = expectedLatest
        ? candidates.filter((noteId) => {
            const expected = expectedLatest.get(noteId)
            const row = latest!.get(space, noteId) as { id: number | bigint } | undefined
            return expected !== undefined && row != null && String(row.id) === expected
          })
        : candidates
      const pinned = db.prepare(
        `SELECT 1
          FROM restore_operation_notes AS pins
           JOIN restore_operations AS operations ON operations.id = pins.operation_id
          WHERE pins.space = ? AND pins.note_id = ?
            AND operations.phase NOT IN ('succeeded', 'rejected')
          LIMIT 1`,
      )
      ids = ids.filter((noteId) => !pinned.get(space, noteId))
      // The fence is scoped exactly like the DELETE below it.
      // canon: docs/meta-db.md#source-of-truth
      const fenceNote = db.prepare(
        "INSERT OR IGNORE INTO revision_purge_fences (kind, entity_id, space) VALUES ('note', ?, ?)",
      )

      for (const noteId of ids) {
        fenceNote.run(noteId, space)
      }
      // Owner state of a package whose registry note is gone for good. The policy is
      // keyed by the package DIRECTORY, so the note that ends it is a SECOND key —
      // the directory is named by the id its manifest declared, and claim arbitration
      // can leave the note carrying a different one, which is why the preference
      // and policy rows both carry the registry identity. A row
      // whose writer did not know the note id keeps the pre-arbitration answer, and
      // only such a row: matching the package id for a row that HAS the key would
      // forget a live policy whose directory happens to be named like some other
      // purged note. canon: docs/meta-db.md#source-of-truth
      const purgedPolicy = `home_space = ?
          AND (registry_note_id = ?
               OR (registry_note_id IS NULL AND package_id = ?))`
      const deleteBindings = db.prepare(
        `DELETE FROM ability_project_bindings
          WHERE home_space = ?
            AND package_id IN (
              SELECT package_id FROM ability_availability WHERE ${purgedPolicy}
            )`,
      )
      const deleteAvailability = db.prepare(
        `DELETE FROM ability_availability WHERE ${purgedPolicy}`,
      )
      const deletePreferences = db.prepare(
        'DELETE FROM ability_preferences WHERE space_id = ? AND registry_note_id = ?',
      )

      for (const noteId of ids) {
        deleteBindings.run(space, space, noteId, noteId)
        deleteAvailability.run(space, noteId, noteId)
        deletePreferences.run(space, noteId)
      }
      const stillUsed = db.prepare('SELECT 1 FROM note_revisions WHERE content_hash = ? LIMIT 1')
      const dropBlob = db.prepare('DELETE FROM revision_blobs WHERE hash = ?')

      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK)
        const ph = batch.map(() => '?').join(',')
        const hashes = (
          db
            .prepare(
              `SELECT DISTINCT content_hash AS h FROM note_revisions WHERE space = ? AND note_id IN (${ph}) AND content_hash IS NOT NULL`,
            )
            .all(space, ...batch) as Array<{ h: string }>
        ).map((r) => r.h)
        db.prepare(`DELETE FROM revision_heads WHERE space = ? AND note_id IN (${ph})`).run(
          space,
          ...batch,
        )
        db.prepare(`DELETE FROM note_revisions WHERE space = ? AND note_id IN (${ph})`).run(
          space,
          ...batch,
        )
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

    return ids
  },
  latestTimestamps: async (space) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT note_id, created_at, MAX(id) FROM note_revisions WHERE space = ? AND ${TRUSTED_ONLY} GROUP BY note_id`,
      )
      .all(space) as Array<{ note_id: string; created_at: string }>
    return new Map(rows.map((r) => [r.note_id, r.created_at]))
  },
  historicalNames: async (space) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT DISTINCT note_id, title FROM note_revisions WHERE space = ? AND ${TRUSTED_ONLY} AND title <> ''`,
      )
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
      .get(contentHash) as { content: string | Uint8Array } | undefined
    const content = row?.content
    return content instanceof Uint8Array ? Uint8Array.from(content) : (content ?? null)
  },
  close: () => ctx.close(),
})
