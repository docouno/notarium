import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { COVERAGE_REPORT_PATH, validateCobertura } from '../../scripts/checkup/ciCoverage.mjs'
import { JUNIT_REPORT_PATH, validateJunit } from '../../scripts/checkup/ciReports.mjs'
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

describe('GitLab coverage adapter', () => {
  it('declares percentage, Cobertura and JUnit over the one lean coverage command', async () => {
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
          reports?: {
            junit?: string
            coverage_report?: { coverage_format?: string; path?: string }
          }
        }
      }
    >
    const job = pipeline['lean:unit']!
    const script = (job.script ?? []).join('\n')
    const regex = new RegExp(job.coverage!.slice(1, -1), 'm')
    const matched = regex.exec('Lines        : 89.71% ( 71603/79812 )')?.[0]

    expect(pipeline['.lean']?.image).toBe('node:24')
    expect(script).toContain('npm run test:coverage')
    expect(script).toContain('scripts/checkup/ciReports.mjs')
    expect(matched?.match(/[0-9]+(?:\.[0-9]+)?/u)?.[0]).toBe('89.71')
    expect(regex.test('Statements   : 99.9%')).toBe(false)
    expect(job.artifacts).toMatchObject({
      when: 'always',
      paths: [JUNIT_REPORT_PATH, COVERAGE_REPORT_PATH],
      reports: {
        junit: JUNIT_REPORT_PATH,
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

  it('keeps visual retry-pass red through the artifact-owned gate', async () => {
    const [source, comparison] = await Promise.all([
      readFile(join(repo, '.gitlab-ci.yml'), 'utf8'),
      readFile(join(repo, 'scripts/checkup/ciVisual.mjs'), 'utf8'),
    ])
    const pipeline = parse(source) as Record<string, { script?: string[] }>
    const gate = (pipeline['visual:gate']?.script ?? []).join('\n')

    expect(gate).toContain('node scripts/visualBaseline.mjs gate')
    expect(gate).toContain('node scripts/visualBaseline.mjs gate --if-present')
    expect(source).toContain('visual-handoff.json')
    expect(comparison).toContain('env.CI_COMMIT_BRANCH === env.CI_DEFAULT_BRANCH')
    expect(comparison).toContain('env.VISUAL_S3_WRITE_KEY_ID')
    expect(comparison).toContain('env.VISUAL_S3_WRITE_SECRET')
    expect(comparison).toContain("[VISUAL_BASELINE, 'verdict']")
    expect(comparison).not.toContain('VISUAL_CANDIDATE')
  })

  it('rejects non-relative Cobertura class filenames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-ci-coverage-invalid-'))
    roots.push(root)
    const invalid = join(root, 'invalid.xml')
    await writeFile(invalid, cobertura('/absolute/source.ts'))

    await expect(validateCobertura(invalid)).rejects.toThrow(/not repository-relative/u)
  })

  it('requires a well-formed, non-empty JUnit testsuites report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-ci-junit-'))
    roots.push(root)
    const valid = join(root, 'valid.xml')
    const invalid = join(root, 'invalid.xml')
    const truncated = join(root, 'truncated.xml')
    await writeFile(valid, '<testsuites tests="1"><testsuite name="unit" /></testsuites>')
    await writeFile(invalid, '<testsuite />')
    await writeFile(truncated, '<testsuites tests="1"><testsuite name="unit">')

    await expect(validateJunit(valid)).resolves.toMatchObject({
      bytes: expect.any(Number),
      suites: 1,
      tests: 1,
    })
    await expect(validateJunit(invalid)).rejects.toThrow(/testsuites root.*positive test count/u)
    await expect(validateJunit(truncated)).rejects.toThrow(/not well-formed XML/u)
    expect(JUNIT_REPORT_PATH).toBe('test-results/vitest-junit.xml')
  })

  it('fails a green run when Cobertura is truncated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-ci-coverage-truncated-'))
    roots.push(root)
    const invalid = join(root, 'truncated.xml')
    await writeFile(invalid, cobertura().replace('</coverage>\n', ''))

    await expect(validateCobertura(invalid)).rejects.toThrow(/not well-formed XML.*unclosed tag/u)
  })
})
