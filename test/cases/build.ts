import { compareEvents } from './generators'
import { getCase } from './registry'
import { makeRng } from './rng'
import type {
  AgentAbilityPreferenceDecl,
  AgentDeltaCursorDecl,
  AgentRoleDecl,
  AgentSessionDecl,
  AgentSkillDecl,
  CaseEvent,
  CaseWorld,
  ConnectedAppDecl,
  ContextOrderDecl,
  ContextSetDecl,
  DurableImportDecl,
  ExternalIdentityClaimDecl,
  ExternalRewriteDecl,
  FavoriteDecl,
  JobDecl,
  MemberDecl,
  PendingOAuthClientDecl,
  ProjectDecl,
  RetrievalDecl,
  RevisionStateDecl,
  ScopePinDecl,
  SpaceDecl,
  UserDecl,
} from './types'

/** The catalog's fixed determinism anchor — the case's "today" when the caller
 *  doesn't override it. A stable instant so a fake/visual re-seed is
 *  byte-reproducible and the heatmap window doesn't drift with the wall clock.
 *  The REAL applier overrides it with the actual current date so a freshly seeded
 *  stand shows activity right up to today. */
export const DEFAULT_NOW = '2026-07-01T12:00:00.000Z'

export type BuildOptions = {
  /** RNG seed → reproducible generated worlds (the CLI's `SEED`). */
  seed?: string
  /** Multiplies generated volume (the CLI's `SCALE`). */
  scale?: number
  /** The determinism anchor / "today"; defaults to DEFAULT_NOW. */
  now?: string
  /** Content locale for the cases that author per-language copy (the demo case,
   *  #256); ignored by every other case. */
  locale?: string
}

const validateAgentDeltaCursorAnchors = (world: CaseWorld): CaseWorld => {
  const noteSpaces = new Map(
    world.events
      .filter((event): event is Extract<CaseEvent, { op: 'create' }> => event.op === 'create')
      .map((event) => [event.noteId, event.space]),
  )

  for (const cursor of world.agentDeltaCursors ?? []) {
    const noteSpace = noteSpaces.get(cursor.throughNote)

    if (noteSpace && noteSpace !== cursor.project.space) {
      throw new Error(
        `agent delta cursor anchor ${cursor.throughNote} belongs to space ${noteSpace}, ` +
          `not project space ${cursor.project.space}`,
      )
    }
  }
  for (const revision of world.revisionStates ?? []) {
    if (!noteSpaces.has(revision.note)) {
      throw new Error(`revision state references unknown note ${revision.note}`)
    }
  }

  return world
}

/** Resolve a case name + options into its CaseWorld — the ONE builder both
 *  appliers call, so the fake and the real stand get the identical world for a
 *  given (name, seed, scale, now). */
export const buildCaseWorld = (name: string, opts: BuildOptions = {}): CaseWorld => {
  const spec = getCase(name)
  const rng = makeRng(`${name}:${opts.seed ?? 'default'}`)
  const now = new Date(opts.now ?? DEFAULT_NOW)

  if (Number.isNaN(now.getTime())) {
    throw new Error(`invalid now: "${opts.now}"`)
  }

  return validateAgentDeltaCursorAnchors(
    spec.build({ rng, scale: opts.scale ?? 1, now, locale: opts.locale }),
  )
}

/** Build ONE OR MANY cases: a comma-separated `spec` combines several catalog
 *  cases into a single stand (`feed-scroll,trash-mixed,multi-space`). Cases keep
 *  their own worlds; on overlap they COMPOSE — spaces merge by slug, users/
 *  projects/members dedup, and per-case logical note-ids + colliding paths are
 *  disambiguated so nothing silently overwrites. One case = the single world
 *  unchanged. Both appliers consume the merged world with no special-casing. */
export const buildCasesWorld = (spec: string, opts: BuildOptions = {}): CaseWorld => {
  const names = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (names.length === 0) {
    throw new Error('no case named')
  }
  if (names.length === 1) {
    return buildCaseWorld(names[0], opts)
  }

  return mergeWorlds(names.map((name) => ({ name, world: buildCaseWorld(name, opts) })))
}

const suffixName = (path: string, n: number): string =>
  path.replace(/(\.md)?$/, (ext) => `-${n}${ext}`)

/** Compose several cases' worlds into one. Deterministic — no wall-clock, no RNG
 *  (each world was already built). */
export const mergeWorlds = (parts: Array<{ name: string; world: CaseWorld }>): CaseWorld => {
  const spaces = new Map<string, SpaceDecl>()
  const projects = new Map<string, ProjectDecl>()
  const contextSets: ContextSetDecl[] = []
  const scopePins: ScopePinDecl[] = []
  const contextOrder: ContextOrderDecl[] = []
  const users = new Map<string, UserDecl>()
  const members = new Map<string, MemberDecl>()
  const connectedApps = new Map<string, ConnectedAppDecl>()
  const pendingOAuthClients = new Map<string, PendingOAuthClientDecl>()
  const favorites = new Map<string, FavoriteDecl>()
  const retrievals: RetrievalDecl[] = []
  const agentSessions: AgentSessionDecl[] = []
  const agentRoles = new Map<string, AgentRoleDecl>()
  const agentSkills = new Map<string, AgentSkillDecl>()
  const agentAbilityPreferences = new Map<string, AgentAbilityPreferenceDecl>()
  const agentDeltaCursors: AgentDeltaCursorDecl[] = []
  const jobs: JobDecl[] = []
  const durableImports: DurableImportDecl[] = []
  const externalRewrites: ExternalRewriteDecl[] = []
  const revisionStates: RevisionStateDecl[] = []
  const externalIdentityClaims: ExternalIdentityClaimDecl[] = []
  const events: CaseEvent[] = []
  const takenPaths = new Set<string>()
  const currentPathByNote = new Map<string, string>()
  let hasAuth = false

  for (const { name, world } of parts) {
    for (const s of world.spaces) {
      const prev = spaces.get(s.slug)

      // First declaration wins the identity, but merge flags a later same-slug case
      // sets (archived / personalFor / displayName) so combining doesn't silently drop
      // e.g. an archived marker or a personal-domain pointer.
      if (!prev) {
        spaces.set(s.slug, s)
      } else {
        const aliases = [...new Set([...(prev.aliases ?? []), ...(s.aliases ?? [])])]
        spaces.set(s.slug, {
          ...prev,
          archived: prev.archived || s.archived,
          personalFor: prev.personalFor ?? s.personalFor,
          displayName: prev.displayName ?? s.displayName,
          ...(aliases.length ? { aliases } : {}),
        })
      }
    }
    for (const p of world.projects ?? []) {
      const key = `${p.space}\0${p.path}`

      if (!projects.has(key)) {
        projects.set(key, p)
      }
    }
    // Namespace the set's item note-ids to match the namespaced events (spaces/users
    // aren't namespaced, so homeSpace/attach references pass through unchanged).
    for (const set of world.contextSets ?? []) {
      contextSets.push({ ...set, items: set.items.map((id) => `${name}:${id}`) })
    }
    // A scope pin's note id is namespaced the same way (its attach targets are spaces/
    // users/paths, which pass through unchanged).
    for (const pin of world.scopePins ?? []) {
      scopePins.push({ ...pin, note: `${name}:${pin.note}` })
    }
    // A scope order (#210): a `pin` entry's note is a logical id (namespace it); a `set`
    // entry references a set by NAME (like homeSpace, passes through). The scope attach
    // targets (spaces/users/paths) pass through too.
    for (const ord of world.contextOrder ?? []) {
      contextOrder.push({
        ...ord,
        entries: ord.entries.map((e) =>
          e.kind === 'pin' ? { kind: 'pin', note: `${name}:${e.note}` } : e,
        ),
      })
    }
    if (world.auth) {
      hasAuth = true
      for (const u of world.auth.users) {
        const prev = users.get(u.username)

        // First declaration wins, but fill in a personalSpace / admin a later case sets.
        if (!prev) {
          users.set(u.username, u)
        } else {
          users.set(u.username, {
            ...prev,
            admin: prev.admin || u.admin,
            personalSpace: prev.personalSpace ?? u.personalSpace,
          })
        }
      }
      for (const m of world.auth.members) {
        const key = `${m.space}\0${m.username}`

        if (!members.has(key)) {
          members.set(key, m)
        }
      }
      for (const app of world.auth.connectedApps ?? []) {
        const key = `${app.owner ?? ''}\0${app.appName}`

        if (!connectedApps.has(key)) {
          connectedApps.set(key, app)
        }
      }
      for (const client of world.auth.pendingOAuthClients ?? []) {
        const key = client.clientId ?? `${client.kind}\0${client.clientName}`

        if (!pendingOAuthClients.has(key)) {
          pendingOAuthClients.set(key, client)
        }
      }
    }
    for (const e of world.events) {
      const noteId = `${name}:${e.noteId}` // namespace so two cases' n-1 never clash
      const agentAudit = e.agentAudit?.sessionRef
        ? { ...e.agentAudit, sessionRef: `${name}:${e.agentAudit.sessionRef}` }
        : e.agentAudit

      if (e.op === 'create') {
        let path = e.path

        for (let n = 2; takenPaths.has(`${e.space}\0${path}`); n++) {
          path = suffixName(e.path, n)
        }
        takenPaths.add(`${e.space}\0${path}`)
        currentPathByNote.set(`${e.space}\0${noteId}`, path)
        events.push({ ...e, noteId, path, ...(agentAudit ? { agentAudit } : {}) })
      } else if (e.op === 'edit' && e.path) {
        const noteKey = `${e.space}\0${noteId}`
        const previousPath = currentPathByNote.get(noteKey)

        if (previousPath) {
          takenPaths.delete(`${e.space}\0${previousPath}`)
        }
        let path = e.path

        for (let n = 2; takenPaths.has(`${e.space}\0${path}`); n++) {
          path = suffixName(e.path, n)
        }
        takenPaths.add(`${e.space}\0${path}`)
        currentPathByNote.set(noteKey, path)
        events.push({ ...e, noteId, path, ...(agentAudit ? { agentAudit } : {}) })
      } else {
        events.push({ ...e, noteId, ...(agentAudit ? { agentAudit } : {}) })
      }
    }
    // Favorites (#42/#245): a NOTE ref is a logical id — namespace it exactly like the
    // events above so it still resolves after the merge; a folder/project ref is a
    // space-relative PATH, which merge keeps stable (only colliding note FILE basenames
    // are suffixed, never folder paths / project paths), so it passes through. Dedup by
    // (space, kind, ref) — two cases starring the same folder/project is idempotent.
    for (const f of world.favorites ?? []) {
      const ref = f.kind === 'note' ? `${name}:${f.ref}` : f.ref
      const key = `${f.space}\0${f.kind}\0${ref}`

      if (!favorites.has(key)) {
        favorites.set(key, { ...f, ref })
      }
    }
    // Retrieval hits reference notes by logical id — namespace them the same way so a
    // combined case's audit rows resolve to the right notes (#243).
    for (const r of world.retrievals ?? []) {
      retrievals.push({
        ...r,
        ...(r.sessionRef ? { sessionRef: `${name}:${r.sessionRef}` } : {}),
        hits: r.hits?.map((h) => ({ ...h, note: `${name}:${h.note}` })),
      })
    }
    // Session and parent refs are logical ids too: namespace both so independent
    // cases can use friendly names such as `active` without colliding.
    for (const session of world.agentSessions ?? []) {
      agentSessions.push({
        ...session,
        ref: `${name}:${session.ref}`,
        ...(session.parentRef ? { parentRef: `${name}:${session.parentRef}` } : {}),
      })
    }
    for (const role of world.agentRoles ?? []) {
      const target = role.target
      const key =
        target.kind === 'personal'
          ? `personal\0${target.user ?? ''}\0${role.name}`
          : target.kind === 'space'
            ? `space\0${target.space}\0${role.name}`
            : `project\0${target.space}\0${target.path}\0${role.name}`

      if (!agentRoles.has(key)) {
        agentRoles.set(key, role)
      }
    }
    // A skill declaration carries no logical note handle either: it addresses a HOME
    // (personal/space) and names roles by the name in the case file, which merge keeps
    // stable — so, exactly like roles above, the decls pass through unchanged and dedup
    // by placement + name, first wins. Declaration ORDER survives inside each case, so
    // a `role-dependency` skill still follows the role that installed it, and a
    // `renameTo`/`linkedRole`/`deleted` operation still applies to its own package.
    for (const skill of world.agentSkills ?? []) {
      const home = skill.home
      const key =
        home.kind === 'personal'
          ? `personal\0${home.user ?? ''}\0${skill.name}`
          : `space\0${home.space}\0${skill.name}`

      if (!agentSkills.has(key)) {
        agentSkills.set(key, skill)
      }
    }
    // Preferences address abilities, not notes, so nothing here is namespaced; two
    // cases naming the same owner and the same ability are one row, first wins.
    for (const preference of world.agentAbilityPreferences ?? []) {
      const ability = preference.ability
      const placement =
        ability.source === 'system'
          ? 'system'
          : ability.kind === 'role'
            ? JSON.stringify(ability.target)
            : JSON.stringify(ability.home)
      const key = `${preference.user ?? ''}\0${ability.source}\0${ability.kind}\0${ability.name}\0${placement}`

      if (!agentAbilityPreferences.has(key)) {
        agentAbilityPreferences.set(key, preference)
      }
    }
    // Cursor declarations reference both a session and a journalled note by logical
    // id; namespace both exactly like their source declarations.
    for (const cursor of world.agentDeltaCursors ?? []) {
      agentDeltaCursors.push({
        ...cursor,
        ...(cursor.sessionRef ? { sessionRef: `${name}:${cursor.sessionRef}` } : {}),
        throughNote: `${name}:${cursor.throughNote}`,
      })
    }
    // Jobs carry no logical note handles — they address a SPACE, and spaces merge by
    // slug WITHOUT namespacing (see above), so a job's `space` resolves unchanged in a
    // combined world and the decls concatenate verbatim (#105/#101).
    for (const j of world.jobs ?? []) {
      jobs.push(j)
    }
    for (const durableImport of world.durableImports ?? []) {
      durableImports.push(durableImport)
    }
    // External claims and rewrites reference logical note handles, so namespace them
    // exactly like timeline events and retrieval hits.
    for (const claim of world.externalIdentityClaims ?? []) {
      externalIdentityClaims.push({
        note: `${name}:${claim.note}`,
        claimFrom: `${name}:${claim.claimFrom}`,
      })
    }
    for (const rewrite of world.externalRewrites ?? []) {
      externalRewrites.push({ ...rewrite, note: `${name}:${rewrite.note}` })
    }
    // Revision-state declarations depend on their timeline note and preserve
    // declaration order. Namespacing makes independent cases collision-free;
    // WorldBuilder rejects incompatible duplicates inside one case.
    for (const revision of world.revisionStates ?? []) {
      revisionStates.push({ ...revision, note: `${name}:${revision.note}` })
    }
  }

  events.sort(compareEvents)
  return validateAgentDeltaCursorAnchors({
    now: parts[0].world.now,
    spaces: [...spaces.values()],
    projects: projects.size ? [...projects.values()] : undefined,
    contextSets: contextSets.length ? contextSets : undefined,
    scopePins: scopePins.length ? scopePins : undefined,
    contextOrder: contextOrder.length ? contextOrder : undefined,
    auth: hasAuth
      ? {
          users: [...users.values()],
          members: [...members.values()],
          ...(connectedApps.size ? { connectedApps: [...connectedApps.values()] } : {}),
          ...(pendingOAuthClients.size
            ? { pendingOAuthClients: [...pendingOAuthClients.values()] }
            : {}),
        }
      : undefined,
    events,
    favorites: favorites.size ? [...favorites.values()] : undefined,
    ...(retrievals.length ? { retrievals } : {}),
    ...(agentSessions.length ? { agentSessions } : {}),
    ...(agentRoles.size ? { agentRoles: [...agentRoles.values()] } : {}),
    ...(agentSkills.size ? { agentSkills: [...agentSkills.values()] } : {}),
    ...(agentAbilityPreferences.size
      ? { agentAbilityPreferences: [...agentAbilityPreferences.values()] }
      : {}),
    ...(agentDeltaCursors.length ? { agentDeltaCursors } : {}),
    ...(jobs.length ? { jobs } : {}),
    ...(durableImports.length ? { durableImports } : {}),
    ...(externalRewrites.length ? { externalRewrites } : {}),
    ...(revisionStates.length ? { revisionStates } : {}),
    ...(externalIdentityClaims.length ? { externalIdentityClaims } : {}),
  })
}
