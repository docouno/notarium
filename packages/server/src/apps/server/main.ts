// Process entry: env → config → listen.

import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'

import {
  createEmbedPool,
  createLocalOnnxEmbedder,
  type Embedder,
  localEmbedderAvailable,
} from '@notarium/engine'

import { backupControlSocketFromEnv } from '../../libs/backupControl'
import { loadEnv } from '../../libs/env'
import { trustProxyFromEnv } from '../../libs/trustProxy'
import { replayKeyringConfigFromEnv } from '../../services/installationReplayKey'
import {
  type DataPaths,
  dataPathsFromEnv,
  describeDataPaths,
  ensureDataRoot,
  legacyMetaDbAt,
} from './dataPaths'
import { graphSearchTuning } from './searchTuningEnv'
import { createServer } from './server'
import { spacesFromEnv } from './spacesFromEnv'

loadEnv()

const PORT = Number(process.env.PORT || 3000)
// External-change reconcile cadence (seconds). Watcher-aware: with a watching
// engine (localfs) this is the rare correctness BACKSTOP; where it can't watch
// (network mount, inotify exhausted, in-memory fake) the read-model caps the
// effective interval at 60s. 0 disables the periodic reconcile (watch-only —
// loses the P3 backstop). canon: docs/core.md#write-through · docs/architecture.md#p3
const SYNC_POLL_SECONDS = Number(process.env.SYNC_POLL_SECONDS ?? 120)
// Evict an idle space's read-model after this long; 0 = keep warm.
const SPACE_IDLE_EVICT_SECONDS = Number(process.env.SPACE_IDLE_EVICT_SECONDS ?? 0)
// The ONE data root and everything derived from it. No path is a required env —
// unset DATA_DIR lands on a writable default (/data in the image, an XDG dir on a
// host). A value it refuses to read (an unusable home, an unknown META_DB_URL
// scheme) is an operator-fixable config error: report the message, not a stack.
// canon: docs/architecture.md#data-root
const dataPaths = ((): DataPaths => {
  try {
    return dataPathsFromEnv(process.env)
  } catch (err) {
    console.error(`\n[notarium] ${(err as Error).message}\n`)
    process.exit(1)
  }
})()
const replayKeyring = (() => {
  try {
    return replayKeyringConfigFromEnv(dataPaths.dataDir, dataPaths.metaDbUrl, process.env)
  } catch (err) {
    console.error(`\n[notarium] ${(err as Error).message}\n`)
    process.exit(1)
  }
})()
// Auth mode; 'none' is a single-principal opt-out (desktop, dev, trusted intranet).
// canon: docs/auth.md#modes
const AUTH_MODE = (process.env.AUTH_MODE ?? 'password') as 'password' | 'none'
const TRUST_PROXY = trustProxyFromEnv(process.env.TRUST_PROXY)

if (AUTH_MODE !== 'password' && AUTH_MODE !== 'none') {
  throw new Error(`AUTH_MODE must be "password" or "none", got "${AUTH_MODE}"`)
}
// Vector/hybrid search: on by default; VECTOR_SEARCH=off runs FTS-only (no model
// loaded). One shared local ONNX embedder is built here at the composition root,
// fetched lazily on the first background embed. Two things can still take the
// capability away, and both degrade rather than fail: the embedder not being
// installed (checked below) and vec0's native binary not loading on this platform
// (checked by the engine). EMBED_MODEL and EMBED_DIMENSIONS go TOGETHER — a
// width mismatch fails closed (vec0 insert rejects, note stays FTS-only) rather
// than corrupting the index. Changing the model re-embeds the corpus (index
// self-rebuilds on embedder-id drift). An asymmetric model (e5) also needs
// EMBED_QUERY_PREFIX / EMBED_PASSAGE_PREFIX. canon: docs/search.md#resources-tiers-settings
const VECTOR_SEARCH = (process.env.VECTOR_SEARCH ?? 'on') !== 'off'
const EMBED_DTYPE = process.env.EMBED_DTYPE

if (EMBED_DTYPE && !['fp32', 'fp16', 'q8', 'q4'].includes(EMBED_DTYPE)) {
  throw new Error(`EMBED_DTYPE must be fp32|fp16|q8|q4, got "${EMBED_DTYPE}"`)
}
const posIntEnv = (name: string, raw: string | undefined): number | undefined => {
  if (!raw) {
    return undefined
  }
  const n = Number(raw)

  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`)
  }

  return n
}
// Query/passage prefixes for ASYMMETRIC models (e5); bge-m3 is symmetric and wants
// none. Forgotten prefixes = silent retrieval degradation, so the e5 tier MUST set
// them.
const EMBED_QUERY_PREFIX = process.env.EMBED_QUERY_PREFIX
const EMBED_PASSAGE_PREFIX = process.env.EMBED_PASSAGE_PREFIX
const embedPrefixes =
  EMBED_QUERY_PREFIX != null || EMBED_PASSAGE_PREFIX != null
    ? { query: EMBED_QUERY_PREFIX ?? '', passage: EMBED_PASSAGE_PREFIX ?? '' }
    : undefined
// onnxruntime's CPU memory arena (default ON) retains its peak and grows on the
// varied tensor shapes a backfill produces — on a tight, swap-less box it creeps
// to multiple GB and OOMs the embed. EMBED_CPU_MEM_ARENA=off frees op memory
// between passes at a throughput cost (the memory-constrained tier knob).
const EMBED_CPU_MEM_ARENA = (process.env.EMBED_CPU_MEM_ARENA ?? 'on') !== 'off'
// Cooperative background scheduler tuning: quiet window after the last interactive
// request before background work resumes, and the floor that still grants one worker
// a turn under unrelenting load. The BACKFILL_* names are retained as deployment API.
// canon: docs/core.md#cooperative
const BACKFILL_QUIET_MS = posIntEnv('BACKFILL_QUIET_MS', process.env.BACKFILL_QUIET_MS)
const BACKFILL_DRIP_MS = posIntEnv('BACKFILL_DRIP_MS', process.env.BACKFILL_DRIP_MS)
// Pool size; default reserves 2 cores for HTTP/main and caps at 4 to bound RAM
// (each worker holds its own model copy).
const EMBED_WORKERS =
  posIntEnv('EMBED_WORKERS', process.env.EMBED_WORKERS) ??
  Math.max(1, Math.min(availableParallelism() - 2, 4))
// Intra-op threads, meaning DIFFERS by path: per-worker in the pool (default 1 —
// pool parallelism beats intra-op of one session), but the single-embedder fallback
// below keeps its own half-cores default. So keep the explicit value separate from
// the pool's `?? 1` — don't default it here.
const EMBED_THREADS = posIntEnv('EMBED_THREADS', process.env.EMBED_THREADS)
const embedderOpts = {
  model: process.env.EMBED_MODEL || undefined,
  dtype: (EMBED_DTYPE as 'fp32' | 'fp16' | 'q8' | 'q4' | undefined) || undefined,
  dimensions: posIntEnv('EMBED_DIMENSIONS', process.env.EMBED_DIMENSIONS),
  prefixes: embedPrefixes,
  cpuMemArena: EMBED_CPU_MEM_ARENA,
}
// Build the worker-pool embedder; degrade to a SINGLE in-process embedder if the
// pool can't stand up — honest degradation (P13): a broken pool costs throughput,
// not correctness, and must not crash-loop the boot. canon: docs/architecture.md#p13
//
// Build NOTHING when the optional stack is not installed, and say so once. Asking
// here rather than letting the engine find out is what keeps `capabilities.vector`
// honest: embedder construction is lazy by design (the model loads on first embed),
// so a hollow embedder over a missing package boots green, advertises vector/hybrid
// to the UI and to agents, and only fails one note at a time afterwards. Until #317
// this could not happen — the same carrier also held sqlite-vec, so vec0 refused to
// load and createNotariumStore dropped the embedder. vec0 ships in every profile now,
// so the check has to name the thing it actually depends on. canon: docs/search.md
let embedder: Embedder | undefined

if (VECTOR_SEARCH && !localEmbedderAvailable()) {
  console.error(
    '[notarium] vector search requested but the embedder is not installed — running FTS-only.',
    'Install it with `make deps-vector`, or set VECTOR_SEARCH=off to silence this.',
  )
} else if (VECTOR_SEARCH) {
  try {
    embedder = createEmbedPool({
      ...embedderOpts,
      numThreads: EMBED_THREADS ?? 1,
      workers: EMBED_WORKERS,
    })
  } catch (err) {
    console.error(
      '[notarium] embed worker pool unavailable — falling back to a single in-process embedder:',
      err,
    )
    embedder = createLocalOnnxEmbedder({ ...embedderOpts, numThreads: EMBED_THREADS })
  }
}

// Graph search channel (hub-robust 1-hop wikilink expansion, a third RRF channel);
// OFF by default, opt in with GRAPH_BOOST=on. Rides the hybrid capability — inert
// with vector search off. canon: docs/search.md#graph-channel-hub-robust-1-hop
const searchTuning = graphSearchTuning(process.env.GRAPH_BOOST)

// The notes-mount root for runtime-created spaces is decided HERE, together with
// the space set — it also gates spaceCreate/purge, so root and mode can't be
// resolved independently without risking disagreement.
const { spaces, adoptLegacyInto, spacesRoot } = spacesFromEnv(
  process.env,
  AUTH_MODE,
  dataPaths.defaultSpacesRoot,
)

// Create + write-probe every data dir BEFORE anything listens: the stores mkdir
// lazily on first write, so without this an unwritable root surfaces as a cryptic
// EACCES inside a background job long after a green boot. Reported as a plain
// message, not a stack — the fix is operational (a mount, an owner).
// Refuse to start fresh on top of an un-migrated legacy host: a green boot over
// invisible data reopens the public setup screen, so the first visitor becomes
// owner (silent takeover).
const legacy = legacyMetaDbAt(process.env, dataPaths)

if (legacy) {
  // Move a directory only where THIS process will actually read it afterwards — a
  // line that relocates a still-overridden path would walk data out from under the
  // running host. Merge rather than rename; suppress only "source isn't there", not
  // a blanket `2>/dev/null || true` that would also hide a failed move.
  const moveInto = (from: string, to: string): string =>
    `    [ -d ${from} ] && mkdir -p ${to} && mv ${from}/* ${to}/`
  const legacyJobs = join(dirname(legacy), 'jobs')
  const jobsMove =
    dataPaths.jobsDataDir === join(dataPaths.dataDir, 'jobs')
      ? [moveInto(legacyJobs, dataPaths.jobsDataDir)]
      : [`  Job artifacts stay put — JOBS_DATA_DIR still points at them.`]
  // Only a host that ALSO dropped SPACES_ROOT/ENGINE lands on the derived notes
  // root — only then is there anything to move. With an explicit root the notes are
  // already where this process reads them; naming <dataDir>/spaces would point the
  // migration somewhere it never looks (a green boot over invisible notes).
  const notesMove =
    spacesRoot === dataPaths.defaultSpacesRoot
      ? [moveInto('<old spaces dir>', dataPaths.defaultSpacesRoot)]
      : ['  Your notes stay put — the notes root you configured still points at them.']

  console.error(
    [
      '',
      `[notarium] found a pre-#101 meta-DB at ${legacy}, but this host now keeps its`,
      `  data under one root and ${dataPaths.dataDir} holds no meta-DB. Starting would`,
      '  ignore your existing notes, ids, history and accounts — and re-open the',
      '  first-run setup screen on an empty database. Stop this host, then move the',
      '  state that is NOT regenerable:',
      '',
      `    mkdir -p ${dataPaths.dataDir}`,
      `    mv ${legacy}* ${dataPaths.dataDir}/`,
      ...jobsMove,
      ...notesMove,
      '',
      '  jobs/ moves too: jobs/imports holds the ONLY copy of an upload while its',
      "  import is unfinished, and meta.db carries that job's row across. Only the",
      '  engine index is derived — leave it, it reindexes.',
      '  Keeping the old layout is also fine — set META_DB_URL (and JOBS_DATA_DIR,',
      '  ENGINE_DATA_DIR, SPACES_ROOT) back to where they were. See README →',
      '  "Migrating from the old layout".',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

try {
  await ensureDataRoot(dataPaths, spacesRoot)
} catch (err) {
  console.error(`\n[notarium] ${(err as Error).message}\n`)
  process.exit(1)
}

// A composition refusal (an in-memory meta-DB under password mode, say) is an
// operator-fixable config error like the ones above — lead with the message. The
// error itself still follows, so a genuine defect keeps its stack.
const app = await createServer({
  spaces,
  adoptLegacyInto,
  pollIntervalMs: SYNC_POLL_SECONDS * 1000,
  idleEvictMs: SPACE_IDLE_EVICT_SECONDS * 1000,
  metaDbUrl: dataPaths.metaDbUrl,
  authMode: AUTH_MODE,
  engineDataDir: dataPaths.engineDataDir,
  jobsDataDir: dataPaths.jobsDataDir,
  importStagingDir: dataPaths.importStagingDir,
  spacesRoot,
  embedder,
  searchTuning,
  backgroundQuietMs: BACKFILL_QUIET_MS,
  backgroundDripMs: BACKFILL_DRIP_MS,
  // Canonical public origin for the OAuth connector facade's discovery docs; set
  // PUBLIC_BASE_URL for a stable issuer behind a reverse proxy. Unset → derived
  // per-request from X-Forwarded-* headers. canon: docs/mcp-oauth.md#config
  publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || undefined,
  trustProxy: TRUST_PROXY || undefined,
  backupControlSocket: backupControlSocketFromEnv(),
  replayKeyring,
}).catch((err: unknown) => {
  console.error(`\n[notarium] ${(err as Error).message}\n`)
  console.error(err)
  process.exit(1)
})

let closing = false

const shutdown = async (signal: string): Promise<void> => {
  if (closing) {
    return
  }
  closing = true
  console.log(`[notarium] ${signal}: draining`)
  try {
    await app.close()
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`\n  notarium backend  →  http://localhost:${PORT}`)
  const list = spaces.map((s) => s.slug).join(', ')
  console.log(`  spaces: ${list || '(none yet — first user mints their personal space)'}`)
  // Report where the data actually landed: DATA_DIR-unset resolves a default (an
  // XDG dir) and overrides can scatter paths off the root, so print the real
  // resolved paths, not the nominal root.
  for (const line of describeDataPaths(dataPaths, spacesRoot)) {
    console.log(`  ${line}`)
  }
  console.log('')
} catch (err) {
  console.error(err)
  process.exit(1)
}
