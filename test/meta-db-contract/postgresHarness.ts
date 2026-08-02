import type { SuiteFactory, TestOptions } from '@vitest/runner'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe } from 'vitest'

import { PgMetaDb } from '../../packages/server/src/services/metaDb/pgMetaDb'

export const testPgUrl = process.env.TEST_PG_URL

/** The marker test/skipSummary.ts groups by, so an ordinary `npm test` says WHY the
 *  live-dialect suites sat out instead of just counting them.
 *  canon: docs/dev-environment.md#invariants */
export const POSTGRES_GATE = '[gate: postgres (make test-pg)]'

/** `describe` for a suite that needs a live database — runs it when TEST_PG_URL points
 *  at one, elsewhere skips it under a name carrying the gate. `make test-pg` supplies an
 *  ephemeral Postgres; plain `npm test` legitimately has none.
 *
 *  Overloads rather than one union parameter: vitest rejects `(name, options)` with no
 *  factory and `(name, fn, fn)` outright, and a single signature would let both compile
 *  — the first to blow up during collection, the second to drop a suite silently. */
export function describePostgres(name: string, fn: SuiteFactory): void
export function describePostgres(name: string, options: TestOptions, fn: SuiteFactory): void
export function describePostgres(
  name: string,
  optionsOrFn: TestOptions | SuiteFactory,
  maybeFn?: SuiteFactory,
): void {
  const suite = testPgUrl ? describe : describe.skip
  const label = testPgUrl ? name : `${name} ${POSTGRES_GATE}`

  if (typeof optionsOrFn === 'function') {
    suite(label, optionsOrFn)
  } else {
    suite(label, optionsOrFn, maybeFn as SuiteFactory)
  }
}

let serial = 0

const quotedIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`

export type PostgresTestSchema = {
  admin: pg.Pool
  db: PgMetaDb
  schema: string
  scopedUrl: string
  teardown(): Promise<void>
}

/** One isolated schema per test: live dialect, no database-per-test privilege
 * required, safe for concurrent Vitest workers. */
export const createPostgresTestSchema = async (
  prefix = 'meta_contract',
): Promise<PostgresTestSchema> => {
  if (!testPgUrl) {
    throw new Error('TEST_PG_URL is required for the live Postgres suite')
  }
  const unique = `${process.pid}_${++serial}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const schema = `${prefix.slice(0, 62 - unique.length)}_${unique}`
  const identifier = quotedIdentifier(schema)
  const admin = new pg.Pool({ connectionString: testPgUrl })

  try {
    await admin.query(`CREATE SCHEMA ${identifier}`)
  } catch (err) {
    await admin.end().catch(() => {})
    throw err
  }

  const parsed = new URL(testPgUrl)
  parsed.searchParams.set('options', `-csearch_path=${schema}`)
  // Unique per schema so failure/retry tests can prove that no old pool remains.
  parsed.searchParams.set('application_name', schema)
  const scopedUrl = parsed.toString()
  const db = new PgMetaDb(scopedUrl)
  let closed = false

  return {
    admin,
    db,
    schema,
    scopedUrl,
    teardown: async () => {
      if (closed) {
        return
      }
      closed = true
      const errors: unknown[] = []

      for (const action of [
        () => db.close(),
        () => admin.query(`DROP SCHEMA IF EXISTS ${identifier} CASCADE`).then(() => undefined),
        () => admin.end(),
      ]) {
        try {
          await action()
        } catch (err) {
          errors.push(err)
        }
      }

      if (errors.length) {
        throw new AggregateError(errors, `failed to tear down Postgres test schema ${schema}`)
      }
    },
  }
}
