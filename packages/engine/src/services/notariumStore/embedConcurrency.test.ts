// Concurrent embed backfill: the store's background loop must launch up to
// `embedder.concurrency` embedNote()s AT ONCE (so a worker pool parallelises the
// backfill across the cores), never more, and fall back to strictly serial when the
// embedder reports concurrency 1 (the single in-process embedder). Uses the
// REAL vec0 driver with a GATED mock embedder (no onnxruntime): each embed() blocks on
// a gate the test releases, so we can freeze the loop mid-flight and count how many
// notes embed simultaneously. Skipped where vec0's native binary can't load.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { Embedder } from '../../libs/embedding'
import { createLocalFsFiles } from '../../libs/files'
import { createNodeSqliteDriver } from '../../libs/sql'
import { NotariumStore } from './notariumStore'
import { type EngineMount, engineMountOf } from './types'
import { describeVector } from './vectorGate.fixture'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A mock embedder that reports `concurrency` and BLOCKS each embed on a per-call gate,
 *  tracking how many run at once — so a test can assert the loop's in-flight cap. */
const gatedEmbedder = (concurrency: number, dimensions = 8) => {
  const state = { inFlight: 0, maxInFlight: 0, total: 0, gates: [] as Array<() => void> }
  const embedder: Embedder = {
    id: 'mock@v1',
    dimensions,
    concurrency,
    embed: async (texts) => {
      state.inFlight++
      state.total++
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      await new Promise<void>((resolve) => state.gates.push(resolve))
      state.inFlight--
      return texts.map((t) => {
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
      })
    },
  }
  return { embedder, state }
}

const userMount = (dir: string): EngineMount =>
  engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(dir))

/** Like gatedEmbedder but tracks concurrency PER embed-input (so per note): a second
 *  concurrent embed of the SAME text bumps maxPerKey to 2. Gates carry their key so a
 *  test can release one note's embed while another stays parked. */
const perNoteEmbedder = (concurrency: number, dimensions = 8) => {
  const state = {
    live: new Map<string, number>(),
    maxPerKey: 0,
    gates: [] as Array<{ key: string; release: () => void }>,
  }
  const embedder: Embedder = {
    id: 'mock@v1',
    dimensions,
    concurrency,
    embed: async (texts) => {
      const key = texts.join(' | ')
      const n = (state.live.get(key) ?? 0) + 1
      state.live.set(key, n)
      state.maxPerKey = Math.max(state.maxPerKey, n)
      await new Promise<void>((release) => state.gates.push({ key, release }))
      state.live.set(key, state.live.get(key)! - 1)
      return texts.map((t) => {
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
      })
    },
  }
  return { embedder, state }
}

const releaseGateFor = (
  state: { gates: Array<{ key: string; release: () => void }> },
  substr: string,
): void => {
  const idx = state.gates.findIndex((g) => g.key.includes(substr))

  if (idx >= 0) {
    state.gates.splice(idx, 1)[0]!.release()
  }
}

/** Release gates across all dispatch waves until the backfill drains. */
const settle = async (store: NotariumStore, state: { gates: Array<() => void> }): Promise<void> => {
  let settled = false
  void store.whenVectorsSettled().then(() => {
    settled = true
  })
  for (let i = 0; i < 200 && !settled; i++) {
    while (state.gates.length) {
      state.gates.shift()!()
    }
    await tick()
  }
  await store.whenVectorsSettled()
}

describeVector('NotariumStore concurrent embed backfill', () => {
  let notesDir: string
  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), 'notarium-embconc-'))
  })
  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true })
  })

  it('embeds up to `concurrency` notes at once, never more', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const { embedder, state } = gatedEmbedder(3)
    const store = new NotariumStore({ mounts: [userMount(notesDir)], sql, embedder })

    try {
      // Fill the queue BEFORE the loop drains it (as the boot backfill does —
      // enqueueMissingVectors enqueues the whole corpus up front), so the refill sees
      // all 7 at once. suspendBackground parks the loop while the writes enqueue; resume
      // starts it against a full queue. (A trickle of writes would correctly embed only
      // as many as are pending at each refill — parallelism you can't have yet.)
      store.suspendBackground()
      for (let i = 0; i < 7; i++) {
        await store.write({ title: `Note ${i}`, content: `Body of note ${i}.` })
      }
      store.resumeBackground()
      // Let the loop reach steady state — it should saturate at exactly 3 in flight.
      for (let i = 0; i < 8 && state.inFlight < 3; i++) {
        await tick()
      }
      expect(state.inFlight).toBe(3)
      expect(state.maxInFlight).toBe(3)
      await settle(store, state)
      expect(state.maxInFlight).toBe(3) // cap held across the whole drain
      const n = await sql.get<{ n: number }>(`SELECT count(*) AS n FROM note_vectors`)
      expect(n!.n).toBe(7) // every note embedded
    } finally {
      state.gates.splice(0).forEach((g) => g())
      await store.stop()
    }
  })

  it('never embeds the SAME rowid twice concurrently when it is re-enqueued mid-flight', async () => {
    // The regression the in-flight-rowid guard closes: with C>=2, a note re-enqueued
    // (an edit/rescan) while its prior embed is still in flight must NOT start a second
    // overlapping embedNote — the two would interleave their non-transactional vec0 writes
    // into duplicate/stale vectors that embedded_hash then marks complete.
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const { embedder, state } = perNoteEmbedder(3)
    const store = new NotariumStore({ mounts: [userMount(notesDir)], sql, embedder })

    try {
      store.suspendBackground()
      const alpha = await store.write({ title: 'Alpha', content: 'alpha unique body' })
      const alphaPath = alpha.filePath!
      await store.write({ title: 'Beta', content: 'beta unique body' })
      store.resumeBackground()
      // Both notes reach the gated embed (2 in flight).
      for (let i = 0; i < 10 && state.gates.length < 2; i++) {
        await tick()
      }
      expect(state.gates.length).toBe(2)
      // Re-enqueue Alpha while its embed is still in flight (same content still re-enqueues).
      // An edit by path, not a second create: the latter is refused onto an occupied path (#274).
      await store.write({ title: 'Alpha', content: 'alpha unique body', originalId: alphaPath })
      // Free Beta's slot so the loop refills: it MUST skip the in-flight Alpha, not launch a
      // second concurrent Alpha embed. Give it several turns to (mis)behave.
      releaseGateFor(state, 'beta')
      for (let i = 0; i < 10; i++) {
        await tick()
      }
      expect(state.maxPerKey).toBe(1) // Alpha never embedded twice at once
      // Drain the rest and confirm the invariant held throughout + no duplicate vectors.
      for (let i = 0; i < 50 && state.gates.length; i++) {
        state.gates.shift()!.release()
        await tick()
      }
      await store.whenVectorsSettled()
      expect(state.maxPerKey).toBe(1)
      const dup = await sql.get<{ n: number }>(
        `SELECT COALESCE(MAX(c),0) AS n FROM (SELECT count(*) AS c FROM note_vectors GROUP BY note_rowid, chunk_index)`,
      )
      expect(dup!.n).toBe(1) // no duplicate (note_rowid, chunk_index) rows
    } finally {
      state.gates.splice(0).forEach((g) => g.release())
      await store.stop()
    }
  })

  it('stays strictly serial when the embedder reports concurrency 1', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const { embedder, state } = gatedEmbedder(1)
    const store = new NotariumStore({ mounts: [userMount(notesDir)], sql, embedder })

    try {
      store.suspendBackground()
      for (let i = 0; i < 5; i++) {
        await store.write({ title: `Note ${i}`, content: `Body ${i}.` })
      }
      store.resumeBackground()
      for (let i = 0; i < 8 && state.inFlight < 1; i++) {
        await tick()
      }
      expect(state.inFlight).toBe(1)
      await settle(store, state)
      expect(state.maxInFlight).toBe(1) // one note at a time — the serial fallback
    } finally {
      state.gates.splice(0).forEach((g) => g())
      await store.stop()
    }
  })
})
