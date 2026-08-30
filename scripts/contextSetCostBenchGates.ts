export type ContextSetCostStats = {
  medianMs: number
  p95Ms: number
  maxMs: number
  rawMs: number[]
}

export const CONTEXT_SET_COST_FROZEN_COMMIT = '5edc7b3373d1f9379e92371f201e92f989ef65af'

export type ContextSetCostBenchmarkReport = {
  phase: 'pre' | 'post'
  provenance: {
    commit: string
    builtAt: string
    image: string
    imageRevision: string
    imageBuiltAt: string
    container: string
    dataRoot: string
    baseUrl: string
  }
  measured: number
  manager: ContextSetCostStats
  reorder: ContextSetCostStats
  eager: ContextSetCostStats
  idleHeartbeat: ContextSetCostStats
  bulk: {
    available: boolean
    absentStatus?: number
    samples: Array<{
      setId: string
      status: number | null
      added: number
      failed: number
      items: number
      ms: number
      requestStartedAt: number
      requestEndedAt: number
      serverStartedAt: number
      serverEndedAt: number
      heartbeat: Array<{
        ms: number
        status: number | null
        startedAt: number
        endedAt: number
        serverStartedAt: number
        serverEndedAt: number
      }>
      error?: string
    }>
  }
  gate?: { baseline: string | null; failures: string[]; passed: boolean }
}

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * p) - 1] ?? 0
}

export const contextSetCostStats = (values: readonly number[]): ContextSetCostStats => ({
  medianMs: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
  maxMs: values.length > 0 ? Math.max(...values) : 0,
  rawMs: [...values],
})

const validStats = (label: string, stats: ContextSetCostStats | undefined, count: number) => {
  if (!stats) {
    return [`${label} is missing`]
  }
  const failures: string[] = []

  if (stats.rawMs.length !== count) {
    failures.push(`${label} has ${stats.rawMs.length} samples, expected ${count}`)
  }
  if (stats.rawMs.some((value) => !Number.isFinite(value) || value <= 0)) {
    failures.push(`${label}.rawMs contains an invalid sample`)
  }
  for (const [field, value] of Object.entries({
    medianMs: stats.medianMs,
    p95Ms: stats.p95Ms,
    maxMs: stats.maxMs,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      failures.push(`${label}.${field} is invalid`)
    }
  }
  const derived = contextSetCostStats(stats.rawMs)

  for (const field of ['medianMs', 'p95Ms', 'maxMs'] as const) {
    if (stats[field] !== derived[field]) {
      failures.push(`${label}.${field} does not match rawMs`)
    }
  }

  return failures
}

export const contextSetCostBenchmarkGateFailures = (
  report: ContextSetCostBenchmarkReport,
  baseline?: ContextSetCostBenchmarkReport,
): string[] => {
  const phase = (report as { phase: string }).phase

  if (phase !== 'pre' && phase !== 'post') {
    return [`unknown benchmark phase: ${phase}`]
  }
  const failures: string[] = []
  const provenance = report.provenance

  if (!Number.isInteger(report.measured) || report.measured <= 0) {
    failures.push('benchmark measured must be a positive integer')
  }

  for (const field of [
    'commit',
    'builtAt',
    'image',
    'imageRevision',
    'imageBuiltAt',
    'container',
    'dataRoot',
    'baseUrl',
  ] as const) {
    if (!provenance?.[field]?.trim()) {
      failures.push(`benchmark provenance.${field} is required`)
    }
  }
  if (provenance?.image && !/^sha256:[0-9a-f]{64}$/.test(provenance.image)) {
    failures.push('benchmark provenance.image must be an observed sha256 digest')
  }
  if (provenance?.imageRevision !== provenance?.commit) {
    failures.push('benchmark OCI revision must match runtime commit')
  }
  if (provenance?.imageBuiltAt !== provenance?.builtAt) {
    failures.push('benchmark OCI created time must match runtime build time')
  }
  failures.push(...validStats('manager', report.manager, report.measured))
  failures.push(...validStats('reorder', report.reorder, report.measured))
  failures.push(...validStats('eager', report.eager, report.measured))
  failures.push(...validStats('idleHeartbeat', report.idleHeartbeat, report.measured))

  if (phase === 'pre') {
    if (provenance?.commit !== CONTEXT_SET_COST_FROZEN_COMMIT) {
      failures.push(`pre phase must use frozen commit ${CONTEXT_SET_COST_FROZEN_COMMIT}`)
    }
    if (
      report.bulk.available ||
      report.bulk.absentStatus !== 404 ||
      report.bulk.samples.length > 0
    ) {
      failures.push('pre phase must prove add-many is absent with status 404')
    }

    return failures
  }

  if (!baseline) {
    failures.push('post phase requires BENCH_BASELINE')
  } else if (baseline.phase !== 'pre') {
    failures.push('BENCH_BASELINE must be a pre report')
  } else {
    failures.push(...contextSetCostBenchmarkGateFailures(baseline))
    if (!baseline.gate?.passed || baseline.gate.failures.length !== 0) {
      failures.push('BENCH_BASELINE must be an unchanged passing pre harness output')
    }
    if (provenance?.dataRoot !== baseline.provenance?.dataRoot) {
      failures.push('post and baseline must use the same data root')
    }
    if (provenance?.baseUrl !== baseline.provenance?.baseUrl) {
      failures.push('post and baseline must use the same base URL')
    }
    if (report.measured < baseline.measured) {
      failures.push('post measured population must not be smaller than the baseline')
    }
  }
  if (!report.bulk.available) {
    failures.push('post phase must exercise available add-many')
  }
  if (report.bulk.samples.length !== report.measured) {
    failures.push(`bulk has ${report.bulk.samples.length} samples, expected ${report.measured}`)
  }
  if (
    new Set(report.bulk.samples.map((sample) => sample.setId)).size !== report.bulk.samples.length
  ) {
    failures.push('every bulk sample must use a fresh set')
  }
  for (const [index, sample] of report.bulk.samples.entries()) {
    if (
      sample.status !== 200 ||
      sample.added !== 1000 ||
      sample.failed !== 0 ||
      sample.items !== 1000 ||
      sample.error
    ) {
      failures.push(`bulk sample ${index} did not apply 1000 refs`)
    }
    if (!Number.isFinite(sample.ms) || sample.ms <= 0) {
      failures.push(`bulk sample ${index} has an invalid duration`)
    }
    if (Math.abs(sample.ms - (sample.requestEndedAt - sample.requestStartedAt)) > 0.01) {
      failures.push(`bulk sample ${index} duration does not match its request interval`)
    }
    if (
      !Number.isFinite(sample.requestStartedAt) ||
      !Number.isFinite(sample.requestEndedAt) ||
      sample.requestEndedAt <= sample.requestStartedAt
    ) {
      failures.push(`bulk sample ${index} has an invalid request interval`)
    }
    if (
      !Number.isFinite(sample.serverStartedAt) ||
      !Number.isFinite(sample.serverEndedAt) ||
      sample.serverEndedAt <= sample.serverStartedAt
    ) {
      failures.push(`bulk sample ${index} has an invalid server interval`)
    }
    if (sample.heartbeat.some((heartbeat) => heartbeat.status !== 200)) {
      failures.push(`bulk sample ${index} heartbeat failed`)
    }
    if (sample.heartbeat.length < 2) {
      failures.push(`bulk sample ${index} must have repeated heartbeat samples`)
    }
    if (sample.heartbeat.some((heartbeat) => !Number.isFinite(heartbeat.ms) || heartbeat.ms <= 0)) {
      failures.push(`bulk sample ${index} has an invalid heartbeat duration`)
    }
    if (
      sample.heartbeat.some(
        (heartbeat) =>
          !Number.isFinite(heartbeat.startedAt) ||
          !Number.isFinite(heartbeat.endedAt) ||
          heartbeat.endedAt <= heartbeat.startedAt,
      )
    ) {
      failures.push(`bulk sample ${index} has an invalid heartbeat interval`)
    }
    if (
      sample.heartbeat.some(
        (heartbeat) =>
          !Number.isFinite(heartbeat.serverStartedAt) ||
          !Number.isFinite(heartbeat.serverEndedAt) ||
          heartbeat.serverEndedAt <= heartbeat.serverStartedAt,
      )
    ) {
      failures.push(`bulk sample ${index} has an invalid heartbeat server interval`)
    }
  }
  if (baseline) {
    const heartbeatServerDurations = report.bulk.samples.flatMap((sample) =>
      sample.heartbeat.map((heartbeat) => heartbeat.serverEndedAt - heartbeat.serverStartedAt),
    )
    const max =
      heartbeatServerDurations.length > 0
        ? Math.max(...heartbeatServerDurations)
        : Number.POSITIVE_INFINITY
    const limit = baseline.idleHeartbeat.maxMs + Math.max(baseline.idleHeartbeat.maxMs * 0.2, 25)

    if (max > limit) {
      failures.push(`bulk heartbeat server max ${max.toFixed(3)} ms exceeds ${limit.toFixed(3)} ms`)
    }
    for (const [index, sample] of report.bulk.samples.entries()) {
      const contained = sample.heartbeat
        .filter(
          (heartbeat) =>
            Number.isFinite(heartbeat.serverStartedAt) &&
            Number.isFinite(heartbeat.serverEndedAt) &&
            heartbeat.serverStartedAt >= sample.serverStartedAt &&
            heartbeat.serverEndedAt <= sample.serverEndedAt,
        )
        .sort((left, right) => left.serverStartedAt - right.serverStartedAt)

      if (contained.length < 1) {
        failures.push(`bulk sample ${index} has no server-overlapping heartbeat`)
        continue
      }
      let maxGap = contained[0].serverStartedAt - sample.serverStartedAt

      for (let heartbeatIndex = 1; heartbeatIndex < contained.length; heartbeatIndex += 1) {
        maxGap = Math.max(
          maxGap,
          contained[heartbeatIndex].serverStartedAt - contained[heartbeatIndex - 1].serverEndedAt,
        )
      }
      maxGap = Math.max(maxGap, sample.serverEndedAt - contained.at(-1)!.serverEndedAt)
      if (!Number.isFinite(maxGap) || maxGap > limit) {
        failures.push(
          `bulk sample ${index} heartbeat coverage gap ${maxGap.toFixed(3)} ms exceeds ${limit.toFixed(3)} ms`,
        )
      }
    }
  }

  return failures
}
