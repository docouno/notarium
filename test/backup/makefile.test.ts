import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const roots: string[] = []
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const backupTools = async (root: string): Promise<{ bin: string; syncCount: string }> => {
  const bin = join(root, 'bin')
  const syncCount = join(root, 'sync-count')
  await mkdir(bin)
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nprintf "complete archive"\n')
  await writeFile(
    join(bin, 'sync'),
    `#!/bin/sh
count=0
test ! -f "$SYNC_COUNT_FILE" || read count < "$SYNC_COUNT_FILE"
count=$((count + 1))
printf '%s\\n' "$count" > "$SYNC_COUNT_FILE"
test "$count" -ne "\${FAIL_SYNC_CALL:-0}"
`,
  )
  await Promise.all([chmod(join(bin, 'docker'), 0o755), chmod(join(bin, 'sync'), 0o755)])
  return { bin, syncCount }
}

describe('Makefile backup publication', () => {
  it('does not publish an empty or partial final archive when Docker backup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-backup-'))
    roots.push(root)
    const bin = join(root, 'bin')
    const target = join(root, 'failed.zip')
    await mkdir(bin)
    const fakeDocker = join(bin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\nexit 23\n')
    await chmod(fakeDocker, 0o755)

    const result = spawnSync('make', ['backup', `BACKUP=${target}`], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    await expect(stat(target)).rejects.toThrow(/ENOENT/)
    expect((await readdir(root)).filter((name) => name.includes('.partial-'))).toEqual([])
  })

  it.each([
    { failure: 3, retainedPartial: true, label: 'final directory fsync' },
    { failure: 4, retainedPartial: false, label: 'partial cleanup fsync' },
  ])(
    'treats $label failure after hard-link commit as success',
    async ({ failure, retainedPartial }) => {
      const root = await mkdtemp(join(tmpdir(), 'notarium-make-backup-commit-'))
      roots.push(root)
      const target = join(root, 'backup.zip')
      const { bin, syncCount } = await backupTools(root)

      const result = spawnSync('make', ['backup', `BACKUP=${target}`], {
        cwd: repo,
        env: {
          ...process.env,
          FAIL_SYNC_CALL: String(failure),
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          SYNC_COUNT_FILE: syncCount,
        },
        encoding: 'utf8',
      })

      expect(result.status).toBe(0)
      await expect(readFile(target, 'utf8')).resolves.toBe('complete archive')
      const partials = (await readdir(root)).filter((name) => name.includes('.partial-'))
      expect(partials).toHaveLength(retainedPartial ? 1 : 0)
      expect(result.stderr).toContain('backup warning:')
    },
  )

  it('retains the durable partial when interrupted immediately after hard-link commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-backup-signal-'))
    roots.push(root)
    const target = join(root, 'backup.zip')
    const { bin, syncCount } = await backupTools(root)
    await writeFile(join(bin, 'ln'), '#!/bin/sh\n/bin/ln "$@"\nkill -TERM "$PPID"\nsleep 1\n')
    await chmod(join(bin, 'ln'), 0o755)

    const result = spawnSync('make', ['backup', `BACKUP=${target}`], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        SYNC_COUNT_FILE: syncCount,
      },
      encoding: 'utf8',
      timeout: 5_000,
    })

    expect(result.status).not.toBe(0)
    await expect(readFile(target, 'utf8')).resolves.toBe('complete archive')
    const partials = (await readdir(root)).filter((name) => name.includes('.partial-'))
    expect(partials).toHaveLength(1)
    await expect(readFile(join(root, partials[0]!), 'utf8')).resolves.toBe('complete archive')
  })

  it('retains the durable partial when ln dies after creating the hard link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-backup-ln-kill-'))
    roots.push(root)
    const target = join(root, 'backup.zip')
    const { bin, syncCount } = await backupTools(root)
    await writeFile(join(bin, 'ln'), '#!/bin/sh\n/bin/ln "$@"\nkill -KILL $$\n')
    await chmod(join(bin, 'ln'), 0o755)

    const result = spawnSync('make', ['backup', `BACKUP=${target}`], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        SYNC_COUNT_FILE: syncCount,
      },
      encoding: 'utf8',
      timeout: 5_000,
    })

    expect(result.status).not.toBe(0)
    await expect(readFile(target, 'utf8')).resolves.toBe('complete archive')
    const partials = (await readdir(root)).filter((name) => name.includes('.partial-'))
    expect(partials).toHaveLength(1)
    await expect(readFile(join(root, partials[0]!), 'utf8')).resolves.toBe('complete archive')
  })

  it('reinstates the original DEV data root exactly once when restore is interrupted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-restore-'))
    roots.push(root)
    const bin = join(root, 'bin')
    const data = join(root, 'data')
    const archive = join(root, 'backup.zip')
    await mkdir(bin)
    await mkdir(data)
    await writeFile(join(data, 'original.txt'), 'original data')
    await writeFile(archive, 'fake backup')
    const fakeDocker = join(bin, 'docker')
    await writeFile(
      fakeDocker,
      `#!/bin/sh
case "$*" in
  "compose -f docker/compose.yml -f docker/compose.dev.yml ps -aq notarium")
    echo fake-container
    ;;
  "compose -f docker/compose.yml -f docker/compose.dev.yml ps -q notarium")
    echo fake-container
    ;;
  "inspect --format {{index .Config.Labels \\"com.docker.compose.project.config_files\\"}} fake-container")
    echo "${join(repo, 'docker/compose.yml')},${join(repo, 'docker/compose.dev.yml')}"
    ;;
  *" run --rm --no-deps -T notarium restore")
    kill -TERM "$PPID"
    sleep 0.1
    exit 143
    ;;
esac
exit 0
`,
    )
    await chmod(fakeDocker, 0o755)

    const result = spawnSync(
      'make',
      ['restore', `BACKUP=${archive}`, `RESTORE_DATA_ROOT=${data}`],
      {
        cwd: repo,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
        timeout: 5_000,
      },
    )

    expect(result.status).not.toBe(0)
    expect(await readFile(join(data, 'original.txt'), 'utf8')).toBe('original data')
    const siblings = await readdir(root)
    expect(siblings.filter((name) => name.includes('.before-restore-'))).toEqual([])
    const failed = siblings.filter((name) => name.includes('.failed-restore-'))
    expect(failed).toHaveLength(1)
    await expect(stat(join(root, failed[0]!, 'original.txt'))).rejects.toThrow(/ENOENT/)
  })
})

// --- backup-smoke orchestration ---------------------------------------------
// Both halves of the image lifecycle need pinning, for the reasons in
// docs/dev-environment.md: an image the run never hands back, and a removal that
// addresses anything wider than this run's own tags.

const BUILD_SIGNALS = [
  { name: 'SIGINT', flag: 'INT' },
  { name: 'SIGTERM', flag: 'TERM' },
] as const

type SmokeHarness = {
  bin: string
  dockerLog: string
  driverLog: string
  tmp: string
  tagState: string
}

const smokeHarness = async (
  root: string,
  { dockerBuild, driver }: { dockerBuild?: string; driver?: string } = {},
): Promise<SmokeHarness> => {
  const bin = join(root, 'bin')
  const dockerLog = join(root, 'docker.log')
  const driverLog = join(root, 'driver.log')
  const tmp = join(root, 'tmp')
  const tagState = join(root, 'tags')
  await mkdir(bin)
  await mkdir(tmp)
  await writeFile(tagState, '')
  // Models the one piece of daemon state the recipe branches on: a tag exists only
  // once a build created it. A shim that answers success to everything cannot
  // exercise `image inspect`'s absent branch, and every guard written over such a
  // shim is green by construction. Cases override the BUILD verb only, so the state
  // model stays in force for every scenario.
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
${dockerBuild ?? ''}
case "$1 $2" in
  "image inspect")
    grep -qxF "$3" "$TAG_STATE" 2>/dev/null || exit 1
    exit 0 ;;
  "image rm")
    grep -qxF "$3" "$TAG_STATE" 2>/dev/null || exit 1
    grep -vxF "$3" "$TAG_STATE" > "$TAG_STATE.next" 2>/dev/null
    mv "$TAG_STATE.next" "$TAG_STATE"
    exit 0 ;;
esac
iid=""
tag=""
target=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --iidfile) iid="$arg" ;;
    -t|--tag) tag="$arg" ;;
    --target) target="$arg" ;;
  esac
  prev="$arg"
done
test -z "$tag" || printf '%s\\n' "$tag" >> "$TAG_STATE"
test -z "$iid" || printf 'sha256:%s-image-id\\n' "$target" > "$iid"
exit 0
`,
  )
  // The recipe calls the driver as a bare `node`, so a PATH shim stands in for the
  // real drill. Only the driver invocation is impersonated — make also asks the real
  // node for the package version while it assembles this recipe's environment.
  await writeFile(
    join(bin, 'node'),
    `#!/bin/sh
case "$1" in
  test/backup/smoke.mjs)
${
  driver ??
  `    printf '%s image=%s fixture=%s tmpdir=%s\\n' "$*" "$BACKUP_SMOKE_IMAGE" "$BACKUP_SMOKE_FIXTURE_IMAGE" "$TMPDIR" >> "$DRIVER_LOG"
    exit 0`
}
    ;;
esac
exec ${process.execPath} "$@"
`,
  )
  await Promise.all([chmod(join(bin, 'docker'), 0o755), chmod(join(bin, 'node'), 0o755)])
  return { bin, dockerLog, driverLog, tmp, tagState }
}

const runSmoke = (harness: SmokeHarness, extra: Record<string, string> = {}) =>
  spawnSync('make', ['backup-smoke'], {
    cwd: repo,
    env: {
      ...process.env,
      DOCKER_LOG: harness.dockerLog,
      DRIVER_LOG: harness.driverLog,
      PATH: `${harness.bin}:${process.env.PATH ?? ''}`,
      TAG_STATE: harness.tagState,
      TMPDIR: harness.tmp,
      ...extra,
    },
    encoding: 'utf8',
    timeout: 20_000,
  })

const dockerCalls = async (harness: SmokeHarness): Promise<string[]> =>
  (await readFile(harness.dockerLog, 'utf8')).split('\n').filter(Boolean)

/** Every `-t`/`--tag` value the recipe asked for, however it spelled the flag. */
const tagsCreated = (calls: string[]): string[] =>
  calls
    .filter((call) => call.startsWith('build '))
    .flatMap((call) => {
      const argv = call.split(' ')
      return argv.flatMap((arg, index) =>
        arg === '-t' || arg === '--tag' ? [argv[index + 1]!] : [],
      )
    })

/** The complete set of docker invocations this target is allowed to make, as a
 *  WHITELIST. Enumerating forbidden spellings does not work: `--tag` walked past a
 *  `-t` check, `image prune` past a removal check, and a global flag before the
 *  subcommand past both. Anything the recipe does that is not one of these three
 *  shapes — a wider removal, a prune, a stray `volume rm` — is a failure by default. */
const PERMITTED_DOCKER = [/^build( |$)/, /^image inspect \S+$/, /^image rm \S+$/] as const

const unexpectedDockerCalls = (calls: string[]): string[] =>
  calls.filter((call) => !PERMITTED_DOCKER.some((shape) => shape.test(call)))

/** Image references the recipe asked docker to drop. */
const imagesRemoved = (calls: string[]): string[] =>
  calls.flatMap((call) => {
    const argv = call.split(' ')
    return argv[0] === 'image' && argv[1] === 'rm' ? [argv[2]!] : []
  })

describe('Makefile backup-smoke orchestration', () => {
  it('tags both builds run-uniquely and hands exactly those tags back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-smoke-'))
    roots.push(root)
    const harness = await smokeHarness(root)

    const result = runSmoke(harness, { BACKUP_SMOKE_RUNS: '3' })
    const calls = await dockerCalls(harness)
    const builds = calls.filter((call) => call.startsWith('build '))
    const runs = (await readFile(harness.driverLog, 'utf8')).split('\n').filter(Boolean)
    const tags = tagsCreated(calls)

    expect(result.status).toBe(0)
    expect(builds).toHaveLength(2)
    for (const build of builds) {
      expect(build).toContain('--load')
      expect(build).toContain('--iidfile')
    }
    expect(builds.filter((build) => build.includes('--target runtime'))).toHaveLength(1)
    expect(builds.filter((build) => build.includes('--target builder'))).toHaveLength(1)
    expect(tags).toHaveLength(2)
    expect(imagesRemoved(calls).sort()).toEqual([...tags].sort())
    expect(unexpectedDockerCalls(calls)).toEqual([])
    // Exactly two builds (asserted above) is what proves the images are built once and
    // reused; this only adds that every run got the same environment.
    expect(new Set(runs).size).toBe(1)
    expect(runs).toHaveLength(3)
    expect(runs[0]).toContain('test/backup/smoke.mjs')
    expect(runs[0]).toContain('image=sha256:runtime-image-id')
    expect(runs[0]).toContain('fixture=sha256:builder-image-id')
    expect(runs[0]).toContain(`tmpdir=${harness.tmp}`)
    expect(await readdir(harness.tmp)).toEqual([])
  })

  it('never removes an image by id, and never reuses a tag another run could hold', async () => {
    const first = await mkdtemp(join(tmpdir(), 'notarium-make-smoke-tags-a-'))
    const second = await mkdtemp(join(tmpdir(), 'notarium-make-smoke-tags-b-'))
    roots.push(first, second)
    const harnessA = await smokeHarness(first)
    const harnessB = await smokeHarness(second)

    expect(runSmoke(harnessA).status).toBe(0)
    expect(runSmoke(harnessB).status).toBe(0)
    const tagsA = tagsCreated(await dockerCalls(harnessA))
    const tagsB = tagsCreated(await dockerCalls(harnessB))

    // Only this run's own tags may ever be dropped.
    for (const removed of imagesRemoved(await dockerCalls(harnessA))) {
      expect(removed).not.toMatch(/^sha256:/)
    }
    expect(unexpectedDockerCalls(await dockerCalls(harnessA))).toEqual([])
    // Both tags were created, so the loop above and the filter below are not vacuous.
    expect(tagsA).toHaveLength(2)
    expect(tagsA.every((tag) => tag.startsWith('notarium-backup-smoke:'))).toBe(true)
    expect(tagsA.filter((tag) => tagsB.includes(tag))).toEqual([])
  })

  it.each([
    { runs: '0', reason: 'must be >= 1' },
    { runs: 'abc', reason: 'must be a positive integer' },
    { runs: '', reason: 'must be a positive integer' },
  ])('refuses to report success on BACKUP_SMOKE_RUNS=$runs', async ({ runs, reason }) => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-smoke-runs-'))
    roots.push(root)
    const harness = await smokeHarness(root)

    const result = runSmoke(harness, { BACKUP_SMOKE_RUNS: runs })

    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toContain(reason)
    await expect(stat(harness.driverLog)).rejects.toThrow(/ENOENT/)
    // Before the builds, not after: a typo must not cost two multi-gigabyte images.
    await expect(stat(harness.dockerLog)).rejects.toThrow(/ENOENT/)
  })

  it('removes its temp root and its tags when a build fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-smoke-build-fail-'))
    roots.push(root)
    const harness = await smokeHarness(root, {
      dockerBuild: 'case "$*" in build*) exit 23;; esac',
    })

    const result = runSmoke(harness)
    const calls = await dockerCalls(harness)

    expect(result.status).not.toBe(0)
    await expect(stat(harness.driverLog)).rejects.toThrow(/ENOENT/)
    // The first build never produced a tag, so there is nothing to drop — cleanup
    // asks the daemon rather than firing removals at names that cannot exist.
    expect(imagesRemoved(calls)).toEqual([])
    expect(unexpectedDockerCalls(calls)).toEqual([])
    expect(await readdir(harness.tmp)).toEqual([])
  })

  it.each(BUILD_SIGNALS)(
    'stops instead of resuming into the next build on $name',
    async ({ flag }) => {
      const root = await mkdtemp(join(tmpdir(), 'notarium-make-smoke-signal-'))
      roots.push(root)
      // The signal goes to the recipe shell alone, which is the case an ordinary
      // Ctrl-C does NOT cover: there the whole process group dies anyway. A trap that
      // returns instead of re-raising lets the recipe walk on into the second build.
      const harness = await smokeHarness(root, {
        dockerBuild: `case "$*" in *"--target runtime"*) kill -${flag} "$PPID"; exit 0 ;; esac`,
      })

      const result = runSmoke(harness)
      const calls = await dockerCalls(harness)

      expect(result.status).not.toBe(0)
      expect(calls.filter((call) => call.startsWith('build '))).toHaveLength(1)
      await expect(stat(harness.driverLog)).rejects.toThrow(/ENOENT/)
      // Cleanup runs once, not once per trap: two lookups, and no removal because the
      // interrupted build never got as far as registering a tag.
      expect(calls.filter((call) => call.startsWith('image inspect '))).toHaveLength(2)
      expect(imagesRemoved(calls)).toEqual([])
      expect(unexpectedDockerCalls(calls)).toEqual([])
      expect(await readdir(harness.tmp)).toEqual([])
    },
  )

  it('fails the gate when the drill fails, without starting the remaining runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-smoke-driver-fail-'))
    roots.push(root)
    const harness = await smokeHarness(root, {
      driver: `    printf '%s\\n' "$*" >> "$DRIVER_LOG"\n    exit 7`,
    })

    const result = runSmoke(harness, { BACKUP_SMOKE_RUNS: '3' })
    const runs = (await readFile(harness.driverLog, 'utf8')).split('\n').filter(Boolean)

    // The one property the whole target exists for: a red drill is a red gate.
    expect(result.status).not.toBe(0)
    expect(runs).toHaveLength(1)
    expect(await readdir(harness.tmp)).toEqual([])
  })

  it('fails the run when the driver leaves a workdir in the controlled TMPDIR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-make-smoke-leak-'))
    roots.push(root)
    const harness = await smokeHarness(root, {
      driver: '    mkdir -p "$TMPDIR/notarium-backup-smoke-leaked"\n    exit 0',
    })

    const result = runSmoke(harness)

    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('notarium-backup-smoke-leaked')
    expect(await readdir(harness.tmp)).toEqual([])
  })
})

describe('CI adapter for backup-smoke', () => {
  it('installs the target toolchain and delegates to the one Make entrypoint', async () => {
    // Parsed, not sliced: a blank line inside the job silently ends a text slice, and
    // every negative assertion below then passes by looking at nothing.
    const pipeline = parse(await readFile(join(repo, '.gitlab-ci.yml'), 'utf8')) as Record<
      string,
      { script?: string[]; after_script?: string[]; extends?: string[]; variables?: unknown }
    >
    const job = pipeline['verify:backup-smoke']!
    const script = (job.script ?? []).join('\n')

    expect(job.extends).toContain('.dind')
    // bash because the Makefile declares `SHELL := /bin/bash`, which the docker
    // client image does not carry; without it the target dies before its first line.
    expect(script).toContain('apk add --no-cache nodejs make bash')
    expect(script).toContain('make backup-smoke')
    // The adapter must not restate target builds, image addressing or runtime cleanup.
    // Its only after-script responsibility is the dind builder resource it created.
    expect(script).not.toContain('docker build')
    expect(JSON.stringify(job)).not.toContain('BACKUP_SMOKE_IMAGE')
    expect(job.after_script).toEqual([
      'node scripts/checkup/ciDockerBuilder.mjs remove --name "notarium-ci-$CI_JOB_ID" || true',
    ])
  })
})
