// The embedder seam (P9/P13): a narrow async surface so the local ONNX runtime
// (transformers.js today) can be swapped for an API embedder or a different model
// later (#83/#87) without the store knowing. The store speaks ONLY this type;
// which embedder gets plugged in is the build profile's choice — exactly like the
// SqlDriver and FileStore seams.
//
// Embeddings are a derived artifact (P13): the index key is
// `content_hash(chunk) × embedder_id × chunker_version`. `embedder_id` here is the
// identity of the vector space — vectors from different embedders are NOT
// comparable (silent quality rot if dimensions happen to match), so a changed
// `id` means rebuild, never reuse.

/** Asymmetric models (e5) prefix a query differently from a stored passage;
 *  symmetric models (bge-m3) ignore the distinction. The seam carries the intent
 *  so the embedder decides — the caller never hand-rolls prefixes. */
export type EmbedKind = 'query' | 'passage'

export type Embedder = {
  /** Stable identity for the index key: model + quantization (+ version). Part of
   *  `embedder_id` (P13). A change here invalidates the whole vector partition. */
  readonly id: string
  /** Vector dimensionality — fixed into the vec0 DDL (`float[dimensions]`); a
   *  change is a drop+rebuild, not an ALTER. */
  readonly dimensions: number
  /** Embed a batch of texts. Returns L2-normalized vectors (cosine-ready), one
   *  Float32Array per input, in order. `kind` lets asymmetric models prefix
   *  query vs passage; symmetric ones ignore it. */
  embed(texts: readonly string[], kind: EmbedKind): Promise<Float32Array[]>
  /** Pre-load whatever the first embed() would lazily initialize (the multi-second
   *  ONNX model load), OFF the request path. Optional: an embedder with no lazy
   *  init (a mock, an API client) omits it. The store fires this at boot so the
   *  vector channel comes online without a query having to pay the cold load —
   *  queries arriving before it finishes degrade to FTS, never block (#81 P13). */
  warmup?(): Promise<void>
  /** How many embed() calls this embedder can absorb CONCURRENTLY with a real
   *  throughput gain (#197). A single in-process ONNX session serialises on its
   *  model → 1. A worker pool runs one note per worker in parallel → the pool size.
   *  The store's background embed loop launches up to this many embedNote()s at once
   *  so a multi-core box actually parallelises the backfill instead of embedding one
   *  note at a time. Absent → treated as 1 (serial), the pre-#197 behaviour. */
  readonly concurrency?: number
  /** Release any long-lived resources (the worker pool's threads). Optional and
   *  duck-typed like the store's stop(): an in-process embedder holds only a lazily
   *  GC'd session and omits it; the pooled embedder terminates its workers. The
   *  composition root calls it on shutdown, once, for the process-shared instance. */
  close?(): Promise<void>
}
