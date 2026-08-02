// The visibility invariant under HYBRID search, end-to-end through the
// read-model — the case the generic contract specs do NOT reach. The contract's visibility search uses a token present in both note
// bodies, so FTS surfaces the agent-memory note and the post-filter drops it
// whether or not the vector channel contributes. The dangerous path is a
// VECTOR-ONLY agent-memory hit — one FTS would never return — reaching CachedStore;
// if its class is missing/mis-resolved the read-model fails OPEN (undefined class →
// user-doc → userSearch=true → leak). This test constructs exactly that hit and
// proves the chokepoint drops it from user scope while agentRecall still sees it.
//
// Hermetic: real vec0 + a lookup-table embedder (no model). Skips where vec0's
// native binary can't load (musl/alpine CI).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { CachedStore } from '@notarium/core'
import { createNotariumStore, type Embedder } from '@notarium/engine'

import { describeVector } from '../../packages/engine/src/services/notariumStore/vectorGate.fixture'

/** Maps an EXACT embed-input string to a fixed vector — so a note becomes a
 *  vector-only hit for a query that shares no token with it. */
const mapEmbedder = (table: Record<string, number[]>, dim = 4): Embedder => {
  const fallback = Array.from({ length: dim }, (_, i) => (i === dim - 1 ? 1 : 0))

  const norm = (a: number[]): Float32Array => {
    const v = Float32Array.from(a.length === dim ? a : fallback)
    let n = 0

    for (const x of v) {
      n += x * x
    }
    n = Math.sqrt(n) || 1
    for (let i = 0; i < dim; i++) {
      v[i] /= n
    }

    return v
  }

  return {
    id: 'map-visibility@v1',
    dimensions: dim,
    embed: async (texts) => texts.map((t) => norm(table[t] ?? fallback)),
  }
}

describeVector(
  'CachedStore hybrid — a vector-only agent-memory hit never leaks into user search',
  () => {
    it('user scope excludes it, agentRecall includes it', async () => {
      const notesDir = mkdtempSync(join(tmpdir(), 'notarium-vec-vis-'))
      const table = {
        'Feline Friend\n\npurrs softly all day': [1, 0, 0, 0], // agent-memory; no "qzxq" token
        qzxq: [1, 0, 0, 0], // the query: reaches the note ONLY via the vector channel
      }
      const inner = createNotariumStore({
        mounts: [
          { class: 'user-doc', dir: notesDir, prefix: '' },
          {
            class: 'agent-memory',
            dir: join(notesDir, '.notarium/memory'),
            prefix: '.notarium/memory',
          },
        ],
        embedder: mapEmbedder(table),
      })
      const store = new CachedStore({ inner, pollIntervalMs: 0 })
      await store.start()
      try {
        await store.write({
          title: 'Feline Friend',
          content: 'purrs softly all day',
          targetClass: 'agent-memory',
        })
        await inner.whenVectorsSettled()

        // Default (user) scope: the vector-only memory hit must be dropped.
        const userHits = await store.search('qzxq')
        expect(userHits.some((h) => h.title === 'Feline Friend')).toBe(false)

        // agentRecall scope: the SAME hit (proving the vector channel DID reach it,
        // so the user-scope exclusion above is the post-filter at work, not FTS
        // simply missing) is admitted.
        const recallHits = await store.search('qzxq', { scope: 'agentRecall' })
        expect(recallHits.some((h) => h.title === 'Feline Friend')).toBe(true)
        expect(recallHits.find((h) => h.title === 'Feline Friend')?.class).toBe('agent-memory')
      } finally {
        store.stop()
        await store.settle()
        rmSync(notesDir, { recursive: true, force: true })
      }
    })

    // Stage 4b: the graph channel adds a NEW way for an agent-memory note to reach
    // user search — as a 1-hop neighbour of a user-doc hit, including one fetched from
    // OUTSIDE the fts/vec pool (GRAPH_NEIGHBOR_SQL). It carries its class, so the
    // read-model must still drop it. We prove BOTH halves: the bare engine surfaces it
    // (so the user-scope absence is the post-filter, not the engine missing it), and
    // the read-model drops it under user scope.
    it('an out-of-pool agent-memory graph neighbour never leaks into user search', async () => {
      const notesDir = mkdtempSync(join(tmpdir(), 'notarium-vec-vis-graph-'))
      const table = {
        'Apex\n\na cat essay [[Secret Memo]]': [1, 0, 0, 0], // user-doc hit, links the memo
        cat: [1, 0, 0, 0],
      }
      const inner = createNotariumStore({
        mounts: [
          { class: 'user-doc', dir: notesDir, prefix: '' },
          {
            class: 'agent-memory',
            dir: join(notesDir, '.notarium/memory'),
            prefix: '.notarium/memory',
          },
        ],
        embedder: mapEmbedder(table),
        // poolSize=1 forces Secret Memo outside the fts/vec pool → it can reach the page
        // ONLY via the graph channel's out-of-pool fetch; wGraph high so it survives the
        // pageSize-1 cut.
        searchTuning: { poolSize: 1, wGraph: 5 },
      })
      const store = new CachedStore({ inner, pollIntervalMs: 0 })
      await store.start()
      try {
        await store.write({ title: 'Apex', content: 'a cat essay [[Secret Memo]]' })
        await store.write({
          title: 'Secret Memo',
          content: 'private alpha',
          targetClass: 'agent-memory',
        })
        await inner.whenVectorsSettled()

        // The BARE engine surfaces the out-of-pool agent-memory neighbour (no visibility
        // enforcement) — so it genuinely reaches the read-model.
        const innerHits = await inner.search('cat', { pageSize: 1 })
        expect(innerHits.some((h) => h.title === 'Secret Memo')).toBe(true)

        // The read-model drops it under user scope — no leak, even via the graph channel.
        const userHits = await store.search('cat', { pageSize: 1 })
        expect(userHits.some((h) => h.title === 'Secret Memo')).toBe(false)
      } finally {
        store.stop()
        await store.settle()
        rmSync(notesDir, { recursive: true, force: true })
      }
    })
  },
)
