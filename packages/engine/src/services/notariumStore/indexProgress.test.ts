// The search-mode + embed-backfill progress the sync indicator shows: the
// engine reports an honest per-space `engine.vector` block from cheap in-memory
// counters (capabilities.vector → mode, pendingEmbed.size → pending, noteCount →
// total), and nudges subscribers via onIndexProgress as the backfill drains. The
// vector path uses the REAL vec0 driver with a deterministic mock embedder (no
// onnxruntime) — skipped where vec0's native binary can't load; the FTS-mode and
// degradation contract run unconditionally.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BackgroundGate } from '@notarium/core'
import type { Embedder } from '../../libs/embedding'
import { createLocalFsFiles } from '../../libs/files'
import { createNodeSqliteDriver } from '../../libs/sql'
import { NotariumStore } from './notariumStore'
import type { EngineMount } from './types'
import { describeVector } from './vectorGate.fixture'

/** Instant deterministic embedder — distinct text → distinct unit vector. */
const mockEmbedder = (dimensions = 4): Embedder => ({
  id: 'mock@v1',
  dimensions,
  embed: async (texts) =>
    texts.map((t) => {
      const v = new Float32Array(dimensions)

      for (let i = 0; i < t.length; i++) {
        v[i % dimensions] += t.charCodeAt(i) + 1
      }
      let norm = 0

      for (const x of v) {
        norm += x * x
      }
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < dimensions; i++) {
        v[i] /= norm
      }

      return v
    }),
})

/** A gate that can park the embed loop at its first turn, so a test can observe
 *  the queue mid-flight (pending = written-but-unembedded) before releasing it. */
const controllableGate = () => {
  let blocking = false
  let release: (() => void) | null = null
  const gate: BackgroundGate = {
    awaitTurn: async () => {
      if (blocking) {
        await new Promise<void>((resolve) => (release = resolve))
      }
    },
  }
  return {
    gate,
    block: () => {
      blocking = true
    },
    unblock: () => {
      blocking = false
      release?.()
      release = null
    },
  }
}

const userMount = (dir: string): EngineMount => ({
  class: 'user-doc',
  prefix: '',
  files: createLocalFsFiles(dir),
})
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('engine.vector status — FTS-only degradation', () => {
  let notesDir: string
  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), 'notarium-ip0-'))
  })
  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true })
  })

  it('reports mode fts, zero pending, total = note count — no embed ticks', async () => {
    const sql = createNodeSqliteDriver(':memory:') // no vec extension, no embedder
    const store = new NotariumStore({ mounts: [userMount(notesDir)], sql })

    try {
      let ticks = 0
      store.onIndexProgress(() => ticks++)
      await store.write({ title: 'One', content: 'body one.' })
      await store.write({ title: 'Two', content: 'body two.' })
      await store.changes(null) // force a rescan so noteCount reflects the writes
      await tick()

      const st = await store.syncStatus()
      expect(st.engine.vector).toEqual({ mode: 'fts', pending: 0, total: 2 })
      expect(ticks).toBe(0) // no vector channel → the embed loop never runs
    } finally {
      await store.stop()
    }
  })
})

describeVector('engine.vector status — vector backfill', () => {
  let notesDir: string
  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), 'notarium-ip1-'))
  })
  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true })
  })

  it('reports mode vector, pending draining to 0, and ticks per embedded note', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const ctl = controllableGate()
    ctl.block() // park the loop so we can catch the queue mid-flight
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mockEmbedder(),
      scheduler: ctl.gate,
    })

    try {
      let ticks = 0
      store.onIndexProgress(() => ticks++)
      await store.write({ title: 'One', content: 'first note body.' })
      await store.write({ title: 'Two', content: 'second note body.' })
      await store.write({ title: 'Three', content: 'third note body.' })
      await store.changes(null) // rescan → total = 3
      await tick()

      // Parked at the gate: mode is vector, nothing embedded yet, all three pending.
      let st = await store.syncStatus()
      expect(st.engine.vector?.mode).toBe('vector')
      expect(st.engine.vector?.total).toBe(3)
      expect(st.engine.vector?.pending).toBe(3)

      // Release the gate and let the backfill drain.
      ctl.unblock()
      await store.whenVectorsSettled()

      st = await store.syncStatus()
      expect(st.engine.vector).toEqual({ mode: 'vector', pending: 0, total: 3 })
      expect(ticks).toBeGreaterThanOrEqual(3) // one progress nudge per embedded note
    } finally {
      await store.stop()
    }
  })

  it('a closed onIndexProgress subscription stops receiving ticks', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mockEmbedder(),
    })

    try {
      let ticks = 0
      const unsub = store.onIndexProgress(() => ticks++)
      unsub?.()
      await store.write({ title: 'One', content: 'body.' })
      await store.whenVectorsSettled()
      expect(ticks).toBe(0) // unsubscribed before any embed
    } finally {
      await store.stop()
    }
  })
})
