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
} from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'
import {
  ARTIFACT_TTL_MS,
  createExportHandler,
  createFsArtifactStore,
  createFsImportStagingStore,
  createMarkerStore,
  createMetaDb,
  dataPathsFromEnv,
  ensureFolderIdentity,
  hashPassword,
  healSpaceMarker,
  JOB_KIND_EXPORT,
  markFolderAsProject,
  mintOAuthAccessToken,
  mintOAuthRefreshToken,
  sha256,
  SpaceManager,
  type SpaceRecord,
} from '@notarium/server'

import { buildCasesWorld, listCases } from '../test/cases'
import type { CaseWorld, UserDecl } from '../test/cases'
import { normDate } from '../test/cases/generators'
import { seedDurableImports } from './seedDurableImports'
import { applySeedExternalRewrites } from './seedExternalRewrites'
import { makeOwnerRemap } from './seedOwner'

const PROFILE_MOUNT = '.notarium/profile'

/** The default notarium mount set — mirrors apps/server/server.ts defaultMounts
 *  (a tiny, stable copy so the dev seeder needs no server-internal import). */
const defaultMounts = (notesDir: string): MountConfig[] => [
  { class: 'user-doc', dir: notesDir, prefix: '' },
  { class: 'agent-memory', dir: join(notesDir, AGENT_MEMORY_MOUNT), prefix: AGENT_MEMORY_MOUNT },
  { class: 'profile', dir: join(notesDir, PROFILE_MOUNT), prefix: PROFILE_MOUNT },
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
  console.log(`seed: spacesRoot=${spacesRoot} metaDb=${metaDbUrl}`)

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

  for (const s of world.spaces) {
    const rec = await manager.create({ slug: s.slug, displayName: s.displayName || s.slug })
    idOf.set(s.slug, rec.id)
  }

  // 2. Mark declared (non-root) projects — writes the .notariummeta marker so the
  //    project survives the server's boot scan (scanProjectsAtBoot rebuilds from
  //    markers), plus the registry row.
  for (const p of world.projects ?? []) {
    if (!p.path) {
      continue
    }
    const space = idOf.get(p.space)

    if (!space) {
      throw new Error(`project references unknown space: ${p.space}`)
    }
    await markFolderAsProject(
      { projects: metaDb.projects, folders: metaDb.folders, markerStore, now: () => new Date() },
      { space, folderPath: p.path, displayName: p.displayName || p.slug || p.path },
    )
  }

  // 3. Auth (#10): the case's users, else a default owner. The first user is the
  //    reported login; ensure it owns every seeded space so the stand is browsable.
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
  // The primary owner must reach every seeded space (a case with no membership decl
  // for a space, or none at all).
  for (const [slug, id] of idOf) {
    if (!members.some((m) => m.space === slug && m.username === primary.username)) {
      await metaDb.auth.upsertMember(id, primary.username, 'owner', t)
    }
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
      if (e.op === 'create') {
        const route = routeOf(e.path, e.class)
        const res = await store.write({
          title: e.title,
          content: e.content,
          directory: route.directory,
          fileName: route.fileName,
          // `pin` makes a note an always-load CONTEXT pin (the #165 tag the pult reads via
          // weighAlwaysLoad) AND a #42 favorite (below) — the two senses the decl documents.
          // Without the tag a seeded stand's pult showed ZERO local pins (only sets/scope-pins).
          tags: e.pin ? [...(e.tags ?? []), 'always-load'] : e.tags,
          noteType: e.noteType,
          targetClass: route.targetClass,
          summary: e.summary,
          muted: e.muted,
          createdAt: normDate(e.date),
          principal: remapPrincipal(e.principal),
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
          filePath: e.path,
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
          const res = await store.write({
            title: e.title ?? prev.title,
            content: e.content,
            tags: e.tags,
            originalId: prev.id,
            versionToken: prev.versionToken,
            principal: remapPrincipal(e.principal),
          })
          await store.settle?.()
          if (!res.versionToken) {
            throw new Error(`edit returned no token for note ${e.noteId}`)
          }
          prev.versionToken = res.versionToken
          if (e.title) {
            prev.title = e.title
          }
          edits++
        } else if (e.op === 'delete') {
          await store.remove(prev.id, { principal: remapPrincipal(e.principal) })
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
      if (a.kind === 'personal') {
        const personalSlug = personalSpaceOf.get(asUser(a.user))
        const targetId = personalSlug ? idOf.get(personalSlug) : undefined

        if (targetId) {
          await metaDb.contextSets.attach({
            setId,
            targetKind: 'personal',
            targetId,
            targetSpace: targetId,
            createdAt: t,
          })
        }
      } else {
        const spaceId = idOf.get(a.space)

        if (!spaceId) {
          continue
        }
        const proj = (await metaDb.projects.listForSpace(spaceId)).find((pr) => pr.path === a.path)

        if (proj) {
          await metaDb.contextSets.attach({
            setId,
            targetKind: 'project',
            targetId: proj.id,
            targetSpace: spaceId,
            createdAt: t,
          })
        }
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
    const a = pin.attach

    if (a.kind === 'personal') {
      const personalSlug = personalSpaceOf.get(asUser(a.user))
      const targetId = personalSlug ? idOf.get(personalSlug) : undefined

      if (targetId) {
        await metaDb.scopePins.addPin({
          targetKind: 'personal',
          targetId,
          targetSpace: targetId,
          noteSpace,
          noteId: note.id,
          createdAt: t,
        })
        scopePins++
      }
    } else {
      const spaceId = idOf.get(a.space)

      if (!spaceId) {
        continue
      }
      const proj = (await metaDb.projects.listForSpace(spaceId)).find((pr) => pr.path === a.path)

      if (proj) {
        await metaDb.scopePins.addPin({
          targetKind: 'project',
          targetId: proj.id,
          targetSpace: spaceId,
          noteSpace,
          noteId: note.id,
          createdAt: t,
        })
        scopePins++
      }
    }
  }

  // 5b-order. Context order (#210): the user's per-scope pin+set order (order = load
  //     priority). Resolved AFTER sets/pins exist — a `pin` entry maps its logical note id
  //     to the real id; a `set` entry maps its name to the id minted in 5. The scope target
  //     resolves exactly like a set attachment (personal → space id, project → project id).
  let contextOrders = 0

  for (const ord of world.contextOrder ?? []) {
    const scope = ord.scope
    let targetId: string | undefined
    let targetSpace: string | undefined

    if (scope.kind === 'personal') {
      const personalSlug = personalSpaceOf.get(asUser(scope.user))
      targetId = personalSlug ? idOf.get(personalSlug) : undefined
      targetSpace = targetId
    } else {
      const spaceId = idOf.get(scope.space)
      const proj = spaceId
        ? (await metaDb.projects.listForSpace(spaceId)).find((pr) => pr.path === scope.path)
        : undefined
      targetId = proj?.id
      targetSpace = spaceId
    }
    if (!targetId || !targetSpace) {
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
    await metaDb.contextOrder.setOrder(scope.kind, targetId, targetSpace, entries)
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
  //     backdated retrieval-log rows so the /agents Audit surface has real history +
  //     blind spots. Runs AFTER the replay so every hit's note id resolves via `live`.
  //     A retrieval with no resolvable hits is a zero-result MISS. Owner = the seed user
  //     (so /api/me/agent-audit shows it); principal remapped like every attribution.
  let retrievals = 0

  for (const r of world.retrievals ?? []) {
    const owner = r.owner ? asUser(r.owner) : primary.username
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
  const externalRewrites = await applySeedExternalRewrites(
    (world.externalRewrites ?? []).map((rewrite) => {
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
