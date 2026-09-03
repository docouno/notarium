export type AbilityPlacementStats = {
  medianMs: number
  p95Ms: number
  maxMs: number
  rawMs: number[]
}

export type AbilityPlacementHeartbeat = {
  status: number | null
  clientStartedAt: number
  clientEndedAt: number
  serverStartedAt: number
  serverEndedAt: number
}

export type AbilityPlacementSample = {
  roleSetupMs: number
  firstMoveMs: number
  firstMoveStatus: number
  replayMs: number
  replayStatus: number
  enabledStayedFalse: boolean
  contextCarried: boolean
  firstMoveClientStartedAt: number
  firstMoveClientEndedAt: number
  firstMoveServerStartedAt: number | null
  firstMoveServerEndedAt: number | null
  heartbeats: AbilityPlacementHeartbeat[]
}

export type AbilityPlacementBenchmarkReport = {
  phase: 'pre' | 'post'
  provenance: {
    commit: string
    builtAt: string
    image: string
    imageRevision: string
    imageBuiltAt: string
    container: string
    baseUrl: string
    harnessHash: string
    dataRootHash: string
    node: string
    npm: string
    caseName: string
    caseSourceHash: string
    now: string
    scale: string
    seed: string
  }
  warmups: number
  measured: number
  idleHeartbeat: AbilityPlacementStats
  roleFirstMove: AbilityPlacementStats
  roleSetup: AbilityPlacementStats
  roleReplay: AbilityPlacementStats
  projectSetControl: AbilityPlacementStats
  projectPinControl: AbilityPlacementStats
  samples: AbilityPlacementSample[]
  gate?: { baseline: string | null; failures: string[]; passed: boolean }
}

export const ABILITY_PLACEMENT_FROZEN_COMMIT = 'f4da0374d96ac575669323aab8cbd9f85c726bcc'

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right)

  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0
}

export const abilityPlacementStats = (values: readonly number[]): AbilityPlacementStats => ({
  medianMs: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
  maxMs: values.length > 0 ? Math.max(...values) : 0,
  rawMs: [...values],
})

const statsFailures = (
  name: string,
  stats: AbilityPlacementStats | undefined,
  measured: number,
): string[] => {
  if (!stats) {
    return [`${name} is missing`]
  }
  const failures: string[] = []

  if (stats.rawMs.length !== measured) {
    failures.push(`${name} has ${stats.rawMs.length} samples, expected ${measured}`)
  }
  if (stats.rawMs.some((sample) => !Number.isFinite(sample) || sample <= 0)) {
    failures.push(`${name}.rawMs contains an invalid sample`)
  }
  const derived = abilityPlacementStats(stats.rawMs)

  for (const field of ['medianMs', 'p95Ms', 'maxMs'] as const) {
    if (!Number.isFinite(stats[field]) || stats[field] <= 0) {
      failures.push(`${name}.${field} is invalid`)
    } else if (stats[field] !== derived[field]) {
      failures.push(`${name}.${field} does not match rawMs`)
    }
  }

  return failures
}

const relativeLimit = (baseline: number, ratio: number, floorMs: number): number =>
  baseline + Math.max(baseline * ratio, floorMs)

const compareStats = (
  name: string,
  post: AbilityPlacementStats,
  pre: AbilityPlacementStats,
  p95Ratio: number,
  p95Floor: number,
  maxRatio: number,
  maxFloor: number,
): string[] => {
  const failures: string[] = []
  const p95Limit = relativeLimit(pre.p95Ms, p95Ratio, p95Floor)
  const maxLimit = relativeLimit(pre.maxMs, maxRatio, maxFloor)

  if (post.p95Ms > p95Limit) {
    failures.push(`${name}.p95 ${post.p95Ms.toFixed(3)} ms exceeds ${p95Limit.toFixed(3)} ms`)
  }
  if (post.maxMs > maxLimit) {
    failures.push(`${name}.max ${post.maxMs.toFixed(3)} ms exceeds ${maxLimit.toFixed(3)} ms`)
  }

  return failures
}

const stationarityFailures = (name: string, stats: AbilityPlacementStats): string[] => {
  const cut = Math.floor(stats.rawMs.length / 2)
  const early = abilityPlacementStats(stats.rawMs.slice(0, cut))
  const late = abilityPlacementStats(stats.rawMs.slice(cut))
  const limit = relativeLimit(early.medianMs, 0.3, 10)

  return late.medianMs > limit
    ? [
        `${name} second-half median ${late.medianMs.toFixed(3)} ms exceeds stationary-series limit ${limit.toFixed(3)} ms`,
      ]
    : []
}

const provenanceFields = [
  'commit',
  'builtAt',
  'image',
  'imageRevision',
  'imageBuiltAt',
  'container',
  'baseUrl',
  'harnessHash',
  'dataRootHash',
  'node',
  'npm',
  'caseName',
  'caseSourceHash',
  'now',
  'scale',
  'seed',
] as const

export const abilityPlacementBenchmarkGateFailures = (
  report: AbilityPlacementBenchmarkReport,
  baseline?: AbilityPlacementBenchmarkReport,
): string[] => {
  const failures: string[] = []

  if (report.phase !== 'pre' && report.phase !== 'post') {
    return [`unknown benchmark phase: ${(report as { phase: string }).phase}`]
  }
  if (!Number.isInteger(report.measured) || report.measured < 30) {
    failures.push('benchmark measured must be an integer >= 30')
  }
  if (!Number.isInteger(report.warmups) || report.warmups < 5) {
    failures.push('benchmark warmups must be an integer >= 5')
  }
  for (const field of provenanceFields) {
    if (!report.provenance?.[field]?.trim()) {
      failures.push(`benchmark provenance.${field} is required`)
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(report.provenance.image)) {
    failures.push('benchmark provenance.image must be an observed sha256 digest')
  }
  if (report.provenance.imageRevision !== report.provenance.commit) {
    failures.push('benchmark OCI revision must match runtime commit')
  }
  if (report.provenance.imageBuiltAt !== report.provenance.builtAt) {
    failures.push('benchmark OCI created time must match runtime build time')
  }
  for (const name of [
    'idleHeartbeat',
    'roleFirstMove',
    'roleSetup',
    'roleReplay',
    'projectSetControl',
    'projectPinControl',
  ] as const) {
    failures.push(...statsFailures(name, report[name], report.measured))
  }
  if (report.samples.length !== report.measured) {
    failures.push(`samples has ${report.samples.length} entries, expected ${report.measured}`)
  }
  for (const [index, sample] of report.samples.entries()) {
    if (sample.firstMoveStatus !== 200) {
      failures.push(`sample ${index} first move returned ${sample.firstMoveStatus}`)
    }
    const expectedReplayStatus = report.phase === 'pre' ? 404 : 200

    if (sample.replayStatus !== expectedReplayStatus) {
      failures.push(
        `sample ${index} replay returned ${sample.replayStatus}, expected ${expectedReplayStatus}`,
      )
    }
    if (!sample.enabledStayedFalse || !sample.contextCarried) {
      failures.push(`sample ${index} did not carry its disabled/context state`)
    }
    if (
      !Number.isFinite(sample.firstMoveClientStartedAt) ||
      !Number.isFinite(sample.firstMoveClientEndedAt) ||
      sample.firstMoveClientEndedAt <= sample.firstMoveClientStartedAt
    ) {
      failures.push(`sample ${index} has an invalid first-move client interval`)
    }
    const hasServerMoveInterval =
      sample.firstMoveServerStartedAt !== null &&
      sample.firstMoveServerEndedAt !== null &&
      Number.isFinite(sample.firstMoveServerStartedAt) &&
      Number.isFinite(sample.firstMoveServerEndedAt) &&
      sample.firstMoveServerEndedAt > sample.firstMoveServerStartedAt

    if (report.phase === 'post' && !hasServerMoveInterval) {
      failures.push(`sample ${index} has no valid first-move server interval`)
    }
    if (sample.heartbeats.length < 2) {
      failures.push(`sample ${index} must have repeated heartbeat samples`)
      continue
    }
    if (
      sample.heartbeats.some(
        (heartbeat) =>
          heartbeat.status !== 200 ||
          !Number.isFinite(heartbeat.clientStartedAt) ||
          !Number.isFinite(heartbeat.clientEndedAt) ||
          heartbeat.clientEndedAt <= heartbeat.clientStartedAt ||
          !Number.isFinite(heartbeat.serverStartedAt) ||
          !Number.isFinite(heartbeat.serverEndedAt) ||
          heartbeat.serverEndedAt <= heartbeat.serverStartedAt ||
          heartbeat.serverStartedAt < heartbeat.clientStartedAt ||
          heartbeat.serverEndedAt > heartbeat.clientEndedAt,
      )
    ) {
      failures.push(`sample ${index} heartbeat has an invalid client/server interval`)
    }
    // The frozen base predates the private Home timing header, so its external
    // client interval is the explicit fallback. Post must carry and use the server
    // interval; otherwise the liveness proof can pass in client/network slack.
    const moveStartedAt = hasServerMoveInterval
      ? sample.firstMoveServerStartedAt!
      : sample.firstMoveClientStartedAt
    const moveEndedAt = hasServerMoveInterval
      ? sample.firstMoveServerEndedAt!
      : sample.firstMoveClientEndedAt
    const overlapping = sample.heartbeats.filter(
      (heartbeat) =>
        heartbeat.serverStartedAt < moveEndedAt && heartbeat.serverEndedAt > moveStartedAt,
    )

    if (overlapping.length < 1) {
      failures.push(`sample ${index} has no server-overlapping heartbeat`)
    }
  }
  failures.push(...stationarityFailures('roleFirstMove', report.roleFirstMove))
  failures.push(...stationarityFailures('roleSetup', report.roleSetup))

  if (report.phase === 'pre') {
    if (report.provenance.commit !== ABILITY_PLACEMENT_FROZEN_COMMIT) {
      failures.push(`pre phase must use frozen commit ${ABILITY_PLACEMENT_FROZEN_COMMIT}`)
    }

    return failures
  }
  if (!baseline) {
    failures.push('post phase requires BENCH_BASELINE')
    return failures
  }
  if (baseline.phase !== 'pre') {
    failures.push('BENCH_BASELINE must be a pre report')
    return failures
  }
  failures.push(...abilityPlacementBenchmarkGateFailures(baseline))
  if (!baseline.gate?.passed || baseline.gate.failures.length > 0) {
    failures.push('BENCH_BASELINE must be an unchanged passing pre harness output')
  }
  for (const field of [
    'harnessHash',
    'dataRootHash',
    'caseSourceHash',
    'caseName',
    'now',
    'scale',
    'seed',
  ] as const) {
    if (report.provenance[field] !== baseline.provenance[field]) {
      failures.push(`post and baseline provenance.${field} must match`)
    }
  }
  if (report.measured < baseline.measured) {
    failures.push('post measured population must not be smaller than the baseline')
  }
  if (report.warmups !== baseline.warmups) {
    failures.push('post and baseline warmup populations must match')
  }
  failures.push(
    ...compareStats(
      'projectSetControl',
      report.projectSetControl,
      baseline.projectSetControl,
      0.2,
      5,
      0.25,
      10,
    ),
    ...compareStats(
      'projectPinControl',
      report.projectPinControl,
      baseline.projectPinControl,
      0.2,
      5,
      0.25,
      10,
    ),
    ...compareStats('roleSetup', report.roleSetup, baseline.roleSetup, 0.25, 10, 0.3, 20),
    ...compareStats(
      'roleFirstMove',
      report.roleFirstMove,
      baseline.roleFirstMove,
      0.25,
      10,
      0.3,
      20,
    ),
  )
  if (report.roleReplay.p95Ms > report.roleFirstMove.p95Ms) {
    failures.push('roleReplay.p95 must not exceed roleFirstMove.p95')
  }
  const heartbeatLimit = relativeLimit(baseline.idleHeartbeat.maxMs, 0.2, 25)
  const heartbeatDurations = report.samples.flatMap((sample) =>
    sample.heartbeats.map((heartbeat) => heartbeat.serverEndedAt - heartbeat.serverStartedAt),
  )
  const heartbeatMax = Math.max(...heartbeatDurations)

  if (!Number.isFinite(heartbeatMax) || heartbeatMax > heartbeatLimit) {
    failures.push(
      `under-load heartbeat server max ${heartbeatMax.toFixed(3)} ms exceeds ${heartbeatLimit.toFixed(3)} ms`,
    )
  }

  return failures
}
