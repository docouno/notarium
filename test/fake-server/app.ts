// The e2e fake backend = the REAL host composition with only the engine
// swapped (the target form): @notarium/server's buildApp over the same
// SpaceManager + CachedStore read-model the production server runs — identity
// passthrough, CAS via the engine's own arbiter, the revision journal
// over the in-memory driver, and the space layer with one InMemoryStore
// per space — plus one test-only reset route. The routes, zod contract
// validation, authz chokepoint, error shaping AND the journaling layer the
// suite exercises ARE the production code paths.
//
// Unlike an operator-static host, the fake's engine
// owns its namespaces — so it can offer `spaceCreate` and exercise the
// create-space flow end to end. Off by default to keep the base fixture's UI
// stable; a fixture opts in via `capabilities.spaceCreate`.

import type { FastifyInstance } from 'fastify'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CachedStore,
  InMemoryRevisionPersistence,
  type InteractiveSignal,
  sha256Hex,
} from '@notarium/core'
import { InMemoryStore, type StoreSnapshot } from '@notarium/engine-memory'
import {
  buildApp,
  createAuthService,
  createExportHandler,
  createFsArtifactStore,
  createFsImportStagingStore,
  createImportHandler,
  createJobRunner,
  hashPassword,
  hostInfoFrom,
  JOB_KIND_EXPORT,
  JOB_KIND_IMPORT,
  jobToWire,
  type MarkerStore,
  markFolderAsProject,
  type MetaDb,
  type MutationGate,
  type ProjectRecord,
  type SpaceDef,
  SpaceManager,
  type SpaceRecord,
  SqliteMetaDb,
} from '@notarium/server'

import { InMemoryAuthPersistence } from './authPersistence'
import { InMemoryContextOrder } from './contextOrder'
import { InMemoryContextSets } from './contextSets'
import { InMemoryFavorites } from './favorites'
import { InMemoryFolders } from './folders'
import { InMemoryGatewayState } from './gatewayState'
import { InMemoryOAuthPersistence } from './oauthPersistence'
import { InMemoryProjects } from './projects'
import { InMemoryRetrievalLog } from './retrievalLog'
import { InMemoryScopePins } from './scopePins'
import { InMemorySpaces } from './spaces'

/** A pre-dated journal revision (activity heatmap/feed). The fake's journal
 *  is otherwise only filled by live writes (stamped "now"), so the dashboard's
 *  Activity surfaces need seeded history at chosen dates to exercise. `kind` is a
 *  DISPLAY intent mapped to a real (journal kind, baseRevisionId) pair:
 *  `created` → write/no-parent, `edited` → write/with-parent, `deleted` →
 *  tombstone, `restored` → restore, `baseline` → the synthetic external/no-parent
 *  row the aggregate must EXCLUDE. `date` is an ISO instant or a YYYY-MM-DD
 *  (noon-UTC). `class` defaults to user-doc (visible); set 'agent-memory' to test
 *  the visibility exclusion. */
export type ActivityFixture = {
  date: string
  kind?: 'created' | 'edited' | 'deleted' | 'restored' | 'baseline'
  title?: string
  principal?: string
  noteId?: string
  class?: string
  charsAdded?: number
  charsRemoved?: number
  /** The note's body AS OF this revision. Seeded into the blob table (keyed by
   *  its sha-256, exactly like a live write), which is what makes a seeded chain
   *  readable rather than a list of "body unknown" rows: the history panel's
   *  revision view and the Changes diff both fetch by `contentHash`. Omit for a
   *  row that only needs to exist as activity. */
  content?: string
}

export type SpaceFixture = {
  slug: string
  displayName?: string
  notes: StoreSnapshot['notes']
  /** Seeded revision history for the activity dashboard. */
  activity?: ActivityFixture[]
}

/** The auth world: present = the fake boots in 'password' mode over the
 *  PRODUCTION AuthService (scrypt, cookie sessions, invites, can()) with these
 *  users/memberships seeded; absent = mode 'none', the pre-auth single
 *  principal — existing suites run untouched. */
export type AuthFixture = {
  users: Array<{
    username: string
    /** Plaintext here, scrypt-hashed at seed time (memoised — scrypt is
     *  deliberately slow and fixtures re-seed per test). */
    password?: string
    displayName?: string
    admin?: boolean
    /** Pre-seed the user's personal domain pointer; omit = null
     *  (provisioned lazily on first agent touch). */
    personalSpace?: string
  }>
  members: Array<{ space: string; username: string; role: 'owner' | 'writer' | 'reader' }>
}

/** Multi-space fixture. NOTE: InMemoryStore derives deterministic
 *  `fake-<slugged-path>` ids from paths alone — keep note paths UNIQUE across
 *  the fixture's spaces or the global id → space resolution turns ambiguous. */
/** A marked-folder project. Seeded straight into the registry — the marker
 *  scan + mark-as-project endpoint are I0c. `path: ''` is a root project (owns the
 *  whole space). Defaults: `slug` = path's last segment (or the space slug for a
 *  root project), `id` = `proj-<space>-<slug>`, `displayName` = slug. */
export type ProjectFixture = {
  space: string
  path: string
  slug?: string
  id?: string
  displayName?: string
  status?: 'active' | 'archived'
  /** Past handle slugs — seed to exercise alias-aware resolveProject. */
  aliases?: string[]
  /** Past folder paths — seed to exercise a moved project's path-history. */
  pathAliases?: string[]
}

export type Fixture = {
  now?: string
  spaces: SpaceFixture[]
  projects?: ProjectFixture[]
  capabilities?: { spaceCreate?: boolean }
  auth?: AuthFixture
  /** Omit the durable job layer from buildApp — reproduces a none-mode host
   *  with no meta-DB backing jobs, so the async-export routes 404 and the client falls
   *  back to the synchronous streaming export (the capability-degradation tier). */
  noJobs?: boolean
  /** Serve the identity of a RELEASED image instead of this unbundled run's
   *  honest nulls — the About tab shows a source link only for a real release, and
   *  that branch is otherwise unreachable outside a published artifact.
   *  canon: docs/release.md#identity */
  build?: { version: string; commit: string | null; builtAt: string | null; source: string | null }
}

/** Expand the fixture's terse project declarations into full registry rows.
 *  `idOf` translates a fixture space-SLUG to the registry's stable space-id:
 *  the `space` column holds the opaque id, while the project's OWN id keeps
 *  the human `proj-<slug>-<slug>` form the tests reference. */
const projectRecords = (fixture: Fixture, idOf: (slug: string) => string): ProjectRecord[] => {
  const now = fixture.now || '2026-01-01T00:00:00.000Z'
  return (fixture.projects ?? []).map((p) => {
    // Last non-empty path segment (a trailing slash must not yield an empty slug).
    const lastSeg = p.path.replace(/\/+$/, '').split('/').pop()
    const slug = p.slug || lastSeg || p.space
    return {
      id: p.id || `proj-${p.space}-${slug}`,
      space: idOf(p.space),
      path: p.path,
      slug,
      // Past handle slugs a fixture can declare to exercise alias resolve.
      aliases: p.aliases ?? [],
      // Past folder paths — usually [] (a fixture rarely pre-moves a project).
      pathAliases: p.pathAliases ?? [],
      displayName: p.displayName || slug,
      status: p.status || 'active',
      lastSeen: now,
      createdAt: now,
    }
  })
}

/** Append a fixture's pre-dated revisions straight into a space's in-memory
 *  journal. Bypasses the RevisionJournal wrapper (dedup/baseline) on purpose
 *  — we want exact rows at exact dates. Appended chronologically so the journal's
 *  monotonic ids match date order (the events feed sorts by id). */
const seedActivity = async (
  revisions: InMemoryRevisionPersistence,
  spaceId: string,
  entries: ActivityFixture[],
) => {
  const normDate = (d: string) => (d.includes('T') ? d : `${d}T12:00:00.000Z`)
  const sorted = [...entries].sort((a, b) => (normDate(a.date) < normDate(b.date) ? -1 : 1))
  let i = 0
  // The id of the last row appended FOR EACH NOTE, so a chained revision points at
  // its real parent. `'0'` — the old blanket value — is not a revision that exists:
  // the Changes tab resolves `baseRev` to fetch the previous body, gets a 404 and
  // sits in its skeleton forever. That only became reachable once rows were keyed
  // to their note (per-note history used to come back empty), so the fix that made
  // history readable is the one that made this visible. Rows without a known parent
  // still fall back to `'0'`: several suites rely on a chained row reading as
  // `edited` rather than `created`, which is what a null parent would make it.
  const lastRevisionOf = new Map<string, string>()

  for (const e of sorted) {
    i++
    const kind = e.kind ?? 'edited'
    const journalKind =
      kind === 'deleted'
        ? 'delete'
        : kind === 'restored'
          ? 'restore'
          : kind === 'baseline'
            ? 'external'
            : 'write'
    const noteId = e.noteId ?? `act-${spaceId}-${i}`
    // `created`/`baseline` have no chain parent; everything else chains to the
    // previous row of the SAME note.
    const baseRevisionId =
      kind === 'created' || kind === 'baseline' ? null : (lastRevisionOf.get(noteId) ?? '0')
    // Content-address the seeded body the same way a live write does, so the blob
    // lands under the hash the reader will ask for.
    const contentHash = e.content != null ? await sha256Hex(e.content) : null
    const appended = await revisions.append(
      {
        noteId,
        space: spaceId,
        baseRevisionId,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: journalKind,
        principal: e.principal ?? 'ui',
        contentHash,
        title: e.title ?? `Activity ${i}`,
        slug: null,
        class: e.class ?? null,
        tags: [],
        createdAt: normDate(e.date),
        charsAdded: e.charsAdded ?? null,
        charsRemoved: e.charsRemoved ?? null,
      },
      e.content ?? null,
    )
    lastRevisionOf.set(noteId, appended.id)
  }
}

// scrypt is ~100ms by design; fixtures re-seed per e2e test — memoise.
const hashMemo = new Map<string, string>()

const memoHash = async (password: string): Promise<string> => {
  let h = hashMemo.get(password)

  if (!h) {
    h = await hashPassword(password)
    hashMemo.set(password, h)
  }

  return h
}

type SpaceWorld = {
  engine: InMemoryStore
  revisions: InMemoryRevisionPersistence
  store: CachedStore
}

export const createApp = async (
  fixture: Fixture,
  opts: {
    spaDist?: string
    markerStore?: MarkerStore
    scheduler?: InteractiveSignal
    mutationGate?: MutationGate
    trustProxy?: string[]
    passwordVerifier?: (password: string, encoded: string) => Promise<boolean>
    oauthPersistence?: InMemoryOAuthPersistence
    /** Test-only seam for deterministic interleavings around the real routes. */
    configureWorld?: (world: SpaceWorld & { slug: string }) => void
  } = {},
): Promise<FastifyInstance> => {
  // The boot fixture is canonical: a body-less reset always restores IT, not
  // whatever world the previous spec swapped in.
  const baseFixture = fixture
  const worlds = new Map<string, SpaceWorld>()

  // The registries (projects + folder-identity) share the real
  // table; the fake keeps two Maps. Declared before buildWorld so the read-model
  // can wire the folder path-history port (heals `[[oldpath/note]]` after a rename).
  const projects = new InMemoryProjects()
  const folders = new InMemoryFolders(projects)
  const favorites = new InMemoryFavorites()
  const contextSets = new InMemoryContextSets()
  const scopePins = new InMemoryScopePins()
  const contextOrder = new InMemoryContextOrder()
  // The space registry: a minimal in-memory SpacesPersistence so the REAL
  // SpaceManager mints an opaque space_id (id ≠ slug) instead of collapsing
  // id ≡ slug — the prerequisite for e2e to see the wire's id→slug projection seam.
  const spacesRegistry = new InMemorySpaces()

  const buildWorld = (rec: SpaceRecord, notes: StoreSnapshot['notes']): SpaceWorld => {
    // The engine + read-model address the space by its STABLE id, exactly
    // as production server.ts does — the slug only ever appears on the wire.
    const engine = new InMemoryStore({ space: rec.id, now: fixture.now, notes })
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner: engine,
      revisionPersistence: revisions,
      space: rec.id,
      // No external change source exists for an in-memory base — polling would
      // only burn cycles. Determinism also wants no timers.
      pollIntervalMs: 0,
      // Folder path-history: same wiring as production server.ts (the
      // folders registry keys by the space id, set on the id-addressed move routes).
      folderAliases: async () =>
        (await folders.aliasesForSpace(rec.id)).flatMap((f) =>
          f.pathAliases.map((alias) => ({ current: f.path, alias })),
        ),
    })
    const world = { engine, revisions, store }

    opts.configureWorld?.({ slug: rec.slug, ...world })
    return world
  }

  const defs: SpaceDef[] = fixture.spaces.map((s) => ({
    slug: s.slug,
    displayName: s.displayName || s.slug,
  }))
  // A meta-DB that backs ONLY the `spaces` facet (the only one SpaceManager reads):
  // it resolves-or-mints each space's opaque id via provisionSpaceIdentity. The fake
  // owns identity in the engines, not a meta-DB — so `identity.findById` is left
  // undefined (resolveNote's `if (findById)` check then falls back to store iteration),
  // and adoptLegacyRows is a no-op (adoptLegacyInto is never set). Shared with
  // createAuthService below so id↔slug translation (me/PAT projections) reads the same
  // registry. `spaces` + `adoptLegacyRows` come through `Pick<MetaDb, …>`, so a shape
  // change to either fails at compile time (the test dir IS type-checked); `identity`
  // is a hand-typed `{ findById: undefined }` whose SHAPE is NOT checked — only its
  // falsiness matters (resolveNote's `if (findById)` fallback). The trailing
  // `as unknown as MetaDb` papers over the facets SpaceManager never reads here, so a
  // FUTURE read of another facet must extend this stub (else a runtime NPE): keep it in
  // lockstep with spaceManager.ts's read sites (`spaces`, `identity.findById`,
  // `adoptLegacyRows`).
  const metaDbStub: Pick<MetaDb, 'spaces' | 'adoptLegacyRows' | 'purgeSpace'> & {
    identity: { findById: undefined }
  } = {
    spaces: spacesRegistry,
    identity: { findById: undefined },
    adoptLegacyRows: async () => {},
    // Permanent purge: drop the registry row (id↔slug gone). The on-disk +
    // world half is the manager's onPurge below; the auth grants are scrubbed by the
    // real drivers transactionally, but here me() already drops a grant whose space the
    // registry no longer lists, so the wire shows the space gone without touching authDb.
    purgeSpace: async (id: string) => spacesRegistry.delete(id),
  }
  const manager = new SpaceManager({
    spaces: defs,
    metaDb: metaDbStub as unknown as MetaDb,
    // Worlds are keyed by the stable id now (a rename never re-keys them).
    createStore: (rec) => {
      let world = worlds.get(rec.id)

      if (!world) {
        world = buildWorld(rec, fixture.spaces.find((s) => s.slug === rec.slug)?.notes ?? [])
        worlds.set(rec.id, world)
      }

      return world.store
    },
    // The in-memory engine owns its namespaces, so creation is always WIRED;
    // whether it's OFFERED follows the live fixture (capability honesty per
    // world — the harness swaps fixtures at runtime).
    createSpace: async (rec) => {
      worlds.set(rec.id, buildWorld(rec, []))
    },
    // Permanent purge: drop the in-memory world (the on-disk analogue). The
    // registry row is removed by metaDbStub.purgeSpace above.
    onPurge: async (rec) => {
      worlds.delete(rec.id)
    },
    spaceCreateEnabled: () => Boolean(fixture.capabilities?.spaceCreate),
    // Auto-mark a freshly minted space's root as a project. Mirrors the
    // production wiring (server.ts) — registry-only here (no marker file), and the
    // displayName is the space's own (NOT the opaque id — the
    // fallback would otherwise label the root project with the id). With the
    // initially-empty registry, init() now fires this for CONFIG spaces too (they're
    // all "new" on first boot), so a seeded fixture space — whose projects come from
    // the fixture, not the auto-mark — is skipped explicitly to stay untouched.
    onProvision: async (rec) => {
      if (fixture.spaces.some((s) => s.slug === rec.slug)) {
        return
      }
      await markFolderAsProject(
        { projects, folders, now: () => new Date() },
        { space: rec.id, folderPath: '', displayName: rec.displayName },
      )
    },
  })
  // Boot: resolve-or-mint each config space's id (populates the registry), then a
  // stable slug→id translator for the seeders below.
  await manager.init()
  // slug→id for the seeders. Fail LOUD on an undeclared space: this fake always has a
  // registry (so every declared space minted an opaque id ≠ slug), hence resolveId
  // only returns null for a slug NOT in `spaces` — a fixture authoring mistake. A
  // silent `?? slug` would seed a slug-keyed grant that me()/slugById then drops,
  // masking the misconfiguration (the exact slug-vs-id flip this guards); mirror
  // production's reject-unknown-slug boundary instead.
  const idOf = (slug: string): string => {
    const id = manager.resolveId(slug)

    if (!id) {
      throw new Error(`fixture references undeclared space: ${slug}`)
    }

    return id
  }
  // Seed the project registry from the fixture (the marker scan that would normally
  // populate it is I0c). Registry-only here (no markerStore) — markFolderAsProject
  // upserts the row directly. AFTER init so space-slugs translate to their ids.
  projects.seed(projectRecords(fixture, idOf))
  // Deterministic tests want every fixture space live before the first request — no
  // lazy-boot timing in the suite (now keyed + booted by the stable id).
  for (const rec of manager.list()) {
    await manager.store(rec.id)
  }
  // Seed activity history into each world's journal AFTER its store booted.
  const seedActivityForFixture = async (fx: Fixture) => {
    for (const s of fx.spaces) {
      if (!s.activity?.length) {
        continue
      }
      const world = worlds.get(idOf(s.slug))

      if (world) {
        await seedActivity(world.revisions, idOf(s.slug), s.activity)
      }
    }
  }
  await seedActivityForFixture(fixture)

  // The auth world: the PRODUCTION service over an in-memory
  // persistence — mode follows the BOOT fixture (a runtime world-swap can't
  // change how the app authenticates, mirroring a real host).
  const authDb = new InMemoryAuthPersistence()
  // The OAuth connector facade's token store — validated through the SAME
  // auth chokepoint, so it joins the production AuthService here.
  const oauthDb = opts.oauthPersistence ?? new InMemoryOAuthPersistence()
  const auth = createAuthService({
    mode: fixture.auth ? 'password' : 'none',
    persistence: authDb,
    oauth: oauthDb,
    passwordVerifier: opts.passwordVerifier,
    // The space registry: grants + the personal pointer are id-keyed,
    // so me/PAT projections translate the stored id back to the wire slug through
    // here (production's slugById/idBySlug). Without it the fake leaked raw ids —
    // invisible only while id ≡ slug.
    spaces: spacesRegistry,
  })

  const seedAuth = async (af: AuthFixture | undefined) => {
    authDb.clear()
    if (!af) {
      return
    }
    const t = fixture.now || '2026-01-01T00:00:00.000Z'

    for (const u of af.users) {
      await authDb.createUser({
        username: u.username,
        displayName: u.displayName || u.username,
        passwordHash: u.password ? await memoHash(u.password) : null,
        admin: Boolean(u.admin),
        disabledAt: null,
        createdAt: t,
        // Seeded users get their personal domain lazily on first agent touch
        // — the fixture seeds projects, not the personal pointer. The pointer
        // holds the stable space id, so translate the fixture's slug.
        personalSpace: u.personalSpace ? idOf(u.personalSpace) : null,
      })
    }
    // Memberships key on the stable space id — translate the fixture slug.
    for (const m of af.members) {
      await authDb.upsertMember(idOf(m.space), m.username, m.role, t)
    }
  }
  await seedAuth(fixture.auth)

  // The MCP gateway's per-token state: start_session delta bookmarks
  // and write-retry dedup, over an in-memory twin the harness resets.
  const gatewayState = new InMemoryGatewayState()
  const retrievalLog = new InMemoryRetrievalLog()

  // /api/about: the in-memory fake wires no embedder (honest FTS) and no
  // meta-DB; authMode follows the boot fixture, engines are the notarium-class
  // in-memory stores. Computed at boot like the real host (a reset can't change
  // how the app authenticates).
  const about = hostInfoFrom({
    authMode: fixture.auth ? 'password' : 'none',
    spaces: defs.map((d) => ({ slug: d.slug, engine: 'notarium' as const })),
  })
  // The durable job layer: the fake wires the REAL runner over an
  // in-memory SQLite jobs facet (`:memory:`) + a tmp FS artifact store, so the async
  // export path (enqueue → background ZIP → Range download) is exercised end to end
  // by the same production code, not stubbed. The InMemoryStore's exportNotes feeds
  // the export handler unchanged.
  const jobsEnabled = !fixture.noJobs
  const jobsMeta = new SqliteMetaDb(':memory:')
  const artifactsDir = mkdtempSync(join(tmpdir(), 'notarium-fake-jobs-'))
  const artifacts = createFsArtifactStore(artifactsDir)
  // Durable import: the fake wires the REAL import handler over a tmp staging
  // store, so enqueue → background write → summary/cancel is exercised end to end by
  // production code (runImport over the InMemoryStore fake engine), not stubbed.
  const stagingDir = mkdtempSync(join(tmpdir(), 'notarium-fake-import-'))
  const staging = createFsImportStagingStore(stagingDir)
  const jobRunner = createJobRunner({
    jobs: jobsMeta.jobs,
    artifacts,
    handlers: {
      [JOB_KIND_EXPORT]: createExportHandler({
        resolveStore: (space) => manager.store(space),
        slugOf: (space) => manager.slugOf(space) ?? null,
      }),
      [JOB_KIND_IMPORT]: createImportHandler({
        resolveStore: (space) => manager.store(space),
        staging,
      }),
    },
    onUpdate: (job) => auth.notifyJobChanged(job.space, job.principal, jobToWire(job)),
    onMaintenance: () =>
      staging.sweepOrphans(async (id) => {
        const j = await jobsMeta.jobs.get(id)
        return !!j && (j.status === 'pending' || j.status === 'running')
      }, Date.now()),
  })

  const app = await buildApp({
    spaces: manager,
    auth,
    gatewayState,
    retrievalLog,
    projects,
    folders,
    favorites,
    contextSets,
    scopePins,
    contextOrder,
    markerStore: opts.markerStore,
    // Omitted when the fixture opts out (noJobs) → the async routes 404, exercising the
    // capability-degradation tier the way a real meta-DB-less host does.
    jobs: jobsEnabled ? jobsMeta.jobs : undefined,
    artifacts: jobsEnabled ? artifacts : undefined,
    staging: jobsEnabled ? staging : undefined,
    wakeJobs: jobsEnabled ? () => jobRunner.wake() : undefined,
    // The same registry backs the PATCH space-rename endpoint — wired
    // faithfully so a future rename e2e gets it for free; no existing route changes.
    spacesPersistence: spacesRegistry,
    spaDist: opts.spaDist,
    about,
    build: fixture.build,
    // The OAuth facade is active only in 'password' mode (none-mode hosts serve
    // the authless connector) — mirrors the production wiring in server.ts.
    oauth: fixture.auth ? oauthDb : undefined,
    // The background scheduler's interactive signal — the fake wires it only
    // when a test passes a spy, so the request-lifecycle hooks can be exercised.
    scheduler: opts.scheduler,
    mutationGate: opts.mutationGate,
    trustProxy: opts.trustProxy,
  })

  // Test-only: re-seed every space from the fixture (optionally a NEW fixture
  // passed in the body — the e2e suite swaps worlds per spec this way), wipe
  // the journals and the auth world, drop test-created spaces and rebuild the
  // snapshots so each E2E test starts clean.
  app.post('/api/__test/reset', { config: { authz: { public: true } } }, async (req) => {
    const next = (req.body as { fixture?: Fixture } | null)?.fixture ?? baseFixture
    fixture = next
    // Worlds + manager are keyed by the stable id now: map each live world
    // back to its record to compare slugs, and drop the ones gone from `next`.
    // (The harness wires no `isPersonalSpace`, so manager.remove never invokes the
    // production "cannot remove a personal space" refusal — a full reset must be able
    // to tear down a runtime-minted personal space too.)
    for (const id of [...worlds.keys()]) {
      const rec = manager.recOf(id)

      if (!rec || !next.spaces.some((s) => s.slug === rec.slug)) {
        await manager.remove(id)
        worlds.delete(id)
      }
    }
    for (const s of next.spaces) {
      const id = manager.resolveId(s.slug)
      const world = id ? worlds.get(id) : undefined

      if (id && world) {
        await world.store.settle()
        world.engine.load({ space: id, now: next.now, notes: s.notes })
        world.revisions.clear()
        await world.store.rescan()
      } else {
        // A brand-new space: the manager mints its opaque id; store() builds the world.
        manager.add({ slug: s.slug, displayName: s.displayName || s.slug })
        await manager.store(manager.resolveId(s.slug) as string)
      }
    }
    // Mirror the registry to the live entries: drops removed spaces, picks up the
    // fresh ids of re-added ones (manager.add mints but doesn't persist) — so id↔slug
    // translation (auth me/PAT) never reads a stale row.
    spacesRegistry.seed(manager.list())
    // Re-seed activity history: the per-space loop above cleared each journal.
    await seedActivityForFixture(next)
    await seedAuth(next.auth)
    gatewayState.clear()
    retrievalLog.clear()
    oauthDb.clear()
    projects.seed(projectRecords(next, idOf))
    favorites.clear()
    contextSets.clear()
    scopePins.clear()
    contextOrder.clear()
    // Folder identities are minted at runtime (no fixture seed), so a reset just
    // wipes them.
    folders.clear()
    return { ok: true }
  })
  // Drain the durable job queue — claims fire on wakeJobs() at enqueue.
  if (jobsEnabled) {
    jobRunner.start()
  }
  app.addHook('onClose', async () => {
    if (jobsEnabled) {
      await jobRunner.stop()
    }
    await jobsMeta.close()
    await rm(artifactsDir, { recursive: true, force: true }).catch(() => {})
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    await manager.stopAll()
  })
  return app
}
