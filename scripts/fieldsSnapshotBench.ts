// [#384] What the authored-frontmatter projection costs the read-model's snapshot, at
// the scale the seed catalog defines for it: `fields-scale` — 10 000 notes with a
// dozen author keys each. The corpus comes from the case rather than from a literal
// here, so the number is measured on the shape the stand can actually be seeded with.
//
// TWO numbers come out of it, because the task is accountable for two different
// questions and one bracket cannot answer both:
//
//   * the cost of the AUTHOR KEYS — the same corpus indexed twice on the CURRENT
//     ladder, once with its author keys in the files and once with only a title. Both
//     runs project the column, so what the contrast isolates is the strings the keys
//     add on top of a column that is there either way.
//   * the cost of the PROJECTION — the authored corpus indexed twice, once on the
//     current ladder and once on that same ladder with the one step that adds the
//     column taken out. There the column does not exist, `fieldsReady` is false, the
//     meta SELECT keeps the narrow column list and `metaOf` omits the member: this
//     engine, minus the projection. That is what design/01 asks for, and it is the
//     bigger number — `{"keys":{}}` is still an object `metaOf` builds on every note of
//     a title-only corpus, so the first contrast subtracts that base allocation away
//     with the base.
//
// The cut-down ladder is not a special measurement rig; it is the same machinery the
// backfill gate runs on (test/integration/fieldsBackfill.test.ts), which is why the
// projection CAN be switched off here even though nothing in production switches it.
//
// It is a checked-in artifact for the same reason the import bench is: the numbers are
// what the task is accountable for. They are RECORDED, never asserted — a memory
// threshold pinned to one machine and one V8 build is a flaky test wearing a
// benchmark's clothes. What bounds this BY CONSTRUCTION is the blob's byte ceiling,
// and that one is gated, in packages/core/src/libs/fields/blob.test.ts.
//
//   make bench-fields-snapshot                         # the containerised run
//   npm run bench:fields-snapshot                      # the catalog scale, on the host
//   SCALE=0.1 npm run bench:fields-snapshot            # a quick shape check
//
// The npm script carries `NODE_OPTIONS=--expose-gc`, and that is load-bearing rather
// than tidy: see `settledHeap` below. Reaching the flag through the binary instead —
// `node --expose-gc node_modules/.bin/tsx …` — does NOT work, because tsx re-execs a
// child node and the flag stays with the parent (measured: `gc` is undefined there).
// canon: docs/seeds.md

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { NoteMeta } from '@notarium/core'
import {
  createLocalFsFiles,
  createNodeSqliteDriver,
  engineMountOf,
  NotariumStore,
} from '@notarium/engine'

import {
  INDEX_MIGRATIONS,
  type IndexMigration,
} from '../packages/engine/src/services/notariumStore/schema'
import { buildCaseWorld } from '../test/cases/build'

const SCALE = Number(process.env.SCALE || 1)
const CASE = process.env.CASE || 'fields-scale'
/** Enough of the corpus to compile every path the two measured runs then take — the
 *  warm-up is thrown away, so its only job is to happen before them. */
const WARMUP_NOTES = 50

/** The step that adds the column, found by its DDL rather than at a literal index, so a
 *  later appended step cannot silently move this bracket. */
const FIELDS_STEP = INDEX_MIGRATIONS.findIndex((step) => /ADD COLUMN fields\b/.test(step.sql))

if (FIELDS_STEP < 0) {
  // Without the step there is nothing to take out, and the bracket would be the current
  // ladder measured against itself — a projection that costs nothing. Stop instead.
  console.error('fields-snapshot bench: no ladder step adds the `fields` column.')
  process.exit(1)
}

/** The whole ladder MINUS that one step — an exclusion, never a prefix. A later FTS
 *  trigger step already follows fields, proving why the difference matters: the
 *  ladder's rule is that a new change APPENDS a step and never edits one (schema.ts),
 *  so a prefix would drop the later step too
 *  and "the cost of the projection" would quietly become the cost of the projection PLUS
 *  someone else's column. The guard below cannot catch that — it only asks whether any
 *  note projects the field — so the cut is made surgical here instead. A later step that
 *  genuinely depends on this column would fail loudly at migration time, which is the
 *  right outcome: there is no honest bracket for it. */
const LADDER_WITHOUT_FIELDS: readonly IndexMigration[] = INDEX_MIGRATIONS.filter(
  (_, step) => step !== FIELDS_STEP,
)

/** The whole report is a heap DELTA, so it is only a measurement if both brackets are
 *  taken against a settled heap. Without a collector to call, each bracket holds
 *  whatever the run had not collected yet, and the delta prints that garbage as if it
 *  were the projection: this corpus has reported anywhere from 19 to 35 MiB unsettled
 *  against a repeatable 11.2 MiB settled, and on `SCALE=0.05` it goes NEGATIVE. An
 *  optional `gc?.()` therefore has no honest reading — a number two to three times too
 *  large is worse than no number — so the collector is required and its absence stops
 *  the run rather than downgrading it to a sleep. */
const gc = (globalThis as { gc?: () => void }).gc

if (!gc) {
  console.error(
    'fields-snapshot bench: no collector to settle the heap against (globalThis.gc is undefined).',
  )
  console.error('Run it as `npm run bench:fields-snapshot` — the script carries the flag.')
  process.exit(1)
}

const settledHeap = async (): Promise<number> => {
  for (let i = 0; i < 4; i++) {
    gc()
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return process.memoryUsage().heapUsed
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`

type Corpus = { path: string; title: string; frontmatter: string; content: string }

const layDown = async (corpus: readonly Corpus[], authored: boolean): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'notarium-fields-bench-'))

  for (const note of corpus) {
    const full = join(dir, note.path)
    const block = authored && note.frontmatter ? `${note.frontmatter}\n` : ''

    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, `---\ntitle: ${note.title}\n${block}---\n\n${note.content}\n`)
  }

  return dir
}

/** Index the corpus, then measure the heap the SNAPSHOT retains: settle around the
 *  inventory build with the store already warm, so the number is the metas and not the
 *  index build that produced them. The engine is composed here rather than through
 *  `createNotariumStore` for one reason — the ladder has to be an argument, and the
 *  three brackets must otherwise be composed identically or the contrast measures the
 *  composition. The index is `:memory:`, so a dir can be measured on two ladders. */
const measure = async (dir: string, migrations?: readonly IndexMigration[]) => {
  const store = new NotariumStore({
    mounts: [engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(dir))],
    sql: createNodeSqliteDriver(':memory:'),
    ...(migrations ? { migrations } : {}),
  })
  const started = Date.now()

  await store.list() // builds the index; its own allocations are released below
  const indexMs = Date.now() - started
  const before = await settledHeap()
  const seed = await store.changes(null)
  const inventory: NoteMeta[] = seed.inventory
  const after = await settledHeap()
  const projecting = inventory.filter((note) => note.fields != null).length
  const carrying = inventory.filter((note) => Object.keys(note.fields?.keys ?? {}).length).length
  const keys = inventory.reduce(
    (total, note) => total + Object.keys(note.fields?.keys ?? {}).length,
    0,
  )
  // graph() walks the whole corpus and deliberately selects the NARROW column list;
  // the contrast is what shows that choice held.
  const graphStarted = Date.now()

  await store.graph()
  const graphMs = Date.now() - graphStarted

  await store.stop?.()

  return {
    notes: inventory.length,
    projecting,
    carrying,
    keys,
    indexMs,
    graphMs,
    heap: after - before,
  }
}

const perNote = (delta: number, notes: number) =>
  `${mib(delta)} · ${Math.round(delta / notes)} B per note`

const main = async (): Promise<void> => {
  const world = buildCaseWorld(CASE, { scale: SCALE })
  const corpus: Corpus[] = world.events
    .filter((event) => event.op === 'create')
    .map((event) => ({
      path: event.path,
      title: event.title,
      frontmatter: event.frontmatter ?? '',
      content: event.content,
    }))
  const authoredDir = await layDown(corpus, true)
  const bareDir = await layDown(corpus, false)
  // A process's one-time allocations — module compilation, the driver's prepared
  // statements, the first parse of every shape — land inside whichever bracket runs
  // first, and that is `bare`, the number the projection is subtracted FROM. One
  // throwaway pass over a slice of the same corpus puts them outside all three
  // brackets; it is taken on BOTH ladders, because the shorter one takes its own
  // branches (the absent column, the narrow SELECT) and would otherwise compile them
  // inside the bracket it is measured in.
  const warmupDir = await layDown(corpus.slice(0, WARMUP_NOTES), true)

  try {
    await measure(warmupDir)
    await measure(warmupDir, LADDER_WITHOUT_FIELDS)
    const bare = await measure(bareDir)
    const authored = await measure(authoredDir)
    const unprojected = await measure(authoredDir, LADDER_WITHOUT_FIELDS)

    // Each bracket has to actually be the thing it is named after, or a contrast prints
    // a difference between two identical runs and reads as a cheap projection.
    if (!authored.keys || authored.projecting !== authored.notes) {
      console.error('fields-snapshot bench: the authored bracket did not project the column.')
      process.exit(1)
    }
    if (bare.keys || bare.projecting !== bare.notes) {
      console.error('fields-snapshot bench: the title-only bracket is not title-only.')
      process.exit(1)
    }
    if (unprojected.projecting) {
      console.error(
        `fields-snapshot bench: the no-column bracket projected ${unprojected.projecting} notes — the ladder cut is wrong.`,
      )
      process.exit(1)
    }

    console.log(`case=${CASE} scale=${SCALE} notes=${authored.notes}`)
    console.log(`author keys indexed: ${authored.keys} over ${authored.carrying} notes`)
    console.log(
      `index build:      no column ${unprojected.indexMs} ms · title-only ${bare.indexMs} ms · authored ${authored.indexMs} ms`,
    )
    console.log(
      `graph():          no column ${unprojected.graphMs} ms · title-only ${bare.graphMs} ms · authored ${authored.graphMs} ms`,
    )
    console.log(
      `snapshot heap:    no column ${mib(unprojected.heap)} · title-only ${mib(bare.heap)} · authored ${mib(authored.heap)}`,
    )
    console.log(
      `AUTHOR KEYS cost (authored − title-only, both projecting): ${perNote(authored.heap - bare.heap, authored.notes)}`,
    )
    console.log(
      `PROJECTION  cost (authored − same corpus, no fields column): ${perNote(authored.heap - unprojected.heap, authored.notes)}`,
    )
  } finally {
    await rm(authoredDir, { recursive: true, force: true })
    await rm(bareDir, { recursive: true, force: true })
    await rm(warmupDir, { recursive: true, force: true })
  }
}

void main()
