import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

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

describe('backup smoke interruption', () => {
  it('removes its exact containers and volumes before preserving the signal exit code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-backup-smoke-signal-'))
    roots.push(root)
    const bin = join(root, 'bin')
    const log = join(root, 'docker.log')
    const ready = join(root, 'ready')
    const lateResource = join(root, 'late-resource')
    await mkdir(bin)
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  "run --rm fake-smoke-image --help")
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
      env: {
        ...process.env,
        BACKUP_SMOKE_IMAGE: 'fake-smoke-image',
        DOCKER_LOG: log,
        LATE_RESOURCE: lateResource,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        READY_FILE: ready,
      },
      stdio: 'ignore',
    })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveClose, rejectClose) => {
        child.once('error', rejectClose)
        child.once('close', (code, signal) => resolveClose({ code, signal }))
      },
    )

    await waitForFile(ready)
    child.kill('SIGTERM')
    let timeout: ReturnType<typeof setTimeout>
    const result = await Promise.race([
      closed,
      new Promise<never>(
        (_, rejectTimeout) =>
          (timeout = setTimeout(
            () => rejectTimeout(new Error('smoke did not exit after SIGTERM')),
            5_000,
          )),
      ),
    ])
    clearTimeout(timeout!)
    const calls = await readFile(log, 'utf8')

    expect(result).toEqual({ code: 143, signal: null })
    await expect(stat(lateResource)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(calls).toMatch(/rm -f notarium-backup-source-\d+-\d+/)
    expect(calls).toMatch(/rm -f notarium-backup-target-\d+-\d+/)
    expect(calls).toMatch(/volume rm -f notarium-backup-source-\d+-\d+/)
    expect(calls).toMatch(/volume rm -f notarium-backup-target-\d+-\d+/)
    expect(calls.indexOf('late-create')).toBeLessThan(
      calls.indexOf('volume rm -f notarium-backup-source-'),
    )
  }, 10_000)

  it('interrupts an active ordinary cleanup child and repeats exact cleanup', async () => {
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
  "run --rm fake-smoke-image --help")
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
      env: {
        ...process.env,
        BACKUP_SMOKE_IMAGE: 'fake-smoke-image',
        BLOCKED_ONCE: blockedOnce,
        DOCKER_LOG: log,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        READY_FILE: ready,
      },
      stdio: 'ignore',
    })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveClose, rejectClose) => {
        child.once('error', rejectClose)
        child.once('close', (code, signal) => resolveClose({ code, signal }))
      },
    )

    await waitForFile(ready)
    child.kill('SIGTERM')
    let timeout: ReturnType<typeof setTimeout>
    const result = await Promise.race([
      closed,
      new Promise<never>(
        (_, rejectTimeout) =>
          (timeout = setTimeout(
            () => rejectTimeout(new Error('smoke cleanup did not exit after SIGTERM')),
            5_000,
          )),
      ),
    ])
    clearTimeout(timeout!)
    const calls = await readFile(log, 'utf8')

    expect(result).toEqual({ code: 143, signal: null })
    expect(calls.match(/^rm -f notarium-backup-source-\d+-\d+$/gm)).toHaveLength(2)
    expect(calls).toMatch(/cleanup-child-killed/)
    expect(calls).toMatch(/volume rm -f notarium-backup-source-\d+-\d+/)
    expect(calls).toMatch(/volume rm -f notarium-backup-target-\d+-\d+/)
    expect(calls.indexOf('cleanup-child-killed')).toBeLessThan(
      calls.lastIndexOf('rm -f notarium-backup-source-'),
    )
  }, 10_000)
})
