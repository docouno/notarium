import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import {
  maintainPgActivityProjectionFinalBatch,
  maintainPgActivityProjectionProgressBatch,
  preparePgActivityProjection,
} from '../packages/server/src/services/metaDb/drivers/pg/activityProjection'
import type { PgDriverCtx } from '../packages/server/src/services/metaDb/drivers/pg/context'
import {
  maintainSqliteActivityProjection,
  prepareSqliteActivityProjection,
} from '../packages/server/src/services/metaDb/drivers/sqlite/activityProjection'
import type { SqliteDriverCtx } from '../packages/server/src/services/metaDb/drivers/sqlite/context'
import {
  loadMetaMigrations,
  runPgMigrations,
  runSqliteMigrations,
} from '../packages/server/src/services/metaDb/migrations'
import { PgMetaDb } from '../packages/server/src/services/metaDb/pgMetaDb'
import { SqliteMetaDb } from '../packages/server/src/services/metaDb/sqliteMetaDb'
import type { ActivityGroupsManifest } from './activityGroupsBenchGates'

type Variant = 'base' | 'revision-10x' | 'breadth-10x'
type PrincipalKind =
  'viewer-user' | 'viewer-agent' | 'other-user' | 'other-agent' | 'external' | 'gap'

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=')
    return [key!, value.join('=')]
  }),
)
const dialect = args.get('dialect') as 'sqlite' | 'postgres'
const variant = args.get('variant') as Variant
const outputRoot = args.get('output')
const reportPath = args.get('report')
const mode = (args.get('mode') ?? 'upgrade-rebuild') as 'fresh-ready' | 'upgrade-rebuild'
const deferRebuild = args.get('defer-rebuild') === 'true'
const manifestPath = args.get('manifest') ?? 'test/cases/manifests/activity-groups-v1.json'
const sqliteWorkerEntry = args.get('sqlite-worker-entry')
const rebuildBatchSize = Number(args.get('rebuild-batch-size') ?? 0)
const migrationCount = Number(args.get('migration-count') ?? 7)
const includeBlobs = args.get('include-blobs') !== 'false'

if (
  !['sqlite', 'postgres'].includes(dialect) ||
  !['base', 'revision-10x', 'breadth-10x'].includes(variant) ||
  !['fresh-ready', 'upgrade-rebuild'].includes(mode) ||
  !Number.isInteger(rebuildBatchSize) ||
  rebuildBatchSize < 0 ||
  !Number.isInteger(migrationCount) ||
  migrationCount <= 0 ||
  !outputRoot ||
  !reportPath
) {
  throw new Error(
    'usage: --dialect=sqlite|postgres --variant=base|revision-10x|breadth-10x --mode=fresh-ready|upgrade-rebuild --rebuild-batch-size=<n> --output=<path> --report=<path>',
  )
}
const manifestBytes = readFileSync(manifestPath)
const manifest = JSON.parse(manifestBytes.toString('utf8')) as ActivityGroupsManifest
const shape = manifest.variants[variant]
const baselineNotes =
  variant === 'breadth-10x'
    ? manifest.firstRoleCohort.breadthBaselineNotes
    : manifest.firstRoleCohort.baseBaselineNotes
const loaderVersion = 'activity-groups-loader-v4'
const principalTargets: Record<PrincipalKind, number> = {
  'viewer-user': shape.revisions * 0.4,
  'viewer-agent': shape.revisions * 0.2,
  'other-user': shape.revisions * 0.2,
  'other-agent': shape.revisions * 0.1,
  external: shape.revisions * 0.08,
  gap: shape.revisions * 0.02,
}
const principalRemaining = { ...principalTargets }
principalRemaining.external -= baselineNotes
const principalKinds = Object.keys(principalRemaining) as PrincipalKind[]
const previousByNote = new Array<number>(shape.activeNotes).fill(0)
const counters = {
  baselineNotes: 0,
  originNotes: 0,
  gaps: 0,
  principals: Object.fromEntries(principalKinds.map((kind) => [kind, 0])) as Record<
    PrincipalKind,
    number
  >,
  churnUnknown: 0,
  trustedChurnUnknown: 0,
  blobs: 0,
  blobBytes: 0,
  sqliteBatches: 0,
  pgCopies: 0,
}

const progressReporter = (phase: string) => {
  const step = Math.max(1, Math.ceil(shape.revisions / 10))
  let next = step

  return (completed: number): void => {
    if (completed < next && completed !== shape.revisions) {
      return
    }
    console.log(`[activity-groups] ${phase} ${completed}/${shape.revisions}`)
    while (next <= completed) {
      next += step
    }
  }
}

const noteOf = (revision: number): number => {
  if (revision <= shape.activeNotes) {
    return revision - 1
  }
  const hotTarget = Math.floor(shape.revisions * 0.8)
  const hotRemaining = hotTarget - 2
  const afterFirst = revision - shape.activeNotes - 1

  if (afterFirst < hotRemaining) {
    return afterFirst % 2
  }

  return 2 + ((afterFirst - hotRemaining) % Math.max(1, shape.activeNotes - 2))
}

const choosePrincipal = (first: boolean, baseline: boolean): PrincipalKind => {
  if (baseline) {
    return 'external'
  }
  const allowed = principalKinds.filter(
    (kind) => principalRemaining[kind] > 0 && (!first || kind !== 'gap'),
  )
  const selected = allowed.sort(
    (left, right) =>
      principalRemaining[right] / principalTargets[right] -
        principalRemaining[left] / principalTargets[left] || left.localeCompare(right),
  )[0]

  if (!selected) {
    throw new Error('principal distribution exhausted before the corpus')
  }
  principalRemaining[selected]--
  return selected
}

const principalValue = (kind: PrincipalKind): string | null =>
  kind === 'viewer-user'
    ? 'user:viewer'
    : kind === 'viewer-agent'
      ? 'pat:viewer:seed'
      : kind === 'other-user'
        ? 'user:other'
        : kind === 'other-agent'
          ? 'pat:other:seed'
          : null

const sizedText = (size: number, prefix: string): string =>
  (prefix + 'x'.repeat(size)).slice(0, size)

const titleOf = (revision: number): string => {
  const percentile = revision % 100
  return sizedText(percentile < 80 ? 32 : percentile < 95 ? 96 : 240, `r${revision}-`)
}

const tagsOf = (revision: number): string => {
  const percentile = revision % 100
  const size = percentile < 80 ? 2 : percentile < 95 ? 32 : 128
  return size === 2 ? '[]' : `["${'t'.repeat(size - 4)}"]`
}

const blobOf = (revision: number): { hash: string; bytes: Buffer } => {
  const bytes = Buffer.alloc(manifest.state.blobBytes, 97)
  bytes.writeBigUInt64BE(BigInt(revision), 0)
  return { hash: createHash('sha256').update(bytes).digest('hex'), bytes }
}

type GeneratedRow = {
  id: number
  noteId: string
  baseRevision: number | null
  kind: 'external' | 'write'
  entryRole: 'baseline' | 'origin' | 'change'
  principalKind: PrincipalKind
  principal: string | null
  contentHash: string | null
  blob: Buffer | null
  title: string
  tags: string
  createdAt: string
  charsAdded: number | null
  charsRemoved: number | null
  integrity: 'trusted' | 'quarantined'
  stateFormat: 'markdown-v2' | null
}

const generatedRow = (revision: number): GeneratedRow => {
  const noteIndex = noteOf(revision)
  const first = previousByNote[noteIndex] === 0
  const baseline = first && noteIndex < baselineNotes
  const principalKind = choosePrincipal(first, baseline)
  const gap = principalKind === 'gap'
  const baseRevision = first ? null : previousByNote[noteIndex]!
  const unknown =
    gap || counters.trustedChurnUnknown < shape.revisions * 0.05 - principalTargets.gap
  const blob = gap || !includeBlobs ? null : blobOf(revision)

  previousByNote[noteIndex] = revision
  counters.principals[principalKind]++
  if (baseline) {
    counters.baselineNotes++
  } else if (first) {
    counters.originNotes++
  }
  if (gap) {
    counters.gaps++
  }
  if (unknown) {
    counters.churnUnknown++
  }
  if (unknown && !gap) {
    counters.trustedChurnUnknown++
  }
  if (blob) {
    counters.blobs++
    counters.blobBytes += blob.bytes.length
  }

  return {
    id: revision,
    noteId: `note-${String(noteIndex).padStart(6, '0')}`,
    baseRevision,
    kind: baseline ? 'external' : 'write',
    entryRole: baseline ? 'baseline' : first ? 'origin' : 'change',
    principalKind,
    principal: principalValue(principalKind),
    contentHash: blob?.hash ?? null,
    blob: blob?.bytes ?? null,
    title: titleOf(revision),
    tags: tagsOf(revision),
    createdAt: new Date(Date.UTC(2020, 0, 1) + revision * 1_000).toISOString(),
    charsAdded: unknown ? null : revision % 17,
    charsRemoved: unknown ? null : revision % 7,
    integrity: gap ? 'quarantined' : 'trusted',
    stateFormat: gap ? null : 'markdown-v2',
  }
}

const writeFiles = () => {
  const filesRoot = join(outputRoot, 'files')
  rmSync(filesRoot, { recursive: true, force: true })
  mkdirSync(filesRoot, { recursive: true })
  const baseSize = Math.floor(shape.sourceBytes / shape.liveNotes)
  let remainder = shape.sourceBytes - baseSize * shape.liveNotes
  let observedBytes = 0

  for (let index = 0; index < shape.liveNotes; index++) {
    const size = baseSize + (remainder-- > 0 ? 1 : 0)
    const folder = `folder-${String(index % shape.folders).padStart(5, '0')}`
    const path = join(filesRoot, folder, `note-${String(index).padStart(6, '0')}.md`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, sizedText(size, `# Note ${index}\n\n`))
    observedBytes += size
  }

  return observedBytes
}

const loadSqlite = async () => {
  const dbPath = join(outputRoot, 'meta.sqlite')
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
  const migrations = loadMetaMigrations()
  const db = new DatabaseSync(dbPath)
  runSqliteMigrations(
    db,
    mode === 'upgrade-rebuild' ? migrations.slice(0, migrationCount) : migrations,
  )
  const blob = db.prepare('INSERT INTO revision_blobs (hash, content) VALUES (?, ?)')
  const row = db.prepare(`INSERT INTO note_revisions
    (id, note_id, space, base_rev, their_rev, source_rev, kind, entry_role, principal,
     content_hash, semantic_fingerprint, restore_safety, state_format, title, class, slug,
     tags, created_at, chars_added, chars_removed, integrity)
    VALUES (?, ?, 'activity-groups', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'user-doc', NULL,
            ?, ?, ?, ?, ?)`)

  const producerStarted = performance.now()
  const reportSqliteLoad = progressReporter(`sqlite/${variant}/${mode}/source`)

  for (let start = 1; start <= shape.revisions; start += manifest.state.sqliteBatchRows) {
    db.exec('BEGIN IMMEDIATE')
    const end = Math.min(shape.revisions, start + manifest.state.sqliteBatchRows - 1)

    for (let revision = start; revision <= end; revision++) {
      const generated = generatedRow(revision)

      if (generated.blob && generated.contentHash) {
        blob.run(generated.contentHash, generated.blob)
      }
      row.run(
        generated.id,
        generated.noteId,
        generated.baseRevision,
        generated.kind,
        generated.entryRole,
        generated.principal,
        generated.contentHash,
        generated.contentHash ? `bench:${generated.contentHash}` : null,
        generated.contentHash ? 'safe' : null,
        generated.stateFormat,
        generated.title,
        generated.tags,
        generated.createdAt,
        generated.charsAdded,
        generated.charsRemoved,
        generated.integrity,
      )
    }
    db.exec('COMMIT')
    counters.sqliteBatches++
    reportSqliteLoad(end)
  }
  const producerMs = performance.now() - producerStarted
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.exec('VACUUM')
  db.exec('ANALYZE')
  db.exec('PRAGMA optimize')
  db.close()
  let rebuildMs = 0
  let rebuildBatches = 0
  let maxRebuildBatchMs = 0

  if (mode === 'upgrade-rebuild' && !deferRebuild) {
    const started = performance.now()

    if (rebuildBatchSize > 0) {
      const projectionDb = new DatabaseSync(dbPath)

      runSqliteMigrations(projectionDb, loadMetaMigrations())
      let open = true
      const ctx: SqliteDriverCtx = {
        ensureInit: async () => {},
        checkpointWal: async () => {
          projectionDb.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
        },
        close: async () => {
          if (open) {
            projectionDb.close()
            open = false
          }
        },
        get required() {
          if (!open) {
            throw new Error('accelerated Activity corpus database is closed')
          }

          return projectionDb
        },
      }
      const prepared = await prepareSqliteActivityProjection(ctx, 'activity-groups')

      if (prepared.state !== 'rebuilding') {
        throw new Error('upgrade corpus did not enter Activity rebuilding')
      }
      const reportSqliteRebuild = progressReporter(`sqlite/${variant}/offline-rebuild`)
      let rebuiltRows = 0

      for (;;) {
        const batchStarted = performance.now()
        const step = await maintainSqliteActivityProjection(
          ctx,
          'activity-groups',
          rebuildBatchSize,
        )
        maxRebuildBatchMs = Math.max(maxRebuildBatchMs, performance.now() - batchStarted)
        rebuildBatches++
        rebuiltRows += step.processed
        reportSqliteRebuild(Math.min(rebuiltRows, shape.revisions))

        if (step.state === 'ready') {
          break
        }
      }
      await ctx.close()
    } else {
      const migrated = new SqliteMetaDb(dbPath, {
        ...(sqliteWorkerEntry
          ? { activityWorkerEntry: pathToFileURL(resolve(sqliteWorkerEntry)) }
          : {}),
      })
      await migrated.revisions.init()
      const prepared = await migrated.revisions.prepareActivityProjection('activity-groups')

      if (prepared && prepared.state !== 'rebuilding') {
        throw new Error('upgrade corpus did not enter Activity rebuilding')
      }
      for (;;) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        const batchStarted = performance.now()
        const step = await migrated.revisions.maintainActivityProjection('activity-groups')
        maxRebuildBatchMs = Math.max(maxRebuildBatchMs, performance.now() - batchStarted)
        rebuildBatches++

        if (step.state === 'ready') {
          break
        }
      }
      await migrated.close()
    }
    rebuildMs = performance.now() - started
  }

  const measured = new DatabaseSync(dbPath, { readOnly: true })
  const count = (table: string): number =>
    Number((measured.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
  const sourceRows = count('note_revisions')
  const hasActivityCarrier =
    measured
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'activity_projection_status'")
      .get() != null
  const orderRows = hasActivityCarrier ? count('activity_revision_order') : 0
  const stateRows = hasActivityCarrier ? count('activity_note_actor_states') : 0
  const headRows = hasActivityCarrier ? count('activity_note_actor_heads') : 0
  const statusRows = hasActivityCarrier ? count('activity_projection_status') : 0
  measured.close()

  return {
    target: dbPath,
    rebuildMs,
    rebuildBatches,
    maxRebuildBatchMs,
    producer: {
      elapsedMs: producerMs,
      sourceRows,
      transactions: counters.sqliteBatches,
      statusRows,
      orderRows,
      stateRows,
      headRows,
      auxiliaryRows: orderRows + stateRows + headRows,
      auxiliaryRowsPerSource: (orderRows + stateRows + headRows) / sourceRows,
    },
  }
}

const writePg = async (child: ReturnType<typeof spawn>, value: string): Promise<void> => {
  if (!child.stdin.write(value)) {
    await once(child.stdin, 'drain')
  }
}

const loadPostgres = async () => {
  const url = process.env.ACTIVITY_GROUPS_PG_URL
  const container = process.env.ACTIVITY_GROUPS_PG_CONTAINER

  if (!url || !container) {
    throw new Error('ACTIVITY_GROUPS_PG_URL and ACTIVITY_GROUPS_PG_CONTAINER are required')
  }
  const parsedUrl = new URL(url)
  const pgUser = decodeURIComponent(parsedUrl.username)
  const pgDatabase = decodeURIComponent(parsedUrl.pathname.slice(1))

  if (!pgUser || !pgDatabase) {
    throw new Error('ACTIVITY_GROUPS_PG_URL must include a username and database')
  }
  if (mode === 'upgrade-rebuild') {
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    await runPgMigrations(client, loadMetaMigrations().slice(0, migrationCount))
    await client.end()
  } else {
    const migrated = new PgMetaDb(url)
    await migrated.revisions.init()
    await migrated.close()
  }
  let producerMs = 0

  {
    const producerStarted = performance.now()
    const child = spawn(
      'docker',
      ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', pgUser, '-d', pgDatabase],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    )
    const copyRevisions =
      'COPY note_revisions (id,note_id,space,base_rev,their_rev,source_rev,kind,entry_role,principal,content_hash,semantic_fingerprint,restore_safety,state_format,title,class,slug,tags,created_at,chars_added,chars_removed,integrity) FROM STDIN;\n'
    const pgValue = (value: string | number | null) => (value == null ? '\\N' : String(value))
    const pgRow = (value: GeneratedRow): string =>
      [
        value.id,
        value.noteId,
        'activity-groups',
        value.baseRevision,
        null,
        null,
        value.kind,
        value.entryRole,
        value.principal,
        value.contentHash,
        value.contentHash ? `bench:${value.contentHash}` : null,
        value.contentHash ? 'safe' : null,
        value.stateFormat,
        value.title,
        'user-doc',
        null,
        value.tags,
        value.createdAt,
        value.charsAdded,
        value.charsRemoved,
        value.integrity,
      ]
        .map(pgValue)
        .join('\t') + '\n'
    const generated = includeBlobs ? new Array<GeneratedRow>(shape.revisions) : null

    await writePg(child, 'ALTER TABLE note_revisions SET (autovacuum_enabled = false);\nBEGIN;\n')
    if (generated) {
      await writePg(child, 'COPY revision_blobs (hash, content) FROM STDIN;\n')
      const reportPgGeneration = progressReporter(`postgres/${variant}/${mode}/generate`)

      for (let revision = 1; revision <= shape.revisions; revision++) {
        const value = generatedRow(revision)
        generated[revision - 1] = value
        if (value.blob && value.contentHash) {
          // COPY text consumes one escaping layer before BYTEA parses its `\x` hex form.
          await writePg(child, `${value.contentHash}\t\\\\x${value.blob.toString('hex')}\n`)
        }
        reportPgGeneration(revision)
      }
      await writePg(child, `\\.\n${copyRevisions}`)
    } else {
      await writePg(child, copyRevisions)
    }
    let generatedStart = 0

    if (mode === 'fresh-ready') {
      // A multi-row PostgreSQL COPY is one statement: its first AFTER ROW trigger
      // can see the statement's other inserted rows and correctly treats them as
      // legacy/unordered input. Establish the genuinely fresh carrier with one
      // committed producer row before exercising the scaled COPY tail.
      if (!generated) {
        throw new Error('fresh-ready PostgreSQL producer requires blob-backed generated rows')
      }
      await writePg(child, pgRow(generated[0]!))
      await writePg(child, `\\.\nCOMMIT;\nBEGIN;\n${copyRevisions}`)
      generatedStart = 1
    }

    const reportPgRows = progressReporter(`postgres/${variant}/${mode}/source`)

    for (let index = generatedStart; index < shape.revisions; index++) {
      const value = generated ? generated[index]! : generatedRow(index + 1)

      await writePg(child, pgRow(value))
      reportPgRows(index + 1)
    }
    await writePg(
      child,
      "\\.\nSELECT setval(pg_get_serial_sequence('note_revisions', 'id'), (SELECT MAX(id) FROM note_revisions), true);\nCOMMIT;\nALTER TABLE note_revisions RESET (autovacuum_enabled);\nVACUUM (ANALYZE, FREEZE) note_revisions;\nCHECKPOINT;\n",
    )
    child.stdin.end()
    const [code] = (await once(child, 'exit')) as [number]

    if (code !== 0) {
      throw new Error(`postgres COPY loader exited ${code}`)
    }
    producerMs = performance.now() - producerStarted
    counters.pgCopies = mode === 'fresh-ready' ? 3 : 2
  }
  let rebuildMs = 0
  let rebuildBatches = 0
  let maxRebuildBatchMs = 0

  if (mode === 'upgrade-rebuild' && !deferRebuild) {
    const started = performance.now()

    if (rebuildBatchSize > 0) {
      const pool = new pg.Pool({ connectionString: url })
      const migrationClient = await pool.connect()

      try {
        await runPgMigrations(migrationClient, loadMetaMigrations())
      } finally {
        migrationClient.release()
      }
      const ctx: PgDriverCtx = {
        ensureInit: async () => {},
        close: async () => pool.end(),
        get required() {
          return pool
        },
      }
      const prepared = await preparePgActivityProjection(ctx, 'activity-groups')

      if (prepared.state !== 'rebuilding') {
        throw new Error('upgrade corpus did not enter Activity rebuilding')
      }
      const client = await pool.connect()
      const reportPgRebuild = progressReporter(`postgres/${variant}/offline-rebuild`)
      let rebuiltRows = 0

      try {
        for (;;) {
          const batchStarted = performance.now()
          const progress = await maintainPgActivityProjectionProgressBatch(
            client,
            'activity-groups',
            rebuildBatchSize,
          )
          const step =
            progress ??
            (await maintainPgActivityProjectionFinalBatch(
              client,
              'activity-groups',
              rebuildBatchSize,
            ))
          maxRebuildBatchMs = Math.max(maxRebuildBatchMs, performance.now() - batchStarted)
          rebuildBatches++
          rebuiltRows += step.processed
          reportPgRebuild(Math.min(rebuiltRows, shape.revisions))

          if (step.state === 'ready') {
            break
          }
        }
      } finally {
        client.release()
        await pool.end()
      }
    } else {
      const migrated = new PgMetaDb(url)
      await migrated.revisions.init()
      const prepared = await migrated.revisions.prepareActivityProjection('activity-groups')

      if (prepared && prepared.state !== 'rebuilding') {
        throw new Error('upgrade corpus did not enter Activity rebuilding')
      }
      for (;;) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        const batchStarted = performance.now()
        const step = await migrated.revisions.maintainActivityProjection('activity-groups')
        maxRebuildBatchMs = Math.max(maxRebuildBatchMs, performance.now() - batchStarted)
        rebuildBatches++

        if (step.state === 'ready') {
          break
        }
      }
      await migrated.close()
    }
    rebuildMs = performance.now() - started
  }
  const measured = new pg.Pool({ connectionString: url })
  const count = async (table: string): Promise<number> =>
    Number((await measured.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n)
  const sourceRows = await count('note_revisions')
  const hasActivityCarrier =
    (await measured.query("SELECT to_regclass('activity_projection_status') AS carrier")).rows[0]
      .carrier != null
  const orderRows = hasActivityCarrier ? await count('activity_revision_order') : 0
  const stateRows = hasActivityCarrier ? await count('activity_note_actor_states') : 0
  const headRows = hasActivityCarrier ? await count('activity_note_actor_heads') : 0
  const statusRows = hasActivityCarrier ? await count('activity_projection_status') : 0
  await measured.end()

  return {
    target: url,
    rebuildMs,
    rebuildBatches,
    maxRebuildBatchMs,
    producer: {
      elapsedMs: producerMs,
      sourceRows,
      transactions: mode === 'fresh-ready' ? 2 : 1,
      statusRows,
      orderRows,
      stateRows,
      headRows,
      auxiliaryRows: orderRows + stateRows + headRows,
      auxiliaryRowsPerSource: (orderRows + stateRows + headRows) / sourceRows,
    },
  }
}

mkdirSync(outputRoot, { recursive: true })
const sourceBytes = writeFiles()
const loaded = dialect === 'sqlite' ? await loadSqlite() : await loadPostgres()

for (const kind of principalKinds) {
  if (counters.principals[kind] !== principalTargets[kind]) {
    throw new Error(
      `${kind} distribution mismatch: expected ${principalTargets[kind]}, got ${counters.principals[kind]}`,
    )
  }
}
if (
  counters.baselineNotes !== baselineNotes ||
  counters.originNotes !== shape.activeNotes - baselineNotes
) {
  throw new Error('first-role cohort mismatch')
}
if (counters.gaps !== shape.revisions * 0.02 || counters.churnUnknown !== shape.revisions * 0.05) {
  throw new Error('gap/churn distribution mismatch')
}
const report = {
  loaderVersion,
  mode,
  deferRebuild,
  dialect,
  variant,
  target: loaded.target,
  rebuildMs: loaded.rebuildMs,
  rebuildBatches: loaded.rebuildBatches,
  maxRebuildBatchMs: loaded.maxRebuildBatchMs,
  producer: loaded.producer,
  manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  shape: { ...shape, sourceBytes },
  ...counters,
  cleanClose: true,
  statistics:
    dialect === 'sqlite'
      ? 'wal-truncate-vacuum-analyze-optimize'
      : 'vacuum-analyze-freeze-checkpoint',
}

mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`loaded ${dialect}/${variant}: ${shape.revisions} revisions`)
