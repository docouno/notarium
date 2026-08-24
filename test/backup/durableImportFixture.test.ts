// The fixture has to be indistinguishable from a real unfinished import, because the
// property under test is that production maintenance KEEPS it.

import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { JOB_KIND_IMPORT } from '../../packages/server/src/apps/server/consumers'
import { dataPathsFromEnv } from '../../packages/server/src/apps/server/dataPaths'
import { createFsImportStagingStore } from '../../packages/server/src/libs/importStaging'
import { createMetaDb } from '../../packages/server/src/services/metaDb'
import type { MetaDb } from '../../packages/server/src/services/metaDb'
import {
  createDurableImportFixture,
  inspectDurableImportFixture,
  main,
} from './durableImportFixture'
import { fixtureArgv } from './fixtureArgv.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const roots: string[] = []
const dbs: MetaDb[] = []

afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const freshDataDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-durable-import-fixture-'))
  roots.push(root)
  return root
}

const optionsFor = (dataDir: string) => ({
  dataDir,
  space: 'space-stable-id',
  jobId: 'backup-smoke-live-1',
  orphanJobId: 'backup-smoke-orphan-1',
  principal: 'user:backup-owner',
  filename: 'backup-smoke-import.json',
  content: 'durable-import-bytes',
  runAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
})

const pathsFor = (dataDir: string) => dataPathsFromEnv({ ...process.env, DATA_DIR: dataDir })

const openMetaDb = (dataDir: string): MetaDb => {
  const db = createMetaDb(pathsFor(dataDir).metaDbUrl)
  dbs.push(db)
  return db
}

describe('durable import fixture', () => {
  it('enqueues a production-shaped live import over its own staged upload', async () => {
    const dataDir = await freshDataDir()
    const options = optionsFor(dataDir)
    const fixture = await createDurableImportFixture(options)
    const row = await openMetaDb(dataDir).jobs.get(options.jobId)

    // Addressed by the STABLE SPACE ID because that is what production writes and what
    // the row's `uploadRef` has to resolve to for a re-claimed import to find its bytes.
    expect(fixture.upload.ref).toBe(`${options.space}/${options.jobId}.import`)
    expect(fixture.orphan.ref).toBe(`${options.space}/${options.orphanJobId}.import`)
    expect(fixture.job).toEqual({
      id: options.jobId,
      space: options.space,
      kind: 'import',
      status: 'pending',
      principal: options.principal,
      uploadRef: fixture.upload.ref,
      filename: options.filename,
      runAt: options.runAt,
      createdAt: row!.createdAt,
      attempts: 0,
      maxAttempts: row!.maxAttempts,
      error: null,
      completedAt: null,
      startedAt: null,
      lockedBy: null,
      phase: null,
    })
    // Read off the row, not synthesised: a constant would compare equal to itself on
    // both sides of the drill's before/after check and silently cover nothing.
    expect(row!.createdAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
    expect(row!.maxAttempts).toBeGreaterThan(0)
  })

  it('stages the upload before the row, so a failed enqueue still leaves the bytes', async () => {
    const dataDir = await freshDataDir()
    const options = optionsFor(dataDir)
    await createDurableImportFixture(options)
    const staging = createFsImportStagingStore(pathsFor(dataDir).importStagingDir)
    await rm(staging.pathOf(`${options.space}/${options.jobId}.import`))

    // The id is taken now, so the enqueue half fails — and the upload half must
    // already have happened, which is exactly the production ordering.
    await expect(createDurableImportFixture(options)).rejects.toThrow()
    await expect(
      stat(staging.pathOf(`${options.space}/${options.jobId}.import`)),
    ).resolves.toMatchObject({ size: options.content.length })
  })

  it('leaves a row no runner can claim during the drill', async () => {
    const dataDir = await freshDataDir()
    const options = optionsFor(dataDir)
    await createDurableImportFixture(options)
    const metaDb = openMetaDb(dataDir)

    await expect(
      metaDb.jobs.claimNext('drill-worker', ['import'], new Date().toISOString()),
    ).resolves.toBeNull()
  })

  it('ages both finals past the staging grace and gives the control orphan no row', async () => {
    const dataDir = await freshDataDir()
    const options = optionsFor(dataDir)
    const fixture = await createDurableImportFixture(options)
    const metaDb = openMetaDb(dataDir)

    // The default is what the drill relies on; an explicit ageMs here would pin the
    // argument rather than the constant.
    expect(Date.parse(fixture.agedTo)).toBeLessThanOrEqual(Date.now() - 120_000)
    for (const staged of [fixture.upload, fixture.orphan]) {
      expect((await stat(staged.path)).mtimeMs).toBeLessThanOrEqual(Date.now() - 120_000)
    }
    await expect(metaDb.jobs.get(options.orphanJobId)).resolves.toBeNull()
  })

  it('survives the production row-aware sweep that reclaims its control orphan', async () => {
    const dataDir = await freshDataDir()
    const options = optionsFor(dataDir)
    const fixture = await createDurableImportFixture(options)
    const metaDb = openMetaDb(dataDir)
    const staging = createFsImportStagingStore(pathsFor(dataDir).importStagingDir)

    // The exact callback server.ts hands the runner, at the moment the first
    // scheduled pass after the fixture lands would run it.
    await staging.sweepOrphans(async (id) => {
      const job = await metaDb.jobs.get(id)
      return !!job && (job.status === 'pending' || job.status === 'running')
    }, Date.now())

    const seen = await inspectDurableImportFixture({
      dataDir,
      jobId: options.jobId,
      orphanRef: fixture.orphan.ref,
    })
    expect(seen.upload.present).toBe(true)
    expect(seen.upload.bytes).toBe(options.content)
    expect(seen.orphan.present).toBe(false)
  })

  it('reads the same lifecycle projection back out of the data root', async () => {
    const dataDir = await freshDataDir()
    const options = optionsFor(dataDir)
    const fixture = await createDurableImportFixture(options)
    const seen = await inspectDurableImportFixture({
      dataDir,
      jobId: options.jobId,
      orphanRef: fixture.orphan.ref,
    })

    expect(seen.mode).toBe('inspect')
    expect(seen.job).toEqual(fixture.job)
    expect(seen.upload.ref).toBe(fixture.upload.ref)
    expect(seen.upload.bytes).toBe(options.content)
  })

  it('follows the ref the row carries rather than a name rebuilt from the job id', async () => {
    const dataDir = await freshDataDir()
    const options = optionsFor(dataDir)
    const paths = pathsFor(dataDir)
    const staging = createFsImportStagingStore(paths.importStagingDir)
    const metaDb = openMetaDb(dataDir)
    // Bytes deliberately parked under a DIFFERENT job id, with the row pointing at
    // them: a rebuilt `<space>/<jobId>.import` would miss them entirely.
    const movedRef = await staging.stage(options.space, 'moved-elsewhere', Readable.from(['moved']))
    await metaDb.jobs.enqueue({
      id: options.jobId,
      space: options.space,
      kind: JOB_KIND_IMPORT,
      principal: options.principal,
      params: { uploadRef: movedRef, filename: options.filename },
      runAt: options.runAt,
      createdAt: new Date().toISOString(),
    })

    const seen = await inspectDurableImportFixture({
      dataDir,
      jobId: options.jobId,
      orphanRef: `${options.space}/${options.orphanJobId}.import`,
    })

    expect(seen.upload.ref).toBe(movedRef)
    expect(seen.upload.bytes).toBe('moved')
  })

  it('reports no upload when the row is gone, instead of guessing a name', async () => {
    const dataDir = await freshDataDir()
    const options = optionsFor(dataDir)
    const fixture = await createDurableImportFixture(options)
    const metaDb = openMetaDb(dataDir)
    await metaDb.jobs.cancel(options.jobId, new Date().toISOString())
    await metaDb.jobs.prune(new Date(Date.now() + 60_000).toISOString())

    const seen = await inspectDurableImportFixture({
      dataDir,
      jobId: options.jobId,
      orphanRef: fixture.orphan.ref,
    })

    expect(seen.job).toBeNull()
    expect(seen.upload).toEqual({ ref: null, path: null, present: false, bytes: null })
  })

  it('spells every fixture option inline, the only form that accepts a dash value', () => {
    // The drill itself is Docker-only, so this is where the CALLER's spelling is
    // pinned; the parser's half is pinned by the dash-id case below.
    const argv = fixtureArgv('create', { space: '--Ab3xQz9_kL', 'run-at': '2027-01-01' })

    expect(argv).toEqual(['create', '--space=--Ab3xQz9_kL', '--run-at=2027-01-01'])
    expect(argv.every((arg, index) => index === 0 || arg.includes('='))).toBe(true)
  })

  it('refuses an option belonging to the other mode instead of dropping it', async () => {
    const dataDir = await freshDataDir()

    await expect(
      main([
        'inspect',
        `--data-dir=${dataDir}`,
        '--job-id=j',
        '--orphan-ref=s/o.import',
        '--space=s',
      ]),
    ).rejects.toThrow('--space is not an option of inspect')
    await expect(
      main(['create', `--data-dir=${dataDir}`, '--job-id=j', '--age-ms=abc']),
    ).rejects.toThrow('--age-ms must be a non-negative integer')
  })

  it('emits one JSON document per mode and refuses an incomplete invocation', async () => {
    const dataDir = await freshDataDir()
    const options = optionsFor(dataDir)
    const created = JSON.parse(
      await main([
        'create',
        `--data-dir=${dataDir}`,
        `--space=${options.space}`,
        `--job-id=${options.jobId}`,
        `--orphan-job-id=${options.orphanJobId}`,
        `--principal=${options.principal}`,
        `--filename=${options.filename}`,
        `--content=${options.content}`,
        `--run-at=${options.runAt}`,
      ]),
    )
    const inspected = JSON.parse(
      await main([
        'inspect',
        `--data-dir=${dataDir}`,
        `--job-id=${options.jobId}`,
        `--orphan-ref=${created.orphan.ref}`,
      ]),
    )

    expect(created.mode).toBe('create')
    expect(inspected.mode).toBe('inspect')
    expect(inspected.job).toEqual(created.job)
    await expect(
      main(['create', `--data-dir=${dataDir}`, `--job-id=${options.jobId}`]),
    ).rejects.toThrow('--space is required')
    await expect(
      main(['audit', `--data-dir=${dataDir}`, `--job-id=${options.jobId}`]),
    ).rejects.toThrow('usage:')
  })

  // A dash-leading space id is a real 1-in-4096 draw from the id alphabet, and the
  // separate-argument form of the parser rejects any value starting with `--`.
  it('accepts a space id that begins with a dash, as the CLI is really invoked', async () => {
    const dataDir = await freshDataDir()
    const options = { ...optionsFor(dataDir), space: '--Ab3xQz9_kL' }
    const created = JSON.parse(
      await main([
        'create',
        `--data-dir=${dataDir}`,
        `--space=${options.space}`,
        `--job-id=${options.jobId}`,
        `--orphan-job-id=${options.orphanJobId}`,
        `--principal=${options.principal}`,
        `--filename=${options.filename}`,
        `--content=${options.content}`,
        `--run-at=${options.runAt}`,
      ]),
    )

    expect(created.upload.ref).toBe(`${options.space}/${options.jobId}.import`)
  })

  // The driver reads the LAST non-empty stdout line, because the meta-DB logs every
  // migration it applies to stdout ahead of the document. Run as a real subprocess:
  // in-process calls never exercise the entrypoint guard or that interleaving, and
  // the log itself is silenced under NODE_ENV=test, which the builder image never
  // sets and vitest always does — so the drill's condition has to be restored here.
  it('prints its document as the last stdout line, behind the meta-DB migration log', async () => {
    const dataDir = await freshDataDir()
    const options = optionsFor(dataDir)
    const driverEnv = { ...process.env }
    delete driverEnv.NODE_ENV
    const result = spawnSync(
      'node_modules/.bin/tsx',
      [
        'test/backup/durableImportFixture.ts',
        'create',
        `--data-dir=${dataDir}`,
        `--space=${options.space}`,
        `--job-id=${options.jobId}`,
        `--orphan-job-id=${options.orphanJobId}`,
        `--principal=${options.principal}`,
        `--filename=${options.filename}`,
        `--content=${options.content}`,
        `--run-at=${options.runAt}`,
      ],
      { cwd: repo, encoding: 'utf8', env: driverEnv, timeout: 60_000 },
    )
    const lines = result.stdout.split('\n').filter((line) => line.trim())

    expect(result.status).toBe(0)
    expect(lines.length).toBeGreaterThan(1)
    expect(JSON.parse(lines.at(-1)!).upload.ref).toBe(`${options.space}/${options.jobId}.import`)

    const failed = spawnSync(
      'node_modules/.bin/tsx',
      ['test/backup/durableImportFixture.ts', 'inspect', `--data-dir=${dataDir}`],
      { cwd: repo, encoding: 'utf8', env: driverEnv, timeout: 60_000 },
    )

    expect(failed.status).not.toBe(0)
    expect(failed.stdout).not.toContain('"mode"')
    expect(failed.stderr).toContain('--job-id is required')
  }, 90_000)
})
