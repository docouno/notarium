// The production stack with the VECTOR channel on: CachedStore over
// a NotariumStore wired with a (deterministic, instant) embedder, so the full
// KnowledgeStore contract runs with the HYBRID search SQL (RRF fusion of FTS5 +
// vec0) actually executing on every search — proving the fused path does not BREAK
// any port semantic (found / id-mapped / visibility / CAS / rename / …).
//
// SCOPE NOTE: the contract's visibility search uses a token that
// is lexically present in the agent-memory note's body, so FTS alone would surface
// (and the read-model drop) it — the fused SQL runs, but the contract's visibility
// asserts are NOT specific to the vector channel. The genuinely vector-specific
// leak guard — a VECTOR-ONLY agent-memory hit (one FTS never returns) reaching the
// user — lives in cachedVectorVisibility.test.ts (end-to-end) and vectorIndex.test.ts
// (engine-level). This wrapper's job is the broad "fusion doesn't regress the port".
//
// Hermetic by construction: a byte-derived mock embedder (no onnxruntime, no model
// download) + the real vec0 extension, so it rides CI wherever the native binary
// loads. Where it can't (musl/alpine CI), the leg skips honestly — the live
// onnxruntime path is proven separately on the stand. The mock returns a vector
// for ANY text, so every lexical hit still flows through fusion; the contract only
// asserts port semantics, never semantic ranking — what makes it engine-agnostic.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { CachedStore } from '@notarium/core'
import { createNotariumStore, type Embedder } from '@notarium/engine'

import {
  VECTOR_GATE,
  vectorAvailable,
} from '../../packages/engine/src/services/notariumStore/vectorGate.fixture'
import { CONTRACT_SUITE_PREFIX, describeKnowledgeStoreContract } from './storeContract'

/** One name for both branches: the running suite and the skipped placeholder. */
const CONTRACT_LEG = 'CachedStore(NotariumStore + vector) [hybrid]'

/** Deterministic, instant embedder: a vector derived from the text bytes so any
 *  text embeds without a model. Hybrid fusion runs for real; the byte direction is
 *  arbitrary (the contract never asserts semantic order). */
const mockEmbedder = (dimensions = 8): Embedder => ({
  id: 'mock-contract@v1',
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

if (vectorAvailable) {
  describeKnowledgeStoreContract(CONTRACT_LEG, async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-engine-vec-'))
    const inner = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir: notesDir, prefix: '' },
        {
          class: 'agent-memory',
          dir: join(notesDir, '.notarium/memory'),
          prefix: '.notarium/memory',
        },
      ],
      embedder: mockEmbedder(),
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    await store.start()
    return {
      store,
      directory: 'contract-vec',
      teardown: async () => {
        store.stop()
        await store.settle() // let the engine's index handle (and embed loop) close
        rmSync(notesDir, { recursive: true, force: true })
      },
    }
  })
} else {
  // The contract helper owns its own `describe`, so this leg gates itself — same marker,
  // same suite prefix, so the summary counts it with the other vector ones. The single
  // case is collected but never executed; without it a skipped suite has no leaves and
  // drops out of the report entirely.
  describe.skip(`${CONTRACT_SUITE_PREFIX}${CONTRACT_LEG} ${VECTOR_GATE}`, () => {
    it('needs the vec0 native extension', () => {})
  })
}
