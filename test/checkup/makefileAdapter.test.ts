import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { phasePlan } from '../../scripts/checkup/index.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('checkup entrypoint adapter', () => {
  it('keeps Make as a one-line adapter to the repo-owned session driver', async () => {
    const makefile = await readFile(resolve(repo, 'Makefile'), 'utf8')
    const targetStart = makefile.indexOf('\ncheckup:') + 1
    const target = makefile.slice(targetStart, makefile.indexOf('\naudit-runtime:', targetStart))

    expect(target).toContain('node scripts/checkup/index.mjs run')
    expect(target).not.toContain('test-coverage')
    expect(target).not.toContain('test-pg')
    expect(target).not.toContain('test-browser')
  })

  it('keeps every standalone source copy on one private-byte deny contract', async () => {
    const [makefile, dockerIgnore] = await Promise.all([
      readFile(resolve(repo, 'Makefile'), 'utf8'),
      readFile(resolve(repo, 'docker/Dockerfile.dockerignore'), 'utf8'),
    ])
    const helper = makefile.slice(
      makefile.indexOf('SOURCE_COPY_TAR_EXCLUDES :='),
      makefile.indexOf('\n\n.DEFAULT_GOAL'),
    )

    for (const denied of [
      "--exclude='./.docs-local'",
      "--exclude='./review.env'",
      "--exclude='./visual-handoff.json'",
      "--exclude='./visual-pulled-base.json'",
      "--exclude='./backups'",
      "--exclude='./notarium-*.tar.gz'",
    ]) {
      expect(helper).toContain(denied)
    }
    expect(makefile.match(/tar -C \/source \$\(SOURCE_COPY_TAR_EXCLUDES\)/gu)).toHaveLength(5)
    expect(makefile.match(/-e CHECKUP_REQUIRE_AFFINITY=1/gu)).toHaveLength(2)
    expect(dockerIgnore).toMatch(/^review[.]env$/mu)
    expect(dockerIgnore).toMatch(/^visual-handoff[.]json$/mu)
    expect(dockerIgnore).toMatch(/^visual-pulled-base[.]json$/mu)
    expect(dockerIgnore).toMatch(/^backups$/mu)
  })

  it('delegates standalone coverage support to the repo-owned carrier', async () => {
    const makefile = await readFile(resolve(repo, 'Makefile'), 'utf8')
    const start = makefile.indexOf('\ntest-coverage:') + 1
    const target = makefile.slice(start, makefile.indexOf('\n# --- live database', start))

    expect(target).toContain('docker create --name $(CHECKUP_RUNNER_CONTAINER)')
    expect(target).toContain('node scripts/checkup/containerSupport.mjs copy')
    expect(target).toContain('docker start --attach $(CHECKUP_RUNNER_CONTAINER)')
    expect(target).not.toContain('src=$(CURDIR)/Makefile')
    expect(target).not.toContain('src=$(CURDIR)/scripts')
    expect(target).not.toContain('src=$(CURDIR)/README.md')
  })

  it('models normalized legacy orchestration without changing subject bytes', () => {
    const legacy = phasePlan('legacy', 'session')
    const candidate = phasePlan('candidate', 'session')

    expect(legacy.static).toEqual(candidate.static)
    expect(legacy.heavy.map(({ name }) => name)).toEqual([
      'coverage',
      'postgres',
      'backup-smoke',
      'browser',
    ])
    expect(legacy.heavy.map(({ args }) => args.at(-1))).toEqual([
      'test-coverage',
      'test-pg',
      'backup-smoke',
      'test-browser',
    ])
    expect(legacy.heavy.every((phase) => phase.parallelGroup === undefined)).toBe(true)
    expect(phasePlan('candidate', 'session').heavy.map(({ name }) => name)).toEqual([
      'coverage',
      'postgres',
      'browser',
      'backup-smoke',
    ])
    expect(phasePlan('candidate', 'session').heavy.slice(0, 2)).toEqual([
      {
        name: 'coverage',
        command: process.execPath,
        args: ['scripts/checkup/heavy.mjs', 'coverage'],
        daemonWork: true,
        resource: { plan: 'local-isolated', lane: 'coverage' },
      },
      {
        name: 'postgres',
        command: process.execPath,
        args: ['scripts/checkup/heavy.mjs', 'postgres'],
        daemonWork: true,
        parallelGroup: 'postgres-browser',
        resource: { plan: 'local-heavy', lane: 'postgres' },
      },
    ])
    expect(phasePlan('candidate', 'session').heavy[2]).toEqual({
      name: 'browser',
      command: process.execPath,
      args: ['scripts/checkup/heavy.mjs', 'browser'],
      daemonWork: true,
      parallelGroup: 'postgres-browser',
      resource: { plan: 'local-heavy', lane: 'browser' },
    })
  })
})
