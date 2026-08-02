// Local ONNX embedder — the desktop/cloud default (#81): a multilingual model
// run in-process via transformers.js (onnxruntime-node native CPU backend),
// offline, no API key. Default is bge-m3 (1024d, 8192 ctx, strong EN + wide
// multilingual incl. RU/AR/CJK) — the cloud-oriented choice (#81; desktop's
// compact-model profile is #87). The model is swappable behind the Embedder seam.
//
// Lazy load: the (large) model is fetched/initialized on first embed(), not at
// construction — so building a store stays cheap and a store that never searches
// never pays for the model. `id` folds model + quantization into the index key
// (P13): change either and the vector space changes → rebuild.

import { availableParallelism } from 'node:os'

import type { Embedder, EmbedKind } from './types'

// transformers.js is an OPTIONAL native dependency (#200): it and its onnxruntime
// backend are declared by the deps-only carrier workspace @notarium/engine-vector —
// NOT by @notarium/engine, which has no dependency on them (static or optional). The
// default `make deps` install omits the whole stack by EXCLUDING that one workspace
// (this repo deliberately does NOT use `optionalDependencies`/`--omit=optional` —
// that blunt flag also strips the toolchain's platform binaries). This module must
// therefore both LOAD and TYPECHECK without the package present. Two decouplings
// make that true:
//  1. The import specifier is held in a `string`-typed variable (not a literal in
//     `import()`), so `tsc` does NOT statically resolve the possibly-absent module
//     — a literal would raise TS2307 on a no-vector checkout.
//  2. The tiny surface we touch — `pipeline()` and the extractor's
//     ({pooling,normalize}) → {data} call — is described by these local structural
//     types instead of imported from '@huggingface/transformers'.
// The real package supplies the runtime types/impl when installed; a no-vector
// profile never calls ready() (the server builds no embedder when VECTOR_SEARCH is
// off), so the specifier is never even evaluated there.
type FeatureExtractionPipeline = (
  input: string | string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array }>
type TransformersModule = {
  pipeline: (
    task: 'feature-extraction',
    model: string,
    options: {
      dtype?: string
      session_options?: {
        intraOpNumThreads?: number
        interOpNumThreads?: number
        enableCpuMemArena?: boolean
      }
    },
  ) => Promise<FeatureExtractionPipeline>
}
// `: string` (not the narrowed literal) is load-bearing: it keeps `import()` below
// unresolved-by-tsc so the module stays optional at the type layer too.
const TRANSFORMERS_MODULE: string = '@huggingface/transformers'

export type LocalOnnxEmbedderOptions = {
  /** HF model id (transformers.js-compatible ONNX). Default Xenova/bge-m3. */
  model?: string
  /** Quantization dtype passed to transformers.js. q8 keeps the download/footprint
   *  small at a small quality cost; fp32 for max quality. Part of `id`. */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4'
  /** Vector dimensionality, fixed into the vec0 DDL. Must match the model. */
  dimensions?: number
  /** Query/passage prefixes for asymmetric models (e5: 'query: '/'passage: ').
   *  bge-m3 is symmetric — leave empty. Forgotten prefixes = silent degradation,
   *  so they live in `id` too (via the model choice). */
  prefixes?: { query: string; passage: string }
  /** Intra-op thread count for the ONNX session. Set EXPLICITLY (default: the
   *  process's available parallelism) so onnxruntime does NOT try to pin threads
   *  to cores — inside a cgroup-restricted container that affinity call fails and
   *  floods the log with `pthread_setaffinity_np failed … Invalid argument` (one
   *  line per worker per inference). An explicit count keeps the same parallelism
   *  without the pinning. 0/undefined → auto (the noisy default). */
  numThreads?: number
  /** Max texts per ONNX forward pass (count cap). Default 32. */
  maxBatchSize?: number
  /** Max total characters per ONNX forward pass (memory cap). Default 8192.
   *  bge-m3's attention is O(seq²), so embedding many long chunks in ONE pass
   *  spikes activation memory — a heading-chunked note can be a dozen chunks of up
   *  to ~8000 chars each, which OOMs a memory-tight host. Capping the per-call CHAR
   *  total (not just the count) keeps the peak ≈ one max-length chunk — the
   *  footprint a single-chunk note already pays — however many chunks a note splits
   *  into. (#81 Stage 4: surfaced embedding the corpus at scale.) */
  maxBatchChars?: number
  /** Keep onnxruntime's CPU memory arena ON (default true — fast, no per-op
   *  malloc/free). The arena RETAINS its peak allocation across calls and grows
   *  on VARIED tensor shapes (different batch sizes × sequence lengths — exactly a
   *  real corpus backfill), so on a memory-tight host (e.g. a homelab box, no
   *  swap) a full backfill creeps to multiple GB that never release and OOMs.
   *  Set false to free op memory between passes: a FLAT footprint (~model + one
   *  pass; measured ~1.9GB for bge-m3 vs OOM with the arena on) at a throughput
   *  cost. Vectors are byte-identical either way. The memory-constrained tier knob.
   *  (#81 Stage 4: corpus backfill OOM was arena retention on varied shapes —
   *  verified the off path stays flat across 60 varied batches.) */
  cpuMemArena?: boolean
}

export const createLocalOnnxEmbedder = (opts: LocalOnnxEmbedderOptions = {}): Embedder => {
  const model = opts.model ?? 'Xenova/bge-m3'
  const dtype = opts.dtype ?? 'q8'
  const dimensions = opts.dimensions ?? 1024
  const prefixes = opts.prefixes ?? { query: '', passage: '' }
  // Explicit thread count so onnxruntime does NOT try to pin worker threads to
  // cores — that affinity call fails in a cgroup-restricted container and floods
  // the log with one warning per worker per embed. Default: HALF the box's cores
  // (min 1) — embedding is background work that runs while the same process serves
  // requests; an explicit-but-modest count both silences the warning and leaves
  // headroom so a large backfill doesn't starve interactive traffic.
  const numThreads = opts.numThreads ?? Math.max(1, Math.floor(availableParallelism() / 2))
  // Memory guard for the forward pass (see maxBatchChars doc): bound BOTH the
  // count and the total chars of each ONNX call so a long/multi-chunk note can't
  // spike onnx activation memory into an OOM on a tight host.
  const maxBatchSize = opts.maxBatchSize && opts.maxBatchSize > 0 ? opts.maxBatchSize : 32
  const maxBatchChars = opts.maxBatchChars && opts.maxBatchChars > 0 ? opts.maxBatchChars : 8_192
  // Arena ON by default (fast); false frees op memory between passes — the bounded
  // footprint a memory-tight host needs (see cpuMemArena doc).
  const cpuMemArena = opts.cpuMemArena ?? true
  // Prefixes fold into the index identity (P13): an asymmetric model (e5) embeds
  // DIFFERENT vectors with vs without its `query: `/`passage: ` prefixes, so a
  // change must rebuild the partition. bge-m3 is symmetric (empty prefixes) → the
  // id is just model@dtype, unchanged. (#81 Stage-3 review.)
  const id =
    prefixes.query || prefixes.passage
      ? `${model}@${dtype}+q=${prefixes.query}+p=${prefixes.passage}`
      : `${model}@${dtype}`

  // Single-flight init: the first embed() starts the load, everyone else awaits it.
  // transformers.js is an OPTIONAL native dependency (it pulls onnxruntime-node),
  // so it is imported DYNAMICALLY on first use — merely importing this module (e.g.
  // the server loading the engine barrel) must never require the package. A host
  // that never embeds, and never installed it (a no-vector install #200, or the
  // alpine dev image), loads fine; the cost is paid only when search needs a vector.
  let pipe: Promise<FeatureExtractionPipeline> | null = null
  const ready = (): Promise<FeatureExtractionPipeline> =>
    (pipe ??= (import(TRANSFORMERS_MODULE) as Promise<TransformersModule>)
      .then(({ pipeline }) =>
        pipeline('feature-extraction', model, {
          dtype,
          session_options: {
            intraOpNumThreads: numThreads,
            interOpNumThreads: numThreads,
            // camelCase is the onnxruntime-common field (snake_case is silently
            // ignored — verified). Off bounds memory on a tight host. (#81 Stage 4)
            enableCpuMemArena: cpuMemArena,
          },
        }),
      )
      // Do NOT memoize a REJECTED load: a transient failure (model fetch, momentary
      // OOM, corrupt HF cache) must stay retryable — a cached rejection would poison
      // EVERY future ready() and strand the store on FTS-only forever while
      // capabilities.vector still reads true. Clear the memo so the next warmup() or
      // embed() re-attempts the load. (#81 final sweep)
      .catch((err: unknown) => {
        pipe = null
        throw err
      }))

  return {
    id,
    dimensions,
    // A single in-process ONNX session serialises every embed() on its one model,
    // so concurrent calls gain nothing — the store embeds one note at a time (#197).
    // The worker pool (createEmbedPool) is what reports a concurrency > 1.
    concurrency: 1,
    // Pre-load the model off the request path (#81 P13): the store calls this at
    // boot so a fully-backfilled warm restart (nothing left to embed, so the embed
    // loop never warms the model) still brings the vector channel online without
    // the first user query eating the multi-second cold load. Idempotent — ready()
    // memoizes the pipeline, so a concurrent boot embed and this warmup share it.
    warmup: async (): Promise<void> => {
      await ready()
    },
    embed: async (texts: readonly string[], kind: EmbedKind): Promise<Float32Array[]> => {
      if (!texts.length) {
        return []
      }
      const extractor = await ready()
      const prefix = prefixes[kind]
      const rows: Float32Array[] = []

      for (let i = 0; i < texts.length;) {
        // Greedily pack a micro-batch up to the char + count budget, then run ONE
        // forward pass over it. Always take at least the first text — a single text
        // over the char budget can't be split, so it goes alone. Bounding the
        // per-call char total (not just the count) is what keeps onnx activation
        // memory flat regardless of how many chunks a note splits into (#81 Stage 4).
        let j = i
        let chars = 0

        do {
          chars += texts[j].length
          j++
        } while (
          j < texts.length &&
          j - i < maxBatchSize &&
          chars + texts[j].length <= maxBatchChars
        )
        const slice = texts.slice(i, j)
        const input = prefix ? slice.map((t) => prefix + t) : slice
        // pooling:'mean' + normalize:true → one L2-normalized sentence vector per text.
        const out = await extractor(input, { pooling: 'mean', normalize: true })
        const flat = out.data as Float32Array
        const dim = flat.length / slice.length

        for (let r = 0; r < slice.length; r++) {
          // Copy each row out of the shared backing buffer (slice on a typed array
          // returns a copy) so callers own independent vectors.
          rows.push(flat.slice(r * dim, (r + 1) * dim))
        }
        i = j
      }

      return rows
    },
  }
}
