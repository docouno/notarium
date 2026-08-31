import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const runEnvironmentProbe = (
  cwd: string,
  {
    expectedPort = '4321',
    expectedVectorSearch = 'on',
    expectedComposeProject = 'notarium_probe',
    extraArgs = [],
  }: {
    expectedPort?: string
    expectedVectorSearch?: string
    expectedComposeProject?: string
    extraArgs?: string[]
  } = {},
) =>
  spawnSync(
    'make',
    [
      '--no-print-directory',
      '-f',
      join(repo, 'Makefile'),
      '--eval',
      'MAKE_ONLY_PROBE := must-not-leak',
      '--eval',
      [
        'environment-probe:',
        `\t@test "$$PORT" = "${expectedPort}"`,
        `\t@test "$$VECTOR_SEARCH" = "${expectedVectorSearch}"`,
        `\t@test "$$COMPOSE_PROJECT_NAME" = "${expectedComposeProject}"`,
        '\t@test "$$EXTERNAL_PROBE" = "from-parent"',
        '\t@test -z "$${MAKE_ONLY_PROBE+x}"',
        '\t@test "$$SHELL" = "/bin/bash"',
        '\t@test -n "$$IMAGE"',
        '\t@test -n "$$HOST_UID"',
        '\t@test -n "$$HOST_GID"',
      ].join('\n'),
      ...extraArgs,
      'environment-probe',
    ],
    {
      cwd,
      env: {
        ...process.env,
        EXTERNAL_PROBE: 'from-parent',
        PORT: '9999',
        VECTOR_SEARCH: '',
        COMPOSE_PROJECT_NAME: '',
      },
      encoding: 'utf8',
      timeout: 5_000,
    },
  )

describe('Makefile recipe environment', () => {
  it('exports .env and recipe defaults without exporting internal make variables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-env-'))
    roots.push(root)
    await writeFile(
      join(root, '.env'),
      'PORT=4321\nVECTOR_SEARCH=on\nCOMPOSE_PROJECT_NAME=notarium_probe\n',
    )

    const result = runEnvironmentProbe(root)

    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })

  it('keeps command-line overrides authoritative and exported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-env-override-'))
    roots.push(root)
    await writeFile(
      join(root, '.env'),
      'PORT=4321\nVECTOR_SEARCH=on\nCOMPOSE_PROJECT_NAME=notarium_probe\n',
    )

    const result = runEnvironmentProbe(root, {
      expectedPort: '8765',
      extraArgs: ['PORT=8765'],
    })

    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })

  it('does not turn an absent .env into export-all semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-env-missing-'))
    roots.push(root)

    const result = runEnvironmentProbe(root, {
      expectedPort: '9999',
      expectedVectorSearch: '',
      expectedComposeProject: '',
    })

    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })
})
