// Retrieval-quality eval harness (#81 stage 4): an offline measurement of the
// engine's search over a REAL corpus. It builds a throwaway index (vec0 + FTS5),
// runs a gold set of queries through store.search() and reports MRR@k / recall@k /
// nDCG@k. Read-only over the corpus — the engine writes only its own index DB
// (P2, derived). The channel (hybrid vs fts-only) is picked BY CAPABILITY (whether
// an embedder is passed), exactly as in production — there is no `mode` in
// search(). This script is the measurement mechanics; the gold-set methodology and
// the choice of metric are written up separately.
//
// Run it on the host (not in Docker; the model is fetched lazily, ~600MB on the
// first run):
//   npx tsx scripts/eval-search.ts \
//     --gold path/to/gold.json \
//     [--notes-dir docker/volumes/data/spaces/main] \
//     [--index-db /tmp/eval-search/hybrid.db] \
//     [--channel hybrid|fts] [--k 10] [--limit 25]
//
// `--gold` is REQUIRED and has no default: a gold set is corpus-specific, so there
// is no sensible one to fall back to. Keep it (and the index DB) outside the tree.
//
// The index DB PERSISTS: the first run builds it (~2-3 min over 2283 notes with
// bge-m3), later runs reuse it (the embedded_hash sentinel makes backfill skip).
// To compare channels honestly use two different --index-db (hybrid with an
// embedder, fts without).

import { readFileSync } from 'node:fs'

import {
  createHeadingChunker,
  createLocalOnnxEmbedder,
  createNotariumStore,
  type Embedder,
  type NotariumStore,
  type SearchTuning,
} from '@notarium/engine'

type Args = Record<string, string>
const args: Args = {}

for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1] ?? ''
}

const NOTES_DIR = args['notes-dir'] || 'docker/volumes/data/spaces/main'
const INDEX_DB = args['index-db'] || '/tmp/eval-search/hybrid.db'
const GOLD_PATH = args['gold']

if (!GOLD_PATH) {
  console.error('eval-search: --gold <path-to-gold.json> is required (see the header comment)')
  process.exit(2)
}
const CHANNEL = (args['channel'] || 'hybrid') as 'hybrid' | 'fts'
const K = Number(args['k'] || 10)
const LIMIT = Math.max(K, Number(args['limit'] || 25))
// Graph-channel sweep (#81 Stage 4b): --sweep runs a built-in tuning grid over ONE
// warmed index (setSearchTuning is instant — the adjacency cache is weight-free, hubs
// are derived per query); single-knob flags probe one point. The corpus gold is
// known-item over a hub-bipartite graph, so these numbers are MECHANICS-validation
// (hub-suppression, no-regression), NOT a transferable optimum — see the plan.
const SWEEP = 'sweep' in args
const numArg = (k: string): number | undefined => (args[k] != null ? Number(args[k]) : undefined)
const baseTuning: Partial<SearchTuning> = {
  ...(numArg('w-fts') != null ? { wFts: numArg('w-fts') } : {}),
  ...(numArg('w-vec') != null ? { wVec: numArg('w-vec') } : {}),
  ...(numArg('w-graph') != null ? { wGraph: numArg('w-graph') } : {}),
  ...(numArg('rrf-k') != null ? { rrfK: numArg('rrf-k') } : {}),
  ...(numArg('pool-size') != null ? { poolSize: numArg('pool-size') } : {}),
  ...(numArg('graph-seed-s') != null ? { graphSeedS: numArg('graph-seed-s') } : {}),
  ...(numArg('graph-per-seed-l') != null ? { graphPerSeedL: numArg('graph-per-seed-l') } : {}),
  ...(numArg('graph-hub-pct') != null ? { graphHubPercentile: numArg('graph-hub-pct') } : {}),
  ...(args['graph-edge-weight']
    ? { graphEdgeWeight: args['graph-edge-weight'] as SearchTuning['graphEdgeWeight'] }
    : {}),
}

/** One gold judgment: a query and the note paths (relative to NOTES_DIR) judged
 *  relevant. `note` is the source note a synthetic query was generated from (the
 *  primary target for known-item search); `relevant` is the full relevant set
 *  (≥1; may include the source + judged extras from pooling). */
type GoldItem = { query: string; note?: string; relevant: string[]; tag?: string }

const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now()
  const out = await fn()
  console.log(`⏱  ${label}: ${Math.round(performance.now() - t0)}ms`)
  return out
}

/** Storage-relative path, normalized for set-membership: no leading slash, always
 *  ends in .md so a gold entry written without the suffix still matches. */
const normPath = (p: string): string => {
  const s = p.replace(/^\.?\//, '').trim()
  return s.endsWith('.md') ? s : `${s}.md`
}

// ── metrics (binary relevance) ────────────────────────────────────────────────

/** Reciprocal rank of the FIRST relevant hit within top-k (0 if none) — rewards
 *  putting a relevant note at rank 1, the interactive-search signal. */
const reciprocalRank = (ranked: string[], relevant: Set<string>, k: number): number => {
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevant.has(ranked[i])) {
      return 1 / (i + 1)
    }
  }

  return 0
}

/** Fraction of the relevant set found within top-k — the agent-recall signal
 *  (did we surface the context at all, regardless of exact rank). */
const recallAtK = (ranked: string[], relevant: Set<string>, k: number): number => {
  if (relevant.size === 0) {
    return 0
  }
  let found = 0

  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevant.has(ranked[i])) {
      found++
    }
  }

  return found / relevant.size
}

/** nDCG@k with binary gains — rank-discounted, position-sensitive across the
 *  whole top-k (not just the first hit), the standard graded-retrieval metric. */
const ndcgAtK = (ranked: string[], relevant: Set<string>, k: number): number => {
  let dcg = 0

  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevant.has(ranked[i])) {
      dcg += 1 / Math.log2(i + 2)
    }
  }
  let idcg = 0

  for (let i = 0; i < Math.min(k, relevant.size); i++) {
    idcg += 1 / Math.log2(i + 2)
  }

  return idcg === 0 ? 0 : dcg / idcg
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const fmt = (x: number): string => x.toFixed(4)

type Agg = { mrr: number; recall: number; ndcg: number; misses: number; total: number }
type PerQuery = { q: string; rr: number; rec: number; ndcg: number; top: string }

/** One pass of the gold set through the (already-built, already-warm) store at the
 *  store's CURRENT tuning. Returns the aggregate + (optionally) per-query rows. */
const runGold = async (
  store: NotariumStore,
  gold: GoldItem[],
  perQueryOut?: PerQuery[],
): Promise<Agg> => {
  const rr: number[] = []
  const rec: number[] = []
  const ndcg: number[] = []

  for (const item of gold) {
    const relevant = new Set(item.relevant.map(normPath))
    const hits = await store.search(item.query, { pageSize: LIMIT })
    const ranked = hits.map((h) => normPath(h.filePath ?? ''))
    const q_rr = reciprocalRank(ranked, relevant, K)
    const q_rec = recallAtK(ranked, relevant, K)
    const q_ndcg = ndcgAtK(ranked, relevant, K)
    rr.push(q_rr)
    rec.push(q_rec)
    ndcg.push(q_ndcg)
    perQueryOut?.push({ q: item.query, rr: q_rr, rec: q_rec, ndcg: q_ndcg, top: ranked[0] ?? '∅' })
  }

  return {
    mrr: mean(rr),
    recall: mean(rec),
    ndcg: mean(ndcg),
    misses: rr.filter((x) => x === 0).length,
    total: rr.length,
  }
}

/** The built-in sweep grid (#81 Stage 4b): baseline (graph off) then wGraph rising,
 *  plus edge-weight and hub-percentile variants at the mid weight. nDCG@k is primary;
 *  leave-one-out is implicit (known-item: each query's own note is the only target,
 *  never reachable as its own graph neighbour). Each point is SELF-CONTAINED — it sets
 *  every knob the grid varies (wGraph, edge-weight, hub-pct) — because setSearchTuning
 *  MERGES over the live tuning; a partial point would inherit the previous row's
 *  values. SWEEP_BASE pins the rest (over baseTuning). */
const SWEEP_BASE: Partial<SearchTuning> = {
  rrfK: 60,
  wFts: 1,
  wVec: 1,
  graphSeedS: 10,
  graphPerSeedL: 5,
  ...baseTuning,
}
const SWEEP_GRID: Array<{ label: string; t: Partial<SearchTuning> }> = [
  {
    label: 'baseline graph-off    ',
    t: { wGraph: 0, graphEdgeWeight: 'invsqrtdeg', graphHubPercentile: 0.01 },
  },
  {
    label: 'wG=0.25 invsqrt p=.01 ',
    t: { wGraph: 0.25, graphEdgeWeight: 'invsqrtdeg', graphHubPercentile: 0.01 },
  },
  {
    label: 'wG=0.5  invsqrt p=.01 ',
    t: { wGraph: 0.5, graphEdgeWeight: 'invsqrtdeg', graphHubPercentile: 0.01 },
  },
  {
    label: 'wG=1.0  invsqrt p=.01 ',
    t: { wGraph: 1.0, graphEdgeWeight: 'invsqrtdeg', graphHubPercentile: 0.01 },
  },
  {
    label: 'wG=2.0  invsqrt p=.01 ',
    t: { wGraph: 2.0, graphEdgeWeight: 'invsqrtdeg', graphHubPercentile: 0.01 },
  },
  {
    label: 'wG=0.5  invdeg   p=.01',
    t: { wGraph: 0.5, graphEdgeWeight: 'invdeg', graphHubPercentile: 0.01 },
  },
  {
    label: 'wG=0.5  invsqrt p=.05',
    t: { wGraph: 0.5, graphEdgeWeight: 'invsqrtdeg', graphHubPercentile: 0.05 },
  },
  {
    label: 'wG=0.5  invsqrt p=0  ',
    t: { wGraph: 0.5, graphEdgeWeight: 'invsqrtdeg', graphHubPercentile: 0 },
  },
]

// ── run ───────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const gold: GoldItem[] = JSON.parse(readFileSync(GOLD_PATH, 'utf8'))
  console.log(
    `gold: ${gold.length} queries  •  corpus: ${NOTES_DIR}  •  channel: ${CHANNEL}  •  k=${K} limit=${LIMIT}`,
  )

  // Model knobs mirror the server (main.ts) so the eval can run the same tiers:
  // full (bge-m3, default) or compact (e5-small) — the latter fits a memory-tight
  // host where full-corpus bge-m3 embedding OOMs (no swap). e5 is asymmetric →
  // pass EMBED_QUERY_PREFIX/EMBED_PASSAGE_PREFIX ('query: '/'passage: ').
  const qp = process.env.EMBED_QUERY_PREFIX
  const pp = process.env.EMBED_PASSAGE_PREFIX
  const embedder: Embedder | undefined =
    CHANNEL === 'hybrid'
      ? createLocalOnnxEmbedder({
          model: process.env.EMBED_MODEL || undefined,
          dimensions: process.env.EMBED_DIMENSIONS
            ? Number(process.env.EMBED_DIMENSIONS)
            : undefined,
          numThreads: process.env.EMBED_THREADS ? Number(process.env.EMBED_THREADS) : undefined,
          // EMBED_CPU_MEM_ARENA=off → bounded memory for a full bge-m3 corpus build
          // on a tight host (else the arena grows on varied batches and OOMs). #81.
          cpuMemArena: (process.env.EMBED_CPU_MEM_ARENA ?? 'on') !== 'off',
          ...(qp != null || pp != null ? { prefixes: { query: qp ?? '', passage: pp ?? '' } } : {}),
        })
      : undefined
  const store = createNotariumStore({
    notesDir: NOTES_DIR,
    indexDb: INDEX_DB,
    embedder,
    chunker: embedder ? createHeadingChunker() : undefined,
  })

  // Build/attach the index, then DRAIN the background embed queue so every note's
  // vector has landed before we measure (otherwise a half-built index understates
  // hybrid quality). First call triggers ensureReady → backfill enqueue; settling
  // also flips vectorWarm so the hybrid branch is live for the queries below.
  await timed('index build + warm', async () => {
    // Load the model FIRST, alone — so its (multi-GB transient) onnx init doesn't
    // overlap the FTS rescan's working set and spike past a tight memory ceiling
    // (the host has no swap; concurrent load+rescan OOMs). Then build the index.
    if (embedder) {
      await embedder.warmup?.()
    }
    await store.search('warmup probe') // triggers ensureReady + backfill enqueue
    if (CHANNEL === 'hybrid') {
      await store.whenVectorsSettled()
    }
  })
  console.log('capabilities:', JSON.stringify(store.capabilities))

  if (SWEEP) {
    // Sweep mode: ONE warmed index, many tuning points (vectors are fixed; only the
    // JS fusion changes per row). nDCG@k primary. Mechanics-validation on this corpus.
    if (CHANNEL !== 'hybrid') {
      throw new Error('--sweep needs --channel hybrid (the graph channel rides hybrid)')
    }
    console.log('\n━━ sweep ' + '━'.repeat(64))
    console.log(`  ${'config'.padEnd(22)}  MRR@${K}   recall@${K}  nDCG@${K}   misses`)
    for (const point of SWEEP_GRID) {
      store.setSearchTuning({ ...SWEEP_BASE, ...point.t })
      const a = await runGold(store, gold)
      console.log(
        `  ${point.label.padEnd(22)}  ${fmt(a.mrr)}   ${fmt(a.recall)}    ${fmt(a.ndcg)}   ${a.misses}/${a.total}`,
      )
    }
    await store.stop()
    return
  }

  // Single run at the requested (or default) tuning.
  store.setSearchTuning(baseTuning)
  const perQuery: PerQuery[] = []
  const agg = await runGold(store, gold, perQuery)

  console.log('\n━━ per-query ' + '━'.repeat(60))
  for (const p of perQuery) {
    const flag = p.rr === 0 ? ' ✗' : ''
    console.log(
      `  rr=${fmt(p.rr)} rec=${fmt(p.rec)} ndcg=${fmt(p.ndcg)}${flag}  «${p.q.slice(0, 50)}»  → ${p.top}`,
    )
  }
  console.log('\n━━ aggregate ' + '━'.repeat(60))
  console.log(`  channel:    ${CHANNEL}`)
  if (Object.keys(baseTuning).length) {
    console.log(`  tuning:     ${JSON.stringify(baseTuning)}`)
  }
  console.log(`  MRR@${K}:     ${fmt(agg.mrr)}`)
  console.log(`  recall@${K}:  ${fmt(agg.recall)}`)
  console.log(`  nDCG@${K}:    ${fmt(agg.ndcg)}`)
  console.log(`  misses (rr=0): ${agg.misses}/${agg.total}`)

  await store.stop()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
