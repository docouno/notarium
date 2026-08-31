#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveCheckupProfile } from './profile.mjs'

export const GITLAB_COBERTURA_LIMIT_BYTES = 10 * 1024 * 1024
export const COVERAGE_REPORT_PATH = 'coverage/cobertura-coverage.xml'
const COBERTURA_PARSER_PACKAGES = ['saxes', 'xmlchars']

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
      throw new Error(`unknown ci coverage argument: ${flag}`)
    }
  }
  if (!options.image || !options.container) {
    throw new Error('ci coverage requires --image and --container')
  }

  return options
}

const docker = (args, { stdio = 'inherit' } = {}) =>
  spawnSync(process.env.CHECKUP_DOCKER_BIN || 'docker', args, { stdio, encoding: 'utf8' })

const requireSuccess = (result, command) => {
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.status}`)
  }
}

export const coverageProfileArgs = (profile = resolveCheckupProfile()) => [
  '--env',
  `CHECKUP_CPU_CEILING=${profile.effective.cpu}`,
  '--env',
  `CHECKUP_VITEST_WORKERS=${profile.effective.vitestWorkers}`,
  '--env',
  `CHECKUP_COVERAGE_CONCURRENCY=${profile.effective.coverageProcessingConcurrency}`,
  '--env',
  'CHECKUP_REQUIRE_AFFINITY=1',
]

// The dind job deliberately does not install a second host dependency tree: the test
// image already contains the lockfile-owned parser. Copy its two pure-JS packages into
// an ephemeral module root, so strict validation neither repeats npm ci nor relies on a
// transitive package happening to exist in the runner checkout.
const parserFromTestImage = async (container) => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-ci-cobertura-parser-'))
  const modules = join(root, 'node_modules')

  await mkdir(modules)
  try {
    for (const dependency of COBERTURA_PARSER_PACKAGES) {
      const copied = docker(
        ['cp', `${container}:/app/node_modules/${dependency}`, join(modules, dependency)],
        { stdio: 'pipe' },
      )

      requireSuccess(copied, `docker cp Cobertura parser package ${dependency}`)
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }

  return { root, entry: pathToFileURL(join(modules, 'saxes/saxes.js')).href }
}

const copyDockerSupport = async (container) => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-ci-coverage-support-'))
  const support = join(root, 'docker')

  await mkdir(support)
  try {
    await copyFile(
      resolve('docker/Dockerfile.dockerignore'),
      join(support, 'Dockerfile.dockerignore'),
    )
    requireSuccess(
      docker(['cp', support, `${container}:/app`]),
      'docker cp coverage support directory',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export const validateCobertura = async (path, { parserEntry = 'saxes' } = {}) => {
  const metadata = await stat(path)

  if (metadata.size < 1 || metadata.size > GITLAB_COBERTURA_LIMIT_BYTES) {
    throw new Error(
      `Cobertura report must be 1..${GITLAB_COBERTURA_LIMIT_BYTES} bytes, got ${metadata.size}`,
    )
  }
  const xml = await readFile(path, 'utf8')
  const { SaxesParser } = await import(parserEntry)
  const parser = new SaxesParser({ fileName: path })
  const elements = []
  const filenames = []
  let root = null
  let parseError = null
  let hasSources = false
  let hasSource = false
  let hasPackages = false
  let classMissingFilename = false

  parser.on('error', (error) => {
    parseError ??= error
  })
  parser.on('opentag', (tag) => {
    const parent = elements.at(-1)

    if (elements.length === 0 && root === null) {
      root = tag.name
    }
    if (tag.name === 'sources' && parent === 'coverage') {
      hasSources = true
    } else if (tag.name === 'source' && parent === 'sources' && elements.at(-2) === 'coverage') {
      hasSource = true
    } else if (tag.name === 'packages' && parent === 'coverage') {
      hasPackages = true
    } else if (tag.name === 'class' && elements[0] === 'coverage' && elements[1] === 'packages') {
      const filename = tag.attributes.filename

      if (typeof filename === 'string') {
        filenames.push(filename)
      } else {
        classMissingFilename = true
      }
    }
    elements.push(tag.name)
  })
  parser.on('closetag', () => {
    elements.pop()
  })

  try {
    parser.write(xml).close()
  } catch (error) {
    parseError ??= error
  }

  if (parseError) {
    throw new Error(`Cobertura report is not well-formed XML: ${parseError.message}`)
  }
  if (root !== 'coverage' || !hasSources || !hasSource || !hasPackages) {
    throw new Error('Cobertura report is missing coverage/sources/source/packages structure')
  }
  if (classMissingFilename) {
    throw new Error('Cobertura report contains a source class without filename')
  }

  if (!filenames.length) {
    throw new Error('Cobertura report contains no source classes')
  }
  const invalid = filenames.find(
    (filename) =>
      isAbsolute(filename) ||
      filename.includes('\\') ||
      /^[A-Za-z]:\//u.test(filename) ||
      filename.split('/').some((part) => part === '' || part === '.' || part === '..'),
  )

  if (invalid) {
    throw new Error(`Cobertura filename is not repository-relative: ${invalid}`)
  }

  return { bytes: metadata.size, classCount: filenames.length }
}

export const runCiCoverage = async ({
  image,
  container,
  cwd = process.cwd(),
  profile = resolveCheckupProfile(),
}) => {
  const reportPath = resolve(cwd, COVERAGE_REPORT_PATH)

  await mkdir(dirname(reportPath), { recursive: true })
  await rm(reportPath, { force: true })
  console.error(`ci-coverage-profile: ${JSON.stringify(profile.effective)}`)
  requireSuccess(
    docker([
      'create',
      '--name',
      container,
      ...coverageProfileArgs(profile),
      '--entrypoint',
      'npm',
      image,
      'run',
      'test:coverage',
    ]),
    'docker create coverage runner',
  )

  for (const [source, target] of [
    ['./Makefile', '/app/Makefile'],
    ['./scripts/.', '/app/scripts'],
    ['./README.md', '/app/README.md'],
  ]) {
    requireSuccess(docker(['cp', source, `${container}:${target}`]), `docker cp ${source}`)
  }
  await copyDockerSupport(container)

  const test = docker(['start', '--attach', container])
  const copied = docker(['cp', `${container}:/app/${COVERAGE_REPORT_PATH}`, reportPath], {
    stdio: 'pipe',
  })
  let report = null
  let reportError = null

  if (copied.status === 0) {
    let parser = null

    try {
      parser = await parserFromTestImage(container)
      report = await validateCobertura(reportPath, { parserEntry: parser.entry })
      console.error(`ci-coverage: ${JSON.stringify(report)}`)
    } catch (error) {
      reportError = error
    } finally {
      if (parser) {
        await rm(parser.root, { recursive: true, force: true })
      }
    }
  } else {
    reportError = new Error(
      `could not extract Cobertura report: ${copied.error?.message || copied.stderr || copied.status}`,
    )
  }

  if (reportError) {
    console.error(`ci-coverage: ${reportError.message}`)
  }
  if (test.signal) {
    return { exitCode: null, signal: test.signal, report, reportError }
  }

  return {
    exitCode: test.status === 0 && reportError ? 2 : (test.status ?? 1),
    signal: null,
    report,
    reportError,
  }
}

const main = async () => {
  const result = await runCiCoverage(parseArguments(process.argv.slice(2)))

  if (result.signal) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.exitCode
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
