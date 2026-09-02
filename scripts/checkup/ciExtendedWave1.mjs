#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runPhase } from './process.mjs'

export const CI_EXTENDED_WAVE1_REPORT = 'test-results/ci-extended-wave1.json'

const signalExitCode = (signal) => (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)

const connectionAttempt = ({ host, port, signal, timeoutMs }) =>
  new Promise((resolveAttempt, rejectAttempt) => {
    const socket = connect(port, host)
    let settled = false

    const finish = (error) => {
      if (settled) {
        return
      }
      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      if (error) {
        rejectAttempt(error)
      } else {
        resolveAttempt()
      }
    }
    const onAbort = () => finish(signal.reason ?? new Error('PostgreSQL readiness aborted'))

    socket.once('connect', () => finish())
    socket.once('error', (error) => finish(error))
    socket.setTimeout(timeoutMs, () =>
      finish(new Error(`PostgreSQL connection attempt timed out at ${host}:${port}`)),
    )
    if (signal?.aborted) {
      onAbort()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }
  })

const abortableDelay = (durationMs, signal) =>
  new Promise((resolveDelay, rejectDelay) => {
    let timer = null

    const finish = (error) => {
      signal?.removeEventListener('abort', onAbort)
      if (timer) {
        clearTimeout(timer)
      }
      if (error) {
        rejectDelay(error)
      } else {
        resolveDelay()
      }
    }
    const onAbort = () => finish(signal.reason ?? new Error('PostgreSQL readiness aborted'))

    timer = setTimeout(() => finish(), durationMs)

    if (signal?.aborted) {
      onAbort()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }
  })

/**
 * @param {{ host?: string, port?: number, timeoutMs?: number, retryMs?: number, signal?: AbortSignal }} [options]
 */
export const waitForPostgres = async ({
  host = 'postgres',
  port = 5432,
  timeoutMs = 60_000,
  retryMs = 500,
  signal,
} = {}) => {
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (!signal?.aborted && Date.now() <= deadline) {
    try {
      await connectionAttempt({
        host,
        port,
        signal,
        timeoutMs: Math.max(1, Math.min(retryMs, deadline - Date.now())),
      })
      return
    } catch (error) {
      lastError = error
    }
    if (!signal?.aborted && Date.now() <= deadline) {
      await abortableDelay(Math.min(retryMs, Math.max(1, deadline - Date.now())), signal)
    }
  }

  if (signal?.aborted) {
    throw signal.reason ?? new Error('PostgreSQL readiness aborted')
  }
  throw new Error(`PostgreSQL never accepted a connection at ${host}:${port}: ${lastError}`)
}

const phases = ({ cwd, env, signal, phaseRunner, readiness }) => {
  const common = { cwd, env, terminationSignal: signal }
  const visual = phaseRunner({
    ...common,
    name: 'visual',
    command: process.execPath,
    args: [
      'scripts/checkup/profile.mjs',
      '--plan',
      'ci-extended-wave1',
      '--lane',
      'visual',
      process.execPath,
      'scripts/checkup/ciVisual.mjs',
    ],
  })
  const postgres = readiness({ signal }).then(() =>
    phaseRunner({
      ...common,
      name: 'postgres',
      command: process.execPath,
      args: [
        'scripts/checkup/profile.mjs',
        '--plan',
        'ci-extended-wave1',
        '--lane',
        'postgres',
        'npm',
        'run',
        'test:pg:lanes',
      ],
    }),
  )

  return [postgres, visual]
}

const rejectedPhase = (name, error, startedAt) => ({
  name,
  command: [],
  startedAt,
  endedAt: new Date().toISOString(),
  wallMs: 0,
  exitCode: 1,
  signal: null,
  diagnostics: null,
  error: { name: error?.name || 'Error', message: error?.message || String(error) },
})

export const runCiExtendedWave1 = async ({
  cwd = process.cwd(),
  env = process.env,
  output = resolve(cwd, CI_EXTENDED_WAVE1_REPORT),
  signal,
  phaseRunner = runPhase,
  readiness = waitForPostgres,
} = {}) => {
  const startedAt = new Date().toISOString()
  const started = process.hrtime.bigint()
  const outcomes = await Promise.allSettled(phases({ cwd, env, signal, phaseRunner, readiness }))
  const results = outcomes.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : rejectedPhase(index === 0 ? 'postgres' : 'visual', outcome.reason, startedAt),
  )
  const report = {
    schemaVersion: 1,
    startedAt,
    endedAt: new Date().toISOString(),
    wallMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    phases: results,
    verdict: results.every((result) => result.exitCode === 0 && result.signal === null)
      ? 'passed'
      : 'failed',
  }

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)

  return report
}

export const validateCiExtendedWave1Report = (report) => {
  if (!report || report.schemaVersion !== 1 || !Array.isArray(report.phases)) {
    throw new Error('CI extended wave report has an invalid envelope')
  }
  const phases = new Map(report.phases.map((phase) => [phase?.name, phase]))

  if (
    report.phases.length !== 2 ||
    phases.size !== 2 ||
    !phases.has('postgres') ||
    !phases.has('visual')
  ) {
    throw new Error('CI extended wave report must contain exactly postgres and visual')
  }
  for (const phase of phases.values()) {
    if (
      (phase.exitCode !== null && !Number.isSafeInteger(phase.exitCode)) ||
      (phase.signal !== null && typeof phase.signal !== 'string')
    ) {
      throw new Error(`CI extended wave phase ${phase.name} has an invalid result`)
    }
  }
  const failed = [...phases.values()].filter(
    (phase) => phase.exitCode !== 0 || phase.signal !== null,
  )
  const verdict = failed.length ? 'failed' : 'passed'

  if (report.verdict !== verdict) {
    throw new Error(`CI extended wave verdict mismatch: ${report.verdict} != ${verdict}`)
  }

  return { verdict, failed }
}

export const readCiExtendedWave1Report = async (
  path = resolve(process.cwd(), CI_EXTENDED_WAVE1_REPORT),
) => validateCiExtendedWave1Report(JSON.parse(await readFile(path, 'utf8')))

const main = async () => {
  const command = process.argv[2] || 'run'

  if (command === 'gate') {
    const result = await readCiExtendedWave1Report()

    for (const phase of result.failed) {
      console.error(
        `extended-wave: ${phase.name} failed (${phase.signal || `exit ${phase.exitCode}`})${phase.error?.message ? `: ${phase.error.message}` : ''}`,
      )
    }
    if (result.verdict === 'passed') {
      console.error('extended-wave: PostgreSQL and visual producers passed')
    }
    process.exitCode = result.verdict === 'passed' ? 0 : 1
    return
  }
  if (command !== 'run') {
    throw new Error('usage: ciExtendedWave1.mjs [run|gate]')
  }
  const interruption = new AbortController()
  let interrupted = null

  const onSignal = (signal) => {
    interrupted ??= signal
    interruption.abort(signal)
  }
  const onSigint = () => onSignal('SIGINT')
  const onSigterm = () => onSignal('SIGTERM')

  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  try {
    await runCiExtendedWave1({ signal: interruption.signal })

    process.exitCode = interrupted ? signalExitCode(interrupted) : 0
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
