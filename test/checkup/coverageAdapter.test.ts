import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  COVERAGE_REPORT_PATH,
  coverageProfileArgs,
  runCiCoverage,
  validateCobertura,
} from '../../scripts/checkup/ciCoverage.mjs'
import { resolveCheckupProfile } from '../../scripts/checkup/profile.mjs'
import vitestConfig from '../../vitest.config'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const cobertura = (filename = 'packages/core/src/example.ts') => `<?xml version="1.0" ?>
<coverage lines-valid="1" lines-covered="1" line-rate="1">
  <sources><source>/app</source></sources>
  <packages><package name="core"><classes><class name="example" filename="${filename}" line-rate="1" /></classes></package></packages>
</coverage>
`

const fakeDocker = async (root: string, { testExit = 0, xml = cobertura() } = {}) => {
  const bin = join(root, 'docker')
  const report = join(root, 'fake-report.xml')
  await writeFile(report, xml)
  await writeFile(
    bin,
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >> ${JSON.stringify(join(root, 'docker.calls'))}
case "\${1:-}" in
  create) exit 0 ;;
  start)
    printf '%s\n' 'Lines        : 89.71% ( 71603/79812 )'
    exit ${testExit}
    ;;
  cp)
    case "\${2:-}" in
      */notarium-ci-coverage-support-*/docker)
        test "\${3:-}" = 'runner:/app'
        test -f "$2/Dockerfile.dockerignore"
        test "$(find "$2" -mindepth 1 -maxdepth 1 -print | wc -l)" -eq 1
        ;;
      *:/app/coverage/cobertura-coverage.xml) cp ${JSON.stringify(report)} "$3" ;;
      *:/app/node_modules/saxes) cp -R ${JSON.stringify(join(repo, 'node_modules/saxes'))} "$3" ;;
      *:/app/node_modules/xmlchars) cp -R ${JSON.stringify(join(repo, 'node_modules/xmlchars'))} "$3" ;;
    esac
    exit 0
    ;;
esac
exit 2
`,
  )
  await chmod(bin, 0o755)

  return bin
}

describe('GitLab coverage adapter', () => {
  it('declares percentage and Cobertura as separate surfaces over one repo command', async () => {
    const pipeline = parse(await readFile(join(repo, '.gitlab-ci.yml'), 'utf8')) as Record<
      string,
      {
        image?: string
        script?: string[]
        timeout?: string
        coverage?: string
        artifacts?: {
          when?: string
          paths?: string[]
          reports?: { coverage_report?: { coverage_format?: string; path?: string } }
        }
      }
    >
    const job = pipeline['extended:unit']!
    const script = (job.script ?? []).join('\n')
    const regex = new RegExp(job.coverage!.slice(1, -1), 'm')
    const matched = regex.exec('Lines        : 89.71% ( 71603/79812 )')?.[0]

    expect(job.image).toBe('node:24-alpine')
    expect(script).toContain('docker-cli-buildx')
    expect(script).toContain('docker-cli-compose')
    expect(script).not.toMatch(/apk add[^\n]*\bnodejs\b/u)
    expect(script.match(/ciCoverage[.]mjs/gu)).toHaveLength(1)
    expect(script).not.toContain('docker start --attach')
    expect(matched?.match(/[0-9]+(?:\.[0-9]+)?/u)?.[0]).toBe('89.71')
    expect(regex.test('Statements   : 99.9%')).toBe(false)
    expect(job.artifacts).toMatchObject({
      when: 'always',
      paths: [COVERAGE_REPORT_PATH],
      reports: {
        coverage_report: { coverage_format: 'cobertura', path: COVERAGE_REPORT_PATH },
      },
    })
  })

  it('gives the manual comparison a Node 24 runtime and a bounded four-hour window', async () => {
    const pipeline = parse(await readFile(join(repo, '.gitlab-ci.yml'), 'utf8')) as Record<
      string,
      { image?: string; script?: string[]; timeout?: string }
    >
    const job = pipeline['checkup:compare']!
    const script = (job.script ?? []).join('\n')

    expect(job.image).toBe('node:24-alpine')
    expect(job.timeout).toBe('4h')
    expect(script).toContain('docker-cli-buildx')
    expect(script).toContain('docker-cli-compose')
    expect(script).not.toMatch(/apk add[^\n]*\bnodejs\b/u)
  })

  it('makes canonical Vitest produce Cobertura even on a red test run', () => {
    const coverage = (vitestConfig as { test?: { coverage?: Record<string, unknown> } }).test!
      .coverage!

    expect(coverage.reporter).toContain('cobertura')
    expect(coverage.reportOnFailure).toBe(true)
    expect(coverage.processingConcurrency).toBe(
      resolveCheckupProfile().effective.coverageProcessingConcurrency,
    )
  })

  it('passes one resolved effective tuple into the coverage container and requires affinity', () => {
    const profile = resolveCheckupProfile({ env: {}, availableCpu: 2 })

    expect(coverageProfileArgs(profile)).toEqual([
      '--env',
      'CHECKUP_CPU_CEILING=2',
      '--env',
      'CHECKUP_VITEST_WORKERS=2',
      '--env',
      'CHECKUP_COVERAGE_CONCURRENCY=2',
      '--env',
      'CHECKUP_REQUIRE_AFFINITY=1',
    ])
  })

  it('keeps visual retry-pass red through the artifact-owned gate', async () => {
    const source = await readFile(join(repo, '.gitlab-ci.yml'), 'utf8')
    const pipeline = parse(source) as Record<string, { script?: string[] }>
    const comparison = (pipeline['extended:visual']?.script ?? []).join('\n')
    const gate = (pipeline['visual:gate']?.script ?? []).join('\n')

    expect(gate).toContain('node scripts/visualBaseline.mjs gate')
    expect(source).toContain('visual-handoff.json')
    expect(comparison).toContain(
      'if [ -n "${VISUAL_S3_WRITE_KEY_ID:-}" ] && [ -n "${VISUAL_S3_WRITE_SECRET:-}" ]; then',
    )
    expect(comparison).toContain('node scripts/visualBaseline.mjs verdict')
    expect(comparison).not.toContain('if [ -n "$VISUAL_S3_WRITE_KEY_ID" ]')
  })

  it('preserves the original red exit after extracting a valid report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-ci-coverage-red-'))
    roots.push(root)
    await mkdir(join(root, 'scripts'))
    await Promise.all([
      writeFile(join(root, 'Makefile'), 'fixture'),
      writeFile(join(root, 'README.md'), 'fixture'),
    ])
    const docker = await fakeDocker(root, { testExit: 7 })
    const old = process.env.CHECKUP_DOCKER_BIN
    process.env.CHECKUP_DOCKER_BIN = docker

    try {
      const profile = resolveCheckupProfile({ env: {}, availableCpu: 2 })
      const result = await runCiCoverage({
        image: 'image',
        container: 'runner',
        cwd: root,
        profile,
      })

      expect(result.exitCode).toBe(7)
      expect(result.report).toMatchObject({ classCount: 1 })
      const calls = await readFile(join(root, 'docker.calls'), 'utf8')

      expect(calls).toContain(
        'create --name runner --env CHECKUP_CPU_CEILING=2 --env CHECKUP_VITEST_WORKERS=2 --env CHECKUP_COVERAGE_CONCURRENCY=2 --env CHECKUP_REQUIRE_AFFINITY=1',
      )
      expect(
        calls.split('\n').filter((call) => call.includes('/notarium-ci-coverage-support-')),
      ).toEqual([
        expect.stringMatching(
          /^cp \/tmp\/notarium-ci-coverage-support-[^/]+\/docker runner:\/app$/u,
        ),
      ])
      await expect(readFile(join(root, COVERAGE_REPORT_PATH), 'utf8')).resolves.toContain(
        'packages/core/src/example.ts',
      )
    } finally {
      if (old === undefined) {
        delete process.env.CHECKUP_DOCKER_BIN
      } else {
        process.env.CHECKUP_DOCKER_BIN = old
      }
    }
  })

  it('rejects non-relative Cobertura class filenames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-ci-coverage-invalid-'))
    roots.push(root)
    const invalid = join(root, 'invalid.xml')
    await writeFile(invalid, cobertura('/absolute/source.ts'))

    await expect(validateCobertura(invalid)).rejects.toThrow(/not repository-relative/u)
  })

  it('fails a green run when Cobertura is truncated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-ci-coverage-truncated-'))
    roots.push(root)
    await mkdir(join(root, 'scripts'))
    await Promise.all([
      writeFile(join(root, 'Makefile'), 'fixture'),
      writeFile(join(root, 'README.md'), 'fixture'),
    ])
    const xml = cobertura().replace('</coverage>\n', '')
    const docker = await fakeDocker(root, { xml })
    const old = process.env.CHECKUP_DOCKER_BIN
    process.env.CHECKUP_DOCKER_BIN = docker

    try {
      const result = await runCiCoverage({ image: 'image', container: 'runner', cwd: root })

      expect(result.exitCode).toBe(2)
      expect(result.report).toBeNull()
      expect(result.reportError).toMatchObject({
        message: expect.stringMatching(/not well-formed XML.*unclosed tag/u),
      })
    } finally {
      if (old === undefined) {
        delete process.env.CHECKUP_DOCKER_BIN
      } else {
        process.env.CHECKUP_DOCKER_BIN = old
      }
    }
  })
})
