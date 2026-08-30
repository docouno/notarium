import { type DatabaseSync } from 'node:sqlite'
import { type PoolClient } from 'pg'

export type CatalogColumn = {
  name: string
  type: string
  notNull: boolean
  defaultValue: string | null
  primaryKeyPosition: number
}

export type CatalogForeignKey = {
  columns: string[]
  referencedTable: string
  referencedColumns: string[]
  onUpdate: string
  onDelete: string
}

export type CatalogIndex = {
  name: string | null
  unique: boolean
  columns: Array<{ name: string; descending: boolean }>
  predicate: string | null
}

export type CatalogTable = {
  name: string
  columns: CatalogColumn[]
  checks: string[]
  foreignKeys: CatalogForeignKey[]
  indexes: CatalogIndex[]
}

export type MetaDbCatalog = { tables: CatalogTable[] }

const normalizeSql = (value: string): string => {
  let quoted = false
  let normalized = ''

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]

    if (char === "'") {
      normalized += char

      if (quoted && value[index + 1] === "'") {
        normalized += value[index + 1]
        index += 1
      } else {
        quoted = !quoted
      }
    } else {
      normalized += quoted ? char : char.toLowerCase()
    }
  }

  return normalized.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim()
}

const checksOf = (sql: string): string[] => {
  const checks: string[] = []
  const upper = sql.toUpperCase()
  let cursor = 0

  while (cursor < sql.length) {
    const checkAt = upper.indexOf('CHECK', cursor)

    if (checkAt === -1) {
      break
    }
    const openAt = sql.indexOf('(', checkAt + 5)

    if (openAt === -1) {
      break
    }
    let depth = 1
    let quoted = false
    let index = openAt + 1

    for (; index < sql.length && depth > 0; index += 1) {
      const char = sql[index]

      if (char === "'") {
        if (quoted && sql[index + 1] === "'") {
          index += 1
        } else {
          quoted = !quoted
        }
      } else if (!quoted && char === '(') {
        depth += 1
      } else if (!quoted && char === ')') {
        depth -= 1
      }
    }
    checks.push(normalizeSql(sql.slice(openAt + 1, index - 1)))
    cursor = index
  }

  return checks.sort()
}

const quoteSqliteName = (name: string): string => `"${name.replaceAll('"', '""')}"`

export const sqliteMetaDbCatalog = (db: DatabaseSync): MetaDbCatalog => {
  const tableRows = db
    .prepare(
      `SELECT name, sql
         FROM sqlite_schema
        WHERE type = 'table'
          AND name NOT IN ('sqlite_sequence')
        ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string }>

  return {
    tables: tableRows.map(({ name, sql }) => {
      const quoted = quoteSqliteName(name)
      const columns = db.prepare(`PRAGMA table_xinfo(${quoted})`).all() as Array<{
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }>
      const indexRows = db.prepare(`PRAGMA index_list(${quoted})`).all() as Array<{
        name: string
        unique: number
        origin: string
      }>
      const foreignKeyRows = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as Array<{
        id: number
        seq: number
        table: string
        from: string
        to: string
        on_update: string
        on_delete: string
      }>
      const foreignKeys = new Map<number, CatalogForeignKey>()

      for (const row of foreignKeyRows) {
        const current = foreignKeys.get(row.id) ?? {
          columns: [],
          referencedTable: row.table,
          referencedColumns: [],
          onUpdate: row.on_update.toLowerCase(),
          onDelete: row.on_delete.toLowerCase(),
        }
        current.columns[row.seq] = row.from
        current.referencedColumns[row.seq] = row.to
        foreignKeys.set(row.id, current)
      }

      return {
        name,
        columns: columns.map((column) => ({
          name: column.name,
          type: normalizeSql(column.type),
          notNull: column.notnull === 1,
          defaultValue: column.dflt_value == null ? null : normalizeSql(column.dflt_value),
          primaryKeyPosition: column.pk,
        })),
        checks: checksOf(sql),
        foreignKeys: [...foreignKeys.values()].sort((left, right) =>
          left.columns.join('\0').localeCompare(right.columns.join('\0')),
        ),
        indexes: indexRows
          .map((index): CatalogIndex => {
            const indexSql = db
              .prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?')
              .get('index', index.name) as { sql: string | null } | undefined
            const keyRows = db
              .prepare(`PRAGMA index_xinfo(${quoteSqliteName(index.name)})`)
              .all() as Array<{
              seqno: number
              name: string | null
              desc: number
              key: number
            }>
            const where = indexSql?.sql?.match(/\sWHERE\s([\s\S]+)$/i)?.[1]

            return {
              name: index.origin === 'c' ? index.name : null,
              unique: index.unique === 1,
              columns: keyRows
                .filter((row) => row.key === 1)
                .sort((left, right) => left.seqno - right.seqno)
                .map((row) => ({
                  name: row.name ?? '<expression>',
                  descending: row.desc === 1,
                })),
              predicate: where == null ? null : normalizeSql(where),
            }
          })
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      }
    }),
  }
}

export const pgMetaDbCatalog = async (
  client: PoolClient,
  schema: string,
): Promise<MetaDbCatalog> => {
  const tables = await client.query(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
    [schema],
  )
  const result: CatalogTable[] = []

  for (const { name } of tables.rows as Array<{ name: string }>) {
    const columns = await client.query(
      `SELECT a.attname AS name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS not_null,
                pg_get_expr(d.adbin, d.adrelid) AS default_value,
                COALESCE(array_position(i.indkey::smallint[], a.attnum), 0) AS primary_key_position
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
          WHERE n.nspname = $1 AND c.relname = $2
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
      [schema, name],
    )
    const constraints = await client.query(
      `SELECT con.contype AS type, pg_get_constraintdef(con.oid, true) AS definition
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2
            AND con.contype IN ('c', 'f', 'p', 'u')
          ORDER BY con.contype, definition`,
      [schema, name],
    )
    const indexes = await client.query(
      `SELECT i.indisunique AS unique, pg_get_indexdef(i.indexrelid) AS definition,
                con.oid IS NOT NULL AS constraint_owned
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
          WHERE n.nspname = $1 AND c.relname = $2
          ORDER BY definition`,
      [schema, name],
    )
    const constraintRows = constraints.rows as Array<{ type: string; definition: string }>

    result.push({
      name,
      columns: (
        columns.rows as Array<{
          name: string
          type: string
          not_null: boolean
          default_value: string | null
          primary_key_position: number | null
        }>
      ).map((column) => ({
        name: column.name,
        type: normalizeSql(column.type),
        notNull: column.not_null,
        defaultValue: column.default_value == null ? null : normalizeSql(column.default_value),
        primaryKeyPosition: Number(column.primary_key_position ?? 0),
      })),
      checks: constraintRows
        .filter((constraint) => constraint.type === 'c')
        .map((constraint) => normalizeSql(constraint.definition.replace(/^CHECK\s*\(|\)$/gi, '')))
        .sort(),
      foreignKeys: constraintRows
        .filter((constraint) => constraint.type === 'f')
        .map((constraint) => ({
          columns: [normalizeSql(constraint.definition)],
          referencedTable: '',
          referencedColumns: [],
          onUpdate: '',
          onDelete: '',
        })),
      indexes: (
        indexes.rows as Array<{
          unique: boolean
          definition: string
          constraint_owned: boolean
        }>
      )
        .map((index) => {
          const definition = normalizeSql(
            index.definition.replace(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+\S+\s+/i, ''),
          )
          const where = definition.match(/\swhere\s([\s\S]+)$/)?.[1]
          const keys = definition.match(/\(([^)]*)\)/)?.[1] ?? ''

          return {
            name: null,
            unique: index.unique,
            columns: keys.split(',').map((column) => ({
              name: normalizeSql(column.replace(/\s+desc$/i, '')),
              descending: /\s+desc$/i.test(column),
            })),
            predicate: where == null ? null : normalizeSql(where),
          }
        })
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    })
  }

  return { tables: result }
}

const tableOf = (catalog: MetaDbCatalog, name: string): CatalogTable => {
  const table = catalog.tables.find((candidate) => candidate.name === name)

  if (!table) {
    throw new Error(`golden catalog misses ${name}`)
  }

  return table
}

/** The tables the provider contour adds, which the pre-cut golden cannot contain by
 *  construction. The golden gate answers one question — did COMPACTING the published
 *  ladder change the schema it produced — and a table that did not exist before the
 *  cut is outside it. They are named here rather than described in catalog form: a
 *  second spelling of their DDL would have to be kept in step with the migrations by
 *  hand, while their shape is already held by the schema object counts, the meta-DB
 *  contract suites, the foreign-key assertion and the lock-order register. */
export const PROVIDER_CONTOUR_TABLES: readonly string[] = [
  'credentials',
  'provider_attachments',
  'provider_call_log',
  'provider_resources',
  'secret_keyring',
]

/** Splits a live catalog into the published line the golden describes and the names of
 *  the contour tables on top of it, so both halves are asserted rather than one. */
export const splitProviderContour = (
  live: MetaDbCatalog,
): { published: MetaDbCatalog; contour: string[] } => ({
  published: {
    tables: live.tables.filter((table) => !PROVIDER_CONTOUR_TABLES.includes(table.name)),
  },
  contour: live.tables
    .filter((table) => PROVIDER_CONTOUR_TABLES.includes(table.name))
    .map((table) => table.name)
    .sort(),
})

export const approvedTargetCatalog = (golden: MetaDbCatalog): MetaDbCatalog => {
  const target = structuredClone(golden)
  target.tables = target.tables.filter((table) => table.name !== 'mcp_bookmarks')

  const revisions = tableOf(target, 'note_revisions')
  revisions.columns = revisions.columns.filter(
    (column) => column.name !== 'snapshot_format' && column.name !== 'document_format',
  )
  const integrity = revisions.columns.find((column) => column.name === 'integrity')!
  const entryRole = revisions.columns.find((column) => column.name === 'entry_role')!
  integrity.defaultValue = null
  entryRole.defaultValue = null
  const semanticAt = revisions.columns.findIndex((column) => column.name === 'semantic_fingerprint')
  revisions.columns.splice(semanticAt, 0, {
    name: 'state_format',
    type: 'text',
    notNull: false,
    defaultValue: null,
    primaryKeyPosition: 0,
  })
  revisions.checks = revisions.checks.filter(
    (check) => !check.includes('snapshot_format') && !check.includes('document_format'),
  )
  const postgres = revisions.checks.some((check) => check.includes(' = any (array['))
  revisions.checks.push(
    postgres
      ? "integrity = any (array['trusted'::text, 'quarantined'::text])"
      : normalizeSql("integrity in ('trusted', 'quarantined')"),
    postgres
      ? "state_format is null or (state_format = any (array['markdown-v1'::text, 'markdown-v2'::text, 'skill-markdown-v1'::text, 'opaque-v1'::text]))"
      : normalizeSql(
          "state_format is null or state_format in ('markdown-v1', 'markdown-v2', 'skill-markdown-v1', 'opaque-v1')",
        ),
  )
  revisions.checks.sort()

  const placement = tableOf(target, 'ability_placement_trail')
  placement.columns.find((column) => column.name === 'registry_note_id')!.notNull = true
  placement.columns.find((column) => column.name === 'manifest_note_id')!.notNull = true
  placement.checks = placement.checks.filter(
    (check) => !check.includes('registry_note_id') && !check.includes('manifest_note_id'),
  )

  return target
}
