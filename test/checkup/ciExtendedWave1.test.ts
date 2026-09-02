import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CI_EXTENDED_WAVE1_REPORT,
  runCiExtendedWave1,
  validateCiExtendedWave1Report,
  waitForPostgres,
} from '../../scripts/checkup/ciExtendedWave1.mjs'
import { runCiVisual } from '../../scripts/checkup/ciVisual.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const phaseResult = (name: string, exitCode = 0) => ({
  name,
  command: ['node'],
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  wallMs: 1,
  exitCode,
  signal: null,
  diagnostics: null,
})

describe('CI extended PostgreSQL + visual wave', () => {
  it('recognizes the live service before starting the PostgreSQL child', async () => {
    const server = createServer()

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    try {
      const address = server.address()

      expect(address).not.toBeNull()
      await expect(
        waitForPostgres({
          host: '127.0.0.1',
          port: typeof address === 'object' && address ? address.port : 0,
          timeoutMs: 100,
          retryMs: 10,
        }),
      ).resolves.toBeUndefined()
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      )
    }
  })

  it('honors cancellation before spending the readiness budget', async () => {
    const cancellation = new AbortController()

    cancellation.abort('SIGTERM')
    await expect(waitForPostgres({ signal: cancellation.signal })).rejects.toBe('SIGTERM')
  })

  it('starts both profiled children together and preserves both verdicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-ci-wave-test-'))
    roots.push(root)
    const started: string[] = []
    const releases = new Map<string, () => void>()
    const run = runCiExtendedWave1({
      cwd: root,
      readiness: async () => {},
      phaseRunner: ({ name, args }: { name: string; args?: string[] }) =>
        new Promise((resolvePhase) => {
          started.push(name)
          expect(args).toContain('ci-extended-wave1')
          expect(args).toContain(name)
          releases.set(name, () => resolvePhase(phaseResult(name, name === 'postgres' ? 1 : 0)))
        }),
    })

    await Promise.resolve()
    expect(new Set(started)).toEqual(new Set(['postgres', 'visual']))
    releases.get('visual')?.()
    releases.get('postgres')?.()

    await expect(run).resolves.toMatchObject({
      verdict: 'failed',
      phases: [
        { name: 'postgres', exitCode: 1 },
        { name: 'visual', exitCode: 0 },
      ],
    })
    await expect(readFile(join(root, CI_EXTENDED_WAVE1_REPORT), 'utf8')).resolves.toContain(
      '"verdict": "failed"',
    )
    expect(
      validateCiExtendedWave1Report({
        schemaVersion: 1,
        verdict: 'failed',
        phases: [phaseResult('postgres', 1), phaseResult('visual')],
      }),
    ).toMatchObject({ verdict: 'failed', failed: [{ name: 'postgres', exitCode: 1 }] })
  })

  it('still completes visual when PostgreSQL readiness fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-ci-wave-readiness-test-'))
    roots.push(root)
    const started: string[] = []
    const report = await runCiExtendedWave1({
      cwd: root,
      readiness: async () => {
        throw new Error('postgres cold')
      },
      phaseRunner: async ({ name }: { name: string }) => {
        started.push(name)
        return phaseResult(name)
      },
    })

    expect(started).toEqual(['visual'])
    expect(report).toMatchObject({
      verdict: 'failed',
      phases: [
        { name: 'postgres', error: { message: 'postgres cold' } },
        { name: 'visual', exitCode: 0 },
      ],
    })
  })

  it('rejects a missing phase or a verdict that disagrees with its children', () => {
    expect(() =>
      validateCiExtendedWave1Report({
        schemaVersion: 1,
        verdict: 'passed',
        phases: [phaseResult('postgres')],
      }),
    ).toThrow(/exactly postgres and visual/u)
    expect(() =>
      validateCiExtendedWave1Report({
        schemaVersion: 1,
        verdict: 'failed',
        phases: [phaseResult('postgres'), phaseResult('postgres'), phaseResult('visual')],
      }),
    ).toThrow(/exactly postgres and visual/u)
    expect(() =>
      validateCiExtendedWave1Report({
        schemaVersion: 1,
        verdict: 'failed',
        phases: [{ ...phaseResult('postgres'), exitCode: undefined }, phaseResult('visual')],
      }),
    ).toThrow(/invalid result/u)
    expect(() =>
      validateCiExtendedWave1Report({
        schemaVersion: 1,
        verdict: 'passed',
        phases: [phaseResult('postgres', 1), phaseResult('visual')],
      }),
    ).toThrow(/verdict mismatch/u)
  })
})

describe('CI visual producer', () => {
  const tagEnv = {
    CI_COMMIT_REF_SLUG: 'ci-419',
    CI_COMMIT_SHORT_SHA: 'abc12345',
    CI_COMMIT_SHA: 'a'.repeat(40),
    CI_DEFAULT_BRANCH: 'main',
    CI_JOB_ID: '42',
    CI_PIPELINE_ID: '7',
    VISUAL_S3_READ_KEY_ID: 'read-id',
    VISUAL_S3_READ_SECRET: 'read-secret',
  }

  it('keeps comparison refs producer-green while the artifact owns a red visual attempt', () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
    const statuses = [0, 1, 0]
    const result = runCiVisual({
      env: tagEnv,
      run: ({ args, env }: { args: string[]; env: NodeJS.ProcessEnv }) => {
        calls.push({ args, env })
        return { status: statuses.shift() ?? 0, signal: null }
      },
    })

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      visualExitCode: 1,
      visualSignal: null,
      mode: 'verdict',
    })
    expect(calls.map(({ args }) => args)).toEqual([
      ['scripts/visualBaseline.mjs', 'pull'],
      [
        '--no-maglev',
        'node_modules/@playwright/test/cli.js',
        'test',
        'test/visual',
        '--workers=1',
        '--reporter=list,json',
      ],
      ['scripts/visualBaseline.mjs', 'verdict'],
    ])
    expect(calls[0]?.env).toMatchObject({
      VISUAL_S3_KEY_ID: 'read-id',
      VISUAL_S3_SECRET: 'read-secret',
    })
  })

  it('publishes only the protected default branch under the combined producer identity', () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
    const result = runCiVisual({
      env: {
        ...tagEnv,
        CI_COMMIT_BRANCH: 'main',
        VISUAL_S3_WRITE_KEY_ID: 'write-id',
        VISUAL_S3_WRITE_SECRET: 'write-secret',
      },
      run: ({ args, env }: { args: string[]; env: NodeJS.ProcessEnv }) => {
        calls.push({ args, env })
        return { status: 0, signal: null }
      },
    })

    expect(result.mode).toBe('publish')
    expect(calls[2]?.args).toEqual([
      'scripts/visualBaseline.mjs',
      'publish',
      '--candidate',
      'ci-419-abc12345-7-42',
      '--commit',
      'a'.repeat(40),
      '--pipeline',
      '7',
      '--job',
      '42',
    ])
    expect(calls[2]?.env).toMatchObject({
      VISUAL_S3_KEY_ID: 'write-id',
      VISUAL_S3_SECRET: 'write-secret',
    })
  })

  it('fails closed before rendering when the baseline cannot be pulled', () => {
    const calls: string[][] = []

    expect(() =>
      runCiVisual({
        env: tagEnv,
        run: ({ args }: { args: string[] }) => {
          calls.push(args)
          return { status: 2, signal: null }
        },
      }),
    ).toThrow(/visual baseline pull: exited 2/u)
    expect(calls).toEqual([['scripts/visualBaseline.mjs', 'pull']])
  })

  it('returns the protocol failure even when the render itself completed', () => {
    const statuses = [0, 0, 2]

    expect(
      runCiVisual({
        env: tagEnv,
        run: () => ({ status: statuses.shift() ?? 0, signal: null }),
      }),
    ).toMatchObject({ exitCode: 2, visualExitCode: 0, mode: 'verdict' })
  })
})
