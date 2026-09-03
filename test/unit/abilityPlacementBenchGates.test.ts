import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import {
  ABILITY_PLACEMENT_FROZEN_COMMIT,
  abilityPlacementBenchmarkGateFailures,
  type AbilityPlacementBenchmarkReport,
  abilityPlacementStats,
} from '../../scripts/abilityPlacementBenchGates'

const stats = (value: number) => abilityPlacementStats(Array.from({ length: 30 }, () => value))

const report = (phase: 'pre' | 'post'): AbilityPlacementBenchmarkReport => ({
  phase,
  provenance: {
    commit: phase === 'pre' ? ABILITY_PLACEMENT_FROZEN_COMMIT : 'a'.repeat(40),
    builtAt: phase === 'pre' ? '2026-09-01T00:00:00Z' : '2026-09-02T00:00:00Z',
    image: `sha256:${(phase === 'pre' ? 'b' : 'c').repeat(64)}`,
    imageRevision: phase === 'pre' ? ABILITY_PLACEMENT_FROZEN_COMMIT : 'a'.repeat(40),
    imageBuiltAt: phase === 'pre' ? '2026-09-01T00:00:00Z' : '2026-09-02T00:00:00Z',
    container: `notarium-404-${phase}`,
    baseUrl: `http://notarium-404-${phase}:3000`,
    harnessHash: 'd'.repeat(64),
    dataRootHash: 'e'.repeat(64),
    node: 'v24.8.0',
    npm: '11.19.0',
    caseName: 'agent-roles',
    caseSourceHash: 'f'.repeat(64),
    now: '2026-09-02T00:00:00.000Z',
    scale: '1',
    seed: 'ability-placement',
  },
  warmups: 5,
  measured: 30,
  idleHeartbeat: stats(2),
  roleFirstMove: stats(20),
  roleSetup: stats(15),
  roleReplay: stats(10),
  projectSetControl: stats(5),
  projectPinControl: stats(5),
  samples: Array.from({ length: 30 }, () => ({
    roleSetupMs: 15,
    firstMoveMs: 20,
    firstMoveStatus: 200,
    replayMs: 10,
    replayStatus: phase === 'pre' ? 404 : 200,
    enabledStayedFalse: true,
    contextCarried: true,
    firstMoveClientStartedAt: 1_000,
    firstMoveClientEndedAt: 1_020,
    firstMoveServerStartedAt: phase === 'pre' ? null : 1_001,
    firstMoveServerEndedAt: phase === 'pre' ? null : 1_019,
    heartbeats: [
      {
        status: 200,
        clientStartedAt: 1_001,
        clientEndedAt: 1_005,
        serverStartedAt: 1_002,
        serverEndedAt: 1_004,
      },
      {
        status: 200,
        clientStartedAt: 1_009,
        clientEndedAt: 1_013,
        serverStartedAt: 1_010,
        serverEndedAt: 1_012,
      },
    ],
  })),
  gate: { baseline: null, failures: [], passed: true },
})

describe('ability-placement benchmark gates', () => {
  it('accepts the frozen known-failure baseline and successful post replay', () => {
    expect(abilityPlacementBenchmarkGateFailures(report('pre'))).toEqual([])
    expect(abilityPlacementBenchmarkGateFailures(report('post'), report('pre'))).toEqual([])
  })

  it('binds the post report to the frozen harness and logical world', () => {
    const post = report('post')
    post.provenance.harnessHash = 'f'.repeat(64)
    post.provenance.dataRootHash = '1'.repeat(64)

    expect(abilityPlacementBenchmarkGateFailures(post, report('pre'))).toEqual(
      expect.arrayContaining([
        'post and baseline provenance.harnessHash must match',
        'post and baseline provenance.dataRootHash must match',
      ]),
    )
  })

  it('requires replay semantics and carried state in every sample', () => {
    const post = report('post')
    post.samples[1].replayStatus = 404
    post.samples[2].enabledStayedFalse = false
    post.samples[3].contextCarried = false

    expect(abilityPlacementBenchmarkGateFailures(post, report('pre'))).toEqual(
      expect.arrayContaining([
        'sample 1 replay returned 404, expected 200',
        'sample 2 did not carry its disabled/context state',
        'sample 3 did not carry its disabled/context state',
      ]),
    )
  })

  it('rejects control and move regressions using the fixed causal thresholds', () => {
    const post = report('post')
    post.projectSetControl = stats(20)
    post.roleFirstMove = stats(50)

    const failures = abilityPlacementBenchmarkGateFailures(post, report('pre'))

    expect(failures.some((failure) => failure.startsWith('projectSetControl.p95'))).toBe(true)
    expect(failures.some((failure) => failure.startsWith('roleFirstMove.p95'))).toBe(true)
  })

  it('requires a server-observed heartbeat inside every move interval', () => {
    const post = report('post')
    post.samples[0].heartbeats = post.samples[0].heartbeats.map((heartbeat) => ({
      ...heartbeat,
      clientStartedAt: 1_999,
      clientEndedAt: 2_003,
      serverStartedAt: 2_000,
      serverEndedAt: 2_002,
    }))

    expect(abilityPlacementBenchmarkGateFailures(post, report('pre'))).toContain(
      'sample 0 has no server-overlapping heartbeat',
    )
  })

  it('rejects reversed heartbeat intervals even when their endpoints overlap the move', () => {
    const post = report('post')
    post.samples[0].heartbeats = post.samples[0].heartbeats.map((heartbeat) => ({
      ...heartbeat,
      clientStartedAt: 900,
      clientEndedAt: 1_100,
      serverStartedAt: 1_010,
      serverEndedAt: 1_005,
    }))

    expect(abilityPlacementBenchmarkGateFailures(post, report('pre'))).toContain(
      'sample 0 heartbeat has an invalid client/server interval',
    )
  })

  it('rejects a role series whose second half drifts beyond its stationary bound', () => {
    const post = report('post')
    post.roleFirstMove = abilityPlacementStats([
      ...Array.from({ length: 15 }, () => 20),
      ...Array.from({ length: 15 }, () => 40),
    ])

    expect(
      abilityPlacementBenchmarkGateFailures(post, report('pre')).some((failure) =>
        failure.startsWith('roleFirstMove second-half median'),
      ),
    ).toBe(true)
  })

  it('makes the task-owned benchmark clean both image tags it creates', async () => {
    const makefile = await readFile('Makefile', 'utf8')
    const start = makefile.indexOf('\nability-placement-gate:')
    const target = makefile.slice(start, makefile.indexOf('\n# The pinned Playwright', start))

    expect(target).toContain(
      'docker image rm "$(ABILITY_PLACEMENT_RUNTIME_IMAGE)" "$(ABILITY_PLACEMENT_BUILDER_IMAGE)"',
    )
    expect(target.match(/CASE=agent-roles/g)).toHaveLength(2)
    expect(target).toContain('git archive "$(ABILITY_PLACEMENT_BASE_COMMIT)" test/cases')
    expect(target).toContain('src=$$fixture_dir/test,dst=/app/test,readonly')
  })
})
