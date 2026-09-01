import type { PoolClient } from 'pg'

export const ACTIVITY_GROUPS_GATE_DATABASE = 'notarium_activity_gate'

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`

const isSystemSchema = (schema: string): boolean =>
  schema === 'information_schema' || schema.startsWith('pg_')

/** Reset the dedicated Activity gate database, including schemas left by an
 * interrupted live-PG proof. DDL stays in one transaction and begins only after
 * the connected database itself confirms the destructive target. */
export const resetActivityGroupsPgSchemas = async (client: PoolClient): Promise<void> => {
  await client.query('BEGIN')

  try {
    const database = await client.query<{ database: string }>(
      'SELECT current_database() AS database',
    )

    if (
      database.rows.length !== 1 ||
      database.rows[0]?.database !== ACTIVITY_GROUPS_GATE_DATABASE
    ) {
      throw new Error(
        `Activity gate PostgreSQL connection must target ${ACTIVITY_GROUPS_GATE_DATABASE}`,
      )
    }
    const result = await client.query<{ schema: unknown }>(
      'SELECT nspname AS schema FROM pg_namespace ORDER BY nspname',
    )
    const schemas = result.rows.map(({ schema }) => {
      if (typeof schema !== 'string') {
        throw new Error('Activity gate PostgreSQL schema inventory is invalid')
      }

      return schema
    })

    for (const schema of schemas) {
      if (!isSystemSchema(schema)) {
        await client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`)
      }
    }
    await client.query('CREATE SCHEMA public')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}
