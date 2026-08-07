// Production host assembly: one engine instance per space (isolation), each
// behind its own read-model cache, wired into the shared app via the space layer.
// Everything configurable arrives via options — main.ts is the sole env reader.
// canon: docs/spaces.md#server · docs/architecture.md#p8

import type { FastifyInstance } from 'fastify'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AUTH_MODE, DurableDisplayNameSchema, NOTE_CLASS } from '@notarium/contract'
import {
  AGENT_MEMORY_MOUNT,
  BackgroundScheduler,
  CachedStore,
  type MountConfig,
} from '@notarium/core'
import { createNotariumStore, type Embedder, type SearchTuning } from '@notarium/engine'

import { createFsArtifactStore } from '../../libs/artifactStore'
import { createBackupControl } from '../../libs/backupControl'
import { hostInfoFrom } from '../../libs/hostInfo'
import { createFsImportStagingStore } from '../../libs/importStaging'
import { createMutationGate } from '../../libs/mutationGate'
import { notesDirReader } from '../../libs/notesDir'
import { type AuthMode, createAuthService } from '../../services/auth'
import {
  createMetaDb,
  META_DB_TARGET_KIND,
  metaDbFlavourOf,
  metaDbTargetOf,
  type SpaceRecord,
} from '../../services/metaDb'
import {
  createMarkerStore,
  discoverSpaceFolders,
  healSpaceMarker,
  markFolderAsProject,
  readRootMarker,
  scanProjectsAtBoot,
} from '../../services/projects'
import {
  createFsRoleLibrary,
  createRolesService,
  loadBuiltinRoleCatalog,
} from '../../services/roles'
import { type DiscoveredSpace, SpaceManager } from '../../services/spaces'
import { buildApp, webDist } from './app'
import {
  createExportHandler,
  createImportHandler,
  createJobRunner,
  JOB_KIND_EXPORT,
  JOB_KIND_IMPORT,
  jobToWire,
} from './consumers'

/** Per-space engine config. canon: docs/architecture.md#p11 */
export type SpaceConfig = {
  slug: string
  displayName?: string
  engine?: 'notarium'
  notesDir?: string
  mounts?: MountConfig[]
  indexDb?: string
}

/** Space-relative path of the hidden agent-memory mount. Dot-named so it is
 *  collision-proof vs user folders and falls out of the notes-mount scan for free
 *  (localfs skips dot-dirs) — mounts stay disjoint with no extra logic. Aliases
 *  the core constant so this and memory.ts memoryDirOf (which strips this prefix
 *  off filePath) can't drift — they MUST agree or the directory-scoped find breaks.
 *  canon: docs/note-model.md#agent-memory */
export const AGENT_MOUNT_PREFIX = AGENT_MEMORY_MOUNT

/** Space-relative path of the hidden profile mount: dot-named (hidden from the
 *  notes-mount scan), holds the one reserved `profile`-class note. Present in every
 *  space for layout uniformity though only the personal domain uses it.
 *  canon: docs/note-model.md#note-classes */
export const PROFILE_MOUNT_PREFIX = '.notarium/profile'

/** Space-relative path of the writable Agent Skills library. Built-in catalog
 * templates do NOT live here: Add copies one into this owned, hidden mount. */
export const SKILL_MOUNT_PREFIX = '.notarium/skills'

/** Default mount set for a notarium space. */
export const defaultMounts = (notesDir: string): MountConfig[] => [
  { class: NOTE_CLASS.userDoc, dir: notesDir, prefix: '' },
  {
    class: NOTE_CLASS.agentMemory,
    dir: join(notesDir, AGENT_MOUNT_PREFIX),
    prefix: AGENT_MOUNT_PREFIX,
  },
  {
    class: NOTE_CLASS.profile,
    dir: join(notesDir, PROFILE_MOUNT_PREFIX),
    prefix: PROFILE_MOUNT_PREFIX,
  },
  {
    class: NOTE_CLASS.skill,
    dir: join(notesDir, SKILL_MOUNT_PREFIX),
    prefix: SKILL_MOUNT_PREFIX,
  },
]

/** Resolve the exact mount set shared by the store and sidecar services. A
 * configured class mount is authoritative, including its physical directory. */
const mountsForConfig = (cfg: SpaceConfig, notesDir: string): MountConfig[] => {
  const mounts = cfg.mounts ?? defaultMounts(notesDir)

  return mounts.some((mount) => mount.class === NOTE_CLASS.skill)
    ? mounts
    : [
        ...mounts,
        {
          class: NOTE_CLASS.skill,
          dir: join(notesDir, SKILL_MOUNT_PREFIX),
          prefix: SKILL_MOUNT_PREFIX,
        },
      ]
}

/** Clamp a marker-borne label: a hand-planted `.notariummeta` bypasses the wire's
 *  max(200), so a disk-read displayName is length-capped + stripped of control
 *  chars before it reaches the registry. '' when nothing usable remains. */
const boundLabel = (raw: string | undefined): string => {
  return (
    (raw ?? '')
      // eslint-disable-next-line no-control-regex -- intentional: strip C0/C1 control chars from a label
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 200)
  )
}

export type CreateServerOptions = {
  /** Spaces this host serves, in display order. MAY be empty — a fresh password
   *  host serves none until setup mints the owner's personal space. */
  spaces: SpaceConfig[]
  /** Where to adopt legacy rows (`space=''`) on boot — set ONLY by the legacy
   *  single-space env path; absent ⇒ skip. */
  adoptLegacyInto?: string
  /** External-change poll period in ms; 0 disables polling. */
  pollIntervalMs?: number
  /** Evict an idle space's read-model after this many ms; 0 (default) keeps every
   *  touched space warm. */
  idleEvictMs?: number
  /** Meta-DB URL (sqlite:<path> | postgres://…). Empty ⇒ identity/journal run
   *  ephemeral (note-ids regenerate per process, history lives only for the
   *  process) — honest degradation (P5). Auth does NOT degrade: 'password' refuses to
   *  boot without a meta-DB, and on one that cannot outlive the process. */
  metaDbUrl?: string
  /** How this host authenticates: 'password' (default) or 'none' (single-principal
   *  opt-out). canon: docs/auth.md#modes */
  authMode?: AuthMode
  /** Where notarium spaces keep index DBs when the space pins no path. REQUIRED
   *  and absolute — no default here, so a caller can't silently inherit one;
   *  resolving belongs to the composition root (dataPaths.ts).
   *  canon: docs/architecture.md#data-root */
  engineDataDir: string
  /** Where the durable job layer stages produced artifacts (an export ZIP). Used
   *  only when a meta-DB backs jobs; absent ⇒ no runner, the sync export is the
   *  path. REQUIRED and absolute — see engineDataDir. */
  jobsDataDir: string
  /** Durable import staging (a subtree of jobsDataDir). Passed in, not derived
   *  here: the boot probe must create + prove writable the SAME dir this store
   *  writes to — two join(jobsDataDir,'imports') agree only by coincidence.
   */
  importStagingDir: string
  /** Parent dir for RUNTIME-created spaces (one folder per slug). Setting it turns
   *  ON the spaceCreate capability (mint = mkdir + registry row); unset ⇒
   *  operator-static host, capability honestly false (spaces from config/registry). */
  spacesRoot?: string
  /** Shared embedder for vector/hybrid search, wired into every space (loaded once
   *  per process, not per space). Unset ⇒ spaces run FTS-only, no model loaded
   *  (honest degradation). canon: docs/search.md#model */
  embedder?: Embedder
  /** Hybrid-search RRF fusion tuning, applied to every space. Unset ⇒ conservative
   *  defaults. */
  searchTuning?: Partial<SearchTuning>
  /** Canonical PUBLIC origin the OAuth facade advertises (issuer/resource) — set
   *  for a stable issuer behind a proxy. Unset ⇒ derived per-request from forwarded
   *  headers. canon: docs/mcp-oauth.md#config */
  publicBaseUrl?: string
  /** Direct proxy IP/CIDR allowlist for canonical client-IP resolution. Unset
   *  means X-Forwarded-For cannot affect req.ip or its rate-limit budgets. */
  trustProxy?: string[]
  /** Cooperative background-scheduler tuning: the quiet window background workers
   *  wait after interactive traffic, and the drip floor that still grants one a turn
   *  under load. Unset ⇒ scheduler defaults. canon: docs/core.md#cooperative */
  backgroundQuietMs?: number
  backgroundDripMs?: number
  /** Local Unix socket exposed only inside the container for online-backup
   *  checkpoints. Unset in tests/embedded hosts. */
  backupControlSocket?: string
}

export const createServer = async ({
  spaces,
  adoptLegacyInto,
  pollIntervalMs,
  idleEvictMs,
  metaDbUrl,
  authMode,
  engineDataDir,
  jobsDataDir,
  importStagingDir,
  spacesRoot,
  embedder,
  searchTuning,
  publicBaseUrl,
  trustProxy,
  backgroundQuietMs,
  backgroundDripMs,
  backupControlSocket,
}: CreateServerOptions): Promise<FastifyInstance> => {
  // `createServer` is also a public composition boundary (tests and embedders call
  // it without going through spacesFromEnv). Reject labels that could not be
  // persisted by the registry/marker contract before opening DBs or touching disk.
  for (const space of spaces) {
    if (
      space.displayName !== undefined &&
      !DurableDisplayNameSchema.safeParse(space.displayName).success
    ) {
      throw new Error(`bad displayName for configured space "${space.slug}"`)
    }
  }
  // Present is not durable: an in-memory meta-DB forgets every account on restart.
  // canon: docs/architecture.md#data-root
  if (
    (authMode ?? AUTH_MODE.password) === AUTH_MODE.password &&
    metaDbUrl &&
    metaDbTargetOf(metaDbUrl).kind === META_DB_TARGET_KIND.memory
  ) {
    throw new Error(
      'AUTH_MODE=password needs a durable meta-DB, and META_DB_URL names an in-memory one — point it at a file or a postgres:// URL, or opt out explicitly with AUTH_MODE=none',
    )
  }
  const metaDb = metaDbUrl ? createMetaDb(metaDbUrl) : undefined
  const mutationGate = createMutationGate()
  // The ONE process-global cooperative scheduler — a single instance gates all
  // spaces, so embed backfill and graph enrichment yield to every space's traffic.
  const scheduler = new BackgroundScheduler({
    quietMs: backgroundQuietMs,
    dripMs: backgroundDripMs,
  })
  // 'password' without a meta-DB is a boot error, not a degraded mode — accepting
  // logins into a store that forgets them is worse than refusing to start. The
  // OAuth facet joins the SAME service so its tokens validate at one chokepoint.
  const auth = createAuthService({
    mode: authMode ?? AUTH_MODE.password,
    persistence: metaDb?.auth,
    oauth: metaDb?.oauth,
    // Translate stored space ids ↔ wire slugs.
    spaces: metaDb?.spaces,
    aliasesForSpace: (id) => manager.resolvableAliasesOf(id),
    runMutation: (task) => mutationGate.run(task),
  })
  const configBySlug = new Map(spaces.map((s) => [s.slug, s]))

  // Resolve a space record → its engine config. A config space uses its declared
  // config; a runtime space follows the spaces-root convention over its IMMUTABLE
  // notes_dir (decoupled from the slug — a rename never moves the folder or index).
  const configForRec = (rec: SpaceRecord): SpaceConfig | undefined => {
    const cfg = configBySlug.get(rec.slug)

    if (cfg) {
      return cfg
    }
    if (!spacesRoot) {
      return undefined
    }

    return {
      slug: rec.slug,
      displayName: rec.displayName,
      engine: 'notarium',
      notesDir: join(spacesRoot, rec.notesDir),
    }
  }
  // The `.notariummeta` marker owner, keyed by space id (no local notes dir ⇒ no
  // marker storage). Late-bound to the manager below — only called at runtime,
  // after init, so the forward reference is safe.
  // canon: docs/projects.md#the-notariummeta-marker-schema-parser-pin
  let notesDirOfId: (id: string) => string | null = () => null
  const markerStore = createMarkerStore((id) => notesDirOfId(id))

  // First-provision only (idempotent): mark the space root as a project — always
  // an addressable root so create_note works immediately — and seat the space id
  // into the root `.notariummeta` `space` facet. No meta-DB / no marker ⇒ skip (P5).
  const autoMarkRoot = async (rec: SpaceRecord): Promise<void> => {
    if (!metaDb || !markerStore.available(rec.id)) {
      return
    }
    await markFolderAsProject(
      { projects: metaDb.projects, folders: metaDb.folders, markerStore, now: () => new Date() },
      { space: rec.id, folderPath: '', displayName: rec.displayName },
    )
    await healSpaceMarker({ spaces: metaDb.spaces, markerStore, now: () => new Date() }, rec)
  }
  // Async-export artifact store, built early so onPurge (below) can sweep a purged
  // space's subtree. Present only WITH a meta-DB. canon: docs/jobs.md#artifacts
  const artifacts = metaDb ? createFsArtifactStore(jobsDataDir) : undefined
  // Durable-import staging store: an uploaded export's home so an import job can
  // read it after the request ends / a restart. Present only WITH a meta-DB.
  // canon: docs/jobs.md#input-staging-191
  const staging = metaDb ? createFsImportStagingStore(importStagingDir) : undefined
  const manager = new SpaceManager({
    spaces: spaces.map((s) => ({ slug: s.slug, displayName: s.displayName || s.slug })),
    adoptLegacyInto,
    // Personal spaces are persistent; auth owns "is this a personal space", so the
    // predicate is injected here.
    isPersonalSpace: (id) => auth.isPersonalSpace(id),
    metaDb,
    onProvision: autoMarkRoot,
    // Purge the FS half of a purged space: notes dir under SPACES_ROOT (incl. the
    // hidden agent-mount) + the derived engine index (+ WAL/SHM). Meta-DB rows are
    // wiped separately (atomically) by metaDb.purgeSpace. The startsWith guard keeps
    // a stray config space's operator-managed dir untouched.
    onPurge: spacesRoot
      ? async (rec) => {
          const cfg = configForRec(rec)
          const root = resolve(spacesRoot)
          const dir = cfg?.notesDir ? resolve(cfg.notesDir) : null

          if (dir && (dir === root || dir.startsWith(`${root}/`)) && dir !== root) {
            await rm(dir, { recursive: true, force: true })
          }
          const indexDb = cfg?.indexDb || join(engineDataDir, `${rec.notesDir}.db`)

          for (const suffix of ['', '-wal', '-shm']) {
            await rm(`${indexDb}${suffix}`, { force: true })
          }
          // purgeSpace deleted the job ROWS, so the row-driven TTL GC can no longer
          // reach these ZIPs — sweep the artifact subtree here or they leak forever.
          await artifacts
            ?.removeSpace(rec.id)
            .catch((err) => console.error('[jobs] purge artifacts ->', (err as Error).message))
          // Same as artifacts: rows gone ⇒ the row-aware sweep can't reach these
          // uploads; drop the staging subtree directly.
          await staging
            ?.removeSpace(rec.id)
            .catch((err) => console.error('[jobs] purge import staging ->', (err as Error).message))
        }
      : undefined,
    // Cross-host continuity: adopt a re-cloned space's marker-borne id into an
    // empty registry. Both callbacks need a meta-DB (no registry ⇒ id≡slug, nothing
    // to adopt). readSpaceFacet reads the root marker's `space` facet (the file-truth
    // half of the registry). canon: docs/spaces.md#model
    readSpaceFacet: metaDb
      ? async (def) => {
          const dir = configForRec({
            id: def.slug,
            slug: def.slug,
            displayName: def.displayName,
            notesDir: def.slug,
            aliases: [],
            createdAt: '',
            archivedAt: null,
            archivedBy: null,
          })?.notesDir
          return dir ? (await readRootMarker(dir))?.space : undefined
        }
      : undefined,
    discoverDiskSpaces:
      metaDb && spacesRoot
        ? async () => {
            // Config spaces adopt via readSpaceFacet/provision — exclude their dirs
            // from the runtime walk.
            const configDirs = new Set(
              spaces.map((s) => (s.notesDir ? resolve(s.notesDir) : '')).filter(Boolean),
            )
            const hits = await discoverSpaceFolders(resolve(spacesRoot), (abs) =>
              configDirs.has(abs),
            )
            return hits.map((h): DiscoveredSpace => ({
              id: h.facet.id,
              slug: h.facet.slug,
              aliases: h.facet.aliases ?? [],
              notesDir: h.notesDir,
              // The facet has no displayName; autoMarkRoot seated it as the root
              // project's displayName in the same marker, so reuse that (fall back to
              // the slug). boundLabel clamps it — a hand-planted marker bypasses the wire.
              displayName: boundLabel(h.displayName) || h.facet.slug,
            }))
          }
        : undefined,
    idleEvictMs,
    // Runtime space creation (spacesRoot set): mint = mkdir <root>/<notes_dir> +
    // the hidden agent-mount, suffixed on collision. Returns the ACTUAL folder name
    // (the durable notes_dir, may differ from the slug). Unset ⇒ capability false.
    createSpace: spacesRoot
      ? async (rec) => {
          let name = rec.notesDir

          for (let n = 2; ; n++) {
            try {
              await mkdir(join(spacesRoot, name), { recursive: false })
              break
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw err
              }
              name = `${rec.notesDir}-${n}`
            }
          }
          // Pre-create hidden writable truth mounts. The role catalog itself is
          // packaged read-only data and stays physically separate.
          await mkdir(join(spacesRoot, name, AGENT_MOUNT_PREFIX), { recursive: true })
          await mkdir(join(spacesRoot, name, SKILL_MOUNT_PREFIX), { recursive: true })
          return name
        }
      : undefined,
    createStore: (rec) => {
      const cfg = configForRec(rec)

      if (!cfg) {
        throw new Error(`no engine config for space ${rec.slug}`)
      }
      if (!cfg.notesDir) {
        throw new Error(`space ${rec.slug}: the notarium engine needs notesDir`)
      }
      const notesDir = cfg.notesDir
      const mounts = mountsForConfig(cfg, notesDir)
      const engine = createNotariumStore({
        mounts,
        // Keyed by the stable notes_dir, not the (mutable) slug — a rename never
        // moves the index DB.
        indexDb: cfg.indexDb || join(engineDataDir, `${rec.notesDir}.db`),
        embedder,
        searchTuning,
        scheduler,
      })
      return new CachedStore({
        inner: engine,
        identityPersistence: metaDb?.identity,
        revisionPersistence: metaDb?.revisions,
        // The read-model keys the meta-DB by the STABLE space id.
        space: rec.id,
        pollIntervalMs,
        readBody: notesDirReader(notesDir),
        // A streaming import into this space marks the shared scheduler busy
        // so OTHER spaces' backfills yield to it too.
        scheduler,
        // Folder path-history: the read-model heals `[[oldpath/note]]` from the
        // folder registry — the engine can't (folder identity lives in the
        // `.notariummeta` markers it never reads).
        folderAliases: metaDb
          ? async () =>
              (await metaDb.folders.aliasesForSpace(rec.id)).flatMap((f) =>
                f.pathAliases.map((alias) => ({ current: f.path, alias })),
              )
          : undefined,
      })
    },
  })
  const roles = createRolesService({
    catalog: loadBuiltinRoleCatalog,
    library: createFsRoleLibrary({
      rootForSpace: (space) => {
        const rec = manager.recOf(space)
        const cfg = rec ? configForRec(rec) : undefined
        const notesDir = cfg?.notesDir

        return notesDir
          ? (mountsForConfig(cfg, notesDir).find((mount) => mount.class === NOTE_CLASS.skill)
              ?.dir ?? null)
          : null
      },
    }),
  })

  // Late-bind the marker store's id → notes-dir resolution to the manager.
  notesDirOfId = (id) => {
    const rec = manager.recOf(id)
    return rec ? (configForRec(rec)?.notesDir ?? null) : null
  }
  // The durable job layer: one runner per process draining the `jobs` table.
  // Present only WITH a meta-DB — a none-mode host has no runner, the synchronous
  // streaming export is the honest fallback. canon: docs/jobs.md#durable-job-layer-105
  const jobRunner =
    metaDb && artifacts && staging
      ? createJobRunner({
          jobs: metaDb.jobs,
          artifacts,
          handlers: {
            [JOB_KIND_EXPORT]: createExportHandler({
              resolveStore: (space) => manager.store(space),
              slugOf: (space) => manager.slugOf(space) ?? null,
            }),
            // Durable import: reads the staged upload, writes through the same warm
            // read-model, produces no artifact (its result is the summary).
            [JOB_KIND_IMPORT]: createImportHandler({
              resolveStore: (space) => manager.store(space),
              staging,
            }),
          },
          // Push progress ONLY to the job's owner (its principal) — mirrors the REST
          // ownership gate over status/error/artifact.
          onUpdate: (job) => auth.notifyJobChanged(job.space, job.principal, jobToWire(job)),
          // Reclaim orphaned import uploads. A finished upload's FINAL file is dropped
          // row-aware once its job is terminal/gone; an in-progress `.import.part` is
          // invisible to that pass and reclaimed only past the part-grace (a crash
          // leftover). A live/retrying import keeps its source regardless of age.
          onMaintenance: () =>
            staging.sweepOrphans(async (id) => {
              const j = await metaDb.jobs.get(id)
              return !!j && (j.status === 'pending' || j.status === 'running')
            }, Date.now()),
          runMutation: (task) => mutationGate.run(task),
          enterMutation: () => mutationGate.enter(),
        })
      : undefined
  // Host diagnostics for /api/about: effective search capability + deployment shape.
  const hostInfo = hostInfoFrom({
    embedder,
    searchTuning,
    authMode: authMode ?? AUTH_MODE.password,
    metaDbFlavour: metaDbFlavourOf(metaDbUrl),
    spaces,
  })
  const app = await buildApp({
    spaces: manager,
    auth,
    roles,
    scheduler,
    sessions: metaDb?.sessions,
    agentDeltaCursors: metaDb?.agentDeltaCursors,
    gatewayState: metaDb?.gateway,
    retrievalLog: metaDb?.retrievalLog,
    projects: metaDb?.projects,
    folders: metaDb?.folders,
    favorites: metaDb?.favorites,
    contextSets: metaDb?.contextSets,
    scopePins: metaDb?.scopePins,
    contextOrder: metaDb?.contextOrder,
    spacesPersistence: metaDb?.spaces,
    markerStore,
    spaDist: webDist(),
    about: hostInfo,
    // Async export via the durable job layer. Absent meta-DB ⇒ undefined ⇒
    // the routes 404 and the client uses the sync streaming export.
    jobs: metaDb?.jobs,
    artifacts,
    staging,
    wakeJobs: jobRunner ? () => jobRunner.wake() : undefined,
    mutationGate,
    // OAuth connector facade: active in 'password' mode with a meta-DB backing the
    // token store; none-mode hosts serve the authless connector (no token to mint).
    // canon: docs/mcp-oauth.md#mode-fork
    oauth: (authMode ?? AUTH_MODE.password) === AUTH_MODE.password ? metaDb?.oauth : undefined,
    publicBaseUrl,
    trustProxy,
  })
  const backupControl = backupControlSocket
    ? createBackupControl(backupControlSocket, (signal) =>
        mutationGate.checkpoint(() => manager.checkpointAll(), { signal }),
      )
    : undefined
  // Spaces boot lazily on first touch (nothing is pre-warmed); requests mid-scan
  // get the phase-1 inventory within seconds. canon: docs/core.md#phased-boot
  app.addHook('onReady', async () => {
    // init provisions config spaces AND recovers runtime spaces from the registry —
    // runtime spaces live only in the registry, so without this they'd vanish on restart.
    await manager.init()
    // Boot rule: a space with no members gets owner rows for every active admin;
    // curated membership is never touched.
    await auth.ensureOwners(manager.list().map((s) => s.id))
    // Rebuild the projects registry from on-disk `.notariummeta` markers every boot
    // (lost table / fresh clone / out-of-band marker reconverge). Runs after
    // manager.init (table exists, space set complete). Best-effort, never blocks serving.
    // canon: docs/projects.md#reconcile-the-row-lifecycle-fork-b-lazy-i3-implemented-cadence-boot-only-2026-06-18
    if (metaDb) {
      await scanProjectsAtBoot(
        {
          projects: metaDb.projects,
          folders: metaDb.folders,
          markerStore,
          now: () => new Date(),
        },
        manager.list().map((s) => s.id),
      ).catch((err) => console.error('[projects] boot scan ->', (err as Error).message))
      // Seat each space's identity into its root `.notariummeta` — heals markers
      // that predate the facet. The equality guard makes a steady-state boot a no-op.
      for (const rec of manager.list()) {
        await healSpaceMarker(
          { spaces: metaDb.spaces, markerStore, now: () => new Date() },
          rec,
        ).catch((err) => console.error('[spaces] boot heal ->', (err as Error).message))
      }
    }
    // Start draining the job queue once spaces are recorded; the first maintenance
    // tick reopens any job left 'running' by a previous crash.
    jobRunner?.start()
    await backupControl?.start()
  })
  app.addHook('onClose', async () => {
    await backupControl?.close().catch(() => {})
    // Stop the job runner FIRST: abort in-flight handlers and release their
    // jobs back to pending, before the space stores it reads from are torn down.
    await jobRunner?.stop().catch(() => {})
    // The journal queues and identity flushes must land before the DB closes.
    await manager.stopAll()
    // Release the shared embed pool's worker threads AFTER the stores settle, so no
    // embedNote is still awaiting a worker. Duck-typed: a single in-process embedder
    // has nothing to close.
    await embedder?.close?.().catch(() => {})
    await metaDb?.close().catch(() => {})
  })
  return app
}
