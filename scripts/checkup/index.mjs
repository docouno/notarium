#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { positiveInteger, sessionIdFor } from './contract.mjs'
import { cleanupHeavyResources } from './heavy.mjs'
import { acquireHeavyLease } from './lease.mjs'
import { phaseOwnershipIncompleteErrors, runPhase } from './process.mjs'
import { resolveCheckupProfile, resolveResourceAllocation } from './profile.mjs'
import {
  environmentEvidence,
  finishCheckupReport,
  newCheckupReport,
  writeCheckupReport,
} from './report.mjs'
import { createSourceSnapshot, verifySourceSnapshot } from './snapshot.mjs'

const execFileAsync = promisify(execFile)
const driverDirectory = dirname(fileURLToPath(import.meta.url))

const signalExitCode = (signal) => (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)

const signalFromAbort = (signal) => (signal?.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM')

const interruptionError = (signal) =>
  Object.assign(new Error(`checkup interrupted by ${signal}`), {
    name: 'CheckupInterruptionError',
    signal,
  })

const checkupSamplerInterval = (value, fallback) => {
  const intervalMs = positiveInteger(value, fallback, 'CHECKUP_SAMPLE_INTERVAL_MS')

  if (!Number.isSafeInteger(intervalMs) || intervalMs > 60_000) {
    throw new RangeError(
      `CHECKUP_SAMPLE_INTERVAL_MS must be a safe integer no greater than 60000, got ${JSON.stringify(value)}`,
    )
  }

  return intervalMs
}

const checkupTimerDuration = (value, fallback, name) => {
  const durationMs = positiveInteger(value, fallback, name)

  if (!Number.isSafeInteger(durationMs) || durationMs > 60_000) {
    throw new RangeError(
      `${name} must be a safe integer no greater than 60000, got ${JSON.stringify(value)}`,
    )
  }

  return durationMs
}

const waitForSignal = (promise, signal) => {
  if (!signal) {
    return promise
  }
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(interruptionError(signalFromAbort(signal)))
  }

  return new Promise((resolveWait, rejectWait) => {
    let interrupted = false

    const onAbort = () => {
      interrupted = true
      promise.catch(() => {})
      rejectWait(interruptionError(signalFromAbort(signal)))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (interrupted) {
          return
        }
        resolveWait(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        rejectWait(error)
      },
    )
  })
}

const settleWithin = async (promise, timeoutMs) => {
  let timeout
  const pending = Symbol('pending')

  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      ),
      new Promise((resolvePending) => {
        timeout = setTimeout(() => resolvePending(pending), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

const createOwnedSourceSnapshot = async (options, lifecycle) => {
  const sessionRoot = await mkdtemp(join(tmpdir(), 'notarium-checkup-'))
  const snapshotPromise = Promise.resolve().then(() =>
    (options.snapshotFactory ?? createSourceSnapshot)({
      root: options.subjectRoot,
      sessionRoot,
      signal: lifecycle.signal,
    }),
  )

  try {
    const snapshot = await waitForSignal(snapshotPromise, lifecycle.signal)

    if (resolve(snapshot.sessionRoot) !== resolve(sessionRoot)) {
      throw new Error(
        `snapshot factory returned unowned session root ${JSON.stringify(snapshot.sessionRoot)}`,
      )
    }

    return snapshot
  } catch (error) {
    const cleanupErrors = []

    if (error?.name === 'CheckupInterruptionError') {
      const settled = await settleWithin(snapshotPromise, options.snapshotAbortGraceMs ?? 5_000)

      if (typeof settled === 'symbol') {
        cleanupErrors.push(
          `snapshot creation did not settle after ${error.signal}; ownership remains indeterminate`,
        )
        void snapshotPromise
          .then(
            () => rm(sessionRoot, { recursive: true, force: true }),
            () => rm(sessionRoot, { recursive: true, force: true }),
          )
          .catch(() => {})
      } else if (settled.status === 'fulfilled') {
        if (resolve(settled.value?.sessionRoot) !== resolve(sessionRoot)) {
          cleanupErrors.push('snapshot factory settled with an unowned session root')
        }
      }
    }

    try {
      await rm(sessionRoot, { recursive: true, force: true })
    } catch (cleanupError) {
      cleanupErrors.push(`snapshot root ${sessionRoot}: ${cleanupError.message}`)
    }
    if (cleanupErrors.length) {
      error.cleanupErrors = [...(error.cleanupErrors ?? []), ...cleanupErrors]
    }

    throw error
  }
}

export const parseArguments = (argv) => {
  const options = {
    command: 'run',
    mode: 'candidate',
    subjectRoot: process.cwd(),
    outputDir: null,
    keepSnapshot: false,
    snapshotOnly: false,
  }
  const args = [...argv]

  if (args[0] && !args[0].startsWith('-')) {
    options.command = args.shift()
  }

  while (args.length) {
    const flag = args.shift()

    if (flag === '--mode') {
      options.mode = args.shift()
    } else if (flag === '--subject-root') {
      options.subjectRoot = args.shift()
    } else if (flag === '--output-dir') {
      options.outputDir = args.shift()
    } else if (flag === '--keep-snapshot') {
      options.keepSnapshot = true
    } else if (flag === '--snapshot-only') {
      options.snapshotOnly = true
    } else {
      throw new Error(`unknown checkup argument: ${flag}`)
    }
  }
  if (!['run', 'snapshot'].includes(options.command)) {
    throw new Error(`unknown checkup command: ${options.command}`)
  }
  if (!['candidate', 'legacy'].includes(options.mode)) {
    throw new Error(`checkup mode must be candidate or legacy, got ${options.mode}`)
  }

  options.subjectRoot = resolve(options.subjectRoot)
  options.outputDir = resolve(options.outputDir ?? join(process.cwd(), 'test-results/checkup'))

  return options
}

const gitValue = async (root, args, fallback = null) => {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, encoding: 'utf8' })

    return stdout.trim() || fallback
  } catch {
    return fallback
  }
}

const driverDigest = async () => {
  const names = (await readdir(driverDirectory)).filter((name) => name.endsWith('.mjs')).sort()
  const hash = createHash('sha256')

  for (const name of names) {
    hash.update(name)
    hash.update('\0')
    hash.update(await readFile(join(driverDirectory, name)))
    hash.update('\0')
  }

  return hash.digest('hex')
}

const STATIC_CORRECTNESS_PHASES = Object.freeze([
  { name: 'format', command: 'npm', args: ['run', 'format:check'] },
  { name: 'canon', command: 'npm', args: ['run', 'canon:check'] },
  { name: 'meta-migrations', command: 'npm', args: ['run', 'meta-migrations:check'] },
  { name: 'runtime-audit', command: 'npm', args: ['run', 'audit:runtime'] },
  { name: 'lint', command: 'npm', args: ['run', 'lint'] },
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
])

export const staticPhasePlan = ({ preset = 'checkup', profiled = true } = {}) => {
  if (!['checkup', 'ci-lean'].includes(preset)) {
    throw new Error(`unknown static phase preset ${JSON.stringify(preset)}`)
  }
  const resource = profiled ? { resource: { plan: 'local-static', lane: 'static' } } : {}
  const correctness = STATIC_CORRECTNESS_PHASES.filter(
    (phase) => preset === 'checkup' || phase.name !== 'runtime-audit',
  ).map((phase) => ({
    ...phase,
    parallelGroup: 'static-correctness',
    ...resource,
  }))

  return preset === 'ci-lean'
    ? correctness
    : [
        {
          name: 'dependencies',
          command: 'npm',
          args: ['run', 'deps:lean'],
          resource: { plan: 'local-static', lane: 'static' },
        },
        {
          name: 'write-performance',
          command: 'make',
          args: ['--no-print-directory', 'write-perf-gate'],
          resource: { plan: 'local-static', lane: 'write-performance' },
        },
        ...correctness,
      ]
}

export const phasePlan = (mode, sessionId) => {
  const staticPhases = staticPhasePlan()

  if (mode === 'legacy') {
    return {
      static: staticPhases,
      heavy: [
        {
          name: 'coverage',
          command: 'make',
          args: ['--no-print-directory', 'test-coverage'],
          daemonWork: true,
        },
        {
          name: 'postgres',
          command: 'make',
          args: ['--no-print-directory', 'test-pg'],
          daemonWork: true,
        },
        {
          name: 'backup-smoke',
          command: 'make',
          args: ['--no-print-directory', 'backup-smoke'],
          daemonWork: true,
        },
        {
          name: 'browser',
          command: 'make',
          args: ['--no-print-directory', 'test-browser'],
          daemonWork: true,
        },
      ],
    }
  }

  return {
    static: staticPhases,
    heavy: [
      {
        name: 'coverage',
        command: process.execPath,
        args: ['scripts/checkup/heavy.mjs', 'coverage'],
        daemonWork: true,
        resource: { plan: 'local-isolated', lane: 'coverage' },
      },
      {
        name: 'postgres',
        command: process.execPath,
        args: ['scripts/checkup/heavy.mjs', 'postgres'],
        daemonWork: true,
        parallelGroup: 'postgres-browser',
        resource: { plan: 'local-heavy', lane: 'postgres' },
      },
      {
        name: 'browser',
        command: process.execPath,
        args: ['scripts/checkup/heavy.mjs', 'browser'],
        daemonWork: true,
        parallelGroup: 'postgres-browser',
        resource: { plan: 'local-heavy', lane: 'browser' },
      },
      {
        name: 'backup-smoke',
        command: 'make',
        args: [
          '--no-print-directory',
          `BACKUP_SMOKE_TAG=notarium-backup-smoke:${sessionId}`,
          'backup-smoke',
        ],
        daemonWork: true,
      },
    ],
  }
}

export const expectedPhaseNames = (mode) => {
  const plan = phasePlan(mode, 'phase-contract')

  return [...plan.static, ...plan.heavy].map(({ name }) => name)
}

export const expectedSnapshotVerifications = (mode) => {
  const heavy = phasePlan(mode, 'verification-contract').heavy
  let batches = 0

  for (let index = 0; index < heavy.length;) {
    const group = heavy[index].parallelGroup

    batches += 1
    index += 1
    while (group && index < heavy.length && heavy[index].parallelGroup === group) {
      index += 1
    }
  }

  return 1 + batches
}

const createSignalLifecycle = (externalSignal) => {
  const interruption = new AbortController()
  const activeChildren = new Set()
  let interruptedSignal = null

  const forwardToChild = (child, signal) => {
    if (!child?.pid) {
      return
    }
    try {
      if (process.platform === 'win32') {
        child.kill(signal)
      } else {
        process.kill(-child.pid, signal)
      }
    } catch {
      // The phase already exited; its completion path owns the remaining cleanup.
    }
  }

  const handleSignal = (signal) => {
    interruptedSignal ||= signal
    if (!interruption.signal.aborted) {
      interruption.abort(interruptedSignal)
    }
    for (const child of activeChildren) {
      forwardToChild(child, interruptedSignal)
    }
  }
  const onSigint = () => handleSignal('SIGINT')
  const onSigterm = () => handleSignal('SIGTERM')
  const onExternalAbort = () => handleSignal(signalFromAbort(externalSignal))

  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  if (externalSignal?.aborted) {
    onExternalAbort()
  } else {
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  }

  return {
    signal: interruption.signal,
    get interruptedSignal() {
      return interruptedSignal
    },
    addChild: (child) => {
      activeChildren.add(child)
      if (interruptedSignal) {
        forwardToChild(child, interruptedSignal)
      }
    },
    removeChild: (child) => activeChildren.delete(child),
    dispose: () => {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

const runCheckupSession = async (options, lifecycle) => {
  const digest = await waitForSignal(driverDigest(), lifecycle.signal)
  const snapshot = await createOwnedSourceSnapshot(options, lifecycle)
  const sessionId = sessionIdFor(snapshot.sourceDigest)
  const reportPath = join(options.outputDir, `${sessionId}.json`)
  const manifestOutput = join(options.outputDir, `${sessionId}.manifest.jsonl`)
  const gitHead = await gitValue(options.subjectRoot, ['rev-parse', 'HEAD'])
  const repositoryIdentity = await gitValue(
    options.subjectRoot,
    ['config', '--get', 'remote.origin.url'],
    await gitValue(options.subjectRoot, ['rev-parse', '--show-toplevel'], options.subjectRoot),
  )
  const report = newCheckupReport({
    sessionId,
    driverDigest: digest,
    subject: {
      mode: options.mode,
      sourceDigest: snapshot.sourceDigest,
      gitHead,
      dirty: snapshot.dirty,
    },
    snapshot: {
      fileCount: snapshot.fileCount,
      byteCount: snapshot.byteCount,
      denied: snapshot.denied,
      manifest: `${sessionId}.manifest.jsonl`,
    },
  })
  let lease = null
  let exitCode = 0
  const cleanupErrors = []
  let retainLease = false
  const ownershipIncompleteErrors = []
  const sessionEnvironment = options.env ?? process.env
  let samplerIntervalMs = null
  let phaseTerminationGraceMs = null

  const rememberOwnershipIncomplete = (errors) => {
    for (const error of errors) {
      if (!ownershipIncompleteErrors.includes(error)) {
        ownershipIncompleteErrors.push(error)
      }
    }
  }
  const ownershipIncompleteEvidence = (error) => ({
    name: error.name,
    code: error.code,
    message: error.message,
    phase: error.phase,
    rootPid: error.rootPid ?? null,
    leaderFinished: error.leaderFinished,
    groupAlive: error.groupAlive,
    ...(error.phaseResult ? { phaseResult: error.phaseResult } : {}),
  })

  try {
    await mkdir(options.outputDir, { recursive: true })
    await copyFile(snapshot.manifestPath, manifestOutput)
    const workRoot = join(snapshot.sessionRoot, 'work')
    await cp(snapshot.sourceRoot, workRoot, { recursive: true, preserveTimestamps: true })
    report.environment = await environmentEvidence()
    const resolvedProfile = resolveCheckupProfile({ env: sessionEnvironment })

    samplerIntervalMs = checkupSamplerInterval(
      sessionEnvironment.CHECKUP_SAMPLE_INTERVAL_MS,
      resolvedProfile.requested.samplerIntervalMs,
    )
    phaseTerminationGraceMs = checkupTimerDuration(
      options.phaseTerminationGraceMs ?? sessionEnvironment.CHECKUP_PHASE_TERMINATION_GRACE_MS,
      30_000,
      'CHECKUP_PHASE_TERMINATION_GRACE_MS',
    )
    report.profile = {
      ...resolvedProfile,
      requested: { ...resolvedProfile.requested, samplerIntervalMs, phaseTerminationGraceMs },
      effective: { ...resolvedProfile.effective, samplerIntervalMs, phaseTerminationGraceMs },
    }
    await writeCheckupReport(reportPath, report)

    execution: {
      if (options.command === 'snapshot' || options.snapshotOnly) {
        break execution
      }

      const plan = (options.planFactory ?? phasePlan)(options.mode, sessionId)
      const phaseEnvironment = {
        ...sessionEnvironment,
        CHECKUP_SAMPLE_INTERVAL_MS: String(samplerIntervalMs),
        CHECKUP_SESSION_ID: sessionId,
        CHECKUP_SUBJECT_DIGEST: snapshot.sourceDigest,
        CHECKUP_REQUIRE_AFFINITY: '1',
        TEST_COMPOSE_PROJECT: `notarium-checkup-${sessionId}`,
        CHECKUP_IMAGE: `notarium-checkup:${sessionId}`,
        CHECKUP_ARTIFACT_DIR: join(options.outputDir, `${sessionId}.artifacts`),
        CHECKUP_SOURCE_ROOT: snapshot.sourceRoot,
        CHECKUP_PLAYWRIGHT_IMAGE: 'mcr.microsoft.com/playwright:v1.60.0-jammy',
        CHECKUP_WORKSPACE_VOLUME: `notarium-checkup-${sessionId}-workspace`,
        CHECKUP_RUNNER_CONTAINER: `notarium-checkup-${sessionId}-runner`,
      }

      const leaseBookkeepingError = (phase, operation, error) =>
        Object.assign(
          new Error(`lease ${operation} failed for phase ${phase}: ${error?.message || error}`),
          {
            name: 'LeasePhaseBookkeepingError',
            phase,
            operation,
            cause: error,
          },
        )

      const runPhaseResult = async (phase) => {
        const runnable = phase.resource
          ? {
              ...phase,
              command: process.execPath,
              args: [
                'scripts/checkup/profile.mjs',
                '--plan',
                phase.resource.plan,
                '--lane',
                phase.resource.lane,
                phase.command,
                ...(phase.args ?? []),
              ],
            }
          : phase
        let activeChild = null
        let phaseRegistration = { status: 'fulfilled', error: null }
        let phaseBegun = false
        let result = null
        let primaryError = null
        let phaseOwnershipIncomplete = []
        const bookkeepingErrors = []

        try {
          if (phase.daemonWork) {
            try {
              await lease?.beginPhase?.(phase.name)
              phaseBegun = true
            } catch (error) {
              bookkeepingErrors.push(leaseBookkeepingError(phase.name, 'begin', error))
              return {
                result,
                primaryError,
                bookkeepingErrors,
                ownershipIncomplete: phaseOwnershipIncomplete,
              }
            }
          }
          try {
            result = await (options.phaseRunner ?? runPhase)({
              ...runnable,
              cwd: workRoot,
              env: phaseEnvironment,
              samplerIntervalMs,
              terminationSignal: lifecycle.signal,
              terminationKillGraceMs: phaseTerminationGraceMs,
              onSpawnFailureKillGraceMs: phaseTerminationGraceMs,
              onSpawn: (child) => {
                activeChild = child
                lifecycle.addChild(child)
                if (phase.daemonWork) {
                  try {
                    const registration = Promise.resolve(
                      lease?.registerPhasePid?.(phase.name, child.pid),
                    ).catch((error) => {
                      throw leaseBookkeepingError(phase.name, 'register-pid', error)
                    })

                    phaseRegistration = { status: 'pending', error: null }
                    void registration.then(
                      () => {
                        phaseRegistration = { status: 'fulfilled', error: null }
                      },
                      (error) => {
                        phaseRegistration = { status: 'rejected', error }
                      },
                    )

                    return registration.then(() => undefined)
                  } catch (error) {
                    const bookkeepingError = leaseBookkeepingError(
                      phase.name,
                      'register-pid',
                      error,
                    )

                    phaseRegistration = { status: 'rejected', error: bookkeepingError }
                    throw bookkeepingError
                  }
                }
              },
            })
          } catch (error) {
            primaryError = error
            phaseOwnershipIncomplete = phaseOwnershipIncompleteErrors(error)
            result ??= phaseOwnershipIncomplete.find((entry) => entry.phaseResult)?.phaseResult
          }
          const registrationError =
            phaseRegistration.status === 'rejected' ? phaseRegistration.error : null

          if (registrationError) {
            bookkeepingErrors.push(registrationError)
          }
          if (result && phase.daemonWork) {
            result.daemonDiagnostics = {
              capability: 'unavailable',
              reason: 'docker-daemon-work-not-attributable-to-client-process-tree',
            }
          }
          if (result && phase.resource) {
            result.resource = resolveResourceAllocation({
              ...phase.resource,
              availableCpu: report.environment.availableParallelism,
            })
          }
          try {
            if (!result) {
              throw new Error('phase produced no result')
            }
            result.artifactEvidence = JSON.parse(
              await readFile(
                join(options.outputDir, `${sessionId}.artifacts`, `evidence-${phase.name}.json`),
                'utf8',
              ),
            )
          } catch {
            // Phases without a reusable-artifact contract (for example backup-smoke)
            // deliberately carry no fabricated zero-count evidence.
          }
        } finally {
          const registrationError =
            phaseRegistration.status === 'rejected' ? phaseRegistration.error : null

          if (registrationError && !bookkeepingErrors.includes(registrationError)) {
            bookkeepingErrors.push(registrationError)
          }
          if (phase.daemonWork && phaseBegun && !phaseOwnershipIncomplete.length) {
            try {
              await lease?.endPhase?.(phase.name)
            } catch (error) {
              bookkeepingErrors.push(leaseBookkeepingError(phase.name, 'end', error))
            }
          }
          if (activeChild && !phaseOwnershipIncomplete.length) {
            lifecycle.removeChild(activeChild)
          }
        }

        return {
          result,
          primaryError,
          bookkeepingErrors,
          ownershipIncomplete: phaseOwnershipIncomplete,
        }
      }

      const recordResults = async (results) => {
        report.phases.push(...results)
        await writeCheckupReport(reportPath, report)
        const failed = results.find((result) => result.exitCode !== 0 || result.signal)

        if (failed) {
          exitCode = failed.exitCode ?? signalExitCode(failed.signal)
          return false
        }

        return true
      }

      const recordBookkeepingErrors = async (errors) => {
        if (!errors.length) {
          return
        }
        report.lease ??= { bookkeepingErrors: [] }
        report.lease.bookkeepingErrors ??= []
        for (const error of errors) {
          report.lease.bookkeepingErrors.push({
            phase: error.phase,
            operation: error.operation,
            name: error.name,
            message: error.message,
          })
          cleanupErrors.push(
            `lease phase ${error.phase} ${error.operation}: ${error.cause?.message || error.message}`,
          )
        }
        await writeCheckupReport(reportPath, report)
      }

      const execute = async (phase) => {
        if (lifecycle.interruptedSignal) {
          exitCode = signalExitCode(lifecycle.interruptedSignal)
          return false
        }
        const outcome = await runPhaseResult(phase)

        rememberOwnershipIncomplete(outcome.ownershipIncomplete)
        const passed = outcome.result ? await recordResults([outcome.result]) : false

        await recordBookkeepingErrors(outcome.bookkeepingErrors)
        if (outcome.primaryError || outcome.bookkeepingErrors.length) {
          throw outcome.primaryError ?? outcome.bookkeepingErrors[0]
        }

        return passed
      }

      const executeParallel = async (phases) => {
        if (lifecycle.interruptedSignal) {
          exitCode = signalExitCode(lifecycle.interruptedSignal)
          return false
        }
        const outcomes = await Promise.all(phases.map((phase) => runPhaseResult(phase)))
        rememberOwnershipIncomplete(outcomes.flatMap((outcome) => outcome.ownershipIncomplete))
        const results = outcomes.map(({ result }) => result).filter(Boolean)
        const passed = results.length ? await recordResults(results) : false
        const bookkeepingErrors = outcomes.flatMap((outcome) => outcome.bookkeepingErrors)
        const primaryError = outcomes.find((outcome) => outcome.primaryError)?.primaryError

        await recordBookkeepingErrors(bookkeepingErrors)
        if (primaryError || bookkeepingErrors.length) {
          throw primaryError ?? bookkeepingErrors[0]
        }

        return passed
      }

      for (let index = 0; index < plan.static.length;) {
        const phase = plan.static[index]
        const group = phase.parallelGroup

        if (!group) {
          index += 1
          if (!(await execute(phase))) {
            break execution
          }
          continue
        }
        const phases = []

        while (index < plan.static.length && plan.static[index].parallelGroup === group) {
          phases.push(plan.static[index])
          index += 1
        }
        if (!(await executeParallel(phases))) {
          break execution
        }
      }

      const verifyBeforeHeavy = async () => {
        try {
          await verifySourceSnapshot(snapshot)
          report.snapshot.verifiedBeforeHeavy = true
          report.snapshot.verificationsBeforeHeavy =
            (report.snapshot.verificationsBeforeHeavy ?? 0) + 1
          await writeCheckupReport(reportPath, report)
        } catch (error) {
          report.snapshot.verifiedBeforeHeavy = false
          await writeCheckupReport(reportPath, report)
          throw error
        }
      }

      await verifyBeforeHeavy()

      lease = await (options.leaseFactory ?? acquireHeavyLease)({
        repositoryIdentity,
        sessionId,
        subjectDigest: snapshot.sourceDigest,
        command: options.mode === 'legacy' ? 'checkup legacy' : 'checkup candidate',
        onWait: ({ current, elapsed, heartbeatAgeMs }) => {
          if (elapsed < 1_500 || elapsed % 30_000 < 1_000) {
            console.error(
              `checkup: waiting for heavy lease owner=${current.owner} session=${current.sessionId} elapsedMs=${elapsed} heartbeatAgeMs=${heartbeatAgeMs}`,
            )
          }
        },
        signal: lifecycle.signal,
      })
      report.lease = {
        name: lease.container,
        waitMs: lease.waitMs,
        recovered: lease.recovered,
        owner: lease.owner,
        bookkeepingErrors: [],
      }
      await writeCheckupReport(reportPath, report)

      for (let index = 0; index < plan.heavy.length;) {
        const phase = plan.heavy[index]
        const group = phase.parallelGroup

        await verifyBeforeHeavy()
        await lease.assertHealthy()
        if (!group) {
          index += 1
          if (!(await execute(phase))) {
            break execution
          }
          continue
        }
        const phases = []

        while (index < plan.heavy.length && plan.heavy[index].parallelGroup === group) {
          phases.push(plan.heavy[index])
          index += 1
        }
        if (!(await executeParallel(phases))) {
          break execution
        }
      }
    }
  } catch (error) {
    rememberOwnershipIncomplete(phaseOwnershipIncompleteErrors(error))
    exitCode = lifecycle.interruptedSignal
      ? signalExitCode(lifecycle.interruptedSignal)
      : exitCode || 1
    if (Array.isArray(error?.cleanupErrors)) {
      cleanupErrors.push(
        ...error.cleanupErrors.map((detail) => `lease initialization: ${String(detail)}`),
      )
    }
    const ownershipCause = ownershipIncompleteErrors[0]
      ? ownershipIncompleteEvidence(ownershipIncompleteErrors[0])
      : null

    report.error = lifecycle.interruptedSignal
      ? {
          stage: 'execution',
          name: 'CheckupInterruptionError',
          message: `checkup interrupted by ${lifecycle.interruptedSignal}`,
          signal: lifecycle.interruptedSignal,
          ...(ownershipCause ? { cause: ownershipCause } : {}),
        }
      : {
          stage: report.phases.length || ownershipCause ? 'execution' : 'setup',
          name: error?.name || 'Error',
          message: error?.message || String(error),
          ...(ownershipCause ? { cause: ownershipCause } : {}),
        }
  } finally {
    const retainOwnership = ownershipIncompleteErrors.length > 0
    const retainedReason = 'phase-ownership-incomplete'

    if (retainOwnership) {
      for (const error of ownershipIncompleteErrors) {
        cleanupErrors.push(
          `${error.name}[${error.code}]: phase=${error.phase} rootPid=${error.rootPid ?? 'unknown'} leaderFinished=${error.leaderFinished} groupAlive=${error.groupAlive}: ${error.message}`,
        )
      }
      report.snapshot.retained = true
      report.snapshot.retainedReason = retainedReason
      report.snapshot.retainedPath = snapshot.sessionRoot
      if (lease) {
        report.lease.retained = true
        report.lease.retainedReason = retainedReason
      }
    }
    if (lease) {
      try {
        await lease.stopHeartbeat?.()
      } catch (error) {
        cleanupErrors.push(`lease heartbeat: ${error.message}`)
      }
    }
    if (options.command === 'run' && options.mode === 'candidate' && !retainOwnership) {
      try {
        const cleanup = options.cleanupHeavyResources ?? cleanupHeavyResources

        cleanup({
          ...sessionEnvironment,
          CHECKUP_SESSION_ID: sessionId,
          CHECKUP_IMAGE: `notarium-checkup:${sessionId}`,
          CHECKUP_RUNNER_CONTAINER: `notarium-checkup-${sessionId}-runner`,
        })
      } catch (error) {
        cleanupErrors.push(`heavy resources: ${error.message}`)
        retainLease = true
      }
    } else if (options.command === 'run' && options.mode === 'candidate' && retainOwnership) {
      cleanupErrors.push('heavy resources retained because phase ownership is incomplete')
      retainLease = true
    }
    if (lease && !retainLease && !retainOwnership) {
      try {
        await lease.release()
      } catch (error) {
        cleanupErrors.push(`lease: ${error.message}`)
      }
    } else if (lease && retainOwnership) {
      cleanupErrors.push('lease retained because phase ownership is incomplete')
    } else if (lease && retainLease) {
      cleanupErrors.push('lease retained because heavy resource cleanup was incomplete')
    }
    try {
      await verifySourceSnapshot(snapshot)
      report.snapshot.verifiedAfterRun = true
    } catch (error) {
      exitCode = exitCode || 1
      report.snapshot.verifiedAfterRun = false
      cleanupErrors.push(`snapshot verification: ${error.message}`)
    }
    if (!options.keepSnapshot && !retainOwnership) {
      try {
        await rm(snapshot.sessionRoot, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(`snapshot: ${error.message}`)
      }
    } else if (retainOwnership) {
      cleanupErrors.push(
        `snapshot retained at ${snapshot.sessionRoot} because phase ownership is incomplete`,
      )
    }
    if (lifecycle.interruptedSignal) {
      exitCode = signalExitCode(lifecycle.interruptedSignal)
      const ownershipCause = ownershipIncompleteErrors[0]
        ? ownershipIncompleteEvidence(ownershipIncompleteErrors[0])
        : null

      report.error ??= {
        stage: 'execution',
        name: 'CheckupInterruptionError',
        message: `checkup interrupted by ${lifecycle.interruptedSignal}`,
        signal: lifecycle.interruptedSignal,
        ...(ownershipCause ? { cause: ownershipCause } : {}),
      }
    }
    if (cleanupErrors.length && exitCode === 0) {
      exitCode = 1
    }
    finishCheckupReport(report, { exitCode, cleanupErrors })
    await writeCheckupReport(reportPath, report)
  }

  return { exitCode, reportPath, report, snapshot }
}

export const runCheckup = async (inputOptions = {}) => {
  const options = { ...parseArguments([]), ...inputOptions }
  const lifecycle = createSignalLifecycle(options.abortSignal)

  try {
    return await runCheckupSession(options, lifecycle)
  } catch (error) {
    const failureDigest = createHash('sha256')
      .update(`setup-failure\0${options.mode}\0${options.subjectRoot}`)
      .digest('hex')
    const sessionId = `setup-${sessionIdFor(failureDigest)}`
    const reportPath = join(options.outputDir, `${sessionId}.json`)
    const report = newCheckupReport({
      sessionId,
      driverDigest: createHash('sha256').update('driver-unavailable').digest('hex'),
      subject: {
        mode: options.mode,
        sourceDigest: null,
        gitHead: null,
        dirty: null,
      },
      snapshot: {
        capability: 'unavailable',
        reason: lifecycle.interruptedSignal ? 'setup-interrupted' : 'setup-failed',
        verifiedAfterRun: false,
      },
    })

    report.error = {
      stage: 'setup',
      name: error?.name || 'Error',
      message: error?.message || String(error),
      ...(lifecycle.interruptedSignal ? { signal: lifecycle.interruptedSignal } : {}),
    }
    const exitCode = lifecycle.interruptedSignal ? signalExitCode(lifecycle.interruptedSignal) : 1
    const cleanupErrors = Array.isArray(error?.cleanupErrors) ? error.cleanupErrors.map(String) : []

    finishCheckupReport(report, { exitCode, cleanupErrors })
    await mkdir(options.outputDir, { recursive: true })
    await writeCheckupReport(reportPath, report)

    return { exitCode, reportPath, report, snapshot: null }
  } finally {
    lifecycle.dispose()
  }
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  const result = await runCheckup(options)

  console.log(
    JSON.stringify({
      sessionId: result.report.sessionId,
      report: result.reportPath,
      sourceDigest: result.report.subject.sourceDigest,
      verdict: result.report.verdict,
    }),
  )
  process.exitCode = result.exitCode
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
