export const ACTIVITY_GROUPS_MANIFEST_SHA256 =
  '67b78c3a2646d10fe83135fad5a5c271be27b46f9b37e48dc82fb9d9f4adbdcb'

export const ACTIVITY_GROUPS_PRODUCER_PROFILE = {
  liveNotes: 4_096,
  activeNotes: 4_000,
  folders: 512,
  sourceBytes: 25_165_824,
  revisions: 10_000,
  baselineNotes: 400,
} as const

export const ACTIVITY_GROUPS_LIVENESS_PROFILE = {
  liveNotes: 10_000,
  activeNotes: 10_000,
  folders: 1_250,
  sourceBytes: 25_165_824,
  revisions: 10_000,
  baselineNotes: 1_000,
} as const

export const ACTIVITY_GROUPS_OFFLINE_REBUILD_BATCH_SIZE = 100_000
export const ACTIVITY_GROUPS_PHASE_TIMEOUT_MS = 8 * 60_000

type ActivityGroupsExecutionProfile = {
  liveNotes: number
  activeNotes: number
  folders: number
  sourceBytes: number
  revisions: number
  baselineNotes: number
}

export const minimumActivityGroupsProducerHeadRows = (
  profile: Pick<ActivityGroupsExecutionProfile, 'activeNotes' | 'baselineNotes'>,
): number => profile.activeNotes - profile.baselineNotes

export type ActivityGroupsManifest = {
  version: 'activity-groups-v1'
  seed: number
  variants: Record<
    'base' | 'revision-10x' | 'breadth-10x',
    {
      liveNotes: number
      activeNotes: number
      folders: number
      sourceBytes: number
      revisions: number
    }
  >
  hotNotes: { count: number; revisionPercent: number }
  principals: {
    viewerUserPercent: number
    viewerAgentPercent: number
    otherUserPercent: number
    otherAgentPercent: number
    trustedExternalPercent: number
    gapPercent: number
  }
  locations: { rootPercent: number; unavailablePercent: number; movedPercent: number }
  churnUnknownPercent: number
  firstRoleCohort: {
    baselinePercentOfActiveNotes: number
    baseBaselineNotes: number
    breadthBaselineNotes: number
  }
  state: { blobBytes: number; stateFormat: string; sqliteBatchRows: number }
  titleBytes: Record<'32' | '96' | '240', number>
  tagJsonBytes: Record<'2' | '32' | '128', number>
}

export type ActivityGroupsLatencyCell = {
  dialect: 'sqlite' | 'postgres'
  variant: 'base' | 'revision-10x' | 'breadth-10x'
  cut: 'current' | 'historical'
  by: 'note' | 'folder'
  scope: 'all' | 'mine'
  cycles: Array<{
    coldMs: number
    warmMs: number[]
    /** Event-loop sampling around the complete production route, including the
     * main-thread current-location join and Note/Folder shaping. */
    productionHeartbeat: {
      productionTurns: number
      timerActiveTurns: number
      heartbeatSamples: number
      blocksOverOneSecond: number
      totalLatenessMs: number
      latenessMaxMs: number
    }
    /** Production Fastify/CachedStore turn after a real current-location move.
     * Present only for current-cut cells. */
    locationChurnMs?: number
  }>
}

type ActivityGroupsVariant = 'base' | 'revision-10x' | 'breadth-10x'
type ActivityGroupsDialect = 'sqlite' | 'postgres'

const ACTIVITY_GROUP_PROOF_KEYS = [
  'migrationCarrier',
  'producerAtomicity',
  'commitOrder',
  'currentHistoricalReference',
  'workerRecovery',
] as const

const ACTIVITY_GROUP_FAULT_KEYS = [
  'raw-before-group',
  'eager-raw-array',
  'query-per-group',
  'duplicate-scan',
  'number-cursor',
  'unbounded-page',
] as const

export type ActivityGroupsProducerEvidence =
  | {
      kind: 'fresh-ready'
      dialect: ActivityGroupsDialect
      variant: ActivityGroupsVariant
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
  | {
      kind: 'postgres-contention'
      dialect: 'postgres'
      variant: 'base'
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

export type ActivityGroupsProofTestReport = {
  testResults: Array<{
    assertionResults: Array<{ title: string; status: string }>
  }>
}

/** Every declared proof title must resolve to exactly one passed assertion.
 * A renamed/removed/skipped test and a duplicate title are both fail-closed: the
 * report cannot infer evidence from the rest of a green combined test process. */
export const activityGroupsProofFailures = (
  report: ActivityGroupsProofTestReport,
  expectedTitles: readonly string[],
): string[] => {
  const assertions = report.testResults.flatMap(({ assertionResults }) => assertionResults)

  return expectedTitles.flatMap((title) => {
    const matches = assertions.filter((assertion) => assertion.title === title)

    return matches.length === 1 && matches[0]?.status === 'passed'
      ? []
      : [`proof assertion must pass exactly once: ${title}`]
  })
}

export type ActivityGroupsBenchReport = {
  scenario: 'activity-groups-v1'
  manifest: { sha256: string; version: string }
  provenance: {
    preCommit: string
    postCommit: string
    preImage: string
    postImage: string
    postgresImage: string
    loaderVersion: string
    migrationsChecksum: string
  }
  resources: {
    appCpu: number
    appMemoryMiB: number
    postgresCpu: number
    postgresMemoryMiB: number
  }
  profiles: {
    producer: ActivityGroupsExecutionProfile
    liveness: ActivityGroupsExecutionProfile
    offlineRebuildBatchSize: number
    phaseTimeoutMs: number
    deepCorpusBlobs: boolean
    dialectsParallel: boolean
    deepDialects: ActivityGroupsDialect[]
  }
  corpus: Array<{
    dialect: 'sqlite' | 'postgres'
    variant: 'base' | 'revision-10x' | 'breadth-10x'
    liveNotes: number
    activeNotes: number
    folders: number
    sourceBytes: number
    revisions: number
    baselineNotes: number
    originNotes: number
    gaps: number
    cleanStop: boolean
  }>
  latency: ActivityGroupsLatencyCell[]
  existing: Array<{
    dialect: 'sqlite' | 'postgres'
    surface: 'activity' | 'events' | 'note' | 'append'
    baselineMedianMs: number
    baselineP95Ms: number
    candidateMedianMs: number
    candidateP95Ms: number
    candidateMaxMs: number
  }>
  heartbeat: Array<{
    dialect: 'sqlite' | 'postgres'
    sourceRows: number
    liveNotes: number
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
    responseMaxMs: number
    latenessMaxMs: number
    readyReadMaxMs: number
    readyReadLatenessMaxMs: number
    pairedBaselineResponseMaxMs: number
    pairedBaselineLatenessMaxMs: number
    baselineAppendMedianMs: number
    baselineAppendP95Ms: number
    appendMedianMs: number
    appendP95Ms: number
    appendMaxMs: number
    maxGcBatchMs: number
    phaseObservations: Array<{
      phase:
        | 'paced-rebuild'
        | 'near-publication-invalidation'
        | 'restart'
        | 'replacement-publication'
        | 'generation-gc'
        | 'ready-reads'
      durationMs: number
      workUnits: number
      heartbeatSamples: number
      blocksOverOneSecond: number
      totalLatenessMs: number
      latenessMaxMs: number
      responseMaxMs: number
      foregroundPoint: {
        count: number
        medianMs: number
        p95Ms: number
        maxMs: number
      }
      foregroundAppend: {
        count: number
        medianMs: number
        p95Ms: number
        maxMs: number
      }
    }>
  }>
  storage: Array<{
    dialect: 'sqlite' | 'postgres'
    variant: 'base' | 'revision-10x' | 'breadth-10x'
    journalBytes: number
    projectionBytes: number
    statusRows: number
    orderRows: number
    stateRows: number
    headRows: number
    gcRows: number
  }>
  producer: ActivityGroupsProducerEvidence[]
  proofs: {
    migrationCarrier: boolean
    producerAtomicity: boolean
    commitOrder: boolean
    currentHistoricalReference: boolean
    workerRecovery: boolean
  }
  structure: {
    bodyReads: number
    rawRevisionMaterializations: number
    queryPerGroup: number
    duplicateOverviewScans: number
    retainedGroupsBase: number
    retainedGroupsRevision10x: number
    responseItemsBase: number
    responseItemsRevision10x: number
    missingProductionLayers: string[]
    faultInjectionFailures: Record<
      | 'raw-before-group'
      | 'eager-raw-array'
      | 'query-per-group'
      | 'duplicate-scan'
      | 'number-cursor'
      | 'unbounded-page',
      boolean
    >
  }
}

export const nearestRank = (values: readonly number[], percentile: number): number => {
  if (!values.length) {
    return Number.NaN
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!
}

const median = (values: readonly number[]): number => nearestRank(values, 0.5)
const p95 = (values: readonly number[]): number => nearestRank(values, 0.95)
const max = (values: readonly number[]): number => Math.max(...values)
const finiteNonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const PRODUCTION_MAX_LATENESS_MS = 100
const PRODUCTION_DEBT_PER_TURN_MS = 25
const expectedProductionTurns = (
  cell: ActivityGroupsLatencyCell,
  cycle: ActivityGroupsLatencyCell['cycles'][number],
): number => 1 + 3 + cycle.warmMs.length + (cell.cut === 'current' ? 1 : 0)
const productionDebtLimit = (
  cell: ActivityGroupsLatencyCell,
  cycle: ActivityGroupsLatencyCell['cycles'][number],
): number => expectedProductionTurns(cell, cycle) * PRODUCTION_DEBT_PER_TURN_MS

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactTrueRecordFailures = (
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
  rejectedMessage: (key: string) => string,
): string[] => {
  if (!isRecord(value)) {
    return [`${label} must be an object with the exact required keys`]
  }
  const failures: string[] = []
  const actualKeys = Object.keys(value)

  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      failures.push(`${label} is missing required key: ${key}`)
    }
    if (value[key] !== true) {
      failures.push(rejectedMessage(key))
    }
  }
  for (const key of actualKeys) {
    if (!expectedKeys.includes(key)) {
      failures.push(`${label} has unexpected key: ${key}`)
    }
  }

  return failures
}

/** Smoke is not a resource-qualified performance verdict, but an event-loop
 * block invalidates its liveness evidence on any host. Recovery phases live in
 * their own observations, so the paced top-level aggregate is not sufficient. */
export const activityGroupsSmokeFailures = (report: ActivityGroupsBenchReport): string[] => [
  ...report.heartbeat.flatMap((heartbeat) =>
    heartbeat.phaseObservations.flatMap((phase) => {
      const label = `${heartbeat.dialect}/${phase.phase}`
      const failures: string[] = []

      if (phase.blocksOverOneSecond !== 0) {
        failures.push(`${label} smoke heartbeat blocked over one second`)
      }
      if (!finiteNonnegative(phase.latenessMaxMs) || phase.latenessMaxMs >= 1_000) {
        failures.push(`${label} smoke heartbeat lateness must be finite and below 1000 ms`)
      }

      return failures
    }),
  ),
  ...report.latency.flatMap((cell) =>
    cell.cycles.flatMap((cycle, cycleIndex) => {
      const label = `${cell.dialect}/${cell.variant}/${cell.cut}/${cell.by}/${cell.scope}`
      const heartbeat = cycle.productionHeartbeat
      const failures: string[] = []

      if (heartbeat.blocksOverOneSecond !== 0 || heartbeat.latenessMaxMs >= 1_000) {
        failures.push(`${label} smoke cycle ${cycleIndex + 1} production heartbeat blocked`)
      }
      if (
        !Number.isInteger(heartbeat.productionTurns) ||
        heartbeat.productionTurns !== expectedProductionTurns(cell, cycle) ||
        !Number.isInteger(heartbeat.timerActiveTurns) ||
        heartbeat.timerActiveTurns !== expectedProductionTurns(cell, cycle) ||
        !Number.isInteger(heartbeat.heartbeatSamples) ||
        heartbeat.heartbeatSamples <= 0 ||
        !Number.isInteger(heartbeat.blocksOverOneSecond) ||
        heartbeat.blocksOverOneSecond < 0 ||
        !finiteNonnegative(heartbeat.totalLatenessMs) ||
        !finiteNonnegative(heartbeat.latenessMaxMs)
      ) {
        failures.push(`${label} smoke cycle ${cycleIndex + 1} production heartbeat is invalid`)
      }

      return failures
    }),
  ),
]

/** Wall-time tails from an uncapped, two-sample smoke run are diagnostic only.
 * Surface every hard-ceiling observation without promoting it to the full
 * resource-qualified verdict. */
export const activityGroupsSmokeWarnings = (report: ActivityGroupsBenchReport): string[] => {
  const warnings = report.heartbeat.flatMap((heartbeat) =>
    heartbeat.phaseObservations.flatMap((phase) =>
      phase.responseMaxMs >= 1_000
        ? [
            `${heartbeat.dialect}/${phase.phase} smoke work-unit response reached ${phase.responseMaxMs} ms`,
          ]
        : [],
    ),
  )

  for (const cell of report.latency) {
    const label = `${cell.dialect}/${cell.variant}/${cell.cut}/${cell.by}/${cell.scope}`

    cell.cycles.forEach((cycle, cycleIndex) => {
      if (cycle.coldMs >= 1_000) {
        warnings.push(`${label} smoke cycle ${cycleIndex + 1} cold reached ${cycle.coldMs} ms`)
      }
      cycle.warmMs.forEach((sample, sampleIndex) => {
        if (sample >= 1_000) {
          warnings.push(
            `${label} smoke cycle ${cycleIndex + 1} warm ${sampleIndex + 1} reached ${sample} ms`,
          )
        }
      })
      if (cycle.locationChurnMs != null && cycle.locationChurnMs >= 1_000) {
        warnings.push(
          `${label} smoke cycle ${cycleIndex + 1} location churn reached ${cycle.locationChurnMs} ms`,
        )
      }
      if (cycle.productionHeartbeat.latenessMaxMs >= PRODUCTION_MAX_LATENESS_MS) {
        warnings.push(
          `${label} smoke cycle ${cycleIndex + 1} production event-loop lateness reached ${cycle.productionHeartbeat.latenessMaxMs} ms`,
        )
      }
      if (cycle.productionHeartbeat.totalLatenessMs >= productionDebtLimit(cell, cycle)) {
        warnings.push(
          `${label} smoke cycle ${cycleIndex + 1} production event-loop debt reached ${cycle.productionHeartbeat.totalLatenessMs} ms`,
        )
      }
    })
  }

  return warnings
}

export const activityGroupsGateFailures = (
  report: ActivityGroupsBenchReport,
  manifest: ActivityGroupsManifest,
): string[] => {
  const failures: string[] = []

  if (report.scenario !== 'activity-groups-v1') {
    failures.push('unknown activity groups scenario')
  }
  if (report.manifest.sha256 !== ACTIVITY_GROUPS_MANIFEST_SHA256) {
    failures.push('activity groups manifest hash mismatch')
  }
  if (report.manifest.version !== manifest.version) {
    failures.push('activity groups manifest version mismatch')
  }
  for (const field of [
    'preCommit',
    'postCommit',
    'preImage',
    'postImage',
    'postgresImage',
    'loaderVersion',
    'migrationsChecksum',
  ] as const) {
    if (
      typeof report.provenance[field] !== 'string' ||
      report.provenance[field].trim().length === 0
    ) {
      failures.push(`activity groups provenance.${field} is required`)
    }
  }
  if (report.provenance.preCommit !== '4d824c336927f52df5a671ad4284c772f7183a01') {
    failures.push('activity groups pre baseline must be main@4d824c3')
  }
  const runnerImage = /^((?:sha256:)[0-9a-f]{64})\+git:([0-9a-f]{40})$/.exec(
    report.provenance.preImage,
  )

  if (!runnerImage || runnerImage[2] !== report.provenance.preCommit) {
    failures.push('activity groups pre image must bind the runner image id to the baseline commit')
  }
  if (!/^(?:commit:[0-9a-f]{40}|worktree:[0-9a-f]{64})$/.test(report.provenance.postCommit)) {
    failures.push('activity groups post tree identity has an invalid format')
  }
  if (
    !runnerImage ||
    report.provenance.postImage !== `${runnerImage[1]}+${report.provenance.postCommit}`
  ) {
    failures.push('activity groups post image must bind the same runner image id to the post tree')
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(report.provenance.postgresImage)) {
    failures.push('activity groups PostgreSQL image must be an inspected image id')
  }
  if (report.resources.appCpu !== 2 || report.resources.postgresCpu !== 2) {
    failures.push('activity groups app and postgres must each use 2 vCPU')
  }
  if (report.resources.appMemoryMiB !== 2048 || report.resources.postgresMemoryMiB !== 2048) {
    failures.push('activity groups app and postgres must each use 2 GiB')
  }
  if (
    JSON.stringify(report.profiles.producer) !== JSON.stringify(ACTIVITY_GROUPS_PRODUCER_PROFILE) ||
    JSON.stringify(report.profiles.liveness) !== JSON.stringify(ACTIVITY_GROUPS_LIVENESS_PROFILE) ||
    report.profiles.offlineRebuildBatchSize !== ACTIVITY_GROUPS_OFFLINE_REBUILD_BATCH_SIZE ||
    report.profiles.phaseTimeoutMs !== ACTIVITY_GROUPS_PHASE_TIMEOUT_MS ||
    report.profiles.deepCorpusBlobs !== false ||
    report.profiles.dialectsParallel !== false ||
    JSON.stringify(report.profiles.deepDialects) !== JSON.stringify(['sqlite'])
  ) {
    failures.push('activity groups bounded execution profiles do not match the reviewed protocol')
  }

  if (report.corpus.length !== 4) {
    failures.push(`expected 4 corpus observations, got ${report.corpus.length}`)
  }
  for (const dialect of ['sqlite', 'postgres'] as const) {
    const expectedVariants =
      dialect === 'sqlite'
        ? (['base', 'revision-10x', 'breadth-10x'] as const)
        : (['base'] as const)

    for (const variant of expectedVariants) {
      const observed = report.corpus.find(
        (entry) => entry.dialect === dialect && entry.variant === variant,
      )
      const expected = manifest.variants[variant]

      if (!observed) {
        failures.push(`missing ${dialect}/${variant} corpus observation`)
        continue
      }
      for (const field of [
        'liveNotes',
        'activeNotes',
        'folders',
        'sourceBytes',
        'revisions',
      ] as const) {
        if (observed[field] !== expected[field]) {
          failures.push(
            `${dialect}/${variant} ${field}: expected ${expected[field]}, got ${observed[field]}`,
          )
        }
      }
      const baselineNotes = variant === 'breadth-10x' ? 4_000 : 400

      if (observed.baselineNotes !== baselineNotes) {
        failures.push(`${dialect}/${variant} baseline cohort mismatch`)
      }
      if (observed.originNotes !== expected.activeNotes - baselineNotes) {
        failures.push(`${dialect}/${variant} origin cohort mismatch`)
      }
      if (observed.gaps !== expected.revisions * 0.02) {
        failures.push(`${dialect}/${variant} gap count mismatch`)
      }
      if (!observed.cleanStop) {
        failures.push(`${dialect}/${variant} snapshot was not closed cleanly`)
      }
    }
  }

  const expectedCellKeys = (['sqlite', 'postgres'] as const).flatMap((dialect) =>
    (dialect === 'sqlite'
      ? (['base', 'revision-10x', 'breadth-10x'] as const)
      : (['base'] as const)
    ).flatMap((variant) =>
      (['current', 'historical'] as const).flatMap((cut) =>
        (['note', 'folder'] as const).flatMap((by) =>
          (['all', 'mine'] as const).map((scope) => `${dialect}/${variant}/${cut}/${by}/${scope}`),
        ),
      ),
    ),
  )
  const expectedCells = expectedCellKeys.length

  if (report.latency.length !== expectedCells) {
    failures.push(`expected ${expectedCells} latency cells, got ${report.latency.length}`)
  }
  for (const key of expectedCellKeys) {
    if (
      report.latency.filter(
        ({ dialect, variant, cut, by, scope }) =>
          `${dialect}/${variant}/${cut}/${by}/${scope}` === key,
      ).length !== 1
    ) {
      failures.push(`latency cell must appear exactly once: ${key}`)
    }
  }
  for (const cell of report.latency) {
    const label = `${cell.dialect}/${cell.variant}/${cell.cut}/${cell.by}/${cell.scope}`

    if (cell.cycles.length !== 3) {
      failures.push(`${label} needs 3 cycles`)
    }
    const pooled = cell.cycles.flatMap((cycle) => cycle.warmMs)

    if (pooled.length !== 60) {
      failures.push(`${label} needs 60 warm samples`)
    }
    if (
      cell.cycles.some(
        (cycle) =>
          !finiteNonnegative(cycle.coldMs) ||
          cycle.warmMs.some((sample) => !finiteNonnegative(sample)),
      )
    ) {
      failures.push(`${label} latency samples must be finite and nonnegative`)
    }
    if (p95(pooled) >= 500) {
      failures.push(`${label} p95 reached ${p95(pooled)} ms`)
    }
    if (max(pooled) >= 1_000 || cell.cycles.some((cycle) => cycle.coldMs >= 1_000)) {
      failures.push(`${label} max reached 1000 ms`)
    }
    for (const cycle of cell.cycles) {
      if (cycle.warmMs.length !== 20) {
        failures.push(`${label} cycle needs 20 samples`)
      }
      if (cell.cut === 'current') {
        if (
          cycle.locationChurnMs == null ||
          !finiteNonnegative(cycle.locationChurnMs) ||
          cycle.locationChurnMs >= 1_000
        ) {
          failures.push(`${label} current-location churn was not measured below 1000 ms`)
        }
      } else if (cycle.locationChurnMs !== undefined) {
        failures.push(`${label} historical cell must not claim current-location churn`)
      }
      const productionHeartbeat = cycle.productionHeartbeat

      if (
        !Number.isInteger(productionHeartbeat.productionTurns) ||
        productionHeartbeat.productionTurns !== expectedProductionTurns(cell, cycle) ||
        !Number.isInteger(productionHeartbeat.timerActiveTurns) ||
        productionHeartbeat.timerActiveTurns !== expectedProductionTurns(cell, cycle) ||
        !Number.isInteger(productionHeartbeat.heartbeatSamples) ||
        productionHeartbeat.heartbeatSamples <= 0 ||
        !Number.isInteger(productionHeartbeat.blocksOverOneSecond) ||
        productionHeartbeat.blocksOverOneSecond < 0 ||
        !finiteNonnegative(productionHeartbeat.totalLatenessMs) ||
        !finiteNonnegative(productionHeartbeat.latenessMaxMs)
      ) {
        failures.push(`${label} production-route heartbeat metrics are invalid`)
      } else if (
        productionHeartbeat.blocksOverOneSecond !== 0 ||
        productionHeartbeat.latenessMaxMs >= PRODUCTION_MAX_LATENESS_MS
      ) {
        failures.push(`${label} production route blocked the event loop`)
      }
      if (productionHeartbeat.totalLatenessMs >= productionDebtLimit(cell, cycle)) {
        failures.push(`${label} production route accumulated event-loop debt`)
      }
    }
  }

  if (report.existing.length !== 8) {
    failures.push(`expected 8 existing-surface cells, got ${report.existing.length}`)
  }

  for (const dialect of ['sqlite', 'postgres'] as const) {
    for (const surface of ['activity', 'events', 'note', 'append'] as const) {
      if (
        report.existing.filter((entry) => entry.dialect === dialect && entry.surface === surface)
          .length !== 1
      ) {
        failures.push(`existing-surface cell must appear exactly once: ${dialect}/${surface}`)
      }
    }
  }

  for (const surface of report.existing) {
    if (
      ![
        surface.baselineMedianMs,
        surface.baselineP95Ms,
        surface.candidateMedianMs,
        surface.candidateP95Ms,
        surface.candidateMaxMs,
      ].every(finiteNonnegative)
    ) {
      failures.push(`${surface.dialect}/${surface.surface} timings must be finite and nonnegative`)
      continue
    }
    const medianLimit = surface.baselineMedianMs + Math.max(surface.baselineMedianMs * 0.1, 5)
    const p95Limit = surface.baselineP95Ms + Math.max(surface.baselineP95Ms * 0.1, 5)

    if (surface.candidateMedianMs > medianLimit || surface.candidateP95Ms > p95Limit) {
      failures.push(`${surface.dialect}/${surface.surface} regressed beyond baseline floor`)
    }
    if (surface.candidateMaxMs >= 1_000) {
      failures.push(`${surface.dialect}/${surface.surface} max reached 1000 ms`)
    }
  }

  if (report.heartbeat.length !== 2) {
    failures.push(`expected 2 heartbeat observations, got ${report.heartbeat.length}`)
  }
  for (const dialect of ['sqlite', 'postgres'] as const) {
    if (report.heartbeat.filter((entry) => entry.dialect === dialect).length !== 1) {
      failures.push(`${dialect} heartbeat observation must appear exactly once`)
    }
  }
  for (const heartbeat of report.heartbeat) {
    const topLevelMetrics = [
      ['durationSeconds', heartbeat.durationSeconds],
      ['intervalMs', heartbeat.intervalMs],
      ['blocksOverOneSecond', heartbeat.blocksOverOneSecond],
      ['totalLatenessMs', heartbeat.totalLatenessMs],
      ['responseMaxMs', heartbeat.responseMaxMs],
      ['latenessMaxMs', heartbeat.latenessMaxMs],
      ['readyReadMaxMs', heartbeat.readyReadMaxMs],
      ['readyReadLatenessMaxMs', heartbeat.readyReadLatenessMaxMs],
      ['pairedBaselineResponseMaxMs', heartbeat.pairedBaselineResponseMaxMs],
      ['pairedBaselineLatenessMaxMs', heartbeat.pairedBaselineLatenessMaxMs],
      ['baselineAppendMedianMs', heartbeat.baselineAppendMedianMs],
      ['baselineAppendP95Ms', heartbeat.baselineAppendP95Ms],
      ['appendMedianMs', heartbeat.appendMedianMs],
      ['appendP95Ms', heartbeat.appendP95Ms],
      ['appendMaxMs', heartbeat.appendMaxMs],
      ['maxGcBatchMs', heartbeat.maxGcBatchMs],
    ] as const

    for (const [metric, value] of topLevelMetrics) {
      if (!finiteNonnegative(value)) {
        failures.push(`${heartbeat.dialect} heartbeat ${metric} must be finite and nonnegative`)
      }
    }
    if (heartbeat.durationSeconds !== 90 || heartbeat.intervalMs !== 50) {
      failures.push(`${heartbeat.dialect} heartbeat protocol mismatch`)
    }
    if (
      heartbeat.sourceRows !== ACTIVITY_GROUPS_LIVENESS_PROFILE.revisions ||
      heartbeat.liveNotes !== ACTIVITY_GROUPS_LIVENESS_PROFILE.liveNotes
    ) {
      failures.push(`${heartbeat.dialect} heartbeat corpus profile mismatch`)
    }
    if (heartbeat.blocksOverOneSecond !== 0) {
      failures.push(`${heartbeat.dialect} heartbeat blocked over one second`)
    }
    for (const proof of [
      'completed',
      'published',
      'restarted',
      'invalidationRecovered',
      'gcDrained',
      'referenceMatched',
    ] as const) {
      if (heartbeat[proof] !== true) {
        failures.push(`${heartbeat.dialect} liveness proof did not complete: ${proof}`)
      }
    }
    if (heartbeat.totalLatenessMs >= 3_000) {
      failures.push(`${heartbeat.dialect} heartbeat lateness reached 3 seconds`)
    }
    // A cold/restarted SQLite worker call includes module/connection startup but
    // remains off the main event loop; heartbeat lateness below is the blocking
    // proof. Keep the IPC wall ceiling explicit instead of misclassifying it as a
    // 250 ms event-loop stall.
    const responseLimit = Math.max(1_000, heartbeat.pairedBaselineResponseMaxMs + 100)
    const latenessLimit = Math.max(250, heartbeat.pairedBaselineLatenessMaxMs + 100)

    if (heartbeat.responseMaxMs > responseLimit || heartbeat.latenessMaxMs > latenessLimit) {
      failures.push(`${heartbeat.dialect} heartbeat exceeded paired ceiling`)
    }
    if (heartbeat.readyReadMaxMs >= 1_000 || heartbeat.readyReadLatenessMaxMs >= 250) {
      failures.push(`${heartbeat.dialect} ready Activity worker read exceeded its ceiling`)
    }
    const appendP95Limit =
      heartbeat.baselineAppendP95Ms + Math.max(heartbeat.baselineAppendP95Ms * 0.1, 5)

    if (heartbeat.appendP95Ms > appendP95Limit || heartbeat.appendMaxMs >= 1_000) {
      failures.push(`${heartbeat.dialect} rebuild append regressed beyond baseline floor`)
    }

    if (
      !Number.isFinite(heartbeat.maxGcBatchMs) ||
      heartbeat.maxGcBatchMs <= 0 ||
      heartbeat.maxGcBatchMs >= 1_000
    ) {
      failures.push(`${heartbeat.dialect} generation GC batch was not bounded below 1000 ms`)
    }

    const expectedPhases = [
      'paced-rebuild',
      'near-publication-invalidation',
      'restart',
      'replacement-publication',
      'generation-gc',
      'ready-reads',
    ] as const

    for (const phase of expectedPhases) {
      if (heartbeat.phaseObservations.filter((entry) => entry.phase === phase).length !== 1) {
        failures.push(`${heartbeat.dialect} liveness phase must appear exactly once: ${phase}`)
      }
    }
    if (heartbeat.phaseObservations.length !== expectedPhases.length) {
      failures.push(
        `${heartbeat.dialect} expected ${expectedPhases.length} liveness phases, got ${heartbeat.phaseObservations.length}`,
      )
    }

    for (const phase of heartbeat.phaseObservations) {
      const scalarMetrics = [
        ['durationMs', phase.durationMs],
        ['workUnits', phase.workUnits],
        ['heartbeatSamples', phase.heartbeatSamples],
        ['blocksOverOneSecond', phase.blocksOverOneSecond],
        ['totalLatenessMs', phase.totalLatenessMs],
        ['latenessMaxMs', phase.latenessMaxMs],
        ['responseMaxMs', phase.responseMaxMs],
        ['foregroundPoint.count', phase.foregroundPoint.count],
        ['foregroundPoint.medianMs', phase.foregroundPoint.medianMs],
        ['foregroundPoint.p95Ms', phase.foregroundPoint.p95Ms],
        ['foregroundPoint.maxMs', phase.foregroundPoint.maxMs],
        ['foregroundAppend.count', phase.foregroundAppend.count],
        ['foregroundAppend.medianMs', phase.foregroundAppend.medianMs],
        ['foregroundAppend.p95Ms', phase.foregroundAppend.p95Ms],
        ['foregroundAppend.maxMs', phase.foregroundAppend.maxMs],
      ] as const

      for (const [metric, value] of scalarMetrics) {
        if (!finiteNonnegative(value)) {
          failures.push(
            `${heartbeat.dialect}/${phase.phase} ${metric} must be finite and nonnegative`,
          )
        }
      }
      if (phase.durationMs <= 0) {
        failures.push(`${heartbeat.dialect}/${phase.phase} duration was not measured`)
      }
      if (!Number.isInteger(phase.workUnits) || phase.workUnits <= 0) {
        failures.push(`${heartbeat.dialect}/${phase.phase} work units were not measured`)
      }
      if (!Number.isInteger(phase.heartbeatSamples) || phase.heartbeatSamples <= 0) {
        failures.push(`${heartbeat.dialect}/${phase.phase} heartbeat was not sampled`)
      }
      if (phase.blocksOverOneSecond !== 0 || phase.latenessMaxMs >= 1_000) {
        failures.push(`${heartbeat.dialect}/${phase.phase} heartbeat blocked over one second`)
      }
      // The paced protocol keeps the original 3 s absolute debt budget. A
      // full-corpus recovery phase may legitimately run much longer, so its
      // cumulative timer jitter is capped to 5% of wall time while every
      // individual stall remains independently bounded below one second.
      const latenessLimit =
        phase.phase === 'paced-rebuild' ? 3_000 : Math.max(3_000, phase.durationMs * 0.05)

      if (phase.totalLatenessMs >= latenessLimit) {
        failures.push(`${heartbeat.dialect}/${phase.phase} heartbeat lateness exceeded its budget`)
      }
      const phaseResponseLimit = phase.phase === 'restart' ? responseLimit : 1_000

      if (phase.responseMaxMs >= phaseResponseLimit) {
        failures.push(`${heartbeat.dialect}/${phase.phase} work unit exceeded its response ceiling`)
      }
      if (!Number.isInteger(phase.foregroundPoint.count) || phase.foregroundPoint.count <= 0) {
        failures.push(`${heartbeat.dialect}/${phase.phase} foreground point was not sampled`)
      }
      if (phase.foregroundPoint.maxMs >= 1_000) {
        failures.push(`${heartbeat.dialect}/${phase.phase} foreground point reached 1000 ms`)
      }
      if (!Number.isInteger(phase.foregroundAppend.count) || phase.foregroundAppend.count <= 0) {
        failures.push(`${heartbeat.dialect}/${phase.phase} foreground append was not sampled`)
      }
      if (phase.foregroundAppend.p95Ms > appendP95Limit || phase.foregroundAppend.maxMs >= 1_000) {
        failures.push(
          `${heartbeat.dialect}/${phase.phase} foreground append regressed beyond baseline floor`,
        )
      }
    }

    const gcPhase = heartbeat.phaseObservations.find(({ phase }) => phase === 'generation-gc')

    if (gcPhase && gcPhase.responseMaxMs !== heartbeat.maxGcBatchMs) {
      failures.push(`${heartbeat.dialect} generation GC response maximum is inconsistent`)
    }
  }

  if (report.storage.length !== 4) {
    failures.push(`expected 4 storage observations, got ${report.storage.length}`)
  }
  for (const dialect of ['sqlite', 'postgres'] as const) {
    const expectedVariants =
      dialect === 'sqlite'
        ? (['base', 'revision-10x', 'breadth-10x'] as const)
        : (['base'] as const)

    for (const variant of expectedVariants) {
      if (
        report.storage.filter((entry) => entry.dialect === dialect && entry.variant === variant)
          .length !== 1
      ) {
        failures.push(`storage observation must appear exactly once: ${dialect}/${variant}`)
      }
    }
  }
  for (const observed of report.storage) {
    if (observed.journalBytes <= 0 || observed.projectionBytes <= 0) {
      failures.push(`${observed.dialect}/${observed.variant} storage bytes were not observed`)
    }
    if (observed.statusRows !== 1 || observed.stateRows <= 0 || observed.headRows <= 0) {
      failures.push(`${observed.dialect}/${observed.variant} projection cardinality mismatch`)
    }
    if (observed.orderRows !== 0 || observed.gcRows !== 0) {
      failures.push(`${observed.dialect}/${observed.variant} clean generation residue mismatch`)
    }
  }

  const freshProducer = report.producer.filter(
    (entry): entry is Extract<ActivityGroupsProducerEvidence, { kind: 'fresh-ready' }> =>
      entry.kind === 'fresh-ready',
  )
  const contention = report.producer.filter(
    (entry): entry is Extract<ActivityGroupsProducerEvidence, { kind: 'postgres-contention' }> =>
      entry.kind === 'postgres-contention',
  )

  if (freshProducer.length !== 2 || contention.length !== 1 || report.producer.length !== 3) {
    failures.push(
      'producer evidence must contain two bounded fresh-ready cells and one PG contention cell',
    )
  }
  for (const dialect of ['sqlite', 'postgres'] as const) {
    const matches = freshProducer.filter(
      (entry) => entry.dialect === dialect && entry.variant === 'base',
    )

    if (matches.length !== 1) {
      failures.push(`bounded fresh-ready producer must appear exactly once: ${dialect}`)
      continue
    }
    const observed = matches[0]!
    const numeric = [
      observed.elapsedMs,
      observed.sourceRows,
      observed.transactions,
      observed.statusRows,
      observed.orderRows,
      observed.stateRows,
      observed.headRows,
      observed.auxiliaryRows,
      observed.auxiliaryRowsPerSource,
    ]

    if (!numeric.every(finiteNonnegative) || observed.elapsedMs <= 0) {
      failures.push(`${dialect}/bounded fresh-ready metrics must be finite and measured`)
    }
    if (
      observed.sourceRows !== ACTIVITY_GROUPS_PRODUCER_PROFILE.revisions ||
      observed.statusRows !== 1 ||
      observed.orderRows !== observed.sourceRows ||
      observed.stateRows !==
        ACTIVITY_GROUPS_PRODUCER_PROFILE.revisions -
          ACTIVITY_GROUPS_PRODUCER_PROFILE.baselineNotes ||
      observed.headRows < minimumActivityGroupsProducerHeadRows(ACTIVITY_GROUPS_PRODUCER_PROFILE) ||
      !Number.isInteger(observed.transactions) ||
      observed.transactions <= 0
    ) {
      failures.push(`${dialect}/bounded fresh-ready producer cardinality mismatch`)
    }
    if (
      observed.auxiliaryRows !== observed.orderRows + observed.stateRows + observed.headRows ||
      observed.auxiliaryRowsPerSource !== observed.auxiliaryRows / observed.sourceRows
    ) {
      failures.push(`${dialect}/bounded fresh-ready write amplification mismatch`)
    }
  }
  if (contention.length === 1) {
    const observed = contention[0]!
    const numeric = [
      observed.elapsedMs,
      observed.throughputPerSecond,
      observed.appendLatencyMs.median,
      observed.appendLatencyMs.p95,
      observed.appendLatencyMs.max,
      observed.overlap.maxInFlight,
      observed.postgresWaits.samples,
      observed.postgresWaits.activeSamples,
      observed.postgresWaits.waitingSamples,
      observed.postgresWaits.lockWaitingSamples,
      observed.postgresWaits.maxActive,
      observed.postgresWaits.maxWaiting,
      observed.rowAmplification.sourceRows,
      observed.rowAmplification.orderRows,
      observed.rowAmplification.stateRows,
      observed.rowAmplification.headRows,
      observed.rowAmplification.auxiliaryRows,
      observed.rowAmplification.auxiliaryRowsPerSource,
    ]

    if (!numeric.every(finiteNonnegative) || observed.elapsedMs <= 0) {
      failures.push('postgres contention metrics must be finite and measured')
    }
    if (
      observed.writes !== 128 ||
      observed.concurrency !== 10 ||
      observed.overlap.maxInFlight < 2 ||
      observed.postgresWaits.samples <= 0 ||
      observed.postgresWaits.maxActive < 2 ||
      observed.postgresWaits.waitingSamples <= 0 ||
      observed.postgresWaits.lockWaitingSamples <= 0 ||
      observed.appendLatencyMs.max >= 1_000
    ) {
      failures.push('postgres contention protocol or latency mismatch')
    }
    if (
      observed.rowAmplification.sourceRows !== observed.writes ||
      observed.rowAmplification.orderRows !== observed.writes ||
      observed.rowAmplification.stateRows !== observed.writes ||
      observed.rowAmplification.headRows !== observed.writes ||
      observed.rowAmplification.auxiliaryRows !== observed.writes * 3 ||
      observed.rowAmplification.auxiliaryRowsPerSource !== 3
    ) {
      failures.push('postgres contention lost rows or changed write amplification')
    }
  }
  failures.push(
    ...exactTrueRecordFailures(
      report.proofs,
      ACTIVITY_GROUP_PROOF_KEYS,
      'production proof set',
      (proof) => `production proof did not pass: ${proof}`,
    ),
  )

  const structure = report.structure
  const structureScalars = [
    ['bodyReads', structure.bodyReads],
    ['rawRevisionMaterializations', structure.rawRevisionMaterializations],
    ['queryPerGroup', structure.queryPerGroup],
    ['duplicateOverviewScans', structure.duplicateOverviewScans],
    ['retainedGroupsBase', structure.retainedGroupsBase],
    ['retainedGroupsRevision10x', structure.retainedGroupsRevision10x],
    ['responseItemsBase', structure.responseItemsBase],
    ['responseItemsRevision10x', structure.responseItemsRevision10x],
  ] as const

  for (const [metric, value] of structureScalars) {
    if (!finiteNonnegative(value) || !Number.isInteger(value)) {
      failures.push(`activity groups structure.${metric} must be a nonnegative integer`)
    }
  }

  if (structure.bodyReads !== 0) {
    failures.push('activity groups summary read note bodies')
  }
  if (structure.rawRevisionMaterializations !== 0) {
    failures.push('activity groups summary materialized raw revisions')
  }
  if (structure.queryPerGroup !== 0) {
    failures.push('activity groups issued query-per-group')
  }
  if (structure.duplicateOverviewScans !== 0) {
    failures.push('activity groups duplicated the overview scan')
  }
  if (structure.missingProductionLayers.length !== 0) {
    failures.push(
      `activity groups production source chain is incomplete: ${structure.missingProductionLayers.join(', ')}`,
    )
  }
  if (structure.retainedGroupsRevision10x !== structure.retainedGroupsBase) {
    failures.push('revision-10x changed retained group cardinality')
  }
  if (structure.responseItemsRevision10x !== structure.responseItemsBase) {
    failures.push('revision-10x changed response cardinality')
  }
  failures.push(
    ...exactTrueRecordFailures(
      structure.faultInjectionFailures,
      ACTIVITY_GROUP_FAULT_KEYS,
      'negative-control set',
      (fault) => `producer fault did not fail: ${fault}`,
    ),
  )

  return failures
}

export const activityGroupsLatencySummary = (cell: ActivityGroupsLatencyCell) => {
  const values = cell.cycles.flatMap((cycle) => cycle.warmMs)
  return { median: median(values), p95: p95(values), max: max(values) }
}
