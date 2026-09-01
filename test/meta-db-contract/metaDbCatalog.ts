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

const indexKeysOf = (definition: string): string[] => {
  const openAt = definition.indexOf('(')

  if (openAt === -1) {
    return []
  }
  const keys: string[] = []
  let start = openAt + 1
  let depth = 1
  let quoted = false

  for (let index = start; index < definition.length; index += 1) {
    const char = definition[index]

    if (char === "'") {
      if (quoted && definition[index + 1] === "'") {
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (!quoted && char === '(') {
      depth += 1
    } else if (!quoted && char === ')') {
      depth -= 1

      if (depth === 0) {
        keys.push(definition.slice(start, index).trim())
        break
      }
    } else if (!quoted && char === ',' && depth === 1) {
      keys.push(definition.slice(start, index).trim())
      start = index + 1
    }
  }

  return keys.filter(Boolean)
}

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
          const keys = indexKeysOf(definition)

          return {
            name: null,
            unique: index.unique,
            columns: keys.map((column) => ({
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

const activityProjectionTables = (postgres: boolean): CatalogTable[] => {
  const integer = postgres ? 'bigint' : 'integer'
  const column = (
    name: string,
    type = 'text',
    notNull = true,
    primaryKeyPosition = 0,
  ): CatalogColumn => ({ name, type, notNull, defaultValue: null, primaryKeyPosition })
  const index = (columns: string[], unique: boolean, name: string | null = null): CatalogIndex => ({
    name: postgres ? null : name,
    unique,
    columns: columns.map((columnName) => ({ name: columnName, descending: false })),
    predicate: null,
  })
  const actorCheck = postgres
    ? "actor_kind = any (array['principal'::text, 'external'::text, 'gap'::text])"
    : "actor_kind in ('principal', 'external', 'gap')"
  const pk = (sqlite: number, pg: number): number => (postgres ? pg : sqlite)

  return [
    {
      name: 'activity_note_actor_heads',
      columns: [
        column('space', 'text', true, pk(1, 0)),
        column('generation', integer, true, pk(2, 1)),
        column('note_id', 'text', true, pk(3, 2)),
        column('actor_kind', 'text', true, pk(4, 3)),
        column('actor_key', 'text', true, pk(5, 4)),
        column('class_key', 'text', true, pk(6, 5)),
        column('source_ordinal', integer),
        column('revision_id', integer),
      ],
      checks: [actorCheck],
      foreignKeys: [],
      indexes: [
        index(
          [
            'space',
            'generation',
            'actor_kind',
            'actor_key',
            'class_key',
            'note_id',
            'source_ordinal',
            'revision_id',
          ],
          false,
          'idx_activity_heads_space_generation',
        ),
        index(['space', 'generation', 'note_id', 'actor_kind', 'actor_key', 'class_key'], true),
      ],
    },
    {
      name: 'activity_note_actor_states',
      columns: [
        column('space', 'text', true, pk(1, 0)),
        column('generation', integer, true, pk(2, 1)),
        column('source_ordinal', integer, true, pk(3, 2)),
        column('revision_id', integer),
        column('note_id'),
        column('actor_kind'),
        column('actor_key'),
        column('class_key'),
        column('event_count', integer),
        column('chars_added_sum', integer),
        column('chars_added_known', integer),
        column('chars_removed_sum', integer),
        column('chars_removed_known', integer),
      ],
      checks: [actorCheck, 'chars_added_known >= 0', 'chars_removed_known >= 0', 'event_count > 0'],
      foreignKeys: [],
      indexes: [
        index(
          [
            'space',
            'generation',
            'note_id',
            'actor_kind',
            'actor_key',
            'class_key',
            'source_ordinal',
          ],
          false,
          'idx_activity_states_bucket_source',
        ),
        index(['space', 'generation', 'revision_id'], true),
        index(['space', 'generation', 'source_ordinal'], true),
      ],
    },
    {
      name: 'activity_projection_gc',
      columns: [
        column('space', 'text', true, pk(1, 0)),
        column('generation', integer, true, pk(2, 1)),
        column('phase'),
        column('updated_at'),
      ],
      checks: [
        postgres
          ? "phase = any (array['states'::text, 'heads'::text])"
          : "phase in ('states', 'heads')",
      ],
      foreignKeys: [],
      indexes: [index(['space', 'generation'], true)],
    },
    {
      name: 'activity_projection_status',
      columns: [
        column('space', 'text', postgres, pk(1, 0)),
        column('state'),
        column('legacy_through_revision_id', integer, false),
        column('next_source_ordinal', integer),
        column('generation_counter', integer),
        column('active_generation', integer, false),
        column('active_through', integer, false),
        column('build_generation', integer, false),
        column('rebuild_cursor', integer, false),
        column('rebuild_target', integer, false),
        column('source_generation', integer),
        column('build_source_generation', integer, false),
        column('last_error_code', 'text', false),
        column('updated_at'),
      ],
      checks: (postgres
        ? [
            'generation_counter > 0',
            'next_source_ordinal >= 0',
            'source_generation > 0',
            "state = 'ready'::text and active_generation is not null and build_generation is null or state = 'rebuilding'::text",
            "state = any (array['ready'::text, 'rebuilding'::text])",
          ]
        : [
            "(state = 'ready' and active_generation is not null and build_generation is null) or state = 'rebuilding'",
            'generation_counter > 0',
            'next_source_ordinal >= 0',
            'source_generation > 0',
            "state in ('ready', 'rebuilding')",
          ]
      ).sort(),
      foreignKeys: [],
      indexes: [index(['space'], true)],
    },
    {
      name: 'activity_revision_order',
      columns: [
        column('space', 'text', true, pk(1, 0)),
        column('source_ordinal', integer, true, pk(2, 1)),
        column('revision_id', integer),
      ],
      checks: [],
      foreignKeys: [],
      indexes: [
        index(['space', 'revision_id'], false, 'idx_activity_revision_order_space_revision'),
        index(['revision_id'], true),
        index(['space', 'source_ordinal'], true),
      ],
    },
  ]
}

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

  target.tables.push(...activityProjectionTables(postgres))
  target.tables.sort((left, right) => left.name.localeCompare(right.name))

  return target
}

/** Remove the 0005 trace carrier so the immutable pre-cut golden can keep proving
 * every older table while the new carrier is asserted by its executable contract. */
export const withoutAgentCallTrace = (catalog: MetaDbCatalog): MetaDbCatalog => {
  const target = structuredClone(catalog)
  const newTables = new Set([
    'agent_calls',
    'agent_call_details',
    'agent_telemetry_config',
    'agent_session_cleanup_markers',
  ])
  target.tables = target.tables.filter((table) => !newTables.has(table.name))

  for (const name of ['agent_retrievals', 'note_revisions']) {
    const table = target.tables.find((candidate) => candidate.name === name)

    if (!table) {
      continue
    }
    table.columns = table.columns.filter((column) => column.name !== 'agent_call_id')
    table.indexes = table.indexes.filter((index) => {
      const columns = index.columns.map((column) => column.name)
      const traceLink =
        index.columns.length === 1 &&
        index.columns[0]?.name === 'agent_call_id' &&
        index.unique === false
      const legacyAgent =
        index.predicate?.includes('agent_call_id') === true &&
        (name === 'agent_retrievals'
          ? columns.length === 2 && columns[0] === 'owner' && columns[1] === 'agent'
          : columns.length === 2 && columns[0] === 'agent_owner' && columns[1] === 'agent_name')

      return !traceLink && !legacyAgent
    })
  }

  return target
}

const TRACE_TABLES = new Set([
  'agent_calls',
  'agent_call_details',
  'agent_telemetry_config',
  'agent_session_cleanup_markers',
])
const TRACE_JSON_COLUMNS = new Set([
  'payload',
  'input_shape',
  'issue_summary',
  'target_summary',
  'result_summary',
])
const TRACE_BOOLEAN_COLUMNS = new Set([
  'redacted',
  'truncated',
  'detail_capture_failed',
  'detailed_enabled',
  'cleanup_pending',
])
const TRACE_PRIMARY_KEYS: Readonly<Record<string, readonly string[]>> = {
  agent_calls: ['id'],
  agent_call_details: ['agent_call_id'],
  agent_telemetry_config: ['singleton'],
  agent_session_cleanup_markers: ['owner', 'session_id'],
}

const traceType = (column: CatalogColumn): string => {
  if (TRACE_JSON_COLUMNS.has(column.name)) {
    return 'json'
  }
  if (TRACE_BOOLEAN_COLUMNS.has(column.name)) {
    return 'boolean'
  }

  return column.type === 'bigint' ? 'integer' : column.type
}

const withoutOuterParentheses = (value: string): string => {
  let current = value.trim()

  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0
    let quoted = false
    let wrapsWholeValue = true

    for (let index = 0; index < current.length; index += 1) {
      const char = current[index]

      if (char === "'") {
        if (quoted && current[index + 1] === "'") {
          index += 1
        } else {
          quoted = !quoted
        }
      } else if (!quoted && char === '(') {
        depth += 1
      } else if (!quoted && char === ')') {
        depth -= 1

        if (depth === 0 && index !== current.length - 1) {
          wrapsWholeValue = false
          break
        }
      }
    }

    if (!wrapsWholeValue || depth !== 0) {
      break
    }
    current = current.slice(1, -1).trim()
  }

  return current
}

const tracePredicate = (predicate: string | null): string | null => {
  if (!predicate) {
    return null
  }
  const normalized = withoutOuterParentheses(normalizeSql(predicate.replaceAll('::text', '')))

  if (
    normalized.includes("tool = 'start_session'") &&
    normalized.includes("outcome = 'success'") &&
    normalized.includes('session.state') &&
    normalized.includes("'new'") &&
    normalized.includes("'forked'")
  ) {
    return '<complete-start>'
  }
  if (
    normalized.includes('outcome is not null') &&
    normalized.includes('agent is not null') &&
    (normalized.includes("agent != ''") || normalized.includes("agent <> ''"))
  ) {
    return '<terminal-agent>'
  }
  if (
    normalized.includes('agent_call_id is null') &&
    normalized.includes('agent is not null') &&
    (normalized.includes("agent != ''") || normalized.includes("agent <> ''"))
  ) {
    return '<legacy-agent>'
  }
  if (
    normalized.includes('agent_call_id is null') &&
    normalized.includes("integrity = 'trusted'") &&
    normalized.includes('agent_name is not null') &&
    (normalized.includes("agent_name != ''") || normalized.includes("agent_name <> ''"))
  ) {
    return '<legacy-trusted-agent>'
  }

  return normalized
}

const traceForeignKey = (foreignKey: CatalogForeignKey): CatalogForeignKey => {
  if (foreignKey.referencedTable) {
    return foreignKey
  }
  const definition = normalizeSql(foreignKey.columns.join(' '))
  const parsed = definition.match(
    /^foreign key \(([^)]+)\) references ([^(\s]+)\(([^)]+)\)([\s\S]*)$/,
  )

  if (!parsed) {
    return foreignKey
  }
  const tail = parsed[4] ?? ''

  return {
    columns: parsed[1]!.split(',').map((column) => column.trim()),
    referencedTable: parsed[2]!,
    referencedColumns: parsed[3]!.split(',').map((column) => column.trim()),
    onUpdate: tail.match(/on update ([a-z ]+?)(?: on delete|$)/)?.[1]?.trim() ?? 'no action',
    onDelete: tail.match(/on delete ([a-z ]+?)$/)?.[1]?.trim() ?? 'no action',
  }
}

/** Dialect-neutral structural carrier used by the live SQLite↔Postgres migration test. */
export const agentCallTraceCatalog = (catalog: MetaDbCatalog) => ({
  tables: catalog.tables
    .filter((table) => TRACE_TABLES.has(table.name))
    .map((table) => {
      const expectedPrimaryKey = TRACE_PRIMARY_KEYS[table.name] ?? []
      const indexColumns = (index: CatalogIndex) => index.columns.map((column) => column.name)
      const isPrimaryKeyIndex = (index: CatalogIndex) =>
        index.unique &&
        indexColumns(index).length === expectedPrimaryKey.length &&
        indexColumns(index).every((column, indexAt) => column === expectedPrimaryKey[indexAt])
      const hasPrimaryKey =
        expectedPrimaryKey.every((name) =>
          table.columns.some((column) => column.name === name && column.primaryKeyPosition > 0),
        ) || table.indexes.some(isPrimaryKeyIndex)
      const indexes = table.indexes
        .filter((index) => !isPrimaryKeyIndex(index))
        .map((index) => ({
          unique: index.unique,
          columns: index.columns.map((column) => ({
            name:
              column.name === '<expression>' || column.name.includes('coalesce(')
                ? '<expression>'
                : column.name,
            descending: column.descending,
          })),
          predicate: tracePredicate(index.predicate),
        }))
      const uniqueIndexes = [
        ...new Map(indexes.map((index) => [JSON.stringify(index), index])).values(),
      ]

      return {
        name: table.name,
        columns: table.columns.map((column) => ({
          name: column.name,
          type: traceType(column),
          notNull: column.notNull || column.primaryKeyPosition > 0,
          hasDefault: column.defaultValue != null,
        })),
        primaryKey: hasPrimaryKey ? expectedPrimaryKey : null,
        checkCount:
          table.checks.length -
          table.columns.filter(
            (column) => TRACE_BOOLEAN_COLUMNS.has(column.name) && column.type !== 'boolean',
          ).length,
        foreignKeys: table.foreignKeys.map(traceForeignKey),
        indexes: uniqueIndexes.sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
      }
    }),
  links: ['agent_retrievals', 'note_revisions'].map((name) => {
    const table = tableOf(catalog, name)
    const column = table.columns.find((candidate) => candidate.name === 'agent_call_id')
    const index = table.indexes.find((candidate) =>
      candidate.columns.some((candidateColumn) => candidateColumn.name === 'agent_call_id'),
    )
    const legacyColumns =
      name === 'agent_retrievals' ? ['owner', 'agent'] : ['agent_owner', 'agent_name']
    const legacyAgentIndex = table.indexes.find(
      (candidate) =>
        candidate.columns.length === legacyColumns.length &&
        candidate.columns.every(
          (candidateColumn, indexAt) => candidateColumn.name === legacyColumns[indexAt],
        ) &&
        candidate.predicate?.includes('agent_call_id') === true,
    )
    return {
      table: name,
      column: column
        ? { type: traceType(column), notNull: column.notNull, defaultValue: column.defaultValue }
        : null,
      index: index
        ? {
            unique: index.unique,
            columns: index.columns.map((candidate) => candidate.name),
            predicate: index.predicate,
          }
        : null,
      legacyAgentIndex: legacyAgentIndex
        ? {
            unique: legacyAgentIndex.unique,
            columns: legacyAgentIndex.columns.map((candidate) => candidate.name),
            predicate: tracePredicate(legacyAgentIndex.predicate),
          }
        : null,
    }
  }),
})
