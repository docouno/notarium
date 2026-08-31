import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSourceSnapshot,
  readSnapshotManifest,
  verifySourceSnapshot,
} from '../../scripts/checkup/snapshot.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const repository = async () => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-checkup-snapshot-repo-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, '.gitignore'), 'test/visual/**/*.png\nignored.txt\n')
  await writeFile(join(root, 'src/main.ts'), 'export const value = 1\n')
  await writeFile(join(root, 'src/run.sh'), '#!/bin/sh\necho ok\n')
  await chmod(join(root, 'src/run.sh'), 0o755)
  await symlink('main.ts', join(root, 'src/current.ts'))
  await writeFile(join(root, '.env'), 'SECRET=tracked-but-denied\n')
  await mkdir(join(root, '.docs-local'), { recursive: true })
  await writeFile(join(root, '.docs-local/archive.zip'), 'private bytes')
  const cached = [
    '.docs-local/archive.zip',
    '.env',
    '.gitignore',
    'src/current.ts',
    'src/main.ts',
    'src/run.sh',
  ]
  const state = { deleted: [] as string[], dirty: false, untracked: [] as string[] }
  const inventory = {
    selected: async () => [...cached, ...state.untracked],
    cached: async () => cached,
    deleted: async () => state.deleted,
    status: async () => (state.dirty ? Buffer.from(' M src/main.ts\0') : Buffer.alloc(0)),
  }

  return { root, inventory, state }
}

describe('checkup source snapshot', () => {
  it('captures actual source bytes while denying private/generated paths by rule', async () => {
    const { root, inventory, state } = await repository()
    const session = await mkdtemp(join(tmpdir(), 'notarium-checkup-snapshot-session-'))
    roots.push(session)
    await writeFile(join(root, 'src/main.ts'), 'export const value = 2\n')
    await writeFile(join(root, 'src/untracked.ts'), 'export const untracked = true\n')
    state.untracked.push('src/untracked.ts')
    state.dirty = true
    await mkdir(join(root, 'test/visual/visual.spec.ts-snapshots'), { recursive: true })
    await writeFile(
      join(root, 'test/visual/visual.spec.ts-snapshots/example-chromium.png'),
      'external baseline',
    )
    await writeFile(join(root, 'ignored.txt'), 'must stay out')

    const snapshot = await createSourceSnapshot({ root, sessionRoot: session, inventory })
    const paths = snapshot.rows.map(({ path }) => path)

    expect(snapshot.dirty).toBe(true)
    expect(paths).toContain('src/main.ts')
    expect(paths).toContain('src/untracked.ts')
    expect(paths).toContain('src/current.ts')
    expect(paths).toContain('test/visual/visual.spec.ts-snapshots/example-chromium.png')
    expect(paths).not.toContain('ignored.txt')
    expect(snapshot.denied).toEqual(
      expect.arrayContaining([
        { path: '.env', rule: 'dotenv', tracked: true },
        { path: '.docs-local/archive.zip', rule: 'local-docs', tracked: true },
      ]),
    )
    await expect(readFile(join(snapshot.sourceRoot, 'src/main.ts'), 'utf8')).resolves.toBe(
      'export const value = 2\n',
    )
    expect((await readSnapshotManifest(snapshot.manifestPath)).map(({ path }) => path)).toEqual(
      paths,
    )
  })

  it('keeps the verified snapshot immutable when the live checkout changes later', async () => {
    const { root, inventory } = await repository()
    const session = await mkdtemp(join(tmpdir(), 'notarium-checkup-snapshot-stable-'))
    roots.push(session)
    const snapshot = await createSourceSnapshot({ root, sessionRoot: session, inventory })
    const before = await readFile(join(snapshot.sourceRoot, 'src/main.ts'), 'utf8')

    await writeFile(join(root, 'src/main.ts'), 'export const value = 99\n')

    await expect(readFile(join(snapshot.sourceRoot, 'src/main.ts'), 'utf8')).resolves.toBe(before)
  })

  it('fails when source bytes change between hashing and copying', async () => {
    const { root, inventory } = await repository()
    const session = await mkdtemp(join(tmpdir(), 'notarium-checkup-snapshot-drift-'))
    roots.push(session)

    await expect(
      createSourceSnapshot({
        root,
        sessionRoot: session,
        inventory,
        beforeCopy: async (path: string) => {
          if (path === 'src/main.ts') {
            await writeFile(join(root, path), 'export const drift = true\n')
          }
        },
      }),
    ).rejects.toThrow('source drifted while snapshotting file src/main.ts')
    await expect(stat(session)).resolves.toBeDefined()
  })

  it('removes an internally-owned session root when snapshot construction fails', async () => {
    const { root, inventory } = await repository()
    const parent = await mkdtemp(join(tmpdir(), 'notarium-checkup-snapshot-owned-parent-'))
    const session = join(parent, 'session')
    roots.push(parent)

    await expect(
      createSourceSnapshot({
        root,
        inventory,
        temporaryRootFactory: async () => {
          await mkdir(session, { recursive: true })
          return session
        },
        beforeCopy: async (path: string) => {
          if (path === 'src/main.ts') {
            throw new Error('injected snapshot failure')
          }
        },
      }),
    ).rejects.toThrow('injected snapshot failure')
    await expect(stat(session)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects a consumer that mutates the verified source instead of its work copy', async () => {
    const { root, inventory } = await repository()
    const session = await mkdtemp(join(tmpdir(), 'notarium-checkup-snapshot-tamper-'))
    roots.push(session)
    const snapshot = await createSourceSnapshot({ root, sessionRoot: session, inventory })
    await writeFile(join(snapshot.sourceRoot, 'src/main.ts'), 'tampered\n')

    await expect(verifySourceSnapshot(snapshot)).rejects.toThrow(
      'snapshot file changed after verification: src/main.ts',
    )
  })

  it('rejects files and directories that are not declared by the snapshot manifest', async () => {
    const { root, inventory } = await repository()
    const session = await mkdtemp(join(tmpdir(), 'notarium-checkup-snapshot-extra-'))
    roots.push(session)
    const snapshot = await createSourceSnapshot({ root, sessionRoot: session, inventory })

    await mkdir(join(snapshot.sourceRoot, 'late'), { recursive: true })
    await writeFile(join(snapshot.sourceRoot, 'late/injected.ts'), 'export const late = true\n')

    await expect(verifySourceSnapshot(snapshot)).rejects.toThrow(
      'snapshot contains path outside manifest: late',
    )
  })

  it('accepts a tracked deletion but refuses an untracked disappearance', async () => {
    const tracked = await repository()
    const trackedSession = await mkdtemp(join(tmpdir(), 'notarium-checkup-snapshot-deleted-'))
    roots.push(trackedSession)
    await rm(join(tracked.root, 'src/main.ts'))
    tracked.state.deleted.push('src/main.ts')
    tracked.state.dirty = true

    await expect(
      createSourceSnapshot({
        root: tracked.root,
        sessionRoot: trackedSession,
        inventory: tracked.inventory,
      }),
    ).resolves.toMatchObject({ dirty: true })

    const untracked = await repository()
    const untrackedSession = await mkdtemp(join(tmpdir(), 'notarium-checkup-snapshot-vanished-'))
    roots.push(untrackedSession)
    await writeFile(join(untracked.root, 'src/vanished.ts'), 'vanish\n')
    untracked.state.untracked.push('src/vanished.ts')
    untracked.state.dirty = true

    await expect(
      createSourceSnapshot({
        root: untracked.root,
        sessionRoot: untrackedSession,
        inventory: untracked.inventory,
        beforeCopy: async (path: string) => {
          if (path === 'src/vanished.ts') {
            await rm(join(untracked.root, path))
          }
        },
      }),
    ).rejects.toThrow(/source (drifted|disappeared) while snapshotting/)
  })
})
