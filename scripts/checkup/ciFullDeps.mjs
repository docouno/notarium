#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { copyContainerSupport } from './containerSupport.mjs'
import { containerProfileArgs } from './heavy.mjs'

const docker = (args, { stdio = 'inherit' } = {}) =>
  spawnSync(process.env.CHECKUP_DOCKER_BIN || 'docker', args, {
    encoding: 'utf8',
    stdio,
  })

const requireSuccess = (result, command) => {
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.status}`)
  }
}

const parseArguments = (argv) => {
  const options = { image: '', container: '' }
  const args = [...argv]

  while (args.length) {
    const flag = args.shift()
    const value = args.shift()

    if (flag === '--image') {
      options.image = value
    } else if (flag === '--container') {
      options.container = value
    } else {
      throw new Error(`unknown CI full-deps argument: ${flag}`)
    }
  }
  if (!options.image || !options.container) {
    throw new Error('CI full-deps runner requires --image and --container')
  }

  return options
}

export const runCiFullDeps = async ({
  image,
  container,
  cwd = process.cwd(),
  env = process.env,
}) => {
  requireSuccess(
    docker([
      'create',
      '--name',
      container,
      ...containerProfileArgs(env),
      '--env',
      'CI=1',
      '--entrypoint',
      'npm',
      image,
      'run',
      'test:full-deps',
    ]),
    'docker create full-deps runner',
  )
  await copyContainerSupport({ container, sourceRoot: cwd, docker })

  const test = docker(['start', '--attach', container])

  if (test.signal) {
    return { exitCode: null, signal: test.signal }
  }

  return { exitCode: test.status ?? 1, signal: null }
}

const main = async () => {
  const result = await runCiFullDeps(parseArguments(process.argv.slice(2)))

  if (result.signal) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.exitCode
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
