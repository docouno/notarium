#!/usr/bin/env node
// One lockstep product version. Prepare names the next line without claiming a
// release; the final mode folds the Changelog, commits and tags that prepared tree.
// canon: docs/release.md#cutting-a-release
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  bumpProductVersion,
  compareProductVersions,
  foldUnreleased,
  parseProductVersion,
} from './releaseIdentity.mjs'

export const defaultReleaseRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const systemCommand = (command, args, { cwd, stdio = 'pipe' }) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  }) ?? ''

const normalizedRelativePath = (value) => value.replaceAll('\\', '/')

const trackedInputs = (root, command) => {
  const output = command(
    'git',
    [
      'ls-files',
      '-z',
      '--',
      'package.json',
      'packages/*/package.json',
      'package-lock.json',
      'CHANGELOG.md',
    ],
    { cwd: root },
  )
  const tracked = output.split('\0').filter(Boolean).map(normalizedRelativePath)
  const manifests = tracked
    .filter((path) => path === 'package.json' || /^packages\/[^/]+\/package\.json$/.test(path))
    .sort((left, right) => {
      if (left === 'package.json') {
        return -1
      }
      if (right === 'package.json') {
        return 1
      }

      return left.localeCompare(right)
    })

  if (!manifests.includes('package.json')) {
    throw new Error('release root package.json is not tracked')
  }
  if (!tracked.includes('package-lock.json')) {
    throw new Error('release package-lock.json is not tracked')
  }

  return {
    manifests,
    lockfile: 'package-lock.json',
    changelog: tracked.includes('CHANGELOG.md') ? 'CHANGELOG.md' : null,
  }
}

const parsedJson = (bytes, path) => {
  try {
    return JSON.parse(bytes)
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error })
  }
}

const versionState = (root, inputs) => {
  const manifests = inputs.manifests.map((path) => {
    const bytes = readFileSync(join(root, path), 'utf8')
    const json = parsedJson(bytes, path)

    if (!parseProductVersion(json.version)) {
      throw new Error(`${path} version ${JSON.stringify(json.version)} is not canonical safe x.y.z`)
    }

    return { path, bytes, json, version: json.version }
  })
  const current = manifests[0].version
  const mismatched = manifests.filter(({ version }) => version !== current)

  if (mismatched.length) {
    throw new Error(
      `manifest versions diverge from ${current}: ${mismatched
        .map(({ path, version }) => `${path}=${version}`)
        .join(', ')}`,
    )
  }

  const lockPath = join(root, inputs.lockfile)
  const lockBytes = readFileSync(lockPath, 'utf8')
  const lock = parsedJson(lockBytes, inputs.lockfile)
  const lockVersions = [
    { location: 'package-lock.json#version', version: lock.version },
    { location: 'package-lock.json#packages[""]', version: lock.packages?.['']?.version },
    ...manifests
      .filter(({ path }) => path !== 'package.json')
      .map(({ path }) => {
        const workspace = posix.dirname(path)
        return {
          location: `package-lock.json#packages[${JSON.stringify(workspace)}]`,
          version: lock.packages?.[workspace]?.version,
        }
      }),
  ]
  const lockMismatch = lockVersions.filter(({ version }) => version !== current)

  if (lockMismatch.length) {
    throw new Error(
      `package-lock versions diverge from ${current}: ${lockMismatch
        .map(({ location, version }) => `${location}=${JSON.stringify(version)}`)
        .join(', ')}`,
    )
  }

  return { current, manifests, lock: { path: inputs.lockfile, bytes: lockBytes, json: lock } }
}

const requireCleanTree = (root, command) => {
  const porcelain = command('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
  })
  const dirty = porcelain.split('\n').filter(Boolean)

  if (dirty.length) {
    throw new Error(
      `working tree is not completely clean (${dirty.length} path(s)):\n${dirty.slice(0, 20).join('\n')}`,
    )
  }
}

const originalBytes = (root, paths) =>
  new Map(paths.map((path) => [path, readFileSync(join(root, path))]))

const restoreBytes = (root, originals) => {
  for (const [path, bytes] of originals) {
    writeFileSync(join(root, path), bytes)
  }
}

const writeManifestVersions = (root, state, version) => {
  for (const manifest of state.manifests) {
    writeFileSync(
      join(root, manifest.path),
      `${JSON.stringify({ ...manifest.json, version }, null, 2)}\n`,
    )
  }
}

const refreshLockfile = (root, command) => {
  command('npm', ['install', '--package-lock-only'], { cwd: root, stdio: 'inherit' })
}

const assertVersionWritten = (root, inputs, expected) => {
  const written = versionState(root, inputs)

  if (written.current !== expected) {
    throw new Error(`version verification read ${written.current}, expected ${expected}`)
  }
}

const exactOrRelativeTarget = (current, input) => {
  if (parseProductVersion(input)) {
    return input
  }

  return bumpProductVersion(current, input)
}

const releaseTagExists = (root, command, tag) => {
  try {
    command('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: root })
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.status === 1) {
      return false
    }

    throw new Error(`could not determine whether tag ${tag} exists`, { cause: error })
  }
}

/** Import-safe release orchestration. Tests point it at a temporary repository and
 * inject the command boundary; the CLI below supplies the real process boundary. */
export const runRelease = ({
  args,
  root = defaultReleaseRoot,
  command = systemCommand,
  today = new Date().toISOString().slice(0, 10),
  report = console.log,
}) => {
  const prepare = args[0] === '--prepare'
  const input = prepare ? args[1] : args[0]
  const expectedArgCount = prepare ? 2 : 1

  if (!input || args.length !== expectedArgCount) {
    throw new Error(
      prepare
        ? 'usage: npm run release:prepare -- <x.y.z>'
        : 'usage: npm run release -- <patch|minor|major|x.y.z>',
    )
  }

  requireCleanTree(root, command)
  const inputs = trackedInputs(root, command)
  const state = versionState(root, inputs)
  let target

  if (prepare) {
    if (!parseProductVersion(input)) {
      throw new Error(`prepare target ${JSON.stringify(input)} is not canonical safe x.y.z`)
    }
    if (compareProductVersions(input, state.current) <= 0) {
      throw new Error(`prepare target ${input} must be strictly newer than ${state.current}`)
    }
    target = input
  } else {
    target = exactOrRelativeTarget(state.current, input)

    if (!target) {
      throw new Error(`unknown bump ${JSON.stringify(input)} (use patch|minor|major|x.y.z)`)
    }
  }

  let folded = null

  if (!prepare) {
    if (!inputs.changelog) {
      throw new Error('release CHANGELOG.md is not tracked')
    }
    if (releaseTagExists(root, command, `v${target}`)) {
      throw new Error(`tag v${target} already exists`)
    }
    folded = foldUnreleased(readFileSync(join(root, inputs.changelog), 'utf8'), target, today)

    if (!folded.changelog) {
      throw new Error(folded.reason)
    }
  }

  const mutationPaths = [
    ...inputs.manifests,
    inputs.lockfile,
    ...(prepare ? [] : [inputs.changelog]),
  ]
  const originals = originalBytes(root, mutationPaths)

  try {
    writeManifestVersions(root, state, target)
    if (folded?.changelog) {
      writeFileSync(join(root, inputs.changelog), folded.changelog)
    }
    refreshLockfile(root, command)
    assertVersionWritten(root, inputs, target)
  } catch (error) {
    restoreBytes(root, originals)
    throw error
  }

  if (prepare) {
    report(
      `prepared ${inputs.manifests.length} manifests + package-lock: ${state.current} → ${target}`,
    )
    return { mode: 'prepare', current: state.current, target, manifests: inputs.manifests }
  }

  report(`bumped ${inputs.manifests.length} manifests: ${state.current} → ${target}`)
  report(`folded CHANGELOG [Unreleased] → [${target}] — ${today}`)
  command('git', ['add', '--', ...mutationPaths], { cwd: root, stdio: 'inherit' })
  command('git', ['commit', '-m', `chore(release): v${target}`], {
    cwd: root,
    stdio: 'inherit',
  })
  command('git', ['tag', '-a', `v${target}`, '-m', `v${target}`], {
    cwd: root,
    stdio: 'inherit',
  })
  report(`\ntagged v${target}. push with:\n  git push && git push origin v${target}`)

  return { mode: 'release', current: state.current, target, manifests: inputs.manifests }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  try {
    runRelease({ args: process.argv.slice(2) })
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
