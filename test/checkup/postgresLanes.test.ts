import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ensurePostgresLaneDatabase,
  POSTGRES_LANES,
  POSTGRES_LOCK_DATABASE,
  postgresDatabaseUrl,
  postgresLaneArguments,
  runPostgresLanes,
} from '../../scripts/checkup/postgresLanes.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const laneResult = (name: string, exitCode = 0) => ({
  name,
  files: [],
  wallMs: 25,
  exitCode,
  signal: null,
  testFiles: name === 'contracts' ? 4 : 1,
  tests: name === 'contracts' ? 268 : 199,
})

describe('PostgreSQL database lanes', () => {
  it('partitions the canonical files exactly once', () => {
    expect(POSTGRES_LANES).toEqual([
      {
        name: 'contracts',
        files: [
          'test/meta-db-contract/postgres.test.ts',
          'test/meta-db-contract/postgresMigrations.test.ts',
          'test/meta-db-contract/pgLockOrder.test.ts',
          'test/integration/pgOAuth.test.ts',
        ],
      },
      { name: 'lock-pairs', files: ['test/meta-db-contract/pgLockPairs.test.ts'] },
    ])
    expect(new Set(POSTGRES_LANES.flatMap(({ files }) => files)).size).toBe(5)
    expect(postgresLaneArguments(['lane.test.ts'])).toEqual([
      'node_modules/vitest/vitest.mjs',
      'run',
      '--no-file-parallelism',
      '--maxWorkers=1',
      '--minWorkers=1',
      'lane.test.ts',
    ])
  })

  it('changes only the database component of a connection URL', () => {
    expect(
      postgresDatabaseUrl(
        'postgres://notarium:notarium@postgres:5432/notarium_test?application_name=gate',
        POSTGRES_LOCK_DATABASE,
      ),
    ).toBe('postgres://notarium:notarium@postgres:5432/notarium_lock_pairs?application_name=gate')
    expect(() => postgresDatabaseUrl('postgres://localhost/base', 'bad-name')).toThrow(
      /invalid PostgreSQL lane database/u,
    )
  })

  it('creates the second database once and rejects an existing target', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    let existing = false
    class Client {
      async connect() {}
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        return { rowCount: sql.startsWith('SELECT') ? (existing ? 1 : 0) : null }
      }
      async end() {}
    }

    await expect(
      ensurePostgresLaneDatabase({
        baseUrl: 'postgres://notarium:notarium@postgres:5432/notarium_test',
        Client,
      }),
    ).resolves.toEqual({ database: POSTGRES_LOCK_DATABASE, created: true })
    expect(calls).toEqual([
      {
        sql: 'SELECT 1 FROM pg_database WHERE datname = $1',
        params: [POSTGRES_LOCK_DATABASE],
      },
      { sql: `CREATE DATABASE "${POSTGRES_LOCK_DATABASE}"`, params: undefined },
    ])
    existing = true

    await expect(
      ensurePostgresLaneDatabase({
        baseUrl: 'postgres://notarium:notarium@postgres:5432/notarium_test',
        Client,
      }),
    ).rejects.toThrow(/already exists.*fresh owned service/u)
  })

  it('runs both lanes together and writes their exact aggregate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-pg-lanes-'))
    roots.push(root)
    let active = 0
    let peak = 0
    const report = await runPostgresLanes({
      baseUrl: 'postgres://notarium:notarium@postgres:5432/notarium_test',
      cwd: root,
      output: join(root, 'report.json'),
      prepare: async () => ({ database: POSTGRES_LOCK_DATABASE, created: true }),
      runner: async ({ name }: { name: string }) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
        active -= 1
        return laneResult(name)
      },
    })

    expect(peak).toBe(2)
    expect(report).toMatchObject({
      databases: { contracts: 'notarium_test', lockPairs: POSTGRES_LOCK_DATABASE },
      verdict: 'passed',
      lanes: [
        { name: 'contracts', testFiles: 4, tests: 268 },
        { name: 'lock-pairs', testFiles: 1, tests: 199 },
      ],
    })
    await expect(readFile(join(root, 'report.json'), 'utf8')).resolves.toContain(
      '"verdict": "passed"',
    )
  })

  it('keeps a red lane visible after its sibling completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-pg-lanes-red-'))
    roots.push(root)
    const report = await runPostgresLanes({
      baseUrl: 'postgres://notarium:notarium@postgres:5432/notarium_test',
      cwd: root,
      output: join(root, 'report.json'),
      prepare: async () => ({ database: POSTGRES_LOCK_DATABASE, created: false }),
      runner: async ({ name }: { name: string }) => laneResult(name, name === 'contracts' ? 7 : 0),
    })

    expect(report.verdict).toBe('failed')
    expect(report.lanes).toEqual([
      expect.objectContaining({ name: 'contracts', exitCode: 7 }),
      expect.objectContaining({ name: 'lock-pairs', exitCode: 0 }),
    ])
  })
})
