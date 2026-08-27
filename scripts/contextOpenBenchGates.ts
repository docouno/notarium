// The verdict half of the context-open benchmark: what a pre or post report must
// carry, and what it must be compared against, before its numbers read as a result.
// canon: docs/seeds.md#cli

export type ContextOpenStats = {
  medianMs: number
  p95Ms: number
  maxMs: number
  rawMs: number[]
}

export const CONTEXT_OPEN_FROZEN_COMMIT = '5ce60d459584c6cc093c8e9b77b89e9e7fa6e9e9'
const FROZEN_TIMEOUT_FAILURE = 'AbortError: This operation was aborted'
const FROZEN_TIMEOUT_MS = 1_000

type ProbeSample = { ms: number; status: number | null; error?: string }
type RawOperation = {
  call: {
    ms: number
    status: number | null
    isError?: boolean
    error?: string
    step?: { error?: string; outcome: string; step: string }
  }
  unrelatedNote: ProbeSample
  healthHeartbeat: ProbeSample[]
}

export type ContextOpenBenchmarkReport = {
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
  warmDashboard: ContextOpenStats
  warmGraphHealth: ContextOpenStats
  personalContext: ContextOpenStats
  projectContext: ContextOpenStats
  noteOpen: ContextOpenStats
  abilityEdit: {
    completed: boolean
    failure: string | null
    timeoutMs: number
    targetRef: string
    applied: ContextOpenStats | null
    noOp: ContextOpenStats | null
    conflict: ContextOpenStats | null
    healthHeartbeat: {
      stats: ContextOpenStats | null
      failures: ProbeSample[]
    }
    raw: Array<{
      phase: 'warmup' | 'measured'
      applied: RawOperation
      noOp?: RawOperation
      conflict?: RawOperation
    }>
  }
  postAbilitySurfaces: {
    noteOpen: ContextOpenStats
    personalContext: ContextOpenStats
    projectContext: ContextOpenStats
    dashboard: ContextOpenStats
    graphHealth: ContextOpenStats
  } | null
  gate?: {
    baseline: string | null
    failures: string[]
    passed: boolean
  }
}

// Nearest rank: p <= 1, so the rank never runs past the last index and the only
// out-of-range read is an empty sample set — a run configured with MEASURED=0.
const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((left, right) => left - right)

  return sorted[Math.ceil(sorted.length * p) - 1] ?? 0
}

export const contextOpenStats = (samples: readonly number[]): ContextOpenStats => ({
  medianMs: percentile(samples, 0.5),
  p95Ms: percentile(samples, 0.95),
  maxMs: Math.max(...samples),
  rawMs: [...samples],
})

const validStats = (
  label: string,
  value: ContextOpenStats | null | undefined,
  measured: number,
): string[] => {
  if (!value) {
    return [`${label} is missing`]
  }
  const failures: string[] = []

  if (value.rawMs.length !== measured) {
    failures.push(`${label} has ${value.rawMs.length} samples, expected ${measured}`)
  }
  for (const [name, sample] of Object.entries({
    medianMs: value.medianMs,
    p95Ms: value.p95Ms,
    maxMs: value.maxMs,
  })) {
    if (!Number.isFinite(sample) || sample < 0) {
      failures.push(`${label}.${name} is invalid`)
    }
  }

  return failures
}

const regressionLimit = (baseline: number): number => baseline + Math.max(baseline * 0.2, 5)

const surfaceFailures = (
  label: string,
  current: ContextOpenStats | undefined,
  baseline: ContextOpenStats | undefined,
  measured: number,
): string[] => {
  const failures = [
    ...validStats(`post ${label}`, current, measured),
    ...validStats(`baseline ${label}`, baseline, measured),
  ]

  if (!current || !baseline) {
    return failures
  }
  // The median, and only the median: at this sample count nearest-rank p95 IS the
  // single worst sample, whose own run-to-run swing on one unchanged image is wider
  // than the allowance below — so a p95 leg here would report noise, not a shift.
  const limit = regressionLimit(baseline.medianMs)

  if (current.medianMs > limit) {
    failures.push(
      `${label}.medianMs ${current.medianMs.toFixed(3)} ms exceeds ${limit.toFixed(3)} ms`,
    )
  }

  return failures
}

const EXPECTED_OUTCOME = {
  applied: 'applied',
  noOp: 'skipped',
  conflict: 'failed',
} as const

const operationFailures = (report: ContextOpenBenchmarkReport): string[] => {
  const failures: string[] = []
  const measuredCycles = report.abilityEdit.raw.filter(({ phase }) => phase === 'measured')

  if (measuredCycles.length !== report.measured) {
    failures.push(
      `abilityEdit has ${measuredCycles.length} measured cycles, expected ${report.measured}`,
    )
  }
  for (const [cycleIndex, cycle] of measuredCycles.entries()) {
    for (const key of ['applied', 'noOp', 'conflict'] as const) {
      const operation = cycle[key]

      if (!operation) {
        failures.push(`abilityEdit cycle ${cycleIndex} is missing ${key}`)
        continue
      }
      if (operation.call.status !== 200 || operation.call.isError === true) {
        failures.push(`abilityEdit cycle ${cycleIndex} ${key} call failed`)
      }
      if (
        operation.call.step?.step !== 'document' ||
        operation.call.step.outcome !== EXPECTED_OUTCOME[key]
      ) {
        failures.push(
          `abilityEdit cycle ${cycleIndex} ${key} is not a document ${EXPECTED_OUTCOME[key]} step`,
        )
      }
      if (operation.unrelatedNote.status !== 200) {
        failures.push(`abilityEdit cycle ${cycleIndex} ${key} unrelated note failed`)
      }
      if (operation.healthHeartbeat.some(({ status }) => status !== 200)) {
        failures.push(`abilityEdit cycle ${cycleIndex} ${key} heartbeat failed`)
      }
    }
  }

  return failures
}

export const contextOpenBenchmarkGateFailures = (
  report: ContextOpenBenchmarkReport,
  baseline?: ContextOpenBenchmarkReport,
): string[] => {
  const failures: string[] = []
  const phase = (report as { phase: string }).phase
  const provenance = report.provenance

  if (phase !== 'pre' && phase !== 'post') {
    return [`unknown benchmark phase: ${phase}`]
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
  const abilityEdit = report.abilityEdit as ContextOpenBenchmarkReport['abilityEdit'] | undefined

  if (
    !abilityEdit ||
    !Array.isArray(abilityEdit.raw) ||
    !Array.isArray(abilityEdit.healthHeartbeat?.failures)
  ) {
    failures.push(`${phase} report has no ability-edit section`)

    return failures
  }
  if (phase === 'pre') {
    if (provenance?.commit !== CONTEXT_OPEN_FROZEN_COMMIT) {
      failures.push(`pre phase must use frozen commit ${CONTEXT_OPEN_FROZEN_COMMIT}`)
    }
    if (report.abilityEdit.completed) {
      failures.push('pre phase must capture the frozen ability-edit failure')
    }
    if (report.abilityEdit.failure !== FROZEN_TIMEOUT_FAILURE) {
      failures.push(`pre phase must capture the exact frozen ${FROZEN_TIMEOUT_FAILURE}`)
    }
    if (report.abilityEdit.timeoutMs !== FROZEN_TIMEOUT_MS) {
      failures.push(`pre phase must use the ${FROZEN_TIMEOUT_MS} ms correctness timeout`)
    }
    if (!report.abilityEdit.targetRef?.trim()) {
      failures.push('pre phase must identify the seeded ability target')
    }
    if (
      report.abilityEdit.applied !== null ||
      report.abilityEdit.noOp !== null ||
      report.abilityEdit.conflict !== null
    ) {
      failures.push('pre phase must not publish completed operation stats')
    }
    const [frozenCycle] = report.abilityEdit.raw

    if (
      report.abilityEdit.raw.length !== 1 ||
      frozenCycle?.phase !== 'warmup' ||
      frozenCycle.applied.call.status !== null ||
      frozenCycle.applied.call.error !== FROZEN_TIMEOUT_FAILURE ||
      frozenCycle.noOp !== undefined ||
      frozenCycle.conflict !== undefined
    ) {
      failures.push('pre phase must contain the single frozen applied-timeout cycle')
    }
    if (report.postAbilitySurfaces !== null) {
      failures.push('pre phase must not claim post-edit surfaces after the frozen timeout')
    }

    return failures
  }

  if (!baseline) {
    failures.push('post phase requires BENCH_BASELINE')
  } else if (baseline.phase !== 'pre') {
    failures.push('BENCH_BASELINE must be a pre report')
  } else {
    failures.push(...contextOpenBenchmarkGateFailures(baseline))
    if (
      !baseline.gate?.passed ||
      baseline.gate.failures.length !== 0 ||
      baseline.gate.baseline !== null
    ) {
      failures.push('BENCH_BASELINE must be an unchanged passing pre harness output')
    }
    if (provenance?.dataRoot !== baseline.provenance?.dataRoot) {
      failures.push('post and baseline must use the same data root')
    }
    if (provenance?.baseUrl !== baseline.provenance?.baseUrl) {
      failures.push('post and baseline must use the same base URL')
    }
    if (provenance?.commit === baseline.provenance?.commit) {
      failures.push('post commit must differ from the frozen baseline commit')
    }
    if (provenance?.image === baseline.provenance?.image) {
      failures.push('post image must differ from the frozen baseline image')
    }
  }
  if (!report.abilityEdit.completed) {
    failures.push(
      `abilityEdit did not complete: ${report.abilityEdit.failure ?? 'unknown failure'}`,
    )
  }
  failures.push(
    ...validStats('abilityEdit.applied', report.abilityEdit.applied, report.measured),
    ...validStats('abilityEdit.noOp', report.abilityEdit.noOp, report.measured),
    ...validStats('abilityEdit.conflict', report.abilityEdit.conflict, report.measured),
    ...operationFailures(report),
  )
  if (report.abilityEdit.timeoutMs !== FROZEN_TIMEOUT_MS) {
    failures.push(`post phase must use the ${FROZEN_TIMEOUT_MS} ms correctness timeout`)
  }
  for (const key of ['applied', 'noOp', 'conflict'] as const) {
    const operation = report.abilityEdit[key]

    if (!operation) {
      continue
    }
    if (operation.p95Ms >= 500) {
      failures.push(`abilityEdit.${key}.p95Ms must be below 500 ms`)
    }
    if (operation.maxMs >= 1_000) {
      failures.push(`abilityEdit.${key}.maxMs must be below 1000 ms`)
    }
  }
  if (report.abilityEdit.healthHeartbeat.failures.length > 0) {
    failures.push('abilityEdit heartbeat has failed samples')
  }
  if (!report.postAbilitySurfaces) {
    failures.push('postAbilitySurfaces is missing')
  }
  if (baseline && report.postAbilitySurfaces) {
    failures.push(
      ...surfaceFailures(
        'noteOpen',
        report.postAbilitySurfaces.noteOpen,
        baseline.noteOpen,
        report.measured,
      ),
      ...surfaceFailures(
        'personalContext',
        report.postAbilitySurfaces.personalContext,
        baseline.personalContext,
        report.measured,
      ),
      ...surfaceFailures(
        'projectContext',
        report.postAbilitySurfaces.projectContext,
        baseline.projectContext,
        report.measured,
      ),
      ...surfaceFailures(
        'dashboard',
        report.postAbilitySurfaces.dashboard,
        baseline.warmDashboard,
        report.measured,
      ),
      ...surfaceFailures(
        'graphHealth',
        report.postAbilitySurfaces.graphHealth,
        baseline.warmGraphHealth,
        report.measured,
      ),
    )
  }
  const heartbeat = report.abilityEdit.healthHeartbeat.stats
  const baselineHeartbeat = baseline?.abilityEdit?.healthHeartbeat?.stats

  if (!heartbeat) {
    failures.push('abilityEdit heartbeat stats are missing')
  } else if (!baselineHeartbeat) {
    failures.push('baseline abilityEdit heartbeat stats are missing')
  } else {
    const limit = Math.max(baselineHeartbeat.maxMs + 100, 250)

    if (heartbeat.maxMs > limit) {
      failures.push(
        `abilityEdit heartbeat max ${heartbeat.maxMs.toFixed(3)} ms exceeds ${limit.toFixed(3)} ms`,
      )
    }
  }

  return failures
}

export type ContextOpenContainerIdentity = {
  builtAt: string | undefined
  health: string | undefined
  image: string | undefined
  revision: string | undefined
  running: boolean | undefined
}

/** The stand the operator declared vs the container Docker reports. Neither the
 *  declared BENCH_IMAGE nor the container's state ever reaches the report, so this
 *  is the only place either can be checked. */
export const contextOpenContainerFailures = (
  expected: { container: string; image: string },
  observed: ContextOpenContainerIdentity,
): string[] => {
  const failures: string[] = []

  if (!observed.running || observed.health !== 'healthy') {
    failures.push(`BENCH_CONTAINER ${expected.container} is not a healthy running container`)
  }
  if (!observed.image || observed.image !== expected.image) {
    failures.push(
      `BENCH_IMAGE ${expected.image} does not match running container image ${observed.image ?? 'none'}`,
    )
  }
  if (!observed.revision || !observed.builtAt) {
    failures.push('running container image has no OCI revision/created provenance')
  }

  return failures
}

/** The same container's OCI labels and the declared BENCH_COMMIT vs the build the
 *  server actually serves. Labels absent altogether are named once, by the container
 *  check above, rather than twice more as mismatches against `undefined`. */
export const contextOpenRuntimeFailures = (
  expected: { commit: string },
  observed: ContextOpenContainerIdentity,
  runtime: { builtAt: string | null; commit: string | null },
): string[] => {
  if (!runtime.commit || !runtime.builtAt) {
    return ['serving runtime does not expose a commit-bound production build']
  }
  const failures: string[] = []

  if (runtime.commit !== expected.commit) {
    failures.push(
      `BENCH_COMMIT ${expected.commit} does not match serving runtime ${runtime.commit}`,
    )
  }
  if (observed.revision && observed.revision !== runtime.commit) {
    failures.push(
      `OCI revision ${observed.revision} does not match serving runtime ${runtime.commit}`,
    )
  }
  if (observed.builtAt && observed.builtAt !== runtime.builtAt) {
    failures.push(
      `OCI created ${observed.builtAt} does not match serving runtime ${runtime.builtAt}`,
    )
  }

  return failures
}
