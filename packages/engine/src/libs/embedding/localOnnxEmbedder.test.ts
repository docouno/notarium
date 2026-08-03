import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock transformers.js so the seam's reshape/prefix logic is tested without
// downloading a 570MB model. hoisted state captures what the fake extractor saw.
const h = vi.hoisted(() => {
  const state = {
    calls: [] as { input: string[]; opts: unknown }[],
    data: new Float32Array(),
    // When set, the fake extractor sizes its output to the call's input (so a
    // sub-batched embed gets the right shape per micro-batch); else returns state.data.
    gen: null as null | ((input: string[]) => Float32Array),
    // The mocked transformers.js `pipeline`, captured HERE rather than re-imported
    // from '@huggingface/transformers' in each test. That keeps this file free of any
    // tsc-RESOLVED reference to the package (the removed per-test `await import('@hugg…')`
    // calls were resolved by tsc → TS2307 on a no-vector install; the surviving
    // `vi.mock('@huggingface/transformers', …)` first arg is a plain string tsc never
    // resolves, and the factory replaces the module so it's never loaded at runtime).
    // So this file typechecks AND runs where the package is absent (#200) — vitest
    // still routes the engine's dynamic `import()` to this mock by resolved id.
    pipeline: null as unknown as ReturnType<typeof vi.fn>,
  }
  state.pipeline = vi.fn(async () => async (input: string[], opts: unknown) => {
    state.calls.push({ input, opts })
    return { data: state.gen ? state.gen(input) : state.data }
  })
  return state
})

vi.mock('@huggingface/transformers', () => ({ pipeline: h.pipeline }))

import { createLocalOnnxEmbedder } from './localOnnxEmbedder'

describe('createLocalOnnxEmbedder', () => {
  beforeEach(() => {
    h.calls.length = 0
    h.gen = null
  })

  it('reshapes the flat tensor into one row per text, with mean-pool+normalize', async () => {
    h.data = new Float32Array([1, 2, 3, 4, 5, 6]) // 2 texts × dim 3
    const e = createLocalOnnxEmbedder({ model: 'm', dtype: 'q8', dimensions: 3 })
    const rows = await e.embed(['a', 'b'], 'passage')
    expect(rows).toHaveLength(2)
    expect(Array.from(rows[0])).toEqual([1, 2, 3])
    expect(Array.from(rows[1])).toEqual([4, 5, 6])
    expect(h.calls[0].opts).toEqual({ pooling: 'mean', normalize: true })
  })

  it('each row is an independent copy (not a view into the shared buffer)', async () => {
    h.data = new Float32Array([1, 2, 3, 4])
    const e = createLocalOnnxEmbedder({ dimensions: 2 })
    const rows = await e.embed(['a', 'b'], 'passage')
    rows[0][0] = 99
    expect(Array.from(rows[1])).toEqual([3, 4]) // unaffected
  })

  it('applies query/passage prefixes for asymmetric models', async () => {
    h.data = new Float32Array([0, 0])
    const e = createLocalOnnxEmbedder({ prefixes: { query: 'query: ', passage: 'passage: ' } })
    await e.embed(['cat'], 'query')
    await e.embed(['dog'], 'passage')
    expect(h.calls[0].input).toEqual(['query: cat'])
    expect(h.calls[1].input).toEqual(['passage: dog'])
  })

  it('symmetric model (no prefixes) passes text through unchanged', async () => {
    h.data = new Float32Array([0, 0])
    const e = createLocalOnnxEmbedder() // bge-m3 default: empty prefixes
    await e.embed(['cat'], 'query')
    expect(h.calls[0].input).toEqual(['cat'])
  })

  it('returns [] for empty input without loading the model', async () => {
    const e = createLocalOnnxEmbedder()
    expect(await e.embed([], 'query')).toEqual([])
    expect(h.calls).toHaveLength(0)
  })

  it('exposes id (model@dtype) and dimensions for the index key', () => {
    const e = createLocalOnnxEmbedder({ model: 'foo', dtype: 'fp32', dimensions: 7 })
    expect(e.id).toBe('foo@fp32')
    expect(e.dimensions).toBe(7)
  })

  it('folds query/passage prefixes into the id so a change rebuilds the partition (#81 Stage-3 review)', () => {
    // bge-m3 (no prefixes) → plain id; e5-style prefixes → a DIFFERENT id, so the
    // index can never reuse asymmetric vectors against symmetric ones (silent rot).
    const plain = createLocalOnnxEmbedder({ model: 'm', dtype: 'q8' })
    const prefixed = createLocalOnnxEmbedder({
      model: 'm',
      dtype: 'q8',
      prefixes: { query: 'query: ', passage: 'passage: ' },
    })
    expect(plain.id).toBe('m@q8')
    expect(prefixed.id).not.toBe(plain.id)
    expect(prefixed.id).toContain('query: ')
  })

  it('passes an explicit intra-op thread count to the onnx session (#81: no affinity pinning)', async () => {
    h.data = new Float32Array([0])
    const e = createLocalOnnxEmbedder({ dimensions: 1, numThreads: 3 })
    await e.embed(['x'], 'passage')
    const opts = h.pipeline.mock.calls.at(-1)?.[2] as
      { session_options?: { intraOpNumThreads?: number } } | undefined
    expect(opts?.session_options?.intraOpNumThreads).toBe(3)
  })

  it('sub-batches by char + count budget, embedding a long text alone, order preserved (#81 Stage 4)', async () => {
    // dim 1; the fake returns one element per text = its char length, so each row
    // maps back to its input — lets us assert order, completeness, and partition.
    h.gen = (input) => new Float32Array(input.map((t) => t.length))
    const e = createLocalOnnxEmbedder({ dimensions: 1, maxBatchSize: 2, maxBatchChars: 10 })
    const texts = ['aa', 'bb', 'cccc', 'ddddddddddddd', 'ee'] // lengths 2,2,4,13,2
    const rows = await e.embed(texts, 'passage')
    // every input embedded exactly once, in order (no drop, no reorder across batches)
    expect(rows.map((r) => r[0])).toEqual([2, 2, 4, 13, 2])
    // it did NOT pass everything in one forward pass…
    expect(h.calls.length).toBeGreaterThan(1)
    // count cap (2): the first micro-batch is ['aa','bb']
    expect(h.calls[0].input).toEqual(['aa', 'bb'])
    // a single over-budget text (13 > 10) is embedded ALONE — the OOM guard
    expect(h.calls.some((c) => c.input.length === 1 && c.input[0].length === 13)).toBe(true)
  })

  it('does NOT memoize a failed model load — the next embed retries (#81 final sweep)', async () => {
    // A transient first load (model fetch error / momentary OOM / corrupt HF cache)
    // must stay retryable: a cached rejected promise would poison every future call and
    // strand the store on FTS-only while capabilities.vector still reads true.
    h.pipeline.mockRejectedValueOnce(new Error('transient model fetch failure'))
    h.data = new Float32Array([1, 2])
    const e = createLocalOnnxEmbedder({ dimensions: 2 })
    // First embed: the load rejects and propagates (not swallowed at this layer).
    await expect(e.embed(['x'], 'passage')).rejects.toThrow('transient model fetch failure')
    // The memo was cleared on failure — this re-attempts the load and succeeds (a
    // cached rejection would have made THIS reject too).
    const rows = await e.embed(['x'], 'passage')
    expect(rows).toHaveLength(1)
    expect(Array.from(rows[0])).toEqual([1, 2])
  })

  it('passes enableCpuMemArena to the onnx session — default on, off bounds memory (#81 Stage 4)', async () => {
    h.data = new Float32Array([0])
    const off = createLocalOnnxEmbedder({ dimensions: 1, cpuMemArena: false })
    await off.embed(['x'], 'passage')
    const offOpts = h.pipeline.mock.calls.at(-1)?.[2] as
      { session_options?: { enableCpuMemArena?: boolean } } | undefined
    // camelCase (the onnxruntime-common field) — snake_case is silently ignored.
    expect(offOpts?.session_options?.enableCpuMemArena).toBe(false)

    const on = createLocalOnnxEmbedder({ dimensions: 1 }) // default
    await on.embed(['x'], 'passage')
    const onOpts = h.pipeline.mock.calls.at(-1)?.[2] as
      { session_options?: { enableCpuMemArena?: boolean } } | undefined
    expect(onOpts?.session_options?.enableCpuMemArena).toBe(true)
  })
})

// The signal a composition root asks before building an embedder (#317). It has to
// answer from the tree, because everything else about this module is deliberately
// lazy: construction never touches the package, so a hollow embedder built over a
// missing install boots green and advertises capabilities.vector it cannot serve.
// Before #317 the absent sqlite-vec made vec0 refuse and the engine dropped the
// embedder; vec0 now ships in every profile, so nothing else is left to notice.
describe('localEmbedderAvailable', () => {
  // Drive the real resolver both ways rather than asserting today's install: this
  // file runs on BOTH profiles, and the answer differs between them by design.
  const withResolution = async (resolvable: boolean): Promise<boolean> => {
    // The CommonJS Module object, not the ESM namespace: the namespace's bindings are
    // read-only, and the resolver we need to steer is a property of the real module.
    const { createRequire } = await import('node:module')
    const mod = createRequire(import.meta.url)('node:module') as {
      _resolveFilename: (request: string, ...rest: unknown[]) => string
    }
    const real = mod._resolveFilename

    mod._resolveFilename = function (request: string, ...rest: unknown[]) {
      if (request === '@huggingface/transformers') {
        if (!resolvable) {
          throw new Error("Cannot find package '@huggingface/transformers'")
        }

        return '/fake/transformers/index.js'
      }

      return real.call(this, request, ...rest)
    }
    try {
      // A fresh module instance per probe: the real one caches, and the cache is
      // correct in production (an install cannot appear mid-process) but would make
      // the second case here read the first case's answer.
      vi.resetModules()

      const fresh = await import('./localOnnxEmbedder')

      return fresh.localEmbedderAvailable()
    } finally {
      mod._resolveFilename = real
    }
  }

  it('reports false where the embedder package cannot be resolved', async () => {
    expect(await withResolution(false)).toBe(false)
  })

  it('reports true where it can', async () => {
    expect(await withResolution(true)).toBe(true)
  })
})
