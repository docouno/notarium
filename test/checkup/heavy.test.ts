import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureHeavyResourceOwnership,
  cleanupHeavyResourceClaims,
  cleanupHeavyResources,
  containerProfileArgs,
  heavyResourceNames,
  resolveDockerImageId,
} from '../../scripts/checkup/heavy.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('checkup heavy artifact ownership', () => {
  it('derives every reusable coverage/Postgres resource from one session namespace', () => {
    expect(
      heavyResourceNames({
        CHECKUP_SESSION_ID: 'session',
        CHECKUP_IMAGE: 'notarium-checkup:session',
        CHECKUP_RUNNER_CONTAINER: 'notarium-checkup-session-runner',
      }),
    ).toEqual({
      sessionId: 'session',
      image: 'notarium-checkup:session',
      coverage: 'notarium-checkup-session-runner-coverage',
      postgres: 'notarium-checkup-session-runner-postgres',
      postgresRunner: 'notarium-checkup-session-runner-pg-tests',
      network: 'notarium-checkup-session-runner-pg-net',
      browserVolume: 'notarium-checkup-session-runner-browser-workspace',
      browserSeed: 'notarium-checkup-session-runner-browser-seed',
      browserDeps: 'notarium-checkup-session-runner-browser-deps',
      browserBuild: 'notarium-checkup-session-runner-browser-build',
      browserTests: 'notarium-checkup-session-runner-browser-tests',
      browserVisual: 'notarium-checkup-session-runner-browser-visual',
    })
  })

  it('refuses an unowned namespace rather than falling back to shared names', () => {
    expect(() => heavyResourceNames({})).toThrow(/requires CHECKUP_SESSION_ID/u)
  })

  it('bounds every best-effort cleanup call when the Docker client stalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-docker-stall-'))
    const docker = join(root, 'docker')
    const previous = process.env.CHECKUP_DOCKER_BIN
    roots.push(root)
    await writeFile(docker, '#!/bin/sh\nsleep 2\n')
    await chmod(docker, 0o755)
    process.env.CHECKUP_DOCKER_BIN = docker

    try {
      expect(() =>
        cleanupHeavyResources({
          CHECKUP_SESSION_ID: 'session',
          CHECKUP_IMAGE: 'notarium-checkup:session',
          CHECKUP_RUNNER_CONTAINER: 'notarium-checkup-session-runner',
          CHECKUP_DOCKER_CLEANUP_MS: '20',
        }),
      ).toThrow(/ownership inspection timed out/u)
    } finally {
      if (previous === undefined) {
        delete process.env.CHECKUP_DOCKER_BIN
      } else {
        process.env.CHECKUP_DOCKER_BIN = previous
      }
    }
  })

  it('fails cleanup when Docker claims success but owned resources still inspect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-docker-leftover-'))
    const docker = join(root, 'docker')
    const previous = process.env.CHECKUP_DOCKER_BIN
    roots.push(root)
    await writeFile(
      docker,
      `#!/bin/sh
set -eu
kind="$1"
action="$2"
if [ "$action" = inspect ]; then
  name="$5"
  case "$kind" in
    container|image)
      printf '{"Id":"sha256:%064d","Config":{"Labels":{"notarium.checkup.session":"session"}},"Name":"%s"}\\n' 0 "$name"
      ;;
    network)
      printf '{"Id":"network-id","Labels":{"notarium.checkup.session":"session"},"Name":"%s"}\\n' "$name"
      ;;
    volume)
      printf '{"Name":"%s","Labels":{"notarium.checkup.session":"session"}}\\n' "$name"
      ;;
  esac
fi
exit 0
`,
    )
    await chmod(docker, 0o755)
    process.env.CHECKUP_DOCKER_BIN = docker

    try {
      expect(() =>
        cleanupHeavyResources({
          CHECKUP_SESSION_ID: 'session',
          CHECKUP_IMAGE: 'notarium-checkup:session',
          CHECKUP_RUNNER_CONTAINER: 'notarium-checkup-session-runner',
          CHECKUP_DOCKER_CLEANUP_MS: '100',
        }),
      ).toThrow(/still exists after cleanup/u)
    } finally {
      if (previous === undefined) {
        delete process.env.CHECKUP_DOCKER_BIN
      } else {
        process.env.CHECKUP_DOCKER_BIN = previous
      }
    }
  })

  it('accepts the Docker daemon missing-resource variants as a clean postcondition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-docker-absent-'))
    const docker = join(root, 'docker')
    const previous = process.env.CHECKUP_DOCKER_BIN
    roots.push(root)
    await writeFile(
      docker,
      `#!/bin/sh
if [ "$2" != "inspect" ]; then
  exit 0
fi
case "$1" in
  container) echo "Error response from daemon: No such object: $3" >&2 ;;
  network) echo "Error response from daemon: network $3 not found" >&2 ;;
  volume) echo "Error response from daemon: get $3: no such volume" >&2 ;;
  image) echo "Error response from daemon: No such image: $3" >&2 ;;
esac
exit 1
`,
    )
    await chmod(docker, 0o755)
    process.env.CHECKUP_DOCKER_BIN = docker

    try {
      expect(() =>
        cleanupHeavyResources({
          CHECKUP_SESSION_ID: 'session',
          CHECKUP_IMAGE: 'notarium-checkup:session',
          CHECKUP_RUNNER_CONTAINER: 'notarium-checkup-session-runner',
          CHECKUP_DOCKER_CLEANUP_MS: '100',
        }),
      ).not.toThrow()
    } finally {
      if (previous === undefined) {
        delete process.env.CHECKUP_DOCKER_BIN
      } else {
        process.env.CHECKUP_DOCKER_BIN = previous
      }
    }
  })

  it('leaves a foreign collision untouched and reports incomplete cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-docker-foreign-'))
    const docker = join(root, 'docker')
    const removals = join(root, 'removals')
    const previous = process.env.CHECKUP_DOCKER_BIN
    roots.push(root)
    await writeFile(
      docker,
      `#!/bin/sh
set -eu
if [ "$2" = inspect ]; then
  name="$5"
  case "$1" in
    container|image) printf '{"Id":"foreign-id","Config":{"Labels":{"notarium.checkup.session":"other"}},"Name":"%s"}\\n' "$name" ;;
    network) printf '{"Id":"foreign-id","Labels":{"notarium.checkup.session":"other"},"Name":"%s"}\\n' "$name" ;;
    volume) printf '{"Name":"%s","Labels":{"notarium.checkup.session":"other"}}\\n' "$name" ;;
  esac
  exit 0
fi
printf '%s\\n' "$*" >> ${JSON.stringify(removals)}
`,
    )
    await chmod(docker, 0o755)
    process.env.CHECKUP_DOCKER_BIN = docker

    try {
      expect(() =>
        cleanupHeavyResources({
          CHECKUP_SESSION_ID: 'session',
          CHECKUP_IMAGE: 'notarium-checkup:session',
          CHECKUP_RUNNER_CONTAINER: 'notarium-checkup-session-runner',
          CHECKUP_DOCKER_CLEANUP_MS: '100',
        }),
      ).toThrow(/belongs to session other/u)
      await expect(readFile(removals, 'utf8')).rejects.toThrow(/ENOENT/u)
    } finally {
      if (previous === undefined) {
        delete process.env.CHECKUP_DOCKER_BIN
      } else {
        process.env.CHECKUP_DOCKER_BIN = previous
      }
    }
  })

  it('leaves a foreign replacement volume untouched during global cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-global-volume-replacement-'))
    const docker = join(root, 'docker')
    const inspections = join(root, 'inspections')
    const removals = join(root, 'removals')
    const previous = process.env.CHECKUP_DOCKER_BIN
    roots.push(root)
    await writeFile(
      docker,
      `#!/bin/sh
set -eu
if [ "$2" = inspect ]; then
  name="$5"
  if [ "$1" = volume ]; then
    count=0
    [ ! -f ${JSON.stringify(inspections)} ] || count="$(cat ${JSON.stringify(inspections)})"
    count=$((count + 1))
    printf '%s' "$count" > ${JSON.stringify(inspections)}
    session=session
    [ "$count" -eq 1 ] || session=foreign
    printf '{"Name":"%s","Labels":{"notarium.checkup.session":"%s"}}\n' "$name" "$session"
    exit 0
  fi
  case "$1" in
    container) echo "Error response from daemon: No such object: $name" >&2 ;;
    network) echo "Error response from daemon: network $name not found" >&2 ;;
    image) echo "Error response from daemon: No such image: $name" >&2 ;;
  esac
  exit 1
fi
printf '%s\n' "$*" >> ${JSON.stringify(removals)}
`,
    )
    await chmod(docker, 0o755)
    process.env.CHECKUP_DOCKER_BIN = docker

    try {
      expect(() =>
        cleanupHeavyResources({
          CHECKUP_SESSION_ID: 'session',
          CHECKUP_IMAGE: 'notarium-checkup:session',
          CHECKUP_RUNNER_CONTAINER: 'notarium-checkup-session-runner',
          CHECKUP_DOCKER_CLEANUP_MS: '100',
        }),
      ).toThrow(/belongs to session foreign and was left untouched/u)
      await expect(readFile(removals, 'utf8')).rejects.toThrow(/ENOENT/u)
    } finally {
      if (previous === undefined) {
        delete process.env.CHECKUP_DOCKER_BIN
      } else {
        process.env.CHECKUP_DOCKER_BIN = previous
      }
    }
  })

  it('leaves a same-name container replacement untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-container-replacement-'))
    const docker = join(root, 'docker')
    const inspections = join(root, 'inspections')
    const removals = join(root, 'removals')
    const previous = process.env.CHECKUP_DOCKER_BIN
    roots.push(root)
    await writeFile(
      docker,
      `#!/bin/sh
set -eu
if [ "$2" = inspect ]; then
  name="$5"
  id=owned-id
  if [ "$name" != owned-id ]; then
    if [ -f ${JSON.stringify(inspections)} ]; then
      id=replacement-id
    else
      : > ${JSON.stringify(inspections)}
    fi
  fi
  printf '{"Id":"%s","Config":{"Labels":{"notarium.checkup.session":"session"}}}\n' "$id"
  exit 0
fi
printf '%s\n' "$*" >> ${JSON.stringify(removals)}
`,
    )
    await chmod(docker, 0o755)
    process.env.CHECKUP_DOCKER_BIN = docker

    try {
      const claim = captureHeavyResourceOwnership(
        { kind: 'container', name: 'runner' },
        'session',
        100,
      )

      expect(() => cleanupHeavyResourceClaims([claim], 100)).toThrow(
        /was replaced during cleanup and was left untouched/u,
      )
      await expect(readFile(removals, 'utf8')).resolves.toBe('container rm --force owned-id\n')
    } finally {
      if (previous === undefined) {
        delete process.env.CHECKUP_DOCKER_BIN
      } else {
        process.env.CHECKUP_DOCKER_BIN = previous
      }
    }
  })

  it('leaves a foreign replacement volume untouched before name removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-volume-replacement-'))
    const docker = join(root, 'docker')
    const inspections = join(root, 'inspections')
    const removals = join(root, 'removals')
    const previous = process.env.CHECKUP_DOCKER_BIN
    roots.push(root)
    await writeFile(
      docker,
      `#!/bin/sh
set -eu
if [ "$2" = inspect ]; then
  count=0
  [ ! -f ${JSON.stringify(inspections)} ] || count="$(cat ${JSON.stringify(inspections)})"
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(inspections)}
  session=session
  [ "$count" -eq 1 ] || session=foreign
  printf '{"Name":"workspace","Labels":{"notarium.checkup.session":"%s"}}\n' "$session"
  exit 0
fi
printf '%s\n' "$*" >> ${JSON.stringify(removals)}
`,
    )
    await chmod(docker, 0o755)
    process.env.CHECKUP_DOCKER_BIN = docker

    try {
      const claim = captureHeavyResourceOwnership(
        { kind: 'volume', name: 'workspace' },
        'session',
        100,
      )

      expect(() => cleanupHeavyResourceClaims([claim], 100)).toThrow(
        /belongs to session foreign and was left untouched/u,
      )
      await expect(readFile(removals, 'utf8')).rejects.toThrow(/ENOENT/u)
    } finally {
      if (previous === undefined) {
        delete process.env.CHECKUP_DOCKER_BIN
      } else {
        process.env.CHECKUP_DOCKER_BIN = previous
      }
    }
  })

  it('requires and passes one resolved profile into measured Docker children', () => {
    expect(
      containerProfileArgs({
        CHECKUP_CPU_CEILING: '2',
        CHECKUP_VITEST_WORKERS: '2',
        CHECKUP_COVERAGE_CONCURRENCY: '1',
      }),
    ).toEqual([
      '-e',
      'CHECKUP_CPU_CEILING=2',
      '-e',
      'CHECKUP_VITEST_WORKERS=2',
      '-e',
      'CHECKUP_COVERAGE_CONCURRENCY=1',
      '-e',
      'CHECKUP_REQUIRE_AFFINITY=1',
    ])
    expect(() => containerProfileArgs({})).toThrow(/requires resolved CHECKUP_CPU_CEILING/u)
  })

  it('resolves a mutable browser tag to one immutable image ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-docker-image-id-'))
    const docker = join(root, 'docker')
    const previous = process.env.CHECKUP_DOCKER_BIN
    roots.push(root)
    await writeFile(
      docker,
      `#!/bin/sh
if [ "$1" = image ] && [ "$2" = inspect ]; then
  printf 'sha256:%064d\\n' 0
  exit 0
fi
exit 2
`,
    )
    await chmod(docker, 0o755)
    process.env.CHECKUP_DOCKER_BIN = docker

    try {
      expect(resolveDockerImageId('playwright:tag')).toBe(`sha256:${'0'.repeat(64)}`)
    } finally {
      if (previous === undefined) {
        delete process.env.CHECKUP_DOCKER_BIN
      } else {
        process.env.CHECKUP_DOCKER_BIN = previous
      }
    }
  })
})
