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

export type BenchmarkGateReport = {
  phase: string
  cells: BenchmarkGateCell[]
  probes: BenchmarkGateProbe[]
}

const MAX_RATIO = 2
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

const cellKey = (cell: BenchmarkGateCell): string =>
  `${cell.driver}:${cell.dataset}:${cell.scope}:${cell.filter}:${cell.page}`

const probeKey = (probe: BenchmarkGateProbe): string =>
  `${probe.driver}:${probe.dataset}:${probe.kind}`

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

    if (measuredRatio > MAX_RATIO) {
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
  failures.push(
    ...matrixFailures('post', 'cell', report.cells, REQUIRED_CELL_KEYS, cellKey),
    ...matrixFailures('post', 'probe', report.probes, REQUIRED_PROBE_KEYS, probeKey),
  )
  if (baseline) {
    failures.push(
      ...matrixFailures('baseline', 'cell', baseline.cells, REQUIRED_CELL_KEYS, cellKey),
      ...matrixFailures('baseline', 'probe', baseline.probes, REQUIRED_PROBE_KEYS, probeKey),
    )
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

      if (measuredRatio > MAX_RATIO) {
        failures.push(`regression ${key} ratio ${measuredRatio.toFixed(3)} exceeds ${MAX_RATIO}`)
      }
    }
  }

  return failures
}
