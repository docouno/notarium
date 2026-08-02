// The embed backfill yields to the process-global scheduler: the loop must
// await a turn from the injected BackgroundGate BEFORE each note, so a gate that
// holds the turn back parks the backfill (no CPU/sqlite churn) and releasing it
// resumes embedding. Uses the REAL vec0 driver with a deterministic mock embedder
// (no onnxruntime) — skipped where vec0's native binary can't load.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackgroundGate } from '@notarium/core'

import type { Embedder } from '../../libs/embedding'
import { createLocalFsFiles } from '../../libs/files'
import { createNodeSqliteDriver, type SqlDriver } from '../../libs/sql'
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

const userMount = (dir: string): EngineMount => ({
  class: 'user-doc',
  prefix: '',
  files: createLocalFsFiles(dir),
})

const vecCount = (sql: SqlDriver): Promise<number> =>
  sql.get<{ n: number }>(`SELECT count(*) AS n FROM note_vectors`).then((r) => r?.n ?? 0)

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A controllable gate: counts awaitTurn calls and can hold the loop at the gate. */
const controllableGate = () => {
  let calls = 0
  let blocking = false
  let release: (() => void) | null = null
  const gate: BackgroundGate = {
    awaitTurn: async () => {
      calls++
      if (blocking) {
        await new Promise<void>((resolve) => (release = resolve))
      }
    },
  }
  return {
    gate,
    get calls() {
      return calls
    },
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

// Unconditional (no vec0 needed): the degradation contract. An FTS-only engine has
// no background embedding, so the scheduler must never be consulted — the gate is an
// optional capability, engaged ONLY when there is real embed work. (The full loop↔gate
// integration below needs the vec0 native binary and is skipped where it can't load;
// that path runs in the canonical host unit CI where vec0 is present.)
describe('embed backfill scheduler — degradation', () => {
  let notesDir: string
  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), 'notarium-bg0-'))
  })
  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true })
  })

  it('an FTS-only engine (no embedder) never engages the scheduler', async () => {
    const sql = createNodeSqliteDriver(':memory:') // no vec extension
    const ctl = controllableGate()
    const store = new NotariumStore({ mounts: [userMount(notesDir)], sql, scheduler: ctl.gate })

    try {
      await store.write({ title: 'One', content: 'no vectors here.' })
      await tick()
      await tick()
      expect(ctl.calls).toBe(0) // no embed loop → awaitTurn never called
    } finally {
      await store.stop()
    }
  })
})

describeVector('embed backfill yields to the scheduler', () => {
  let notesDir: string
  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), 'notarium-bg-'))
  })
  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true })
  })

  it('awaits a turn from the gate before each embedded note', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const ctl = controllableGate()
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mockEmbedder(),
      scheduler: ctl.gate,
    })

    try {
      await store.write({ title: 'One', content: 'first note body.' })
      await store.write({ title: 'Two', content: 'second note body.' })
      await store.write({ title: 'Three', content: 'third note body.' })
      await store.whenVectorsSettled()
      expect(await vecCount(sql)).toBe(3) // all embedded
      expect(ctl.calls).toBeGreaterThanOrEqual(3) // one turn taken per note
    } finally {
      await store.stop()
    }
  })

  it('a held gate parks the backfill; releasing it resumes embedding', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const ctl = controllableGate()
    ctl.block() // hold the very first turn
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mockEmbedder(),
      scheduler: ctl.gate,
    })

    try {
      await store.write({ title: 'Pending', content: 'awaiting a turn.' })
      // The loop is parked at the gate — no embed has run, the partition stays empty.
      await tick()
      await tick()
      expect(await vecCount(sql)).toBe(0)
      expect(ctl.calls).toBeGreaterThanOrEqual(1)

      ctl.unblock() // grant the turn
      await store.whenVectorsSettled()
      expect(await vecCount(sql)).toBe(1) // now embedded
    } finally {
      ctl.unblock()
      await store.stop()
    }
  })
})
