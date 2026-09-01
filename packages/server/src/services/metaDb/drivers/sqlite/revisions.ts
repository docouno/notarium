import {
  type ActivityLastEvent,
  type ActivityNoteGroupCount,
  type ActivityProjectionLease,
  AGENT_SESSION_ATTACH,
  type AuthorFilter,
  DOCUMENT_STATE_FORMAT,
  LOGICAL_NOTE_STATE_FORMAT,
  type Revision,
  REVISION_INTEGRITY,
  REVISION_UNAVAILABLE_REASON,
  REVISION_UNAVAILABLE_TITLE,
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
import {
  maintainSqliteActivityProjection,
  maintainSqliteActivityProjectionGc,
  prepareSqliteActivityProjection,
  sqliteActivityProjectionLease,
} from './activityProjection'
import { readSqliteBigInts, type SqliteDriverCtx } from './context'

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

type ActivityGroupRow = RevisionRow & {
  group_count: number | bigint
  chars_added_sum: number | bigint
  chars_removed_sum: number | bigint
  chars_added_known: number | bigint
  chars_removed_known: number | bigint
  contract_through: number | bigint | null
  contract_has_other: number | bigint | null
  last_source_ordinal?: number | bigint
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

const activityLastOfRow = (row: RevisionRow): ActivityLastEvent =>
  row.integrity === REVISION_INTEGRITY.quarantined
    ? {
        id: String(row.id),
        noteId: row.note_id,
        kind: row.kind as Revision['kind'],
        entryRole: row.entry_role as Revision['entryRole'],
        principal: null,
        title: REVISION_UNAVAILABLE_TITLE,
        createdAt: row.created_at,
        charsAdded: null,
        charsRemoved: null,
        unavailableReason: REVISION_UNAVAILABLE_REASON.identityConflict,
      }
    : {
        id: String(row.id),
        noteId: row.note_id,
        kind: row.kind as Revision['kind'],
        entryRole: row.entry_role as Revision['entryRole'],
        principal: row.principal,
        title: row.title,
        createdAt: row.created_at,
        charsAdded: row.chars_added == null ? null : Number(row.chars_added),
        charsRemoved: row.chars_removed == null ? null : Number(row.chars_removed),
      }

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

const otherAuthorSqlite = (viewer: AuthorFilter, params: string[]): string => {
  const parts: string[] = []

  if (viewer.exact.length) {
    parts.push(`principal IN (${viewer.exact.map(() => '?').join(',')})`)
    // The principal vocabulary has a fixed handful of viewer aliases.
    // eslint-disable-next-line no-restricted-syntax
    params.push(...viewer.exact)
  }
  for (const prefix of viewer.prefixes) {
    parts.push('principal LIKE ?')
    params.push(`${prefix}%`)
  }

  return `${TRUSTED_ONLY} AND NOT COALESCE((${parts.length ? parts.join(' OR ') : 'FALSE'}), FALSE)`
}

const projectionActorMatchSqlite = (
  author: AuthorFilter,
  params: string[],
  alias = 'states',
): string => {
  const parts: string[] = []

  if (author.exact.length) {
    parts.push(`${alias}.actor_key IN (${author.exact.map(() => '?').join(',')})`)
    // The viewer owns a fixed handful of principal aliases.
    // eslint-disable-next-line no-restricted-syntax
    params.push(...author.exact)
  }
  for (const prefix of author.prefixes) {
    parts.push(`${alias}.actor_key LIKE ?`)
    params.push(`${prefix}%`)
  }

  return parts.length ? parts.join(' OR ') : 'FALSE'
}

const activityEventsFromProjection = (
  ctx: SqliteDriverCtx,
  space: string,
  opts: {
    from?: string
    to?: string
    offset: number
    limit: number
    excludeClasses: readonly string[]
    author?: AuthorFilter
    viewerAuthor?: AuthorFilter
    noteId?: string
    activityLease?: ActivityProjectionLease
    afterId?: string
  },
) => {
  const db = ctx.required
  db.exec('BEGIN')

  try {
    const lease = sqliteActivityProjectionLease(ctx, space, opts.activityLease)

    if (lease.through == null) {
      db.exec('COMMIT')
      return {
        items: [],
        total: 0,
        through: null,
        nextAfterId: null,
        activityLease: lease,
        ...(opts.viewerAuthor ? { hasOtherAuthors: false } : {}),
      }
    }
    const where = [notSyntheticBaselineClause]
    const params: Array<string | number> = [space, lease.through, lease.through]

    if (opts.from != null) {
      where.push('revisions.created_at >= ?')
      params.push(opts.from)
    }
    if (opts.to != null) {
      where.push('revisions.created_at < ?')
      params.push(opts.to)
    }
    if (opts.noteId != null) {
      where.push('revisions.note_id = ?')
      params.push(opts.noteId)
    }
    if (opts.excludeClasses.length) {
      where.push(classFilterSqlite(opts.excludeClasses).replace(/^ AND /, ''))
      // The class registry is a fixed enum, not a corpus-sized input.
      // eslint-disable-next-line no-restricted-syntax
      params.push(...opts.excludeClasses)
    }
    if (opts.author) {
      const clause = authorClauseSqlite(opts.author)
      where.push(clause.clause.replace(/^ AND /, ''))
      // The principal vocabulary has a fixed handful of viewer aliases.
      // eslint-disable-next-line no-restricted-syntax
      params.push(...clause.params)
    }
    const gateParams: string[] = []
    const gate = opts.viewerAuthor
      ? `MAX(CASE WHEN ${otherAuthorSqlite(opts.viewerAuthor, gateParams)} THEN 1 ELSE 0 END)`
      : 'NULL'
    // Gate binds occur in aggregate, before the page binds below.
    // eslint-disable-next-line no-restricted-syntax
    params.push(...gateParams)
    const pageWhere: string[] = []

    if (opts.afterId != null) {
      pageWhere.push('id < ?')
      params.push(opts.afterId)
    }
    params.push(opts.limit + 1, opts.afterId == null ? opts.offset : 0)
    const rows = readSqliteBigInts(
      db.prepare(
        `WITH ordered AS (
           SELECT revisions.*, COALESCE(ordered.source_ordinal, revisions.id) AS source_ordinal
             FROM note_revisions AS revisions
             JOIN activity_projection_status AS status ON status.space = revisions.space
             LEFT JOIN activity_revision_order AS ordered ON ordered.revision_id = revisions.id
            WHERE revisions.space = ?
              AND (
                (ordered.source_ordinal IS NOT NULL AND ordered.source_ordinal <= ?)
                OR (ordered.source_ordinal IS NULL
                    AND revisions.id <= status.legacy_through_revision_id
                    AND revisions.id <= ?)
              )
         ),
         filtered AS (
           SELECT revisions.* FROM ordered AS revisions WHERE ${where.join(' AND ')}
         ),
         aggregate AS (
           SELECT COUNT(*) AS contract_total, ${gate} AS contract_has_other FROM filtered
         ),
         page AS (
           SELECT * FROM filtered
            ${pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : ''}
            ORDER BY id DESC LIMIT ? OFFSET ?
         )
         SELECT page.*, aggregate.contract_total, aggregate.contract_has_other
           FROM aggregate LEFT JOIN page ON TRUE ORDER BY page.id DESC`,
      ),
    ).all(...params) as Array<
      RevisionRow & {
        id: number | bigint | null
        contract_total: number | bigint
        contract_has_other: number | bigint | null
      }
    >
    const meta = rows[0]
    const page = rows.filter((row): row is typeof row & RevisionRow => row.id != null)
    const items = page.slice(0, opts.limit)

    db.exec('COMMIT')
    return {
      items: items.map(revisionOfRow),
      total: Number(meta?.contract_total ?? 0),
      through: lease.through,
      nextAfterId: page.length > opts.limit ? String(items.at(-1)!.id) : null,
      activityLease: lease,
      ...(opts.viewerAuthor ? { hasOtherAuthors: Number(meta?.contract_has_other) === 1 } : {}),
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export const createRevisionsFacet = (ctx: SqliteDriverCtx): RevisionPersistence => ({
  init: () => ctx.ensureInit(),
  prepareActivityProjection: (space) => prepareSqliteActivityProjection(ctx, space),
  maintainActivityProjection: async (space) => {
    await ctx.ensureInit()
    const worker = ctx.activityWorker?.()

    return worker
      ? worker.maintainActivityProjection(space)
      : maintainSqliteActivityProjection(ctx, space)
  },
  maintainActivityProjectionGc: async (space) => {
    await ctx.ensureInit()
    const worker = ctx.activityWorker?.()

    return worker
      ? worker.maintainActivityProjectionGc(space)
      : maintainSqliteActivityProjectionGc(ctx, space)
  },
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
               (note_id, space, base_rev, their_rev, source_rev, kind, entry_role, principal, agent_owner, agent_name, session_id, session_name, session_attach, agent_call_id, content_hash, semantic_fingerprint, restore_safety, state_format, title, class, slug, tags, created_at, chars_added, chars_removed, integrity)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          rev.agent?.agentCallId ?? null,
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
  activityEvents: async (
    space,
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
    },
  ) => {
    await ctx.ensureInit()
    const needsProjection = noteId != null || (from == null && to == null)
    const worker = from == null && to == null && noteId == null ? ctx.activityWorker?.() : null

    if (worker) {
      return worker.activityEvents(space, {
        from,
        to,
        offset,
        limit,
        excludeClasses,
        author,
        viewerAuthor,
        noteId,
        through,
        activityLease,
        afterId,
      })
    }

    if (needsProjection) {
      return activityEventsFromProjection(ctx, space, {
        from,
        to,
        offset,
        limit,
        excludeClasses,
        author,
        viewerAuthor,
        noteId,
        activityLease,
        afterId,
      })
    }
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
    if (noteId != null) {
      where.push('note_id = ?')
      args.push(noteId)
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
    const aggregateWhere = through == null ? whereSql : `${whereSql} AND id <= ?`
    const aggregateArgs = through == null ? [...args] : [...args, through]
    const gateParams: string[] = []
    const gate = viewerAuthor
      ? `MAX(CASE WHEN ${otherAuthorSqlite(viewerAuthor, gateParams)} THEN 1 ELSE 0 END)`
      : 'NULL'
    const aggregate = readSqliteBigInts(
      db.prepare(
        `SELECT COUNT(*) AS n, MAX(id) AS max_id, ${gate} AS has_other
           FROM note_revisions WHERE ${aggregateWhere}`,
      ),
    ).get(...gateParams, ...aggregateArgs) as {
      n: number | bigint
      max_id: number | bigint | null
      has_other: number | bigint | null
    }
    const resolvedThrough = through ?? (aggregate.max_id == null ? null : String(aggregate.max_id))

    if (resolvedThrough == null) {
      return {
        items: [],
        total: 0,
        through: null,
        nextAfterId: null,
        ...(viewerAuthor ? { hasOtherAuthors: false } : {}),
      }
    }
    const pageWhere = [`${whereSql}`, 'id <= ?']
    const pageArgs: Array<string | number> = [...args, resolvedThrough]

    if (afterId != null) {
      pageWhere.push('id < ?')
      pageArgs.push(afterId)
    }
    const rows = readSqliteBigInts(
      db.prepare(
        `SELECT * FROM note_revisions WHERE ${pageWhere.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ),
    ).all(...pageArgs, limit + 1, afterId == null ? offset : 0) as RevisionRow[]
    const page = rows.slice(0, limit)

    return {
      items: page.map(revisionOfRow),
      total: Number(aggregate.n),
      through: resolvedThrough,
      nextAfterId: rows.length > limit ? String(page.at(-1)!.id) : null,
      ...(viewerAuthor ? { hasOtherAuthors: Number(aggregate.has_other) === 1 } : {}),
    }
  },
  activityGroupsByNote: async (
    space,
    { from, to, excludeClasses = [], author, viewerAuthor, activityLease },
  ) => {
    await ctx.ensureInit()
    const worker = from == null && to == null ? ctx.activityWorker?.() : null

    if (worker) {
      return worker.activityGroupsByNote(space, {
        from,
        to,
        excludeClasses,
        author,
        viewerAuthor,
        activityLease,
      })
    }
    const db = ctx.required
    db.exec('BEGIN')

    try {
      const lease = sqliteActivityProjectionLease(ctx, space, activityLease)

      if (lease.through == null) {
        db.exec('COMMIT')
        return {
          items: [],
          through: null,
          activityLease: lease,
          ...(viewerAuthor ? { hasOtherAuthors: false } : {}),
        }
      }
      let rows: Array<ActivityGroupRow & { id: number | bigint | null }>

      if (from != null || to != null) {
        const where = [notSyntheticBaselineClause]
        const params: Array<string | null> = [space, lease.through, lease.through]

        if (from != null) {
          where.push('revisions.created_at >= ?')
          params.push(from)
        }
        if (to != null) {
          where.push('revisions.created_at < ?')
          params.push(to)
        }
        if (excludeClasses.length) {
          where.push(classFilterSqlite(excludeClasses).replace(/^ AND /, ''))
          // The class registry is a fixed enum, not a corpus-sized input.
          // eslint-disable-next-line no-restricted-syntax
          params.push(...excludeClasses)
        }
        if (author) {
          const clause = authorClauseSqlite(author)
          where.push(clause.clause.replace(/^ AND /, ''))
          // The principal vocabulary has a fixed handful of viewer aliases.
          // eslint-disable-next-line no-restricted-syntax
          params.push(...clause.params)
        }
        const gateParams: string[] = []
        const gate = viewerAuthor
          ? `MAX(CASE WHEN ${otherAuthorSqlite(viewerAuthor, gateParams)} THEN 1 ELSE 0 END)`
          : 'MAX(NULL)'

        rows = readSqliteBigInts(
          db.prepare(
            `WITH ordered AS (
               SELECT revisions.*, COALESCE(ordered.source_ordinal, revisions.id) AS source_ordinal
                 FROM note_revisions AS revisions
                 JOIN activity_projection_status AS status ON status.space = revisions.space
                 LEFT JOIN activity_revision_order AS ordered ON ordered.revision_id = revisions.id
                WHERE revisions.space = ?
                  AND (
                    (ordered.source_ordinal IS NOT NULL AND ordered.source_ordinal <= ?)
                    OR (ordered.source_ordinal IS NULL
                        AND revisions.id <= status.legacy_through_revision_id
                        AND revisions.id <= ?)
                  )
                  AND ${where.join(' AND ')}
             ),
             grouped AS (
               SELECT note_id,
                      MAX(source_ordinal) AS last_source_ordinal,
                      COUNT(*) AS group_count,
                      SUM(CASE WHEN ${TRUSTED_ONLY} AND chars_added IS NOT NULL THEN chars_added ELSE 0 END)
                        AS chars_added_sum,
                      SUM(CASE WHEN ${TRUSTED_ONLY} AND chars_removed IS NOT NULL THEN chars_removed ELSE 0 END)
                        AS chars_removed_sum,
                      MAX(CASE WHEN ${TRUSTED_ONLY} AND chars_added IS NOT NULL THEN 1 ELSE 0 END)
                        AS chars_added_known,
                      MAX(CASE WHEN ${TRUSTED_ONLY} AND chars_removed IS NOT NULL THEN 1 ELSE 0 END)
                        AS chars_removed_known,
                      ${gate} AS group_has_other
                 FROM ordered GROUP BY note_id
             ),
             meta AS (
               SELECT MAX(group_has_other) AS contract_has_other FROM grouped
             )
             SELECT latest.*,
                    grouped.group_count,
                    grouped.chars_added_sum,
                    grouped.chars_removed_sum,
                    grouped.chars_added_known,
                    grouped.chars_removed_known,
                    grouped.last_source_ordinal,
                    ? AS contract_through,
                    meta.contract_has_other
               FROM meta
               LEFT JOIN grouped ON TRUE
               LEFT JOIN ordered AS latest
                 ON latest.note_id = grouped.note_id
                AND latest.source_ordinal = grouped.last_source_ordinal
              ORDER BY grouped.last_source_ordinal DESC`,
          ),
        ).all(...params, ...gateParams, lease.through) as Array<
          ActivityGroupRow & { id: number | bigint | null }
        >
      } else {
        const status = readSqliteBigInts(
          db.prepare('SELECT active_generation FROM activity_projection_status WHERE space = ?'),
        ).get(space) as { active_generation: number | bigint }
        const stateParams: Array<string | number> = activityLease
          ? [lease.through, space, String(status.active_generation)]
          : [space, String(status.active_generation)]
        const stateJoin = activityLease
          ? `states.source_ordinal = (
               SELECT MAX(seek.source_ordinal)
                 FROM activity_note_actor_states AS seek
                WHERE seek.space = heads.space
                  AND seek.generation = heads.generation
                  AND seek.note_id = heads.note_id
                  AND seek.actor_kind = heads.actor_kind
                  AND seek.actor_key = heads.actor_key
                  AND seek.class_key = heads.class_key
                  AND seek.source_ordinal <= ?
             )`
          : 'states.source_ordinal = heads.source_ordinal'

        const classParams: string[] = []
        const classClause = excludeClasses.length
          ? `AND (states.actor_kind = 'gap' OR states.class_key NOT IN (${excludeClasses
              .map(() => '?')
              .join(',')}))`
          : ''
        // The class registry is a fixed enum, not a corpus-sized input.
        // eslint-disable-next-line no-restricted-syntax
        classParams.push(...excludeClasses)
        const authorParams: string[] = []
        const authorClause = author
          ? `WHERE visible.actor_kind = 'principal' AND (${projectionActorMatchSqlite(
              author,
              authorParams,
              'visible',
            )})`
          : ''
        const gateParams: string[] = []
        const gate = viewerAuthor
          ? `MAX(CASE
               WHEN visible.actor_kind = 'external' THEN 1
               WHEN visible.actor_kind = 'principal'
                AND NOT (${projectionActorMatchSqlite(viewerAuthor, gateParams, 'visible')}) THEN 1
               ELSE 0
             END)`
          : 'MAX(NULL)'

        rows = readSqliteBigInts(
          db.prepare(
            `WITH bucket_states AS (
               SELECT states.*
                 FROM activity_note_actor_heads AS heads
                 JOIN activity_note_actor_states AS states
                   ON states.space = heads.space
                  AND states.generation = heads.generation
                  AND ${stateJoin}
                WHERE heads.space = ? AND heads.generation = ?
             ),
             visible AS (
               SELECT states.* FROM bucket_states AS states WHERE TRUE ${classClause}
             ),
             selected AS (
               SELECT visible.* FROM visible ${authorClause}
             ),
             ranked AS (
               SELECT selected.*,
                      ROW_NUMBER() OVER (
                        PARTITION BY note_id ORDER BY source_ordinal DESC
                      ) AS note_rank
                 FROM selected
             ),
             grouped AS (
               SELECT note_id,
                      MAX(source_ordinal) AS last_source_ordinal,
                      MAX(CASE WHEN note_rank = 1 THEN revision_id END) AS last_revision_id,
                      SUM(event_count) AS group_count,
                      SUM(chars_added_sum) AS chars_added_sum,
                      SUM(chars_added_known) AS chars_added_known,
                      SUM(chars_removed_sum) AS chars_removed_sum,
                      SUM(chars_removed_known) AS chars_removed_known
                 FROM ranked GROUP BY note_id
             ),
             meta AS (
               SELECT ${gate} AS contract_has_other FROM visible
             )
             SELECT revisions.*,
                    grouped.group_count,
                    grouped.chars_added_sum,
                    grouped.chars_removed_sum,
                    grouped.chars_added_known,
                    grouped.chars_removed_known,
                    grouped.last_source_ordinal,
                    ? AS contract_through,
                    meta.contract_has_other
               FROM meta
               LEFT JOIN grouped ON TRUE
               LEFT JOIN note_revisions AS revisions ON revisions.id = grouped.last_revision_id
              ORDER BY grouped.last_source_ordinal DESC`,
          ),
        ).all(
          ...stateParams,
          ...classParams,
          ...authorParams,
          ...gateParams,
          lease.through,
        ) as Array<ActivityGroupRow & { id: number | bigint | null }>
      }
      const meta = rows[0]
      const items: ActivityNoteGroupCount[] = rows
        .filter((row): row is ActivityGroupRow => row.id != null)
        .map((row) => ({
          noteId: row.note_id,
          count: String(row.group_count),
          charsAdded: Number(row.chars_added_known) > 0 ? String(row.chars_added_sum) : null,
          charsRemoved: Number(row.chars_removed_known) > 0 ? String(row.chars_removed_sum) : null,
          lastSourceOrdinal: String(row.last_source_ordinal),
          lastEvent: activityLastOfRow(row),
        }))

      db.exec('COMMIT')
      return {
        items,
        through: lease.through,
        activityLease: lease,
        ...(viewerAuthor ? { hasOtherAuthors: Number(meta?.contract_has_other) === 1 } : {}),
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
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
