import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createNotariumStore } from './createNotariumStore'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const waitFor = async (pred: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const start = Date.now()

  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout waiting for watch signal')
    }
    await sleep(20)
  }
}

describe('NotariumStore watch capability (#146)', () => {
  it('advertises watch over a localfs mount and forwards external-change signals', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nstore-watch-'))
    const store = createNotariumStore({ notesDir: root }) // ':memory:' index

    try {
      expect(store.capabilities.watch).toBe(true)

      let hits = 0
      const unwatch = store.watch(() => {
        hits++
      })
      expect(unwatch).toBeTruthy()

      // An external editor lands a file; the watcher invites a reconcile, and a
      // changes() pull (rescan = truth, P3) actually surfaces it.
      await fs.writeFile(join(root, 'external.md'), '# from another process')
      await waitFor(() => hits > 0)

      const delta = await store.changes(null)
      expect(delta.inventory.some((m) => m.filePath === 'external.md')).toBe(true)

      unwatch!()
    } finally {
      await store.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
