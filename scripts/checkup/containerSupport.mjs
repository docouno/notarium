#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CONTAINER_SUPPORT_MANIFEST = Object.freeze([
  Object.freeze({ source: 'Makefile', target: 'Makefile', directory: false }),
  Object.freeze({ source: 'scripts', target: 'scripts', directory: true }),
  Object.freeze({ source: 'README.md', target: 'README.md', directory: false }),
  Object.freeze({ source: 'docker/Dockerfile', target: 'docker/Dockerfile', directory: false }),
  Object.freeze({
    source: 'docker/Dockerfile.dockerignore',
    target: 'docker/Dockerfile.dockerignore',
    directory: false,
  }),
])

/** @typedef {{ source: string, target: string, directory: boolean }} ContainerSupportEntry */
/** @typedef {{ status?: number | null, signal?: NodeJS.Signals | null, error?: Error, stderr?: string | Buffer | null }} DockerResult */

/** @type {(args: string[], options?: { stdio?: import('node:child_process').StdioOptions }) => DockerResult} */
const defaultDocker = (args, { stdio = 'inherit' } = {}) =>
  spawnSync(process.env.CHECKUP_DOCKER_BIN || 'docker', args, {
    encoding: 'utf8',
    stdio,
  })

const inside = (root, path) => {
  const offset = relative(root, path)

  return offset !== '..' && !offset.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}

const checkedPath = (root, value, name) => {
  if (!value || isAbsolute(value)) {
    throw new Error(`container support ${name} must be a non-empty relative path`)
  }
  const path = resolve(root, value)

  if (!inside(root, path)) {
    throw new Error(`container support ${name} escapes its root: ${value}`)
  }

  return path
}

/**
 * @param {{ sourceRoot?: string, manifest?: readonly ContainerSupportEntry[] }} [options]
 */
export const stageContainerSupport = async ({
  sourceRoot = process.cwd(),
  manifest = CONTAINER_SUPPORT_MANIFEST,
} = {}) => {
  const source = resolve(sourceRoot)
  const stageRoot = await mkdtemp(join(tmpdir(), 'notarium-container-support-'))

  try {
    for (const entry of manifest) {
      const input = checkedPath(source, entry.source, 'source')
      const output = checkedPath(stageRoot, entry.target, 'target')

      await mkdir(dirname(output), { recursive: true })
      if (entry.directory) {
        await cp(input, output, { recursive: true, preserveTimestamps: true })
      } else {
        await copyFile(input, output)
      }
    }
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true })
    throw error
  }

  return stageRoot
}

/**
 * @param {{
 *   container?: string,
 *   sourceRoot?: string,
 *   manifest?: readonly ContainerSupportEntry[],
 *   docker?: (args: string[], options?: { stdio?: import('node:child_process').StdioOptions }) => DockerResult,
 * }} [options]
 */
export const copyContainerSupport = async ({
  container,
  sourceRoot = process.cwd(),
  manifest = CONTAINER_SUPPORT_MANIFEST,
  docker = defaultDocker,
} = {}) => {
  if (!container) {
    throw new Error('container support copy requires a container name')
  }
  const stageRoot = await stageContainerSupport({ sourceRoot, manifest })

  try {
    const copied = docker(['cp', `${stageRoot}/.`, `${container}:/app`], { stdio: 'pipe' })

    if (copied.error || copied.status !== 0) {
      throw new Error(
        `docker cp container support failed: ${copied.error?.message || copied.stderr || copied.status}`,
      )
    }
  } finally {
    await rm(stageRoot, { recursive: true, force: true })
  }
}

const parseArguments = (argv) => {
  const [command, ...args] = argv
  const options = { command, container: '', sourceRoot: process.cwd() }

  while (args.length) {
    const flag = args.shift()
    const value = args.shift()

    if (flag === '--container') {
      options.container = value
    } else if (flag === '--source-root') {
      options.sourceRoot = value
    } else {
      throw new Error(`unknown container support argument: ${flag}`)
    }
  }
  if (options.command !== 'copy') {
    throw new Error('usage: containerSupport.mjs copy --container <name> [--source-root <path>]')
  }

  return options
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))

  await copyContainerSupport(options)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
