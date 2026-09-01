import { readFileSync } from 'node:fs'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  ACTIVITY_GROUPS_LIVENESS_PROFILE,
  ACTIVITY_GROUPS_MANIFEST_SHA256,
  ACTIVITY_GROUPS_OFFLINE_REBUILD_BATCH_SIZE,
  ACTIVITY_GROUPS_PHASE_TIMEOUT_MS,
  ACTIVITY_GROUPS_PRODUCER_PROFILE,
  type ActivityGroupsBenchReport,
  activityGroupsGateFailures,
  type ActivityGroupsManifest,
  activityGroupsProofFailures,
  activityGroupsSmokeFailures,
  activityGroupsSmokeWarnings,
  minimumActivityGroupsProducerHeadRows,
  nearestRank,
} from '../../scripts/activityGroupsBenchGates'
import {
  ACTIVITY_GROUPS_GATE_DATABASE,
  resetActivityGroupsPgSchemas,
} from '../../scripts/activityGroupsPgReset'

const manifest = JSON.parse(
  readFileSync('test/cases/manifests/activity-groups-v1.json', 'utf8'),
) as ActivityGroupsManifest
const preCommit = '4d824c336927f52df5a671ad4284c772f7183a01'
const postCommit = `worktree:${'a'.repeat(64)}`
const runnerImage = `sha256:${'b'.repeat(64)}`
const measuredVariants = (dialect: 'sqlite' | 'postgres') =>
  dialect === 'sqlite' ? (['base', 'revision-10x', 'breadth-10x'] as const) : (['base'] as const)

const report = (): ActivityGroupsBenchReport => ({
  scenario: 'activity-groups-v1',
  manifest: { sha256: ACTIVITY_GROUPS_MANIFEST_SHA256, version: manifest.version },
  provenance: {
    preCommit,
    postCommit,
    preImage: `${runnerImage}+git:${preCommit}`,
    postImage: `${runnerImage}+${postCommit}`,
    postgresImage: `sha256:${'d'.repeat(64)}`,
    loaderVersion: 'activity-groups-loader-v1',
    migrationsChecksum: 'migrations-v1',
  },
  resources: { appCpu: 2, appMemoryMiB: 2048, postgresCpu: 2, postgresMemoryMiB: 2048 },
  profiles: {
    producer: { ...ACTIVITY_GROUPS_PRODUCER_PROFILE },
    liveness: { ...ACTIVITY_GROUPS_LIVENESS_PROFILE },
    offlineRebuildBatchSize: ACTIVITY_GROUPS_OFFLINE_REBUILD_BATCH_SIZE,
    phaseTimeoutMs: ACTIVITY_GROUPS_PHASE_TIMEOUT_MS,
    deepCorpusBlobs: false,
    dialectsParallel: false,
    deepDialects: ['sqlite'],
  },
  corpus: (['sqlite', 'postgres'] as const).flatMap((dialect) =>
    measuredVariants(dialect).map((variant) => {
      const expected = manifest.variants[variant]
      const baselineNotes = variant === 'breadth-10x' ? 4_000 : 400
      return {
        dialect,
        variant,
        ...expected,
        baselineNotes,
        originNotes: expected.activeNotes - baselineNotes,
        gaps: expected.revisions * 0.02,
        cleanStop: true,
      }
    }),
  ),
  latency: (['sqlite', 'postgres'] as const).flatMap((dialect) =>
    measuredVariants(dialect).flatMap((variant) =>
      (['current', 'historical'] as const).flatMap((cut) =>
        (['note', 'folder'] as const).flatMap((by) =>
          (['all', 'mine'] as const).map((scope) => ({
            dialect,
            variant,
            cut,
            by,
            scope,
            cycles: Array.from({ length: 3 }, () => ({
              coldMs: 60,
              warmMs: Array.from({ length: 20 }, () => 45),
              productionHeartbeat: {
                productionTurns: cut === 'current' ? 25 : 24,
                timerActiveTurns: cut === 'current' ? 25 : 24,
                heartbeatSamples: 20,
                blocksOverOneSecond: 0,
                totalLatenessMs: 40,
                latenessMaxMs: 20,
              },
              ...(cut === 'current' ? { locationChurnMs: 70 } : {}),
            })),
          })),
        ),
      ),
    ),
  ),
  existing: (['sqlite', 'postgres'] as const).flatMap((dialect) =>
    (['activity', 'events', 'note', 'append'] as const).map((surface) => ({
      dialect,
      surface,
      baselineMedianMs: 20,
      baselineP95Ms: 30,
      candidateMedianMs: 25,
      candidateP95Ms: 35,
      candidateMaxMs: 100,
    })),
  ),
  heartbeat: (['sqlite', 'postgres'] as const).map((dialect) => ({
    dialect,
    sourceRows: ACTIVITY_GROUPS_LIVENESS_PROFILE.revisions,
    liveNotes: ACTIVITY_GROUPS_LIVENESS_PROFILE.liveNotes,
    durationSeconds: 90,
    intervalMs: 50,
    completed: true,
    published: true,
    restarted: true,
    invalidationRecovered: true,
    gcDrained: true,
    referenceMatched: true,
    blocksOverOneSecond: 0,
    totalLatenessMs: 2_000,
    responseMaxMs: 200,
    latenessMaxMs: 200,
    readyReadMaxMs: 200,
    readyReadLatenessMaxMs: 40,
    pairedBaselineResponseMaxMs: 100,
    pairedBaselineLatenessMaxMs: 100,
    baselineAppendMedianMs: 20,
    baselineAppendP95Ms: 30,
    appendMedianMs: 24,
    appendP95Ms: 34,
    appendMaxMs: 100,
    maxGcBatchMs: 100,
    phaseObservations: (
      [
        'paced-rebuild',
        'near-publication-invalidation',
        'restart',
        'replacement-publication',
        'generation-gc',
        'ready-reads',
      ] as const
    ).map((phase) => ({
      phase,
      durationMs: 500,
      workUnits: 10,
      heartbeatSamples: 10,
      blocksOverOneSecond: 0,
      totalLatenessMs: 50,
      latenessMaxMs: 20,
      responseMaxMs: 100,
      foregroundPoint: { count: 2, medianMs: 20, p95Ms: 25, maxMs: 25 },
      foregroundAppend: { count: 2, medianMs: 24, p95Ms: 34, maxMs: 34 },
    })),
  })),
  storage: (['sqlite', 'postgres'] as const).flatMap((dialect) =>
    measuredVariants(dialect).map((variant) => ({
      dialect,
      variant,
      journalBytes: 10_000,
      projectionBytes: 1_000,
      statusRows: 1,
      orderRows: 0,
      stateRows: 100,
      headRows: 10,
      gcRows: 0,
    })),
  ),
  producer: [
    ...(['sqlite', 'postgres'] as const).map((dialect) => {
      const sourceRows = ACTIVITY_GROUPS_PRODUCER_PROFILE.revisions
      const stateRows = sourceRows - ACTIVITY_GROUPS_PRODUCER_PROFILE.baselineNotes
      const headRows = minimumActivityGroupsProducerHeadRows(ACTIVITY_GROUPS_PRODUCER_PROFILE)
      const auxiliaryRows = sourceRows + stateRows + headRows

      return {
        kind: 'fresh-ready' as const,
        dialect,
        variant: 'base' as const,
        elapsedMs: 1_000,
        sourceRows,
        transactions: dialect === 'sqlite' ? Math.ceil(sourceRows / 10_000) : 1,
        statusRows: 1,
        orderRows: sourceRows,
        stateRows,
        headRows,
        auxiliaryRows,
        auxiliaryRowsPerSource: auxiliaryRows / sourceRows,
      }
    }),
    {
      kind: 'postgres-contention' as const,
      dialect: 'postgres' as const,
      variant: 'base' as const,
      writes: 128,
      concurrency: 10,
      elapsedMs: 500,
      throughputPerSecond: 256,
      appendLatencyMs: { median: 20, p95: 40, max: 80 },
      overlap: { maxInFlight: 10 },
      postgresWaits: {
        samples: 10,
        activeSamples: 30,
        waitingSamples: 20,
        lockWaitingSamples: 20,
        maxActive: 10,
        maxWaiting: 9,
        waitEvents: { 'Lock:transactionid': 20 },
      },
      rowAmplification: {
        sourceRows: 128,
        orderRows: 128,
        stateRows: 128,
        headRows: 128,
        auxiliaryRows: 384,
        auxiliaryRowsPerSource: 3,
      },
    },
  ],
  proofs: {
    migrationCarrier: true,
    producerAtomicity: true,
    commitOrder: true,
    currentHistoricalReference: true,
    workerRecovery: true,
  },
  structure: {
    bodyReads: 0,
    rawRevisionMaterializations: 0,
    queryPerGroup: 0,
    duplicateOverviewScans: 0,
    retainedGroupsBase: 4_000,
    retainedGroupsRevision10x: 4_000,
    responseItemsBase: 12,
    responseItemsRevision10x: 12,
    missingProductionLayers: [],
    faultInjectionFailures: {
      'raw-before-group': true,
      'eager-raw-array': true,
      'query-per-group': true,
      'duplicate-scan': true,
      'number-cursor': true,
      'unbounded-page': true,
    },
  },
})

describe('activity groups production gate', () => {
  it('drops every non-system schema only after confirming the exact gate database', async () => {
    const queries: string[] = []
    const client = {
      query: async (text: string) => {
        queries.push(text)

        if (text === 'SELECT current_database() AS database') {
          return { rows: [{ database: ACTIVITY_GROUPS_GATE_DATABASE }] }
        }
        if (text === 'SELECT nspname AS schema FROM pg_namespace ORDER BY nspname') {
          return {
            rows: [
              { schema: 'information_schema' },
              { schema: 'leftover_test_schema' },
              { schema: 'odd"schema' },
              { schema: 'pg_catalog' },
              { schema: 'pg_temp_3' },
              { schema: 'public' },
            ],
          }
        }

        return { rows: [] }
      },
    } as unknown as PoolClient

    await resetActivityGroupsPgSchemas(client)

    expect(queries).toEqual([
      'BEGIN',
      'SELECT current_database() AS database',
      'SELECT nspname AS schema FROM pg_namespace ORDER BY nspname',
      'DROP SCHEMA "leftover_test_schema" CASCADE',
      'DROP SCHEMA "odd""schema" CASCADE',
      'DROP SCHEMA "public" CASCADE',
      'CREATE SCHEMA public',
      'COMMIT',
    ])
  })

  it('rolls back without dropping schemas when the connected database is not the gate', async () => {
    const queries: string[] = []
    const client = {
      query: async (text: string) => {
        queries.push(text)

        return text === 'SELECT current_database() AS database'
          ? { rows: [{ database: 'notarium' }] }
          : { rows: [] }
      },
    } as unknown as PoolClient

    await expect(resetActivityGroupsPgSchemas(client)).rejects.toThrow(
      `must target ${ACTIVITY_GROUPS_GATE_DATABASE}`,
    )
    expect(queries).toEqual(['BEGIN', 'SELECT current_database() AS database', 'ROLLBACK'])
  })

  it('accepts the exact paired protocol', () => {
    expect(activityGroupsGateFailures(report(), manifest)).toEqual([])
  })

  it('uses nearest-rank percentiles', () => {
    expect(nearestRank([4, 1, 3, 2], 0.5)).toBe(2)
    expect(nearestRank([4, 1, 3, 2], 0.95)).toBe(4)
  })

  it('fails closed when a declared proof is missing, skipped or ambiguous', () => {
    const result = (assertionResults: Array<{ title: string; status: string }>) => ({
      testResults: [{ assertionResults }],
    })

    expect(activityGroupsProofFailures(result([]), ['required proof'])).toHaveLength(1)
    expect(
      activityGroupsProofFailures(result([{ title: 'required proof', status: 'skipped' }]), [
        'required proof',
      ]),
    ).toHaveLength(1)
    expect(
      activityGroupsProofFailures(
        result([
          { title: 'required proof', status: 'passed' },
          { title: 'required proof', status: 'passed' },
        ]),
        ['required proof'],
      ),
    ).toHaveLength(1)
    expect(
      activityGroupsProofFailures(result([{ title: 'required proof', status: 'passed' }]), [
        'required proof',
      ]),
    ).toEqual([])
  })

  it('requires the exact proof and negative-control keys with literal true values', () => {
    const value = report()
    const proofs = value.proofs as Record<string, unknown>
    const faults = value.structure.faultInjectionFailures as Record<string, unknown>

    delete proofs.commitOrder
    proofs.unexpectedProof = true
    proofs.workerRecovery = 'true'
    delete faults['query-per-group']
    faults['unexpected-control'] = true
    faults['number-cursor'] = 1

    expect(activityGroupsGateFailures(value, manifest)).toEqual(
      expect.arrayContaining([
        'production proof set is missing required key: commitOrder',
        'production proof set has unexpected key: unexpectedProof',
        'production proof did not pass: workerRecovery',
        'negative-control set is missing required key: query-per-group',
        'negative-control set has unexpected key: unexpected-control',
        'producer fault did not fail: number-cursor',
      ]),
    )

    const omitted = report() as unknown as Record<string, unknown>
    delete omitted.proofs
    ;(omitted.structure as Record<string, unknown>).faultInjectionFailures = null

    expect(
      activityGroupsGateFailures(omitted as unknown as ActivityGroupsBenchReport, manifest),
    ).toEqual(
      expect.arrayContaining([
        'production proof set must be an object with the exact required keys',
        'negative-control set must be an object with the exact required keys',
      ]),
    )
  })

  it('rejects null and non-finite heartbeat and paired structure scalars', () => {
    const heartbeatMetrics = [
      'durationSeconds',
      'intervalMs',
      'blocksOverOneSecond',
      'totalLatenessMs',
      'responseMaxMs',
      'latenessMaxMs',
      'readyReadMaxMs',
      'readyReadLatenessMaxMs',
      'pairedBaselineResponseMaxMs',
      'pairedBaselineLatenessMaxMs',
      'baselineAppendMedianMs',
      'baselineAppendP95Ms',
      'appendMedianMs',
      'appendP95Ms',
      'appendMaxMs',
      'maxGcBatchMs',
    ] as const

    for (const metric of heartbeatMetrics) {
      const value = report()
      ;(value.heartbeat[0] as unknown as Record<string, unknown>)[metric] = null

      expect(activityGroupsGateFailures(value, manifest)).toContain(
        `sqlite heartbeat ${metric} must be finite and nonnegative`,
      )
    }

    const paired = report()
    const structure = paired.structure as unknown as Record<string, unknown>

    structure.retainedGroupsBase = null
    structure.retainedGroupsRevision10x = null
    structure.responseItemsBase = Number.NaN
    structure.responseItemsRevision10x = Number.POSITIVE_INFINITY

    expect(activityGroupsGateFailures(paired, manifest)).toEqual(
      expect.arrayContaining([
        'activity groups structure.retainedGroupsBase must be a nonnegative integer',
        'activity groups structure.retainedGroupsRevision10x must be a nonnegative integer',
        'activity groups structure.responseItemsBase must be a nonnegative integer',
        'activity groups structure.responseItemsRevision10x must be a nonnegative integer',
      ]),
    )
  })

  it('fails smoke on a recovery-phase heartbeat block outside the paced aggregate', () => {
    const value = report()
    const replacement = value.heartbeat[0]!.phaseObservations.find(
      ({ phase }) => phase === 'replacement-publication',
    )!

    expect(value.heartbeat[0]!.blocksOverOneSecond).toBe(0)
    replacement.blocksOverOneSecond = 1
    replacement.latenessMaxMs = 1_498

    expect(activityGroupsSmokeFailures(value)).toEqual([
      'sqlite/replacement-publication smoke heartbeat blocked over one second',
      'sqlite/replacement-publication smoke heartbeat lateness must be finite and below 1000 ms',
    ])

    replacement.blocksOverOneSecond = 0
    replacement.latenessMaxMs = Number.NaN
    expect(activityGroupsSmokeFailures(value)).toEqual([
      'sqlite/replacement-publication smoke heartbeat lateness must be finite and below 1000 ms',
    ])
  })

  it('warns without failing for uncapped smoke response and grouped latency tails', () => {
    const value = report()
    const replacement = value.heartbeat[0]!.phaseObservations.find(
      ({ phase }) => phase === 'replacement-publication',
    )!
    const cycle = value.latency.find(({ cut }) => cut === 'current')!.cycles[0]!

    replacement.responseMaxMs = 1_233
    cycle.coldMs = 1_176
    cycle.warmMs[0] = 2_248
    cycle.locationChurnMs = 1_500
    cycle.productionHeartbeat.latenessMaxMs = 300

    expect(activityGroupsSmokeFailures(value)).toEqual([])
    expect(activityGroupsSmokeWarnings(value)).toEqual([
      'sqlite/replacement-publication smoke work-unit response reached 1233 ms',
      'sqlite/base/current/note/all smoke cycle 1 cold reached 1176 ms',
      'sqlite/base/current/note/all smoke cycle 1 warm 1 reached 2248 ms',
      'sqlite/base/current/note/all smoke cycle 1 location churn reached 1500 ms',
      'sqlite/base/current/note/all smoke cycle 1 production event-loop lateness reached 300 ms',
    ])
  })

  it('binds runner and PostgreSQL image ids to the measured trees', () => {
    const unboundPre = report()
    unboundPre.provenance.preImage = runnerImage
    expect(activityGroupsGateFailures(unboundPre, manifest)).toContain(
      'activity groups pre image must bind the runner image id to the baseline commit',
    )

    const differentRunner = report()
    differentRunner.provenance.postImage = `sha256:${'e'.repeat(64)}+${postCommit}`
    expect(activityGroupsGateFailures(differentRunner, manifest)).toContain(
      'activity groups post image must bind the same runner image id to the post tree',
    )

    const taggedPostgres = report()
    taggedPostgres.provenance.postgresImage = 'postgres:16-alpine'
    expect(activityGroupsGateFailures(taggedPostgres, manifest)).toContain(
      'activity groups PostgreSQL image must be an inspected image id',
    )

    const invalidTree = report()
    invalidTree.provenance.postCommit = 'candidate'
    invalidTree.provenance.postImage = `${runnerImage}+candidate`
    expect(activityGroupsGateFailures(invalidTree, manifest)).toContain(
      'activity groups post tree identity has an invalid format',
    )
  })

  it('fails corpus, latency, liveness and producer-shape regressions', () => {
    const value = report()
    value.corpus[0]!.revisions--
    value.latency[0]!.cycles[0]!.warmMs[0] = 1_000
    value.heartbeat[0]!.blocksOverOneSecond = 1
    value.heartbeat[0]!.completed = false
    value.structure.bodyReads = 1
    value.structure.missingProductionLayers = ['rest-wire']
    if (value.producer[0]!.kind === 'fresh-ready') {
      value.producer[0]!.sourceRows--
    }
    value.structure.faultInjectionFailures['number-cursor'] = false

    expect(activityGroupsGateFailures(value, manifest)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('revisions'),
        expect.stringContaining('max reached 1000 ms'),
        expect.stringContaining('blocked over one second'),
        expect.stringContaining('liveness proof did not complete: completed'),
        expect.stringContaining('read note bodies'),
        expect.stringContaining('fresh-ready producer cardinality'),
        expect.stringContaining('production source chain is incomplete'),
        expect.stringContaining('number-cursor'),
      ]),
    )
  })

  it('fails closed when a bounded execution profile or liveness corpus drifts', () => {
    const value = report()

    value.profiles.producer.revisions++
    value.heartbeat[0]!.sourceRows--

    expect(activityGroupsGateFailures(value, manifest)).toEqual(
      expect.arrayContaining([
        'activity groups bounded execution profiles do not match the reviewed protocol',
        'sqlite heartbeat corpus profile mismatch',
      ]),
    )
  })

  it('fails a production-route event-loop stall even when wall latency stays below its ceiling', () => {
    const value = report()
    const heartbeat = value.latency[0]!.cycles[0]!.productionHeartbeat

    heartbeat.latenessMaxMs = 100
    expect(activityGroupsGateFailures(value, manifest)).toContain(
      'sqlite/base/current/note/all production route blocked the event loop',
    )

    heartbeat.latenessMaxMs = 20
    heartbeat.heartbeatSamples = 0
    expect(activityGroupsGateFailures(value, manifest)).toContain(
      'sqlite/base/current/note/all production-route heartbeat metrics are invalid',
    )

    heartbeat.heartbeatSamples = 20
    heartbeat.latenessMaxMs = 80
    heartbeat.totalLatenessMs = 625
    expect(activityGroupsGateFailures(value, manifest)).toContain(
      'sqlite/base/current/note/all production route accumulated event-loop debt',
    )

    heartbeat.totalLatenessMs = 0
    heartbeat.productionTurns = 1
    heartbeat.timerActiveTurns = 1
    heartbeat.heartbeatSamples = 1
    expect(activityGroupsGateFailures(value, manifest)).toContain(
      'sqlite/base/current/note/all production-route heartbeat metrics are invalid',
    )

    heartbeat.productionTurns = 25
    expect(activityGroupsGateFailures(value, manifest)).toContain(
      'sqlite/base/current/note/all production-route heartbeat metrics are invalid',
    )
  })

  it('fails closed for missing production latency cells and location churn', () => {
    const value = report()
    const duplicate = structuredClone(value.latency[0]!)

    value.latency[1] = duplicate
    delete value.latency.find(({ cut }) => cut === 'current')!.cycles[0]!.locationChurnMs

    expect(activityGroupsGateFailures(value, manifest)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('latency cell must appear exactly once'),
        expect.stringContaining('current-location churn was not measured'),
      ]),
    )
  })

  it('fails closed for missing or lossy fresh-ready/contention producer evidence', () => {
    const missing = report()
    missing.producer = missing.producer.filter(({ kind }) => kind !== 'postgres-contention')

    expect(activityGroupsGateFailures(missing, manifest)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('two bounded fresh-ready cells and one PG contention'),
      ]),
    )

    const missingOriginHead = report()
    const fresh = missingOriginHead.producer.find(
      (entry) => entry.kind === 'fresh-ready' && entry.dialect === 'sqlite',
    )!

    if (fresh.kind !== 'fresh-ready') {
      throw new Error('fixture fresh-ready evidence is missing')
    }
    fresh.headRows = minimumActivityGroupsProducerHeadRows(ACTIVITY_GROUPS_PRODUCER_PROFILE) - 1
    fresh.auxiliaryRows = fresh.orderRows + fresh.stateRows + fresh.headRows
    fresh.auxiliaryRowsPerSource = fresh.auxiliaryRows / fresh.sourceRows

    expect(activityGroupsGateFailures(missingOriginHead, manifest)).toContain(
      'sqlite/bounded fresh-ready producer cardinality mismatch',
    )

    const lossy = report()
    const contention = lossy.producer.find(({ kind }) => kind === 'postgres-contention')!

    if (contention.kind !== 'postgres-contention') {
      throw new Error('fixture contention evidence is missing')
    }
    contention.rowAmplification.orderRows--
    contention.appendLatencyMs.max = 1_000
    contention.postgresWaits.lockWaitingSamples = 0

    expect(activityGroupsGateFailures(lossy, manifest)).toEqual(
      expect.arrayContaining([
        'postgres contention protocol or latency mismatch',
        'postgres contention lost rows or changed write amplification',
      ]),
    )
  })

  it('fails closed for slow or unmeasured generation GC', () => {
    const slowBatch = report()
    const slowBatchGc = slowBatch.heartbeat[0]!.phaseObservations.find(
      ({ phase }) => phase === 'generation-gc',
    )!

    slowBatch.heartbeat[0]!.maxGcBatchMs = 1_000
    slowBatchGc.responseMaxMs = 1_000
    expect(activityGroupsGateFailures(slowBatch, manifest)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('generation GC batch was not bounded'),
        expect.stringContaining('generation-gc work unit exceeded its response ceiling'),
      ]),
    )

    const noHeartbeat = report()
    const noHeartbeatGc = noHeartbeat.heartbeat[0]!.phaseObservations.find(
      ({ phase }) => phase === 'generation-gc',
    )!

    noHeartbeatGc.heartbeatSamples = 0
    expect(activityGroupsGateFailures(noHeartbeat, manifest)).toContain(
      'sqlite/generation-gc heartbeat was not sampled',
    )

    const noAppend = report()
    const noAppendGc = noAppend.heartbeat[0]!.phaseObservations.find(
      ({ phase }) => phase === 'generation-gc',
    )!

    noAppendGc.foregroundAppend = { count: 0, medianMs: 0, p95Ms: 0, maxMs: 0 }
    expect(activityGroupsGateFailures(noAppend, manifest)).toContain(
      'sqlite/generation-gc foreground append was not sampled',
    )
  })

  it('fails closed for a missing phase and invalid phase metrics', () => {
    const value = report()

    value.heartbeat[0]!.phaseObservations = value.heartbeat[0]!.phaseObservations.filter(
      ({ phase }) => phase !== 'restart',
    )
    value.heartbeat[1]!.phaseObservations[0]!.totalLatenessMs = Number.POSITIVE_INFINITY

    expect(activityGroupsGateFailures(value, manifest)).toEqual(
      expect.arrayContaining([
        'sqlite liveness phase must appear exactly once: restart',
        'sqlite expected 6 liveness phases, got 5',
        'postgres/paced-rebuild totalLatenessMs must be finite and nonnegative',
        'postgres/paced-rebuild heartbeat lateness exceeded its budget',
      ]),
    )
  })

  it('scales cumulative recovery debt without relaxing single-stall ceilings', () => {
    const value = report()
    const replacement = value.heartbeat[0]!.phaseObservations.find(
      ({ phase }) => phase === 'replacement-publication',
    )!

    replacement.durationMs = 1_000_000
    replacement.totalLatenessMs = 49_999
    expect(activityGroupsGateFailures(value, manifest)).toEqual([])

    replacement.totalLatenessMs = 50_000
    expect(activityGroupsGateFailures(value, manifest)).toContain(
      'sqlite/replacement-publication heartbeat lateness exceeded its budget',
    )
  })

  it('keeps CI as a thin adapter over the one repo-owned Make target', () => {
    const makefile = readFileSync('Makefile', 'utf8')
    const pipeline = readFileSync('.gitlab-ci.yml', 'utf8')
    const pipelineDocument = parse(pipeline) as Record<
      string,
      {
        extends?: string[]
        rules?: Array<{ when: string; allow_failure: boolean }>
        timeout?: string
      }
    >
    const job = pipelineDocument['extended:activity-groups']
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(makefile).toContain('activity-groups-gate: ##')
    expect(makefile).toContain('node scripts/activityGroupsGateDriver.mjs')
    expect(scripts.scripts['bench:activity-groups-gate']).toBe(
      'tsx scripts/activityGroupsProductionGate.ts',
    )
    expect(pipeline).toMatch(
      /extended:activity-groups:[\s\S]*make activity-groups-gate ACTIVITY_GROUPS_GATE_MODE=full/,
    )
    expect(pipeline).toMatch(
      /extended:activity-groups:[\s\S]*apk add --no-cache bash git make nodejs-current[\s\S]*make activity-groups-gate/,
    )
    expect(job).toMatchObject({
      extends: ['.dind', '.heavy'],
      rules: [{ when: 'manual', allow_failure: true }],
      timeout: '1h',
    })
  })

  it('recreates every cold latency cycle and inspects enforced container provenance', () => {
    const productionGate = readFileSync('scripts/activityGroupsProductionGate.ts', 'utf8')
    const productionMeasure = readFileSync('scripts/activityGroupsMeasure.ts', 'utf8')
    const driver = readFileSync('scripts/activityGroupsGateDriver.mjs', 'utf8')

    expect(driver).toContain('const dockerHostName = new URL(dockerHost).hostname')
    expect(driver).toContain("dockerHostName === 'docker'")
    expect(driver).toContain("['--add-host', 'docker:host-gateway']")
    expect(driver).toContain('type=bind,src=${dockerCertPath},dst=/certs/client,readonly')
    expect(productionGate).toContain('ACTIVITY_GROUPS_PRODUCER_PROFILE')
    expect(productionGate).toContain('ACTIVITY_GROUPS_LIVENESS_PROFILE')
    expect(productionGate).toContain('ACTIVITY_GROUPS_OFFLINE_REBUILD_BATCH_SIZE')
    expect(productionGate).toContain('timeout: options.timeoutMs ?? phaseTimeoutMs')
    expect(productionGate).toContain('deepCorpusBlobs: false')
    expect(productionGate).toContain('dialectsParallel: false')
    expect(productionGate).toContain('selectedMigrationCount = 7')
    expect(productionGate).toContain("mode === 'smoke' ? baseSample : undefined")
    expect(productionGate).toContain('copySqlite(target, cycleTarget)')
    expect(productionGate).toContain('restorePg(pgSnapshotLabel)')
    expect(productionGate).toContain("execFileSync('docker', ['inspect', name]")
    expect(productionGate).toContain('runner.HostConfig.NanoCpus')
    expect(productionGate).toContain('postgres.HostConfig.Memory')
    expect(productionGate).toContain('activityGroupsSmokeFailures(report)')
    expect(productionGate).toContain('activityGroupsSmokeWarnings(report)')
    expect(productionMeasure).toContain(
      'const productionHeartbeatMeasure = startProductionHeartbeat()',
    )
    expect(productionMeasure).toContain(
      'cells.push({ by, scope, cold, warm, locationChurn, productionHeartbeat })',
    )
    expect(productionMeasure).toContain(
      'const cold = await productionHeartbeatMeasure.measure(() => sample(by, scope))',
    )
    expect(productionMeasure).toContain(
      'productionHeartbeatMeasure.measure(() => sampleLocationChurn(by, scope))',
    )
    const timerStart = productionMeasure.indexOf(
      'let timer: ReturnType<typeof setInterval> | null = setInterval',
    )
    const activeTimerGuard = productionMeasure.indexOf(
      "throw new Error('production heartbeat timer is not active')",
    )

    expect(timerStart).toBeGreaterThan(-1)
    expect(activeTimerGuard).toBeGreaterThan(timerStart)
    expect(driver).toContain("['image', 'inspect', '--format', '{{.Id}}', image]")
    expect(driver).toContain('ACTIVITY_GROUPS_RUNNER_CONTAINER=')
  })
})
