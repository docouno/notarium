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
  READ_SCOPE,
} from '@notarium/core'
import {
  createNotariumStore,
  type Embedder,
  ensureNotariumResourceAuthority,
  type GraphAdjacencyBuildObservation,
  NotariumStoreCompositionOwner,
  renameNoReplaceIfAvailable,
  type SearchTuning,
  SpaceResourceAuthorityRegistry,
} from '@notarium/engine'

import { createFsArtifactStore } from '../../libs/artifactStore'
import { createBackupControl } from '../../libs/backupControl'
import { hostInfoFrom } from '../../libs/hostInfo'
import { createFsImportStagingStore } from '../../libs/importStaging'
import { createMutationGate } from '../../libs/mutationGate'
import { notesDirReader } from '../../libs/notesDir'
import { DurableAbilityCreator } from '../../services/abilities'
import { type AuthMode, createAuthService } from '../../services/auth'
import { CausalOutboxProjector, causalReplicaId } from '../../services/causalOutboxProjector'
import {
  CredentialKeyring,
  type CredentialKeyringConfig,
  CredentialKeyringService,
} from '../../services/credentialKeyring'
import { createFieldSchemaStore } from '../../services/fields'
import { closeTerminalImportReservations } from '../../services/import'
import {
  InstallationReplayKey,
  ReplayKeyring,
  type ReplayKeyringConfig,
} from '../../services/installationReplayKey'
import {
  createMetaDb,
  META_DB_TARGET_KIND,
  metaDbFlavourOf,
  metaDbTargetOf,
  pruneProviderCallLogRetention,
  type SpaceRecord,
  type UserRecord,
} from '../../services/metaDb'
import { BulkRestoreCoordinator, RestoreCoordinator } from '../../services/noteRestore'
import {
  createMarkerStore,
  discoverSpaceFolders,
  healSpaceMarker,
  localFsAnchoredFiles,
  markFolderAsProject,
  projectHandleOf,
  readRootMarker,
  scanProjectsAtBoot,
} from '../../services/projects'
import { ProviderRegistry } from '../../services/providerRegistry'
import { ProviderRuntime } from '../../services/providerRuntime'
import {
  createFsRoleLibrary,
  createProjectedRolePackageScope,
  createRolesService,
  inMemoryAbilityPersistence,
  loadBundledAbilityInventory,
} from '../../services/roles'
import {
  type DiscoveredSpace,
  followPersonalSpaceRename,
  renameSpace,
  SpaceManager,
} from '../../services/spaces'
import { buildApp, webDist } from './app'
import {
  createExportHandler,
  createImportHandler,
  createJobRunner,
  JOB_KIND_EXPORT,
  JOB_KIND_IMPORT,
  jobToWire,
} from './consumers'
import type { ProviderConfig } from './providersEnv'

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

/** Space-relative path of the writable Agent Skills library. The bundled inventory
 * templates do NOT live here: Add copies one into this owned, hidden mount. */
export const SKILL_MOUNT_PREFIX = '.notarium/skills'

/** Which classes a space gets, and where each sits under its notes dir. Split
 *  from the builder below because the SHAPE of the policy has to be readable
 *  without naming a space: composition answers "will a space this host has not
 *  created yet have a library root" from here, rather than by inventing a
 *  directory for one that does not exist. */
const DEFAULT_MOUNT_LAYOUT = [
  { class: NOTE_CLASS.userDoc, prefix: '' },
  { class: NOTE_CLASS.agentMemory, prefix: AGENT_MOUNT_PREFIX },
  { class: NOTE_CLASS.profile, prefix: PROFILE_MOUNT_PREFIX },
  { class: NOTE_CLASS.skill, prefix: SKILL_MOUNT_PREFIX },
] as const

type MountLayoutEntry = (typeof DEFAULT_MOUNT_LAYOUT)[number]

const SKILL_MOUNT_LAYOUT: MountLayoutEntry = DEFAULT_MOUNT_LAYOUT.find(
  (entry) => entry.class === NOTE_CLASS.skill,
)!

const mountAt = (notesDir: string, entry: MountLayoutEntry): MountConfig => ({
  class: entry.class,
  dir: entry.prefix ? join(notesDir, entry.prefix) : notesDir,
  prefix: entry.prefix,
})

/** Default mount set for a notarium space. */
export const defaultMounts = (notesDir: string): MountConfig[] =>
  DEFAULT_MOUNT_LAYOUT.map((entry) => mountAt(notesDir, entry))

/** Resolve the exact mount set shared by the store and sidecar services. A
 * configured class mount is authoritative, including its physical directory. */
const mountsForConfig = (cfg: SpaceConfig, notesDir: string): MountConfig[] => {
  const mounts = cfg.mounts ?? defaultMounts(notesDir)

  return mounts.some((mount) => mount.class === NOTE_CLASS.skill)
    ? mounts
    : [...mounts, mountAt(notesDir, SKILL_MOUNT_LAYOUT)]
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
  /** Engine-local parsed-wikilink cache mode. False selects the atomic reference
   * derivation without changing files, index schema or canonical data. */
  wikilinkParseCache?: boolean
  /** Private per-space observer for successfully published graph adjacency.
   * Production-shaped gates use it without adding a wire capability. */
  onGraphAdjacencyBuilt?: (
    space: SpaceRecord,
    observation: GraphAdjacencyBuildObservation,
  ) => void | Promise<void>
  /** Embedded-host/test observer for the concrete per-space engine after every
   * composition option has been applied. It exposes no wire or runtime capability. */
  onEngineCreated?: (engine: ReturnType<typeof createNotariumStore>, space: SpaceRecord) => void
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
  /** Installation-wide HMAC keyring. The process entry always supplies it;
   *  embedded/test hosts may omit it until they enable durable restore replay. */
  replayKeyring?: ReplayKeyringConfig
  /** Reversible provider-secret keyring. Config is validated even while providers
   *  are off; no filesystem state is created until the subsystem is enabled. */
  credentialKeyring?: CredentialKeyringConfig
  /** Model-provider subsystem deploy config. Absent on embedded/test hosts means
   *  disabled with no operator-admitted private origins. */
  providers?: ProviderConfig
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
  wikilinkParseCache,
  onGraphAdjacencyBuilt,
  onEngineCreated,
  publicBaseUrl,
  trustProxy,
  backgroundQuietMs,
  backgroundDripMs,
  backupControlSocket,
  replayKeyring,
  credentialKeyring,
  providers,
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
  const installationReplayKey =
    metaDb && replayKeyring
      ? new InstallationReplayKey({
          persistence: metaDb.installationGeneration,
          keyring: new ReplayKeyring(replayKeyring.path),
          topology: replayKeyring.topology,
        })
      : undefined
  const credentialKeyringService =
    metaDb && credentialKeyring && providers?.enabled
      ? new CredentialKeyringService({
          persistence: metaDb.secretKeyring,
          keyring: new CredentialKeyring(credentialKeyring.path, credentialKeyring.packedRoots),
          ciphertexts: metaDb.providerCiphertexts,
        })
      : undefined
  const mutationGate = createMutationGate()
  // The journal is not optional, so neither is the meta-DB: a host that cannot record
  // a call does not make one. Without persistence the registry is absent anyway and
  // nothing would ever reach this runtime.
  const providerRuntime =
    metaDb && providers?.enabled
      ? new ProviderRuntime({
          privateOrigins: providers.privateOrigins,
          callLog: metaDb.providerCallLog,
          mutationGate,
        })
      : undefined
  const providerRegistry =
    metaDb && credentialKeyringService && providers?.enabled
      ? new ProviderRegistry({
          credentials: metaDb.credentials,
          resources: metaDb.providerResources,
          attachments: metaDb.providerAttachments,
          attachmentLifecycle: metaDb,
          spaces: metaDb.spaces,
          projects: metaDb.projects,
          directory: metaDb.auth,
          keyring: credentialKeyringService,
          privateOrigins: providers.privateOrigins,
          runtime: providerRuntime,
          mutationGate,
          authMode: authMode ?? AUTH_MODE.password,
        })
      : undefined
  // The ONE process-global cooperative scheduler — a single instance gates all
  // spaces, so embed backfill and graph enrichment yield to every space's traffic.
  const scheduler = new BackgroundScheduler({
    quietMs: backgroundQuietMs,
    dripMs: backgroundDripMs,
  })
  const resourceAuthorities = new SpaceResourceAuthorityRegistry()
  // This process owns one physical adapter assembly per stable space id. The
  // derived store may be cold or evicted while restore still needs the authority;
  // both paths receive this same explicit composition instead of rebuilding it.
  const storeCompositions = new NotariumStoreCompositionOwner()

  // 'password' without a meta-DB is a boot error, not a degraded mode — accepting
  // logins into a store that forgets them is worse than refusing to start. The
  // OAuth facet joins the SAME service so its tokens validate at one chokepoint.
  // Bound once the space manager exists (below): a rename is a runtime event, so the
  // late binding is safe, like `manager` in aliasesForSpace.
  let personalSpaceFollows: (change: {
    user: UserRecord
    previousUsername: string
  }) => Promise<void> = async () => {}
  const auth = createAuthService({
    mode: authMode ?? AUTH_MODE.password,
    persistence: metaDb?.auth,
    oauth: metaDb?.oauth,
    // Translate stored space ids ↔ wire slugs.
    spaces: metaDb?.spaces,
    aliasesForSpace: (id) => manager.resolvableAliasesOf(id),
    runMutation: (task) => mutationGate.run(task),
    removeMemberAndProviderAttachments: metaDb
      ? (space, userId) => metaDb.removeMemberAndProviderAttachments(space, userId)
      : async () => {},
    onUsernameChanged: (change) => personalSpaceFollows(change),
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
  // The `.notariummeta` marker owner, keyed by space id. Write availability joins
  // the notes root, the verified host anchor and a conditional mutation factory,
  // so gate marker-backed mutations on `available(id)`. Late-bound to the
  // manager below: only called at runtime, after init, so the reference is safe.
  // canon: docs/projects.md#the-notariummeta-marker-schema-parser-pin
  let notesDirOfId: (id: string) => string | null = () => null
  const markerStore = createMarkerStore((id) => notesDirOfId(id), {
    // Asked of the storage adapter once, at composition: a medium with no
    // conditional file mutation cannot publish a marker, and this host says so
    // up front rather than at the first Mark as project.
    anchoredFilesForRoot: localFsAnchoredFiles(),
  })
  const fieldSchemaStore = createFieldSchemaStore((id) => notesDirOfId(id))

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
    closeResourceAdmission: async (space, deadlineMs) => {
      await resourceAuthorities.get(space)?.closeAdmission({ deadlineMs })
    },
    reopenResourceAdmission: (space) => resourceAuthorities.get(space)?.reopenAdmission(),
    // Purge the FS half of a purged space: notes dir under SPACES_ROOT (incl. the
    // hidden agent-mount) + the derived engine index (+ WAL/SHM). Meta-DB rows are
    // wiped separately (atomically) by metaDb.purgeSpace. The startsWith guard keeps
    // a stray config space's operator-managed dir untouched.
    onPurge: spacesRoot
      ? async (rec) => {
          fieldSchemaStore.clear(rec.id)
          resourceAuthorities.remove(rec.id)
          storeCompositions.remove(rec.id)
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
      const composition = storeCompositions.getOrCreate(rec.id, mounts)
      const engine = createNotariumStore({
        spaceId: rec.id,
        resourceAuthorityRegistry: resourceAuthorities,
        composition,
        // Keyed by the stable notes_dir, not the (mutable) slug — a rename never
        // moves the index DB.
        indexDb: cfg.indexDb || join(engineDataDir, `${rec.notesDir}.db`),
        embedder,
        searchTuning,
        wikilinkParseCache,
        onGraphAdjacencyBuilt: onGraphAdjacencyBuilt
          ? (observation) => onGraphAdjacencyBuilt(rec, observation)
          : undefined,
        scheduler,
      })
      onEngineCreated?.(engine, rec)
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

  // The personal space follows its owner's handle — after the account rename is
  // durable, never as a reason to roll it back: what fails here is logged, not raised.
  // canon: docs/spaces.md#model
  personalSpaceFollows = async (change) => {
    if (!metaDb) {
      return
    }
    try {
      const outcome = await followPersonalSpaceRename(
        {
          spaces: manager,
          rename: (input) =>
            renameSpace(
              {
                spaces: manager,
                spacesPersistence: metaDb.spaces,
                markerStore,
                notifyRenamed: (id) => auth.notifySpaceRenamed(id),
              },
              input,
            ),
        },
        change,
      )

      if (outcome === 'renamed') {
        console.info(
          `[auth] personal space of ${change.user.id} follows the handle: ${change.previousUsername} → ${change.user.username}`,
        )
      }
    } catch (err) {
      console.warn(
        `[auth] personal space of ${change.user.id} keeps its slug after the rename: ${(err as Error).message}`,
      )
    }
  }
  const causalOutboxProjector = metaDb
    ? new CausalOutboxProjector({
        outbox: metaDb.causalOutbox,
        subscriberId: await causalReplicaId(engineDataDir),
        project: ({ space, resourceId }) => manager.reconcileCausalProjection(space, resourceId),
      })
    : undefined

  const authorityForSpace = async (space: string) => {
    const rec = manager.recOf(space)
    const cfg = rec ? configForRec(rec) : undefined

    if (!rec || !cfg?.notesDir) {
      return null
    }

    const mounts = mountsForConfig(cfg, cfg.notesDir)
    const composition = storeCompositions.getOrCreate(rec.id, mounts)

    return ensureNotariumResourceAuthority({
      spaceId: rec.id,
      resourceAuthorityRegistry: resourceAuthorities,
      composition,
    })
  }
  const restoreCoordinator =
    metaDb && installationReplayKey
      ? new RestoreCoordinator({
          metaDb,
          replayKey: installationReplayKey,
          spaces: manager,
          authorityForSpace,
          wakeOutbox: causalOutboxProjector ? () => causalOutboxProjector.wake() : undefined,
        })
      : undefined
  const bulkRestoreCoordinator =
    metaDb && installationReplayKey && restoreCoordinator
      ? new BulkRestoreCoordinator({
          metaDb,
          replayKey: installationReplayKey,
          single: restoreCoordinator,
          spaces: manager,
          rosterForSelection: async ({ space, selection }) => {
            const store = await manager.store(space)

            if (!store.listTrashed) {
              throw new Error('trash roster unavailable')
            }

            return (
              await store.listTrashed({
                offset: 0,
                limit: 2_147_483_647,
                q: selection.mode === 'all' ? (selection.q ?? undefined) : undefined,
                availability:
                  selection.mode === 'all' && selection.onlyRestorable ? 'restorable' : undefined,
                scope: READ_SCOPE.trash,
              })
            ).items
          },
        })
      : undefined

  /** The skill library root of one existing space, or `null` where this host
   *  serves no library for it. One resolver, used by the library's reads and by
   *  the prospective answer's no-mint branch. */
  const skillRootForSpace = (space: string): string | null => {
    const rec = manager.recOf(space)
    const cfg = rec ? configForRec(rec) : undefined
    const notesDir = cfg?.notesDir

    return notesDir
      ? (mountsForConfig(cfg, notesDir).find((mount) => mount.class === NOTE_CLASS.skill)?.dir ??
          null)
      : null
  }
  const roles = createRolesService({
    catalog: loadBundledAbilityInventory,
    projectHandleForId: async (projectId) => {
      const project = await metaDb?.projects.getById(projectId)
      return project
        ? projectHandleOf(project, manager.slugOf(project.space) ?? project.space)
        : null
    },
    // Spelled either way round, never inherited: a spread that silently contributes
    // nothing is how a host with a meta-DB ends up on volatile facets, and the
    // difference only shows after a restart.
    ...(metaDb
      ? {
          abilityAvailability: metaDb.abilityAvailability,
          abilityPreferences: metaDb.abilityPreferences,
          abilityPlacement: metaDb.abilityPlacement,
        }
      : inMemoryAbilityPersistence()),
    ...createFsRoleLibrary({
      // Asked of the runtime once, at composition: absent here means an install
      // is refused before it stages anything, not after it wrote a package.
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      // Where a Personal Add that has not minted yet would land. A host that can
      // mint reads the answer off the mount LAYOUT, which carries a skill library
      // for every space it produces; one that cannot mint degrades to the first
      // existing space, and that space's own configured root answers. Neither
      // branch touches a disk or invents a root for a space nobody has created.
      prospectivePersonalRoot: () =>
        manager.capabilities.spaceCreate
          ? DEFAULT_MOUNT_LAYOUT.some((entry) => entry.class === NOTE_CLASS.skill)
          : skillRootForSpace(manager.list()[0]?.id ?? '') != null,
      authorityForSpace: async (space) => {
        await manager.store(space)
        return resourceAuthorities.get(space) ?? null
      },
      resourcePrefixForSpace: (space) => {
        const rec = manager.recOf(space)
        const cfg = rec ? configForRec(rec) : undefined
        const notesDir = cfg?.notesDir

        return notesDir
          ? (mountsForConfig(cfg, notesDir).find((mount) => mount.class === NOTE_CLASS.skill)
              ?.prefix ?? null)
          : null
      },
      rootForSpace: skillRootForSpace,
      withProjectedRolePackage: createProjectedRolePackageScope((space) => manager.store(space)),
      projectPublishedPackages: async (space, packages, options) => {
        const store = await manager.store(space)

        // The barrier belongs to publication: it reconciles file truth and blocks
        // mutations across the space while it runs. A reader asks the projection what
        // it currently holds — a package it has not caught up with is answered as
        // absent, which is the same answer as "published a moment later".
        if (options?.settle) {
          if (store.checkpoint) {
            await store.checkpoint()
          } else if (store.reconcile) {
            await store.reconcile()
            await store.identityReady?.()
          } else {
            throw new Error(`space ${space} cannot project a published role package`)
          }
        }
        const notes = await store.list({ scope: READ_SCOPE.all, classes: [NOTE_CLASS.skill] })
        const byPath = new Map(notes.map((note) => [note.filePath, note]))
        const projected = new Map<string, string>()

        for (const pkg of packages) {
          const note = byPath.get(pkg.filePath)

          // A partial answer, by contract: the package may have moved between the
          // directory scan and this lookup, and every caller already reads a missing
          // identity as "not listable". Failing the whole call would turn one racing
          // rename into a 500 for an entire library page.
          if (!note?.id) {
            continue
          }
          projected.set(pkg.directoryName, note.id)
        }

        return projected
      },
    }),
  })
  const customAbilityCreator = metaDb
    ? new DurableAbilityCreator({
        persistence: metaDb.abilityCreate,
        roles,
        authorityForSpace,
        beginProjection: (space, operationId) =>
          manager.beginCausalPublication(space, { kind: 'ability-create', operationId }),
        primeIdentity: (space, record) => manager.primeWarmCausalIdentity(space, record),
        confirmIdentity: (space, noteId) => manager.confirmCausalIdentity(space, noteId),
        releaseIdentity: (space, noteId) => manager.releasePrimedIdentity(space, noteId),
        adoptPublication: (space, evidence) => manager.adoptCausalPublication(space, evidence),
        reconcile: (space, noteId) => manager.reconcileCausalProjection(space, noteId),
        wakeOutbox: causalOutboxProjector ? () => causalOutboxProjector.wake() : undefined,
      })
    : undefined

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
              // The same meta-DB the jobs layer runs on: the reservation proves its
              // premise against the very `jobs` row this handler holds.
              metaDb,
            }),
          },
          // Push progress ONLY to the job's owner (its principal) — mirrors the REST
          // ownership gate over status/error/artifact.
          onUpdate: (job) => auth.notifyJobChanged(job.space, job.principal, jobToWire(job)),
          // Reclaim orphaned import uploads. A finished upload's FINAL file is dropped
          // row-aware once its job is terminal/gone; an in-progress `.import.part` is
          // invisible to that pass and reclaimed only past the part-grace (a crash
          // leftover). A live/retrying import keeps its source regardless of age.
          onMaintenance: async () => {
            await staging.sweepOrphans(async (id) => {
              const j = await metaDb.jobs.get(id)
              return !!j && (j.status === 'pending' || j.status === 'running')
            }, Date.now())
            await pruneProviderCallLogRetention(metaDb.providerCallLog, {
              now: new Date(),
              days:
                providers?.callLogRetentionDays === undefined ? 90 : providers.callLogRetentionDays,
            })
          },
          // Terminal claims close before retention can remove the row that proves
          // the job ended, and before the staging sweep reclaims what it read.
          onTerminalCleanup: () =>
            closeTerminalImportReservations({
              metaDb,
              // A stuck claim is a destination nothing frees; the next tick retries
              // it, and until it succeeds the only evidence is this line.
              log: (message, err) =>
                console.error(`[import] ${message} ->`, (err as Error).message),
            }),
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
    providers: providers?.enabled,
    credentialKeyring: credentialKeyringService?.diagnostic,
  })
  const app = await buildApp({
    spaces: manager,
    auth,
    roles,
    providerRegistry,
    scheduler,
    sessions: metaDb?.sessions,
    customAbilityCreator,
    agentDeltaCursors: metaDb?.agentDeltaCursors,
    gatewayState: metaDb?.gateway,
    retrievalLog: metaDb?.retrievalLog,
    agentCalls: metaDb?.agentCalls,
    sessionAudit: metaDb?.sessionAudit,
    projects: metaDb?.projects,
    folders: metaDb?.folders,
    favorites: metaDb?.favorites,
    contextSets: metaDb?.contextSets,
    scopePins: metaDb?.scopePins,
    contextOrder: metaDb?.contextOrder,
    spacesPersistence: metaDb?.spaces,
    markerStore,
    fieldSchemaStore,
    spaDist: webDist(),
    about: hostInfo,
    // Async export via the durable job layer. Absent meta-DB ⇒ undefined ⇒
    // the routes 404 and the client uses the sync streaming export.
    jobs: metaDb?.jobs,
    artifacts,
    staging,
    wakeJobs: jobRunner ? () => jobRunner.wake() : undefined,
    mutationGate,
    restoreCoordinator,
    bulkRestoreCoordinator,
    // OAuth connector facade: active in 'password' mode with a meta-DB backing the
    // token store; none-mode hosts serve the authless connector (no token to mint).
    // canon: docs/mcp-oauth.md#mode-fork
    oauth: (authMode ?? AUTH_MODE.password) === AUTH_MODE.password ? metaDb?.oauth : undefined,
    publicBaseUrl,
    trustProxy,
  })
  const backupControl = backupControlSocket
    ? createBackupControl(
        backupControlSocket,
        (signal) => mutationGate.checkpoint(() => manager.checkpointAll(), { signal }),
        undefined,
        metaDb?.installationGeneration,
      )
    : undefined
  // Spaces boot lazily on first touch (nothing is pre-warmed); requests mid-scan
  // get the phase-1 inventory within seconds. canon: docs/core.md#phased-boot
  app.addHook('onReady', async () => {
    // Installation recovery precedes lifecycle replay and disk discovery: no
    // watcher or public mutation may observe an ambiguous replay-key generation.
    await installationReplayKey?.bootstrap()
    const credentialKey = await credentialKeyringService?.bootstrap()

    if (credentialKeyringService && !credentialKey) {
      console.error(`[providers] ${credentialKeyringService.errorMessage()}`)
    }
    // init provisions config spaces AND recovers runtime spaces from the registry —
    // runtime spaces live only in the registry, so without this they'd vanish on restart.
    await manager.init()
    await customAbilityCreator?.recover()
    // Accepted restores pin lifecycle work. Resolve their durable state before
    // the outbox/projected read models and public handlers are admitted.
    await restoreCoordinator?.recover()
    await bulkRestoreCoordinator?.recover()
    // Terminal metadata is already committed; repair this replica's derived
    // snapshots before public admission, then keep polling for peer commits.
    await causalOutboxProjector?.start()
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
    providerRuntime?.close()
    await backupControl?.close().catch(() => {})
    await causalOutboxProjector?.stop().catch(() => {})
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
