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
  type AgentWriteAttribution,
  analyzeDocumentState,
  CachedStore,
  DOCUMENT_ROLE,
  type FieldSchema,
  freshNoteId,
  InMemoryRestoreOperationPersistence,
  type InMemoryRevisionPersistence,
  InMemorySpaceLifecyclePersistence,
  type InteractiveSignal,
  READ_SCOPE,
  REVISION_ENTRY_ROLE,
  sha256Hex,
  SPACE_LIFECYCLE_PHASE,
} from '@notarium/core'
import { InMemoryStore, type StoreSnapshot } from '@notarium/engine-memory'
import {
  type AgentCallRecord,
  type AgentSessionRecord,
  buildApp,
  createAuthService,
  createExportHandler,
  createFsArtifactStore,
  createFsImportStagingStore,
  createImportHandler,
  createInMemoryFieldSchemaStore,
  createJobRunner,
  createRolesService,
  type CustomAbilityCreator,
  hashPassword,
  hostInfoFrom,
  InMemoryAbilityAvailability,
  JOB_KIND_EXPORT,
  JOB_KIND_IMPORT,
  jobToWire,
  loadBundledAbilityInventory,
  type MarkerStore,
  markFolderAsProject,
  type MetaDb,
  type MutationGate,
  ownedRoleLocator,
  ownedSkillLocator,
  projectHandleOf,
  type ProjectRecord,
  PROVIDER_CALL_KIND,
  PROVIDER_RETRY_MODE,
  ProviderRegistry,
  ProviderRuntime,
  type ProviderRuntimeOptions,
  type RoleLocation,
  runProviderJobCall,
  type SkillHomeLocation,
  type SpaceDef,
  spaceLifecycleHasEnded,
  SpaceManager,
  type SpaceRecord,
  SqliteMetaDb,
  SYSTEM_PRINCIPAL,
  SystemAbilityNameConflictError,
  TerminalJobError,
} from '@notarium/server'
import { applyAgentAbilityPreferences } from '../cases/applyAbilityPreferences'
import { applyAgentRoleDeclarations } from '../cases/applyAgentRoles'
import { applyAgentSkillDeclarations } from '../cases/applyAgentSkills'
import { applyProviderSeed } from '../cases/applyProviders'
import { personalSpaceForPlacement } from '../cases/personalSpaceSeam'
import { resolveAvailabilityDecl } from '../cases/resolveAvailability'
import type {
  AgentAbilityPreferenceDecl,
  AgentRoleDecl,
  AgentRoleTargetDecl,
  AgentSkillDecl,
  ProviderSeedDecl,
} from '../cases/types'
import { createInMemoryAbilityPlacement } from './abilityPlacement'
import { InMemoryAbilityPreferences } from './abilityPreferences'
import { InMemoryAgentCalls } from './agentCalls'
import { InMemoryAgentDeltaCursors } from './agentDeltaCursors'
import { InMemoryAgentSessions } from './agentSessions'
import { AuditedRevisionPersistence } from './auditedRevisionPersistence'
import { InMemoryAuthPersistence } from './authPersistence'
import { InMemoryContextOrder } from './contextOrder'
import { InMemoryContextSets } from './contextSets'
import { createFakeCredentialKeyring } from './credentialKeyring'
import { InMemoryFavorites } from './favorites'
import { InMemoryFolders } from './folders'
import { InMemoryGatewayState } from './gatewayState'
import { InMemoryOAuthPersistence } from './oauthPersistence'
import { InMemoryProjects } from './projects'
import { InMemoryProviderCallLog } from './providerCallLog'
import { createInMemoryProviderPersistence, type InMemoryProviderPersistence } from './providers'
import { InMemoryRetrievalLog } from './retrievalLog'
import { InMemoryScopePins } from './scopePins'
import { InMemorySecretKeyringPersistence } from './secretKeyring'
import { InMemorySessionAudit } from './sessionAudit'
import { InMemorySpaces } from './spaces'
import { createStoreRoleLibrary } from './storeRoleLibrary'

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
  /** Optional host-built agent/session attribution for the session-audit twin. */
  agent?: AgentWriteAttribution
  noteId?: string
  class?: string
  charsAdded?: number
  charsRemoved?: number
  /** Body projection as of this revision. Current-format rows additionally
   * provide `snapshot`; body-only content without one intentionally models legacy. */
  content?: string
  /** Complete canonical logical state for current-format seeded rows. Omission
   * deliberately creates a legacy body-only row. */
  snapshot?: string
  /** Byte-safe state blob for exact/opaque named cases. Base64 keeps reset
   * fixtures JSON-stable. When present it wins over snapshot/content. */
  stateBlobBase64?: string
  stateFormat?: 'markdown-v1' | 'markdown-v2' | 'skill-markdown-v1' | 'opaque-v1' | null
  restoreSafety?: 'safe' | 'blocked' | 'unknown' | null
  semanticFingerprint?: string | null
  /** Seed this row as a journal GAP — the state a cross-space id collision leaves
   *  behind (#327). The fake's journal cannot DECIDE a quarantine (that closure
   *  lives in the meta-DB's settlement transaction), so the fixture names the row
   *  and the twin serves it with the drivers' effective-field semantics. */
  unavailable?: boolean
}

export type SpaceFixture = {
  slug: string
  displayName?: string
  archived?: boolean
  /** Past slugs pre-seeded into the real SpaceManager registry. */
  aliases?: string[]
  notes: StoreSnapshot['notes']
  fieldSchema?: FieldSchema
  fieldSchemaRaw?: string
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
    disabled?: boolean
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
  capabilities?: { spaceCreate?: boolean; providers?: boolean }
  providerPrivateOrigins?: string[]
  providers?: ProviderSeedDecl
  /** Pinned lookup / limiter clock for a validate probe against a local server. */
  providerRuntime?: Omit<ProviderRuntimeOptions, 'privateOrigins' | 'callLog' | 'mutationGate'>
  auth?: AuthFixture
  agentSessions?: AgentSessionRecord[]
  agentCalls?: AgentCallRecord[]
  agentCleanupMarkers?: Array<{
    owner: string
    sessionId: string
    operations: Array<{
      reason: 'retention' | 'human-delete'
      cleanup: 'pending' | 'complete'
    }>
  }>
  agentCallDetails?: Array<{
    id: string
    payload: Record<string, string | number | boolean | null>
  }>
  agentTelemetryDetailed?: boolean
  agentRoles?: AgentRoleDecl[]
  agentSkills?: AgentSkillDecl[]
  /** Owner Enable/Disable overrides, applied AFTER the packages above so each row can
   *  name the exact placement that published it. Sparse like the durable facet: a row
   *  exists only where a declaration asked for one, and absence already means enabled. */
  agentAbilityPreferences?: AgentAbilityPreferenceDecl[]
  /** Lower a production bound so a world can cross it with a handful of rows instead
   *  of hundreds. The behaviour behind the bound stays the real one — only the number
   *  is the fixture's. */
  limits?: {
    /** Packages one placement's listing returns before it reports `truncated`. */
    libraryPackages?: number
  }
  /** Omit the durable job layer from buildApp — reproduces a none-mode host
   *  with no meta-DB backing jobs, so the async-export routes 404 and the client falls
   *  back to the synchronous streaming export (the capability-degradation tier). */
  noJobs?: boolean
  /** Omit the agent-session persistence facet to exercise P5 degradation. */
  noAgentSessions?: boolean
  /** Omit the cross-source session audit facet while keeping the rest of the fake meta layer. */
  noSessionAudit?: boolean
  /** Omit the gateway-state facet — a host with no meta-DB behind idempotencyKey.
   *  The DURABLE half of the dedup degrades away (a replay arriving later writes
   *  again); the in-process single-flight does not depend on it. */
  noGatewayState?: boolean
  /** Keep owned roles but omit their reusable context facets to exercise independent
   * P5 degradation of role presets. */
  noContextFacets?: boolean
  /** Serve the identity of a RELEASED image instead of this unbundled run's
   *  honest nulls — the About tab shows a source link only for a real release, and
   *  that branch is otherwise unreachable outside a published artifact.
   *  canon: docs/release.md#identity */
  build?: { version: string; commit: string | null; builtAt: string | null; source: string | null }
}

const TEST_PROVIDER_JOB_KIND = '__test-provider-call'
const TEST_PROVIDER_JOB_CALL_KEY = 'reply'

type TestProviderCallParams = {
  resourceId: string
  model: string
}

const testProviderCallParams = (value: unknown): TestProviderCallParams | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const { resourceId, model } = value as Record<string, unknown>

  return typeof resourceId === 'string' && resourceId && typeof model === 'string' && model
    ? { resourceId, model }
    : null
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
    // The role is a WRITTEN column now, so this second writer stamps it too — its
    // public contract (`kind`) already says exactly which of the three each fixture
    // row is. Leaving it to a default would classify every fake-stand row, and the
    // e2e and demo screenshots that stand on them, by a field nobody set.
    const entryRole =
      kind === 'baseline'
        ? REVISION_ENTRY_ROLE.baseline
        : kind === 'created'
          ? REVISION_ENTRY_ROLE.origin
          : REVISION_ENTRY_ROLE.change
    // Content-address the seeded body the same way a live write does, so the blob
    // lands under the hash the reader will ask for.
    const blob = e.stateBlobBase64
      ? Uint8Array.from(Buffer.from(e.stateBlobBase64, 'base64'))
      : (e.snapshot ?? e.content)
    const contentHash = blob != null ? await sha256Hex(blob) : null
    const appended = await revisions.append(
      {
        noteId,
        space: spaceId,
        baseRevisionId,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: journalKind,
        entryRole,
        principal: e.principal ?? 'ui',
        contentHash,
        semanticFingerprint: e.semanticFingerprint ?? null,
        restoreSafety: e.restoreSafety ?? null,
        stateFormat: e.stateFormat ?? (e.snapshot != null ? 'markdown-v1' : null),
        title: e.title ?? `Activity ${i}`,
        slug: null,
        class: e.class ?? null,
        tags: [],
        createdAt: normDate(e.date),
        charsAdded: e.charsAdded ?? null,
        charsRemoved: e.charsRemoved ?? null,
        agent: e.agent,
      },
      blob ?? null,
    )

    if (e.unavailable) {
      revisions.quarantineForTest([appended.id])
    }
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
    omitAbout?: boolean
    passwordVerifier?: (password: string, encoded: string) => Promise<boolean>
    oauthPersistence?: InMemoryOAuthPersistence
    /** The provider journal, injected so a test can read the rows a real call left:
     *  the subsystem publishes no route over them, deliberately and permanently. */
    providerCallLog?: InMemoryProviderCallLog
    /** Test read-model seam for persisted job params/result/error/phase. */
    onJobsPersistence?: (jobs: MetaDb['jobs']) => void
    /** Test-only access to archive a configured Space without the product guard. */
    onSpacesPersistence?: (spaces: InMemorySpaces) => void
    /** The provider facets, handed back so a test can put an attachment into a state
     *  the acceptance surface will produce once vertical 14 ships it. `idOf` comes
     *  with them because an attachment addresses a Space by its stable id. */
    onProviderPersistence?: (
      persistence: InMemoryProviderPersistence,
      idOf: (slug: string) => string,
    ) => void
    /** Test-only seam for deterministic interleavings around the real routes. */
    configureWorld?: (world: SpaceWorld & { slug: string }) => void
    contextSets?: InMemoryContextSets
    /** Runs only after live space/project/note identities exist, initially and after reset. */
    seedContextSets?: (ctx: {
      contextSets: InMemoryContextSets
      spaceIdOf(slug: string): string
      projectIdOf(spaceSlug: string, path: string): Promise<string>
      noteIdAt(spaceSlug: string, filePath: string): Promise<string>
    }) => void | Promise<void>
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
  const contextSets = opts.contextSets ?? new InMemoryContextSets()
  const scopePins = new InMemoryScopePins()
  const contextOrder = new InMemoryContextOrder()
  // Declared here rather than beside the meta-DB stub below because the ability twins
  // are built out of it: it is the journal half of their fence, and an arrow that
  // closed over it before it existed would answer a Space in `purge-intent` `false`.
  const spaceLifecycle = new InMemorySpaceLifecyclePersistence()
  // The registry the durable schema's foreign keys point at. Without it the fake is
  // silently laxer than the server it stands in for: a binding to a project of
  // another Space would be stored, and neither cascade would ever be observed.
  //
  // BOTH halves of the ability fence, out of the two registries this host really keeps:
  // the `spaces` row and the lifecycle journal beside it. Handing over the first alone
  // is what made the fake accept an override and a policy in a Space already in
  // `purge-intent`, where every driver refuses — the very laxness the paragraph above
  // says this wiring exists to prevent. The phase list is the drivers' own
  // (`spaceLifecycleHasEnded`), not a copy.
  const spaceEnded = async (spaceId: string): Promise<boolean> =>
    spaceLifecycleHasEnded(await spaceLifecycle.get(spaceId))
  const abilityAvailability = new InMemoryAbilityAvailability({
    projectHomeSpace: async (projectId) => (await projects.getById(projectId))?.space ?? null,
    spaceExists: async (spaceId) => (await spacesRegistry.getById(spaceId)) != null,
    spaceEnded,
  })
  const abilityPreferences = new InMemoryAbilityPreferences({
    spaceExists: async (spaceId) => (await spacesRegistry.getById(spaceId)) != null,
    spaceEnded,
  })
  const agentSessions = new InMemoryAgentSessions()
  const retrievalLog = new InMemoryRetrievalLog()
  const agentCalls = new InMemoryAgentCalls(agentSessions, retrievalLog)
  const sessionAudit = new InMemorySessionAudit(agentSessions, retrievalLog, agentCalls)
  agentCalls.attachRevisionLinks((owner, id) => sessionAudit.linkedRevisions(owner, id))
  const agentDeltaCursors = new InMemoryAgentDeltaCursors()
  projects.attachLifecycle(agentDeltaCursors)
  agentSessions.attachLifecycle(agentDeltaCursors)
  // The space registry: a minimal in-memory SpacesPersistence so the REAL
  // SpaceManager mints an opaque space_id (id ≠ slug) instead of collapsing
  // id ≡ slug — the prerequisite for e2e to see the wire's id→slug projection seam.
  const spacesRegistry = new InMemorySpaces()
  opts.onSpacesPersistence?.(spacesRegistry)
  // Declared here, not at the auth block below: provider resolution derives owner
  // deactivation and owner membership from these rows, so the registry needs them
  // at construction.
  const authDb = new InMemoryAuthPersistence()
  const secretKeyring = new InMemorySecretKeyringPersistence()
  const providerPersistence = createInMemoryProviderPersistence({
    spaceIsLive: async (space) =>
      (await spacesRegistry.getById(space)) != null &&
      !spaceLifecycleHasEnded(await spaceLifecycle.get(space)),
    ownerIsMember: async (space, owner) =>
      (await authDb.grantsFor(owner)).some((grant) => grant.space === space),
    activeCiphertextKey: () => secretKeyring.activeWrite(),
    retireCiphertextKeys: (keyIds, retiredAt) => secretKeyring.retireKeys(keyIds, retiredAt),
  })
  const fakeCredentialKeyring =
    fixture.capabilities?.providers || fixture.providers
      ? createFakeCredentialKeyring(providerPersistence.providerCiphertexts, secretKeyring)
      : undefined
  const providerCallLog = opts.providerCallLog ?? new InMemoryProviderCallLog()
  const providerRuntime = fixture.capabilities?.providers
    ? new ProviderRuntime({
        privateOrigins: new Set(fixture.providerPrivateOrigins ?? []),
        callLog: providerCallLog,
        mutationGate: opts.mutationGate,
        ...(fixture.providerRuntime ?? {}),
      })
    : undefined
  const providerSeedRegistry = fakeCredentialKeyring
    ? new ProviderRegistry({
        credentials: providerPersistence.credentials,
        resources: providerPersistence.providerResources,
        attachments: providerPersistence.providerAttachments,
        attachmentLifecycle: providerPersistence,
        spaces: spacesRegistry,
        projects,
        directory: authDb,
        keyring: fakeCredentialKeyring.service,
        privateOrigins: new Set(fixture.providerPrivateOrigins ?? []),
        runtime: providerRuntime,
        mutationGate: opts.mutationGate,
        authMode: fixture.auth ? 'password' : 'none',
        now: fixture.now ? () => new Date(fixture.now!) : undefined,
      })
    : undefined
  const providerRegistry = fixture.capabilities?.providers ? providerSeedRegistry : undefined

  if (providerSeedRegistry && fakeCredentialKeyring) {
    await fakeCredentialKeyring.service.bootstrap()
  }

  const buildWorld = (rec: SpaceRecord, notes: StoreSnapshot['notes']): SpaceWorld => {
    // The engine + read-model address the space by its STABLE id, exactly
    // as production server.ts does — the slug only ever appears on the wire.
    const engine = new InMemoryStore({ space: rec.id, now: fixture.now, notes })
    const revisions = new AuditedRevisionPersistence(sessionAudit, rec.id, [
      abilityAvailability,
      abilityPreferences,
    ])
    const store = new CachedStore({
      inner: engine,
      revisionPersistence: revisions,
      space: rec.id,
      // No external change source exists for an in-memory base — polling would
      // only burn cycles. Determinism also wants no timers.
      pollIntervalMs: 0,
      readBody: async (filePath) => engine.rawFileAt(filePath),
      // InMemoryStore already owns/materializes identity. Raw bytes are still the
      // authoritative facts/preview source, but must not install a second path owner.
      readBodyIdentityClaims: false,
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

  // An archived case Space is runtime-created before being archived. Putting it
  // into config defs would make the lifecycle correctly refuse the archive as a
  // pinned deployment Space, which is a different state from the case's soft-
  // archived user Space.
  const defs: SpaceDef[] = fixture.spaces
    .filter((space) => !space.archived)
    .map((space) => ({
      slug: space.slug,
      displayName: space.displayName || space.slug,
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
  const restoreOperations = new InMemoryRestoreOperationPersistence(spaceLifecycle)
  const metaDbStub: Pick<
    MetaDb,
    'spaces' | 'spaceLifecycle' | 'restoreOperations' | 'jobs' | 'adoptLegacyRows' | 'purgeSpace'
  > & { identity: { findById: undefined } } = {
    spaces: spacesRegistry,
    spaceLifecycle,
    restoreOperations,
    jobs: {
      list: async () => [],
      cancel: async () => false,
    } as unknown as MetaDb['jobs'],
    identity: { findById: undefined },
    adoptLegacyRows: async () => {},
    // Permanent purge: drop the registry row (id↔slug gone). The on-disk +
    // world half is the manager's onPurge below; the auth grants are scrubbed by the
    // real drivers transactionally, but here me() already drops a grant whose space the
    // registry no longer lists, so the wire shows the space gone without touching authDb.
    purgeSpace: async (id: string) => {
      await providerPersistence.coordinator.run(() => {
        providerPersistence.purgeSpaceInsideCoordinator(id)
        spacesRegistry.delete(id)
        // The Space's overrides go with it and the fence closes behind them — the
        // second half of what the driver does in one transaction.
        abilityPreferences.spacePurged(id)
      })
    },
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
      worlds.set(
        rec.id,
        buildWorld(rec, fixture.spaces.find((space) => space.slug === rec.slug)?.notes ?? []),
      )
    },
    // Permanent purge: drop the in-memory world (the on-disk analogue). The
    // registry row is removed by metaDbStub.purgeSpace above.
    onPurge: async (rec) => {
      fieldSchemaStore.clear(rec.id)
      worlds.get(rec.id)?.revisions.clear()
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
  for (const space of fixture.spaces) {
    if (!space.archived) {
      continue
    }
    manager.add({ slug: space.slug, displayName: space.displayName || space.slug })
    const id = manager.resolveId(space.slug) as string
    const record = manager.recOf(id)

    if (!record) {
      throw new Error(`fixture could not mint archived Space: ${space.slug}`)
    }
    await spacesRegistry.upsert(record)
    await spaceLifecycle.ensure(id, SPACE_LIFECYCLE_PHASE.active, record.createdAt)
    await manager.store(id)
  }
  spacesRegistry.seed(manager.list())
  const fieldSchemaStore = createInMemoryFieldSchemaStore()

  for (const seeded of fixture.spaces) {
    const id = manager.resolveId(seeded.slug)

    if (id) {
      if (seeded.fieldSchemaRaw) {
        fieldSchemaStore.seedRaw(id, seeded.fieldSchemaRaw)
      } else {
        fieldSchemaStore.seed(id, seeded.fieldSchema)
      }
    }
  }
  // A fixture authors the current slug plus its retired handles. Config provision
  // mints the current record; apply the history afterward through the same
  // persistence + in-memory seams a committed rename updates.
  for (const fixtureSpace of fixture.spaces) {
    if (!fixtureSpace.aliases?.length) {
      continue
    }
    const id = manager.resolveId(fixtureSpace.slug)
    const record = id ? manager.recOf(id) : undefined

    if (!record) {
      throw new Error(`fixture aliases reference undeclared space: ${fixtureSpace.slug}`)
    }
    const withAliases = { ...record, aliases: [...fixtureSpace.aliases] }
    await spacesRegistry.upsert(withAliases)
    manager.applyRename(withAliases)
  }
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
  opts.onProviderPersistence?.(providerPersistence, idOf)
  // Seed the project registry from the fixture (the marker scan that would normally
  // populate it is I0c). Registry-only here (no markerStore) — markFolderAsProject
  // upserts the row directly. AFTER init so space-slugs translate to their ids.
  projects.seed(projectRecords(fixture, idOf))
  const seedContextSetFacet = async () => {
    if (!opts.seedContextSets) {
      return
    }
    await opts.seedContextSets({
      contextSets,
      spaceIdOf: idOf,
      projectIdOf: async (spaceSlug, path) => {
        const match = (await projects.listForSpace(idOf(spaceSlug))).find(
          (project) => project.path === path,
        )

        if (!match) {
          throw new Error(`fixture project not found: ${spaceSlug}/${path}`)
        }

        return match.id
      },
      noteIdAt: async (spaceSlug, filePath) => {
        const store = await manager.store(idOf(spaceSlug))
        const matches = (await store.list({ scope: READ_SCOPE.all })).filter(
          (note) => note.filePath === filePath && note.id,
        )

        if (matches.length !== 1) {
          throw new Error(`fixture note path is absent or ambiguous: ${spaceSlug}/${filePath}`)
        }

        return matches[0].id!
      },
    })
  }
  await seedContextSetFacet()
  const roleLibrary = createStoreRoleLibrary(
    async (space) => manager.store(space),
    // Read per call: a reset swaps the whole world, and with it the bound a fixture
    // asked the listing to report as truncated.
    () => fixture.limits?.libraryPackages,
  )
  const roles = createRolesService({
    catalog: loadBundledAbilityInventory,
    projectHandleForId: async (projectId) => {
      const project = await projects.getById(projectId)
      return project
        ? projectHandleOf(project, manager.slugOf(project.space) ?? project.space)
        : null
    },
    library: roleLibrary.library,
    publication: roleLibrary.publication,
    abilityAvailability,
    abilityPreferences,
    // Placement is part of an owned Role's address. This host keeps every table keyed
    // by it, so the no-op default would silently strand context, the owner's
    // preference and a live episode on a placement that no longer exists.
    abilityPlacement: createInMemoryAbilityPlacement({
      contextSets,
      scopePins,
      contextOrder,
      abilityPreferences,
      agentSessions,
    }),
  })
  const customAbilityCreator: CustomAbilityCreator = {
    createDurably: async ({ attribution, preparePackage, operation }) => {
      let { prepared, pkg } = await preparePackage()
      const availability = prepared.availability

      if (
        operation?.systemNamePolicy === 'reject' &&
        (await roles.hasSystemAbility(prepared.kind, prepared.body.name))
      ) {
        throw new SystemAbilityNameConflictError(
          `${prepared.kind} "${prepared.body.name}" conflicts with a System ability`,
        )
      }

      if (availability) {
        while (
          !(await abilityAvailability.reserve(
            prepared.location.space,
            pkg.directoryName,
            availability,
          ))
        ) {
          ;({ prepared, pkg } = await preparePackage())
        }
      }
      const manifest = pkg.files.get('SKILL.md')
      const path = roles.manifestPath(prepared.location, pkg.directoryName)

      if (!manifest || pkg.files.size !== 1 || !path) {
        throw new Error('fake custom ability must be one SKILL.md package')
      }
      const state = analyzeDocumentState({
        source: manifest,
        role: DOCUMENT_ROLE.skillRoot,
        skillDirectoryName: pkg.directoryName,
      })
      const projection = state.projection

      if (!projection?.skill) {
        throw new Error('fake custom ability manifest is invalid')
      }
      const store = await manager.store(prepared.location.space)
      let written

      try {
        written = await roles.withCreateAdmission(prepared.location, pkg.directoryName, () =>
          store.write(
            {
              id: pkg.directoryName,
              title:
                projection.titleOrigin.kind === 'hidden-h1'
                  ? projection.titleOrigin.title
                  : projection.title,
              content: projection.body,
              frontmatter: projection.frontmatterEntries,
              frontmatterMode: 'replace',
              targetClass: 'skill',
              restorePath: path,
              principal: attribution.principal,
              ...(attribution.agent ? { agent: attribution.agent } : {}),
            },
            {
              requiredRevision: true,
              resourceAdmitted: true,
              ...(prepared.availability
                ? {
                    beforePublish: async ({ id }) => {
                      if (
                        !(await abilityAvailability.finalize(
                          prepared.location.space,
                          pkg.directoryName,
                          id,
                        ))
                      ) {
                        throw new Error('fake ability availability finalize failed')
                      }
                    },
                  }
                : {}),
            },
          ),
        )
      } catch (error) {
        if (prepared.availability) {
          await abilityAvailability.cancel(prepared.location.space, pkg.directoryName)
        }
        throw error
      }
      if (!written.id || !written.versionToken) {
        throw new Error('fake custom ability produced no identity')
      }
      const ability = {
        name: prepared.body.name,
        title: projection.title,
        description: prepared.body.description,
        scope: prepared.location.scope,
        space: prepared.location.space,
        ...(prepared.location.projectId ? { projectId: prepared.location.projectId } : {}),
        ...(prepared.availability ? { availability: prepared.availability } : {}),
        packageId: pkg.directoryName,
        noteId: written.id,
      }

      return prepared.kind === 'role'
        ? {
            kind: 'role',
            body: prepared.body,
            location: prepared.location as RoleLocation,
            ability,
            locator: ownedRoleLocator(prepared.location as RoleLocation, pkg.directoryName),
            versionToken: written.versionToken,
          }
        : {
            kind: 'skill',
            body: prepared.body,
            location: prepared.location as SkillHomeLocation,
            ability: {
              ...ability,
              scope: (prepared.location as SkillHomeLocation).scope,
            },
            locator: ownedSkillLocator(prepared.location as SkillHomeLocation, pkg.directoryName),
            versionToken: written.versionToken,
          }
    },
  }

  const seedAgentPackages = async (fx: Fixture): Promise<void> => {
    const resolveRoleTarget = async (target: AgentRoleTargetDecl) => {
      if (target.kind === 'personal') {
        const user = target.user
          ? fx.auth?.users.find((candidate) => candidate.username === target.user)
          : fx.auth?.users[0]
        const personal = user?.personalSpace

        if (!personal) {
          throw new Error('fixture agent package has no personal space')
        }

        return { scope: 'personal' as const, space: idOf(personal) }
      }
      if (target.kind === 'space') {
        return { scope: 'space' as const, space: idOf(target.space) }
      }
      const project = projectRecords(fx, idOf).find(
        (candidate) => candidate.space === idOf(target.space) && candidate.path === target.path,
      )

      if (!project) {
        throw new Error('fixture agent package references an unknown project')
      }

      return { scope: 'project' as const, space: project.space, projectId: project.id }
    }
    const projectOf = (reference: { space: string; path: string }) =>
      projectRecords(fx, idOf).find(
        (candidate) =>
          candidate.space === idOf(reference.space) && candidate.path === reference.path,
      ) ?? null
    // Every space that IS somebody's personal one, by id — this stand's answer to the
    // question production answers with `peekPersonalSpace` on every owned-package call.
    const personalSpaceIds = new Set(
      (fx.auth?.users ?? []).flatMap((user) =>
        user.personalSpace ? [idOf(user.personalSpace)] : [],
      ),
    )
    const appliedRoles = await applyAgentRoleDeclarations({
      declarations: fx.agentRoles ?? [],
      roles,
      resolveLocation: async (declaration) => {
        const location = await resolveRoleTarget(declaration.target)

        if (declaration.availability && location.scope !== 'space') {
          throw new Error(`fixture role ${declaration.name} cannot declare availability here`)
        }

        return {
          location,
          personalSpace: personalSpaceForPlacement(personalSpaceIds, location.space),
          ...(location.scope === 'space'
            ? {
                availability: resolveAvailabilityDecl(
                  declaration.availability,
                  location.space,
                  projectOf,
                  `fixture role ${declaration.name}`,
                ),
              }
            : {}),
        }
      },
      storeForSpace: (space) => manager.store(space),
    })

    const appliedSkills = await applyAgentSkillDeclarations({
      declarations: fx.agentSkills ?? [],
      roles,
      library: roleLibrary.library,
      seedPackageFile: roleLibrary.seedPackageFile,
      storeForSpace: (space) => manager.store(space),
      resolveLocation: async (declaration) => {
        const home = declaration.home

        if (home.kind === 'personal') {
          if (declaration.availability) {
            throw new Error(
              `fixture personal skill ${declaration.name} cannot declare availability`,
            )
          }
          const user = home.user
            ? fx.auth?.users.find((candidate) => candidate.username === home.user)
            : fx.auth?.users[0]
          const personal = user?.personalSpace

          if (!personal) {
            throw new Error(`fixture personal skill ${declaration.name} has no personal space`)
          }

          const location = { scope: 'personal' as const, space: idOf(personal) }
          return {
            role: declaration.roleTarget
              ? await resolveRoleTarget(declaration.roleTarget)
              : location,
            skill: location,
          }
        }
        const location = { scope: 'space' as const, space: idOf(home.space) }
        const availability = resolveAvailabilityDecl(
          declaration.availability,
          location.space,
          projectOf,
          `fixture skill ${declaration.name}`,
        )

        return {
          role: declaration.roleTarget ? await resolveRoleTarget(declaration.roleTarget) : location,
          skill: location,
          availability,
        }
      },
    })

    // Owner Enable/Disable, written LAST against the ids the two appliers just minted
    // — by the one applier both stands share (`test/cases/applyAbilityPreferences.ts`),
    // so this fake and `scripts/seed.ts` cannot disagree about what a case declares.
    // Only the clock and the facet are this host's.
    const updatedAt = fx.now ?? new Date().toISOString()

    await applyAgentAbilityPreferences({
      declarations: fx.agentAbilityPreferences ?? [],
      roles,
      publishedRoles: appliedRoles,
      publishedSkills: appliedSkills,
      resolvePlacement: resolveRoleTarget,
      ownerOf: (preference) => {
        const owner = preference.user ?? fx.auth?.users[0]?.username

        if (!owner) {
          throw new Error('fixture ability preference has no owner')
        }

        return owner
      },
      setEnabled: (owner, target, enabled) =>
        abilityPreferences.setEnabled(owner, target, enabled, updatedAt),
    })
  }
  await seedAgentPackages(fixture)
  const seedAgentSessions = async (fx: Fixture): Promise<void> => {
    const records = await Promise.all(
      (fx.agentSessions ?? []).map(async (record) => {
        if (!record.role) {
          return record
        }
        const user = fx.auth?.users.find((candidate) => candidate.username === record.owner)
        const personalSpace = user?.personalSpace ? idOf(user.personalSpace) : null
        const sessionProject = record.projectId ? await projects.getById(record.projectId) : null
        const resolved = await roles.resolveEffective(
          { personalSpace, ...(sessionProject ? { project: sessionProject } : {}) },
          SYSTEM_PRINCIPAL,
          record.role,
        )

        return resolved
          ? {
              ...record,
              role: resolved.role.name,
              // The address the resolver already produced — the same one the real
              // seeder now stores. Rebuilt here it was a second producer of the
              // locator, and a System role has no placement to rebuild one from.
              roleLocator: resolved.locator,
              roleContextProjectId: sessionProject?.id ?? null,
            }
          : record
      }),
    )

    agentSessions.seed(records)
  }
  await seedAgentSessions(fixture)
  agentCalls.seed(
    fixture.agentCalls ?? [],
    fixture.agentCallDetails ?? [],
    fixture.agentTelemetryDetailed ?? false,
  )
  const seedAgentCleanup = async (fx: Fixture) => {
    for (const marker of fx.agentCleanupMarkers ?? []) {
      for (const operation of marker.operations) {
        const common = {
          owner: marker.owner,
          sessionId: marker.sessionId,
          acceptedAt: fx.now ?? new Date().toISOString(),
          batchSize: operation.cleanup === 'pending' ? 0 : 10_000,
        }

        if (operation.reason === 'retention') {
          await agentCalls.expireSession({
            ...common,
            expiredBefore: fx.now ?? new Date().toISOString(),
          })
        } else {
          await agentCalls.deleteSession({
            ...common,
            activeSince: fx.now ?? new Date().toISOString(),
            confirmActive: true,
          })
        }
      }
    }
  }
  await seedAgentCleanup(fixture)
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
    aliasesForSpace: (id) => manager.resolvableAliasesOf(id),
    removeMemberAndProviderAttachments: (space, username) =>
      providerPersistence.coordinator.run(() => {
        providerPersistence.removeProviderAttachmentsForMemberInsideCoordinator(space, username)
        return authDb.removeMember(space, username)
      }),
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
        disabledAt: u.disabled ? t : null,
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

  const seedProviders = async (fx: Fixture) => {
    if (!fx.providers) {
      return
    }
    if (!providerSeedRegistry) {
      throw new Error('provider seed fixture has no credential keyring')
    }
    await applyProviderSeed({
      declaration: fx.providers,
      registry: providerSeedRegistry,
      resolveSpace: (slug) => manager.resolveId(slug),
      resolveProject: async (space, path) => {
        const record = projectRecords(fx, idOf).find(
          (candidate) => candidate.space === idOf(space) && candidate.path === path,
        )
        return record ? { id: record.id, space: record.space } : null
      },
      overrideResource: (record) => providerPersistence.injectProviderResource(record),
      recordMeasurement: async (input) => {
        const current = await providerPersistence.providerResources.get(input.resourceId)

        if (!current) {
          throw new Error(`seeded provider resource disappeared: ${input.resourceId}`)
        }
        const result = await providerPersistence.providerResources.recordLastCheck({
          resourceId: input.resourceId,
          capability: input.capability,
          lastCheck: {
            status: input.status === 'model-unavailable' ? 'not-configured' : 'ready',
            checkedAt: fx.now || '2026-01-01T00:00:00.000Z',
            diagnostic: null,
            credentialProven: false,
          },
          measurement: {
            modelName: input.modelName,
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
          },
          expectedRuntimeEpoch: current.runtimeEpoch,
          expectedCredentialId: current.credentialId,
          expectedCredentialRuntimeEpoch: current.credentialId
            ? ((await providerPersistence.credentials.get(current.credentialId))?.runtimeEpoch ??
              null)
            : null,
        })

        if (result.status !== 'recorded') {
          throw new Error(`provider seed measurement was not recorded: ${input.resourceId}`)
        }
      },
      overrideAttachment: (record) => providerPersistence.injectProviderAttachment(record),
    })
  }

  /** Fake fixtures now project Space archive as a real lifecycle state because
   * provider resolution must name `space-archived` instead of silently losing the
   * attachment. Reset first restores every old world, then reapplies the next one. */
  const applyArchivedSpaces = async (fx: Fixture) => {
    for (const record of manager.listArchived()) {
      await manager.restore(record.id)
    }
    for (const space of fx.spaces) {
      if (!space.archived) {
        continue
      }
      const id = idOf(space.slug)
      await manager.archive(id, SYSTEM_PRINCIPAL.id)
    }
  }

  await seedProviders(fixture)
  await applyArchivedSpaces(fixture)

  // MCP durable state: per-session/project delta cursors plus write-retry dedup,
  // over in-memory twins the harness resets.
  const gatewayState = new InMemoryGatewayState()

  // /api/about: the in-memory fake wires no embedder (honest FTS) and no
  // meta-DB; authMode follows the boot fixture, engines are the notarium-class
  // in-memory stores. Computed at boot like the real host (a reset can't change
  // how the app authenticates).
  const about = hostInfoFrom({
    authMode: fixture.auth ? 'password' : 'none',
    metaDbFlavour: 'none',
    spaces: defs.map((d) => ({ slug: d.slug, engine: 'notarium' as const })),
    providers: fixture.capabilities?.providers,
  })
  // The durable job layer: the fake wires the REAL runner over an
  // in-memory SQLite jobs facet (`:memory:`) + a tmp FS artifact store, so the async
  // export path (enqueue → background ZIP → Range download) is exercised end to end
  // by the same production code, not stubbed. The InMemoryStore's exportNotes feeds
  // the export handler unchanged.
  const jobsEnabled = !fixture.noJobs
  const jobsMeta = new SqliteMetaDb(':memory:')
  opts.onJobsPersistence?.(jobsMeta.jobs)
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
      ...(providerRegistry
        ? {
            [TEST_PROVIDER_JOB_KIND]: async (ctx) => {
              const params = testProviderCallParams(ctx.job.params)

              if (!params) {
                throw new TerminalJobError('invalid-provider-job')
              }
              const result = await runProviderJobCall(ctx, providerRegistry, {
                resourceId: params.resourceId,
                jobCallKey: TEST_PROVIDER_JOB_CALL_KEY,
                operation: {
                  kind: PROVIDER_CALL_KIND.chat,
                  model: params.model,
                  messages: [{ role: 'user', content: 'Reply with OK.' }],
                  stream: true,
                  maxOutputTokens: 32,
                },
                inputUpperBound: 8,
                outputTokenBudget: 32,
              })
              return { result }
            },
          }
        : {}),
    },
    onUpdate: (job) => auth.notifyJobChanged(job.space, job.principal, jobToWire(job)),
    onMaintenance: () =>
      staging.sweepOrphans(async (id) => {
        const j = await jobsMeta.jobs.get(id)
        return !!j && (j.status === 'pending' || j.status === 'running')
      }, Date.now()),
    ...(providerRegistry ? { pollIntervalMs: 10, staleAfterMs: 3_000 } : {}),
  })

  const app = await buildApp({
    spaces: manager,
    auth,
    sessions: fixture.noAgentSessions ? undefined : agentSessions,
    customAbilityCreator,
    roles,
    providerRegistry,
    agentDeltaCursors,
    gatewayState: fixture.noGatewayState ? undefined : gatewayState,
    retrievalLog,
    agentCalls,
    sessionAudit: fixture.noSessionAudit ? undefined : sessionAudit,
    projects,
    folders,
    favorites,
    contextSets: fixture.noContextFacets ? undefined : contextSets,
    scopePins: fixture.noContextFacets ? undefined : scopePins,
    contextOrder: fixture.noContextFacets ? undefined : contextOrder,
    markerStore: opts.markerStore,
    fieldSchemaStore,
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
    about: opts.omitAbout ? undefined : about,
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

  // Test-only durable provider consumer. Production has no enqueue surface or job
  // kind until #95 supplies an actual background feature; the adapter itself is real.
  app.post(
    '/api/__test/providers/jobs',
    { config: { authz: { public: true } } },
    async (req, reply) => {
      const body = testProviderCallParams(req.body)
      const spaceRaw =
        typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>).space
          : null
      const space = typeof spaceRaw === 'string' ? manager.resolveId(spaceRaw) : null

      if (!providerRegistry || !jobsEnabled) {
        return reply.code(404).send({ error: 'provider_jobs_unavailable' })
      }
      if (!body || !space) {
        return reply.code(400).send({ error: 'invalid_provider_job' })
      }
      const now = new Date().toISOString()
      const delayRaw =
        typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>).delayMs
          : null
      const delayMs =
        typeof delayRaw === 'number' && Number.isSafeInteger(delayRaw) && delayRaw >= 0
          ? delayRaw
          : 0
      const idRaw =
        typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>).jobId
          : null
      const maxAttemptsRaw =
        typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>).maxAttempts
          : null
      const queued = await jobsMeta.jobs.enqueue({
        id: typeof idRaw === 'string' && idRaw ? idRaw : freshNoteId(),
        space,
        kind: TEST_PROVIDER_JOB_KIND,
        principal: SYSTEM_PRINCIPAL.id,
        params: body,
        progressTotal: 1,
        maxAttempts:
          typeof maxAttemptsRaw === 'number' &&
          Number.isSafeInteger(maxAttemptsRaw) &&
          maxAttemptsRaw > 0
            ? maxAttemptsRaw
            : undefined,
        runAt: new Date(Date.parse(now) + delayMs).toISOString(),
        createdAt: now,
      })
      jobRunner.wake()
      return reply.code(202).send(jobToWire(queued))
    },
  )

  // Test-only interactive streaming driver. `longLived` keeps it out of the
  // scheduler counter; cancellation is its own AbortController on socket close.
  app.post(
    '/api/__test/providers/stream',
    { config: { authz: { public: true }, longLived: true } },
    async (req, reply) => {
      const body = testProviderCallParams(req.body)
      const spaceRaw =
        typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>).space
          : null
      const space = typeof spaceRaw === 'string' ? manager.resolveId(spaceRaw) : null

      if (!providerRegistry) {
        return reply.code(404).send({ error: 'providers_unavailable' })
      }
      if (!body || !space) {
        return reply.code(400).send({ error: 'invalid_provider_stream' })
      }
      const controller = new AbortController()

      const disconnected = () => {
        if (!reply.raw.writableEnded) {
          controller.abort(new Error('provider stream client disconnected'))
        }
      }
      reply.raw.once('close', disconnected)
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      })
      reply.raw.flushHeaders()

      try {
        await providerRegistry.executeForScope({
          space,
          principal: SYSTEM_PRINCIPAL.id,
          agent: null,
          resourceId: body.resourceId,
          operation: {
            kind: PROVIDER_CALL_KIND.chat,
            model: body.model,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            stream: true,
            maxOutputTokens: 32,
          },
          retryMode: PROVIDER_RETRY_MODE.none,
          job: null,
          rateLimit: { inputUpperBound: 8, outputTokenBudget: 32 },
          signal: controller.signal,
          onText: ({ text }) => {
            if (!reply.raw.destroyed) {
              reply.raw.write(text)
            }
          },
        })
        if (!reply.raw.destroyed) {
          reply.raw.end()
        }
      } catch (error) {
        if (!controller.signal.aborted && !reply.raw.destroyed) {
          reply.raw.destroy(error instanceof Error ? error : new Error(String(error)))
        }
      } finally {
        reply.raw.removeListener('close', disconnected)
      }
    },
  )

  // Test-only: re-seed every space from the fixture (optionally a NEW fixture
  // passed in the body — the e2e suite swaps worlds per spec this way), wipe
  // the journals and the auth world, drop test-created spaces and rebuild the
  // snapshots so each E2E test starts clean.
  app.post('/api/__test/reset', { config: { authz: { public: true } } }, async (req) => {
    const next = (req.body as { fixture?: Fixture } | null)?.fixture ?? baseFixture
    fixture = next
    for (const record of manager.listArchived()) {
      await manager.restore(record.id)
    }
    // Worlds + manager are keyed by the stable id now: map each live world
    // back to its record to compare slugs, and drop the ones gone from `next`.
    // (The harness wires no `isPersonalSpace`, so manager.remove never invokes the
    // production "cannot remove a personal space" refusal — a full reset must be able
    // to tear down a runtime-minted personal space too.)
    for (const id of [...worlds.keys()]) {
      const rec = manager.recOf(id)

      if (!rec || !next.spaces.some((s) => s.slug === rec.slug)) {
        const world = worlds.get(id)
        fieldSchemaStore.clear(id)
        await manager.remove(id)
        world?.revisions.clear()
        worlds.delete(id)
      }
    }
    // Reset is a replacement, not a sequence of renames. Retired aliases from the
    // previous fixture must not reserve a current slug the next fixture introduces.
    // Clear history first, materialize every exact current slug, then apply the new
    // history in a second pass (current > alias, independent of fixture order).
    for (const rec of [...manager.list(), ...manager.listArchived()]) {
      if (rec.aliases.length) {
        manager.applyRename({ ...rec, aliases: [] })
      }
    }
    for (const s of next.spaces) {
      const record = [...manager.list(), ...manager.listArchived()].find(
        (candidate) => candidate.slug === s.slug,
      )
      const world = record ? worlds.get(record.id) : undefined

      if (record && world) {
        await world.store.settle()
        world.engine.load({ space: record.id, now: next.now, notes: s.notes })
        world.revisions.clear()
        await world.store.rescan()
      } else {
        // A brand-new space: the manager mints its opaque id; store() builds the world.
        manager.add({ slug: s.slug, displayName: s.displayName || s.slug })
        const id = manager.resolveId(s.slug) as string
        const minted = manager.recOf(id)

        if (!minted) {
          throw new Error(`fixture reset could not mint Space: ${s.slug}`)
        }
        await spacesRegistry.upsert(minted)
        await spaceLifecycle.ensure(id, SPACE_LIFECYCLE_PHASE.active, minted.createdAt)
        await manager.store(id)
      }
    }
    for (const s of next.spaces) {
      const record = [...manager.list(), ...manager.listArchived()].find(
        (candidate) => candidate.slug === s.slug,
      )

      if (!record) {
        throw new Error(`fixture aliases reference undeclared space: ${s.slug}`)
      }
      manager.applyRename({ ...record, aliases: [...(s.aliases ?? [])] })
      if (s.fieldSchemaRaw) {
        fieldSchemaStore.seedRaw(record.id, s.fieldSchemaRaw)
      } else {
        fieldSchemaStore.seed(record.id, s.fieldSchema)
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
    agentDeltaCursors.clear()
    retrievalLog.clear()
    agentCalls.clear()
    oauthDb.clear()
    projects.seed(projectRecords(next, idOf))
    abilityAvailability.clearAll()
    abilityPreferences.clear()
    await seedAgentPackages(next)
    await seedAgentSessions(next)
    agentCalls.seed(
      next.agentCalls ?? [],
      next.agentCallDetails ?? [],
      next.agentTelemetryDetailed ?? false,
    )
    await seedAgentCleanup(next)
    favorites.clear()
    contextSets.clear()
    scopePins.clear()
    contextOrder.clear()
    await seedContextSetFacet()
    providerPersistence.clear()
    providerCallLog.clear()
    await seedProviders(next)
    await applyArchivedSpaces(next)
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
    await fakeCredentialKeyring?.close().catch(() => {})
    await manager.stopAll()
  })
  return app
}
