import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createLocalFsFiles } from './localFs'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll a predicate until true or the timeout — fs.watch delivery is async and
 *  platform-paced, so the tests wait on the EFFECT, never a fixed sleep. */
const waitFor = async (pred: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const start = Date.now()

  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout waiting for fs.watch event')
    }
    await sleep(20)
  }
}

const mkroot = (): Promise<string> => fs.mkdtemp(join(tmpdir(), 'nfswatch-'))

describe('localFs.watch (#146)', () => {
  it('fires onChange for an external write and goes quiet after close', async () => {
    const root = await mkroot()

    try {
      const files = createLocalFsFiles(root)
      const paths: Array<string | null> = []
      const unwatch = files.watch!((path) => {
        paths.push(path)
      })
      expect(unwatch).toBeTruthy() // recursive fs.watch engages on this platform

      await fs.writeFile(join(root, 'note.md'), '# hi')
      await waitFor(() => paths.length > 0)
      expect(paths).toContain('note.md')

      unwatch!()
      await sleep(60)
      const afterClose = paths.length
      await fs.writeFile(join(root, 'after.md'), 'written post-close')
      await sleep(150)
      expect(paths).toHaveLength(afterClose) // no events delivered once closed
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('catches a nested write (recursive) and ignores hidden-path churn', async () => {
    const root = await mkroot()

    try {
      const files = createLocalFsFiles(root)
      let hits = 0
      const unwatch = files.watch!(() => {
        hits++
      })

      try {
        // Hidden churn — our own dot-named tmp writes, .git/.obsidian — must not
        // trigger a reconcile (the index never sees these paths anyway).
        await fs.mkdir(join(root, '.obsidian'), { recursive: true })
        await fs.writeFile(join(root, '.obsidian/workspace.json'), '{}')
        await fs.writeFile(join(root, '.scratch.tmp'), 'x')
        await sleep(200)
        expect(hits).toBe(0)

        // A real nested note DOES fire (recursive watch + non-hidden path).
        await fs.mkdir(join(root, 'sub'), { recursive: true })
        await fs.writeFile(join(root, 'sub/deep.md'), 'content')
        await waitFor(() => hits > 0)
      } finally {
        unwatch!()
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('changes the cheap stat token for a same-size rewrite whose mtime is restored', async () => {
    const root = await mkroot()

    try {
      const files = createLocalFsFiles(root)
      const path = join(root, 'note.md')
      const fixed = new Date('2026-07-23T12:00:00.000Z')
      await fs.writeFile(path, 'AAAA')
      await fs.utimes(path, fixed, fixed)
      const before = await files.stat('note.md')
      // Some filesystems quantize ctime to a scheduler tick. Cross that
      // boundary so this tests token semantics rather than timestamp resolution.
      await sleep(20)
      await fs.writeFile(path, 'BBBB')
      await fs.utimes(path, fixed, fixed)
      const after = await files.stat('note.md')

      expect(after?.size).toBe(before?.size)
      expect(after?.mtimeMs).toBe(before?.mtimeMs)
      expect(after?.changeToken).not.toBe(before?.changeToken)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
