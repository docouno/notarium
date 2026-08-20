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

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'

import {
  AGENT_MEMORY_MOUNT,
  CachedStore,
  freshNoteId,
  type MountConfig,
  type NoteClass,
  parseFrontmatterLines,
  sha256Hex,
} from '@notarium/core'
import { createNotariumStore, renameNoReplaceIfAvailable } from '@notarium/engine'
import {
  ARTIFACT_TTL_MS,
  createExportHandler,
  createFsArtifactStore,
  createFsImportStagingStore,
  createFsRoleLibrary,
  createMarkerStore,
  createMetaDb,
  createRolesService,
  dataPathsFromEnv,
  describeMetaDbUrl,
  ensureFolderIdentity,
  hashPassword,
  healSpaceMarker,
  JOB_KIND_EXPORT,
  loadBundledAbilityInventory,
  markFolderAsProject,
  mintOAuthAccessToken,
  mintOAuthRefreshToken,
  ownedRoleLocator,
  renameProjectSlug,
  roleContextTargetOf,
  sha256,
  SpaceManager,
  type SpaceRecord,
  SYSTEM_PRINCIPAL,
} from '@notarium/server'

import { buildCasesWorld, listCases } from '../test/cases'
import type { AgentRoleTargetDecl, CaseWorld, ContextSetAttachDecl, UserDecl } from '../test/cases'
import { applyAgentAbilityPreferences } from '../test/cases/applyAbilityPreferences'
import { applyAgentRoleDeclarations } from '../test/cases/applyAgentRoles'
import { applyAgentSkillDeclarations } from '../test/cases/applyAgentSkills'
import { normDate } from '../test/cases/generators'
import { personalSpaceForPlacement } from '../test/cases/personalSpaceSeam'
import { resolveAvailabilityDecl } from '../test/cases/resolveAvailability'
import { materializeRevisionState } from '../test/cases/revisionStates'
import { agentSessionId } from '../test/cases/sessionIds'
import { seedDurableImports } from './seedDurableImports'
import { applySeedExternalRewrites, identityClaimRewrite } from './seedExternalRewrites'
import {
  makeOwnerRemap,
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
  // The catalog authors primary content as a canonical owner token (`sergey`); the
  // real stand renders it as the configured INIT USER (SEED_USER, default `admin`), so
  // the default login IS the content author and the "mine" heatmap/feed light up out of
  // the box. A second collaborator (`alex`) stays as-is for multi-author cases. Override
  // with SEED_USER / SEED_PASSWORD / SEED_DISPLAY_NAME (or `make seed PASSWORD=…`).
  const CATALOG_OWNER = 'sergey'
  const { asUser, remapPrincipal } = makeOwnerRemap(CATALOG_OWNER, ownerUser)

  // CASE may be a single case or a comma-list to COMBINE (feed-scroll,trash-mixed).
  const world: CaseWorld = buildCasesWorld(caseName, { seed, scale, now: nowIso })
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
  const markerStore = createMarkerStore((id) => notesDirOf(id))

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
      const engine = createNotariumStore({
        mounts: defaultMounts(notesDir),
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
          ? { ...u, username: ownerUser, displayName: ownerName, password: ownerPass }
          : u,
      )
    : [{ username: ownerUser, password: ownerPass, displayName: ownerName, admin: true }]
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

  for (const u of users) {
    const personalSlug = personalSpaceOf.get(u.username)
    await metaDb.auth.createUser({
      username: u.username,
      displayName: u.displayName || u.username,
      passwordHash: u.password ? await hashPassword(u.password) : null,
      admin: Boolean(u.admin),
      disabledAt: null,
      createdAt: t,
      personalSpace: personalSlug ? (idOf.get(personalSlug) ?? null) : null,
    })
  }
  const members = (world.auth?.members ?? []).map((m) => ({ ...m, username: asUser(m.username) }))

  for (const m of members) {
    const space = idOf.get(m.space)

    if (space) {
      await metaDb.auth.upsertMember(space, m.username, m.role, t)
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
      await metaDb.auth.upsertMember(id, primary.username, 'owner', t)
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
  })
  const roleService = createRolesService({
    catalog: loadBundledAbilityInventory,
    library: roleLibrary,
    abilityAvailability: metaDb.abilityAvailability,
    abilityPreferences: metaDb.abilityPreferences,
    abilityPlacement: metaDb.abilityPlacement,
  })
  const projectRows = await metaDb.projects.listForSpaces([...idOf.values()])

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
    library: roleLibrary,
    storeForSpace: seedStoreForSpace,
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
    ownerOf: (preference) => (preference.user ? asUser(preference.user) : primary.username),
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

    const rolePackage = location ? await roleLibrary.getSkill(location, declaration.name) : null
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
      username: owner,
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
      username: owner,
      clientId,
      scope: app.scope,
      spaces: spaceIds,
      expiresAt: daysAheadIso(2),
      refreshId: refresh.id,
      revokedAt: null,
      createdAt,
      lastUsedAt,
    })
    oauthPrincipals.set(`${owner}\0${app.appName.toLowerCase()}`, `oauth:${owner}:${access.id}`)
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
    const selectedRole = session.role
      ? await roleService.resolveEffective({ personalSpace }, SYSTEM_PRINCIPAL, session.role)
      : null
    await metaDb.sessions.insert({
      id: agentSessionId(session.ref),
      owner,
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
      roleContextProjectId: null,
    })
    agentSessions++
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
  const ownerKey = `user:${primary.username}`

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

    for (const e of spaceEvents) {
      clock = new Date(normDate(e.date))
      const declaredSession = e.agentAudit?.sessionRef
        ? sessionByRef.get(e.agentAudit.sessionRef)
        : undefined

      if (e.agentAudit?.sessionRef && !declaredSession) {
        throw new Error(`agent write references unknown session: ${e.agentAudit.sessionRef}`)
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
            owner: auditOwner,
            agent: e.agentAudit?.agent ?? null,
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
          principal: remapPrincipal(e.principal),
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
            principal: remapPrincipal(e.principal),
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
            principal: remapPrincipal(e.principal),
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
            principal: remapPrincipal(e.principal),
          })
          await store.settle?.()
          if (res.versionToken) {
            prev.versionToken = res.versionToken
          }
          restores++
        }
      }
    }
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
        principal: remapPrincipal(declaration.principal) ?? null,
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
        owner,
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

  // 5. Context sets (#209): named cross-space collections attached to scopes. Applied
  //    AFTER the timeline so each item's LOGICAL note id resolves to its real id + space
  //    via `live`. Real-stand only (the fake fixture has no stable note ids to reference).
  let contextSets = 0
  // Set NAME → its minted id (#210): the order seed (5d) references sets by name (ids are
  // minted here). Seed set names are unique per case, so a flat name map suffices.
  const setIdByName = new Map<string, string>()

  for (const set of world.contextSets ?? []) {
    const homeSpace = idOf.get(set.homeSpace)

    if (!homeSpace) {
      throw new Error(`context set references unknown home space: ${set.homeSpace}`)
    }
    const items = set.items.flatMap((logicalId) => {
      const note = live.get(logicalId)

      if (!note) {
        return []
      }
      const space = idOf.get(note.spaceSlug)
      return space ? [{ space, noteId: note.id }] : []
    })
    const setId = freshNoteId()
    setIdByName.set(set.name, setId)
    await metaDb.contextSets.createSet({
      id: setId,
      homeSpace,
      name: set.name,
      items,
      createdAt: t,
    })
    contextSets++
    for (const a of set.attach ?? []) {
      const target = await resolveContextTarget(a)

      if (target) {
        await metaDb.contextSets.attach({ setId, ...target, createdAt: t })
      }
    }
  }

  // 5b. Loose cross-space pins (#209): individual notes pinned into a scope from another
  //     space — the sibling of a set. Same logical→real resolution via `live`/`idOf`.
  let scopePins = 0

  for (const pin of world.scopePins ?? []) {
    const note = live.get(pin.note)

    if (!note) {
      continue
    }
    const noteSpace = idOf.get(note.spaceSlug)

    if (!noteSpace) {
      continue
    }
    const target = await resolveContextTarget(pin.attach)

    if (target) {
      await metaDb.scopePins.addPin({
        ...target,
        noteSpace,
        noteId: note.id,
        createdAt: t,
      })
      scopePins++
    }
  }

  // 5b-order. Context order (#210): the user's per-scope pin+set order (order = load
  //     priority). Resolved AFTER sets/pins exist — a `pin` entry maps its logical note id
  //     to the real id; a `set` entry maps its name to the id minted in 5. The scope target
  //     resolves exactly like a set attachment (personal → space id, project → project id).
  let contextOrders = 0

  for (const ord of world.contextOrder ?? []) {
    const target = await resolveContextTarget(ord.scope)

    if (!target) {
      continue
    }
    const entries: Array<{ entryKind: 'pin' | 'set'; entryRef: string }> = []

    for (const e of ord.entries) {
      if (e.kind === 'set') {
        const setId = setIdByName.get(e.name)

        if (setId) {
          entries.push({ entryKind: 'set', entryRef: setId })
        }
      } else {
        const note = live.get(e.note)

        if (note) {
          entries.push({ entryKind: 'pin', entryRef: note.id })
        }
      }
    }
    if (entries.length === 0) {
      continue
    }
    await metaDb.contextOrder.setOrder(
      target.targetKind,
      target.targetId,
      target.targetSpace,
      entries,
    )
    contextOrders++
  }

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
        remapPrincipal(r.principal) ??
        r.principal)
      : (remapPrincipal(r.principal) ?? r.principal)
    await metaDb.retrievalLog.append({
      owner,
      principal,
      agent: r.agent ?? null,
      sessionId: r.sessionRef ? agentSessionId(r.sessionRef) : null,
      sessionName: declaredSession?.name ?? null,
      sessionAttach: r.sessionRef ? (r.sessionAttach ?? 'declared') : null,
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
    const principal = j.owner ? `user:${asUser(j.owner)}` : ownerKey
    const rec = await metaDb.jobs.enqueue({
      id: freshNoteId(),
      space: spaceId,
      kind: JOB_KIND_EXPORT,
      principal: remapPrincipal(principal) ?? principal,
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
          agentRoles: appliedRoles.length,
          agentSkills: appliedSkills.length,
          agentAbilityPreferences,
          agentDeltaCursors,
          favorites,
          retrievals,
          jobs,
          durableImports,
          externalRewrites,
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
