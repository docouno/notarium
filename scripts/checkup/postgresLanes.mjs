#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'

export const POSTGRES_LOCK_DATABASE = 'notarium_lock_pairs'
export const POSTGRES_LANES = Object.freeze([
  Object.freeze({
    name: 'contracts',
    files: Object.freeze([
      'test/meta-db-contract/postgres.test.ts',
      'test/meta-db-contract/postgresMigrations.test.ts',
      'test/meta-db-contract/pgLockOrder.test.ts',
      'test/integration/pgOAuth.test.ts',
    ]),
  }),
  Object.freeze({
    name: 'lock-pairs',
    files: Object.freeze(['test/meta-db-contract/pgLockPairs.test.ts']),
  }),
])

const databaseName = (url) => decodeURIComponent(new URL(url).pathname.replace(/^\//u, ''))

export const postgresDatabaseUrl = (url, database) => {
  if (!/^[a-z][a-z0-9_]*$/u.test(database)) {
    throw new Error(`invalid PostgreSQL lane database ${JSON.stringify(database)}`)
  }
  const parsed = new URL(url)

  parsed.pathname = `/${database}`

  return parsed.toString()
}

/** @typedef {{ connect(): Promise<void>, query(sql: string, params?: unknown[]): Promise<{ rowCount?: number | null }>, end(): Promise<void> }} PgClientLike */

/**
 * @param {{
 *   baseUrl?: string,
 *   database?: string,
 *   Client?: new (options: { connectionString: string }) => PgClientLike,
 * }} [options]
 */
export const ensurePostgresLaneDatabase = async ({
  baseUrl,
  database = POSTGRES_LOCK_DATABASE,
  Client = pg.Client,
} = {}) => {
  if (!baseUrl) {
    throw new Error('PostgreSQL lanes require TEST_PG_URL')
  }
  const admin = new Client({ connectionString: postgresDatabaseUrl(baseUrl, 'postgres') })

  await admin.connect()
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])

    if (existing.rowCount) {
      throw new Error(
        `PostgreSQL lane database ${database} already exists; canonical lanes require a fresh owned service`,
      )
    }
    await admin.query(`CREATE DATABASE "${database}"`)
    return { database, created: true }
  } finally {
    await admin.end()
  }
}

const ANSI_ESCAPE = String.fromCharCode(27)
const withoutAnsi = (value) => value.replace(new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'gu'), '')

const countFrom = (output, label) => {
  const match = new RegExp(`${label}\\s+(\\d+) passed`, 'u').exec(withoutAnsi(output))

  return match ? Number(match[1]) : null
}

export const postgresLaneArguments = (files) => [
  'node_modules/vitest/vitest.mjs',
  'run',
  '--no-file-parallelism',
  '--maxWorkers=1',
  '--minWorkers=1',
  ...files,
]

export const runPostgresLane = ({ name, files, url, cwd = process.cwd(), env = process.env }) =>
  new Promise((resolveLane) => {
    const started = process.hrtime.bigint()
    const child = spawn(process.execPath, postgresLaneArguments(files), {
      cwd,
      env: { ...env, TEST_PG_URL: url },
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    let output = ''

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      output += chunk
    })
    child.once('error', (error) => {
      resolveLane({
        name,
        files,
        wallMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        exitCode: 1,
        signal: null,
        testFiles: null,
        tests: null,
        error: { name: error.name, message: error.message },
      })
    })
    child.once('exit', (exitCode, signal) => {
      resolveLane({
        name,
        files,
        wallMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        exitCode,
        signal,
        testFiles: countFrom(output, 'Test Files'),
        tests: countFrom(output, 'Tests'),
      })
    })
  })

export const runPostgresLanes = async ({
  baseUrl = process.env.TEST_PG_URL,
  cwd = process.cwd(),
  env = process.env,
  output = resolve(cwd, 'test-results/postgres-lanes.json'),
  prepare = ensurePostgresLaneDatabase,
  runner = runPostgresLane,
} = {}) => {
  if (!baseUrl) {
    throw new Error('PostgreSQL lanes require TEST_PG_URL')
  }
  const contractsDatabase = databaseName(baseUrl)

  if (!contractsDatabase || contractsDatabase === POSTGRES_LOCK_DATABASE) {
    throw new Error(`PostgreSQL contracts need a distinct base database, got ${contractsDatabase}`)
  }
  const prepared = await prepare({ baseUrl, database: POSTGRES_LOCK_DATABASE })
  const urls = {
    contracts: baseUrl,
    'lock-pairs': postgresDatabaseUrl(baseUrl, POSTGRES_LOCK_DATABASE),
  }
  const startedAt = new Date().toISOString()
  const started = process.hrtime.bigint()
  const lanes = await Promise.all(
    POSTGRES_LANES.map((lane) => runner({ ...lane, url: urls[lane.name], cwd, env })),
  )
  const report = {
    schemaVersion: 1,
    startedAt,
    endedAt: new Date().toISOString(),
    wallMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    databases: { contracts: contractsDatabase, lockPairs: prepared.database },
    lanes,
    verdict: lanes.every((lane) => lane.exitCode === 0 && lane.signal === null)
      ? 'passed'
      : 'failed',
  }

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)

  return report
}

const main = async () => {
  const report = await runPostgresLanes()
  const signal = report.lanes.find((lane) => lane.signal)?.signal

  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = report.verdict === 'passed' ? 0 : 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
