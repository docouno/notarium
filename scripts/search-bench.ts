// [#193] Search read-path LATENCY bench (the latency twin of eval-search.ts, which
// measures retrieval QUALITY). vec0 KNN cost is driven by chunk COUNT × dim, never
// by the vector VALUES — so this builds a fresh index with a FAKE embedder (instant
// random unit vectors) over a real corpus at the real chunk count and times warm
// store.search(). That sidesteps the multi-hour real-model build while faithfully
// reproducing the corpus-scaling post-retrieval cost (vec0 brute-force KNN, JS-RRF,
// snippets). Real query-embed time (~50-85ms warm) is corpus-independent; add it
// mentally for an end-to-end figure. This is the harness that pinned #193 (a vec0
// partition key → KNN cost growing with note count).
//
//   npx tsx scripts/search-bench.ts \
//     --notes-dir docker/volumes/data/spaces/main \
//     --index-db /tmp/search-bench/bench.db [--dim 1024] [--repeats 6] [--build 0]

import { existsSync, rmSync } from 'node:fs'

import { createHeadingChunker, createNotariumStore, type Embedder } from '@notarium/engine'

const args: Record<string, string> = {}

for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1] ?? ''
}
const NOTES_DIR = args['notes-dir'] || 'docker/volumes/data/spaces/main'
const INDEX_DB = args['index-db'] || '/tmp/search-bench/bench.db'
const DIM = Number(args['dim'] || 1024)
const BUILD = args['build'] !== '0'
const REPEATS = Number(args['repeats'] || 5)

// A length profile, not a topic list: one bare term, one long natural-language
// question, one mid-length phrase, one English phrase, one two-word term. Latency
// tracks token count and chunk count, never the meaning — but non-ASCII queries
// must stay in the set, because FTS tokenization of Cyrillic is a real code path.
const QUERIES = [
  'архитектура',
  'что решили по поводу переезда в новый офис',
  'заметки про планы и приоритеты на следующий квартал',
  'planning next steps project architecture',
  'протокол встречи',
]

const createFakeEmbedder = (dim: number): Embedder => ({
  id: `fake-rand-${dim}@f32`,
  dimensions: dim,
  embed: async (texts) =>
    texts.map(() => {
      const v = new Float32Array(dim)
      let s = 0

      for (let i = 0; i < dim; i++) {
        const x = Math.random() - 0.5
        v[i] = x
        s += x * x
      }
      const n = Math.sqrt(s) || 1

      for (let i = 0; i < dim; i++) {
        v[i] /= n
      }

      return v
    }),
  warmup: async () => {},
})

const main = async (): Promise<void> => {
  if (BUILD && existsSync(INDEX_DB)) {
    for (const suf of ['', '-wal', '-shm']) {
      if (existsSync(INDEX_DB + suf)) {
        rmSync(INDEX_DB + suf)
      }
    }
  }
  const embedder = createFakeEmbedder(DIM)
  const store = createNotariumStore({
    notesDir: NOTES_DIR,
    indexDb: INDEX_DB,
    embedder,
    chunker: createHeadingChunker(),
  })

  const t0 = performance.now()
  await store.search('warmup probe')
  console.log(`scan: ${Math.round(performance.now() - t0)}ms`)
  if (BUILD) {
    const tb = performance.now()
    await store.whenVectorsSettled()
    console.log(`embed-backfill (fake): ${Math.round(performance.now() - tb)}ms`)
  }
  console.log('capabilities:', JSON.stringify(store.capabilities))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql = (store as any).sql
  const notes = await sql.get<{ c: number }>('SELECT COUNT(*) AS c FROM notes')
  const chunks = await sql.get<{ c: number }>('SELECT COUNT(*) AS c FROM note_vectors')
  console.log(`corpus: notes=${notes?.c} chunks=${chunks?.c} dim=${DIM}`)

  // force warm (fake embedder is instant; first hybrid query flips vectorWarm)
  await store.search('заметки')

  console.log('\n━━ per-query timing (warm) ' + '━'.repeat(40))
  for (const q of QUERIES) {
    const times: number[] = []
    let hitN = 0

    for (let r = 0; r < REPEATS; r++) {
      const s = performance.now()
      const hits = await store.search(q, { pageSize: 25 })
      times.push(performance.now() - s)
      hitN = hits.length
    }
    times.sort((a, b) => a - b)
    const best = times[0]
    const med = times[Math.floor(times.length / 2)]
    console.log(
      `q="${q.slice(0, 40)}" hits=${hitN} wall: best=${best.toFixed(0)}ms median=${med.toFixed(0)}ms`,
    )
  }

  await store.stop()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
