import { execFileSync, spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { pathToFileURL } from 'node:url'
import { positiveInteger } from './contract.mjs'

export const COMMITTED_CHECKUP_PROFILE = Object.freeze({
  cpuCeiling: 4,
  vitestWorkers: 4,
  coverageProcessingConcurrency: 4,
  playwrightWorkers: 1,
  samplerIntervalMs: 250,
})

const override = (env, name, fallback) => positiveInteger(env[name], fallback, name)

export const resolveCheckupProfile = ({
  env = process.env,
  availableCpu = availableParallelism(),
} = {}) => {
  const cpuCeiling = override(env, 'CHECKUP_CPU_CEILING', COMMITTED_CHECKUP_PROFILE.cpuCeiling)
  const vitestWorkers = override(
    env,
    'CHECKUP_VITEST_WORKERS',
    COMMITTED_CHECKUP_PROFILE.vitestWorkers,
  )
  const coverageProcessingConcurrency = override(
    env,
    'CHECKUP_COVERAGE_CONCURRENCY',
    COMMITTED_CHECKUP_PROFILE.coverageProcessingConcurrency,
  )

  if (cpuCeiling > COMMITTED_CHECKUP_PROFILE.cpuCeiling) {
    throw new Error(
      `CHECKUP_CPU_CEILING=${cpuCeiling} exceeds the committed ceiling ${COMMITTED_CHECKUP_PROFILE.cpuCeiling}`,
    )
  }
  if (vitestWorkers > cpuCeiling) {
    throw new Error(`CHECKUP_VITEST_WORKERS=${vitestWorkers} exceeds CPU ceiling ${cpuCeiling}`)
  }
  if (coverageProcessingConcurrency > cpuCeiling) {
    throw new Error(
      `CHECKUP_COVERAGE_CONCURRENCY=${coverageProcessingConcurrency} exceeds CPU ceiling ${cpuCeiling}`,
    )
  }
  if (!Number.isSafeInteger(availableCpu) || availableCpu < 1) {
    throw new Error(`runtime reported invalid available CPU count ${availableCpu}`)
  }

  const effectiveCpu = Math.min(cpuCeiling, availableCpu)
  const effectiveWorkers = Math.min(vitestWorkers, effectiveCpu)
  const effectiveCoverageConcurrency = Math.min(coverageProcessingConcurrency, effectiveCpu)

  return {
    requested: {
      cpuCeiling,
      vitestWorkers,
      coverageProcessingConcurrency,
      playwrightWorkers: COMMITTED_CHECKUP_PROFILE.playwrightWorkers,
      samplerIntervalMs: COMMITTED_CHECKUP_PROFILE.samplerIntervalMs,
    },
    availableCpu,
    effective: {
      cpu: effectiveCpu,
      vitestWorkers: effectiveWorkers,
      coverageProcessingConcurrency: effectiveCoverageConcurrency,
      playwrightWorkers: Math.min(COMMITTED_CHECKUP_PROFILE.playwrightWorkers, effectiveCpu),
      fileParallelism: effectiveWorkers > 1,
    },
  }
}

export const expandCpuList = (value) => {
  const cpus = []

  for (const part of value.trim().split(',')) {
    if (/^\d+$/u.test(part)) {
      cpus.push(Number(part))
      continue
    }
    const range = /^(\d+)-(\d+)$/u.exec(part)

    if (!range || Number(range[1]) > Number(range[2])) {
      throw new Error(`cannot parse CPU affinity list ${JSON.stringify(value)}`)
    }
    for (let cpu = Number(range[1]); cpu <= Number(range[2]); cpu += 1) {
      cpus.push(cpu)
    }
  }

  return [...new Set(cpus)]
}

export const selectedAffinity = (current, count) => {
  const selected = expandCpuList(current).slice(0, count)

  if (selected.length !== count) {
    throw new Error(`CPU affinity ${current} cannot provide ${count} CPU(s)`)
  }

  return selected.join(',')
}

const currentAffinity = () => {
  const output = execFileSync('taskset', ['-pc', String(process.pid)], { encoding: 'utf8' })
  const list = output.slice(output.lastIndexOf(':') + 1).trim()

  if (!list) {
    throw new Error(`taskset returned no CPU list: ${output.trim()}`)
  }

  return list
}

export const applyCheckupAffinity = (profile, { env = process.env } = {}) => {
  if (process.platform !== 'linux') {
    if (env.CHECKUP_REQUIRE_AFFINITY === '1') {
      throw new Error('canonical checkup requires Linux CPU affinity support')
    }

    return { capability: 'unavailable', reason: `platform-${process.platform}` }
  }

  try {
    const before = currentAffinity()
    const selected = selectedAffinity(before, profile.effective.cpu)
    execFileSync('taskset', ['-pc', selected, String(process.pid)], { stdio: 'ignore' })
    const after = currentAffinity()

    return { capability: 'exact', before, selected, after }
  } catch (error) {
    if (env.CHECKUP_REQUIRE_AFFINITY === '1') {
      throw new Error(`canonical checkup could not apply CPU affinity: ${error.message}`)
    }

    return { capability: 'unavailable', reason: error?.code || error?.message || 'taskset-failed' }
  }
}

const main = async () => {
  const [command, ...args] = process.argv.slice(2)

  if (!command) {
    console.error('usage: profile.mjs <command> [args...]')
    process.exitCode = 2
    return
  }
  const profile = resolveCheckupProfile()
  const affinity = applyCheckupAffinity(profile)

  console.error(`checkup-profile ${JSON.stringify({ ...profile, affinity })}`)
  const child = spawn(command, args, { env: process.env, stdio: 'inherit' })

  child.once('error', (error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exitCode = code ?? 1
  })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
