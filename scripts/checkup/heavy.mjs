#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { positiveInteger } from './contract.mjs'

const LABELS = (sessionId) => [
  '--label',
  'notarium.checkup.runner=true',
  '--label',
  `notarium.checkup.session=${sessionId}`,
]
const PLAYWRIGHT_CLI = 'node_modules/@playwright/test/cli.js'
const SESSION_LABEL = 'notarium.checkup.session'
const RESOURCE_INSPECT_TIMEOUT_MS = 10_000

const docker = (args, { allowFailure = false, stdio = 'inherit', timeoutMs } = {}) => {
  const result = spawnSync(process.env.CHECKUP_DOCKER_BIN || 'docker', args, {
    encoding: 'utf8',
    stdio,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  })

  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `docker ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.status}`,
    )
  }

  return result
}

export const heavyResourceNames = (env = process.env) => {
  const sessionId = env.CHECKUP_SESSION_ID
  const runner = env.CHECKUP_RUNNER_CONTAINER
  const image = env.CHECKUP_IMAGE

  if (!sessionId || !runner || !image) {
    throw new Error('heavy checkup phase requires CHECKUP_SESSION_ID/RUNNER_CONTAINER/IMAGE')
  }

  return {
    sessionId,
    image,
    coverage: `${runner}-coverage`,
    postgres: `${runner}-postgres`,
    postgresRunner: `${runner}-pg-tests`,
    network: `${runner}-pg-net`,
    browserVolume: `${runner}-browser-workspace`,
    browserSeed: `${runner}-browser-seed`,
    browserDeps: `${runner}-browser-deps`,
    browserBuild: `${runner}-browser-build`,
    browserTests: `${runner}-browser-tests`,
    browserVisual: `${runner}-browser-visual`,
  }
}

const sourceRoot = (env) => resolve(env.CHECKUP_SOURCE_ROOT || process.cwd())

export const containerProfileArgs = (env = process.env) => {
  const required = (name) => {
    const value = positiveInteger(env[name], undefined, name)

    if (value === undefined) {
      throw new Error(`canonical heavy phase requires resolved ${name}`)
    }

    return value
  }
  const values = {
    CHECKUP_CPU_CEILING: required('CHECKUP_CPU_CEILING'),
    CHECKUP_VITEST_WORKERS: required('CHECKUP_VITEST_WORKERS'),
    CHECKUP_COVERAGE_CONCURRENCY: required('CHECKUP_COVERAGE_CONCURRENCY'),
  }

  return [
    ...Object.entries(values).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    '-e',
    'CHECKUP_REQUIRE_AFFINITY=1',
  ]
}

export const resolveDockerImageId = (image) => {
  let inspected = docker(['image', 'inspect', '--format', '{{.Id}}', image], {
    allowFailure: true,
    stdio: 'pipe',
  })

  if (inspected.status !== 0) {
    docker(['pull', image])
    inspected = docker(['image', 'inspect', '--format', '{{.Id}}', image], { stdio: 'pipe' })
  }
  const id = inspected.stdout?.trim()

  if (!/^sha256:[a-f0-9]{64}$/u.test(id ?? '')) {
    throw new Error(`Docker image ${image} resolved to an invalid ID: ${id || 'missing'}`)
  }

  return id
}

const writeEvidence = (env, name, value) => {
  const directory = resolve(env.CHECKUP_ARTIFACT_DIR || 'test-results/checkup-artifacts')

  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `evidence-${name}.json`), `${JSON.stringify(value, null, 2)}\n`)
}

const copyTooling = (container, env = process.env) => {
  const root = sourceRoot(env)

  for (const [input, target] of [
    [join(root, 'Makefile'), '/app/Makefile'],
    [`${join(root, 'scripts')}/.`, '/app/scripts'],
    [join(root, 'README.md'), '/app/README.md'],
  ]) {
    docker(['cp', input, `${container}:${target}`])
  }
}

const resourceContract = {
  container: {
    absent: /No such (?:container|object)/u,
    remove: (names) => ['container', 'rm', '--force', ...names],
  },
  network: {
    absent: /(?:no such network|network .* not found)/iu,
    remove: (names) => ['network', 'rm', ...names],
  },
  volume: {
    absent: /no such volume/iu,
    remove: (names) => ['volume', 'rm', ...names],
  },
  image: {
    absent: /No such (?:image|object)/u,
    remove: (names) => ['image', 'rm', ...names],
  },
}

const inspectResource = ({ kind, name }, timeoutMs) => {
  const contract = resourceContract[kind]
  const result = docker([kind, 'inspect', '--format', '{{json .}}', name], {
    allowFailure: true,
    stdio: 'pipe',
    timeoutMs,
  })

  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${kind} ${name} ownership inspection timed out`)
  }
  if (result.status === 0) {
    let value

    try {
      value = JSON.parse(result.stdout)
    } catch {
      throw new Error(`${kind} ${name} ownership inspection returned invalid JSON`)
    }
    const labels = kind === 'container' || kind === 'image' ? value.Config?.Labels : value.Labels
    const identity = kind === 'volume' ? value.Name : value.Id

    if (!identity) {
      throw new Error(
        `${kind} ${name} ownership inspection returned no ${kind === 'volume' ? 'name' : 'immutable identity'}`,
      )
    }

    return {
      exists: true,
      identity,
      sessionId: labels?.[SESSION_LABEL] ?? '',
    }
  }
  if (contract.absent.test(String(result.stderr ?? result.error?.message ?? ''))) {
    return { exists: false, sessionId: null }
  }
  throw new Error(
    `${kind} ${name} ownership inspection failed: ${result.stderr || result.error || result.status}`,
  )
}

export const captureHeavyResourceOwnership = (
  resource,
  sessionId,
  timeoutMs = RESOURCE_INSPECT_TIMEOUT_MS,
) => {
  const current = inspectResource(resource, timeoutMs)

  if (!current.exists) {
    throw new Error(
      `${resource.kind} ${resource.name} disappeared before ownership could be captured`,
    )
  }
  if (current.sessionId !== sessionId) {
    throw new Error(
      `${resource.kind} ${resource.name} belongs to session ${current.sessionId || 'unlabelled'}`,
    )
  }

  return { ...resource, identity: current.identity, sessionId }
}

export const cleanupHeavyResourceClaims = (resources, timeoutMs = RESOURCE_INSPECT_TIMEOUT_MS) => {
  const cleanupErrors = []

  for (const resource of resources) {
    try {
      const removalTarget =
        resource.kind === 'volume' ? resource : { ...resource, name: resource.identity }
      const current = inspectResource(removalTarget, timeoutMs)

      if (current.exists && current.sessionId !== resource.sessionId) {
        cleanupErrors.push(
          `${resource.kind} ${resource.name} belongs to session ${current.sessionId || 'unlabelled'} and was left untouched`,
        )
        continue
      }
      if (current.exists && resource.kind !== 'volume' && current.identity !== resource.identity) {
        cleanupErrors.push(
          `${resource.kind} ${resource.name} ownership identity changed and was left untouched`,
        )
        continue
      }

      // Docker volumes expose no immutable ID. The session label is therefore
      // re-observed immediately before the only possible, name-addressed remove.
      if (current.exists) {
        const target = resource.kind === 'volume' ? resource.name : resource.identity
        const removed = docker(resourceContract[resource.kind].remove([target]), {
          allowFailure: true,
          stdio: 'pipe',
          timeoutMs,
        })

        if (removed.error?.code === 'ETIMEDOUT') {
          cleanupErrors.push(`${resource.kind} ${resource.name} cleanup timed out`)
        }
      }

      const remaining = inspectResource(resource, timeoutMs)

      if (!remaining.exists) {
        continue
      }
      if (
        remaining.sessionId !== resource.sessionId ||
        (resource.kind !== 'volume' && remaining.identity !== resource.identity)
      ) {
        cleanupErrors.push(
          `${resource.kind} ${resource.name} was replaced during cleanup and was left untouched`,
        )
      } else {
        cleanupErrors.push(`${resource.kind} ${resource.name} still exists after cleanup`)
      }
    } catch (error) {
      cleanupErrors.push(error.message)
    }
  }

  if (cleanupErrors.length) {
    throw new Error(cleanupErrors.join('; '))
  }
}

const phaseCleanupTimeout = (env) =>
  positiveInteger(env.CHECKUP_DOCKER_CLEANUP_MS, 10_000, 'CHECKUP_DOCKER_CLEANUP_MS')

const assertResourcesFree = (resources) => {
  for (const resource of resources) {
    if (inspectResource(resource, RESOURCE_INSPECT_TIMEOUT_MS).exists) {
      throw new Error(
        `checkup refuses to replace existing Docker ${resource.kind} ${resource.name}`,
      )
    }
  }
}

export const runCoverageArtifact = async (env = process.env) => {
  const names = heavyResourceNames(env)
  const artifacts = resolve(env.CHECKUP_ARTIFACT_DIR || 'test-results/checkup-artifacts')
  const coverageArtifacts = resolve(artifacts, 'coverage')
  const source = sourceRoot(env)
  const owned = []

  assertResourcesFree([
    { kind: 'container', name: names.coverage },
    { kind: 'image', name: names.image },
  ])
  await mkdir(coverageArtifacts, { recursive: true })
  docker([
    'build',
    '--target',
    'test',
    '--label',
    `${SESSION_LABEL}=${names.sessionId}`,
    '-t',
    names.image,
    '-f',
    join(source, 'docker/Dockerfile'),
    source,
  ])
  try {
    docker([
      'create',
      '--name',
      names.coverage,
      ...LABELS(names.sessionId),
      ...containerProfileArgs(env),
      '--entrypoint',
      'npm',
      names.image,
      'run',
      'test:coverage',
    ])
    owned.push(
      captureHeavyResourceOwnership({ kind: 'container', name: names.coverage }, names.sessionId),
    )
    copyTooling(names.coverage, env)
    const test = docker(['start', '--attach', names.coverage], { allowFailure: true })
    const copied = docker(['cp', `${names.coverage}:/app/coverage/.`, coverageArtifacts], {
      allowFailure: true,
      stdio: 'pipe',
    })

    writeEvidence(env, 'coverage', {
      sourceCopies: 0,
      dependencyInstalls: 1,
      productionBuilds: 1,
      coverageRuns: 1,
      image: names.image,
      artifactCopied: copied.status === 0,
    })
    if (copied.status !== 0) {
      console.error(
        `checkup coverage artifact extraction failed: ${copied.stderr || copied.status}`,
      )
    }
    if (test.signal) {
      return { exitCode: null, signal: test.signal, artifactCopied: copied.status === 0 }
    }

    return {
      exitCode: test.status === 0 && copied.status !== 0 ? 2 : (test.status ?? 1),
      signal: null,
      artifactCopied: copied.status === 0,
    }
  } finally {
    cleanupHeavyResourceClaims(owned, phaseCleanupTimeout(env))
  }
}

const waitForPostgres = (name) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = docker(
      [
        'inspect',
        '--format',
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}',
        name,
      ],
      { allowFailure: true, stdio: 'pipe' },
    ).stdout?.trim()

    if (state === 'healthy') {
      return
    }
    if (state === 'unhealthy') {
      throw new Error('checkup PostgreSQL service became unhealthy')
    }
    spawnSync('sleep', ['1'])
  }

  throw new Error('checkup PostgreSQL service did not become healthy')
}

export const runPostgresFromCoverage = (env = process.env) => {
  const names = heavyResourceNames(env)
  const owned = []

  assertResourcesFree([
    { kind: 'container', name: names.postgres },
    { kind: 'container', name: names.postgresRunner },
    { kind: 'network', name: names.network },
  ])
  try {
    docker([
      'network',
      'create',
      '--label',
      `notarium.checkup.session=${names.sessionId}`,
      names.network,
    ])
    owned.push(
      captureHeavyResourceOwnership({ kind: 'network', name: names.network }, names.sessionId),
    )
    docker([
      'run',
      '-d',
      '--name',
      names.postgres,
      ...LABELS(names.sessionId),
      '--network',
      names.network,
      '--network-alias',
      'postgres',
      '--health-cmd',
      'pg_isready -U notarium -d notarium_test',
      '--health-interval',
      '1s',
      '--health-timeout',
      '3s',
      '--health-retries',
      '60',
      '-e',
      'POSTGRES_USER=notarium',
      '-e',
      'POSTGRES_PASSWORD=notarium',
      '-e',
      'POSTGRES_DB=notarium_test',
      'postgres:16-alpine',
    ])
    owned.push(
      captureHeavyResourceOwnership({ kind: 'container', name: names.postgres }, names.sessionId),
    )
    waitForPostgres(names.postgres)
    docker([
      'create',
      '--name',
      names.postgresRunner,
      ...LABELS(names.sessionId),
      '--network',
      names.network,
      ...containerProfileArgs(env),
      '-e',
      'HOME=/tmp',
      '-e',
      'TEST_PG_URL=postgres://notarium:notarium@postgres:5432/notarium_test',
      '--entrypoint',
      'npm',
      names.image,
      'run',
      'test:pg',
    ])
    owned.push(
      captureHeavyResourceOwnership(
        { kind: 'container', name: names.postgresRunner },
        names.sessionId,
      ),
    )
    copyTooling(names.postgresRunner, env)
    const test = docker(['start', '--attach', names.postgresRunner], { allowFailure: true })

    writeEvidence(env, 'postgres', {
      sourceCopies: 0,
      dependencyInstalls: 0,
      builds: 0,
      postgresRuns: 1,
      reusedImage: names.image,
    })

    if (test.signal) {
      return { exitCode: null, signal: test.signal }
    }

    return { exitCode: test.status ?? 1, signal: null }
  } finally {
    cleanupHeavyResourceClaims([...owned].reverse(), phaseCleanupTimeout(env))
  }
}

const startAndRemove = (resource, cleanupTimeoutMs) => {
  try {
    return docker(['start', '--attach', resource.name], { allowFailure: true })
  } finally {
    cleanupHeavyResourceClaims([resource], cleanupTimeoutMs)
  }
}

const extractContainerPath = async (container, source, destination) => {
  await mkdir(destination, { recursive: true })

  return docker(['cp', `${container}:${source}/.`, destination], {
    allowFailure: true,
    stdio: 'pipe',
  })
}

const hasVisualBaselines = async (root) => {
  try {
    return (await readdir(join(root, 'test/visual/visual.spec.ts-snapshots'))).some((name) =>
      name.endsWith('.png'),
    )
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export const runBrowserWorkspace = async (env = process.env) => {
  const names = heavyResourceNames(env)
  const source = sourceRoot(env)
  const playwrightImageTag =
    env.CHECKUP_PLAYWRIGHT_IMAGE || 'mcr.microsoft.com/playwright:v1.60.0-jammy'
  const playwrightImage = resolveDockerImageId(playwrightImageTag)
  const artifacts = resolve(env.CHECKUP_ARTIFACT_DIR || 'test-results/checkup-artifacts', 'browser')
  const containers = [
    names.browserSeed,
    names.browserDeps,
    names.browserBuild,
    names.browserTests,
    names.browserVisual,
  ]
  const browserScope = env.CHECKUP_BROWSER_SCOPE || 'full'
  const realStress = browserScope === 'real-stress'
  const fakeStress = browserScope === 'fake-stress'
  const stressRuns = env.CHECKUP_BROWSER_RUNS || '3'
  const cleanupTimeoutMs = phaseCleanupTimeout(env)
  const owned = []

  const capture = (kind, name) => {
    const resource = captureHeavyResourceOwnership({ kind, name }, names.sessionId)

    owned.push(resource)
    return resource
  }

  if (!['full', 'real-stress', 'fake-stress'].includes(browserScope)) {
    throw new Error(`unknown CHECKUP_BROWSER_SCOPE ${browserScope}`)
  }
  if (realStress && !/^[1-9]\d*$/u.test(stressRuns)) {
    throw new Error(`CHECKUP_BROWSER_RUNS must be a positive integer, got ${stressRuns}`)
  }
  assertResourcesFree([
    ...containers.map((name) => ({ kind: 'container', name })),
    { kind: 'volume', name: names.browserVolume },
  ])
  try {
    await mkdir(artifacts, { recursive: true })
    docker([
      'volume',
      'create',
      '--label',
      `notarium.checkup.session=${names.sessionId}`,
      names.browserVolume,
    ])
    capture('volume', names.browserVolume)
    docker([
      'create',
      '--name',
      names.browserSeed,
      ...LABELS(names.sessionId),
      '--mount',
      `type=volume,src=${names.browserVolume},dst=/app`,
      '--entrypoint',
      'true',
      'node:24-slim',
    ])
    const seed = capture('container', names.browserSeed)

    try {
      docker(['cp', `${source}/.`, `${names.browserSeed}:/app`])
    } finally {
      cleanupHeavyResourceClaims([seed], cleanupTimeoutMs)
    }

    const install = `set -eu
pinned_npm="$(node -p "(/^npm@([0-9]+[.][0-9]+[.][0-9]+([-][0-9A-Za-z.-]+)?)([+].*)?$/.exec(require('./package.json').packageManager)||[,''])[1]")"
[ -n "$pinned_npm" ] || { echo 'package.json packageManager must be npm@<x.y.z>' >&2; exit 1; }
npm i -g "npm@$pinned_npm"
npm -v
npm run deps:lean`
    docker([
      'create',
      '--name',
      names.browserDeps,
      ...LABELS(names.sessionId),
      '--mount',
      `type=volume,src=${names.browserVolume},dst=/app`,
      '--workdir',
      '/app',
      '-e',
      'HOME=/tmp',
      '--entrypoint',
      'sh',
      playwrightImage,
      '-c',
      install,
    ])
    const dependencies = startAndRemove(capture('container', names.browserDeps), cleanupTimeoutMs)

    if (dependencies.status !== 0) {
      writeEvidence(env, 'browser', { dependencyInstalls: 1, pwaOffBuilds: 0 })
      return { exitCode: dependencies.status ?? 1, signal: dependencies.signal }
    }

    docker([
      'create',
      '--name',
      names.browserBuild,
      ...LABELS(names.sessionId),
      '--mount',
      `type=volume,src=${names.browserVolume},dst=/app`,
      '--workdir',
      '/app',
      '-e',
      'HOME=/tmp',
      '-e',
      'VITE_PWA=off',
      '-e',
      `CHECKUP_SUBJECT_DIGEST=${env.CHECKUP_SUBJECT_DIGEST}`,
      '-e',
      `CHECKUP_PLAYWRIGHT_IMAGE=${playwrightImage}`,
      '--entrypoint',
      'sh',
      playwrightImage,
      '-c',
      'npm run build -w @notarium/web && node scripts/checkup/browserArtifact.mjs write',
    ])
    const build = startAndRemove(capture('container', names.browserBuild), cleanupTimeoutMs)

    if (build.status !== 0) {
      writeEvidence(env, 'browser', { dependencyInstalls: 1, pwaOffBuilds: 1 })
      return { exitCode: build.status ?? 1, signal: build.signal }
    }

    docker([
      'create',
      '--name',
      names.browserTests,
      ...LABELS(names.sessionId),
      '--mount',
      `type=volume,src=${names.browserVolume},dst=/app`,
      '--workdir',
      '/app',
      '--ipc',
      'host',
      '-e',
      'HOME=/tmp',
      '-e',
      'CI=1',
      '-e',
      'PLAYWRIGHT_PREBUILT=1',
      '-e',
      `CHECKUP_SUBJECT_DIGEST=${env.CHECKUP_SUBJECT_DIGEST}`,
      '-e',
      `CHECKUP_PLAYWRIGHT_IMAGE=${playwrightImage}`,
      '--entrypoint',
      realStress ? 'sh' : fakeStress ? 'node' : 'npm',
      playwrightImage,
      ...(realStress
        ? [
            '-c',
            `set -eu; run=1; while [ "$run" -le ${stressRuns} ]; do echo "real-stress: run $run/${stressRuns}"; node --no-maglev ${PLAYWRIGHT_CLI} test -c playwright.real.config.ts --retries=0; run=$((run + 1)); done`,
          ]
        : fakeStress
          ? [
              '--no-maglev',
              PLAYWRIGHT_CLI,
              'test',
              'test/e2e/spotlight.spec.ts',
              'test/e2e/trash-glass.spec.ts',
              'test/e2e/editor-list-continuation.spec.ts',
              '--workers=1',
              '--retries=0',
              '--repeat-each=20',
            ]
          : ['run', 'e2e']),
    ])
    const browserTests = capture('container', names.browserTests)
    const e2e = docker(['start', '--attach', names.browserTests], { allowFailure: true })

    await extractContainerPath(
      names.browserTests,
      '/app/playwright-report',
      join(artifacts, 'e2e-report'),
    )
    await extractContainerPath(
      names.browserTests,
      '/app/test-results',
      join(artifacts, 'e2e-results'),
    )
    cleanupHeavyResourceClaims([browserTests], cleanupTimeoutMs)
    writeEvidence(env, 'browser', {
      sourceCopies: 1,
      dependencyInstalls: 1,
      pwaOffBuilds: 1,
      fakeRebuilds: 0,
      realRebuilds: 0,
      visualRebuilds: 0,
      browserScope,
      nodeRuntime: 'maglev-disabled',
      playwrightImage: { source: playwrightImageTag, id: playwrightImage },
    })
    if (e2e.status !== 0 || e2e.signal) {
      return { exitCode: e2e.status ?? 1, signal: e2e.signal }
    }

    if (realStress || fakeStress) {
      return { exitCode: 0, signal: null, visual: 'not-requested' }
    }

    if (!(await hasVisualBaselines(source))) {
      console.error('checkup browser: visual skipped — external baselines are not present')
      return { exitCode: 0, signal: null, visual: 'skipped' }
    }

    docker([
      'create',
      '--name',
      names.browserVisual,
      ...LABELS(names.sessionId),
      '--mount',
      `type=volume,src=${names.browserVolume},dst=/app`,
      '--workdir',
      '/app',
      '--ipc',
      'host',
      '-e',
      'HOME=/tmp',
      '-e',
      'CI=1',
      '-e',
      'PLAYWRIGHT_PREBUILT=1',
      '-e',
      `CHECKUP_SUBJECT_DIGEST=${env.CHECKUP_SUBJECT_DIGEST}`,
      '-e',
      `CHECKUP_PLAYWRIGHT_IMAGE=${playwrightImage}`,
      '--entrypoint',
      'node',
      playwrightImage,
      '--no-maglev',
      PLAYWRIGHT_CLI,
      'test',
      'test/visual',
    ])
    const browserVisual = capture('container', names.browserVisual)
    const visual = docker(['start', '--attach', names.browserVisual], { allowFailure: true })

    await extractContainerPath(
      names.browserVisual,
      '/app/playwright-report',
      join(artifacts, 'visual-report'),
    )
    await extractContainerPath(
      names.browserVisual,
      '/app/test-results',
      join(artifacts, 'visual-results'),
    )
    cleanupHeavyResourceClaims([browserVisual], cleanupTimeoutMs)

    return { exitCode: visual.status ?? 1, signal: visual.signal, visual: 'run' }
  } finally {
    cleanupHeavyResourceClaims([...owned].reverse(), cleanupTimeoutMs)
  }
}

export const cleanupHeavyResources = (env = process.env) => {
  const names = heavyResourceNames(env)
  const cleanupTimeoutMs = positiveInteger(
    env.CHECKUP_DOCKER_CLEANUP_MS,
    10_000,
    'CHECKUP_DOCKER_CLEANUP_MS',
  )
  const resources = [
    ...[
      names.coverage,
      names.postgresRunner,
      names.postgres,
      names.browserSeed,
      names.browserDeps,
      names.browserBuild,
      names.browserTests,
      names.browserVisual,
    ].map((name) => ({ kind: 'container', name })),
    { kind: 'network', name: names.network },
    { kind: 'volume', name: names.browserVolume },
    { kind: 'image', name: names.image },
  ]
  const cleanupErrors = []
  const owned = []

  for (const resource of resources) {
    try {
      const current = inspectResource(resource, cleanupTimeoutMs)

      if (!current.exists) {
        continue
      }
      if (current.sessionId !== names.sessionId) {
        cleanupErrors.push(
          `${resource.kind} ${resource.name} belongs to session ${current.sessionId || 'unlabelled'}`,
        )
        continue
      }
      owned.push({
        ...resource,
        identity: current.identity,
        sessionId: names.sessionId,
      })
    } catch (error) {
      cleanupErrors.push(error.message)
    }
  }

  try {
    cleanupHeavyResourceClaims(owned, cleanupTimeoutMs)
  } catch (error) {
    cleanupErrors.push(error.message)
  }

  if (cleanupErrors.length) {
    throw new Error(cleanupErrors.join('; '))
  }
}

const main = async () => {
  const command = process.argv[2]
  const result =
    command === 'coverage'
      ? await runCoverageArtifact()
      : command === 'postgres'
        ? runPostgresFromCoverage()
        : command === 'browser'
          ? await runBrowserWorkspace()
          : command === 'cleanup'
            ? (cleanupHeavyResources(), { exitCode: 0, signal: null })
            : null

  if (!result) {
    console.error('usage: heavy.mjs coverage|postgres|browser|cleanup')
    process.exitCode = 2
  } else if (result.signal) {
    process.kill(process.pid, result.signal)
  } else {
    process.exitCode = result.exitCode
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
