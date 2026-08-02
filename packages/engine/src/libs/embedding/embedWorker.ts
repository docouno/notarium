// Embed-pool worker (#197): the worker thread that owns ONE ONNX session and does
// nothing but run inference off the main event loop. It wraps the SAME
// createLocalOnnxEmbedder the single-embedder path uses — there is no second
// inference implementation, the pool is just N of these behind the Embedder seam.
// The main thread keeps ALL sqlite writes and the crash-safety invariants; a worker
// receives already-chunked passage texts and returns their vectors, nothing more.
//
// Bundling (tsup): this file is a SEPARATE entry → dist/embedWorker.js next to
// dist/main.js, and @huggingface/transformers stays external (loaded from the
// production node_modules), exactly like the host bundle — see tsup.config.ts and
// createEmbedPool's worker-URL resolution.

import { parentPort, workerData } from 'node:worker_threads'

import { createLocalOnnxEmbedder, type LocalOnnxEmbedderOptions } from './localOnnxEmbedder'
import type { EmbedKind } from './types'

/** Parent → worker requests, correlated by `id` so the pool can pipeline safely. */
type Req = { t: 'warm'; id: number } | { t: 'embed'; id: number; texts: string[]; kind: EmbedKind }

if (!parentPort) {
  throw new Error('embedWorker must run as a worker_thread')
}
const port = parentPort

// The embedder is built from the SAME options the composition root would pass a
// single embedder (model/dtype/dims/prefixes/threads/arena) — so a worker's vectors
// are byte-identical to the in-process path and its `id` matches (partition identity
// is stable across single↔pool, #197). The model loads lazily on warm()/first embed.
const embedder = createLocalOnnxEmbedder(workerData as LocalOnnxEmbedderOptions)

port.on('message', (req: Req) => {
  if (req.t === 'warm') {
    // Off-request-path model preload (#81 P13), now per worker. A minimal embedder
    // with no lazy init omits warmup() — nothing to do, still ack so the pool's
    // warmup() resolves.
    Promise.resolve(embedder.warmup?.())
      .then(() => port.postMessage({ t: 'warm', id: req.id }))
      .catch((err: unknown) => port.postMessage({ t: 'err', id: req.id, msg: String(err) }))
    return
  }
  // embed: run the batch, then flatten to ONE Float32Array and TRANSFER its buffer
  // (zero-copy hand-off — the vectors leave this thread's heap for the main thread's).
  embedder
    .embed(req.texts, req.kind)
    .then((vecs) => {
      // Flatten at the model's ACTUAL output width, NOT the configured embedder.dimensions.
      // A model whose real width differs from the configured `dimensions` (e.g. e5-small=384
      // with EMBED_DIMENSIONS left at the 1024 default) must surface its true width to the
      // main thread's fail-closed guard (`vec.length !== embedder.dimensions` in embedNote),
      // NOT be silently zero-padded to the configured width — padding would pass the guard
      // and write bogus vectors marked complete, where the single embedder throws (#197 review).
      // Every row from one ONNX model shares a width; an empty batch is handled before this.
      const dim = vecs.length ? vecs[0].length : 0
      const out = new Float32Array(vecs.length * dim)

      for (let i = 0; i < vecs.length; i++) {
        out.set(vecs[i], i * dim)
      }
      port.postMessage({ t: 'embed', id: req.id, n: vecs.length, buf: out.buffer }, [out.buffer])
    })
    .catch((err: unknown) => port.postMessage({ t: 'err', id: req.id, msg: String(err) }))
})
