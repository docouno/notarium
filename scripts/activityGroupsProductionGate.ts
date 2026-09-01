import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'

import {
  ACTIVITY_GROUPS_LIVENESS_PROFILE,
  ACTIVITY_GROUPS_MANIFEST_SHA256,
  ACTIVITY_GROUPS_OFFLINE_REBUILD_BATCH_SIZE,
  ACTIVITY_GROUPS_PHASE_TIMEOUT_MS,
  ACTIVITY_GROUPS_PRODUCER_PROFILE,
  type ActivityGroupsBenchReport,
  activityGroupsGateFailures,
  type ActivityGroupsLatencyCell,
  type ActivityGroupsManifest,
  activityGroupsProofFailures,
  type ActivityGroupsProofTestReport,
  activityGroupsSmokeFailures,
  activityGroupsSmokeWarnings,
  minimumActivityGroupsProducerHeadRows,
  nearestRank,
} from './activityGroupsBenchGates'
import {
  ACTIVITY_GROUPS_GATE_DATABASE,
  resetActivityGroupsPgSchemas,
} from './activityGroupsPgReset'
import {
  auditActivityGroupSections,
  loadActivityGroupProductionSources,
} from './activityGroupsSourceAudit'

type Dialect = 'sqlite' | 'postgres'
type Variant = 'base' | 'revision-10x' | 'breadth-10x'
type GroupBy = 'note' | 'folder'
type Scope = 'all' | 'mine'

type LoaderReport = {
  loaderVersion: string
  mode: 'fresh-ready' | 'upgrade-rebuild'
  dialect: Dialect
  variant: Variant
  target: string
  manifestSha256: string
  shape: {
    liveNotes: number
    activeNotes: number
    folders: number
    sourceBytes: number
    revisions: number
  }
  baselineNotes: number
  originNotes: number
  gaps: number
  cleanClose: boolean
  producer: {
    elapsedMs: number
    sourceRows: number
    transactions: number
    statusRows: number
    orderRows: number
    stateRows: number
    headRows: number
    auxiliaryRows: number
    auxiliaryRowsPerSource: number
  }
}

type MeasureEntry = {
  elapsedMs: number
  groups: number
  responseItems: number
  retainedBytes: number
  locationThrough?: string
}

type MeasureReport = {
  consumerPath: string[]
  coldProtocol: string
  cells: Array<{
    by: GroupBy
    scope: Scope
    cold: MeasureEntry
    warm: MeasureEntry[]
    productionHeartbeat: ActivityGroupsLatencyCell['cycles'][number]['productionHeartbeat']
    locationChurn?: {
      elapsedMs: number
      responseItems: number
      through: string
      locationThrough: string
    }
  }>
}

type ProducerContentionReport = {
  writes: number
  concurrency: number
  elapsedMs: number
  throughputPerSecond: number
  appendLatencyMs: { median: number; p95: number; max: number }
  overlap: { maxInFlight: number }
  postgresWaits: {
    samples: number
    activeSamples: number
    waitingSamples: number
    lockWaitingSamples: number
    maxActive: number
    maxWaiting: number
    waitEvents: Record<string, number>
  }
  rowAmplification: {
    sourceRows: number
    orderRows: number
    stateRows: number
    headRows: number
    auxiliaryRows: number
    auxiliaryRowsPerSource: number
  }
}

type ProducerEvidence =
  | ({ kind: 'fresh-ready'; dialect: Dialect; variant: Variant } & LoaderReport['producer'])
  | ({
      kind: 'postgres-contention'
      dialect: 'postgres'
      variant: 'base'
    } & ProducerContentionReport)

type ExistingReport = {
  values: Record<'activity' | 'events' | 'note' | 'append', number[]>
}

type LivenessReport = {
  durationSeconds: number
  intervalMs: number
  completed: boolean
  published: boolean
  restarted: boolean
  invalidationRecovered: boolean
  gcDrained: boolean
  referenceMatched: boolean
  blocksOverOneSecond: number
  totalLatenessMs: number
  latenessMaxMs: number
  readyReadMaxMs: number
  readyReadLatenessMaxMs: number
  maxRebuildBatchMs: number
  maxGcBatchMs: number
  phaseObservations: ActivityGroupsBenchReport['heartbeat'][number]['phaseObservations']
  foregroundPoint: { maxMs: number }
  foregroundAppend: { maxMs: number; medianMs: number; p95Ms: number }
  foregroundFailures: string[]
}

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=')
    return [key!, value.join('=')]
  }),
)
const mode = (args.get('mode') ?? 'full') as 'smoke' | 'full'
const requestedDialects = args.get('dialects')
const outputRoot = resolve(args.get('output') ?? 'test-results/activity-groups-gate')
const repoRoot = resolve('.')
const preCommit = '4d824c336927f52df5a671ad4284c772f7183a01'
const fullManifestPath = resolve('test/cases/manifests/activity-groups-v1.json')
const runId = randomUUID().slice(0, 8)

if (!['smoke', 'full'].includes(mode)) {
  throw new Error('--mode must be smoke or full')
}
if (outputRoot === repoRoot || outputRoot === '/' || outputRoot === resolve(tmpdir())) {
  throw new Error(`refusing broad Activity gate output: ${outputRoot}`)
}

mkdirSync(outputRoot, { recursive: true })

const smokeManifest: ActivityGroupsManifest = {
  version: 'activity-groups-v1',
  seed: 41420260830,
  variants: {
    base: {
      liveNotes: 128,
      activeNotes: 100,
      folders: 16,
      sourceBytes: 1_048_576,
      revisions: 1_000,
    },
    'revision-10x': {
      liveNotes: 128,
      activeNotes: 100,
      folders: 16,
      sourceBytes: 1_048_576,
      revisions: 10_000,
    },
    'breadth-10x': {
      liveNotes: 256,
      activeNotes: 200,
      folders: 32,
      sourceBytes: 2_097_152,
      revisions: 2_000,
    },
  },
  hotNotes: { count: 2, revisionPercent: 80 },
  principals: {
    viewerUserPercent: 40,
    viewerAgentPercent: 20,
    otherUserPercent: 20,
    otherAgentPercent: 10,
    trustedExternalPercent: 8,
    gapPercent: 2,
  },
  locations: { rootPercent: 2, unavailablePercent: 2, movedPercent: 5 },
  churnUnknownPercent: 5,
  firstRoleCohort: {
    baselinePercentOfActiveNotes: 10,
    baseBaselineNotes: 10,
    breadthBaselineNotes: 20,
  },
  state: { blobBytes: 256, stateFormat: 'markdown-v2', sqliteBatchRows: 1_000 },
  titleBytes: { '32': 80, '96': 15, '240': 5 },
  tagJsonBytes: { '2': 80, '32': 15, '128': 5 },
}
const manifestPath =
  mode === 'full' ? fullManifestPath : join(outputRoot, 'activity-groups-smoke.json')

if (mode === 'smoke') {
  writeFileSync(manifestPath, `${JSON.stringify(smokeManifest, null, 2)}\n`)
}
const manifestBytes = readFileSync(manifestPath)
const manifest = JSON.parse(manifestBytes.toString('utf8')) as ActivityGroupsManifest
const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
const cycles = 3
const samples = mode === 'full' ? 20 : 2
const livenessDuration = mode === 'full' ? 90 : 3
const dialects: Dialect[] =
  mode === 'full'
    ? ['sqlite', 'postgres']
    : ((requestedDialects?.split(',').filter(Boolean) ?? ['sqlite']) as Dialect[])
const variants: Variant[] = ['base', 'revision-10x', 'breadth-10x']
const sqliteWorkerEntry = resolve('packages/server/dist/activityProjectionWorker.js')
const producerProfile =
  mode === 'full'
    ? ACTIVITY_GROUPS_PRODUCER_PROFILE
    : {
        ...smokeManifest.variants.base,
        baselineNotes: smokeManifest.firstRoleCohort.baseBaselineNotes,
      }
const livenessProfile =
  mode === 'full'
    ? ACTIVITY_GROUPS_LIVENESS_PROFILE
    : {
        ...smokeManifest.variants['revision-10x'],
        baselineNotes: smokeManifest.firstRoleCohort.baseBaselineNotes,
      }
const offlineRebuildBatchSize = mode === 'full' ? ACTIVITY_GROUPS_OFFLINE_REBUILD_BATCH_SIZE : 0
const phaseTimeoutMs = mode === 'full' ? ACTIVITY_GROUPS_PHASE_TIMEOUT_MS : 3 * 60_000

const manifestForProfile = (profile: typeof producerProfile): ActivityGroupsManifest => ({
  ...manifest,
  variants: {
    ...manifest.variants,
    base: {
      liveNotes: profile.liveNotes,
      activeNotes: profile.activeNotes,
      folders: profile.folders,
      sourceBytes: profile.sourceBytes,
      revisions: profile.revisions,
    },
  },
  firstRoleCohort: {
    ...manifest.firstRoleCohort,
    baseBaselineNotes: profile.baselineNotes,
  },
})
const producerManifestPath = join(outputRoot, 'activity-groups-producer.json')
const livenessManifestPath = join(outputRoot, 'activity-groups-liveness.json')

writeFileSync(
  producerManifestPath,
  `${JSON.stringify(manifestForProfile(producerProfile), null, 2)}\n`,
)
writeFileSync(
  livenessManifestPath,
  `${JSON.stringify(manifestForProfile(livenessProfile), null, 2)}\n`,
)

if (!dialects.length || dialects.some((dialect) => !['sqlite', 'postgres'].includes(dialect))) {
  throw new Error('smoke dialects must be sqlite and/or postgres')
}

const run = async (
  command: string,
  commandArgs: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean; timeoutMs?: number } = {},
): Promise<void> => {
  const child = spawn(command, [...commandArgs], {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: options.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
    timeout: options.timeoutMs ?? phaseTimeoutMs,
  })
  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null]

  if (code !== 0) {
    throw new Error(
      `${basename(command)} ${commandArgs[0] ?? ''} ${signal ? `timed out or exited on ${signal}` : `exited ${code}`}`,
    )
  }
}

const runTs = (script: string, scriptArgs: readonly string[], env?: NodeJS.ProcessEnv) =>
  run(process.execPath, ['--import', 'tsx', resolve(script), ...scriptArgs], { env })

const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

const ensureDir = (path: string): string => {
  mkdirSync(path, { recursive: true })
  return path
}

const preRoot = mkdtempSync(join(tmpdir(), 'notarium-414-pre-'))
const archivePath = join(preRoot, 'pre.tar')

const preparePreTree = (): void => {
  const suppliedArchive = process.env.ACTIVITY_GROUPS_PRE_ARCHIVE

  if (suppliedArchive) {
    copyFileSync(suppliedArchive, archivePath)
  } else {
    execFileSync('git', ['archive', '--format=tar', `--output=${archivePath}`, preCommit], {
      cwd: repoRoot,
    })
  }
  execFileSync('tar', ['-xf', archivePath, '-C', preRoot])
  rmSync(archivePath, { force: true })
  const targetModules = ensureDir(join(preRoot, 'node_modules'))
  const sourceModules = join(repoRoot, 'node_modules')

  for (const entry of readdirSync(sourceModules)) {
    if (entry === '@notarium') {
      continue
    }
    symlinkSync(join(sourceModules, entry), join(targetModules, entry), 'junction')
  }
  const notariumModules = ensureDir(join(targetModules, '@notarium'))

  for (const entry of readdirSync(join(preRoot, 'packages'))) {
    const packageJson = join(preRoot, 'packages', entry, 'package.json')

    if (existsSync(packageJson)) {
      symlinkSync(join(preRoot, 'packages', entry), join(notariumModules, entry), 'junction')
    }
  }
}

const pgUrl = process.env.ACTIVITY_GROUPS_PG_URL
const pgContainer = process.env.ACTIVITY_GROUPS_PG_CONTAINER
const runnerContainer = process.env.ACTIVITY_GROUPS_RUNNER_CONTAINER

type RuntimeContainerFacts = {
  Image: string
  HostConfig: { NanoCpus: number; Memory: number }
}

const inspectContainer = (name: string): RuntimeContainerFacts => {
  const inspected = JSON.parse(
    execFileSync('docker', ['inspect', name], { encoding: 'utf8' }),
  ) as RuntimeContainerFacts[]
  const facts = inspected[0]

  if (!facts) {
    throw new Error(`Activity gate container inspection is missing: ${name}`)
  }

  return facts
}

const verifiedRuntimeResources = (): ActivityGroupsBenchReport['resources'] => {
  if (mode !== 'full') {
    return { appCpu: 0, appMemoryMiB: 0, postgresCpu: 0, postgresMemoryMiB: 0 }
  }
  if (!runnerContainer || !pgContainer) {
    throw new Error('full Activity gate requires runner and PostgreSQL container identities')
  }
  const runner = inspectContainer(runnerContainer)
  const postgres = inspectContainer(pgContainer)
  const facts = {
    appCpu: runner.HostConfig.NanoCpus / 1_000_000_000,
    appMemoryMiB: runner.HostConfig.Memory / 1_048_576,
    postgresCpu: postgres.HostConfig.NanoCpus / 1_000_000_000,
    postgresMemoryMiB: postgres.HostConfig.Memory / 1_048_576,
  }

  if (
    facts.appCpu !== 2 ||
    facts.appMemoryMiB !== 2_048 ||
    facts.postgresCpu !== 2 ||
    facts.postgresMemoryMiB !== 2_048
  ) {
    throw new Error(`Activity gate container resources are not enforced: ${JSON.stringify(facts)}`)
  }
  const preImage = process.env.ACTIVITY_GROUPS_PRE_IMAGE
  const postImage = process.env.ACTIVITY_GROUPS_POST_IMAGE
  const postgresImage = process.env.ACTIVITY_GROUPS_PG_IMAGE

  if (
    !preImage?.startsWith(`${runner.Image}+`) ||
    !postImage?.startsWith(`${runner.Image}+`) ||
    postgresImage !== postgres.Image
  ) {
    throw new Error('Activity gate image provenance does not match the running containers')
  }

  return facts
}

const assertPgTarget = (): void => {
  if (!pgUrl || !pgContainer) {
    throw new Error('full gate requires ACTIVITY_GROUPS_PG_URL and ACTIVITY_GROUPS_PG_CONTAINER')
  }
  const parsed = new URL(pgUrl)

  if (parsed.pathname !== `/${ACTIVITY_GROUPS_GATE_DATABASE}`) {
    throw new Error(`Activity gate PostgreSQL database must be ${ACTIVITY_GROUPS_GATE_DATABASE}`)
  }
}

const resetPg = async (): Promise<void> => {
  assertPgTarget()
  const pool = new pg.Pool({ connectionString: pgUrl })

  try {
    const client = await pool.connect()

    try {
      await resetActivityGroupsPgSchemas(client)
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

const pgDumpPath = (label: string): string => `/tmp/notarium-414-${runId}-${label}.dump`
const pgDumpLabels = new Set<string>()

const dumpPg = async (label: string): Promise<void> => {
  assertPgTarget()
  pgDumpLabels.add(label)
  await run('docker', [
    'exec',
    pgContainer!,
    'pg_dump',
    '-Fc',
    '-U',
    'notarium',
    '-d',
    'notarium_activity_gate',
    '-f',
    pgDumpPath(label),
  ])
}

const restorePg = async (label: string): Promise<void> => {
  await resetPg()
  await run('docker', [
    'exec',
    pgContainer!,
    'pg_restore',
    '--no-owner',
    '--no-privileges',
    '-U',
    'notarium',
    '-d',
    'notarium_activity_gate',
    pgDumpPath(label),
  ])
  await run('docker', [
    'exec',
    pgContainer!,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'notarium',
    '-d',
    'notarium_activity_gate',
    '-c',
    'ANALYZE',
  ])
  await run('docker', [
    'exec',
    pgContainer!,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'notarium',
    '-d',
    'notarium_activity_gate',
    '-c',
    'CHECKPOINT',
  ])
}

const loader = async (
  dialect: Dialect,
  variant: Variant,
  root: string,
  deferRebuild: boolean,
  corpusMode: LoaderReport['mode'] = 'upgrade-rebuild',
  selectedManifestPath = manifestPath,
  selectedRebuildBatchSize = 0,
  selectedMigrationCount = 7,
  includeBlobs = true,
): Promise<LoaderReport> => {
  if (dialect === 'postgres') {
    await resetPg()
  }
  const reportPath = join(root, 'loader.json')
  const targetRoot = ensureDir(join(root, 'data'))
  const phase = `${dialect}/${variant}/${corpusMode}${deferRebuild ? '/deferred' : ''}`
  const started = performance.now()

  console.log(`[activity-groups] load start ${phase}`)
  await runTs(
    'scripts/activityGroupsCorpus.ts',
    [
      `--dialect=${dialect}`,
      `--variant=${variant}`,
      `--mode=${corpusMode}`,
      `--defer-rebuild=${deferRebuild}`,
      `--manifest=${selectedManifestPath}`,
      `--rebuild-batch-size=${selectedRebuildBatchSize}`,
      `--migration-count=${selectedMigrationCount}`,
      `--include-blobs=${includeBlobs}`,
      `--output=${targetRoot}`,
      `--report=${reportPath}`,
      ...(dialect === 'sqlite' ? [`--sqlite-worker-entry=${sqliteWorkerEntry}`] : []),
    ],
    dialect === 'postgres'
      ? {
          ACTIVITY_GROUPS_PG_URL: pgUrl,
          ACTIVITY_GROUPS_PG_CONTAINER: pgContainer,
        }
      : undefined,
  )
  const report = json<LoaderReport>(reportPath)

  console.log(
    `[activity-groups] load done ${phase} (${Math.round(performance.now() - started)} ms)`,
  )
  return report
}

type StructureSample = { groups: number; responseItems: number }
const structureSamples = new Map<string, StructureSample>()

const copySqlite = (source: string, target: string): void => {
  copyFileSync(source, target)
  rmSync(`${target}-wal`, { force: true })
  rmSync(`${target}-shm`, { force: true })
}

const measureLatency = async (
  dialect: Dialect,
  variant: Variant,
  target: string,
  root: string,
): Promise<
  Array<
    Omit<ActivityGroupsLatencyCell, 'cycles'> & {
      cycles: Array<{
        coldMs: number
        warmMs: number[]
        productionHeartbeat: ActivityGroupsLatencyCell['cycles'][number]['productionHeartbeat']
        locationChurnMs?: number
      }>
    }
  >
> => {
  const cells: Array<
    Omit<ActivityGroupsLatencyCell, 'cycles'> & {
      cycles: Array<{
        coldMs: number
        warmMs: number[]
        productionHeartbeat: ActivityGroupsLatencyCell['cycles'][number]['productionHeartbeat']
        locationChurnMs?: number
      }>
    }
  > = []
  const pgSnapshotLabel = `latency-${variant}-${runId}`

  if (dialect === 'postgres') {
    await dumpPg(pgSnapshotLabel)
  }

  for (const cut of ['current', 'historical'] as const) {
    for (const by of ['note', 'folder'] as const) {
      for (const scope of ['all', 'mine'] as const) {
        const measuredCycles: Array<{
          coldMs: number
          warmMs: number[]
          productionHeartbeat: ActivityGroupsLatencyCell['cycles'][number]['productionHeartbeat']
          locationChurnMs?: number
        }> = []

        for (let cycle = 0; cycle < cycles; cycle++) {
          const reportPath = join(root, `${cut}-${by}-${scope}-${cycle}.json`)
          let cycleTarget = target

          if (dialect === 'sqlite') {
            cycleTarget = join(root, `${cut}-${by}-${scope}-${cycle}.sqlite`)
            copySqlite(target, cycleTarget)
          } else {
            await restorePg(pgSnapshotLabel)
            cycleTarget = pgUrl!
          }

          await runTs('scripts/activityGroupsMeasure.ts', [
            `--dialect=${dialect}`,
            `--variant=${variant}`,
            `--target=${cycleTarget}`,
            `--output=${reportPath}`,
            `--manifest=${manifestPath}`,
            `--samples=${samples}`,
            `--cut=${cut}`,
            `--by=${by}`,
            `--scope=${scope}`,
            ...(dialect === 'sqlite' ? [`--sqlite-worker-entry=${sqliteWorkerEntry}`] : []),
          ])
          const measureReport = json<MeasureReport>(reportPath)

          if (dialect === 'sqlite') {
            rmSync(cycleTarget, { force: true })
            rmSync(`${cycleTarget}-wal`, { force: true })
            rmSync(`${cycleTarget}-shm`, { force: true })
          }
          const result = measureReport.cells[0]

          if (
            measureReport.consumerPath.join('/') !==
            'fastify-rest-wire/cached-store/history-surface/revision-journal'
          ) {
            throw new Error(`latency report bypassed the production consumer: ${reportPath}`)
          }
          if (measureReport.coldProtocol !== 'background-maintenance-held-until-after-cold') {
            throw new Error(`latency report did not preserve the cold worker path: ${reportPath}`)
          }

          if (!result || result.warm.length !== samples) {
            throw new Error(
              `invalid latency report ${dialect}/${variant}/${cut}/${by}/${scope}/${cycle}`,
            )
          }
          measuredCycles.push({
            coldMs: result.cold.elapsedMs,
            warmMs: result.warm.map(({ elapsedMs }) => elapsedMs),
            productionHeartbeat: result.productionHeartbeat,
            ...(result.locationChurn ? { locationChurnMs: result.locationChurn.elapsedMs } : {}),
          })
          if (
            cut === 'current' &&
            (!result.locationChurn ||
              result.locationChurn.responseItems < 1 ||
              result.locationChurn.locationThrough === result.cold.locationThrough)
          ) {
            throw new Error(`current-location churn was not observed: ${reportPath}`)
          }
          if (cut === 'current' && by === 'note' && scope === 'all' && cycle === 0) {
            const observed = result.warm[0] ?? result.cold
            structureSamples.set(`${dialect}/${variant}`, {
              groups: observed.groups,
              responseItems: observed.responseItems,
            })
          }
        }
        cells.push({ dialect, variant, cut, by, scope, cycles: measuredCycles })
      }
    }
  }

  return cells
}

const existingRuns = async (
  dialect: Dialect,
  baselineTarget: string,
  candidateTarget: string,
  root: string,
): Promise<ActivityGroupsBenchReport['existing']> => {
  const pooled = {
    baseline: { activity: [], events: [], note: [], append: [] } as ExistingReport['values'],
    candidate: { activity: [], events: [], note: [], append: [] } as ExistingReport['values'],
  }
  const orders = [
    ['baseline', 'candidate'],
    ['candidate', 'baseline'],
    ['baseline', 'candidate'],
  ] as const

  for (let cycle = 0; cycle < orders.length; cycle++) {
    for (const phase of orders[cycle]) {
      let target = phase === 'baseline' ? baselineTarget : candidateTarget

      if (dialect === 'sqlite') {
        target = join(root, `${phase}-${cycle}.sqlite`)
        copySqlite(phase === 'baseline' ? baselineTarget : candidateTarget, target)
      } else {
        await restorePg(phase)
        target = pgUrl!
      }
      const output = join(root, `${phase}-${cycle}.json`)
      await runTs('scripts/activityGroupsExistingMeasure.ts', [
        `--phase=${phase}`,
        `--dialect=${dialect}`,
        `--target=${target}`,
        `--output=${output}`,
        `--source-root=${phase === 'baseline' ? preRoot : repoRoot}`,
        `--samples=${samples}`,
      ])
      const result = json<ExistingReport>(output)

      for (const surface of ['activity', 'events', 'note', 'append'] as const) {
        pooled[phase][surface].push(...result.values[surface])
      }
    }
  }

  return (['activity', 'events', 'note', 'append'] as const).map((surface) => {
    const baseline = pooled.baseline[surface]
    const candidate = pooled.candidate[surface]
    return {
      dialect,
      surface,
      baselineMedianMs: nearestRank(baseline, 0.5),
      baselineP95Ms: nearestRank(baseline, 0.95),
      candidateMedianMs: nearestRank(candidate, 0.5),
      candidateP95Ms: nearestRank(candidate, 0.95),
      candidateMaxMs: Math.max(...candidate),
    }
  })
}

const liveness = async (
  dialect: Dialect,
  variant: Variant,
  root: string,
  appendBaseline: ActivityGroupsBenchReport['existing'][number],
  selectedManifestPath: string,
): Promise<ActivityGroupsBenchReport['heartbeat'][number]> => {
  const source = await loader(
    dialect,
    variant,
    root,
    true,
    'upgrade-rebuild',
    selectedManifestPath,
    0,
    7,
    false,
  )
  const output = join(root, 'liveness.json')
  await runTs('scripts/activityProjectionRebuildMeasure.ts', [
    `--dialect=${dialect}`,
    `--target=${source.target}`,
    `--output=${output}`,
    `--duration-seconds=${livenessDuration}`,
    '--foreground=true',
    ...(dialect === 'sqlite' ? [`--sqlite-worker-entry=${sqliteWorkerEntry}`] : []),
  ])
  const result = json<LivenessReport>(output)

  if (result.foregroundFailures.length) {
    throw new Error(`${dialect} foreground failures: ${result.foregroundFailures.join('; ')}`)
  }

  return {
    dialect,
    sourceRows: source.shape.revisions,
    liveNotes: source.shape.liveNotes,
    durationSeconds: result.durationSeconds,
    intervalMs: result.intervalMs,
    completed: result.completed,
    published: result.published,
    restarted: result.restarted,
    invalidationRecovered: result.invalidationRecovered,
    gcDrained: result.gcDrained,
    referenceMatched: result.referenceMatched,
    blocksOverOneSecond: result.blocksOverOneSecond,
    totalLatenessMs: result.totalLatenessMs,
    responseMaxMs: result.maxRebuildBatchMs,
    latenessMaxMs: result.latenessMaxMs,
    readyReadMaxMs: result.readyReadMaxMs,
    readyReadLatenessMaxMs: result.readyReadLatenessMaxMs,
    pairedBaselineResponseMaxMs: result.foregroundPoint.maxMs,
    pairedBaselineLatenessMaxMs: 0,
    baselineAppendMedianMs: appendBaseline.baselineMedianMs,
    baselineAppendP95Ms: appendBaseline.baselineP95Ms,
    appendMedianMs: result.foregroundAppend.medianMs,
    appendP95Ms: result.foregroundAppend.p95Ms,
    appendMaxMs: result.foregroundAppend.maxMs,
    maxGcBatchMs: result.maxGcBatchMs,
    phaseObservations: result.phaseObservations,
  }
}

const storageOf = async (
  dialect: Dialect,
  variant: Variant,
  target: string,
): Promise<ActivityGroupsBenchReport['storage'][number]> => {
  const tables = {
    statusRows: 'activity_projection_status',
    orderRows: 'activity_revision_order',
    stateRows: 'activity_note_actor_states',
    headRows: 'activity_note_actor_heads',
    gcRows: 'activity_projection_gc',
  } as const

  if (dialect === 'sqlite') {
    const db = new DatabaseSync(target, { readOnly: true })

    try {
      const bytes = (tablePredicate: string): number =>
        Number(
          (
            db
              .prepare(
                `SELECT COALESCE(SUM(stats.pgsize), 0) AS bytes
                   FROM dbstat AS stats
                   JOIN sqlite_schema AS schema ON schema.name = stats.name
                  WHERE ${tablePredicate}`,
              )
              .get() as { bytes: number }
          ).bytes,
        )
      const counts = Object.fromEntries(
        Object.entries(tables).map(([field, table]) => [
          field,
          Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n),
        ]),
      ) as Record<keyof typeof tables, number>

      return {
        dialect,
        variant,
        journalBytes: bytes(
          "schema.tbl_name IN ('note_revisions', 'revision_blobs', 'revision_heads')",
        ),
        projectionBytes: bytes("schema.tbl_name LIKE 'activity_%'"),
        ...counts,
      }
    } finally {
      db.close()
    }
  }

  const pool = new pg.Pool({ connectionString: target })

  try {
    const relationBytes = async (tablesToMeasure: readonly string[]): Promise<number> => {
      const result = await pool.query(
        `SELECT COALESCE(SUM(pg_total_relation_size(name::regclass)), 0)::text AS bytes
           FROM unnest($1::text[]) AS relation(name)`,
        [tablesToMeasure],
      )
      return Number(result.rows[0].bytes)
    }
    const counts = {} as Record<keyof typeof tables, number>

    for (const [field, table] of Object.entries(tables) as Array<[keyof typeof tables, string]>) {
      counts[field] = Number(
        (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n,
      )
    }

    return {
      dialect,
      variant,
      journalBytes: await relationBytes(['note_revisions', 'revision_blobs', 'revision_heads']),
      projectionBytes: await relationBytes(Object.values(tables)),
      ...counts,
    }
  } finally {
    await pool.end()
  }
}

const sourceStructure = () => auditActivityGroupSections(loadActivityGroupProductionSources())

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const NEGATIVE_PROOF_TITLES = {
  'raw-before-group': 'rejects raw-before-group by retaining a peer displaced from the raw page',
  'eager-raw-array': 'rejects an eager raw Activity array',
  'query-per-group': 'rejects query-per-group',
  'duplicate-scan': 'rejects duplicate overview scans',
  'number-cursor': 'keeps a bigint cursor exact',
  'unbounded-page': 'rejects an unbounded grouped page',
} as const

const SQLITE_PROOF_TITLES = {
  migrationCarrier:
    'installs the Activity carrier without reading or initializing existing journal spaces',
  producerAtomicity:
    'rolls back every fresh Activity effect when the projection trigger tail fails',
  sourceOrder:
    'atomically advances the fresh Activity order, state and head and invalidates on rewrite',
  upgradedRebuild:
    'lazily rebuilds exactly one upgraded Activity space and publishes its generation',
  workerErrors: 'preserves Activity errors and closes its dedicated connection',
  workerRecovery: 'resumes a durable rebuild cursor after replacing the worker and main connection',
  workerBusy: 'turns foreground SQLite writer contention into a retryable empty GC turn',
  historicalReference:
    'serves current and historical unbounded Activity from one stable projection lease',
  boundedRaw: 'keeps bounded raw events available while every grouped SQLite read rebuilds',
  pgLostGeneration: 'rolls back a progress batch when source invalidation retires its generation',
} as const

const POSTGRES_PROOF_TITLES = {
  commitOrder: 'orders post-carrier revisions by the trigger tail instead of raw id allocation',
  producerAtomicity:
    'rolls back every fresh PostgreSQL Activity effect when the trigger tail fails',
  upgradedRebuild: 'lazily rebuilds one upgraded Activity space and leaves siblings uninitialized',
  historicalReference:
    'serves current and historical unbounded Activity from one stable projection lease',
  boundedRaw: 'keeps bounded raw events available while every grouped Postgres read rebuilds',
} as const

const runProofSuite = async (
  label: string,
  files: readonly string[],
  expectedTitles: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<Set<string>> => {
  const proofRoot = ensureDir(join(outputRoot, 'proofs'))
  const reportPath = join(proofRoot, `${label}.json`)
  const vitest = resolve('node_modules/vitest/vitest.mjs')

  await run(
    process.execPath,
    [
      vitest,
      'run',
      ...(label === 'postgres' ? ['--no-file-parallelism'] : []),
      ...files,
      '--testNamePattern',
      expectedTitles.map(escapeRegExp).join('|'),
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ],
    { env },
  )
  const result = json<ActivityGroupsProofTestReport>(reportPath)
  const failures = activityGroupsProofFailures(result, expectedTitles)

  if (failures.length) {
    throw new Error(
      `Activity ${label} proof suite is incomplete:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    )
  }

  return new Set(expectedTitles)
}

const productionProofs = async (): Promise<{
  proofs: ActivityGroupsBenchReport['proofs']
  faultInjectionFailures: ActivityGroupsBenchReport['structure']['faultInjectionFailures']
}> => {
  const sqliteExpected = [
    ...Object.values(NEGATIVE_PROOF_TITLES),
    ...Object.values(SQLITE_PROOF_TITLES),
  ]
  const verified = await runProofSuite(
    'sqlite',
    [
      'test/unit/activityGroupsNegativeStrategies.test.ts',
      'test/unit/metaDbMigrations.test.ts',
      'packages/server/src/services/metaDb/drivers/pg/activityProjection.test.ts',
      'packages/server/src/services/metaDb/drivers/sqlite/activityWorker/activityWorker.test.ts',
      'test/meta-db-contract/sqlite.test.ts',
    ],
    sqliteExpected,
  )

  if (dialects.includes('postgres')) {
    const pgVerified = await runProofSuite(
      'postgres',
      [
        'test/meta-db-contract/postgresMigrations.test.ts',
        'test/meta-db-contract/postgres.test.ts',
      ],
      Object.values(POSTGRES_PROOF_TITLES),
      { TEST_PG_URL: pgUrl },
    )

    for (const title of pgVerified) {
      verified.add(title)
    }
  }

  const postgresRequired = (title: string): boolean =>
    !dialects.includes('postgres') || verified.has(title)

  return {
    proofs: {
      migrationCarrier: verified.has(SQLITE_PROOF_TITLES.migrationCarrier),
      producerAtomicity:
        verified.has(SQLITE_PROOF_TITLES.producerAtomicity) &&
        postgresRequired(POSTGRES_PROOF_TITLES.producerAtomicity),
      commitOrder:
        verified.has(SQLITE_PROOF_TITLES.sourceOrder) &&
        postgresRequired(POSTGRES_PROOF_TITLES.commitOrder),
      currentHistoricalReference:
        verified.has(SQLITE_PROOF_TITLES.historicalReference) &&
        postgresRequired(POSTGRES_PROOF_TITLES.historicalReference),
      workerRecovery:
        verified.has(SQLITE_PROOF_TITLES.workerErrors) &&
        verified.has(SQLITE_PROOF_TITLES.workerRecovery) &&
        verified.has(SQLITE_PROOF_TITLES.workerBusy),
    },
    faultInjectionFailures: Object.fromEntries(
      Object.entries(NEGATIVE_PROOF_TITLES).map(([fault, title]) => [fault, verified.has(title)]),
    ) as ActivityGroupsBenchReport['structure']['faultInjectionFailures'],
  }
}

const worktreeDigest = (): string => {
  if (process.env.ACTIVITY_GROUPS_POST_TREE) {
    return process.env.ACTIVITY_GROUPS_POST_TREE
  }
  const hash = createHash('sha256')
  hash.update(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repoRoot }))
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort()

  for (const relative of untracked) {
    hash.update(relative)
    hash.update(readFileSync(join(repoRoot, relative)))
  }

  return `worktree:${hash.digest('hex')}`
}

const cleanup = async (): Promise<void> => {
  if (pgContainer) {
    for (const label of pgDumpLabels) {
      await run('docker', ['exec', pgContainer, 'rm', '-f', pgDumpPath(label)], {
        quiet: true,
      }).catch(() => {})
    }
  }
  rmSync(preRoot, { recursive: true, force: true })
}

const execute = async (): Promise<void> => {
  const runtimeResources = verifiedRuntimeResources()

  if (mode === 'full') {
    assertPgTarget()
    if (process.env.ACTIVITY_GROUPS_RESOURCES_ENFORCED !== 'true') {
      throw new Error('full Activity gate requires enforced 2 vCPU / 2 GiB runner resources')
    }
    if (manifestSha256 !== ACTIVITY_GROUPS_MANIFEST_SHA256) {
      throw new Error('full Activity gate requires the pinned manifest')
    }
  }
  preparePreTree()
  if (dialects.includes('sqlite') && !existsSync(sqliteWorkerEntry)) {
    throw new Error(`bundled SQLite Activity worker is missing: ${sqliteWorkerEntry}`)
  }
  const proofRun = await productionProofs()
  const corpus: ActivityGroupsBenchReport['corpus'] = []
  const latency: ActivityGroupsBenchReport['latency'] = []
  const existing: ActivityGroupsBenchReport['existing'] = []
  const heartbeat: ActivityGroupsBenchReport['heartbeat'] = []
  const storage: ActivityGroupsBenchReport['storage'] = []
  const producer: ProducerEvidence[] = []
  let observedLoaderVersion: string | null = null

  for (const dialect of dialects) {
    const dialectRoot = ensureDir(join(outputRoot, dialect))
    const producerRoot = ensureDir(join(dialectRoot, 'fresh-ready-bounded'))
    const fresh = await loader(
      dialect,
      'base',
      producerRoot,
      false,
      'fresh-ready',
      producerManifestPath,
    )

    if (fresh.mode !== 'fresh-ready' || fresh.producer.sourceRows !== fresh.shape.revisions) {
      throw new Error(`${dialect}/bounded fresh-ready producer evidence is incomplete`)
    }
    const minimumHeadRows = minimumActivityGroupsProducerHeadRows({
      activeNotes: fresh.shape.activeNotes,
      baselineNotes: fresh.baselineNotes,
    })
    console.log(
      `[activity-groups] ${dialect}/bounded producer ${JSON.stringify({
        ...fresh.producer,
        minimumHeadRows,
      })}`,
    )
    if (
      fresh.producer.statusRows !== 1 ||
      fresh.producer.orderRows !== fresh.shape.revisions ||
      fresh.producer.stateRows !== fresh.shape.revisions - fresh.baselineNotes ||
      fresh.producer.headRows < minimumHeadRows ||
      !Number.isInteger(fresh.producer.transactions) ||
      fresh.producer.transactions <= 0
    ) {
      throw new Error(`${dialect}/bounded fresh-ready producer cardinality is invalid`)
    }
    if (
      fresh.producer.auxiliaryRows !==
        fresh.producer.orderRows + fresh.producer.stateRows + fresh.producer.headRows ||
      fresh.producer.auxiliaryRowsPerSource !==
        fresh.producer.auxiliaryRows / fresh.producer.sourceRows
    ) {
      throw new Error(`${dialect}/bounded fresh-ready write amplification is invalid`)
    }
    producer.push({ kind: 'fresh-ready', dialect, variant: 'base', ...fresh.producer })

    if (dialect === 'postgres') {
      const contentionPath = join(producerRoot, 'contention.json')

      await runTs('scripts/activityGroupsPgProducerContention.ts', [
        `--target=${fresh.target}`,
        `--output=${contentionPath}`,
        `--writes=${mode === 'full' ? 128 : 16}`,
        `--concurrency=${mode === 'full' ? 10 : 4}`,
      ])
      producer.push({
        kind: 'postgres-contention',
        dialect: 'postgres',
        variant: 'base',
        ...json<ProducerContentionReport>(contentionPath),
      })
    }
    const baselineRoot = ensureDir(join(dialectRoot, 'baseline-base'))
    // The immutable pre tree knows the published 0000..0004 ladder only. A raw
    // comparison snapshot carrying later main migrations fails closed there as an
    // unknown future schema before any endpoint can be measured.
    const baseline = await loader(
      dialect,
      'base',
      baselineRoot,
      true,
      'upgrade-rebuild',
      manifestPath,
      0,
      5,
      false,
    )

    if (dialect === 'postgres') {
      await dumpPg('baseline')
    }
    let candidateBase: LoaderReport | null = null
    const measuredVariants = dialect === 'sqlite' ? variants : (['base'] as const)

    for (const variant of measuredVariants) {
      const variantRoot = ensureDir(join(dialectRoot, variant))
      const candidate = await loader(
        dialect,
        variant,
        variantRoot,
        false,
        'upgrade-rebuild',
        manifestPath,
        offlineRebuildBatchSize,
        7,
        false,
      )

      if (observedLoaderVersion && observedLoaderVersion !== candidate.loaderVersion) {
        throw new Error('Activity corpus loader version drifted within one gate run')
      }
      observedLoaderVersion = candidate.loaderVersion

      if (variant === 'base') {
        candidateBase = candidate
        if (dialect === 'postgres') {
          await dumpPg('candidate')
        }
      }
      corpus.push({
        dialect,
        variant,
        ...candidate.shape,
        baselineNotes: candidate.baselineNotes,
        originNotes: candidate.originNotes,
        gaps: candidate.gaps,
        cleanStop: candidate.cleanClose,
      })
      storage.push(await storageOf(dialect, variant, candidate.target))
      latency.push(
        ...(await measureLatency(
          dialect,
          variant,
          candidate.target,
          ensureDir(join(variantRoot, 'latency')),
        )),
      )
    }
    if (!candidateBase) {
      throw new Error(`${dialect} candidate base was not generated`)
    }
    if (dialect === 'postgres') {
      await restorePg('candidate')
    }
    const dialectExisting = await existingRuns(
      dialect,
      baseline.target,
      candidateBase.target,
      ensureDir(join(dialectRoot, 'existing')),
    )
    existing.push(...dialectExisting)
    const appendBaseline = dialectExisting.find(({ surface }) => surface === 'append')

    if (!appendBaseline) {
      throw new Error(`${dialect} append baseline is missing`)
    }
    heartbeat.push(
      await liveness(
        dialect,
        'base',
        ensureDir(join(dialectRoot, 'liveness')),
        appendBaseline,
        livenessManifestPath,
      ),
    )
  }

  const source = sourceStructure()

  if (source.missingProductionLayers.length) {
    throw new Error(
      `Activity production source chain is incomplete: ${source.missingProductionLayers.join(', ')}`,
    )
  }
  const structureDialect = dialects.includes('sqlite') ? 'sqlite' : dialects[0]!
  const baseSample = structureSamples.get(`${structureDialect}/base`)
  const revisionSample =
    structureSamples.get(`${structureDialect}/revision-10x`) ??
    (mode === 'smoke' ? baseSample : undefined)

  if (!baseSample || !revisionSample) {
    throw new Error(`${structureDialect} base/revision structure samples are missing`)
  }
  const report: ActivityGroupsBenchReport = {
    scenario: 'activity-groups-v1',
    manifest: { sha256: manifestSha256, version: manifest.version },
    provenance: {
      preCommit,
      postCommit: worktreeDigest(),
      preImage: process.env.ACTIVITY_GROUPS_PRE_IMAGE ?? 'source-tree:git-archive',
      postImage: process.env.ACTIVITY_GROUPS_POST_IMAGE ?? `node:${process.version}`,
      postgresImage: process.env.ACTIVITY_GROUPS_PG_IMAGE ?? 'postgres:16-alpine',
      loaderVersion: observedLoaderVersion ?? 'missing',
      migrationsChecksum: createHash('sha256')
        .update(readFileSync('packages/server/src/services/metaDb/migrations/manifest.json'))
        .digest('hex'),
    },
    resources: runtimeResources,
    profiles: {
      producer: producerProfile,
      liveness: livenessProfile,
      offlineRebuildBatchSize,
      phaseTimeoutMs,
      deepCorpusBlobs: false,
      dialectsParallel: false,
      deepDialects: ['sqlite'],
    },
    corpus,
    latency,
    existing,
    heartbeat,
    storage,
    producer,
    proofs: proofRun.proofs,
    structure: {
      ...source,
      faultInjectionFailures: proofRun.faultInjectionFailures,
      retainedGroupsBase: baseSample.groups,
      retainedGroupsRevision10x: revisionSample.groups,
      responseItemsBase: baseSample.responseItems,
      responseItemsRevision10x: revisionSample.responseItems,
    },
  }
  const reportPath = join(outputRoot, 'report.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  if (mode === 'full') {
    const failures = activityGroupsGateFailures(report, manifest)

    if (failures.length) {
      throw new Error(
        `Activity groups gate failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
      )
    }
  } else {
    const measuredVariantCount = dialects.reduce(
      (total, dialect) => total + (dialect === 'sqlite' ? 3 : 1),
      0,
    )

    if (
      report.corpus.length !== measuredVariantCount ||
      report.latency.length !== measuredVariantCount * 8 ||
      report.existing.length !== dialects.length * 4 ||
      report.heartbeat.length !== dialects.length ||
      report.storage.length !== measuredVariantCount ||
      report.producer.filter(({ kind }) => kind === 'fresh-ready').length !== dialects.length ||
      (dialects.includes('postgres') &&
        report.producer.filter(({ kind }) => kind === 'postgres-contention').length !== 1) ||
      report.heartbeat.some(({ blocksOverOneSecond }) => blocksOverOneSecond !== 0) ||
      report.heartbeat.some(
        ({ maxGcBatchMs, phaseObservations }) =>
          !Number.isFinite(maxGcBatchMs) || maxGcBatchMs <= 0 || phaseObservations.length !== 6,
      ) ||
      report.latency.some(({ cut, cycles }) =>
        cut === 'current'
          ? cycles.some(
              ({ locationChurnMs }) => locationChurnMs == null || !Number.isFinite(locationChurnMs),
            )
          : false,
      ) ||
      report.structure.missingProductionLayers.length !== 0 ||
      report.heartbeat.some(
        ({ completed, published, restarted, invalidationRecovered, gcDrained, referenceMatched }) =>
          !completed ||
          !published ||
          !restarted ||
          !invalidationRecovered ||
          !gcDrained ||
          !referenceMatched,
      ) ||
      Object.values(report.structure.faultInjectionFailures).some((rejected) => !rejected)
    ) {
      throw new Error('Activity groups smoke evidence is incomplete')
    }
    const smokeFailures = activityGroupsSmokeFailures(report)

    if (smokeFailures.length) {
      throw new Error(
        `Activity groups smoke liveness failed:\n${smokeFailures.map((failure) => `- ${failure}`).join('\n')}`,
      )
    }
    const smokeWarnings = activityGroupsSmokeWarnings(report)

    if (smokeWarnings.length) {
      console.warn(
        `Activity groups uncapped smoke performance warnings:\n${smokeWarnings.map((warning) => `- ${warning}`).join('\n')}`,
      )
    }
  }
  console.log(`activity groups ${mode} gate passed: ${reportPath}`)
}

try {
  await execute()
} finally {
  await cleanup()
}
