import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  inspectDependencyFreshness,
  recordDependencyFreshness,
} from '../../scripts/checkup/depsFreshness.mjs'

const roots: string[] = []
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, json(value))
}

const createWorkspace = async (root: string, directory: string, name: string): Promise<string> => {
  const workspace = join(root, 'packages', directory)

  await writeJson(join(workspace, 'package.json'), { name, version: '0.2.0' })
  return workspace
}

const linkWorkspace = async (root: string, workspace: string, name: string): Promise<void> => {
  const link = join(root, 'node_modules', ...name.split('/'))

  await mkdir(dirname(link), { recursive: true })
  await symlink(workspace, link, 'dir')
}

const fixture = async (): Promise<{ root: string; coreManifest: string; lockfile: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-deps-freshness-'))
  roots.push(root)
  const core = await createWorkspace(root, 'core', '@notarium/core')
  const cli = await createWorkspace(root, 'cli', 'notarium')
  await createWorkspace(root, 'engine-vector', '@notarium/engine-vector')
  await writeJson(join(root, 'package.json'), {
    name: '@notarium/monorepo',
    private: true,
    packageManager: 'npm@11.19.0',
    workspaces: ['packages/*'],
  })
  const lockfile = join(root, 'package-lock.json')
  await writeJson(lockfile, { name: '@notarium/monorepo', lockfileVersion: 3, packages: {} })
  await writeFile(join(root, '.npmrc'), 'engine-strict=true\n')
  await writeJson(join(root, 'node_modules', '.package-lock.json'), {
    name: '@notarium/monorepo',
    lockfileVersion: 3,
    packages: {},
  })
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
  await writeFile(join(root, 'node_modules', '.bin', 'tsc'), '')
  await writeJson(join(root, 'node_modules', 'sqlite-vec', 'package.json'), {
    name: 'sqlite-vec',
  })
  await linkWorkspace(root, core, '@notarium/core')
  await linkWorkspace(root, cli, 'notarium')

  return { root, coreManifest: join(core, 'package.json'), lockfile }
}

describe('dependency freshness', () => {
  it('wires every canonical install to record and every make dependency check to inspect', async () => {
    const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
    const makefile = await readFile(join(repo, 'Makefile'), 'utf8')
    const dockerfile = await readFile(join(repo, 'docker', 'Dockerfile'), 'utf8')
    const dockerignore = await readFile(join(repo, 'docker', 'Dockerfile.dockerignore'), 'utf8')

    expect(manifest.scripts['postdeps:lean']).toBe(
      'node scripts/checkup/depsFreshness.mjs record lean',
    )
    expect(manifest.scripts['postdeps:full']).toBe(
      'node scripts/checkup/depsFreshness.mjs record full',
    )
    expect(makefile).toContain('@node scripts/checkup/depsFreshness.mjs check || npm run deps:lean')
    const carrier = 'COPY scripts/checkup/depsFreshness.mjs scripts/checkup/'
    const builderInstall = dockerfile.indexOf('RUN npm run deps:full')
    const runtimeMount = dockerfile.indexOf(
      'RUN --mount=type=bind,source=scripts/checkup/depsFreshness.mjs,target=/app/scripts/checkup/depsFreshness.mjs,ro',
    )
    const runtimeInstall = dockerfile.indexOf(
      'NOTARIUM_DEPS_INSTALL_KIND=runtime npm run deps:full --omit=dev',
    )

    expect(dockerignore).toContain('!scripts/checkup/depsFreshness.mjs')
    expect(dockerfile.match(new RegExp(`^${carrier}$`, 'gmu'))).toHaveLength(1)
    expect(dockerfile.indexOf(carrier)).toBeLessThan(builderInstall)
    expect(runtimeMount).toBeGreaterThan(builderInstall)
    expect(runtimeInstall).toBeGreaterThan(runtimeMount)
  })

  it('does not stamp an intentionally dev-less production install as a complete source tree', async () => {
    const { root } = await fixture()

    await rm(join(root, 'node_modules', '.bin', 'tsc'))
    const result = await execFileAsync(
      process.execPath,
      [join(repo, 'scripts', 'checkup', 'depsFreshness.mjs'), 'record', 'full'],
      {
        cwd: root,
        env: { ...process.env, NOTARIUM_DEPS_INSTALL_KIND: 'runtime' },
      },
    )

    expect(result.stdout).toContain(
      'deps: freshness stamp skipped for production --omit=dev install',
    )
    await expect(stat(join(root, 'node_modules', '.notarium-deps.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('accepts the unchanged canonical lean install without requiring the full-only workspace', async () => {
    const { root } = await fixture()

    await recordDependencyFreshness(root, 'lean')

    await expect(inspectDependencyFreshness(root)).resolves.toEqual({
      fresh: true,
      profile: 'lean',
    })
    expect((await stat(join(root, 'node_modules', '.notarium-deps.json'))).mode & 0o777).toBe(0o644)
    await expect(
      realpath(join(root, 'node_modules', '@notarium', 'engine-vector')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('invalidates an otherwise intact tree when a workspace adds a dependency', async () => {
    const { root, coreManifest } = await fixture()
    await recordDependencyFreshness(root, 'lean')

    const core = JSON.parse(await readFile(coreManifest, 'utf8'))
    core.dependencies = { 'fractional-indexing': '4.0.0' }
    await writeJson(coreManifest, core)

    await expect(inspectDependencyFreshness(root)).resolves.toEqual({
      fresh: false,
      reason: 'dependency manifests or lockfile changed',
    })
  })

  it('does not reinstall for manifest prose that cannot change the installed tree', async () => {
    const { root, coreManifest } = await fixture()
    await recordDependencyFreshness(root, 'lean')

    const core = JSON.parse(await readFile(coreManifest, 'utf8'))
    core.description = 'edited without changing dependency state'
    core.scripts = { test: 'vitest' }
    await writeJson(coreManifest, core)

    await expect(inspectDependencyFreshness(root)).resolves.toEqual({
      fresh: true,
      profile: 'lean',
    })
  })

  it('invalidates an otherwise intact tree when the lockfile changes', async () => {
    const { root, lockfile } = await fixture()
    await recordDependencyFreshness(root, 'lean')

    const lock = JSON.parse(await readFile(lockfile, 'utf8'))
    lock.packages['node_modules/new-package'] = { version: '1.0.0' }
    await writeJson(lockfile, lock)

    await expect(inspectDependencyFreshness(root)).resolves.toEqual({
      fresh: false,
      reason: 'dependency manifests or lockfile changed',
    })
  })

  it('refuses to record a profile whose canonical install omitted an ordinary workspace', async () => {
    const { root } = await fixture()
    const missing = await createWorkspace(root, 'new-workspace', '@notarium/new-workspace')

    await expect(recordDependencyFreshness(root, 'lean')).rejects.toThrow(
      /workspace link node_modules\/@notarium\/new-workspace is missing/u,
    )
    await expect(realpath(missing)).resolves.toBe(missing)
  })
})
