import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

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
