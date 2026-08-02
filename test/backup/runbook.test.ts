import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const roots: string[] = []
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
let backupDoc = ''

beforeAll(async () => {
  backupDoc = await readFile(join(repo, 'docs/backup.md'), 'utf8')
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const codeBlockContaining = (needle: string): string => {
  const block = [...backupDoc.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((match) => match[1]!)
    .find((candidate) => candidate.includes(needle))

  if (!block) {
    throw new Error(`backup runbook block not found: ${needle}`)
  }

  return block
}

const failingDocker = async (root: string): Promise<{ bin: string; log: string }> => {
  const bin = join(root, 'bin')
  const log = join(root, 'docker.log')
  await mkdir(bin)
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  "inspect --format {{.Image}} notarium")
    echo sha256:notarium-test
    ;;
  "inspect --format {{.Config.Image}} notarium")
    echo notarium:mutable
    ;;
  *" restore")
    exit 23
    ;;
esac
exit 0
`,
  )
  await chmod(join(bin, 'docker'), 0o755)
  return { bin, log }
}

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
test "$count" -ne "$FAIL_SYNC_CALL"
`,
  )
  await Promise.all([chmod(join(bin, 'docker'), 0o755), chmod(join(bin, 'sync'), 0o755)])
  return { bin, syncCount }
}

describe('backup restore runbooks', () => {
  it.each([
    { needle: 'docker compose exec -T notarium backup', failure: 3, retainedPartial: true },
    { needle: 'docker compose exec -T notarium backup', failure: 4, retainedPartial: false },
    { needle: 'docker exec notarium backup >', failure: 3, retainedPartial: true },
    { needle: 'docker exec notarium backup >', failure: 4, retainedPartial: false },
  ])(
    'keeps $needle successful after post-commit sync failure $failure',
    async ({ needle, failure, retainedPartial }) => {
      const root = await mkdtemp(join(tmpdir(), 'notarium-backup-runbook-'))
      roots.push(root)
      const { bin, syncCount } = await backupTools(root)

      const result = spawnSync('sh', ['-c', codeBlockContaining(needle)], {
        cwd: root,
        env: {
          ...process.env,
          FAIL_SYNC_CALL: String(failure),
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          SYNC_COUNT_FILE: syncCount,
        },
        encoding: 'utf8',
      })

      expect(result.status).toBe(0)
      const names = await readdir(root)
      const finals = names.filter((name) => name.endsWith('.zip'))
      const partials = names.filter((name) => name.includes('.partial.'))
      expect(finals).toHaveLength(1)
      await expect(readFile(join(root, finals[0]!), 'utf8')).resolves.toBe('complete archive')
      expect(partials).toHaveLength(retainedPartial ? 1 : 0)
      expect(result.stderr).toContain('backup warning:')
    },
  )

  it.each(['docker compose exec -T notarium backup', 'docker exec notarium backup >'])(
    'retains recovery bytes when %s is interrupted just after link',
    async (needle) => {
      const root = await mkdtemp(join(tmpdir(), 'notarium-backup-runbook-signal-'))
      roots.push(root)
      const { bin, syncCount } = await backupTools(root)
      await writeFile(join(bin, 'ln'), '#!/bin/sh\n/bin/ln "$@"\nkill -TERM "$PPID"\nsleep 1\n')
      await chmod(join(bin, 'ln'), 0o755)

      const result = spawnSync('sh', ['-c', codeBlockContaining(needle)], {
        cwd: root,
        env: {
          ...process.env,
          FAIL_SYNC_CALL: '0',
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          SYNC_COUNT_FILE: syncCount,
        },
        encoding: 'utf8',
        timeout: 5_000,
      })
      const names = await readdir(root)
      const final = names.find((name) => name.endsWith('.zip'))
      const partial = names.find((name) => name.includes('.partial.'))

      expect(result.status).not.toBe(0)
      expect(final).toBeDefined()
      expect(partial).toBeDefined()
      await expect(readFile(join(root, final!), 'utf8')).resolves.toBe('complete archive')
      await expect(readFile(join(root, partial!), 'utf8')).resolves.toBe('complete archive')
    },
  )

  it.each(['docker compose exec -T notarium backup', 'docker exec notarium backup >'])(
    'retains recovery bytes when child ln dies after linking in %s',
    async (needle) => {
      const root = await mkdtemp(join(tmpdir(), 'notarium-backup-runbook-ln-kill-'))
      roots.push(root)
      const { bin, syncCount } = await backupTools(root)
      await writeFile(join(bin, 'ln'), '#!/bin/sh\n/bin/ln "$@"\nkill -KILL $$\n')
      await chmod(join(bin, 'ln'), 0o755)

      const result = spawnSync('sh', ['-c', codeBlockContaining(needle)], {
        cwd: root,
        env: {
          ...process.env,
          FAIL_SYNC_CALL: '0',
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          SYNC_COUNT_FILE: syncCount,
        },
        encoding: 'utf8',
        timeout: 5_000,
      })
      const names = await readdir(root)
      const final = names.find((name) => name.endsWith('.zip'))
      const partial = names.find((name) => name.includes('.partial.'))

      expect(result.status).not.toBe(0)
      expect(final).toBeDefined()
      expect(partial).toBeDefined()
      await expect(readFile(join(root, final!), 'utf8')).resolves.toBe('complete archive')
      await expect(readFile(join(root, partial!), 'utf8')).resolves.toBe('complete archive')
    },
  )

  it('does not restart Compose when restore validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-compose-runbook-'))
    roots.push(root)
    const { bin, log } = await failingDocker(root)
    await writeFile(join(root, 'notarium-20260722.zip'), 'invalid archive')

    const result = spawnSync('sh', ['-c', codeBlockContaining('docker compose stop notarium')], {
      cwd: root,
      env: {
        ...process.env,
        DOCKER_LOG: log,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
    })

    expect(result.status).toBe(23)
    expect(await readFile(log, 'utf8')).not.toContain('compose up')
  })

  it('does not rename the original bare container when restore validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-bare-runbook-'))
    roots.push(root)
    const { bin, log } = await failingDocker(root)
    await writeFile(join(root, 'notarium-backup.zip'), 'invalid archive')

    const result = spawnSync('sh', ['-c', codeBlockContaining('image_id="$(docker inspect')], {
      cwd: root,
      env: {
        ...process.env,
        DOCKER_LOG: log,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
    })
    const calls = await readFile(log, 'utf8')

    expect(result.status).toBe(23)
    expect(calls).not.toContain('rename notarium')
    expect(calls).not.toContain('run -d --name notarium')
  })
})
