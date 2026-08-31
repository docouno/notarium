import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isLiveLinuxProcessState,
  PhaseOwnershipIncompleteError,
  phaseOwnershipIncompleteErrors,
  processGroupIsAlive,
  processGroupIsAliveFromProbes,
  processIdentity,
  processIdIsAlive,
  runPhase,
  signalProcessIdentities,
} from '../../scripts/checkup/process.mjs'
import {
  assertPassedCheckupReport,
  finishCheckupReport,
  newCheckupReport,
  writeCheckupReport,
} from '../../scripts/checkup/report.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('checkup phase and report evidence', () => {
  it('keeps uninterruptible Linux processes live while excluding zombies', () => {
    expect(isLiveLinuxProcessState('R')).toBe(true)
    expect(isLiveLinuxProcessState('S')).toBe(true)
    expect(isLiveLinuxProcessState('D')).toBe(true)
    expect(isLiveLinuxProcessState('Z')).toBe(false)
    expect(isLiveLinuxProcessState('X')).toBe(false)
    expect(isLiveLinuxProcessState('x')).toBe(false)
  })

  it('does not accept an empty process-group scan before a later live scan', async () => {
    const scans = [
      { status: 'available', live: false },
      { status: 'available', live: true },
    ]
    const waits: number[] = []
    let existenceProbes = 0
    let scanIndex = 0

    const alive = await processGroupIsAliveFromProbes({
      groupExists: () => {
        existenceProbes += 1
        return true
      },
      scanGroup: async () => scans[scanIndex++]!,
      waitForRescan: (milliseconds) => {
        waits.push(milliseconds)
      },
    })

    expect(alive).toBe(true)
    expect(existenceProbes).toBe(2)
    expect(scanIndex).toBe(2)
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(0)
    expect(waits[0]).toBeLessThanOrEqual(20)
  })

  it.skipIf(process.platform !== 'linux')(
    'treats a zombie-only process group as quiescent even while kill zero sees it',
    async () => {
      const holderScript = [
        "const { spawn } = require('node:child_process')",
        "const { writeSync } = require('node:fs')",
        "const zombie = spawn(process.execPath, ['-e', 'process.exit(0)'], { detached: true, stdio: 'ignore' })",
        'writeSync(1, `${zombie.pid}\\n`)',
        'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)',
        "zombie.once('exit', () => process.exit(0))",
      ].join(';')
      const holder = spawn(process.execPath, ['-e', holderScript], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const holderExit = once(holder, 'exit')

      try {
        if (!holder.stdout) {
          throw new Error('zombie holder stdout unavailable')
        }
        const [chunk] = await once(holder.stdout, 'data')
        const zombiePid = Number(chunk)
        let state = ''

        for (let attempt = 0; attempt < 40 && state !== 'Z'; attempt += 1) {
          try {
            const stat = await readFile(`/proc/${zombiePid}/stat`, 'utf8')

            state =
              stat
                .slice(stat.lastIndexOf(')') + 2)
                .trim()
                .split(/\s+/u)[0] ?? ''
          } catch {
            state = ''
          }
          if (state !== 'Z') {
            await new Promise((resolveWait) => setTimeout(resolveWait, 10))
          }
        }

        expect(state).toBe('Z')
        expect(() => process.kill(zombiePid, 0)).not.toThrow()
        expect(() => process.kill(-zombiePid, 0)).not.toThrow()
        await expect(processIdentity(zombiePid)).resolves.toBe(null)
        await expect(processIdIsAlive(zombiePid)).resolves.toBe(false)
        await expect(processGroupIsAlive(zombiePid)).resolves.toBe(false)
      } finally {
        await holderExit
      }
    },
  )

  it('keeps exact wall/exit facts separate from sampled lower-bound diagnostics', async () => {
    const phase = await runPhase({
      name: 'probe',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(7), 80)'] as string[],
      samplerIntervalMs: 5,
      stdio: 'ignore',
    })

    expect(phase.exitCode).toBe(7)
    expect(phase.wallMs).toBeGreaterThan(50)
    expect(phase.diagnostics).toMatchObject({
      capability: 'sampled',
      semantics: 'sampled-lower-bound',
      intervalMs: 5,
    })
    expect(phase.diagnostics.samplesTaken).toBeGreaterThan(0)
    expect(phase.diagnostics.observedPidCount).toBeGreaterThan(0)
  })

  it('terminates and awaits a spawned child when synchronous ownership setup fails', async () => {
    let childPid = 0

    await expect(
      runPhase({
        name: 'ownership-failure',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        samplerIntervalMs: 5,
        stdio: 'ignore',
        onSpawn: (child) => {
          childPid = child.pid ?? 0
          throw new Error('synchronous ownership failure')
        },
      }),
    ).rejects.toThrow('synchronous ownership failure')
    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/u)
  })

  it('escalates an asynchronous ownership failure when the child ignores SIGTERM', async () => {
    let childPid = 0
    const started = Date.now()

    await expect(
      runPhase({
        name: 'async-ownership-failure',
        command: process.execPath,
        args: [
          '-e',
          "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
        ],
        samplerIntervalMs: 5,
        stdio: ['ignore', 'pipe', 'ignore'],
        onSpawnFailureKillGraceMs: 50,
        onSpawn: (child) => {
          const stdout = child.stdout

          if (!child.pid || !stdout) {
            throw new Error('spawned child has no PID/stdout')
          }
          childPid = child.pid
          return new Promise((_, rejectOwnership) => {
            stdout.once('data', () => rejectOwnership(new Error('asynchronous ownership failure')))
          })
        },
      }),
    ).rejects.toThrow('asynchronous ownership failure')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/u)
  })

  it('waits for asynchronous ownership setup before accepting a fast child exit', async () => {
    const started = Date.now()

    await expect(
      runPhase({
        name: 'delayed-ownership-failure',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        samplerIntervalMs: 5,
        stdio: 'ignore',
        onSpawn: () =>
          new Promise((_, rejectOwnership) => {
            setTimeout(() => rejectOwnership(new Error('delayed ownership failure')), 80)
          }),
      }),
    ).rejects.toThrow('delayed ownership failure')
    expect(Date.now() - started).toBeGreaterThanOrEqual(60)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('does not mistake a post-spawn child error for process exit', async () => {
    let childPid = 0
    const started = Date.now()

    await expect(
      runPhase({
        name: 'post-spawn-error',
        command: process.execPath,
        args: [
          '-e',
          "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
        ],
        samplerIntervalMs: 5,
        stdio: ['ignore', 'pipe', 'ignore'],
        terminationKillGraceMs: 50,
        onSpawn: (child) => {
          if (!child.pid || !child.stdout) {
            throw new Error('spawned child has no PID/stdout')
          }
          childPid = child.pid
          child.stdout.once('data', () => child.emit('error', new Error('post-spawn failure')))
        },
      }),
    ).rejects.toThrow('post-spawn failure')
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/u)
  })

  it.skipIf(process.platform === 'win32')(
    'catches an abort from a later exit listener and waits for the complete process group',
    async () => {
      const interruption = new AbortController()
      const descendantScript =
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"
      const leaderScript = [
        "const { spawn } = require('node:child_process')",
        `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
        "descendant.stdout.once('data', () => { process.stdout.write(`${descendant.pid}\\n`); setImmediate(() => process.exit(0)) })",
        'setInterval(() => {}, 1000)',
      ].join(';')
      let leaderPid = 0
      let resolveDescendantReady: (pid: number) => void
      const descendantReady = new Promise<number>((resolveReady) => {
        resolveDescendantReady = resolveReady
      })
      const running = runPhase({
        name: 'leader-exits-before-descendant',
        command: process.execPath,
        args: ['-e', leaderScript],
        samplerIntervalMs: 5,
        stdio: ['ignore', 'pipe', 'ignore'],
        terminationSignal: interruption.signal,
        terminationKillGraceMs: 50,
        onSpawn: (child) => {
          if (!child.pid || !child.stdout) {
            throw new Error('spawned child has no PID/stdout')
          }
          leaderPid = child.pid
          child.stdout.once('data', (chunk) => resolveDescendantReady(Number(chunk)))
          child.once('exit', () => interruption.abort('SIGTERM'))
        },
      })

      try {
        const descendantPid = await descendantReady
        const leaderExitAt = Date.now()

        expect(descendantPid).toBeGreaterThan(0)
        await expect(running).resolves.toMatchObject({ exitCode: 0, signal: null })
        expect(interruption.signal.aborted).toBe(true)
        expect(Date.now() - leaderExitAt).toBeGreaterThanOrEqual(40)
        await expect(processGroupIsAlive(leaderPid)).resolves.toBe(false)
        await expect(processIdIsAlive(descendantPid)).resolves.toBe(false)
      } finally {
        try {
          process.kill(-leaderPid, 'SIGKILL')
        } catch {
          // The expected path already reaped the complete process group.
        }
      }
    },
  )

  it('rejects boundedly when a killed phase never reports its exit event', async () => {
    const interruption = new AbortController()
    let childPid = 0
    const started = Date.now()
    const running = runPhase({
      name: 'missing-exit-event',
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      samplerIntervalMs: 5,
      stdio: 'ignore',
      terminationSignal: interruption.signal,
      terminationKillGraceMs: 20,
      onSpawn: (child) => {
        childPid = child.pid ?? 0
        child.removeAllListeners('exit')
        interruption.abort('SIGTERM')
      },
    })

    const failure = await running.catch((error) => error)

    expect(failure).toBeInstanceOf(PhaseOwnershipIncompleteError)
    expect(failure).toMatchObject({
      name: 'PhaseOwnershipIncompleteError',
      phase: 'missing-exit-event',
      rootPid: childPid,
      leaderFinished: false,
      groupAlive: false,
      ownershipIncomplete: true,
      phaseResult: null,
    })
    expect(failure.message).toMatch(/leader .* did not report exit after SIGKILL/u)
    expect(
      phaseOwnershipIncompleteErrors(new AggregateError([new Error('primary'), failure])),
    ).toEqual([failure])
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/u)
  })

  it('rejects unsafe phase termination timers before spawning', async () => {
    await expect(
      runPhase({
        name: 'invalid-timer',
        command: process.execPath,
        terminationKillGraceMs: 0,
      }),
    ).rejects.toThrow(/terminationKillGraceMs must be a safe integer between 1 and 60000/u)
  })

  it('never signals a reused PID whose process start identity changed', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit))

    try {
      if (!child.pid) {
        throw new Error('child process PID unavailable')
      }
      const pid = child.pid
      const identity = await processIdentity(pid)

      expect(identity).not.toBe(null)
      if (!identity) {
        throw new Error('child process identity unavailable')
      }
      await expect(
        signalProcessIdentities(
          [{ ...identity, startTime: `${identity.startTime}-reused` }],
          'SIGKILL',
        ),
      ).resolves.toEqual([])
      expect(() => process.kill(pid, 0)).not.toThrow()

      await signalProcessIdentities([identity], 'SIGKILL')
      await exited
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
  })

  it('writes an atomic versioned report and preserves the first red verdict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-report-'))
    roots.push(root)
    const path = join(root, 'nested/report.json')
    const report = newCheckupReport({
      sessionId: 'session',
      driverDigest: 'a'.repeat(64),
      subject: { sourceDigest: 'b'.repeat(64) },
      snapshot: { fileCount: 10, byteCount: 20 },
    })

    const phases = report.phases as Array<{ name: string; exitCode: number }>

    phases.push({ name: 'red', exitCode: 7 })
    finishCheckupReport(report, { exitCode: 7 })
    await writeCheckupReport(path, report)
    const saved = JSON.parse(await readFile(path, 'utf8'))

    expect(saved).toMatchObject({
      schemaVersion: 1,
      state: 'finished',
      verdict: 'failed',
      cleanup: { completed: true, errors: [] },
    })
    expect(saved.phases).toEqual([{ name: 'red', exitCode: 7 }])
  })

  it('rejects reports whose schema, verdict, mode, or cleanup cannot prove a green run', () => {
    const report = {
      schemaVersion: 1,
      driver: { version: 1, digest: 'a'.repeat(64) },
      state: 'finished',
      verdict: 'passed',
      subject: {
        mode: 'candidate',
        gitHead: 'commit',
        dirty: false,
        sourceDigest: 'b'.repeat(64),
      },
      snapshot: {
        verifiedBeforeHeavy: true,
        verifiedAfterRun: true,
        verificationsBeforeHeavy: 4,
      },
      lease: { bookkeepingErrors: [] },
      cleanup: { completed: true, errors: [] },
      phases: [{ name: 'green', exitCode: 0, signal: null }],
      measurement: { executionWallMs: 100, phaseWallMs: 90, leaseWaitMs: 0 },
    }

    expect(
      assertPassedCheckupReport(report, {
        mode: 'candidate',
        gitHead: 'commit',
        expectedPhases: ['green'],
        expectedSnapshotVerificationCount: 4,
      }),
    ).toBe(report)
    expect(() =>
      assertPassedCheckupReport({ ...report, schemaVersion: 2 }, { mode: 'candidate' }),
    ).toThrow(/schemaVersion/u)
    expect(() =>
      assertPassedCheckupReport({ ...report, verdict: 'failed' }, { mode: 'candidate' }),
    ).toThrow(/finished and passed/u)
    expect(() => assertPassedCheckupReport(report, { mode: 'legacy' })).toThrow(/subject.mode/u)
    expect(() =>
      assertPassedCheckupReport(
        { ...report, snapshot: { ...report.snapshot, verifiedBeforeHeavy: false } },
        { mode: 'candidate' },
      ),
    ).toThrow(/before heavy consumption/u)
    expect(() =>
      assertPassedCheckupReport(report, {
        mode: 'candidate',
        expectedSnapshotVerificationCount: 1,
      }),
    ).toThrow(/verification count/u)
    expect(() =>
      assertPassedCheckupReport(report, { mode: 'candidate', expectedPhases: ['other'] }),
    ).toThrow(/phase contract mismatch/u)
    expect(() =>
      assertPassedCheckupReport(
        { ...report, lease: { bookkeepingErrors: [{ operation: 'end' }] } },
        { mode: 'candidate', expectedPhases: ['green'] },
      ),
    ).toThrow(/lease bookkeeping/u)
    expect(() =>
      assertPassedCheckupReport({ ...report, error: { message: 'hidden' } }, { mode: 'candidate' }),
    ).toThrow(/carrying an error/u)
    expect(() =>
      assertPassedCheckupReport(
        { ...report, phases: [{ name: 'red', exitCode: 7, signal: null }] },
        { mode: 'candidate' },
      ),
    ).toThrow(/conflicts with phase/u)
    expect(() =>
      assertPassedCheckupReport(
        { ...report, cleanup: { completed: false, errors: ['leftover'] } },
        { mode: 'candidate' },
      ),
    ).toThrow(/cleanup/u)
  })
})
