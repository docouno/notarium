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

// Shares address positions in the process's allowed CPU set, never host CPU ids. The
// same plan therefore fills a 4-, 8- or 16-CPU cgroup without changing repo config.
const lane = (startShare, endShare, options = {}) =>
  Object.freeze({ startShare, endShare, ...options })

export const CHECKUP_RESOURCE_PLANS = Object.freeze({
  'local-static': Object.freeze({
    lanes: Object.freeze({
      static: lane(0, 1),
      'write-performance': lane(0, 1),
    }),
  }),
  'local-isolated': Object.freeze({
    lanes: Object.freeze({
      unit: lane(0, 1, { vitestWorkerShare: 0.75, coverageWorkerShare: 0.75 }),
      coverage: lane(0, 1, { vitestWorkerShare: 0.75, coverageWorkerShare: 0.75 }),
    }),
  }),
  'local-heavy': Object.freeze({
    minimumCpu: 2,
    lanes: Object.freeze({
      postgres: lane(0, 0.5),
      browser: lane(0.5, 1, { playwrightWorkerShare: 0.5, playwrightWorkersMax: 3 }),
    }),
  }),
  'ci-lean-wave1': Object.freeze({
    affinity: 'required',
    minimumCpu: 2,
    lanes: Object.freeze({
      coverage: lane(0, 0.5),
      static: lane(0.5, 1),
    }),
  }),
  'ci-lean-wave2': Object.freeze({
    affinity: 'required',
    minimumCpu: 2,
    lanes: Object.freeze({
      coverage: lane(0, 0.5),
      build: lane(0.5, 1),
    }),
  }),
  'ci-extended-wave1': Object.freeze({
    affinity: 'required',
    minimumCpu: 4,
    lanes: Object.freeze({
      coverage: lane(0, 0.5),
      wave: lane(0.5, 1),
      postgres: lane(0.5, 0.75),
      visual: lane(0.75, 1, { playwrightWorkers: 1 }),
    }),
  }),
  'ci-extended-wave2': Object.freeze({
    affinity: 'required',
    minimumCpu: 2,
    lanes: Object.freeze({
      coverage: lane(0, 0.5),
      browser: lane(0.5, 1, { playwrightWorkerShare: 0.5, playwrightWorkersMax: 3 }),
    }),
  }),
  'ci-heavy-tail': Object.freeze({
    affinity: 'required',
    minimumCpu: 2,
    lanes: Object.freeze({
      backup: lane(0, 0.5),
      release: lane(0, 0.5),
    }),
  }),
})

const DEFAULT_PLAN_FOR_LANE = Object.freeze({
  unit: 'local-isolated',
  coverage: 'local-isolated',
  static: 'local-static',
  'write-performance': 'local-static',
  postgres: 'local-heavy',
  browser: 'local-heavy',
})

const override = (env, name, fallback) => positiveInteger(env[name], fallback, name)

const scaledSlice = ({ startShare, endShare }, availableCpu) => {
  const start = Math.floor(startShare * availableCpu)
  const end = Math.floor(endShare * availableCpu)

  return { offset: start, count: end - start }
}

/**
 * @param {{ plan?: string, lane?: string, availableCpu?: number }} [options]
 */
export const resolveResourceAllocation = ({
  plan: planName,
  lane: laneName,
  availableCpu = availableParallelism(),
} = {}) => {
  if (!Number.isSafeInteger(availableCpu) || availableCpu < 1) {
    throw new Error(`runtime reported invalid available CPU count ${availableCpu}`)
  }
  const plan = CHECKUP_RESOURCE_PLANS[planName]

  if (!plan) {
    throw new Error(`unknown checkup resource plan ${JSON.stringify(planName)}`)
  }
  const requested = plan.lanes[laneName]

  if (!requested) {
    throw new Error(`checkup resource plan ${planName} has no lane ${JSON.stringify(laneName)}`)
  }
  if (availableCpu < (plan.minimumCpu ?? 1)) {
    throw new Error(
      `checkup resource plan ${planName} requires at least ${plan.minimumCpu} CPU(s), got ${availableCpu}`,
    )
  }
  const effective = scaledSlice(requested, availableCpu)

  if (effective.count < 1) {
    throw new Error(
      `checkup resource lane ${planName}/${laneName} is empty at ${availableCpu} available CPU(s)`,
    )
  }

  if (effective.offset + effective.count > availableCpu) {
    throw new Error(
      `checkup resource lane ${planName}/${laneName} exceeds ${availableCpu} available CPU(s)`,
    )
  }

  return {
    plan: planName,
    lane: laneName,
    capacity: availableCpu,
    requested,
    effective,
  }
}

const scaledWorkers = (allocatedCpu, share, maximum = allocatedCpu) =>
  Math.max(1, Math.min(allocatedCpu, maximum, Math.floor(allocatedCpu * share)))

export const resolveCheckupProfile = ({
  env = process.env,
  availableCpu = availableParallelism(),
} = {}) => {
  const planName = env.CHECKUP_RESOURCE_PLAN
  const laneName = env.CHECKUP_RESOURCE_LANE
  const alreadyResolved = env.CHECKUP_PROFILE_RESOLVED === '1'
  let allocation = null

  if ((planName || laneName) && !(planName && laneName)) {
    throw new Error('CHECKUP_RESOURCE_PLAN and CHECKUP_RESOURCE_LANE must be set together')
  }
  if (planName && laneName && !alreadyResolved) {
    allocation = resolveResourceAllocation({ plan: planName, lane: laneName, availableCpu })
  }
  const allocatedCpu = allocation?.effective.count
  const requestedLane = allocation?.requested
  const cpuCeiling = override(
    env,
    'CHECKUP_CPU_CEILING',
    allocatedCpu ?? COMMITTED_CHECKUP_PROFILE.cpuCeiling,
  )
  const vitestWorkers = override(
    env,
    'CHECKUP_VITEST_WORKERS',
    requestedLane?.vitestWorkers ??
      (requestedLane?.vitestWorkerShare && allocatedCpu
        ? scaledWorkers(allocatedCpu, requestedLane.vitestWorkerShare)
        : allocatedCpu) ??
      COMMITTED_CHECKUP_PROFILE.vitestWorkers,
  )
  const coverageProcessingConcurrency = override(
    env,
    'CHECKUP_COVERAGE_CONCURRENCY',
    requestedLane?.coverageProcessingConcurrency ??
      (requestedLane?.coverageWorkerShare && allocatedCpu
        ? scaledWorkers(allocatedCpu, requestedLane.coverageWorkerShare)
        : allocatedCpu) ??
      COMMITTED_CHECKUP_PROFILE.coverageProcessingConcurrency,
  )
  const playwrightWorkers = override(
    env,
    'CHECKUP_PLAYWRIGHT_WORKERS',
    requestedLane?.playwrightWorkers ??
      (requestedLane?.playwrightWorkerShare && allocatedCpu
        ? scaledWorkers(
            allocatedCpu,
            requestedLane.playwrightWorkerShare,
            requestedLane.playwrightWorkersMax,
          )
        : COMMITTED_CHECKUP_PROFILE.playwrightWorkers),
  )

  if (env.CHECKUP_CPU_CEILING !== undefined && cpuCeiling > availableCpu) {
    throw new Error(`CHECKUP_CPU_CEILING=${cpuCeiling} exceeds ${availableCpu} available CPU(s)`)
  }
  if (allocatedCpu !== undefined && cpuCeiling > allocatedCpu) {
    throw new Error(`CHECKUP_CPU_CEILING=${cpuCeiling} exceeds lane allocation ${allocatedCpu}`)
  }
  if (vitestWorkers > cpuCeiling) {
    throw new Error(`CHECKUP_VITEST_WORKERS=${vitestWorkers} exceeds CPU ceiling ${cpuCeiling}`)
  }
  if (coverageProcessingConcurrency > cpuCeiling) {
    throw new Error(
      `CHECKUP_COVERAGE_CONCURRENCY=${coverageProcessingConcurrency} exceeds CPU ceiling ${cpuCeiling}`,
    )
  }
  if (playwrightWorkers > cpuCeiling) {
    throw new Error(
      `CHECKUP_PLAYWRIGHT_WORKERS=${playwrightWorkers} exceeds CPU ceiling ${cpuCeiling}`,
    )
  }
  if (!Number.isSafeInteger(availableCpu) || availableCpu < 1) {
    throw new Error(`runtime reported invalid available CPU count ${availableCpu}`)
  }

  const effectiveCpu = Math.min(cpuCeiling, availableCpu)
  const effectiveWorkers = Math.min(vitestWorkers, effectiveCpu)
  const effectiveCoverageConcurrency = Math.min(coverageProcessingConcurrency, effectiveCpu)

  return {
    resource: planName && laneName ? { plan: planName, lane: laneName, allocation } : null,
    requested: {
      cpuCeiling,
      vitestWorkers,
      coverageProcessingConcurrency,
      playwrightWorkers,
      samplerIntervalMs: COMMITTED_CHECKUP_PROFILE.samplerIntervalMs,
      cpuOffset: allocation?.effective.offset ?? 0,
    },
    availableCpu,
    effective: {
      cpu: effectiveCpu,
      vitestWorkers: effectiveWorkers,
      coverageProcessingConcurrency: effectiveCoverageConcurrency,
      playwrightWorkers: Math.min(playwrightWorkers, effectiveCpu),
      fileParallelism: effectiveWorkers > 1,
      cpuOffset: allocation?.effective.offset ?? 0,
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

export const selectedAffinity = (current, count, offset = 0) => {
  const selected = expandCpuList(current).slice(offset, offset + count)

  if (selected.length !== count) {
    throw new Error(`CPU affinity ${current} cannot provide ${count} CPU(s) at offset ${offset}`)
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

export const requiresCheckupAffinity = (profile, { env = process.env } = {}) =>
  env.CHECKUP_REQUIRE_AFFINITY === '1' ||
  CHECKUP_RESOURCE_PLANS[profile.resource?.plan]?.affinity === 'required'

export const applyCheckupAffinity = (profile, { env = process.env } = {}) => {
  const required = requiresCheckupAffinity(profile, { env })

  if (process.platform !== 'linux') {
    if (required) {
      throw new Error('canonical checkup requires Linux CPU affinity support')
    }

    return { capability: 'unavailable', reason: `platform-${process.platform}` }
  }

  try {
    const before = currentAffinity()
    const selected = selectedAffinity(before, profile.effective.cpu, profile.effective.cpuOffset)
    execFileSync('taskset', ['-pc', selected, String(process.pid)], { stdio: 'ignore' })
    const after = currentAffinity()

    return { capability: 'exact', before, selected, after }
  } catch (error) {
    if (required) {
      throw new Error(`canonical checkup could not apply CPU affinity: ${error.message}`)
    }

    return { capability: 'unavailable', reason: error?.code || error?.message || 'taskset-failed' }
  }
}

const parseArguments = (argv) => {
  const args = [...argv]
  const options = { plan: '', lane: '', command: '', args: [] }

  while (args[0]?.startsWith('--')) {
    const flag = args.shift()
    const value = args.shift()

    if (flag === '--plan') {
      options.plan = value
    } else if (flag === '--lane') {
      options.lane = value
    } else {
      throw new Error(`unknown checkup profile argument: ${flag}`)
    }
  }
  options.command = args.shift() ?? ''
  options.args = args
  if (!options.command) {
    throw new Error('usage: profile.mjs [--plan <name>] [--lane <name>] <command> [args...]')
  }
  if (options.plan && !options.lane) {
    throw new Error('--plan requires --lane')
  }
  if (options.lane && !options.plan) {
    options.plan = process.env.CHECKUP_RESOURCE_PLAN || DEFAULT_PLAN_FOR_LANE[options.lane]
    if (!options.plan) {
      throw new Error(`no default resource plan for lane ${JSON.stringify(options.lane)}`)
    }
  }

  return options
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  const env = {
    ...process.env,
    ...(options.plan ? { CHECKUP_RESOURCE_PLAN: options.plan } : {}),
    ...(options.lane ? { CHECKUP_RESOURCE_LANE: options.lane } : {}),
  }
  const profile = resolveCheckupProfile({ env })
  const affinity = applyCheckupAffinity(profile, { env })
  const childEnv = {
    ...env,
    CHECKUP_PROFILE_RESOLVED: '1',
    CHECKUP_CPU_CEILING: String(profile.effective.cpu),
    CHECKUP_VITEST_WORKERS: String(profile.effective.vitestWorkers),
    CHECKUP_COVERAGE_CONCURRENCY: String(profile.effective.coverageProcessingConcurrency),
    CHECKUP_PLAYWRIGHT_WORKERS: String(profile.effective.playwrightWorkers),
    ...(affinity.capability === 'exact' ? { CHECKUP_CPUSET: affinity.selected } : {}),
  }

  console.error(`checkup-profile ${JSON.stringify({ ...profile, affinity })}`)
  const child = spawn(options.command, options.args, { env: childEnv, stdio: 'inherit' })

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
