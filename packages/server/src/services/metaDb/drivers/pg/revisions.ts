import type { AuthorFilter, Revision, RevisionInput, RevisionPersistence } from '@notarium/core'

import type { PgDriverCtx } from './context'
import { lockRevisionKeys } from './revisionLocks'

type RevisionRow = {
  id: string | number
  note_id: string
  space: string
  base_rev: string | number | null
  their_rev: string | number | null
  source_rev: string | number | null
  kind: string
  principal: string | null
  content_hash: string | null
  title: string
  class: string | null
  slug: string | null
  tags: string
  created_at: string
  chars_added: string | number | null
  chars_removed: string | number | null
}

type RevisionDeltaRow = RevisionRow & {
  contract_max: string | number | null
  contract_total: string | number
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

/** Author-scope predicate as `$n` SQL, appending its binds to `params`.
 *  Usernames carry no LIKE wildcard, so prefix matches need no ESCAPE. */
const authorClausePg = (author: AuthorFilter | undefined, params: unknown[]): string => {
  if (!author) {
    return ''
  }
  const parts: string[] = []

  if (author.exact.length) {
    const ph = author.exact.map((v) => {
      params.push(v)
      return `$${params.length}`
    })
    parts.push(`principal IN (${ph.join(',')})`)
  }
  for (const p of author.prefixes) {
    params.push(`${p}%`)
    parts.push(`principal LIKE $${params.length}`)
  }

  return parts.length ? ` AND (${parts.join(' OR ')})` : ' AND false'
}

export const createRevisionsFacet = (ctx: PgDriverCtx): RevisionPersistence => ({
  init: () => ctx.ensureInit(),
  append: async (rev: RevisionInput, content: string | null) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      if (rev.contentHash != null && content != null) {
        // Lock-unaware writers upsert CAS bytes before their note INSERT reaches
        // the database trigger. Match that order before taking any advisory lock: two
        // generations sharing a previously-absent hash then serialize on the
        // unique tuple without forming tuple-lock ↔ advisory-lock deadlocks.
        await client.query(
          'INSERT INTO revision_blobs (hash, content) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING',
          [rev.contentHash, content],
        )
      }
      // Appends in one space may proceed concurrently; whole-space purge takes
      // the matching exclusive lock before enumerating notes and blobs.
      await lockRevisionKeys(client, 'space', [rev.space], 'shared')
      await lockRevisionKeys(client, 'note', [rev.noteId])
      if (rev.contentHash != null) {
        // Every CAS reference joins blob GC. Body-less tombstones take the same
        // lock even though they had no bytes to upsert above.
        await lockRevisionKeys(client, 'blob', [rev.contentHash])
        if (content != null) {
          // The pre-lock upsert may have been a no-op against a blob that a
          // competing purge removed while this append waited on note/blob
          // stripes. Reassert our retained bytes under the GC lock.
          await client.query(
            'INSERT INTO revision_blobs (hash, content) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING',
            [rev.contentHash, content],
          )
        }
      }
      const fence = await client.query(
        `SELECT kind FROM revision_purge_fences
          WHERE (kind = 'space' AND entity_id = $1)
             OR (kind = 'note' AND entity_id = $2)
          LIMIT 1`,
        [rev.space, rev.noteId],
      )

      if (fence.rows.length) {
        throw new Error(`revision target was permanently purged: ${fence.rows[0].kind}`)
      }
      const res = await client.query(
        `INSERT INTO note_revisions
             (note_id, space, base_rev, their_rev, source_rev, kind, principal, content_hash, title, class, slug, tags, created_at, chars_added, chars_removed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING id`,
        [
          rev.noteId,
          rev.space,
          rev.baseRevisionId,
          rev.theirRevisionId,
          rev.sourceRevisionId,
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
        ],
      )
      await client.query('COMMIT')
      return { ...rev, tags: [...rev.tags], id: String(res.rows[0].id) }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  listByNote: async (noteId, { offset, limit }) => {
    await ctx.ensureInit()
    const [rows, count] = await Promise.all([
      ctx.required.query(
        'SELECT * FROM note_revisions WHERE note_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3',
        [noteId, limit, offset],
      ),
      ctx.required.query('SELECT COUNT(*) AS n FROM note_revisions WHERE note_id = $1', [noteId]),
    ])
    return {
      items: (rows.rows as RevisionRow[]).map(revisionOfRow),
      total: Number(count.rows[0].n),
    }
  },
  listBySpaceSince: async (space, sinceRevId, limit, excludeClasses = []) => {
    await ctx.ensureInit()
    // Keep BIGSERIAL cursors as decimal strings. Converting through JS Number
    // loses precision above 2^53 and can replay an acknowledged revision.
    const since = sinceRevId ?? '0'
    // Class filter runs in-SQL so window, distinct total and max id stay post-filter and consistent.
    const exParams = excludeClasses.map((_, i) => `$${i + 3}`)
    const exFilter = exParams.length
      ? ` AND (class IS NULL OR class NOT IN (${exParams.join(',')}))`
      : ''
    // One statement = one MVCC snapshot for page, total, and bookmark cursor.
    // The aggregate is the left side so even LIMIT 0 / an empty window returns
    // one metadata row; a null page.id is filtered before row conversion.
    const result = await ctx.required.query(
      `WITH filtered AS MATERIALIZED (
         SELECT * FROM note_revisions WHERE space = $1 AND id > $2${exFilter}
       ),
       collapsed AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
         FROM filtered
       ),
       page AS (
         SELECT * FROM collapsed WHERE rn = 1
         ORDER BY id DESC LIMIT $${excludeClasses.length + 3}
       ),
       aggregate AS (
         SELECT COUNT(DISTINCT note_id) AS n, MAX(id) AS m FROM filtered
       )
       SELECT page.*, aggregate.n AS contract_total, aggregate.m AS contract_max
       FROM aggregate LEFT JOIN page ON TRUE
       ORDER BY page.id DESC`,
      [space, since, ...excludeClasses, limit],
    )
    const rows = result.rows as RevisionDeltaRow[]
    const aggregate = rows[0]

    return {
      items: rows.filter((row) => row.id != null).map(revisionOfRow),
      total: Number(aggregate.contract_total),
      maxRevId: aggregate.contract_max == null ? null : String(aggregate.contract_max),
    }
  },
  activityByDay: async (space, { from, to, tzOffsetMinutes, excludeClasses = [], author }) => {
    await ctx.ensureInit()
    // created_at is ISO TEXT (cast ::timestamptz).
    // Exclude the synthetic pre-edit baseline (external + base_rev NULL) so a first edit isn't double-counted.
    const params: unknown[] = [tzOffsetMinutes, space, from, to]
    const exFilter = excludeClasses.length
      ? ` AND (class IS NULL OR class NOT IN (${excludeClasses
          .map((c) => {
            params.push(c)
            return `$${params.length}`
          })
          .join(',')}))`
      : ''
    const auFilter = authorClausePg(author, params)
    const res = await ctx.required.query(
      `SELECT to_char((created_at::timestamptz AT TIME ZONE 'UTC') + make_interval(mins => $1), 'YYYY-MM-DD') AS day,
                SUM(CASE WHEN kind = 'delete' THEN 1 ELSE 0 END) AS deleted,
                SUM(CASE WHEN kind <> 'delete' AND base_rev IS NULL THEN 1 ELSE 0 END) AS created,
                SUM(CASE WHEN kind <> 'delete' AND base_rev IS NOT NULL THEN 1 ELSE 0 END) AS edited
           FROM note_revisions
          WHERE space = $2 AND created_at >= $3 AND created_at < $4
            AND NOT (kind = 'external' AND base_rev IS NULL)${exFilter}${auFilter}
          GROUP BY 1 ORDER BY 1 ASC`,
      params,
    )
    return (
      res.rows as Array<{ day: string; created: string; edited: string; deleted: string }>
    ).map((r) => ({
      date: r.day,
      created: Number(r.created),
      edited: Number(r.edited),
      deleted: Number(r.deleted),
    }))
  },
  activityEvents: async (space, { from, to, offset, limit, excludeClasses = [], author }) => {
    await ctx.ensureInit()
    const where = ['space = $1', "NOT (kind = 'external' AND base_rev IS NULL)"]
    const params: unknown[] = [space]

    if (from != null) {
      params.push(from)
      where.push(`created_at >= $${params.length}`)
    }
    if (to != null) {
      params.push(to)
      where.push(`created_at < $${params.length}`)
    }
    if (excludeClasses.length) {
      const exParams = excludeClasses.map((c) => {
        params.push(c)
        return `$${params.length}`
      })
      where.push(`(class IS NULL OR class NOT IN (${exParams.join(',')}))`)
    }
    if (author) {
      // authorClausePg yields a leading ' AND '; strip it (this list is AND-joined), and push its
      // binds BEFORE the totalParams snapshot below so window + COUNT queries share identical binds.
      where.push(authorClausePg(author, params).replace(/^ AND /, ''))
    }
    const whereSql = where.join(' AND ')
    const totalParams = [...params]
    params.push(limit)
    const limitParam = `$${params.length}`
    params.push(offset)
    const offsetParam = `$${params.length}`
    const [rows, agg] = await Promise.all([
      ctx.required.query(
        `SELECT * FROM note_revisions WHERE ${whereSql} ORDER BY id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params,
      ),
      ctx.required.query(`SELECT COUNT(*) AS n FROM note_revisions WHERE ${whereSql}`, totalParams),
    ])
    return {
      items: (rows.rows as RevisionRow[]).map(revisionOfRow),
      total: Number((agg.rows[0] as { n: string | number }).n),
    }
  },
  activityByNote: async (space, { from, to, excludeClasses = [] }) => {
    await ctx.ensureInit()
    const params: unknown[] = [space, from, to]
    const exFilter = excludeClasses.length
      ? ` AND (class IS NULL OR class NOT IN (${excludeClasses
          .map((c) => {
            params.push(c)
            return `$${params.length}`
          })
          .join(',')}))`
      : ''
    const res = await ctx.required.query(
      `SELECT note_id, COUNT(*) AS n, MAX(created_at) AS last
           FROM note_revisions
          WHERE space = $1 AND created_at >= $2 AND created_at < $3
            AND NOT (kind = 'external' AND base_rev IS NULL)${exFilter}
          GROUP BY note_id`,
      params,
    )
    return (res.rows as Array<{ note_id: string; n: string | number; last: string }>).map((r) => ({
      noteId: r.note_id,
      count: Number(r.n),
      lastAt: r.last,
    }))
  },
  get: async (revisionId) => {
    await ctx.ensureInit()
    if (!/^\d+$/.test(revisionId)) {
      return null
    }
    const res = await ctx.required.query('SELECT * FROM note_revisions WHERE id = $1', [revisionId])
    return res.rows[0] ? revisionOfRow(res.rows[0] as RevisionRow) : null
  },
  latestFor: async (noteId) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT * FROM note_revisions WHERE note_id = $1 ORDER BY id DESC LIMIT 1',
      [noteId],
    )
    return res.rows[0] ? revisionOfRow(res.rows[0] as RevisionRow) : null
  },
  latestForMany: async (noteIds) => {
    await ctx.ensureInit()
    const ids = [...new Set(noteIds)]

    if (!ids.length) {
      return new Map()
    }
    const result = await ctx.required.query(
      `SELECT DISTINCT ON (note_id) *
         FROM note_revisions
        WHERE note_id = ANY($1::text[])
        ORDER BY note_id, id DESC`,
      [ids],
    )
    const revisions = (result.rows as RevisionRow[]).map(revisionOfRow)
    return new Map(revisions.map((revision) => [revision.noteId, revision]))
  },
  listTrashed: async (space, { offset, limit, q }, excludeClasses = []) => {
    await ctx.ensureInit()
    // Class filter runs BEFORE the per-note collapse (inside the subquery); title search AFTER it.
    const params: unknown[] = [space]
    const exParams = excludeClasses.map((c) => {
      params.push(c)
      return `$${params.length}`
    })
    const exFilter = exParams.length
      ? ` AND (class IS NULL OR class NOT IN (${exParams.join(',')}))`
      : ''
    const needle = q?.trim().toLowerCase()
    let qFilter = ''

    if (needle) {
      params.push(`%${needle.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
      qFilter = ` AND LOWER(title) LIKE $${params.length} ESCAPE '\\'`
    }
    const totalParams = [...params] // window + total share everything but limit/offset
    params.push(limit)
    const limitParam = `$${params.length}`
    params.push(offset)
    const offsetParam = `$${params.length}`
    const [rows, agg, restAgg] = await Promise.all([
      ctx.required.query(
        `SELECT * FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
             FROM note_revisions WHERE space = $1${exFilter}
           ) t WHERE rn = 1 AND kind = 'delete'${qFilter} ORDER BY id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params,
      ),
      ctx.required.query(
        `SELECT COUNT(*) AS n FROM (
             SELECT note_id, kind, title, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
             FROM note_revisions WHERE space = $1${exFilter}
           ) t WHERE rn = 1 AND kind = 'delete'${qFilter}`,
        totalParams,
      ),
      ctx.required.query(
        `SELECT COUNT(*) AS n FROM (
             SELECT note_id, kind, title, content_hash, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
             FROM note_revisions WHERE space = $1${exFilter}
           ) t WHERE rn = 1 AND kind = 'delete' AND content_hash IS NOT NULL${qFilter}`,
        totalParams,
      ),
    ])
    return {
      items: (rows.rows as RevisionRow[]).map(revisionOfRow),
      total: Number((agg.rows[0] as { n: string | number }).n),
      restorableTotal: Number((restAgg.rows[0] as { n: string | number }).n),
    }
  },
  purgeNotes: async (noteIds) => {
    await ctx.ensureInit()
    if (!noteIds.length) {
      return
    }
    const ids = [...noteIds]
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('notarium.revision_purge_protocol', 'v26', true)")
      // Serialize cross-replica appends and purges for the same notes first,
      // then their shared CAS hashes. Sorted acquisition keeps overlapping
      // batch purges deadlock-free.
      await lockRevisionKeys(client, 'note', ids)
      await client.query(
        `INSERT INTO revision_purge_fences (kind, entity_id)
         SELECT 'note', value FROM unnest($1::text[]) AS input(value)
         ON CONFLICT (kind, entity_id) DO NOTHING`,
        [ids],
      )
      // pg arrays take any list size in one param — no chunking needed.
      const hashesRes = await client.query(
        'SELECT DISTINCT content_hash AS h FROM note_revisions WHERE note_id = ANY($1) AND content_hash IS NOT NULL',
        [ids],
      )
      const hashes = (hashesRes.rows as Array<{ h: string }>).map(({ h }) => h).sort()

      await lockRevisionKeys(client, 'blob', hashes)
      await client.query('DELETE FROM note_revisions WHERE note_id = ANY($1)', [ids])
      // GC each blob whose last referrer just went away (the CAS is shared).
      for (const h of hashes) {
        const used = await client.query(
          'SELECT 1 FROM note_revisions WHERE content_hash = $1 LIMIT 1',
          [h],
        )

        if (!used.rows.length) {
          await client.query('DELETE FROM revision_blobs WHERE hash = $1', [h])
        }
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  latestTimestamps: async (space) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT DISTINCT ON (note_id) note_id, created_at FROM note_revisions WHERE space = $1 ORDER BY note_id, id DESC',
      [space],
    )
    const rows = res.rows as Array<{ note_id: string; created_at: string }>
    return new Map(rows.map((r) => [r.note_id, r.created_at]))
  },
  historicalNames: async (space) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      "SELECT DISTINCT note_id, title FROM note_revisions WHERE space = $1 AND title <> ''",
      [space],
    )
    const rows = res.rows as Array<{ note_id: string; title: string }>
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
    const res = await ctx.required.query('SELECT content FROM revision_blobs WHERE hash = $1', [
      contentHash,
    ])
    return res.rows[0]?.content ?? null
  },
  close: () => ctx.close(),
})
