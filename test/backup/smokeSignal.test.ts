import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Both signals, one contract: the drill removes its exact named resources and then
// reports the interruption the way a shell expects it. The codes are the shell's
// 128+N convention, not a preference — a wrapper that swallowed them would make
// `make backup-smoke` look like an ordinary failure to whoever pressed Ctrl-C.
const SIGNALS = [
  { signal: 'SIGINT', code: 130 },
  { signal: 'SIGTERM', code: 143 },
] as const

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const smokeEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  BACKUP_SMOKE_IMAGE: 'fake-smoke-image',
  BACKUP_SMOKE_FIXTURE_IMAGE: 'fake-fixture-image',
  // Keep the harness on the same command shape as the exact-affinity CI carrier.
  // Otherwise the fake can accept a command production never emits and hide a drift
  // in resource propagation until the full coverage job.
  CHECKUP_CPUSET: '0-3',
  ...extra,
})

/** The driver mkdtemps its workdir under TMPDIR; pointing that at a directory the
 *  test owns is the only way to see whether a signal path removes it. */
const workdirsIn = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((name) => name.startsWith('notarium-backup-smoke-'))

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 5_000

  while (Date.now() < deadline) {
    try {
      await stat(path)
      return
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

const waitForFileOrExit = async (
  path: string,
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> => {
  const first = await Promise.race([
    waitForFile(path).then(() => ({ kind: 'ready' }) as const),
    closed.then((result) => ({ kind: 'exit', result }) as const),
  ])

  if (first.kind === 'exit') {
    throw new Error(
      `backup smoke exited before readiness (code=${String(first.result.code)}, signal=${String(first.result.signal)})`,
    )
  }
}

describe('backup smoke interruption', () => {
  it.each(SIGNALS)(
    'removes its exact containers and volumes before preserving $signal',
    async ({ signal, code }) => {
      const root = await mkdtemp(join(tmpdir(), 'notarium-backup-smoke-signal-'))
      roots.push(root)
      const bin = join(root, 'bin')
      const log = join(root, 'docker.log')
      const ready = join(root, 'ready')
      const lateResource = join(root, 'late-resource')
      const driverTmp = join(root, 'tmp')
      await mkdir(bin)
      await mkdir(driverTmp)
      await writeFile(
        join(bin, 'docker'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  "run --cpuset-cpus 0-3 --rm fake-smoke-image --help")
    printf 'backup verify\\n'
    ;;
  "volume create notarium-backup-source-"*)
    : > "$READY_FILE"
    trap 'sleep 0.2; : > "$LATE_RESOURCE"; printf "%s\\n" late-create >> "$DOCKER_LOG"; exit 143' TERM INT
    while :; do sleep 1; done
    ;;
  "volume rm -f notarium-backup-source-"*)
    rm -f "$LATE_RESOURCE"
    ;;
esac
exit 0
`,
      )
      await chmod(join(bin, 'docker'), 0o755)

      const child = spawn(process.execPath, ['test/backup/smoke.mjs'], {
        cwd: repo,
        env: smokeEnv({
          DOCKER_LOG: log,
          LATE_RESOURCE: lateResource,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          READY_FILE: ready,
          TMPDIR: driverTmp,
        }),
        stdio: 'ignore',
      })
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveClose, rejectClose) => {
          child.once('error', rejectClose)
          child.once('close', (exitCode, exitSignal) =>
            resolveClose({ code: exitCode, signal: exitSignal }),
          )
        },
      )

      await waitForFileOrExit(ready, closed)
      child.kill(signal)
      let timeout: ReturnType<typeof setTimeout>
      const result = await Promise.race([
        closed,
        new Promise<never>(
          (_, rejectTimeout) =>
            (timeout = setTimeout(
              () => rejectTimeout(new Error(`smoke did not exit after ${signal}`)),
              5_000,
            )),
        ),
      ])
      clearTimeout(timeout!)
      const calls = await readFile(log, 'utf8')

      expect(result).toEqual({ code, signal: null })
      await expect(stat(lateResource)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await workdirsIn(driverTmp)).toEqual([])
      expect(calls).toMatch(/^run --cpuset-cpus 0-3 --rm fake-smoke-image --help$/m)
      // Anchored: unanchored, every one of these is also satisfied by the
      // `volume rm -f …` lines below, and dropping a container from cleanup stays green.
      expect(calls).toMatch(/^rm -f notarium-backup-source-\d+-\d+$/m)
      expect(calls).toMatch(/^rm -f notarium-backup-target-\d+-\d+$/m)
      expect(calls).toMatch(/^rm -f notarium-backup-fixture-create-\d+-\d+$/m)
      expect(calls).toMatch(/^rm -f notarium-backup-fixture-source-\d+-\d+$/m)
      expect(calls).toMatch(/^rm -f notarium-backup-fixture-target-\d+-\d+$/m)
      expect(calls).toMatch(/^volume rm -f notarium-backup-source-\d+-\d+$/m)
      expect(calls).toMatch(/^volume rm -f notarium-backup-target-\d+-\d+$/m)
      expect(calls.indexOf('late-create')).toBeLessThan(
        calls.indexOf('volume rm -f notarium-backup-source-'),
      )
    },
    10_000,
  )

  it.each(SIGNALS)(
    'interrupts an active ordinary cleanup child and repeats exact cleanup on $signal',
    async ({ signal, code }) => {
      const root = await mkdtemp(join(tmpdir(), 'notarium-backup-cleanup-signal-'))
      roots.push(root)
      const bin = join(root, 'bin')
      const log = join(root, 'docker.log')
      const ready = join(root, 'ready')
      const blockedOnce = join(root, 'blocked-once')
      await mkdir(bin)
      await writeFile(
        join(bin, 'docker'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  "run --cpuset-cpus 0-3 --rm fake-smoke-image --help")
    printf 'invalid help\\n'
    ;;
  "rm -f notarium-backup-source-"*)
    if [ ! -e "$BLOCKED_ONCE" ]; then
      : > "$BLOCKED_ONCE"
      : > "$READY_FILE"
      trap 'printf "%s\\n" cleanup-child-killed >> "$DOCKER_LOG"; exit 143' TERM INT
      while :; do sleep 1; done
    fi
    ;;
esac
exit 0
`,
      )
      await chmod(join(bin, 'docker'), 0o755)

      const child = spawn(process.execPath, ['test/backup/smoke.mjs'], {
        cwd: repo,
        env: smokeEnv({
          BLOCKED_ONCE: blockedOnce,
          DOCKER_LOG: log,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          READY_FILE: ready,
        }),
        stdio: 'ignore',
      })
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveClose, rejectClose) => {
          child.once('error', rejectClose)
          child.once('close', (exitCode, exitSignal) =>
            resolveClose({ code: exitCode, signal: exitSignal }),
          )
        },
      )

      await waitForFileOrExit(ready, closed)
      child.kill(signal)
      let timeout: ReturnType<typeof setTimeout>
      const result = await Promise.race([
        closed,
        new Promise<never>(
          (_, rejectTimeout) =>
            (timeout = setTimeout(
              () => rejectTimeout(new Error(`smoke cleanup did not exit after ${signal}`)),
              5_000,
            )),
        ),
      ])
      clearTimeout(timeout!)
      const calls = await readFile(log, 'utf8')

      expect(result).toEqual({ code, signal: null })
      expect(calls.match(/^rm -f notarium-backup-source-\d+-\d+$/gm)).toHaveLength(2)
      expect(calls).toMatch(/cleanup-child-killed/)
      expect(calls).toMatch(/volume rm -f notarium-backup-source-\d+-\d+/)
      expect(calls).toMatch(/volume rm -f notarium-backup-target-\d+-\d+/)
      expect(calls.indexOf('cleanup-child-killed')).toBeLessThan(
        calls.lastIndexOf('rm -f notarium-backup-source-'),
      )
    },
    10_000,
  )
})
