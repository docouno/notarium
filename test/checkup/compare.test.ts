import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  argumentsOf,
  assertNormalizedSubjects,
  assertNotInterrupted,
  assertUniformRunIdentity,
  comparisonSummary,
  failedComparisonResult,
  retainedResourcesForFailure,
  runComparison,
  runLoggedProcess,
  runSubject,
  trimmedCommandOutput,
} from '../../scripts/checkup/compare.mjs'
import { processIdIsAlive } from '../../scripts/checkup/process.mjs'

describe('checkup A/B comparison', () => {
  it('keeps the GitLab speed denominator byte-identical', () => {
    const pipeline = readFileSync('.gitlab-ci.yml', 'utf8')

    expect(pipeline).toContain('--base "$CI_COMMIT_SHA" --candidate "$CI_COMMIT_SHA"')
    expect(pipeline).not.toContain('CHECKUP_COMPARE_BASE')
  })

  it('allows an explicit zero warmup for harness smoke runs only', () => {
    expect(
      argumentsOf(['--base', 'base', '--warmups', '0', '--run-timeout-ms', '240000']),
    ).toMatchObject({ warmups: 0, runTimeoutMs: 240000 })
    expect(() => argumentsOf(['--base', 'base', '--warmups', '-1'])).toThrow(
      /non-negative integer/u,
    )
    expect(() => argumentsOf(['--base', 'base', '--progress-interval-ms', '1'])).toThrow(
      /between 10000 and 600000/u,
    )
    expect(() =>
      argumentsOf(['--base', 'base', '--progress-interval-ms', '999999999999999999999']),
    ).toThrow(/safe integer/u)
    expect(() =>
      argumentsOf(['--base', 'base', '--run-timeout-ms', '999999999999999999999']),
    ).toThrow(/safe Node timer duration/u)
  })

  it('accepts inherited stdio commands that deliberately return no captured output', () => {
    expect(trimmedCommandOutput(null)).toBe('')
    expect(trimmedCommandOutput('  commit\n')).toBe('commit')
  })

  it('uses measured execution wall only and keeps max beside the median', () => {
    expect(
      comparisonSummary([
        { mode: 'legacy', measured: false, executionWallMs: 1 },
        { mode: 'candidate', measured: false, executionWallMs: 1 },
        { mode: 'legacy', measured: true, executionWallMs: 100 },
        { mode: 'candidate', measured: true, executionWallMs: 70 },
        { mode: 'legacy', measured: true, executionWallMs: 110 },
        { mode: 'candidate', measured: true, executionWallMs: 80 },
        { mode: 'legacy', measured: true, executionWallMs: 120 },
        { mode: 'candidate', measured: true, executionWallMs: 75 },
      ]),
    ).toEqual({
      legacy: { runs: 3, medianMs: 110, maxMs: 120 },
      candidate: { runs: 3, medianMs: 75, maxMs: 80 },
      improvementPercent: (35 / 110) * 100,
      targetMet: true,
    })
  })

  it('does not call a sub-20-percent change ready', () => {
    expect(
      comparisonSummary([
        { mode: 'legacy', measured: true, executionWallMs: 100 },
        { mode: 'candidate', measured: true, executionWallMs: 81 },
      ]).targetMet,
    ).toBe(false)
  })

  it('keeps a failed subject and both diagnostic streams in a partial aggregate', () => {
    const error = Object.assign(new Error('candidate failed'), {
      run: {
        mode: 'candidate',
        measured: true,
        ordinal: 2,
        kind: 'exit',
        exitCode: 1,
        signal: null,
        report: '/tmp/run.json',
        stdoutLog: '/tmp/run.stdout.log',
        stderrLog: '/tmp/run.stderr.log',
      },
    })

    expect(
      failedComparisonResult({
        base: 'base',
        candidate: 'candidate',
        diff: [],
        runs: [{ mode: 'legacy', measured: true, ordinal: 1 }],
        error,
      }),
    ).toMatchObject({
      schemaVersion: 1,
      summary: null,
      runs: [{ mode: 'legacy', measured: true, ordinal: 1 }],
      error: {
        name: 'Error',
        message: 'candidate failed',
        run: {
          mode: 'candidate',
          report: '/tmp/run.json',
          stdoutLog: '/tmp/run.stdout.log',
          stderrLog: '/tmp/run.stderr.log',
        },
      },
    })
  })

  it('retains owned worktrees when termination reports surviving processes', () => {
    const error = Object.assign(new Error('timeout'), {
      run: { termination: { survivingPids: [101, 202] } },
    })
    const retained = retainedResourcesForFailure({
      error,
      root: '/tmp/compare-root',
      baseRoot: '/tmp/compare-root/base',
      candidateRoot: '/tmp/compare-root/candidate',
    })

    expect(retained).toEqual({
      reason: 'owned-processes-survived-termination',
      survivingPids: [101, 202],
      root: '/tmp/compare-root',
      worktrees: ['/tmp/compare-root/base', '/tmp/compare-root/candidate'],
    })
    expect(
      failedComparisonResult({
        base: 'base',
        candidate: 'candidate',
        diff: [],
        runs: [],
        error,
        retained,
      }),
    ).toMatchObject({ retained: { root: '/tmp/compare-root', survivingPids: [101, 202] } })
    expect(
      retainedResourcesForFailure({
        error: new Error('ordinary failure'),
        root: '/tmp/compare-root',
        baseRoot: null,
        candidateRoot: null,
      }),
    ).toBe(null)
  })

  it('enforces the normalized tree and cohort identities as executable contracts', () => {
    expect(assertNormalizedSubjects({ baseTree: 'tree', candidateTree: 'tree', diff: [] })).toEqual(
      { tree: 'tree' },
    )
    expect(() =>
      assertNormalizedSubjects({ baseTree: 'base', candidateTree: 'candidate', diff: [] }),
    ).toThrow(/byte-identical trees/u)
    expect(() =>
      assertNormalizedSubjects({ baseTree: 'tree', candidateTree: 'tree', diff: ['M file'] }),
    ).toThrow(/empty base\/candidate diff/u)

    const paired = [
      {
        mode: 'legacy',
        ordinal: 1,
        measured: true,
        sourceDigest: 'source',
        driverDigest: 'driver',
      },
      {
        mode: 'candidate',
        ordinal: 1,
        measured: true,
        sourceDigest: 'source',
        driverDigest: 'driver',
      },
    ]

    expect(assertUniformRunIdentity(paired)).toEqual({
      sourceDigest: 'source',
      driverDigest: 'driver',
    })
    expect(() =>
      assertUniformRunIdentity([paired[0], { ...paired[1], sourceDigest: 'different-source' }]),
    ).toThrow(/source identity changed/u)
    expect(() =>
      assertUniformRunIdentity([paired[0], { ...paired[1], driverDigest: 'different-driver' }]),
    ).toThrow(/driver identity changed/u)
  })

  it('writes a machine-readable aggregate when commit preflight fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-compare-preflight-'))
    const output = join(root, 'aggregate.json')

    try {
      await expect(
        runComparison({
          base: 'missing-base',
          candidate: 'missing-candidate',
          runs: 1,
          warmups: 0,
          runTimeoutMs: 1_000,
          output,
          commitResolver: () => {
            throw new Error('injected revision failure')
          },
        }),
      ).rejects.toThrow('injected revision failure')
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        schemaVersion: 1,
        base: 'missing-base',
        candidate: 'missing-candidate',
        runs: [],
        summary: null,
        error: { message: 'injected revision failure', run: null },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retains a driver report path when timeout remains the owning failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-compare-timeout-report-'))
    const report = join(root, 'finished-report.json')

    try {
      await expect(
        runSubject({
          mode: 'candidate',
          root,
          revision: 'commit',
          output: root,
          measured: true,
          ordinal: 1,
          timeoutMs: 100,
          progressIntervalMs: 60_000,
          runProcess: async ({
            stdoutLog,
            stderrLog,
          }: {
            stdoutLog: string
            stderrLog: string
          }) => {
            writeFileSync(stdoutLog, `${JSON.stringify({ report })}\n`)
            writeFileSync(stderrLog, '')
            return {
              exitCode: 143,
              signal: null,
              error: null,
              timedOut: true,
              termination: {
                kind: 'timeout',
                requestedSignal: 'SIGTERM',
                survivingPids: [123],
              },
            }
          },
        }),
      ).rejects.toMatchObject({
        run: {
          kind: 'timeout',
          report,
          exitCode: 143,
          signal: null,
          termination: { survivingPids: [123] },
        },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('spools both streams without the spawnSync maxBuffer ceiling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-compare-streams-'))
    const stdoutLog = join(root, 'stdout.log')
    const stderrLog = join(root, 'stderr.log')
    const bytes = 2 * 1024 * 1024

    try {
      const result = await runLoggedProcess({
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write('o'.repeat(${bytes})); process.stderr.write('e'.repeat(${bytes}))`,
        ],
        stdoutLog,
        stderrLog,
        timeoutMs: 5_000,
      })

      expect(result).toMatchObject({ exitCode: 0, signal: null, error: null, timedOut: false })
      expect(statSync(stdoutLog).size).toBe(bytes)
      expect(statSync(stderrLog).size).toBe(bytes)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('forwards interruption and bounds a timed-out child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-compare-signals-'))
    const idle = ['-e', 'setInterval(() => {}, 1000)']
    const handlesInterrupt = [
      '-e',
      "process.on('SIGINT', () => setTimeout(() => process.exit(130), 120)); setInterval(() => {}, 1000)",
    ]

    try {
      const interruption = new AbortController()
      const interrupted = runLoggedProcess({
        command: process.execPath,
        args: handlesInterrupt,
        stdoutLog: join(root, 'interrupt.stdout.log'),
        stderrLog: join(root, 'interrupt.stderr.log'),
        timeoutMs: 150,
        abortSignal: interruption.signal,
        killGraceMs: 300,
      })
      setTimeout(() => interruption.abort('SIGINT'), 100)
      expect(await interrupted).toMatchObject({
        exitCode: 130,
        signal: null,
        error: null,
        timedOut: false,
        termination: { kind: 'abort', requestedSignal: 'SIGINT' },
      })

      expect(
        await runLoggedProcess({
          command: process.execPath,
          args: idle,
          stdoutLog: join(root, 'timeout.stdout.log'),
          stderrLog: join(root, 'timeout.stderr.log'),
          timeoutMs: 50,
          killGraceMs: 100,
        }),
      ).toMatchObject({
        exitCode: null,
        signal: 'SIGTERM',
        error: null,
        timedOut: true,
        termination: { kind: 'timeout', requestedSignal: 'SIGTERM' },
      })

      const late = new AbortController()

      late.abort('SIGTERM')
      expect(() => assertNotInterrupted(late.signal)).toThrow(/interrupted by SIGTERM/u)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits bounded parent heartbeats without forwarding child output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-compare-progress-'))
    const progress: number[] = []

    try {
      const result = await runLoggedProcess({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 90)'],
        stdoutLog: join(root, 'stdout.log'),
        stderrLog: join(root, 'stderr.log'),
        timeoutMs: 1_000,
        progressIntervalMs: 20,
        onProgress: ({ elapsedMs }) => progress.push(elapsedMs),
      })

      expect(result).toMatchObject({ exitCode: 0, signal: null, error: null })
      expect(progress.length).toBeGreaterThanOrEqual(2)
      expect(progress.length).toBeLessThan(10)
      expect(readFileSync(join(root, 'stdout.log'), 'utf8')).toBe('')
      expect(readFileSync(join(root, 'stderr.log'), 'utf8')).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('escalates through a detached descendant instead of orphaning it on timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-compare-descendant-'))
    const pidFile = join(root, 'descendant.pid')
    let descendantPid = 0

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }

    try {
      const script = [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        `const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' })`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid))`,
        'descendant.unref()',
        "process.on('SIGTERM', () => {})",
        'setInterval(() => {}, 1000)',
      ].join(';')
      const result = await runLoggedProcess({
        command: process.execPath,
        args: ['-e', script],
        stdoutLog: join(root, 'stdout.log'),
        stderrLog: join(root, 'stderr.log'),
        timeoutMs: 100,
        killGraceMs: 100,
      })

      descendantPid = Number(readFileSync(pidFile, 'utf8'))
      for (let attempt = 0; attempt < 40 && (await processIdIsAlive(descendantPid)); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25))
      }

      expect(result).toMatchObject({
        exitCode: null,
        signal: 'SIGKILL',
        timedOut: true,
        termination: { kind: 'timeout', requestedSignal: 'SIGTERM' },
      })
      await expect(processIdIsAlive(descendantPid)).resolves.toBe(false)
    } finally {
      if (descendantPid && alive(descendantPid)) {
        process.kill(descendantPid, 'SIGKILL')
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('contains a detached descendant created while the driver handles SIGTERM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-compare-late-descendant-'))
    const pidFile = join(root, 'late-descendant.pid')
    let descendantPid = 0

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }

    try {
      const script = [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        "process.on('SIGTERM', () => {",
        `const late = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' })`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(late.pid))`,
        'late.unref()',
        'setTimeout(() => process.exit(0), 5)',
        '})',
        'setInterval(() => {}, 1000)',
      ].join(';')
      const result = await runLoggedProcess({
        command: process.execPath,
        args: ['-e', script],
        stdoutLog: join(root, 'stdout.log'),
        stderrLog: join(root, 'stderr.log'),
        timeoutMs: 100,
        killGraceMs: 100,
      })

      descendantPid = Number(readFileSync(pidFile, 'utf8'))
      for (let attempt = 0; attempt < 40 && (await processIdIsAlive(descendantPid)); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25))
      }

      expect(result).toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: true,
        termination: { kind: 'timeout', requestedSignal: 'SIGTERM' },
      })
      await expect(processIdIsAlive(descendantPid)).resolves.toBe(false)
    } finally {
      if (descendantPid && alive(descendantPid)) {
        process.kill(descendantPid, 'SIGKILL')
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
