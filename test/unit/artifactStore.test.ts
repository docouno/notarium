// Unit tests for the FS artifact store (#105) — the destructive/safety-carrying ops the
// e2e path doesn't exercise directly: the atomic rename publish, the space-subtree
// removeSpace (with its empty/root guard), the traversal guard, and sweepTempParts (the
// age-based orphan `*.part` reclaim — a `rm` that must delete only aged parts, keep fresh
// ones, ignore non-parts, and never escape one level below the root).

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createFsArtifactStore } from '../../packages/server/src/libs/artifactStore'

describe('createFsArtifactStore (#105)', () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length) {
      await rm(dirs.pop()!, { recursive: true, force: true })
    }
  })
  const make = async () => {
    const d = await mkdtemp(join(tmpdir(), 'notarium-art-'))
    dirs.push(d)
    return d
  }
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    )

  it('rename publishes from→to atomically; removeSpace drops a subtree and refuses the root', async () => {
    const dir = await make()
    const store = createFsArtifactStore(dir)
    const sink = await store.createWriteStream('S/j.part')
    sink.end('data')
    await new Promise((res) => sink.on('finish', res))

    await store.rename('S/j.part', 'S/j.zip')
    expect((await store.stat('S/j.zip'))?.size).toBe(4)
    expect(await store.stat('S/j.part')).toBeNull() // moved away

    await store.removeSpace('S')
    expect(await store.stat('S/j.zip')).toBeNull()
    // Guards: never sweep the whole store, never escape the root.
    await expect(store.removeSpace('')).rejects.toThrow(/refusing/)
    await expect(store.removeSpace('..')).rejects.toThrow(/escapes/)
    await expect(store.stat('../../etc/passwd')).rejects.toThrow(/escapes/)
  })

  it('sweepTempParts removes aged *.part, keeps fresh ones and non-parts, one level only', async () => {
    const dir = await make()
    const store = createFsArtifactStore(dir)
    await mkdir(join(dir, 'S'), { recursive: true })
    const aged = join(dir, 'S', 'j1.lease.part')
    const fresh = join(dir, 'S', 'j2.lease.part')
    const zip = join(dir, 'S', 'j3.zip') // non-part → always kept
    const rootPart = join(dir, 'root.part') // at the root, not under a space dir → skipped

    for (const p of [aged, fresh, zip, rootPart]) {
      await writeFile(p, 'x')
    }
    const now = Date.now()
    await utimes(aged, new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000)) // 2h old

    await store.sweepTempParts!(now - 3600_000) // cutoff: 1h ago (FS store always provides it)

    expect(await exists(aged)).toBe(false) // aged part reclaimed
    expect(await exists(fresh)).toBe(true) // a live run's fresh temp is spared
    expect(await exists(zip)).toBe(true) // published artifact untouched
    expect(await exists(rootPart)).toBe(true) // sweep is one level deep (root/space/*.part)
  })

  it('sweepTempParts on an empty/absent store is a no-op', async () => {
    const dir = await make()
    const store = createFsArtifactStore(dir)
    await expect(store.sweepTempParts!(Date.now())).resolves.toBeUndefined()
  })
})
