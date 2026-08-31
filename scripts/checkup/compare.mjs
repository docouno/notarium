#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nonNegativeInteger, positiveInteger } from './contract.mjs'
import { expectedPhaseNames, expectedSnapshotVerifications } from './index.mjs'
import {
  liveProcessIdentities,
  processIdentities,
  processIdsWithEnvironment,
  signalProcessIdentities,
} from './process.mjs'
import { assertPassedCheckupReport } from './report.mjs'

const driver = resolve(fileURLToPath(new URL('./index.mjs', import.meta.url)))

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const progressInterval = (value, fallback, name) => {
  const intervalMs = positiveInteger(value, fallback, name)

  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 600_000) {
    throw new RangeError(
      `${name} must be a safe integer between 10000 and 600000, got ${JSON.stringify(value)}`,
    )
  }

  return intervalMs
}

const timerDuration = (value, fallback, name) => {
  const durationMs = positiveInteger(value, fallback, name)

  if (!Number.isSafeInteger(durationMs) || durationMs > 2_147_483_647) {
    throw new RangeError(
      `${name} must be a safe Node timer duration no greater than 2147483647, got ${JSON.stringify(value)}`,
    )
  }

  return durationMs
}

export const comparisonSummary = (runs) => {
  const byMode = Object.fromEntries(
    ['legacy', 'candidate'].map((mode) => {
      const values = runs
        .filter((run) => run.mode === mode && run.measured)
        .map((run) => run.executionWallMs)

      if (!values.length) {
        throw new Error(`comparison has no measured ${mode} runs`)
      }

      return [mode, { runs: values.length, medianMs: median(values), maxMs: Math.max(...values) }]
    }),
  )
  const improvement =
    ((byMode.legacy.medianMs - byMode.candidate.medianMs) / byMode.legacy.medianMs) * 100

  return { ...byMode, improvementPercent: improvement, targetMet: improvement >= 20 }
}

export const argumentsOf = (argv) => {
  const options = {
    base: '',
    candidate: 'HEAD',
    runs: positiveInteger(process.env.CHECKUP_COMPARE_RUNS, 3, 'CHECKUP_COMPARE_RUNS'),
    warmups: nonNegativeInteger(process.env.CHECKUP_COMPARE_WARMUPS, 1, 'CHECKUP_COMPARE_WARMUPS'),
    runTimeoutMs: timerDuration(
      process.env.CHECKUP_COMPARE_RUN_TIMEOUT_MS,
      60 * 60 * 1000,
      'CHECKUP_COMPARE_RUN_TIMEOUT_MS',
    ),
    progressIntervalMs: progressInterval(
      process.env.CHECKUP_COMPARE_PROGRESS_INTERVAL_MS,
      60_000,
      'CHECKUP_COMPARE_PROGRESS_INTERVAL_MS',
    ),
    output: resolve(process.env.CHECKUP_COMPARE_OUTPUT || 'test-results/checkup-compare.json'),
  }
  const args = [...argv]

  while (args.length) {
    const flag = args.shift()
    const value = args.shift()

    if (flag === '--base') {
      options.base = value
    } else if (flag === '--candidate') {
      options.candidate = value
    } else if (flag === '--runs') {
      options.runs = positiveInteger(value, 3, '--runs')
    } else if (flag === '--warmups') {
      options.warmups = nonNegativeInteger(value, 1, '--warmups')
    } else if (flag === '--output') {
      options.output = resolve(value)
    } else if (flag === '--run-timeout-ms') {
      options.runTimeoutMs = timerDuration(value, 60 * 60 * 1000, '--run-timeout-ms')
    } else if (flag === '--progress-interval-ms') {
      options.progressIntervalMs = progressInterval(value, 60_000, '--progress-interval-ms')
    } else {
      throw new Error(`unknown compare argument ${flag}`)
    }
  }
  if (!options.base) {
    throw new Error('checkup compare requires --base <commit>')
  }

  return options
}

export const trimmedCommandOutput = (output) => (typeof output === 'string' ? output.trim() : '')

const git = (args, options = {}) =>
  trimmedCommandOutput(
    execFileSync('git', args, { encoding: 'utf8', stdio: options.stdio ?? 'pipe' }),
  )

const ensureCommit = (revision) => {
  try {
    return git(['rev-parse', `${revision}^{commit}`])
  } catch {
    git(['fetch', '--no-tags', 'origin', revision], { stdio: 'inherit' })
    return git(['rev-parse', `${revision}^{commit}`])
  }
}

const addWorktree = (path, revision) => {
  git(['worktree', 'add', '--detach', path, revision], { stdio: 'inherit' })

  return path
}

const removeWorktree = (path) => {
  spawnSync('git', ['worktree', 'remove', '--force', path], { stdio: 'ignore' })
}

const subjectRunError = (message, run) => Object.assign(new Error(message), { run })

const signalFromAbort = (signal) => (signal?.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM')
const interruptionError = (signal) =>
  subjectRunError(`checkup comparison interrupted by ${signal}`, {
    kind: 'interruption',
    requestedSignal: signal,
  })

export const assertNotInterrupted = (signal) => {
  if (signal?.aborted) {
    throw interruptionError(signalFromAbort(signal))
  }
}

/**
 * @param {{
 *   command: string,
 *   args: string[],
 *   stdoutLog: string,
 *   stderrLog: string,
 *   timeoutMs: number,
 *   abortSignal?: AbortSignal,
 *   killGraceMs?: number,
 *   progressIntervalMs?: number,
 *   onProgress?: ((progress: {pid: number, elapsedMs: number}) => void),
 * }} options
 */
export const runLoggedProcess = ({
  command,
  args,
  stdoutLog,
  stderrLog,
  timeoutMs,
  abortSignal = undefined,
  killGraceMs = 240_000,
  progressIntervalMs = 60_000,
  onProgress = undefined,
}) =>
  new Promise((resolveRun) => {
    const stdoutFd = openSync(stdoutLog, 'w')
    let stderrFd
    let child
    const ownershipToken = randomBytes(16).toString('hex')

    try {
      stderrFd = openSync(stderrLog, 'w')
      child = spawn(command, args, {
        stdio: ['ignore', stdoutFd, stderrFd],
        detached: process.platform !== 'win32',
        env: { ...process.env, CHECKUP_COMPARE_PROCESS_TOKEN: ownershipToken },
      })
    } catch (error) {
      if (stderrFd !== undefined) {
        closeSync(stderrFd)
      }
      closeSync(stdoutFd)
      resolveRun({ exitCode: null, signal: null, error, timedOut: false })
      return
    }
    closeSync(stderrFd)
    closeSync(stdoutFd)

    let childError = null
    let settled = false
    let termination = null
    let closeResult = null
    let resolveChildClose
    const childClose = new Promise((resolveClose) => {
      resolveChildClose = resolveClose
    })
    const started = Date.now()
    const progress = onProgress
      ? setInterval(() => {
          try {
            onProgress({ pid: child.pid, elapsedMs: Date.now() - started })
          } catch {
            // Trace progress is diagnostic and cannot change the subject verdict.
          }
        }, progressIntervalMs)
      : null

    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (progress) {
        clearInterval(progress)
      }
      abortSignal?.removeEventListener('abort', onAbort)
      resolveRun({
        exitCode: closeResult?.exitCode ?? child.exitCode,
        signal: closeResult?.signal ?? child.signalCode,
        error: childError,
        timedOut: termination?.kind === 'timeout',
        termination,
      })
    }

    const terminateTree = async (requestedSignal) => {
      const knownProcesses = new Map()
      const identityKey = ({ pid, startTime }) => `${pid}:${startTime}`

      const rememberPids = async (pids) => {
        const identities = await processIdentities(pids)

        for (const identity of identities) {
          knownProcesses.set(identityKey(identity), identity)
        }

        return identities
      }
      const knownIdentities = () => [...knownProcesses.values()]

      // Driver-owned phases inherit this token. Deliberate environment scrubbing is
      // outside the process-token containment contract.
      const scanOwnedProcesses = async () =>
        rememberPids(
          await processIdsWithEnvironment('CHECKUP_COMPARE_PROCESS_TOKEN', ownershipToken),
        )

      const signalNewOwnedProcesses = async (signal) => {
        const before = new Set(knownProcesses.keys())
        const ownedProcesses = await scanOwnedProcesses()
        const newlyOwned = ownedProcesses.filter((identity) => !before.has(identityKey(identity)))

        if (newlyOwned.length) {
          await signalProcessIdentities(newlyOwned, signal)
        }

        return ownedProcesses
      }

      try {
        await scanOwnedProcesses()
        const signalled = await signalProcessIdentities(knownIdentities(), requestedSignal)

        if (!signalled.length) {
          childError ||= new Error('could not establish owned process identity for termination')
        }
      } catch (error) {
        childError ||= error
      }

      const deadline = Date.now() + killGraceMs
      let quiescentScans = 0

      while (Date.now() < deadline) {
        await signalNewOwnedProcesses(requestedSignal)
        if (closeResult && (await liveProcessIdentities(knownIdentities())).length === 0) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20))
          const ownedAfterDeath = await signalNewOwnedProcesses(requestedSignal)

          if (
            !ownedAfterDeath.length &&
            (await liveProcessIdentities(knownIdentities())).length === 0
          ) {
            quiescentScans += 1
            if (quiescentScans >= 3) {
              finish()
              return
            }
            continue
          }
        }
        quiescentScans = 0
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      }

      try {
        await scanOwnedProcesses()
        await signalProcessIdentities(knownIdentities(), 'SIGKILL')
      } catch (error) {
        childError ||= error
      }
      await Promise.race([childClose, new Promise((resolveWait) => setTimeout(resolveWait, 1_000))])
      let survivingPids = []
      let emptyScans = 0

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const ownedProcesses = await scanOwnedProcesses()
        const liveKnown = await liveProcessIdentities(knownIdentities())
        const survivors = new Map(
          [...ownedProcesses, ...liveKnown].map((identity) => [identityKey(identity), identity]),
        )

        survivingPids = [...new Set([...survivors.values()].map(({ pid }) => pid))]
        if (!survivors.size) {
          emptyScans += 1
          if (emptyScans >= 3) {
            break
          }
        } else {
          emptyScans = 0
          await signalProcessIdentities([...survivors.values()], 'SIGKILL')
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      }
      if (survivingPids.length) {
        termination.survivingPids = survivingPids
        childError ||= new Error(
          `owned compare processes survived SIGKILL: ${survivingPids.join(',')}`,
        )
      }
      finish()
    }

    const terminate = (signal, kind) => {
      if (settled || termination || child.exitCode !== null || child.signalCode !== null) {
        return false
      }
      termination = { kind, requestedSignal: signal }
      clearTimeout(timeout)
      void terminateTree(signal)

      return true
    }
    const timeout = setTimeout(() => terminate('SIGTERM', 'timeout'), timeoutMs)
    const onAbort = () => terminate(signalFromAbort(abortSignal), 'abort')

    child.once('error', (error) => {
      childError = error
    })
    child.once('close', (exitCode, signal) => {
      closeResult = { exitCode, signal }
      resolveChildClose(closeResult)
      if (!termination) {
        finish()
      }
    })
    if (abortSignal?.aborted) {
      onAbort()
    } else {
      abortSignal?.addEventListener('abort', onAbort, { once: true })
    }
  })

export const runSubject = async ({
  mode,
  root,
  revision,
  output,
  measured,
  ordinal,
  timeoutMs,
  progressIntervalMs,
  abortSignal = undefined,
  runProcess = runLoggedProcess,
}) => {
  const stamp = `${process.pid}-${Date.now()}`
  const stdoutLog = join(
    output,
    `${mode}-${ordinal}-${measured ? 'measured' : 'warmup'}-${stamp}.stdout.log`,
  )
  const stderrLog = join(
    output,
    `${mode}-${ordinal}-${measured ? 'measured' : 'warmup'}-${stamp}.stderr.log`,
  )
  const label = `${mode} ${measured ? 'measured' : 'warmup'} ${ordinal}`

  console.error(`checkup compare: starting ${label}`)
  const result = await runProcess({
    command: process.execPath,
    args: [driver, 'run', '--mode', mode, '--subject-root', root, '--output-dir', output],
    stdoutLog,
    stderrLog,
    timeoutMs,
    abortSignal,
    progressIntervalMs,
    onProgress: ({ elapsedMs }) => {
      console.error(`checkup compare: ${label} running elapsedMs=${elapsedMs}`)
    },
  })
  const stdout = readFileSync(stdoutLog, 'utf8')
  const runFailure = {
    mode,
    measured,
    ordinal,
    kind: null,
    exitCode: result.exitCode,
    signal: result.signal,
    report: null,
    stdoutLog,
    stderrLog,
    termination: result.termination ?? null,
    errorCode: result.error?.code ?? null,
    errorMessage: result.error?.message ?? null,
  }
  const lines = stdout.trim().split('\n').filter(Boolean)
  let summary = {}
  let summaryError = null

  try {
    summary = JSON.parse(lines.at(-1) || '{}')
  } catch (error) {
    summaryError = error
  }
  runFailure.report = summary.report || null

  if (result.termination?.kind === 'timeout') {
    throw subjectRunError(
      `${mode} compare run ${ordinal} timed out after ${timeoutMs}ms; stdout=${stdoutLog} stderr=${stderrLog}`,
      { ...runFailure, kind: 'timeout', timeoutMs },
    )
  }
  if (result.termination?.kind === 'abort') {
    throw subjectRunError(
      `${mode} compare run ${ordinal} interrupted by ${result.termination.requestedSignal}; stdout=${stdoutLog} stderr=${stderrLog}`,
      {
        ...runFailure,
        kind: 'interruption',
        requestedSignal: result.termination.requestedSignal,
      },
    )
  }
  if (result.error) {
    throw subjectRunError(
      `${mode} compare run ${ordinal} could not start: ${result.error.message}; stdout=${stdoutLog} stderr=${stderrLog}`,
      {
        ...runFailure,
        kind: 'spawn',
        errorCode: result.error.code ?? null,
        errorMessage: result.error.message,
      },
    )
  }
  if (summaryError && result.exitCode === 0 && !result.signal) {
    throw subjectRunError(
      `${mode} compare run ${ordinal} returned no valid summary; stdout=${stdoutLog} stderr=${stderrLog}`,
      { ...runFailure, kind: 'summary' },
    )
  }
  if (result.exitCode !== 0 || result.signal) {
    const kind = result.signal ? 'signal' : 'exit'
    throw subjectRunError(
      `${mode} compare run ${ordinal} failed; report=${summary.report || 'missing'} stdout=${stdoutLog} stderr=${stderrLog}`,
      { ...runFailure, kind },
    )
  }
  if (!summary.report) {
    throw subjectRunError(
      `${mode} compare run ${ordinal} returned no report path; stdout=${stdoutLog} stderr=${stderrLog}`,
      { ...runFailure, kind: 'summary' },
    )
  }
  try {
    const report = assertPassedCheckupReport(JSON.parse(readFileSync(summary.report, 'utf8')), {
      mode,
      gitHead: revision,
      expectedPhases: expectedPhaseNames(mode),
      expectedSnapshotVerificationCount: expectedSnapshotVerifications(mode),
    })
    const run = {
      mode,
      measured,
      ordinal,
      sessionId: report.sessionId,
      report: summary.report,
      sourceDigest: report.subject.sourceDigest,
      driverDigest: report.driver.digest,
      stdoutLog,
      stderrLog,
      executionWallMs: report.measurement.executionWallMs,
      phaseWallMs: report.measurement.phaseWallMs,
      leaseWaitMs: report.measurement.leaseWaitMs,
    }

    console.error(`checkup compare: finished ${label} executionWallMs=${run.executionWallMs}`)
    return run
  } catch (error) {
    throw subjectRunError(
      `${mode} compare run ${ordinal} returned an unreadable report ${summary.report}: ${error.message}; stdout=${stdoutLog} stderr=${stderrLog}`,
      {
        ...runFailure,
        kind: 'report',
        errorCode: error.code ?? null,
        errorMessage: error.message,
      },
    )
  }
}

/** @param {{base: *, candidate: *, diff: *, runs: *, error: *, retained?: *}} input */
export const failedComparisonResult = ({
  base,
  candidate,
  diff,
  runs,
  error,
  retained = null,
}) => ({
  schemaVersion: 1,
  base,
  candidate,
  diff,
  runs,
  summary: null,
  retained,
  error: {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    run: error?.run ?? null,
  },
})

export const retainedResourcesForFailure = ({ error, root, baseRoot, candidateRoot }) => {
  const survivingPids = error?.run?.termination?.survivingPids

  if (!Array.isArray(survivingPids) || !survivingPids.length || !root) {
    return null
  }

  return {
    reason: 'owned-processes-survived-termination',
    survivingPids,
    root,
    worktrees: [baseRoot, candidateRoot].filter(Boolean),
  }
}

export const assertNormalizedSubjects = ({ baseTree, candidateTree, diff }) => {
  if (!baseTree || !candidateTree || baseTree !== candidateTree) {
    throw new Error(
      `normalized comparison requires byte-identical trees, got base=${baseTree || 'unknown'} candidate=${candidateTree || 'unknown'}`,
    )
  }
  if (!Array.isArray(diff) || diff.length) {
    throw new Error('normalized comparison requires an empty base/candidate diff')
  }

  return { tree: baseTree }
}

export const assertUniformRunIdentity = (runs) => {
  if (!runs.length) {
    throw new Error('normalized comparison produced no runs')
  }
  const sourceDigest = runs[0].sourceDigest
  const driverDigest = runs[0].driverDigest
  const pairs = new Map()

  for (const run of runs) {
    if (run.sourceDigest !== sourceDigest) {
      throw new Error(
        `normalized comparison source identity changed: ${sourceDigest} -> ${run.sourceDigest}`,
      )
    }
    if (run.driverDigest !== driverDigest) {
      throw new Error(
        `normalized comparison driver identity changed: ${driverDigest} -> ${run.driverDigest}`,
      )
    }
    if (!['legacy', 'candidate'].includes(run.mode)) {
      throw new Error(`normalized comparison observed invalid mode ${JSON.stringify(run.mode)}`)
    }
    const pair = pairs.get(run.ordinal) ?? []

    pair.push(run)
    pairs.set(run.ordinal, pair)
  }
  for (const [ordinal, pair] of pairs) {
    const modes = pair.map(({ mode }) => mode).sort()

    if (
      pair.length !== 2 ||
      modes[0] !== 'candidate' ||
      modes[1] !== 'legacy' ||
      pair[0].measured !== pair[1].measured
    ) {
      throw new Error(`normalized comparison run ${ordinal} is not a complete matched pair`)
    }
  }

  return { sourceDigest, driverDigest }
}

export const runComparison = async (options) => {
  const output = resolve(options.output)
  const reports = resolve(dirname(output), 'checkup-compare-runs')
  const resolveCommit = options.commitResolver ?? ensureCommit
  let base = options.base
  let candidate = options.candidate
  let baseTree = null
  let candidateTree = null
  let root = null
  let diff = []
  const runs = []
  let baseRoot = null
  let candidateRoot = null
  let baseAdded = false
  let candidateAdded = false
  let retained = null

  try {
    mkdirSync(dirname(output), { recursive: true })
    base = resolveCommit(options.base)
    candidate = resolveCommit(options.candidate)
    try {
      git(['merge-base', '--is-ancestor', base, candidate])
    } catch {
      throw new Error(`base ${base} is not an ancestor of candidate ${candidate}`)
    }
    baseTree = git(['rev-parse', `${base}^{tree}`])
    candidateTree = git(['rev-parse', `${candidate}^{tree}`])
    diff = git(['diff', '--name-status', base, candidate]).split('\n').filter(Boolean)
    assertNormalizedSubjects({ baseTree, candidateTree, diff })
    root = mkdtempSync(join(tmpdir(), 'notarium-checkup-compare-'))
    baseRoot = join(root, 'base')
    candidateRoot = join(root, 'candidate')
    addWorktree(baseRoot, base)
    baseAdded = true
    addWorktree(candidateRoot, candidate)
    candidateAdded = true
    mkdirSync(reports, { recursive: true })
    for (let index = 0; index < options.warmups + options.runs; index += 1) {
      const measured = index >= options.warmups
      const order = index % 2 === 0 ? ['legacy', 'candidate'] : ['candidate', 'legacy']

      for (const mode of order) {
        runs.push(
          await runSubject({
            mode,
            root: mode === 'legacy' ? baseRoot : candidateRoot,
            revision: mode === 'legacy' ? base : candidate,
            output: reports,
            measured,
            ordinal: index + 1,
            timeoutMs: options.runTimeoutMs,
            progressIntervalMs: options.progressIntervalMs,
            abortSignal: options.abortSignal,
          }),
        )
      }
    }
    assertNotInterrupted(options.abortSignal)
    const identity = assertUniformRunIdentity(runs)
    const result = {
      schemaVersion: 1,
      base,
      candidate,
      subject: {
        contract: 'normalized-same-tree',
        tree: baseTree,
        ...identity,
      },
      diff,
      runs,
      summary: comparisonSummary(runs),
    }

    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)

    return result
  } catch (error) {
    retained = retainedResourcesForFailure({ error, root, baseRoot, candidateRoot })
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(
      output,
      `${JSON.stringify(failedComparisonResult({ base, candidate, diff, runs, error, retained }), null, 2)}\n`,
    )
    throw error
  } finally {
    if (candidateAdded && !retained) {
      removeWorktree(candidateRoot)
    }
    if (baseAdded && !retained) {
      removeWorktree(baseRoot)
    }
    if (root && !retained) {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

const main = async () => {
  let interruptedSignal = null
  const interruption = new AbortController()

  const onSigint = () => {
    interruptedSignal ||= 'SIGINT'
    process.exitCode = 130
    if (!interruption.signal.aborted) {
      interruption.abort('SIGINT')
    }
  }

  const onSigterm = () => {
    interruptedSignal ||= 'SIGTERM'
    process.exitCode = 143
    if (!interruption.signal.aborted) {
      interruption.abort('SIGTERM')
    }
  }
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  try {
    const options = { ...argumentsOf(process.argv.slice(2)), abortSignal: interruption.signal }
    const result = await runComparison(options)

    await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
    if (interruptedSignal) {
      const error = interruptionError(interruptedSignal)

      writeFileSync(
        options.output,
        `${JSON.stringify(
          failedComparisonResult({
            base: result.base,
            candidate: result.candidate,
            diff: result.diff,
            runs: result.runs,
            error,
          }),
          null,
          2,
        )}\n`,
      )
      throw error
    }

    console.log(JSON.stringify({ output: options.output, ...result.summary }))
    if (!result.summary.targetMet) {
      process.exitCode = 1
    }
  } catch (error) {
    if (!interruptedSignal) {
      throw error
    }
    console.error(`checkup compare interrupted by ${interruptedSignal}`)
    process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
