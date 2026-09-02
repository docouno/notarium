#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { staticPhasePlan } from './index.mjs'
import { runPhase } from './process.mjs'

const signalExitCode = (signal) => (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)

export const runStaticChecks = async ({
  preset = 'ci-lean',
  cwd = process.cwd(),
  env = process.env,
  output = resolve(cwd, 'test-results/checkup-static.json'),
  signal,
  phaseRunner = runPhase,
} = {}) => {
  const phases = staticPhasePlan({ preset, profiled: false })
  const startedAt = new Date().toISOString()
  const started = process.hrtime.bigint()
  const outcomes = await Promise.allSettled(
    phases.map((phase) => {
      console.error(`static-check: start ${phase.name}`)
      return phaseRunner({
        ...phase,
        cwd,
        env,
        terminationSignal: signal,
      })
    }),
  )
  const results = outcomes.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : {
          name: phases[index].name,
          command: [phases[index].command, ...(phases[index].args ?? [])],
          startedAt,
          endedAt: new Date().toISOString(),
          wallMs: 0,
          exitCode: 1,
          signal: null,
          diagnostics: null,
          error: {
            name: outcome.reason?.name || 'Error',
            message: outcome.reason?.message || String(outcome.reason),
          },
        },
  )
  const endedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    preset,
    startedAt,
    endedAt,
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

const main = async () => {
  const preset = process.argv[2] || 'ci-lean'
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
    const report = await runStaticChecks({ preset, signal: interruption.signal })

    process.exitCode = interrupted
      ? signalExitCode(interrupted)
      : report.verdict === 'passed'
        ? 0
        : 1
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
