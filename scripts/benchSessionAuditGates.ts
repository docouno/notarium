export type BenchmarkGateCell = {
  driver: string
  dataset: number
  scope: 'all' | 'outside' | 'session'
  filter: 'all' | 'reads' | 'writes'
  page: 'first' | 'next'
  mode: 'production' | 'diagnostic-reference'
  medianMs: number
}

export type BenchmarkGateProbe = {
  driver: string
  dataset: number
  kind: 'detail' | 'agent' | 'retrieval-order' | 'outside-reads' | 'outside-writes'
  medianMs: number
}

export type BenchmarkGateTraceProbe = {
  driver: string
  dataset: number
  kind: 'compact-write' | 'detailed-write' | 'maintenance' | 'dense-export'
  rows: number
  medianMs: number
  components?: {
    pages?: number
    eventsMs?: number
    detailsMs?: number
    passes?: number
    maxPassMs?: number
    p99PassMs?: number
    processed?: number
    remaining?: number
    yields?: number
  }
}

export type BenchmarkGateAggregatePair = {
  driver: string
  dataset: number
  disabledMedianMs: number
  enabledMedianMs: number
  ratio: number
}

export type BenchmarkGateStorageProbe = {
  driver: string
  dataset: number
  mode: 'compact' | 'detailed'
  method: 'sqlite-json-payload-v1' | 'postgres-row-size-v1'
  rows: number
  bytes: number
  bytesPerRow: number
}

export type BenchmarkGateReport = {
  phase: string
  gitCommit?: string | null
  gitTree?: string | null
  cells: BenchmarkGateCell[]
  probes: BenchmarkGateProbe[]
  aggregatePairs?: BenchmarkGateAggregatePair[]
  traceProbes?: BenchmarkGateTraceProbe[]
  storageProbes?: BenchmarkGateStorageProbe[]
}

const MAX_RATIO = 2
const REGRESSION_RATIO = 1.5
const AGGREGATE_REGRESSION_RATIO = 1.2
const AGGREGATE_REGRESSION_MIN_DELTA_MS = 150
// Sub-millisecond baselines make ratios noisy and punish a fixed extra source query.
// Keep the ratio gate for material latency changes, while the history and absolute
// trace gates below still catch dataset-proportional work.
const REGRESSION_MIN_DELTA_MS = 5
const REQUIRED_DRIVERS = ['sqlite', 'postgres'] as const
const REQUIRED_DATASETS = [10_000, 100_000, 500_000] as const
const REQUIRED_SCOPES = ['all', 'outside', 'session'] as const
const REQUIRED_FILTERS = ['all', 'reads', 'writes'] as const
const REQUIRED_PAGES = ['first', 'next'] as const
const REQUIRED_PROBES: BenchmarkGateProbe['kind'][] = [
  'detail',
  'agent',
  'retrieval-order',
  'outside-reads',
  'outside-writes',
]
const REQUIRED_TRACE_PROBES: BenchmarkGateTraceProbe['kind'][] = [
  'compact-write',
  'detailed-write',
  'maintenance',
  'dense-export',
]

const cellKey = (cell: BenchmarkGateCell): string =>
  `${cell.driver}:${cell.dataset}:${cell.scope}:${cell.filter}:${cell.page}`

const probeKey = (probe: BenchmarkGateProbe): string =>
  `${probe.driver}:${probe.dataset}:${probe.kind}`

const traceProbeKey = (probe: BenchmarkGateTraceProbe): string =>
  `${probe.driver}:${probe.dataset}:${probe.kind}`

const aggregateKey = (pair: BenchmarkGateAggregatePair): string =>
  `${pair.driver}:${pair.dataset}:aggregates`

const REQUIRED_CELL_KEYS = new Set(
  REQUIRED_DRIVERS.flatMap((driver) =>
    REQUIRED_DATASETS.flatMap((dataset) =>
      REQUIRED_SCOPES.flatMap((scope) =>
        REQUIRED_FILTERS.flatMap((filter) =>
          REQUIRED_PAGES.map((page) => `${driver}:${dataset}:${scope}:${filter}:${page}`),
        ),
      ),
    ),
  ),
)

const REQUIRED_PROBE_KEYS = new Set(
  REQUIRED_DRIVERS.flatMap((driver) =>
    REQUIRED_DATASETS.flatMap((dataset) =>
      REQUIRED_PROBES.map((kind) => `${driver}:${dataset}:${kind}`),
    ),
  ),
)
const REQUIRED_TRACE_PROBE_KEYS = new Set(
  REQUIRED_DRIVERS.flatMap((driver) =>
    REQUIRED_DATASETS.flatMap((dataset) =>
      REQUIRED_TRACE_PROBES.map((kind) => `${driver}:${dataset}:${kind}`),
    ),
  ),
)
const REQUIRED_AGGREGATE_KEYS = new Set(
  REQUIRED_DRIVERS.flatMap((driver) =>
    REQUIRED_DATASETS.map((dataset) => `${driver}:${dataset}:aggregates`),
  ),
)
const REQUIRED_STORAGE_KEYS = new Set(
  REQUIRED_DRIVERS.flatMap((driver) =>
    REQUIRED_DATASETS.flatMap((dataset) =>
      (['compact', 'detailed'] as const).map((mode) => `${driver}:${dataset}:${mode}`),
    ),
  ),
)

const matrixFailures = <T extends { medianMs: number }>(
  label: 'post' | 'baseline',
  kind: 'cell' | 'probe',
  rows: readonly T[],
  required: ReadonlySet<string>,
  keyOf: (row: T) => string,
): string[] => {
  if (rows.length === 0) {
    return [`${label} report is missing benchmark ${kind}s`]
  }
  const failures: string[] = []
  const counts = new Map<string, number>()

  for (const row of rows) {
    const key = keyOf(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)

    if (!required.has(key)) {
      failures.push(`${label} report has unexpected ${kind} ${key}`)
    }
    if (typeof row.medianMs !== 'number' || !Number.isFinite(row.medianMs) || row.medianMs < 0) {
      failures.push(`${label} ${kind} ${key} has invalid medianMs`)
    }
  }
  for (const [key, count] of counts) {
    if (count > 1) {
      failures.push(`${label} report has duplicate ${kind} ${key}`)
    }
  }
  for (const key of required) {
    if (!counts.has(key)) {
      failures.push(`${label} report is missing ${kind} ${key}`)
    }
  }

  return failures
}

const ratio = (slower: number, faster: number): number =>
  faster === 0 ? (slower === 0 ? 1 : Number.POSITIVE_INFINITY) : slower / faster

const historyScaleFailures = (
  label: string,
  rows: ReadonlyArray<{ driver: string; dataset: number; medianMs: number; key: string }>,
): string[] => {
  const failures: string[] = []
  const groups = new Map<string, typeof rows>()

  for (const row of rows) {
    const key = `${row.driver}:${row.key}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  for (const [key, group] of groups) {
    const ordered = [...group].sort((left, right) => left.dataset - right.dataset)

    if (ordered.length < 2) {
      failures.push(`${label} ${key} needs at least two dataset sizes`)
      continue
    }
    const first = ordered[0]!
    const last = ordered.at(-1)!
    const measuredRatio = ratio(last.medianMs, first.medianMs)

    if (measuredRatio > MAX_RATIO && last.medianMs - first.medianMs > REGRESSION_MIN_DELTA_MS) {
      failures.push(
        `${label} ${key} history ratio ${measuredRatio.toFixed(3)} exceeds ${MAX_RATIO}`,
      )
    }
  }

  return failures
}

export const benchmarkGateFailures = (
  report: BenchmarkGateReport,
  baseline?: BenchmarkGateReport,
): string[] => {
  if (report.phase !== 'post') {
    return []
  }
  const failures: string[] = []

  if (!baseline) {
    failures.push('post phase requires BENCH_BASELINE')
  } else if (baseline.phase !== 'pre') {
    failures.push('BENCH_BASELINE must be a pre report')
  }
  if (!report.gitCommit || !report.gitTree) {
    failures.push('post report requires git commit and tree identity')
  }
  if (baseline && (!baseline.gitCommit || !baseline.gitTree)) {
    failures.push('baseline report requires git commit and tree identity')
  }
  failures.push(
    ...matrixFailures('post', 'cell', report.cells, REQUIRED_CELL_KEYS, cellKey),
    ...matrixFailures('post', 'probe', report.probes, REQUIRED_PROBE_KEYS, probeKey),
    ...matrixFailures(
      'post',
      'probe',
      report.traceProbes ?? [],
      REQUIRED_TRACE_PROBE_KEYS,
      traceProbeKey,
    ),
    ...matrixFailures(
      'post',
      'probe',
      (report.aggregatePairs ?? []).map((pair) => ({ ...pair, medianMs: pair.enabledMedianMs })),
      REQUIRED_AGGREGATE_KEYS,
      aggregateKey,
    ),
  )
  const storageCounts = new Map<string, number>()

  for (const probe of report.storageProbes ?? []) {
    const key = `${probe.driver}:${probe.dataset}:${probe.mode}`
    storageCounts.set(key, (storageCounts.get(key) ?? 0) + 1)
    const expectedMethod =
      probe.driver === 'sqlite'
        ? 'sqlite-json-payload-v1'
        : probe.driver === 'postgres'
          ? 'postgres-row-size-v1'
          : null

    if (!REQUIRED_STORAGE_KEYS.has(key)) {
      failures.push(`post report has unexpected storage probe ${key}`)
    }
    if (probe.method !== expectedMethod) {
      failures.push(`post storage probe ${key} has invalid measurement method`)
    }
    if (
      !Number.isSafeInteger(probe.rows) ||
      probe.rows <= 0 ||
      !Number.isFinite(probe.bytes) ||
      probe.bytes <= 0 ||
      !Number.isFinite(probe.bytesPerRow) ||
      Math.abs(probe.bytesPerRow - probe.bytes / probe.rows) > 0.001
    ) {
      failures.push(`post storage probe ${key} has invalid bytes`)
    }
    const limit = probe.mode === 'compact' ? 16_384 : 24_576

    if (probe.bytesPerRow > limit) {
      failures.push(
        `post storage probe ${key} ${probe.bytesPerRow.toFixed(1)} bytes/row exceeds ${limit}`,
      )
    }
  }
  for (const key of REQUIRED_STORAGE_KEYS) {
    if (!storageCounts.has(key)) {
      failures.push(`post report is missing storage probe ${key}`)
    } else if (storageCounts.get(key) !== 1) {
      failures.push(`post report has duplicate storage probe ${key}`)
    }
  }
  for (const driver of REQUIRED_DRIVERS) {
    for (const dataset of REQUIRED_DATASETS) {
      const compact = report.storageProbes?.find(
        (probe) => probe.driver === driver && probe.dataset === dataset && probe.mode === 'compact',
      )
      const detailed = report.storageProbes?.find(
        (probe) =>
          probe.driver === driver && probe.dataset === dataset && probe.mode === 'detailed',
      )

      if (compact && detailed && detailed.bytesPerRow <= compact.bytesPerRow) {
        failures.push(`post detailed storage ${driver}:${dataset} does not exceed Compact`)
      }
    }
  }
  if (baseline) {
    if (report.gitCommit && baseline.gitCommit && report.gitCommit === baseline.gitCommit) {
      failures.push('post and baseline report the same git commit')
    }
    if (report.gitTree && baseline.gitTree && report.gitTree === baseline.gitTree) {
      failures.push('post and baseline report the same git tree')
    }
    failures.push(
      ...matrixFailures('baseline', 'cell', baseline.cells, REQUIRED_CELL_KEYS, cellKey),
      ...matrixFailures('baseline', 'probe', baseline.probes, REQUIRED_PROBE_KEYS, probeKey),
    )
  }

  for (const probe of report.traceProbes ?? []) {
    const writeLimit = probe.driver === 'sqlite' ? 20 : 100
    const maintenanceP99PassLimit = probe.driver === 'sqlite' ? 250 : 1_000
    const maintenanceMaxPassLimit = probe.driver === 'sqlite' ? 500 : 5_000
    const maintenancePerThousandLimit = probe.driver === 'sqlite' ? 100 : 500
    const exportPerThousand = (probe.medianMs / Math.max(1, probe.rows)) * 1_000

    if (
      (probe.kind === 'compact-write' || probe.kind === 'detailed-write') &&
      probe.medianMs > writeLimit
    ) {
      failures.push(
        `trace ${traceProbeKey(probe)} ${probe.medianMs.toFixed(3)} ms exceeds ${writeLimit}`,
      )
    }
    if (probe.kind === 'maintenance') {
      const components = probe.components
      const perThousand = (probe.medianMs / probe.dataset) * 1_000

      if (
        components?.passes == null ||
        components.maxPassMs == null ||
        components.p99PassMs == null ||
        components.processed == null ||
        components.remaining == null ||
        components.yields == null
      ) {
        failures.push(`trace ${traceProbeKey(probe)} is missing convergence components`)
      } else {
        if (components.remaining !== 0) {
          failures.push(`trace ${traceProbeKey(probe)} left ${components.remaining} rows`)
        }
        if (components.processed !== probe.rows || probe.rows < probe.dataset) {
          failures.push(`trace ${traceProbeKey(probe)} reports inconsistent processed rows`)
        }
        if (components.yields < Math.max(0, components.passes - 1)) {
          failures.push(`trace ${traceProbeKey(probe)} did not yield between cleanup passes`)
        }
        if (components.p99PassMs > maintenanceP99PassLimit) {
          failures.push(
            `trace ${traceProbeKey(probe)} p99 pass ${components.p99PassMs.toFixed(3)} ms exceeds ${maintenanceP99PassLimit}`,
          )
        }
        if (components.maxPassMs > maintenanceMaxPassLimit) {
          failures.push(
            `trace ${traceProbeKey(probe)} max pass ${components.maxPassMs.toFixed(3)} ms exceeds ${maintenanceMaxPassLimit}`,
          )
        }
        if (components.passes > 1_800) {
          failures.push(`trace ${traceProbeKey(probe)} needs ${components.passes} cleanup passes`)
        }
      }
      if (perThousand > maintenancePerThousandLimit) {
        failures.push(
          `trace ${traceProbeKey(probe)} convergence ${perThousand.toFixed(3)} ms/1k calls exceeds ${maintenancePerThousandLimit}`,
        )
      }
    }
    if (probe.kind === 'dense-export') {
      if (probe.rows < probe.dataset) {
        failures.push(`trace ${traceProbeKey(probe)} exported fewer rows than the dataset`)
      }
      if (exportPerThousand > 100) {
        failures.push(
          `trace ${traceProbeKey(probe)} ${exportPerThousand.toFixed(3)} ms/1k rows exceeds 100`,
        )
      }
    }
  }
  const baselineAggregates = new Map(
    (baseline?.aggregatePairs ?? []).map((pair) => [aggregateKey(pair), pair]),
  )

  for (const pair of report.aggregatePairs ?? []) {
    if (
      !Number.isFinite(pair.disabledMedianMs) ||
      !Number.isFinite(pair.enabledMedianMs) ||
      !Number.isFinite(pair.ratio) ||
      pair.disabledMedianMs < 0 ||
      pair.enabledMedianMs < 0 ||
      pair.ratio < 0
    ) {
      failures.push(`post aggregate ${aggregateKey(pair)} has invalid timings`)
    } else {
      const before = baselineAggregates.get(aggregateKey(pair))
      const absoluteLimit = pair.driver === 'sqlite' ? 3_500 : 300
      const allowed = Math.min(
        absoluteLimit,
        before
          ? Math.max(
              before.enabledMedianMs + AGGREGATE_REGRESSION_MIN_DELTA_MS,
              before.enabledMedianMs * AGGREGATE_REGRESSION_RATIO,
            )
          : absoluteLimit,
      )

      if (pair.enabledMedianMs <= allowed) {
        continue
      }
      failures.push(
        `post aggregate ${aggregateKey(pair)} ${pair.enabledMedianMs.toFixed(3)} ms exceeds ${allowed.toFixed(3)}`,
      )
    }
  }
  for (const cell of report.cells) {
    if (cell.mode !== 'production') {
      failures.push(
        `post phase used ${cell.mode} for ${cell.driver}:${cell.dataset}:${cell.scope}/${cell.filter}/${cell.page}`,
      )
    }
  }
  failures.push(
    ...historyScaleFailures(
      'page',
      report.cells.map((cell) => ({
        driver: cell.driver,
        dataset: cell.dataset,
        medianMs: cell.medianMs,
        key: `${cell.scope}/${cell.filter}/${cell.page}`,
      })),
    ),
    ...historyScaleFailures(
      'probe',
      report.probes.map((probe) => ({
        driver: probe.driver,
        dataset: probe.dataset,
        medianMs: probe.medianMs,
        key: probe.kind,
      })),
    ),
  )

  if (baseline) {
    for (const cell of baseline.cells) {
      if (cell.scope !== 'all' && cell.mode !== 'production') {
        failures.push(
          `baseline used ${cell.mode} for ${cell.driver}:${cell.dataset}:${cell.scope}/${cell.filter}/${cell.page}`,
        )
      }
    }
    const baselineCells = new Map(
      baseline.cells.map((cell) => [
        `${cell.driver}:${cell.dataset}:${cell.scope}:${cell.filter}:${cell.page}`,
        cell,
      ]),
    )
    const baselineProbes = new Map(baseline.probes.map((probe) => [probeKey(probe), probe]))

    for (const cell of report.cells) {
      if (cell.scope === 'all') {
        continue
      }
      const key = cellKey(cell)
      const before = baselineCells.get(key)

      if (!before) {
        failures.push(`baseline is missing ${key}`)
        continue
      }
      const measuredRatio = ratio(cell.medianMs, before.medianMs)

      if (
        measuredRatio > REGRESSION_RATIO &&
        cell.medianMs > before.medianMs + REGRESSION_MIN_DELTA_MS
      ) {
        failures.push(
          `regression ${key} ratio ${measuredRatio.toFixed(3)} exceeds ${REGRESSION_RATIO}`,
        )
      }
    }
    for (const probe of report.probes) {
      const key = probeKey(probe)
      const before = baselineProbes.get(key)

      if (!before) {
        continue
      }
      const measuredRatio = ratio(probe.medianMs, before.medianMs)

      if (
        measuredRatio > REGRESSION_RATIO &&
        probe.medianMs > before.medianMs + REGRESSION_MIN_DELTA_MS
      ) {
        failures.push(
          `probe regression ${key} ratio ${measuredRatio.toFixed(3)} exceeds ${REGRESSION_RATIO}`,
        )
      }
    }
  }

  return failures
}
