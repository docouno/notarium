#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { expandCpuList } from './profile.mjs'

const BUILDER_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/u
const CPU_SET = /^\d+(?:[-,]\d+)*$/u
export const CI_BUILDKIT_IMAGE =
  'moby/buildkit:buildx-stable-1@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8'

/** @typedef {{ status?: number | null, signal?: NodeJS.Signals | null, stdout?: string, stderr?: string, error?: Error }} CommandResult */

const defaultRun = (args, { quiet = false } = {}) =>
  spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

const failure = (result, label) => {
  if (result.error) {
    return `${label}: ${result.error.message}`
  }
  if (result.signal) {
    return `${label}: terminated by ${result.signal}`
  }
  if (result.status !== 0) {
    return `${label}: exited ${result.status}${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ''}`
  }

  return null
}

const requireSuccess = (result, label) => {
  const error = failure(result, label)

  if (error) {
    throw new Error(error)
  }

  return result
}

export const ciBuilderContainerName = (name) => `buildx_buildkit_${name}0`

export const ciBuilderContextName = (name) => {
  if (!BUILDER_NAME.test(name)) {
    throw new Error(`invalid CI Docker context owner ${JSON.stringify(name)}`)
  }

  // Every Docker context implicitly owns a same-named context builder, so the custom
  // docker-container builder must use a distinct name even though both resources have
  // the same job owner.
  return `ctx-${name}`
}

export const ciBuilderContextCreateArgs = (name) => {
  // With GitLab dind the current endpoint and its client certificates exist only in
  // DOCKER_HOST/DOCKER_TLS_*. Buildx deliberately refuses to persist that ephemeral
  // TLS material in a builder. Docker context create is the supported bridge: it
  // snapshots the current endpoint into this job's isolated Docker config.
  return ['context', 'create', ciBuilderContextName(name)]
}

export const ciBuilderCpuSet = (value) => {
  if (!CPU_SET.test(value)) {
    throw new Error(`invalid CI BuildKit CPU set ${JSON.stringify(value)}`)
  }
  const cpus = expandCpuList(value).sort((left, right) => left - right)
  const ranges = []

  for (const cpu of cpus) {
    const current = ranges.at(-1)

    if (current && cpu === current.end + 1) {
      current.end = cpu
    } else if (!current || cpu !== current.end) {
      ranges.push({ start: cpu, end: cpu })
    }
  }

  return ranges
    .map(({ start, end }) => (start === end ? String(start) : `${start}-${end}`))
    .join(',')
}

export const ciBuilderCreateArgs = ({ name, cpuSet }) => {
  if (!BUILDER_NAME.test(name)) {
    throw new Error(`invalid CI BuildKit builder name ${JSON.stringify(name)}`)
  }
  const builderCpuSet = ciBuilderCpuSet(cpuSet)
  // Buildx parses driver options as CSV even when every --driver-opt is a separate
  // argv item. A sparse Docker cpuset therefore needs literal CSV quotes around the
  // complete key/value field; contiguous sets stay in their compact range form.
  const cpuOption = builderCpuSet.includes(',')
    ? `"cpuset-cpus=${builderCpuSet}"`
    : `cpuset-cpus=${builderCpuSet}`

  return [
    'buildx',
    'create',
    '--name',
    name,
    '--driver',
    'docker-container',
    '--driver-opt',
    cpuOption,
    '--driver-opt',
    'default-load=true',
    '--driver-opt',
    `image=${CI_BUILDKIT_IMAGE}`,
    '--bootstrap',
    ciBuilderContextName(name),
  ]
}

const absentCleanupTarget = (result, kind) => {
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`

  return kind === 'builder'
    ? /no builder .* found/iu.test(output)
    : /(?:context .* not found|no context|does not exist)/iu.test(output)
}

/**
 * Docker-in-Docker is a sibling service, so a taskset applied to the job process does
 * not reach BuildKit. This builder is the missing resource boundary: every build step
 * runs inside a builder container constrained to the job's resolved logical CPU half.
 *
 * @param {{ name: string, env?: NodeJS.ProcessEnv, run?: typeof defaultRun }} options
 */
export const createCiDockerBuilder = ({ name, env = process.env, run = defaultRun }) => {
  const cpuSet = env.CHECKUP_CPUSET?.trim() ?? ''

  if (!CPU_SET.test(cpuSet)) {
    throw new Error('CI BuildKit setup requires a resolved CHECKUP_CPUSET')
  }
  requireSuccess(run(ciBuilderContextCreateArgs(name)), `create Docker context ${name}`)
  try {
    requireSuccess(run(ciBuilderCreateArgs({ name, cpuSet })), `create BuildKit builder ${name}`)
    const inspected = requireSuccess(
      run(
        [
          '--context',
          ciBuilderContextName(name),
          'container',
          'inspect',
          ciBuilderContainerName(name),
          '--format',
          '{{.HostConfig.CpusetCpus}}',
        ],
        { quiet: true },
      ),
      `inspect BuildKit builder ${name}`,
    )
    const actual = inspected.stdout?.trim() ?? ''

    if (ciBuilderCpuSet(actual) !== ciBuilderCpuSet(cpuSet)) {
      throw new Error(
        `BuildKit builder ${name} CPU set mismatch: ${actual || 'missing'} != ${cpuSet}`,
      )
    }
    console.error(`checkup-buildkit ${JSON.stringify({ builder: name, cpuSet: actual })}`)

    return { name, cpuSet: actual }
  } catch (error) {
    try {
      removeCiDockerBuilder({ name, run })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `CI BuildKit builder ${name} setup and cleanup both failed`,
      )
    }
    throw error
  }
}

/** @param {{ name: string, run?: typeof defaultRun }} options */
export const removeCiDockerBuilder = ({ name, run = defaultRun }) => {
  if (!BUILDER_NAME.test(name)) {
    throw new Error(`invalid CI BuildKit builder name ${JSON.stringify(name)}`)
  }

  const targets = [
    {
      kind: 'builder',
      result: run(['buildx', 'rm', name], { quiet: true }),
      label: `remove BuildKit builder ${name}`,
    },
    {
      kind: 'context',
      result: run(['context', 'rm', ciBuilderContextName(name)], { quiet: true }),
      label: `remove Docker context ${ciBuilderContextName(name)}`,
    },
  ]
  const errors = targets.flatMap(({ kind, result, label }) => {
    const detail = failure(result, label)

    return detail && !absentCleanupTarget(result, kind) ? [detail] : []
  })

  if (errors.length) {
    throw new Error(errors.join('\n'))
  }

  return { name }
}

const parseName = (argv) => {
  if (argv[0] !== '--name' || !argv[1] || argv.length !== 2) {
    throw new Error('usage: ciDockerBuilder.mjs <create|remove> --name <builder>')
  }

  return argv[1]
}

const main = () => {
  const command = process.argv[2]
  const name = parseName(process.argv.slice(3))

  if (command === 'create') {
    createCiDockerBuilder({ name })
    return
  }
  if (command === 'remove') {
    removeCiDockerBuilder({ name })
    return
  }

  throw new Error('usage: ciDockerBuilder.mjs <create|remove> --name <builder>')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
