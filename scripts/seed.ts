// The real-engine seed applier (#175). Fills a REAL Notarium stand from a
// declarative case in the shared catalog (test/cases), in-process, so the #12
// revision journal — the source of the heatmap / feed / trash / history — lands
// at the case's AUTHORED dates instead of one "today" spike.
//
// Why in-process (not HTTP/import, not drop-.md): the journal stamps each row
// with `now()`, and no HTTP/MCP/import path sets that date (revisionJournal.ts).
// The ONLY honest backdating is to construct the production store with an
// INJECTED clock and replay the timeline through the real `store.write` /
// `remove` — the file, read-model, search index, identity registry and project
// markers all self-fill (P2), and the journal row gets the chosen instant with a
// correct chained base_rev / charsAdded / class. See docs/seeds.md and the task
// note. Run it with the stand STOPPED (it writes the same on-disk DB the server
// holds under WAL) — `make seed` orchestrates stop → seed → start.
//
// Usage (env-driven, mirrors the server's env edge):
//   CASE=feed-scroll SCALE=1 SEED=default \
//   DATA_DIR=./docker/volumes/data \
//   tsx scripts/seed.ts
//   tsx scripts/seed.ts --list   # list cases
//
// Paths come from the SERVER's own resolver (dataPathsFromEnv, #101), not a copy:
// the seeder writes the very files the stand then reads, so a drift between the
// two would seed one stand and start another.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Client } from 'pg'

import { EmailSchema } from '@notarium/contract'
import {
  AGENT_MEMORY_MOUNT,
  CachedStore,
  freshNoteId,
  type MountConfig,
  type NoteClass,
  parseFrontmatterLines,
  sha256Hex,
} from '@notarium/core'
import {
  createNotariumStore,
  ensureNotariumResourceAuthority,
  NotariumStoreCompositionOwner,
  renameNoReplaceIfAvailable,
  SpaceResourceAuthorityRegistry,
} from '@notarium/engine'
import {
  ARTIFACT_TTL_MS,
  createExportHandler,
  createFieldSchemaStore,
  createFsArtifactStore,
  createFsImportStagingStore,
  createFsRoleLibrary,
  createMarkerStore,
  createMetaDb,
  createRolesService,
  CredentialKeyring,
  credentialKeyringConfigFromEnv,
  CredentialKeyringService,
  dataPathsFromEnv,
  describeMetaDbUrl,
  DurableAbilityCreator,
  ensureFolderIdentity,
  hashPassword,
  healSpaceMarker,
  JOB_KIND_EXPORT,
  loadBundledAbilityInventory,
  localFsAnchoredFiles,
  markFolderAsProject,
  META_DB_TARGET_KIND,
  metaDbTargetOf,
  mintOAuthAccessToken,
  mintOAuthRefreshToken,
  mintUserId,
  oauthPrincipalId,
  ownedRoleLocator,
  type ProviderAttachmentRecord,
  ProviderRegistry,
  type ProviderResourceRecord,
  renameProjectSlug,
  replayKeyringConfigFromEnv,
  roleContextTargetOf,
  sha256,
  SpaceManager,
  type SpaceRecord,
  SYSTEM_PRINCIPAL,
  userPrincipalId,
} from '@notarium/server'

import { TRACE_TOOL_POLICY } from '../packages/server/src/services/agentCalls/traceProjectors'
import { buildCasesWorld, listCases } from '../test/cases'
import type { AgentRoleTargetDecl, CaseWorld, ContextSetAttachDecl, UserDecl } from '../test/cases'
import { applyAgentAbilityPreferences } from '../test/cases/applyAbilityPreferences'
import { applyAgentRoleMoves } from '../test/cases/applyAgentRoleMoves'
import { applyAgentRoleDeclarations } from '../test/cases/applyAgentRoles'
import { applyAgentSkillDeclarations } from '../test/cases/applyAgentSkills'
import { applyContextDeclarations } from '../test/cases/applyContextDeclarations'
import { applyProviderSeed } from '../test/cases/applyProviders'
import { normDate } from '../test/cases/generators'
import { personalSpaceForPlacement } from '../test/cases/personalSpaceSeam'
import { resolveAvailabilityDecl } from '../test/cases/resolveAvailability'
import { materializeRevisionState } from '../test/cases/revisionStates'
import { agentCallId, agentSessionId } from '../test/cases/sessionIds'
import { seedDurableImports } from './seedDurableImports'
import { applySeedExternalRewrites, identityClaimRewrite } from './seedExternalRewrites'
import { applySeedExternalSources } from './seedExternalSources'
import {
  makeOwnerRemap,
  principalWithIds,
  resolveSeedAgentActivityOwner,
  resolveSeedAgentDeltaCursorOwner,
  shouldAutoGrantSeedOwner,
} from './seedOwner'

const PROFILE_MOUNT = '.notarium/profile'
const SKILL_MOUNT = '.notarium/skills'

/** The default notarium mount set — mirrors apps/server/server.ts defaultMounts
 *  (a tiny, stable copy so the dev seeder needs no server-internal import). */
const defaultMounts = (notesDir: string): MountConfig[] => [
  { class: 'user-doc', dir: notesDir, prefix: '' },
  { class: 'agent-memory', dir: join(notesDir, AGENT_MEMORY_MOUNT), prefix: AGENT_MEMORY_MOUNT },
  { class: 'profile', dir: join(notesDir, PROFILE_MOUNT), prefix: PROFILE_MOUNT },
  { class: 'skill', dir: join(notesDir, SKILL_MOUNT), prefix: SKILL_MOUNT },
]

/** The localfs body reader behind CachedStore's readBody (P5) — a tiny copy of
 *  libs/notesDir so the seeder's read-model is wired exactly like production. */
const notesDirReader = (dir: string): ((filePath: string) => Promise<string | null>) => {
  const root = resolvePath(dir)

  return async (filePath: string) => {
    const target = resolvePath(root, filePath)

    if (target !== root && !target.startsWith(root + sep)) {
      return null
    }
    try {
      return await readFile(target, 'utf8')
    } catch {
      return null
    }
  }
}

const env = (name: string, fallback?: string): string => {
  const v = process.env[name]?.trim()

  if (v) {
    return v
  }
  if (fallback !== undefined) {
    return fallback
  }
  throw new Error(`missing required env ${name}`)
}

type MountRoute = { targetClass?: NoteClass; directory: string; fileName: string }

const base = (p: string) => p.replace(/^.*\//, '').replace(/\.md$/, '')
const dirOf = (p: string) => (dirname(p) === '.' ? '' : dirname(p))

/** Split a space-relative note path into the WriteInput channels: a hidden-mount
 *  path (`.notarium/memory/…`) becomes a targetClass + mount-relative dir/file so
 *  the engine lands it in that mount; a plain path stays user-doc. */
const routeOf = (path: string, cls: string | undefined): MountRoute => {
  const strip = (prefix: string) => path.slice(prefix.length + 1)

  if (cls === 'agent-memory' && path.startsWith(`${AGENT_MEMORY_MOUNT}/`)) {
    const rel = strip(AGENT_MEMORY_MOUNT)
    return { targetClass: 'agent-memory', directory: dirOf(rel), fileName: base(rel) }
  }
  if (cls === 'profile' && path.startsWith(`${PROFILE_MOUNT}/`)) {
    const rel = strip(PROFILE_MOUNT)
    return { targetClass: 'profile', directory: dirOf(rel), fileName: base(rel) }
  }
  if (cls === 'skill' && path.startsWith(`${SKILL_MOUNT}/`)) {
    const rel = strip(SKILL_MOUNT)
    return { targetClass: 'skill', directory: dirOf(rel), fileName: base(rel) }
  }

  return { directory: dirOf(path), fileName: base(path) }
}

type ProviderSeedOverrides = {
  resources: ProviderResourceRecord[]
  attachments: ProviderAttachmentRecord[]
}

/** Apply only the two states product writes intentionally refuse: a credential
 * origin mismatch / unreadable header carrier, and a near-expiry pending row.
 * The normal rows were already written through ProviderRegistry + production
 * persistence. Both durable drivers get the same exact final record. */
const applyProviderSeedOverrides = async (
  metaDbUrl: string,
  overrides: ProviderSeedOverrides,
): Promise<void> => {
  if (!overrides.resources.length && !overrides.attachments.length) {
    return
  }
  const target = metaDbTargetOf(metaDbUrl)

  if (target.kind === META_DB_TARGET_KIND.memory) {
    throw new Error('provider seed corrupt states require a durable meta-DB')
  }
  if (target.kind === META_DB_TARGET_KIND.file) {
    const db = new DatabaseSync(target.path)

    try {
      db.exec('BEGIN IMMEDIATE')
      const resource = db.prepare(
        'UPDATE provider_resources SET base_url = ?, headers = ? WHERE id = ?',
      )
      const attachment = db.prepare('UPDATE provider_attachments SET expires_at = ? WHERE id = ?')

      for (const record of overrides.resources) {
        const result = resource.run(record.baseUrl, JSON.stringify(record.headers), record.id)

        if (result.changes !== 1) {
          throw new Error(`provider seed resource override missed ${record.id}`)
        }
      }
      for (const record of overrides.attachments) {
        const result = attachment.run(record.expiresAt, record.id)

        if (result.changes !== 1) {
          throw new Error(`provider seed attachment override missed ${record.id}`)
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    } finally {
      db.close()
    }

    return
  }

  const client = new Client({ connectionString: target.url })
  await client.connect()
  try {
    await client.query('BEGIN')
    for (const record of overrides.resources) {
      const result = await client.query(
        'UPDATE provider_resources SET base_url = $1, headers = $2 WHERE id = $3',
        [record.baseUrl, JSON.stringify(record.headers), record.id],
      )

      if (result.rowCount !== 1) {
        throw new Error(`provider seed resource override missed ${record.id}`)
      }
    }
    for (const record of overrides.attachments) {
      const result = await client.query(
        'UPDATE provider_attachments SET expires_at = $1 WHERE id = $2',
        [record.expiresAt, record.id],
      )

      if (result.rowCount !== 1) {
        throw new Error(`provider seed attachment override missed ${record.id}`)
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await client.end()
  }
}

const run = async (): Promise<void> => {
  if (process.argv.includes('--list')) {
    for (const c of listCases()) {
      console.log(`  ${c.name.padEnd(20)} ${c.description}`)
    }

    return
  }

  const caseName = env('CASE')
  const scale = Number(env('SCALE', '1'))
  const seed = env('SEED', 'default')
  // The real stand anchors on the actual current date (a freshly seeded stand
  // shows activity up to today); override with NOW for a reproducible window.
  const nowIso = process.env.NOW?.trim() || new Date().toISOString()
  // One root → meta.db / engine / jobs / spaces, resolved exactly as the server
  // does (#101). SPACES_ROOT still overrides, mirroring the zero-config branch of
  // spacesFromEnv — the shape a seeded stand always runs in.
  const dataPaths = dataPathsFromEnv(process.env)
  const spacesRoot = process.env.SPACES_ROOT?.trim() || dataPaths.defaultSpacesRoot
  const metaDbUrl = dataPaths.metaDbUrl
  const engineDataDir = dataPaths.engineDataDir
  const ownerUser = env('SEED_USER', 'admin')
  const ownerPass = env('SEED_PASSWORD', 'admin')
  const ownerName = env('SEED_DISPLAY_NAME', 'Admin')
  // Optional: the init user's address. Empty keeps the honest "not set" state, which
  // is a state of its own the UI has to show.
  const ownerEmail = env('SEED_EMAIL', '') || undefined
  // The catalog authors primary content as a canonical owner token (`sergey`); the
  // real stand renders it as the configured INIT USER (SEED_USER, default `admin`), so
  // the default login IS the content author and the "mine" heatmap/feed light up out of
  // the box. A second collaborator (`alex`) stays as-is for multi-author cases. Override
  // with SEED_USER / SEED_PASSWORD / SEED_DISPLAY_NAME (or `make seed PASSWORD=…`).
  const CATALOG_OWNER = 'sergey'
  const { asUser, remapPrincipal } = makeOwnerRemap(CATALOG_OWNER, ownerUser)

  // CASE may be a single case or a comma-list to COMBINE (feed-scroll,trash-mixed).
  const world: CaseWorld = buildCasesWorld(caseName, { seed, scale, now: nowIso })

  if (process.argv.includes('--provider-enabled')) {
    process.stdout.write(world.providers ? String(world.providers.enabled) : '')
    return
  }
  if (process.argv.includes('--provider-private-origins')) {
    process.stdout.write(world.providers?.privateOrigins?.join(',') ?? '')
    return
  }
  console.log(`seed: case=${caseName} scale=${scale} seed=${seed} now=${nowIso}`)
  console.log(`seed: spacesRoot=${spacesRoot} metaDb=${describeMetaDbUrl(metaDbUrl)}`)

  const metaDb = createMetaDb(metaDbUrl)

  // Refuse to seed onto a non-empty stand — the applier provisions fresh (a
  // re-seed would duplicate). `make seed` wipes the volumes first.
  const existing = await metaDb.spaces.list()

  if (existing.length) {
    await metaDb.close()
    throw new Error(
      `stand is not empty (${existing.length} space(s): ${existing.map((s) => s.slug).join(', ')}). ` +
        `Wipe the volumes first (make seed does this), or run against a clean stand.`,
    )
  }

  // The injected clock: every space's CachedStore reads THIS for journal + identity
  // timestamps, so setting it before each event backdates the row. Shared by ref
  // across all spaces (one global chronological replay).
  let clock = new Date(nowIso)

  // notesDirOf reads `manager` (declared just below) — only ever at call time,
  // after it's built, so the forward reference is safe.
  const notesDirOf = (id: string): string | null => {
    const rec = manager.recOf(id)
    return rec ? join(spacesRoot, rec.notesDir) : null
  }
  const markerStore = createMarkerStore((id) => notesDirOf(id), {
    anchoredFilesForRoot: localFsAnchoredFiles(),
  })
  const fieldSchemaStore = createFieldSchemaStore((id) => notesDirOf(id))
  const resourceAuthorities = new SpaceResourceAuthorityRegistry()
  const storeCompositions = new NotariumStoreCompositionOwner()

  const authorityForSpace = async (space: string) => {
    const notesDir = notesDirOf(space)

    if (!notesDir) {
      return null
    }
    const composition = storeCompositions.getOrCreate(space, defaultMounts(notesDir))

    return ensureNotariumResourceAuthority({
      spaceId: space,
      resourceAuthorityRegistry: resourceAuthorities,
      composition,
    })
  }

  const manager = new SpaceManager({
    spaces: [],
    metaDb,
    now: () => new Date(),
    createSpace: async (rec) => {
      const dir = join(spacesRoot, rec.notesDir)
      await mkdir(join(dir, AGENT_MEMORY_MOUNT), { recursive: true })
      await mkdir(join(dir, PROFILE_MOUNT), { recursive: true })
      await mkdir(join(dir, SKILL_MOUNT), { recursive: true })
      return rec.notesDir
    },
    spaceCreateEnabled: () => true,
    // Auto-mark the space root as a project (#97) + seat its id into the root
    // marker (#126) — exactly as apps/server/server.ts does on first provision.
    onProvision: async (rec) => {
      await markFolderAsProject(
        { projects: metaDb.projects, folders: metaDb.folders, markerStore, now: () => new Date() },
        { space: rec.id, folderPath: '', displayName: rec.displayName },
      )
      await healSpaceMarker({ spaces: metaDb.spaces, markerStore, now: () => new Date() }, rec)
    },
    createStore: (rec: SpaceRecord) => {
      const notesDir = join(spacesRoot, rec.notesDir)
      const composition = storeCompositions.getOrCreate(rec.id, defaultMounts(notesDir))
      const engine = createNotariumStore({
        spaceId: rec.id,
        resourceAuthorityRegistry: resourceAuthorities,
        composition,
        indexDb: join(engineDataDir, `${rec.notesDir}.db`),
      })
      // The seeder is the SOLE writer. Disable the engine's fs.watch so the
      // read-model's external-change reconcile (#146) never re-detects our OWN
      // backdated writes as `external` arrivals and re-journals them (which would
      // pollute the honest history with spurious external edits). Returning null =
      // "no watcher engaged"; with pollIntervalMs:0 there is then no reconcile at
      // all, so every journal row is exactly the one write/remove we issued.
      ;(engine as unknown as { watch: () => null }).watch = () => null
      return new CachedStore({
        inner: engine,
        identityPersistence: metaDb.identity,
        revisionPersistence: metaDb.revisions,
        space: rec.id,
        pollIntervalMs: 0,
        readBody: notesDirReader(notesDir),
        // THE seam: the journal + identity stamp their rows with this clock.
        now: () => clock,
        folderAliases: async () =>
          (await metaDb.folders.aliasesForSpace(rec.id)).flatMap((f) =>
            f.pathAliases.map((alias) => ({ current: f.path, alias })),
          ),
      })
    },
  })
  await manager.init()

  // 1. Provision the case's spaces (mkdir + auto-mark root + registry).
  const idOf = new Map<string, string>()
  const records = new Map<string, SpaceRecord>()

  for (const s of world.spaces) {
    const rec = await manager.create({ slug: s.slug, displayName: s.displayName || s.slug })
    idOf.set(s.slug, rec.id)
    records.set(s.slug, rec)
  }

  // 1b. Apply the space-owned declaration document through its production CAS
  // service. It is a sibling structural resource, not a note and not a journal row.
  let fieldSchemas = 0

  for (const declaration of world.spaces) {
    if (!declaration.fieldSchema && !declaration.fieldSchemaRaw) {
      continue
    }
    const space = idOf.get(declaration.slug)

    if (!space) {
      throw new Error(`field schema references unknown space: ${declaration.slug}`)
    }
    if (declaration.fieldSchemaRaw) {
      const notesDir = notesDirOf(space)

      if (!notesDir) {
        throw new Error(`field schema has no notes directory: ${declaration.slug}`)
      }
      const schemaDir = join(notesDir, '.notarium/fields')

      await mkdir(schemaDir, { recursive: true })
      await writeFile(join(schemaDir, 'schema.yaml'), declaration.fieldSchemaRaw, 'utf8')
      fieldSchemaStore.clear(space)
      fieldSchemas++
      continue
    }
    const current = await fieldSchemaStore.read(space)
    const written = await fieldSchemaStore.update(space, {
      ...declaration.fieldSchema!,
      versionToken: current.versionToken,
    })

    if (written.status !== 'saved') {
      throw new Error(`could not seed field schema for ${declaration.slug}: ${written.status}`)
    }
    fieldSchemas++
  }

  // Author alias history only after every current slug exists. This mirrors the
  // fake applier and preserves current > alias when one space's retired handle is
  // another space's current slug, regardless of declaration order.
  for (const s of world.spaces) {
    const initial = records.get(s.slug)

    if (initial && s.aliases?.length) {
      const rec = { ...initial, aliases: [...s.aliases] }
      await metaDb.spaces.upsert(rec)
      manager.applyRename(rec)
      // The marker is the re-clone truth, not just a cache of the current slug.
      // Re-heal after authoring aliases so a fresh meta-DB adopts the same history.
      await healSpaceMarker({ spaces: metaDb.spaces, markerStore, now: () => new Date() }, rec)
    }
  }

  // 2. Materialize declared project directories through the same store-owned
  //    channel as runtime `create:true`, then publish their marker + registry row.
  //    Projects precede the note replay, so they must not rely on a future note
  //    write (or on MarkerStore) to create their directory.
  for (const p of world.projects ?? []) {
    if (!p.path) {
      continue
    }
    const space = idOf.get(p.space)

    if (!space) {
      throw new Error(`project references unknown space: ${p.space}`)
    }
    const projectStore = await manager.store(space)
    const dirs = (await projectStore.listDirs?.()) ?? []

    if (!dirs.includes(p.path)) {
      if (!projectStore.makeDir) {
        throw new Error(`space store cannot create project directory: ${p.space}/${p.path}`)
      }
      await projectStore.makeDir(p.path)
    }
    const marked = await markFolderAsProject(
      { projects: metaDb.projects, folders: metaDb.folders, markerStore, now: () => new Date() },
      { space, folderPath: p.path, displayName: p.displayName || p.slug || p.path },
    )

    if (p.slug && p.slug !== marked.slug) {
      const renamed = await renameProjectSlug(
        { projects: metaDb.projects, folders: metaDb.folders, markerStore, now: () => new Date() },
        { space, id: marked.id, slug: p.slug },
      )

      if (!renamed.ok) {
        throw new Error(
          `project ${p.space}/${p.path} could not use declared slug ${p.slug}: ${renamed.code}`,
        )
      }
    }
  }

  // 3. Auth (#10): the case's users, else a default owner. The first user is the
  //    reported login; ordinary spaces stay browsable without opening foreign
  //    personal domains.
  const users: UserDecl[] = world.auth?.users?.length
    ? world.auth.users.map((u) =>
        u.username === CATALOG_OWNER
          ? {
              ...u,
              username: ownerUser,
              displayName: ownerName,
              password: ownerPass,
              ...(ownerEmail ? { email: ownerEmail } : {}),
            }
          : u,
      )
    : [
        {
          username: ownerUser,
          password: ownerPass,
          displayName: ownerName,
          admin: true,
          ...(ownerEmail ? { email: ownerEmail } : {}),
        },
      ]
  const primary = users[0]
  const personalSpaceOf = new Map<string, string>()

  for (const s of world.spaces) {
    if (s.personalFor) {
      personalSpaceOf.set(asUser(s.personalFor), s.slug)
    }
  }
  for (const u of users) {
    if (u.personalSpace) {
      personalSpaceOf.set(u.username, u.personalSpace)
    }
  }
  // Every space that IS somebody's personal one, by id. This stand's answer to the
  // question production answers with `peekPersonalSpace` on every owned-package call.
  const personalSpaceIds = new Set(
    [...personalSpaceOf.values()].flatMap((slug) => {
      const id = idOf.get(slug)

      return id ? [id] : []
    }),
  )

  const t = nowIso
  // Cases speak handles; the meta-DB keys every owner and attribution by the stable id
  // minted here. `userIdOf` is the one seam between the two — an unknown handle (the
  // `@system` owner, an orphaned attribution) passes through as authored.
  const userIds = new Map<string, string>()

  for (const u of users) {
    const personalSlug = personalSpaceOf.get(u.username)
    const id = mintUserId()
    // The wire schema is the ONE normalizer of an address (trim + lower-case), and the
    // column is a plain UNIQUE that compares bytes. A seed writing a mixed-case address
    // — SEED_EMAIL is typed by a human — would be unreachable by login and would not
    // collide with its own lower-case twin.
    const written = await metaDb.auth.createUser({
      id,
      username: u.username,
      email: u.email ? EmailSchema.parse(u.email) : null,
      displayName: u.displayName || u.username,
      passwordHash: u.password ? await hashPassword(u.password) : null,
      admin: Boolean(u.admin),
      disabledAt: u.disabled ? t : null,
      createdAt: t,
      personalSpace: personalSlug ? (idOf.get(personalSlug) ?? null) : null,
    })

    // createUser reports a duplicate instead of throwing, so an unchecked result would
    // seed a phantom principal: the id below would key memberships and attribution
    // rows that no `users` row backs. Loud is the only honest outcome for a stand.
    if (written.status === 'conflict') {
      throw new Error(
        `seed: user "${u.username}" collides on ${written.field} — the catalog and the SEED_USER/SEED_EMAIL overrides disagree`,
      )
    }
    userIds.set(u.username, id)
  }
  const userIdOf = (username: string): string => userIds.get(username) ?? username
  /** A catalog owner reference → the stable id (through the init-user remap). */
  const ownerIdOf = (name: string): string => userIdOf(asUser(name))
  /** A catalog principal → the stored attribution string (init-user remap, then ids). */
  const principalIdOf = (principal?: string): string | undefined =>
    principal === undefined
      ? undefined
      : principalWithIds(remapPrincipal(principal) ?? principal, (name) => userIds.get(name))
  const members = (world.auth?.members ?? []).map((m) => ({ ...m, username: asUser(m.username) }))

  for (const m of members) {
    const space = idOf.get(m.space)

    if (space) {
      await metaDb.auth.upsertMember(space, userIdOf(m.username), m.role, t)
    }
  }
  // The primary owner reaches every ordinary seeded space so a manual stand stays
  // browsable, but never receives an implicit grant into another user's personal
  // domain. The real product refuses such a second member too.
  for (const [slug, id] of idOf) {
    const declaration = world.spaces.find((space) => space.slug === slug)
    const autoGrant = shouldAutoGrantSeedOwner({
      personalFor: declaration?.personalFor,
      primaryUsername: primary.username,
      asUser,
    })

    if (autoGrant && !members.some((m) => m.space === slug && m.username === primary.username)) {
      await metaDb.auth.upsertMember(id, userIdOf(primary.username), 'owner', t)
    }
  }

  // 3a. Owned role forks. The catalog remains read-only; the seed exercises the
  // same copy-on-Add service as REST instead of dropping ad-hoc fixture files.
  const roleLibrary = createFsRoleLibrary({
    publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
    rootForSpace: (space) => {
      const notesDir = notesDirOf(space)
      return notesDir ? join(notesDir, SKILL_MOUNT) : null
    },
    authorityForSpace,
    resourcePrefixForSpace: (space) => (notesDirOf(space) ? SKILL_MOUNT : null),
  })
  const roleService = createRolesService({
    catalog: loadBundledAbilityInventory,
    library: roleLibrary.library,
    publication: roleLibrary.publication,
    abilityAvailability: metaDb.abilityAvailability,
    abilityPreferences: metaDb.abilityPreferences,
    abilityPlacement: metaDb.abilityPlacement,
  })
  const durableAbilityCreator = new DurableAbilityCreator({
    persistence: metaDb.abilityCreate,
    roles: roleService,
    authorityForSpace,
    beginProjection: (space, operationId) =>
      manager.beginCausalPublication(space, { kind: 'ability-create', operationId }),
    primeIdentity: (space, record) => manager.primeWarmCausalIdentity(space, record),
    confirmIdentity: (space, noteId) => manager.confirmCausalIdentity(space, noteId),
    releaseIdentity: (space, noteId) => manager.releasePrimedIdentity(space, noteId),
    adoptPublication: (space, evidence) => manager.adoptCausalPublication(space, evidence),
    reconcile: (space, noteId) => manager.reconcileCausalProjection(space, noteId),
    now: () => clock,
  })
  const projectRows = await metaDb.projects.listForSpaces([...idOf.values()])
  const providerSeedOverrides: ProviderSeedOverrides = { resources: [], attachments: [] }

  if (world.providers) {
    const replayKeyring = replayKeyringConfigFromEnv(
      dataPaths.dataDir,
      dataPaths.metaDbUrl,
      process.env,
    )
    const keyringConfig = credentialKeyringConfigFromEnv(
      {
        dataDir: dataPaths.dataDir,
        metaDbUrl: dataPaths.metaDbUrl,
        packedRoots: [dataPaths.defaultSpacesRoot, dataPaths.jobsDataDir, replayKeyring.path],
      },
      process.env,
    )
    const keyring = new CredentialKeyringService({
      persistence: metaDb.secretKeyring,
      keyring: new CredentialKeyring(keyringConfig.path, keyringConfig.packedRoots),
      ciphertexts: metaDb.providerCiphertexts,
      now: () => new Date(nowIso),
    })
    await keyring.bootstrap()
    const registry = new ProviderRegistry({
      credentials: metaDb.credentials,
      resources: metaDb.providerResources,
      attachments: metaDb.providerAttachments,
      attachmentLifecycle: metaDb,
      spaces: metaDb.spaces,
      projects: metaDb.projects,
      directory: metaDb.auth,
      keyring,
      privateOrigins: new Set(world.providers.privateOrigins ?? []),
      authMode: 'password',
      now: () => new Date(nowIso),
    })
    const applied = await applyProviderSeed({
      declaration: world.providers,
      registry,
      ownerOf: ownerIdOf,
      resolveSpace: (slug) => idOf.get(slug) ?? null,
      resolveProject: async (spaceSlug, path) => {
        const space = idOf.get(spaceSlug)
        const record = projectRows.find(
          (candidate) => candidate.space === space && candidate.path === path,
        )
        return record ? { id: record.id, space: record.space } : null
      },
      overrideResource: (record) => {
        providerSeedOverrides.resources.push(record)
      },
      recordMeasurement: async (input) => {
        const current = await metaDb.providerResources.get(input.resourceId)

        if (!current) {
          throw new Error(`seeded provider resource disappeared: ${input.resourceId}`)
        }
        const result = await metaDb.providerResources.recordLastCheck({
          resourceId: input.resourceId,
          capability: input.capability,
          lastCheck: {
            status: input.status === 'model-unavailable' ? 'not-configured' : 'ready',
            checkedAt: nowIso,
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
            ? ((await metaDb.credentials.get(current.credentialId))?.runtimeEpoch ?? null)
            : null,
        })

        if (result.status !== 'recorded') {
          throw new Error(`provider seed measurement was not recorded: ${input.resourceId}`)
        }
      },
      overrideAttachment: (record) => {
        providerSeedOverrides.attachments.push(record)
      },
    })
    console.log(
      `seed: providers credentials=${applied.credentials.size} resources=${applied.resources.size} attachments=${applied.attachments.size} served=${world.providers.enabled}`,
    )
  }

  const seedStoreForSpace = async (space: string) => {
    const store = await manager.store(space)

    // RoleLibrary publishes through the filesystem authority. Production's
    // watcher/poll would converge this mount asynchronously; the stopped-stand
    // seeder needs the same reconciliation before its immediate note mutation.
    await store.reconcile?.()
    return store
  }

  const resolveRoleTarget = async (target: AgentRoleTargetDecl) => {
    if (target.kind === 'personal') {
      const username = target.user ? asUser(target.user) : primary.username
      const personalSlug = personalSpaceOf.get(username)
      const personal = personalSlug ? idOf.get(personalSlug) : null

      if (!personal) {
        throw new Error(`agent package has no personal space for ${username}`)
      }

      return { scope: 'personal' as const, space: personal }
    }
    const space = idOf.get(target.space)

    if (!space) {
      throw new Error(`agent package references an unknown space: ${target.space}`)
    }
    if (target.kind === 'space') {
      return { scope: 'space' as const, space }
    }
    const project = projectRows.find(
      (candidate) => candidate.space === space && candidate.path === target.path,
    )

    if (!project) {
      throw new Error(`agent package references an unknown project: ${target.space}/${target.path}`)
    }

    return { scope: 'project' as const, space: project.space, projectId: project.id }
  }

  const projectOf = (reference: { space: string; path: string }) => {
    const space = idOf.get(reference.space)

    return (
      projectRows.find(
        (candidate) => candidate.space === space && candidate.path === reference.path,
      ) ?? null
    )
  }
  const appliedRoles = await applyAgentRoleDeclarations({
    declarations: world.agentRoles ?? [],
    roles: roleService,
    resolveLocation: async (declaration) => {
      const location = await resolveRoleTarget(declaration.target)

      if (declaration.availability && location.scope !== 'space') {
        throw new Error(`agent role ${declaration.name} cannot declare availability here`)
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
                `agent role ${declaration.name}`,
              ),
            }
          : {}),
      }
    },
    storeForSpace: seedStoreForSpace,
  })

  const appliedSkills = await applyAgentSkillDeclarations({
    declarations: world.agentSkills ?? [],
    roles: roleService,
    library: roleLibrary.library,
    seedPackageFile: roleLibrary.seedPackageFile,
    storeForSpace: seedStoreForSpace,
    createCustom: async (declaration, location, availability) => {
      const audit = declaration.agentAudit

      if (!audit) {
        throw new Error(`agent-created skill ${declaration.name} has no audit declaration`)
      }
      const declaredSession = audit.sessionRef
        ? world.agentSessions?.find((session) => session.ref === audit.sessionRef)
        : undefined

      if (audit.sessionRef && !declaredSession) {
        throw new Error(`agent-created skill references unknown session: ${audit.sessionRef}`)
      }
      const owner = resolveSeedAgentActivityOwner({
        kind: 'write',
        activityOwner: audit.owner,
        sessionOwner: declaredSession ? (declaredSession.owner ?? primary.username) : undefined,
        fallbackOwner: primary.username,
        asUser,
      })
      const principalId = principalIdOf(audit.principal) as string
      const principal = {
        ...SYSTEM_PRINCIPAL,
        id: principalId,
        userId: userIdOf(owner),
        username: owner,
        scope: 'write' as const,
        grants: new Map([[location.space, 'owner' as const]]),
        spaces: new Set([location.space]),
        system: false,
      }
      const addressed = roleService.resolveOwnedPlacement(
        location,
        personalSpaceForPlacement(personalSpaceIds, location.space),
      )

      if (!addressed) {
        throw new Error(`agent-created skill has no addressed placement: ${declaration.name}`)
      }
      const body = {
        name: declaration.name,
        description: declaration.description,
        instructions: declaration.instructions ?? '',
        ...(location.scope === 'personal'
          ? { scope: 'personal' as const }
          : {
              scope: 'space' as const,
              space: manager.slugOf(location.space) ?? location.space,
              availability:
                availability?.mode === 'selected-projects'
                  ? {
                      mode: 'selected-projects' as const,
                      projects: availability.projectIds,
                    }
                  : { mode: 'all-projects' as const },
            }),
      }
      const result = await durableAbilityCreator.createDurably({
        prepared: {
          kind: 'skill',
          source: 'custom',
          body,
          principal,
          personalSpace: personalSpaceForPlacement(personalSpaceIds, location.space),
          location: addressed,
          ...(availability ? { availability } : {}),
        },
        attribution: {
          principal: principalId,
          agent: {
            owner: userIdOf(owner),
            agent: audit.agent ?? null,
            ...(declaredSession && audit.sessionRef
              ? {
                  session: {
                    id: agentSessionId(audit.sessionRef),
                    name: declaredSession.name,
                    attach: audit.sessionAttach ?? ('declared' as const),
                  },
                }
              : {}),
          },
        },
        preparePackage: async () => ({
          prepared: {
            kind: 'skill',
            source: 'custom',
            body,
            principal,
            personalSpace: personalSpaceForPlacement(personalSpaceIds, location.space),
            location: addressed,
            ...(availability ? { availability } : {}),
          },
          pkg: roleService.prepareCustomSkill(
            declaration.name,
            declaration.description,
            declaration.instructions ?? '',
          ),
        }),
        operation: {
          idempotencyKey: `seed:${declaration.name}`,
          scopeKey: `${location.scope}:${location.space}`,
          systemNamePolicy: 'reject',
        },
      })

      return { packageId: result.ability.packageId, noteId: result.ability.noteId }
    },
    resolveLocation: async (declaration) => {
      const home = declaration.home

      if (home.kind === 'personal') {
        if (declaration.availability) {
          throw new Error(`personal skill ${declaration.name} cannot declare availability`)
        }
        const username = home.user ? asUser(home.user) : primary.username
        const personalSlug = personalSpaceOf.get(username)
        const personal = personalSlug ? idOf.get(personalSlug) : null

        if (!personal) {
          throw new Error(`agent skill ${declaration.name} has no personal space for ${username}`)
        }

        const location = { scope: 'personal' as const, space: personal }
        return {
          role: declaration.roleTarget ? await resolveRoleTarget(declaration.roleTarget) : location,
          skill: location,
        }
      }
      const space = idOf.get(home.space)

      if (!space) {
        throw new Error(`agent skill ${declaration.name} references an unknown space`)
      }
      const location = { scope: 'space' as const, space }
      const availability = resolveAvailabilityDecl(
        declaration.availability,
        space,
        projectOf,
        `agent skill ${declaration.name}`,
      )

      return {
        role: declaration.roleTarget ? await resolveRoleTarget(declaration.roleTarget) : location,
        skill: location,
        availability,
      }
    },
  })

  // Owner Enable/Disable overrides, resolved by the one applier both stands share
  // (`test/cases/applyAbilityPreferences.ts`) — the real clock and the real facet are
  // this host's to supply, the resolution is not.
  const agentAbilityPreferences = await applyAgentAbilityPreferences({
    declarations: world.agentAbilityPreferences ?? [],
    roles: roleService,
    publishedRoles: appliedRoles,
    publishedSkills: appliedSkills,
    resolvePlacement: resolveRoleTarget,
    ownerOf: (preference) => userIdOf(preference.user ? asUser(preference.user) : primary.username),
    setEnabled: (owner, target, enabled) =>
      metaDb.abilityPreferences.setEnabled(owner, target, enabled, t),
  })

  /** Resolve every seeded context facet through one scope-addressing seam. Role
   * declarations address an exact owned placement, not the effective winner, so
   * same-name Personal/Space/Project presets stay independently inspectable. */
  const resolveContextTarget = async (
    declaration: ContextSetAttachDecl,
  ): Promise<{
    targetKind: 'personal' | 'project' | 'role'
    targetId: string
    targetSpace: string
  } | null> => {
    if (declaration.kind === 'personal') {
      const personalSlug = personalSpaceOf.get(asUser(declaration.user))
      const personal = personalSlug ? idOf.get(personalSlug) : undefined

      return personal ? { targetKind: 'personal', targetId: personal, targetSpace: personal } : null
    }
    if (declaration.kind === 'project') {
      const space = idOf.get(declaration.space)
      const project = projectRows.find(
        (candidate) => candidate.space === space && candidate.path === declaration.path,
      )

      return project
        ? { targetKind: 'project', targetId: project.id, targetSpace: project.space }
        : null
    }

    const target = declaration.target
    const location =
      target.kind === 'personal'
        ? (() => {
            const username = target.user ? asUser(target.user) : primary.username
            const personalSlug = personalSpaceOf.get(username)
            const personal = personalSlug ? idOf.get(personalSlug) : undefined
            return personal ? ({ scope: 'personal', space: personal } as const) : null
          })()
        : target.kind === 'space'
          ? (() => {
              const space = idOf.get(target.space)
              return space ? ({ scope: 'space', space } as const) : null
            })()
          : (() => {
              const space = idOf.get(target.space)
              const project = projectRows.find(
                (candidate) => candidate.space === space && candidate.path === target.path,
              )
              return project
                ? ({ scope: 'project', space: project.space, projectId: project.id } as const)
                : null
            })()

    const rolePackage = location
      ? (await roleLibrary.library.getAbilitiesNamed(location, declaration.name)).get('role')
      : null
    // The service decides personal-vs-Space from the locator, so it needs the personal
    // space of the owner this declaration names — never the seeder's own. Asked of the
    // PLACEMENT rather than of the declaration's kind: a role sitting in a project of
    // somebody's personal space is placed there by that same owner, and answering
    // `null` for it made the resolver look for its dependencies in a Space root that
    // space does not have.
    const ownerPersonalSpace = location
      ? personalSpaceForPlacement(personalSpaceIds, location.space)
      : null
    const resolved =
      location && rolePackage
        ? await roleService.addressedRoleAt(
            // Minted, not spelled: the seeder chose the placement, but how a placement
            // becomes an address is the service's rule — and a stand built on a stale
            // spelling answers 404 to the very server that seeded it.
            ownedRoleLocator(location, rolePackage.directoryName),
            SYSTEM_PRINCIPAL,
            ownerPersonalSpace,
          )
        : null

    if (!resolved) {
      throw new Error(
        `role context references a missing owned role: ${declaration.name} (${target.kind})`,
      )
    }
    const roleTarget = roleContextTargetOf(resolved)
    return { targetKind: 'role', targetId: roleTarget.id, targetSpace: roleTarget.space }
  }

  // 3b. Connected OAuth apps (#181): mint an oauth client + a LIVE access + refresh
  //     token pair per declared connection, with per-space narrowing (slugs → stable
  //     ids), so Settings → Connected apps shows real data. Only the hash of each
  //     secret is stored (the plaintext is discarded — these are display state, not
  //     usable tokens). Expiries anchor on the real `now` so the rows read as live
  //     when the owner looks (refresh well beyond an access lapse, mirroring prod).
  const nowMs = Date.parse(nowIso)
  const daysAgoIso = (d: number) => new Date(nowMs - d * 86_400_000).toISOString()
  const daysAheadIso = (d: number) => new Date(nowMs + d * 86_400_000).toISOString()
  let connectedApps = 0
  let pendingOAuthClients = 0
  const oauthPrincipals = new Map<string, string>()

  for (const [i, app] of (world.auth?.connectedApps ?? []).entries()) {
    const owner = app.owner ? asUser(app.owner) : primary.username
    const clientId = `ntcli_seed_${i}_${app.appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    const spaceIds =
      app.spaces == null
        ? null
        : app.spaces.flatMap((s) => (idOf.get(s) ? [idOf.get(s) as string] : []))
    const createdAt = daysAgoIso(app.connectedDaysAgo ?? 7)
    const lastUsedAt = app.lastUsedDaysAgo == null ? null : daysAgoIso(app.lastUsedDaysAgo)
    await metaDb.oauth.upsertClient({
      clientId,
      kind: 'dcr',
      redirectUris: [`https://${app.appName.toLowerCase()}.example/oauth/callback`],
      clientName: app.appName,
      createdAt,
      lastSeen: createdAt,
      activatedAt: createdAt,
    })
    const refresh = mintOAuthRefreshToken()
    await metaDb.oauth.insertRefresh({
      id: refresh.id,
      tokenHash: sha256(refresh.secret),
      userId: userIdOf(owner),
      clientId,
      scope: app.scope,
      spaces: spaceIds,
      expiresAt: daysAheadIso(60),
      rotatedTo: null,
      revokedAt: null,
      createdAt,
    })
    const access = mintOAuthAccessToken()
    await metaDb.oauth.insertAccess({
      id: access.id,
      tokenHash: sha256(access.secret),
      userId: userIdOf(owner),
      clientId,
      scope: app.scope,
      spaces: spaceIds,
      expiresAt: daysAheadIso(2),
      refreshId: refresh.id,
      revokedAt: null,
      createdAt,
      lastUsedAt,
    })
    oauthPrincipals.set(
      `${owner}\0${app.appName.toLowerCase()}`,
      oauthPrincipalId(userIdOf(owner), access.id),
    )
    connectedApps++
  }

  // Pending OAuth registry rows: registrations that have not crossed a
  // human consent boundary yet. They are intentionally absent from Connected apps
  // and are the only rows subject to the persistent quota + 24h GC.
  for (const [i, client] of (world.auth?.pendingOAuthClients ?? []).entries()) {
    const createdAt = new Date(nowMs - (client.registeredHoursAgo ?? 1) * 3_600_000).toISOString()
    await metaDb.oauth.upsertClient({
      clientId:
        client.clientId ??
        `ntcli_seed_pending_${i}_${client.clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      kind: client.kind,
      redirectUris: client.redirectUris,
      clientName: client.clientName,
      createdAt,
      lastSeen: createdAt,
      activatedAt: null,
    })
    pendingOAuthClients++
  }

  // 3c. Durable agent episodes. Parent refs form a small DAG; resolve it
  // topologically so a combined case need not depend on declaration order.
  let agentSessions = 0
  const pendingSessions = [...(world.agentSessions ?? [])]
  const sessionByRef = new Map((world.agentSessions ?? []).map((session) => [session.ref, session]))
  const insertedSessionRefs = new Set<string>()

  while (pendingSessions.length) {
    const index = pendingSessions.findIndex(
      (session) => !session.parentRef || insertedSessionRefs.has(session.parentRef),
    )

    if (index < 0) {
      throw new Error(
        `agent sessions contain a missing or cyclic parent: ${pendingSessions.map((s) => s.ref).join(', ')}`,
      )
    }
    const [session] = pendingSessions.splice(index, 1)
    insertedSessionRefs.add(session.ref)

    if (session.retained === false) {
      continue
    }
    const owner = session.owner ? asUser(session.owner) : primary.username
    const personalSlug = personalSpaceOf.get(owner)
    const personalSpace = personalSlug ? (idOf.get(personalSlug) ?? null) : null
    const sessionProject = session.project
      ? projectRows.find(
          (project) =>
            project.space === idOf.get(session.project!.space) &&
            project.path === session.project!.path,
        )
      : undefined

    if (session.project && !sessionProject) {
      throw new Error(
        `agent session ${session.ref} references an unknown project ${session.project.space}:${session.project.path}`,
      )
    }
    const selectedRole = session.role
      ? await roleService.resolveEffective(
          { personalSpace, ...(sessionProject ? { project: sessionProject } : {}) },
          SYSTEM_PRINCIPAL,
          session.role,
        )
      : null
    await metaDb.sessions.insert({
      id: agentSessionId(session.ref),
      owner: userIdOf(owner),
      name: session.name,
      named: session.named ?? true,
      parentId:
        session.parentRef && sessionByRef.get(session.parentRef)?.retained !== false
          ? agentSessionId(session.parentRef)
          : null,
      createdAt: daysAgoIso(session.createdDaysAgo),
      lastSeenAt: daysAgoIso(session.lastSeenDaysAgo),
      calls: session.calls,
      role: selectedRole?.role.name ?? null,
      // The address the resolver already produced, not a second derivation of it: a
      // System role has no placement to build one from at all, and rebuilding it here
      // made the seeder a producer of the very locator the binding is looked up by.
      roleLocator: selectedRole?.locator ?? null,
      roleContextProjectId: selectedRole ? (sessionProject?.id ?? null) : null,
      projectId: sessionProject?.id ?? null,
    })
    agentSessions++
  }

  let agentCalls = 0

  if (world.agentTelemetryDetailed) {
    const config = await metaDb.agentCalls.config()
    await metaDb.agentCalls.patchConfig({
      expectedVersionToken: config.versionToken,
      detailedEnabled: true,
      updatedAt: nowIso,
    })
  }
  for (const declaration of world.agentCalls ?? []) {
    const sessionDeclaration = declaration.sessionRef
      ? sessionByRef.get(declaration.sessionRef)
      : undefined

    if (declaration.sessionRef && !sessionDeclaration) {
      throw new Error(`agent call references unknown session: ${declaration.sessionRef}`)
    }
    const owner = declaration.owner
      ? asUser(declaration.owner)
      : sessionDeclaration?.owner
        ? asUser(sessionDeclaration.owner)
        : primary.username
    const id = agentCallId(declaration.ref)
    const startedAt = daysAgoIso(declaration.daysAgo)
    const durationMs = declaration.durationMs ?? 12
    const finishedAt = new Date(Date.parse(startedAt) + durationMs).toISOString()
    const policy = Object.hasOwn(TRACE_TOOL_POLICY, declaration.tool)
      ? TRACE_TOOL_POLICY[declaration.tool as keyof typeof TRACE_TOOL_POLICY]
      : null

    if (policy && (declaration.effect !== policy.effect || declaration.domain !== policy.domain)) {
      throw new Error(
        `agent call ${declaration.ref} declares ${declaration.effect}/${declaration.domain}; ` +
          `${declaration.tool} emits ${policy.effect}/${policy.domain}`,
      )
    }
    await metaDb.agentCalls.admit({
      id,
      owner: userIdOf(owner),
      principal: principalIdOf(declaration.principal) as string,
      agent: declaration.agent ?? null,
      transport: 'mcp',
      requestId: null,
      tool: declaration.tool,
      effect: policy?.effect ?? declaration.effect,
      domain: policy?.domain ?? declaration.domain,
      startedAt,
      inputBytes: 0,
      inputShape: [],
      targetSummary: declaration.target ?? null,
      fingerprint: declaration.fingerprint ?? id.slice(5),
      projectionVersion: 1,
      redacted: declaration.redacted ?? false,
      truncated: declaration.truncated ?? false,
    })
    if (sessionDeclaration) {
      await metaDb.agentCalls.bind(owner, id, {
        id: agentSessionId(sessionDeclaration.ref),
        name: sessionDeclaration.name,
        attach: declaration.sessionAttach ?? 'declared',
      })
    }
    if (declaration.detailed) {
      await metaDb.agentCalls.appendDetail({
        owner,
        id,
        payload: declaration.detailed,
        createdAt: finishedAt,
        expiresAt: new Date(Date.parse(finishedAt) + 30 * 86_400_000).toISOString(),
      })
    }
    await metaDb.agentCalls.finalize(owner, id, {
      finishedAt,
      durationMs,
      outcome: declaration.outcome,
      reasonCode: declaration.reasonCode ?? null,
      outputBytes: 0,
      issueSummary: declaration.issues ?? null,
      resultSummary: declaration.result ?? null,
      fingerprint: declaration.fingerprint ?? id.slice(5),
      redacted: declaration.redacted ?? false,
      truncated: declaration.truncated ?? false,
      detailCaptureFailed: declaration.detailCaptureFailed ?? false,
    })
    agentCalls++
  }

  // 4. Replay the timeline. Group by space and replay each space's events in date
  //    order (they arrive globally sorted, so per-space order is preserved). The
  //    journal is per-space and there is no cross-space ordering requirement, so
  //    replaying one space at a time — rather than globally interleaving — keeps
  //    each space's build sequential and clean: the engine's external-change
  //    watcher never catches a space mid-write while the clock has jumped to
  //    another space's event, which would spuriously re-journal our own writes as
  //    `external`. Set the clock, drive the real write path, drain the journal
  //    before advancing time (so each row lands at its own instant, ids monotonic).
  const live = new Map<
    string,
    {
      spaceSlug: string
      id: string
      title: string
      versionToken: string
      class: string
      filePath: string
      createdAt: string
    }
  >()
  let creates = 0
  let edits = 0
  let deletes = 0
  let restores = 0
  const ownerKey = userPrincipalId(userIdOf(primary.username))

  const eventsBySpace = new Map<string, typeof world.events>()

  for (const e of world.events) {
    const list = eventsBySpace.get(e.space)

    if (list) {
      list.push(e)
    } else {
      eventsBySpace.set(e.space, [e])
    }
  }

  for (const [spaceSlug, spaceEvents] of eventsBySpace) {
    const spaceId = idOf.get(spaceSlug)

    if (!spaceId) {
      throw new Error(`event references unknown space: ${spaceSlug}`)
    }
    const store = await manager.store(spaceId)
    // The real applier can carry thousands of creates in one space. Bracket that
    // replay exactly like the supported importer does: journal rows and injected
    // clocks still settle per event below, while resolver/ghost/graph corpus work
    // is paid once at the boundary instead of once per seeded note.
    const bulkStore = store as typeof store & {
      beginBulk?: () => void
      endBulk?: () => Promise<void>
    }

    bulkStore.beginBulk?.()

    for (const e of spaceEvents) {
      clock = new Date(normDate(e.date))
      const declaredSession = e.agentAudit?.sessionRef
        ? sessionByRef.get(e.agentAudit.sessionRef)
        : undefined
      const declaredCall = e.agentAudit?.callRef
        ? world.agentCalls?.find((candidate) => candidate.ref === e.agentAudit?.callRef)
        : undefined

      if (e.agentAudit?.sessionRef && !declaredSession) {
        throw new Error(`agent write references unknown session: ${e.agentAudit.sessionRef}`)
      }
      if (e.agentAudit?.callRef && !declaredCall) {
        throw new Error(`agent write references unknown call: ${e.agentAudit.callRef}`)
      }
      const auditOwner = e.agentAudit
        ? resolveSeedAgentActivityOwner({
            kind: 'write',
            activityOwner: e.agentAudit.owner,
            sessionOwner: declaredSession ? (declaredSession.owner ?? primary.username) : undefined,
            fallbackOwner: primary.username,
            asUser,
          })
        : undefined
      const agent = auditOwner
        ? {
            owner: userIdOf(auditOwner),
            agent: e.agentAudit?.agent ?? null,
            ...(e.agentAudit?.callRef ? { agentCallId: agentCallId(e.agentAudit.callRef) } : {}),
            ...(declaredSession && e.agentAudit?.sessionRef
              ? {
                  session: {
                    id: agentSessionId(e.agentAudit.sessionRef),
                    name: declaredSession.name,
                    attach: e.agentAudit.sessionAttach ?? ('declared' as const),
                  },
                }
              : {}),
          }
        : undefined

      if (e.op === 'create') {
        let eventPath = e.path

        if (e.projectMemory) {
          const projectSpace = idOf.get(e.projectMemory.space)
          const project = projectRows.find(
            (candidate) =>
              candidate.space === projectSpace && candidate.path === e.projectMemory!.path,
          )

          if (!project || project.space !== spaceId) {
            throw new Error(
              `project memory references an unknown project: ${e.projectMemory.space}/${e.projectMemory.path}`,
            )
          }
          if (e.class !== 'agent-memory' || !e.path.startsWith(`${AGENT_MEMORY_MOUNT}/`)) {
            throw new Error(`project memory note must use the agent-memory mount: ${e.path}`)
          }
          eventPath = e.path.replace(
            `${AGENT_MEMORY_MOUNT}/`,
            `${AGENT_MEMORY_MOUNT}/${project.id}/`,
          )
        }
        const route = routeOf(eventPath, e.class)
        const res = await store.write({
          title: e.title,
          content: e.content,
          directory: route.directory,
          fileName: route.fileName,
          // A fixture-pinned physical id (the identity an authored
          // `[[notarium-id:…]]` in some other seeded note points at). Absent for
          // every ordinary note, which keeps minting its own.
          ...(e.physicalId ? { id: e.physicalId } : {}),
          // `pin` makes a note an always-load CONTEXT pin (the #165 tag the pult reads via
          // weighAlwaysLoad) AND a #42 favorite (below) — the two senses the decl documents.
          // Without the tag a seeded stand's pult showed ZERO local pins (only sets/scope-pins).
          tags: e.pin ? [...(e.tags ?? []), 'always-load'] : e.tags,
          noteType: e.noteType,
          targetClass: route.targetClass,
          summary: e.summary,
          muted: e.muted,
          // The author's own frontmatter (#280) — the SAME write channel the
          // importer uses, so a seeded "imported note" carries its keys the way a
          // really-dropped file does rather than by a seeder-only shortcut.
          frontmatter: e.frontmatter ? parseFrontmatterLines(e.frontmatter) : undefined,
          sourceLocator: e.sourceLocator,
          createdAt: normDate(e.date),
          principal: principalIdOf(e.principal),
          ...(agent ? { agent } : {}),
        })
        await store.settle?.()
        const id = res.id

        if (!id || !res.versionToken) {
          throw new Error(`create returned no id/token for ${e.path}`)
        }
        live.set(e.noteId, {
          spaceSlug: e.space,
          id,
          title: e.title,
          versionToken: res.versionToken,
          class: e.class ?? 'user-doc',
          filePath: eventPath,
          createdAt: normDate(e.date),
        })
        creates++
        if (e.pin) {
          await metaDb.favorites.add({
            owner: ownerKey,
            space: spaceId,
            kind: 'note',
            entityId: id,
            createdAt: normDate(e.date),
            rank: null,
          })
        }
      } else {
        const prev = live.get(e.noteId)

        if (!prev) {
          throw new Error(`event for unknown note ${e.noteId} (op ${e.op})`)
        }
        if (e.op === 'edit') {
          const current = await store.read(prev.id)
          const route = e.path ? routeOf(e.path, prev.class) : undefined
          const res = await store.write({
            title: e.title ?? prev.title,
            content: e.content ?? current.content,
            ...(route ? { directory: route.directory, fileName: route.fileName } : {}),
            tags: e.tags,
            frontmatter: e.frontmatter ? parseFrontmatterLines(e.frontmatter) : undefined,
            originalId: prev.id,
            versionToken: prev.versionToken,
            principal: principalIdOf(e.principal),
            ...(agent ? { agent } : {}),
          })
          await store.settle?.()
          if (!res.versionToken) {
            throw new Error(`edit returned no token for note ${e.noteId}`)
          }
          prev.versionToken = res.versionToken
          if (e.title) {
            prev.title = e.title
          }
          if (res.filePath) {
            prev.filePath = res.filePath
          }
          edits++
        } else if (e.op === 'delete') {
          await store.remove(prev.id, {
            principal: principalIdOf(e.principal),
            ...(agent ? { agent } : {}),
          })
          await store.settle?.()
          deletes++
        } else {
          // restore (#79/#184): un-delete through the real trash path so the journal gets
          // a proper `kind:'restore'` row ("Restored from vN") and the note leaves the
          // trash — not a plain re-write masquerading as a restore.
          if (!store.restoreFromTrash) {
            throw new Error(`engine has no trash capability (restore of ${e.noteId})`)
          }
          const res = await store.restoreFromTrash(prev.id, {
            principal: principalIdOf(e.principal),
          })
          await store.settle?.()
          if (res.versionToken) {
            prev.versionToken = res.versionToken
          }
          restores++
        }
      }
    }
    await bulkStore.endBulk?.()
  }

  // 4a. Named restore/read edge states. These declarations intentionally bypass
  // ordinary writes because gaps, legacy blobs and opaque sources cannot be
  // truthfully produced through that API. Both seed appliers call the same codec
  // materializer, then append through their real revision persistence.
  for (const declaration of [...(world.revisionStates ?? [])].sort((left, right) =>
    normDate(left.date).localeCompare(normDate(right.date)),
  )) {
    const note = live.get(declaration.note)

    if (!note) {
      throw new Error(`revision state references unknown note: ${declaration.note}`)
    }
    const space = idOf.get(note.spaceSlug)

    if (!space) {
      throw new Error(`revision state note has unknown space: ${note.spaceSlug}`)
    }
    const materialized = materializeRevisionState(declaration, {
      noteId: note.id,
      path: note.filePath,
      createdAt: note.createdAt,
      title: note.title,
    })
    const head = await metaDb.revisions.latestFor(space, note.id)
    const blob = materialized.blob

    await metaDb.revisions.append(
      {
        noteId: note.id,
        space,
        baseRevisionId: head?.id ?? null,
        expectedHeadRevisionId: head?.id ?? null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: declaration.kind ?? 'write',
        entryRole: 'change',
        principal: principalIdOf(declaration.principal) ?? null,
        contentHash: blob == null ? null : await sha256Hex(blob),
        semanticFingerprint: materialized.semanticFingerprint,
        restoreSafety: materialized.restoreSafety,
        stateFormat: materialized.stateFormat,
        title: materialized.title,
        class: note.class,
        slug: null,
        tags: [],
        createdAt: normDate(declaration.date),
        charsAdded: null,
        charsRemoved: null,
      },
      blob,
    )
  }

  // 4b. Owner/session delta positions. Cursor declarations name a journalled
  // note rather than a driver-specific numeric revision; resolve that semantic
  // anchor only after the real timeline has minted both note and revision ids.
  let agentDeltaCursors = 0

  for (const cursor of world.agentDeltaCursors ?? []) {
    const note = live.get(cursor.throughNote)

    if (!note) {
      throw new Error(`agent delta cursor references unknown note: ${cursor.throughNote}`)
    }
    if (note.spaceSlug !== cursor.project.space) {
      throw new Error(
        `agent delta cursor anchor ${cursor.throughNote} belongs to space ${note.spaceSlug}, ` +
          `not project space ${cursor.project.space}`,
      )
    }
    const cursorSpaceId = idOf.get(cursor.project.space)

    if (!cursorSpaceId) {
      throw new Error(`agent delta cursor references unknown space: ${cursor.project.space}`)
    }
    const revision = (
      await metaDb.revisions.listByNote(cursorSpaceId, note.id, { offset: 0, limit: 1 })
    ).items[0]

    if (!revision) {
      throw new Error(`agent delta cursor note has no journal revision: ${cursor.throughNote}`)
    }
    const spaceId = idOf.get(cursor.project.space)
    const project = spaceId
      ? (await metaDb.projects.listForSpace(spaceId)).find(
          (candidate) => candidate.path === cursor.project.path,
        )
      : undefined

    if (!project) {
      throw new Error(
        `agent delta cursor references unknown project: ${cursor.project.space}/${cursor.project.path}`,
      )
    }
    const declaredSession = cursor.sessionRef ? sessionByRef.get(cursor.sessionRef) : undefined

    if (cursor.sessionRef && !declaredSession) {
      throw new Error(`agent delta cursor references unknown session: ${cursor.sessionRef}`)
    }
    const owner = resolveSeedAgentDeltaCursorOwner({
      cursorOwner: cursor.owner,
      sessionOwner: declaredSession ? (declaredSession.owner ?? primary.username) : undefined,
      fallbackOwner: primary.username,
      asUser,
    })
    await metaDb.agentDeltaCursors.advance(
      {
        owner: userIdOf(owner),
        ...(cursor.sessionRef
          ? {
              session: {
                id: agentSessionId(cursor.sessionRef),
                parentId: declaredSession?.parentRef
                  ? agentSessionId(declaredSession.parentRef)
                  : null,
              },
            }
          : {}),
      },
      project.id,
      revision.id,
      t,
    )
    agentDeltaCursors++
  }

  // 5. Shared context declarations run after packages, preferences, sessions and the
  // note timeline, so both seed hosts build identical carried rows before a move.
  const appliedContext = await applyContextDeclarations({
    contextSets: world.contextSets ?? [],
    scopePins: world.scopePins ?? [],
    contextOrder: world.contextOrder ?? [],
    persistence: {
      contextSets: metaDb.contextSets,
      scopePins: metaDb.scopePins,
      contextOrder: metaDb.contextOrder,
    },
    resolveHomeSpace: (slug) => idOf.get(slug) ?? null,
    resolveTarget: resolveContextTarget,
    resolveNote: (logicalId) => {
      const note = live.get(logicalId)
      const space = note ? idOf.get(note.spaceSlug) : undefined
      return note && space ? { space, noteId: note.id } : null
    },
    freshId: freshNoteId,
    createdAt: t,
  })
  const contextSets = appliedContext.contextSets
  let scopePins = appliedContext.scopePins
  const contextOrders = appliedContext.contextOrders

  for (const skill of appliedSkills) {
    for (const attach of skill.declaration.pins ?? []) {
      const target = await resolveContextTarget(attach)

      if (target) {
        await metaDb.scopePins.addPin({
          ...target,
          noteSpace: skill.location.space,
          noteId: skill.noteId,
          createdAt: t,
        })
        scopePins++
      }
    }
  }
  const agentRoleMoves = (
    await applyAgentRoleMoves({
      declarations: world.agentRoleMoves ?? [],
      roles: roleService,
      publishedRoles: appliedRoles,
      resolvePlacement: resolveRoleTarget,
      personalSpaceFor: (location) => personalSpaceForPlacement(personalSpaceIds, location.space),
    })
  ).length

  // 5c. Favorites (#42/#245): star the declared notes/folders/projects so the
  //     merged Files section's favorites lens has real data — the rail Files↔Favorites
  //     invariant is only testable with actual starred entities across folders. A note
  //     favorite resolves the note's real id; a project favorite reuses the marked
  //     project's id; a FOLDER favorite lazily mints the folder's identity exactly like
  //     the server's add-to-favorites path (ensureFolderIdentity — a `type='folder'`
  //     marker + row, NOT a project). Owner = the primary login, so the star shows up
  //     on first sight. Done before archive/stop (the marker write needs the live
  //     manager for the folder's notesDir).
  let favorites = 0
  clock = new Date(nowIso)
  for (const f of world.favorites ?? []) {
    const spaceId = idOf.get(f.space)

    if (!spaceId) {
      throw new Error(`favorite references unknown space: ${f.space}`)
    }
    let entityId: string

    if (f.kind === 'note') {
      const n = live.get(f.ref)

      if (!n) {
        throw new Error(`favorite references unknown note: ${f.ref}`)
      }
      entityId = n.id
    } else if (f.kind === 'project') {
      const proj = (await metaDb.projects.listForSpace(spaceId)).find((p) => p.path === f.ref)

      if (!proj) {
        throw new Error(`favorite references unmarked project path "${f.ref}" in ${f.space}`)
      }
      entityId = proj.id
    } else {
      // Validate the folder actually exists BEFORE minting its identity — otherwise a
      // typo'd ref would silently write a stray `.notariummeta` marker for a phantom
      // folder and leave a broken star. This is the seeder's own check (a folder must
      // hold at least one SEEDED note) — deliberately STRICTER than the server's
      // add-to-favorites guard (treeDirsFor, which also accepts empty/identified
      // folders); a seed case always creates content under a folder it stars, so
      // "has a note" is the honest, dependency-light signal here.
      const store = await manager.store(spaceId)
      const dirs = new Set((await store.list()).map((n) => dirOf(n.filePath)))
      const folderExists = [...dirs].some((d) => d === f.ref || d.startsWith(`${f.ref}/`))

      if (!folderExists) {
        throw new Error(
          `favorite references a folder with no seeded notes: "${f.ref}" in ${f.space}`,
        )
      }
      entityId = await ensureFolderIdentity(
        { projects: metaDb.projects, folders: metaDb.folders, markerStore, now: () => clock },
        { space: spaceId, folderPath: f.ref },
      )
    }
    await metaDb.favorites.add({
      owner: ownerKey,
      space: spaceId,
      kind: f.kind,
      entityId,
      createdAt: nowIso,
      rank: null,
    })
    favorites++
  }

  // 5d. Agent retrieval audit (#243): a meta-DB-only side-channel (like connected apps) —
  //     backdated retrieval-log rows so Agents → Sessions has real history +
  //     blind spots. Runs AFTER the replay so every hit's note id resolves via `live`.
  //     A retrieval with no resolvable hits is a zero-result MISS. Owner = the seed user
  //     (so /api/me/agent-audit shows it); principal remapped like every attribution.
  let retrievals = 0

  for (const r of world.retrievals ?? []) {
    const declaredSession = r.sessionRef ? sessionByRef.get(r.sessionRef) : undefined

    if (r.sessionRef && !declaredSession) {
      throw new Error(`retrieval references unknown session: ${r.sessionRef}`)
    }
    const owner = resolveSeedAgentActivityOwner({
      kind: 'retrieval',
      activityOwner: r.owner,
      sessionOwner: declaredSession ? (declaredSession.owner ?? primary.username) : undefined,
      fallbackOwner: primary.username,
      asUser,
    })
    const hits = (r.hits ?? []).flatMap((h) => {
      const note = live.get(h.note)

      if (!note) {
        return []
      }

      return [
        {
          noteId: note.id,
          title: note.title,
          class: note.class,
          ...(h.score != null ? { score: h.score } : {}),
        },
      ]
    })
    const scores = hits.map((h) => h.score).filter((s): s is number => typeof s === 'number')
    // get_note's `query` is the REF the agent passed — a real note id, resolved from the
    // opened note (the case authors it by logical id, which would otherwise leak). Others
    // carry the literal query text.
    const query = r.tool === 'get_note' && hits[0] ? hits[0].noteId : r.query
    const principal = r.principal.startsWith('oauth:')
      ? (oauthPrincipals.get(`${owner}\0${r.principal.slice('oauth:'.length).toLowerCase()}`) ??
        (principalIdOf(r.principal) as string))
      : (principalIdOf(r.principal) as string)
    await metaDb.retrievalLog.append({
      owner: userIdOf(owner),
      principal,
      agent: r.agent ?? null,
      sessionId: r.sessionRef ? agentSessionId(r.sessionRef) : null,
      sessionName: declaredSession?.name ?? null,
      sessionAttach: r.sessionRef ? (r.sessionAttach ?? 'declared') : null,
      agentCallId: r.callRef ? agentCallId(r.callRef) : null,
      tool: r.tool,
      query,
      project: r.project ?? null,
      classFilter: r.classFilter ?? null,
      resultCount: hits.length,
      topScore: r.tool === 'search' && scores.length ? Math.max(...scores) : null,
      hits,
      createdAt: new Date(nowMs - r.daysAgo * 86_400_000).toISOString(),
    })
    retrievals++
  }

  let agentCleanupMarkers = 0

  for (const marker of world.agentCleanupMarkers ?? []) {
    const session = sessionByRef.get(marker.sessionRef)

    if (!session) {
      throw new Error(`agent cleanup marker references unknown session: ${marker.sessionRef}`)
    }
    const owner = marker.owner
      ? asUser(marker.owner)
      : session.owner
        ? asUser(session.owner)
        : primary.username

    for (const operation of marker.operations) {
      const common = {
        owner: userIdOf(owner),
        sessionId: agentSessionId(marker.sessionRef),
        acceptedAt: nowIso,
        batchSize: operation.cleanup === 'pending' ? 0 : 10_000,
      }

      if (operation.reason === 'retention') {
        await metaDb.agentCalls.expireSession({ ...common, expiredBefore: nowIso })
      } else {
        await metaDb.agentCalls.deleteSession({
          ...common,
          activeSince: nowIso,
          confirmActive: true,
        })
      }
    }
    agentCleanupMarkers++
  }

  // 6. Durable jobs (#105) + their artifacts. Runs AFTER the replay so a seeded export
  //    archives the notes the timeline just created. Nothing here is fabricated: the
  //    applier enqueues, claims and runs the PRODUCTION export handler against the real
  //    store, so the archive is a real ZIP under `<DATA_DIR>/jobs` and its byte count is
  //    measured. That also makes `make seed` a live check of the data root (#101) — the
  //    artifact path used to be a forgotten env var whose breakage only surfaced when a
  //    user clicked export in prod.
  const jobArtifacts = createFsArtifactStore(dataPaths.jobsDataDir)
  // The handler dates the archive's FILENAME from its clock, so it reads the job's
  // instant, not the seeder's wall clock — otherwise a job stamped `completed_at` two
  // months ago hands back `main-notes-<today>.zip`, and the decl's promise that
  // nothing here is fabricated stops being true.
  let jobClock = new Date(nowIso)
  const exportHandler = createExportHandler({
    resolveStore: (space) => manager.store(space),
    slugOf: (space) => manager.recOf(space)?.slug ?? null,
    now: () => jobClock,
  })
  // Every decl is TERMINAL (see JobDecl), so each row is enqueued and resolved before
  // the next enqueue — nothing runnable is ever left lying around for claimNext (which
  // takes the oldest runnable row of the kind) to steal.
  let jobs = 0

  for (const j of world.jobs ?? []) {
    const spaceId = idOf.get(j.space)

    // Loud, like projects/favorites: a job aimed at a space the case never declared is
    // an authoring error, and swallowing it would seed a stand that quietly lacks the
    // state the case says it has.
    if (!spaceId) {
      throw new Error(`seed: job targets unknown space "${j.space}"`)
    }
    const at = new Date(nowMs - j.daysAgo * 86_400_000).toISOString()

    jobClock = new Date(at)
    const principal = j.owner ? userPrincipalId(ownerIdOf(j.owner)) : ownerKey
    const rec = await metaDb.jobs.enqueue({
      id: freshNoteId(),
      space: spaceId,
      kind: JOB_KIND_EXPORT,
      principal,
      params: j.params ?? {},
      createdAt: at,
    })
    // Every terminal state starts from a real claim — the lease the runner takes.
    const workerId = `seed-${rec.id}`
    const claimed = await metaDb.jobs.claimNext(workerId, [rec.kind], at)

    if (!claimed || claimed.id !== rec.id) {
      throw new Error(`seed: job ${rec.id} was not claimable (got ${claimed?.id ?? 'none'})`)
    }

    if (j.status === 'canceled') {
      await metaDb.jobs.cancel(rec.id, at)
      jobs++
      continue
    }

    if (j.status === 'failed') {
      // retryAt null ⇒ terminal `failed`, not a backoff reschedule (which the live
      // runner would then pick up and re-run).
      await metaDb.jobs.fail(rec.id, workerId, {
        error: j.error ?? 'failed',
        retryAt: null,
        now: at,
      })
      jobs++
      continue
    }
    // succeeded: run the real handler, then record what it actually produced.
    const out = await exportHandler({
      job: claimed,
      // The lease this seeded run holds — the claim above stamped it.
      lease: claimed.lockedBy ?? 'seed',
      artifacts: jobArtifacts,
      signal: new AbortController().signal,
      report: async () => {},
    })
    // Absent ⇒ the live runner's own window, imported rather than copied, so a seeded
    // artifact and a freshly exported one expire on the same schedule.
    const ttlMs = j.artifactTtlDays == null ? ARTIFACT_TTL_MS : j.artifactTtlDays * 86_400_000
    await metaDb.jobs.succeed(rec.id, workerId, {
      ...out,
      expiresAt: j.artifactTtlDays === null ? at : new Date(Date.parse(at) + ttlMs).toISOString(),
      now: at,
    })

    // A lapsed TTL: run the SAME two steps the GC does — drop the file, then clear the
    // pointer — so the row is honest history with a dead artifact, not a fake one.
    if (j.artifactTtlDays === null && out.artifactRef) {
      await jobArtifacts.remove(out.artifactRef)
      await metaDb.jobs.clearArtifact(rec.id, at)
    }
    jobs++
  }

  // 7. Retrying durable imports (#191/#268). The helper stages through the production
  //    store and creates a real pending row with a distant retry, so row-aware
  //    maintenance retains this backup-critical state for stable manual QA.
  const importStaging = createFsImportStagingStore(dataPaths.importStagingDir)
  const durableImports = await seedDurableImports({
    declarations: world.durableImports ?? [],
    spaceIds: idOf,
    jobs: metaDb.jobs,
    staging: importStaging,
    principal: ownerKey,
    createdAt: nowIso,
  })

  // 8. External editor rewrites (#267). Resolve logical ids only after the write
  //    timeline has minted real notes, then mutate their markdown files directly:
  //    no store API, same size, restored mtime. Watch + polling are disabled in
  //    this seed process, so the restarted production server must reconcile the
  //    changed cheap token/source hash and repair list/search/graph itself.
  // A cross-space id collision is an external rewrite whose replacement is only
  // knowable after the timeline ran: both ids are minted by the production write
  // path, and both are the same length, so size and mtime survive (#327).
  const identityClaims = (world.externalIdentityClaims ?? []).map((claim) =>
    identityClaimRewrite(claim, (handle) => live.get(handle)?.id),
  )
  const externalRewrites = await applySeedExternalRewrites(
    [...(world.externalRewrites ?? []), ...identityClaims].map((rewrite) => {
      const note = live.get(rewrite.note)

      if (!note) {
        throw new Error(`external rewrite references unknown note ${rewrite.note}`)
      }
      const spaceId = idOf.get(note.spaceSlug)
      const notesDir = spaceId ? notesDirOf(spaceId) : null

      if (!notesDir) {
        throw new Error(`external rewrite cannot resolve space ${note.spaceSlug}`)
      }

      return {
        note: rewrite.note,
        filePath: join(notesDir, note.filePath),
        replacements: rewrite.replacements,
      }
    }),
  )
  // Whole-file shapes no authoring write produces — an encoding prologue, prose opening
  // with a `---` rule. AFTER the size-preserving rewrites above on purpose: those look
  // for their own occurrence in the bytes the timeline wrote, and would not find it here.
  const externalSources = await applySeedExternalSources(
    (world.externalSources ?? []).map((decl) => {
      const note = live.get(decl.note)

      if (!note) {
        throw new Error(`external source references unknown note ${decl.note}`)
      }
      const spaceId = idOf.get(note.spaceSlug)
      const notesDir = spaceId ? notesDirOf(spaceId) : null

      if (!notesDir) {
        throw new Error(`external source cannot resolve space ${note.spaceSlug}`)
      }

      return {
        note: decl.note,
        filePath: join(notesDir, note.filePath),
        source: decl.source,
        tokens: { noteId: note.id, path: note.filePath, createdAt: note.createdAt },
      }
    }),
  )

  // 9. Archive any space the case marks archived (#110): it moves to the Trash
  //    (Spaces tab) with its data intact. Done AFTER its notes are seeded — archiving
  //    evicts the store.
  let archived = 0

  for (const s of world.spaces) {
    if (!s.archived) {
      continue
    }
    const id = idOf.get(s.slug)

    if (id) {
      await manager.archive(id, ownerKey)
      archived++
    }
  }

  await manager.stopAll()
  await metaDb.close()
  await applyProviderSeedOverrides(metaDbUrl, providerSeedOverrides)

  const publicPort = process.env.PORT || '3000'
  // A loud, human banner so the login is obvious in the seed output (the machine-
  // readable JSON follows). This is the answer to "how do I log in to the dev stand".
  console.log(
    [
      '',
      '  ┌─ dev stand seeded ─────────────────────────────',
      `  │   URL:    http://localhost:${publicPort}`,
      `  │   login:  ${primary.username}  /  ${primary.password ?? '(none)'}`,
      '  └─────────────────────────────────────────────────',
      '',
    ].join('\n'),
  )
  console.log(
    JSON.stringify(
      {
        ok: true,
        case: caseName,
        spaces: world.spaces.map((s) => s.slug),
        counts: {
          creates,
          edits,
          deletes,
          restores,
          archived,
          contextSets,
          scopePins,
          contextOrders,
          connectedApps,
          pendingOAuthClients,
          agentSessions,
          agentCalls,
          agentCleanupMarkers,
          agentRoles: appliedRoles.length,
          agentSkills: appliedSkills.length,
          agentAbilityPreferences,
          agentRoleMoves,
          agentDeltaCursors,
          favorites,
          retrievals,
          jobs,
          durableImports,
          externalRewrites,
          fieldSchemas,
          externalSources,
        },
        login: { username: primary.username, password: primary.password ?? '(none)' },
        url: `http://localhost:${publicPort}`,
      },
      null,
      2,
    ),
  )
}

run().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exit(1)
})
