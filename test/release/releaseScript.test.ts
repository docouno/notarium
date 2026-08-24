import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { runRelease } from '../../scripts/release.mjs'

const WORKSPACES = [
  'cli',
  'contract',
  'core',
  'desktop',
  'engine',
  'engine-memory',
  'engine-vector',
  'server',
  'web',
]

const MANIFESTS = ['package.json', ...WORKSPACES.map((name) => `packages/${name}/package.json`)]
const VERSION_FILES = [...MANIFESTS, 'package-lock.json']

type CommandCall = { command: string; args: string[]; stdio: string | undefined }

type HarnessOptions = {
  status?: string
  npmFailure?: boolean
  lockVersionAfterNpm?: string
  tagExists?: boolean
  tagCheckFailure?: boolean
}

const repository = (version = '0.1.0') => {
  const root = mkdtempSync(join(tmpdir(), 'notarium-release-script-'))

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: '@notarium/monorepo', version }, null, 2)}\n`,
  )
  for (const workspace of WORKSPACES) {
    mkdirSync(join(root, 'packages', workspace), { recursive: true })
    writeFileSync(
      join(root, 'packages', workspace, 'package.json'),
      `${JSON.stringify({ name: `@notarium/${workspace}`, version, private: true }, null, 2)}\n`,
    )
  }
  const packages = Object.fromEntries([
    ['', { name: '@notarium/monorepo', version }],
    ...WORKSPACES.map((workspace) => [
      `packages/${workspace}`,
      { name: `@notarium/${workspace}`, version },
    ]),
  ])
  writeFileSync(
    join(root, 'package-lock.json'),
    `${JSON.stringify({ name: '@notarium/monorepo', version, lockfileVersion: 3, packages }, null, 2)}\n`,
  )
  writeFileSync(
    join(root, 'CHANGELOG.md'),
    '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Prepared release coverage.\n',
  )

  return root
}

const bytesOf = (root: string, paths: readonly string[]) =>
  new Map(paths.map((path) => [path, readFileSync(join(root, path))]))

const versionsOf = (root: string) => {
  const manifests = MANIFESTS.map(
    (path) => JSON.parse(readFileSync(join(root, path), 'utf8')).version,
  )
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))

  return {
    manifests,
    lock: [
      lock.version,
      lock.packages[''].version,
      ...WORKSPACES.map((name) => lock.packages[`packages/${name}`].version),
    ],
  }
}

const commandHarness = (root: string, options: HarnessOptions = {}) => {
  const calls: CommandCall[] = []

  const command = (name: string, args: string[], commandOptions: { stdio?: string } = {}) => {
    calls.push({ command: name, args: [...args], stdio: commandOptions.stdio })

    if (name === 'git' && args[0] === 'status') {
      return options.status ?? ''
    }
    if (name === 'git' && args[0] === 'ls-files') {
      return `${[...MANIFESTS, 'package-lock.json', 'CHANGELOG.md'].join('\0')}\0`
    }
    if (name === 'git' && args[0] === 'rev-parse') {
      if (options.tagCheckFailure) {
        throw Object.assign(new Error('git tag lookup failed'), { status: 2 })
      }
      if (options.tagExists) {
        return 'tag\n'
      }
      throw Object.assign(new Error('unknown revision'), { status: 1 })
    }
    if (name === 'npm') {
      if (options.npmFailure) {
        throw new Error('npm failed')
      }
      const target = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
      const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
      const lockTarget = options.lockVersionAfterNpm ?? target
      lock.version = lockTarget
      lock.packages[''].version = lockTarget
      for (const workspace of WORKSPACES) {
        lock.packages[`packages/${workspace}`].version = lockTarget
      }
      writeFileSync(join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
    }

    return ''
  }

  return { calls, command }
}

describe('release version orchestration', () => {
  const roots: string[] = []

  afterEach(() => {
    while (roots.length) {
      rmSync(roots.pop()!, { recursive: true, force: true })
    }
  })

  const make = (version?: string) => {
    const root = repository(version)
    roots.push(root)
    return root
  }

  it('refuses manifest and lockfile divergence before writing', () => {
    const manifestRoot = make()
    const manifestPath = join(manifestRoot, 'packages', 'web', 'package.json')
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ name: '@notarium/web', version: '0.1.1', private: true }, null, 2)}\n`,
    )
    const manifestBefore = bytesOf(manifestRoot, VERSION_FILES)
    const manifestHarness = commandHarness(manifestRoot)

    expect(() =>
      runRelease({
        args: ['--prepare', '0.2.0'],
        root: manifestRoot,
        command: manifestHarness.command,
      }),
    ).toThrow(/manifest versions diverge/)
    expect(bytesOf(manifestRoot, VERSION_FILES)).toEqual(manifestBefore)

    const lockRoot = make()
    const lock = JSON.parse(readFileSync(join(lockRoot, 'package-lock.json'), 'utf8'))
    lock.packages['packages/web'].version = '0.1.1'
    writeFileSync(join(lockRoot, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
    const lockBefore = bytesOf(lockRoot, VERSION_FILES)

    expect(() =>
      runRelease({
        args: ['--prepare', '0.2.0'],
        root: lockRoot,
        command: commandHarness(lockRoot).command,
      }),
    ).toThrow(/package-lock versions diverge/)
    expect(bytesOf(lockRoot, VERSION_FILES)).toEqual(lockBefore)
  })

  it('refuses every tracked or untracked dirty path', () => {
    const root = make()
    const harness = commandHarness(root, { status: '?? scratch.md\n M CHANGELOG.md\n' })

    expect(() =>
      runRelease({ args: ['--prepare', '0.2.0'], root, command: harness.command }),
    ).toThrow(/completely clean/)
    expect(harness.calls).toHaveLength(1)
  })

  it.each(['wat', '0.2.0-rc.1', '00.2.0', '0.1.0', '0.0.9'])(
    'refuses prepare target %s without changing bytes',
    (target) => {
      const root = make()
      const before = bytesOf(root, VERSION_FILES)
      const harness = commandHarness(root)

      expect(() =>
        runRelease({ args: ['--prepare', target], root, command: harness.command }),
      ).toThrow(/prepare target/)
      expect(bytesOf(root, VERSION_FILES)).toEqual(before)
      expect(harness.calls.some(({ command }) => command === 'npm')).toBe(false)
    },
  )

  it('prepares exactly the manifests and lockfile without Changelog or git mutation', () => {
    const root = make()
    const changelogBefore = readFileSync(join(root, 'CHANGELOG.md'))
    const reports: string[] = []
    const harness = commandHarness(root)

    expect(
      runRelease({
        args: ['--prepare', '0.2.0'],
        root,
        command: harness.command,
        report: (line: string) => reports.push(line),
      }),
    ).toMatchObject({ mode: 'prepare', current: '0.1.0', target: '0.2.0' })
    expect(versionsOf(root)).toEqual({
      manifests: Array(10).fill('0.2.0'),
      lock: Array(11).fill('0.2.0'),
    })
    expect(readFileSync(join(root, 'CHANGELOG.md'))).toEqual(changelogBefore)
    expect(reports).toEqual(['prepared 10 manifests + package-lock: 0.1.0 → 0.2.0'])
    expect(harness.calls.filter(({ command }) => command === 'npm')).toHaveLength(1)
    expect(
      harness.calls.some(
        ({ command, args }) => command === 'git' && ['add', 'commit', 'tag'].includes(args[0]),
      ),
    ).toBe(false)
  })

  it.each([
    { label: 'npm failure', options: { npmFailure: true } },
    { label: 'post-npm verification failure', options: { lockVersionAfterNpm: '0.1.0' } },
  ])('restores exact original bytes after $label', ({ options }) => {
    const root = make()
    const before = bytesOf(root, VERSION_FILES)

    expect(() =>
      runRelease({
        args: ['--prepare', '0.2.0'],
        root,
        command: commandHarness(root, options).command,
      }),
    ).toThrow()
    expect(bytesOf(root, VERSION_FILES)).toEqual(before)
  })

  it('cuts an already prepared exact version with one add, commit and tag sequence', () => {
    const root = make('0.2.0')
    const harness = commandHarness(root)

    expect(
      runRelease({
        args: ['0.2.0'],
        root,
        command: harness.command,
        today: '2026-08-24',
        report: () => {},
      }),
    ).toMatchObject({ mode: 'release', current: '0.2.0', target: '0.2.0' })
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain(
      '## [0.2.0] — 2026-08-24\n\n### Added',
    )
    expect(versionsOf(root)).toEqual({
      manifests: Array(10).fill('0.2.0'),
      lock: Array(11).fill('0.2.0'),
    })
    expect(
      harness.calls
        .filter(
          ({ command, args }) => command === 'git' && ['add', 'commit', 'tag'].includes(args[0]),
        )
        .map(({ args }) => args[0]),
    ).toEqual(['add', 'commit', 'tag'])
  })

  it('fails closed before writes when the tag lookup itself fails', () => {
    const root = make('0.2.0')
    const paths = [...VERSION_FILES, 'CHANGELOG.md']
    const before = bytesOf(root, paths)
    const harness = commandHarness(root, { tagCheckFailure: true })

    expect(() =>
      runRelease({ args: ['0.2.0'], root, command: harness.command, report: () => {} }),
    ).toThrow(/could not determine whether tag v0\.2\.0 exists/)
    expect(bytesOf(root, paths)).toEqual(before)
    expect(harness.calls.some(({ command }) => command === 'npm')).toBe(false)
  })
})
