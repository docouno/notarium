import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { staticPhasePlan } from '../../scripts/checkup/index.mjs'
import { runStaticChecks } from '../../scripts/checkup/static.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const result = (name: string, exitCode = 0) => ({
  name,
  command: ['fixture'],
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  wallMs: 25,
  exitCode,
  signal: null,
  diagnostics: null,
})

describe('grouped static checks', () => {
  it('shares declarations while keeping CI on exactly its existing five checks', () => {
    expect(staticPhasePlan({ preset: 'ci-lean', profiled: false })).toEqual(
      ['format', 'canon', 'meta-migrations', 'lint', 'typecheck'].map((name) =>
        expect.objectContaining({ name, parallelGroup: 'static-correctness' }),
      ),
    )
    const checkup = staticPhasePlan()

    expect(checkup.map(({ name }) => name)).toEqual([
      'dependencies',
      'write-performance',
      'format',
      'canon',
      'meta-migrations',
      'runtime-audit',
      'lint',
      'typecheck',
    ])
    expect(checkup.find(({ name }) => name === 'write-performance')).not.toHaveProperty(
      'parallelGroup',
    )
  })

  it('starts every CI check together and records declaration order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-static-checks-'))
    roots.push(root)
    let active = 0
    let peak = 0
    const report = await runStaticChecks({
      cwd: root,
      output: join(root, 'report.json'),
      phaseRunner: async ({ name }: { name: string }) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
        active -= 1
        return result(name)
      },
    })

    expect(peak).toBe(5)
    expect(report.verdict).toBe('passed')
    expect(report.phases.map(({ name }) => name)).toEqual([
      'format',
      'canon',
      'meta-migrations',
      'lint',
      'typecheck',
    ])
    await expect(readFile(join(root, 'report.json'), 'utf8')).resolves.toContain(
      '"verdict": "passed"',
    )
  })

  it('waits for and records every red sibling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-static-red-'))
    roots.push(root)
    const report = await runStaticChecks({
      cwd: root,
      output: join(root, 'report.json'),
      phaseRunner: async ({ name }: { name: string }) =>
        result(name, name === 'format' || name === 'lint' ? 7 : 0),
    })

    expect(report.verdict).toBe('failed')
    expect(report.phases.filter(({ exitCode }) => exitCode !== 0).map(({ name }) => name)).toEqual([
      'format',
      'lint',
    ])
  })
})
