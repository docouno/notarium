import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { runCiFullDeps } from '../../scripts/checkup/ciFullDeps.mjs'
import {
  assertFullDepsInstalled,
  FULL_DEPS_NATIVE_MANIFESTS,
  missingFullDepsManifests,
} from '../release/fullDepsProfile'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('CI full-deps adapter', () => {
  it('keeps the full-dependency contour to the two native-manifest cases', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const script = manifest.scripts['test:full-deps']

    expect(script).toContain('assertFullDepsInstalled')
    expect(script).toContain('test/release/fullDepsProfile.ts')
    expect(script).not.toContain('fullDepsGate.ts')
    expect(script).toContain('test/depsProfile.test.ts test/release/licenseCorpus.test.ts')
    expect(script).toContain('contains no unused Linux GPU execution providers')
    expect(script).toContain('keeps native source offers exact')
    expect(script).not.toContain('--coverage')
  })

  it('keeps the precheck independent from Vitest and names missing native manifests', () => {
    const missing = missingFullDepsManifests({
      rootPath: '/repo',
      exists: (path) => path.includes('onnxruntime-common/package.json'),
    })

    expect(missing).toEqual(
      FULL_DEPS_NATIVE_MANIFESTS.filter((dir) => !dir.endsWith('onnxruntime-common')),
    )
    expect(() => assertFullDepsInstalled(['node_modules/onnxruntime-node'])).toThrow(
      /requires the native manifests.*onnxruntime-node/u,
    )
  })

  it('runs only the full-only contour with the resolved slice and shared support carrier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-ci-full-deps-'))
    roots.push(root)
    await Promise.all([mkdir(join(root, 'scripts')), mkdir(join(root, 'docker'))])
    await Promise.all([
      writeFile(join(root, 'Makefile'), 'fixture'),
      writeFile(join(root, 'README.md'), 'fixture'),
      writeFile(join(root, 'scripts/support.mjs'), 'fixture'),
      writeFile(join(root, 'docker/Dockerfile'), 'fixture'),
      writeFile(join(root, 'docker/Dockerfile.dockerignore'), 'fixture'),
    ])
    const calls = join(root, 'docker.calls')
    const bin = join(root, 'docker-bin')
    await writeFile(
      bin,
      `#!/bin/sh
set -eu
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
case "\${1:-}" in
  create|start) exit 0 ;;
  cp)
    support="\${2%/.}"
    test -f "$support/Makefile"
    test -f "$support/docker/Dockerfile"
    test -f "$support/docker/Dockerfile.dockerignore"
    exit 0
    ;;
esac
exit 2
`,
    )
    await chmod(bin, 0o755)
    const previous = process.env.CHECKUP_DOCKER_BIN
    process.env.CHECKUP_DOCKER_BIN = bin

    try {
      await expect(
        runCiFullDeps({
          image: 'image',
          container: 'runner',
          cwd: root,
          env: {
            CHECKUP_CPU_CEILING: '4',
            CHECKUP_VITEST_WORKERS: '4',
            CHECKUP_COVERAGE_CONCURRENCY: '4',
            CHECKUP_PLAYWRIGHT_WORKERS: '1',
            CHECKUP_CPUSET: '0-3',
            CHECKUP_RESOURCE_PLAN: 'ci-extended-wave1',
            CHECKUP_RESOURCE_LANE: 'coverage',
            CHECKUP_PROFILE_RESOLVED: '1',
          },
        }),
      ).resolves.toEqual({ exitCode: 0, signal: null })
      const output = await readFile(calls, 'utf8')

      expect(output).toContain('create --name runner --cpuset-cpus 0-3')
      expect(output).toContain('--env CI=1 --entrypoint npm image run test:full-deps')
      expect(output).toMatch(/cp \/tmp\/notarium-container-support-[^/]+\/[.] runner:\/app/u)
      expect(output).toContain('start --attach runner')
    } finally {
      if (previous === undefined) {
        delete process.env.CHECKUP_DOCKER_BIN
      } else {
        process.env.CHECKUP_DOCKER_BIN = previous
      }
    }
  })
})
