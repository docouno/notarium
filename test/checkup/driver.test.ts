import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArguments, runCheckup } from '../../scripts/checkup/index.mjs'
import { PhaseOwnershipIncompleteError } from '../../scripts/checkup/process.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-driver-repo-'))
  const sessionRoot = await mkdtemp(join(tmpdir(), 'notarium-checkup-driver-session-'))
  roots.push(root, sessionRoot)
  await writeFile(join(root, 'source.txt'), 'source\n')
  const sourceRoot = join(sessionRoot, 'source')
  await mkdir(sourceRoot)
  await writeFile(join(sourceRoot, 'source.txt'), 'source\n')
  const sha256 = createHash('sha256').update('source\n').digest('hex')
  const mode = (await stat(join(sourceRoot, 'source.txt'))).mode & 0o777
  const manifestPath = join(sessionRoot, 'manifest.jsonl')
  await writeFile(
    manifestPath,
    `${JSON.stringify({ path: 'source.txt', kind: 'file', mode, size: 7, sha256 })}\n`,
  )

  return {
    root,
    snapshot: {
      sessionRoot,
      sourceRoot,
      manifestPath,
      sourceDigest: 'b'.repeat(64),
      rows: [{ path: 'source.txt', kind: 'file', mode, size: 7, sha256 }],
      denied: [],
      fileCount: 1,
      byteCount: 7,
      dirty: false,
    },
  }
}

const fakeLease = (overrides = {}) => ({
  container: 'fake-lease',
  waitMs: 0,
  recovered: null,
  owner: 'fixture',
  assertHealthy: async () => {},
  beginPhase: async () => {},
  registerPhasePid: async () => {},
  endPhase: async () => {},
  stopHeartbeat: async () => {},
  release: async () => {},
  ...overrides,
})

const ownedSnapshotFactory =
  (snapshot: Awaited<ReturnType<typeof fixture>>['snapshot']) =>
  async ({ sessionRoot }: { sessionRoot: string }) => {
    const sourceRoot = join(sessionRoot, 'source')
    const manifestPath = join(sessionRoot, 'manifest.jsonl')

    await cp(snapshot.sourceRoot, sourceRoot, { recursive: true, preserveTimestamps: true })
    await copyFile(snapshot.manifestPath, manifestPath)
    Object.assign(snapshot, { sessionRoot, sourceRoot, manifestPath })

    return snapshot
  }

describe('checkup session driver', () => {
  it('keeps a finished setup-failure report when snapshot creation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-setup-failure-'))
    const output = join(root, 'test-results/checkup')
    roots.push(root)
    const result = await runCheckup({
      command: 'run',
      subjectRoot: root,
      outputDir: output,
      snapshotFactory: async () => {
        throw new Error('snapshot exploded')
      },
    })
    const report = JSON.parse(await readFile(result.reportPath, 'utf8'))

    expect(result.exitCode).toBe(1)
    expect(result.reportPath).toContain('/setup-')
    expect(report).toMatchObject({
      state: 'finished',
      verdict: 'failed',
      subject: { sourceDigest: null },
      snapshot: { capability: 'unavailable', reason: 'setup-failed' },
      error: { stage: 'setup', message: 'snapshot exploded' },
    })
  })

  it('rejects an unowned snapshot root without deleting the foreign directory', async () => {
    const { root, snapshot } = await fixture()
    const sentinel = join(snapshot.sessionRoot, 'foreign-sentinel')

    await writeFile(sentinel, 'keep\n')
    const result = await runCheckup({
      command: 'snapshot',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: async () => snapshot,
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toMatchObject({
      error: {
        stage: 'setup',
        message: expect.stringContaining('unowned session root'),
      },
    })
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep\n')
  })

  it('materializes a versioned snapshot report without reading later live changes', async () => {
    const { root, snapshot } = await fixture()
    const output = join(root, 'test-results/checkup')
    await mkdir(output, { recursive: true })
    const result = await runCheckup({
      command: 'snapshot',
      subjectRoot: root,
      outputDir: output,
      snapshotFactory: ownedSnapshotFactory(snapshot),
    })
    const report = JSON.parse(await readFile(result.reportPath, 'utf8'))
    const manifest = await readFile(join(output, report.snapshot.manifest), 'utf8')

    expect(result.exitCode).toBe(0)
    expect(report).toMatchObject({
      schemaVersion: 1,
      state: 'finished',
      verdict: 'passed',
      subject: { dirty: false, mode: 'candidate' },
      snapshot: { fileCount: 1 },
      cleanup: { completed: true },
    })
    expect(report.driver.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(manifest).toContain('source.txt')
    expect(manifest).not.toContain('test-results')
  })

  it('rejects unknown modes before creating session output', () => {
    expect(() => parseArguments(['snapshot', '--mode', 'maybe'])).toThrow(
      'checkup mode must be candidate or legacy',
    )
  })

  it('keeps a red phase report and removes only its owned snapshot', async () => {
    const { root, snapshot } = await fixture()
    const output = join(root, 'test-results/checkup')
    const result = await runCheckup({
      command: 'run',
      subjectRoot: root,
      outputDir: output,
      snapshotFactory: ownedSnapshotFactory(snapshot),
      planFactory: () => ({
        static: [
          {
            name: 'red',
            command: process.execPath,
            args: ['-e', 'process.exit(7)'],
          },
        ],
        heavy: [],
      }),
    })
    const report = JSON.parse(await readFile(result.reportPath, 'utf8'))

    expect(result.exitCode).toBe(7)
    expect(report).toMatchObject({ verdict: 'failed', phases: [{ name: 'red', exitCode: 7 }] })
    await expect(readFile(snapshot.manifestPath, 'utf8')).rejects.toThrow(/ENOENT/u)
  })

  it('runs one declared heavy group concurrently but records deterministic phase order', async () => {
    const { root, snapshot } = await fixture()
    const output = join(root, 'test-results/checkup')
    const result = await runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: output,
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () => ({
        container: 'fake-lease',
        waitMs: 0,
        recovered: null,
        owner: 'fixture',
        assertHealthy: async () => {},
        release: async () => {},
      }),
      planFactory: () => ({
        static: [],
        heavy: [
          {
            name: 'left',
            command: process.execPath,
            args: ['-e', 'setTimeout(() => {}, 250)'],
            parallelGroup: 'pair',
          },
          {
            name: 'right',
            command: process.execPath,
            args: ['-e', 'setTimeout(() => {}, 250)'],
            parallelGroup: 'pair',
          },
        ],
      }),
    })
    const report = JSON.parse(await readFile(result.reportPath, 'utf8'))

    expect(result.exitCode).toBe(0)
    expect(report.phases.map((phase: { name: string }) => phase.name)).toEqual(['left', 'right'])
    expect(report.measurement.phaseWallMs - report.measurement.executionWallMs).toBeGreaterThan(150)
  })

  it('returns red when lease cleanup fails after otherwise green work', async () => {
    const { root, snapshot } = await fixture()
    const result = await runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () => ({
        container: 'fake-lease',
        waitMs: 0,
        recovered: null,
        owner: 'fixture',
        assertHealthy: async () => {},
        stopHeartbeat: async () => {},
        release: async () => {
          throw new Error('release failed')
        },
      }),
      planFactory: () => ({ static: [], heavy: [] }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toMatchObject({
      verdict: 'failed',
      cleanup: { completed: false, errors: ['lease: release failed'] },
    })
  })

  it('carries incomplete lease initialization cleanup into the report verdict', async () => {
    const { root, snapshot } = await fixture()
    const result = await runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () => {
        throw Object.assign(new Error('lease init failed'), {
          cleanupErrors: ['volume remains after create timeout'],
        })
      },
      planFactory: () => ({ static: [], heavy: [] }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toMatchObject({
      verdict: 'failed',
      error: { message: 'lease init failed' },
      cleanup: {
        completed: false,
        errors: ['lease initialization: volume remains after create timeout'],
      },
    })
  })

  it('retains the lease when candidate Docker cleanup is incomplete', async () => {
    const { root, snapshot } = await fixture()
    let releases = 0
    const result = await runCheckup({
      command: 'run',
      mode: 'candidate',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: ownedSnapshotFactory(snapshot),
      cleanupHeavyResources: () => {
        throw new Error('runner remains')
      },
      leaseFactory: async () => ({
        container: 'fake-lease',
        waitMs: 0,
        recovered: null,
        owner: 'fixture',
        assertHealthy: async () => {},
        stopHeartbeat: async () => {},
        release: async () => {
          releases += 1
        },
      }),
      planFactory: () => ({ static: [], heavy: [] }),
    })

    expect(result.exitCode).toBe(1)
    expect(releases).toBe(0)
    expect(result.report.cleanup.errors).toEqual([
      'heavy resources: runner remains',
      'lease retained because heavy resource cleanup was incomplete',
    ])
  })

  it('retains phase, heavy resources, lease, and snapshot after a proven survivor', async () => {
    const { root, snapshot } = await fixture()
    const interruption = new AbortController()
    let phaseEnds = 0
    let cleanupCalls = 0
    let releases = 0
    let heartbeatStops = 0
    const phaseResult = {
      name: 'surviving-heavy-phase',
      command: [process.execPath, '-e', 'process.exit(0)'],
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      wallMs: 25,
      exitCode: 0,
      signal: null,
      diagnostics: { capability: 'unavailable', reason: 'fault-injected-survivor' },
    }
    const result = await runCheckup({
      command: 'run',
      mode: 'candidate',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      abortSignal: interruption.signal,
      snapshotFactory: ownedSnapshotFactory(snapshot),
      cleanupHeavyResources: () => {
        cleanupCalls += 1
      },
      leaseFactory: async () =>
        fakeLease({
          endPhase: async () => {
            phaseEnds += 1
          },
          stopHeartbeat: async () => {
            heartbeatStops += 1
          },
          release: async () => {
            releases += 1
          },
        }),
      phaseRunner: async ({
        onSpawn,
      }: {
        onSpawn: (child: { pid: number }) => void | Promise<void>
      }) => {
        await onSpawn({ pid: 424_242 })
        interruption.abort('SIGTERM')
        const survivor = new PhaseOwnershipIncompleteError({
          phase: 'surviving-heavy-phase',
          rootPid: 424_242,
          leaderFinished: true,
          groupAlive: true,
          phaseResult,
        })

        throw new AggregateError([new Error('primary termination diagnostic'), survivor])
      },
      planFactory: () => ({
        static: [],
        heavy: [
          {
            name: 'surviving-heavy-phase',
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            daemonWork: true,
          },
        ],
      }),
    })

    roots.push(snapshot.sessionRoot)
    expect(result.exitCode).toBe(143)
    expect(phaseEnds).toBe(0)
    expect(cleanupCalls).toBe(0)
    expect(releases).toBe(0)
    expect(heartbeatStops).toBe(1)
    expect(result.report).toMatchObject({
      verdict: 'failed',
      phases: [phaseResult],
      error: {
        name: 'CheckupInterruptionError',
        signal: 'SIGTERM',
        cause: {
          name: 'PhaseOwnershipIncompleteError',
          code: 'CHECKUP_PHASE_OWNERSHIP_INCOMPLETE',
          phase: 'surviving-heavy-phase',
          rootPid: 424_242,
          leaderFinished: true,
          groupAlive: true,
          phaseResult,
        },
      },
      lease: { retained: true, retainedReason: 'phase-ownership-incomplete' },
      snapshot: {
        retained: true,
        retainedReason: 'phase-ownership-incomplete',
        retainedPath: snapshot.sessionRoot,
        verifiedAfterRun: true,
      },
      cleanup: { completed: false },
    })
    expect(result.report.cleanup.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'PhaseOwnershipIncompleteError[CHECKUP_PHASE_OWNERSHIP_INCOMPLETE]',
        ),
        'heavy resources retained because phase ownership is incomplete',
        'lease retained because phase ownership is incomplete',
        expect.stringContaining('snapshot retained at'),
      ]),
    )
    await expect(stat(snapshot.sessionRoot)).resolves.toBeDefined()
  })

  it('retains a candidate snapshot without acquiring a lease after a static survivor', async () => {
    const { root, snapshot } = await fixture()
    let leaseCalls = 0
    let cleanupCalls = 0
    const result = await runCheckup({
      command: 'run',
      mode: 'candidate',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: ownedSnapshotFactory(snapshot),
      cleanupHeavyResources: () => {
        cleanupCalls += 1
      },
      leaseFactory: async () => {
        leaseCalls += 1
        return fakeLease()
      },
      phaseRunner: async ({
        onSpawn,
      }: {
        onSpawn: (child: { pid: number }) => void | Promise<void>
      }) => {
        await onSpawn({ pid: 515_151 })
        throw new PhaseOwnershipIncompleteError({
          phase: 'static-survivor',
          rootPid: 515_151,
          leaderFinished: false,
          groupAlive: true,
        })
      },
      planFactory: () => ({
        static: [{ name: 'static-survivor', command: process.execPath }],
        heavy: [],
      }),
    })

    roots.push(snapshot.sessionRoot)
    expect(leaseCalls).toBe(0)
    expect(cleanupCalls).toBe(0)
    expect(result.report).toMatchObject({
      verdict: 'failed',
      lease: null,
      error: {
        name: 'PhaseOwnershipIncompleteError',
        cause: {
          code: 'CHECKUP_PHASE_OWNERSHIP_INCOMPLETE',
          phase: 'static-survivor',
        },
      },
      snapshot: { retained: true, retainedReason: 'phase-ownership-incomplete' },
      cleanup: { completed: false },
    })
    await expect(stat(snapshot.sessionRoot)).resolves.toBeDefined()
  })

  it('ends a green parallel sibling but retains ownership for the surviving sibling', async () => {
    const { root, snapshot } = await fixture()
    const endedPhases: string[] = []
    let cleanupCalls = 0
    let releases = 0
    const result = await runCheckup({
      command: 'run',
      mode: 'candidate',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: ownedSnapshotFactory(snapshot),
      cleanupHeavyResources: () => {
        cleanupCalls += 1
      },
      leaseFactory: async () =>
        fakeLease({
          endPhase: async (name: string) => {
            endedPhases.push(name)
          },
          release: async () => {
            releases += 1
          },
        }),
      phaseRunner: async ({
        name,
        onSpawn,
      }: {
        name: string
        onSpawn: (child: { pid: number }) => void | Promise<void>
      }) => {
        const pid = name === 'parallel-green' ? 616_161 : 717_171
        const phaseResult = {
          name,
          command: [process.execPath],
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          wallMs: 10,
          exitCode: 0,
          signal: null,
          diagnostics: { capability: 'unavailable', reason: 'fault-injected' },
        }

        await onSpawn({ pid })
        if (name === 'parallel-survivor') {
          throw new PhaseOwnershipIncompleteError({
            phase: name,
            rootPid: pid,
            leaderFinished: true,
            groupAlive: true,
            phaseResult,
          })
        }

        return phaseResult
      },
      planFactory: () => ({
        static: [],
        heavy: [
          {
            name: 'parallel-green',
            command: process.execPath,
            daemonWork: true,
            parallelGroup: 'pair',
          },
          {
            name: 'parallel-survivor',
            command: process.execPath,
            daemonWork: true,
            parallelGroup: 'pair',
          },
        ],
      }),
    })

    roots.push(snapshot.sessionRoot)
    expect(endedPhases).toEqual(['parallel-green'])
    expect(cleanupCalls).toBe(0)
    expect(releases).toBe(0)
    expect(result.report.phases.map((phase: { name: string }) => phase.name)).toEqual([
      'parallel-green',
      'parallel-survivor',
    ])
    expect(result.report).toMatchObject({
      error: { cause: { phase: 'parallel-survivor', groupAlive: true } },
      lease: { retained: true },
      snapshot: { retained: true },
      cleanup: { completed: false },
    })
  })

  it('returns red when post-run snapshot verification detects drift', async () => {
    const { root, snapshot } = await fixture()
    const result = await runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () => ({
        container: 'fake-lease',
        waitMs: 0,
        recovered: null,
        owner: 'fixture',
        assertHealthy: async () => {},
        stopHeartbeat: async () => {},
        release: async () => {},
      }),
      planFactory: () => ({
        static: [
          {
            name: 'mutate-source',
            command: process.execPath,
            args: [
              '-e',
              "require('node:fs').writeFileSync(process.env.CHECKUP_SOURCE_ROOT + '/source.txt', 'changed\\n')",
            ],
          },
        ],
        heavy: [],
      }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toMatchObject({
      verdict: 'failed',
      snapshot: { verifiedAfterRun: false },
      cleanup: { completed: false },
    })
  })

  it('rejects snapshot additions before any heavy consumer or lease starts', async () => {
    const { root, snapshot } = await fixture()
    let leaseCalls = 0
    const result = await runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () => {
        leaseCalls += 1
        return fakeLease()
      },
      planFactory: () => ({
        static: [
          {
            name: 'inject-extra',
            command: process.execPath,
            args: [
              '-e',
              "require('node:fs').writeFileSync(process.env.CHECKUP_SOURCE_ROOT + '/late.ts', 'late\\n')",
            ],
          },
        ],
        heavy: [
          { name: 'must-not-run', command: process.execPath, args: ['-e', 'process.exit(99)'] },
        ],
      }),
    })

    expect(leaseCalls).toBe(0)
    expect(result.exitCode).toBe(1)
    expect(result.report).toMatchObject({
      phases: [{ name: 'inject-extra', exitCode: 0 }],
      snapshot: { verifiedBeforeHeavy: false, verifiedAfterRun: false },
      error: { stage: 'execution', message: expect.stringContaining('outside manifest') },
    })
  })

  it('revalidates the snapshot after lease wait immediately before first heavy use', async () => {
    const { root, snapshot } = await fixture()
    const marker = join(root, 'heavy-ran')
    const result = await runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () => {
        await writeFile(join(snapshot.sourceRoot, 'during-lease.ts'), 'late\n')
        return fakeLease()
      },
      planFactory: () => ({
        static: [],
        heavy: [
          {
            name: 'must-not-consume',
            command: process.execPath,
            args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
          },
        ],
      }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toMatchObject({
      phases: [],
      snapshot: { verifiedBeforeHeavy: false, verifiedAfterRun: false },
      error: { message: expect.stringContaining('outside manifest') },
    })
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a red phase before separately reporting lease bookkeeping failure', async () => {
    const { root, snapshot } = await fixture()
    const result = await runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () =>
        fakeLease({
          endPhase: async () => {
            throw new Error('end bookkeeping failed')
          },
        }),
      planFactory: () => ({
        static: [],
        heavy: [
          {
            name: 'primary-red',
            command: process.execPath,
            args: ['-e', 'process.exit(7)'],
            daemonWork: true,
          },
        ],
      }),
    })

    expect(result.exitCode).toBe(7)
    expect(result.report).toMatchObject({
      phases: [{ name: 'primary-red', exitCode: 7 }],
      error: { name: 'LeasePhaseBookkeepingError' },
      lease: {
        bookkeepingErrors: [
          { phase: 'primary-red', operation: 'end', name: 'LeasePhaseBookkeepingError' },
        ],
      },
      cleanup: {
        completed: false,
        errors: ['lease phase primary-red end: end bookkeeping failed'],
      },
    })
  })

  it('terminates an unregistered daemon phase after synchronous PID bookkeeping failure', async () => {
    const { root, snapshot } = await fixture()
    let childPid = 0
    const result = await runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () =>
        fakeLease({
          registerPhasePid: (_name: string, pid: number) => {
            childPid = pid
            throw new Error('synchronous registration failure')
          },
        }),
      planFactory: () => ({
        static: [],
        heavy: [
          {
            name: 'unregistered',
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            daemonWork: true,
          },
        ],
      }),
    })

    expect(result.exitCode).toBe(1)
    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/u)
    expect(result.report).toMatchObject({
      phases: [],
      error: { name: 'LeasePhaseBookkeepingError' },
      lease: {
        bookkeepingErrors: [{ phase: 'unregistered', operation: 'register-pid' }],
      },
      cleanup: {
        completed: false,
        errors: ['lease phase unregistered register-pid: synchronous registration failure'],
      },
    })
  })

  it('escalates an asynchronous PID registration failure without waiting forever', async () => {
    const { root, snapshot } = await fixture()
    const marker = join(root, 'async-registration-ready')
    let childPid = 0
    const started = Date.now()
    const result = await runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      phaseTerminationGraceMs: 50,
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () =>
        fakeLease({
          registerPhasePid: async (_name: string, pid: number) => {
            childPid = pid
            for (let attempt = 0; attempt < 100; attempt += 1) {
              try {
                await stat(marker)
                throw new Error('asynchronous registration failure')
              } catch (error) {
                if (
                  error instanceof Error &&
                  error.message === 'asynchronous registration failure'
                ) {
                  throw error
                }
                await new Promise((resolveWait) => setTimeout(resolveWait, 10))
              }
            }
            throw new Error('phase never became ready')
          },
        }),
      planFactory: () => ({
        static: [],
        heavy: [
          {
            name: 'async-unregistered',
            command: process.execPath,
            args: [
              '-e',
              `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000)`,
            ],
            daemonWork: true,
          },
        ],
      }),
    })

    expect(Date.now() - started).toBeLessThan(1_500)
    expect(result.exitCode).toBe(1)
    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/u)
    expect(result.report).toMatchObject({
      phases: [],
      error: { name: 'LeasePhaseBookkeepingError' },
      lease: {
        bookkeepingErrors: [{ phase: 'async-unregistered', operation: 'register-pid' }],
      },
      cleanup: {
        completed: false,
        errors: ['lease phase async-unregistered register-pid: asynchronous registration failure'],
      },
    })
  })

  it('records completed parallel siblings when another phase cannot start', async () => {
    const { root, snapshot } = await fixture()
    const result = await runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () => fakeLease(),
      planFactory: () => ({
        static: [],
        heavy: [
          {
            name: 'recorded-sibling',
            command: process.execPath,
            args: ['-e', 'setTimeout(() => {}, 40)'],
            parallelGroup: 'pair',
          },
          {
            name: 'spawn-failure',
            command: '/definitely/missing/checkup-command',
            parallelGroup: 'pair',
          },
        ],
      }),
    })
    const saved = JSON.parse(await readFile(result.reportPath, 'utf8'))

    expect(result.exitCode).toBe(1)
    expect(saved.phases).toMatchObject([{ name: 'recorded-sibling', exitCode: 0 }])
    expect(saved.error).toMatchObject({ stage: 'execution', name: 'Error' })
  })

  it('propagates one resolved profile and reports the validated sampler interval', async () => {
    const { root, snapshot } = await fixture()
    const env = {
      ...process.env,
      CHECKUP_CPU_CEILING: '1',
      CHECKUP_VITEST_WORKERS: '1',
      CHECKUP_COVERAGE_CONCURRENCY: '1',
      CHECKUP_SAMPLE_INTERVAL_MS: '17',
    }
    const result = await runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      env,
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () => fakeLease(),
      planFactory: () => ({
        static: [
          {
            name: 'profile-env',
            command: process.execPath,
            args: [
              '-e',
              "const e=process.env; if ([e.CHECKUP_CPU_CEILING,e.CHECKUP_VITEST_WORKERS,e.CHECKUP_COVERAGE_CONCURRENCY,e.CHECKUP_SAMPLE_INTERVAL_MS].join(',') !== '1,1,1,17') process.exit(9)",
            ],
          },
        ],
        heavy: [],
      }),
    })
    const saved = JSON.parse(await readFile(result.reportPath, 'utf8'))

    expect(result.exitCode).toBe(0)
    expect(saved.profile).toMatchObject({
      requested: { samplerIntervalMs: 17 },
      effective: {
        cpu: 1,
        vitestWorkers: 1,
        coverageProcessingConcurrency: 1,
        samplerIntervalMs: 17,
      },
    })
    expect(saved.phases[0].diagnostics.intervalMs).toBe(17)
  })

  it('fails setup instead of running with an invalid sampler interval', async () => {
    const { root, snapshot } = await fixture()
    const result = await runCheckup({
      command: 'snapshot',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      env: { ...process.env, CHECKUP_SAMPLE_INTERVAL_MS: '0' },
      snapshotFactory: ownedSnapshotFactory(snapshot),
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toMatchObject({
      verdict: 'failed',
      error: {
        stage: 'setup',
        name: 'TypeError',
        message: expect.stringContaining('positive integer'),
      },
    })
    expect(result.report.profile).toBe(null)
  })

  it('rejects a sampler interval that would overflow the Node timer range', async () => {
    const { root, snapshot } = await fixture()
    const result = await runCheckup({
      command: 'snapshot',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      env: { ...process.env, CHECKUP_SAMPLE_INTERVAL_MS: '999999999999999999999' },
      snapshotFactory: ownedSnapshotFactory(snapshot),
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toMatchObject({
      verdict: 'failed',
      error: {
        stage: 'setup',
        name: 'RangeError',
        message: expect.stringContaining('safe integer no greater than 60000'),
      },
    })
  })

  it('rejects an unsafe direct-session termination timer', async () => {
    const { root, snapshot } = await fixture()
    const result = await runCheckup({
      command: 'snapshot',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      env: {
        ...process.env,
        CHECKUP_PHASE_TERMINATION_GRACE_MS: '999999999999999999999',
      },
      snapshotFactory: ownedSnapshotFactory(snapshot),
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toMatchObject({
      verdict: 'failed',
      error: {
        stage: 'setup',
        name: 'RangeError',
        message: expect.stringContaining('safe integer no greater than 60000'),
      },
    })
  })

  it('writes a signal-typed setup report when interrupted inside snapshot creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-snapshot-signal-'))
    roots.push(root)
    const interruption = new AbortController()
    let ownedSnapshotRoot = ''
    let enteredSnapshot: () => void
    const snapshotEntered = new Promise<void>((resolveEntered) => {
      enteredSnapshot = resolveEntered
    })
    const running = runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      abortSignal: interruption.signal,
      snapshotAbortGraceMs: 20,
      snapshotFactory: async ({ sessionRoot }: { sessionRoot: string }) => {
        ownedSnapshotRoot = sessionRoot
        enteredSnapshot()
        return new Promise(() => {})
      },
    })

    await snapshotEntered
    interruption.abort('SIGTERM')
    const result = await running
    const report = JSON.parse(await readFile(result.reportPath, 'utf8'))

    expect(result.exitCode).toBe(143)
    expect(report).toMatchObject({
      state: 'finished',
      verdict: 'failed',
      snapshot: { capability: 'unavailable', reason: 'setup-interrupted' },
      error: { name: 'CheckupInterruptionError', signal: 'SIGTERM' },
      cleanup: {
        completed: false,
        errors: [expect.stringContaining('ownership remains indeterminate')],
      },
    })
    await expect(stat(ownedSnapshotRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('forwards an owned signal to an active phase and still cleans the snapshot', async () => {
    const { root, snapshot } = await fixture()
    const marker = join(root, 'phase-started')
    const interruption = new AbortController()
    const running = runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      abortSignal: interruption.signal,
      snapshotFactory: ownedSnapshotFactory(snapshot),
      planFactory: () => ({
        static: [
          {
            name: 'interrupted-phase',
            command: process.execPath,
            args: [
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000)`,
            ],
          },
        ],
        heavy: [],
      }),
    })

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await stat(marker)
        break
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
    }
    await expect(stat(marker)).resolves.toBeDefined()
    interruption.abort('SIGTERM')
    const result = await running

    expect(result.exitCode).toBe(143)
    expect(result.report).toMatchObject({
      verdict: 'failed',
      phases: [{ name: 'interrupted-phase', exitCode: 143, signal: null }],
      snapshot: { verifiedAfterRun: true },
      cleanup: { completed: true },
    })
    await expect(stat(snapshot.sessionRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not await pending phase registration after interruption has bounded the child', async () => {
    const { root, snapshot } = await fixture()
    const marker = join(root, 'pending-registration-phase-started')
    const interruption = new AbortController()
    let phaseEnds = 0
    let releases = 0
    const started = Date.now()
    const running = runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      abortSignal: interruption.signal,
      phaseTerminationGraceMs: 50,
      snapshotFactory: ownedSnapshotFactory(snapshot),
      leaseFactory: async () =>
        fakeLease({
          registerPhasePid: () => new Promise<void>(() => {}),
          endPhase: async () => {
            phaseEnds += 1
          },
          release: async () => {
            releases += 1
          },
        }),
      planFactory: () => ({
        static: [],
        heavy: [
          {
            name: 'pending-registration',
            command: process.execPath,
            args: [
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000)`,
            ],
            daemonWork: true,
          },
        ],
      }),
    })

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await stat(marker)
        break
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
    }
    await expect(stat(marker)).resolves.toBeDefined()
    interruption.abort('SIGTERM')
    const result = await running

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result.exitCode).toBe(143)
    expect(phaseEnds).toBe(1)
    expect(releases).toBe(1)
    expect(result.report).toMatchObject({
      error: { name: 'CheckupInterruptionError', signal: 'SIGTERM' },
      cleanup: { completed: true },
    })
    await expect(stat(snapshot.sessionRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('escalates direct SIGTERM to SIGKILL and preserves interruption evidence', async () => {
    const { root, snapshot } = await fixture()
    const marker = join(root, 'ignoring-phase-started')
    const interruption = new AbortController()
    const started = Date.now()
    const running = runCheckup({
      command: 'run',
      mode: 'legacy',
      subjectRoot: root,
      outputDir: join(root, 'test-results/checkup'),
      abortSignal: interruption.signal,
      phaseTerminationGraceMs: 50,
      snapshotFactory: ownedSnapshotFactory(snapshot),
      planFactory: () => ({
        static: [
          {
            name: 'ignores-sigterm',
            command: process.execPath,
            args: [
              '-e',
              `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`,
            ],
          },
        ],
        heavy: [],
      }),
    })

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await stat(marker)
        break
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
    }
    await expect(stat(marker)).resolves.toBeDefined()
    interruption.abort('SIGTERM')
    const result = await running

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result.exitCode).toBe(143)
    expect(result.report).toMatchObject({
      verdict: 'failed',
      phases: [{ name: 'ignores-sigterm', exitCode: null, signal: 'SIGKILL' }],
      error: { name: 'CheckupInterruptionError', signal: 'SIGTERM' },
      snapshot: { verifiedAfterRun: true },
      cleanup: { completed: true },
    })
    await expect(stat(snapshot.sessionRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
