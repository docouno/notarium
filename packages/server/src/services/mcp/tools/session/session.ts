// start_session: the agent bootstrap bundle — profile/always-load, per-project index + delta, known-values vocabulary.
// canon: docs/mcp-gateway.md#tools · docs/projects.md#init-context-curation
import { type RoleSummary } from '@notarium/contract'
import {
  type AgentSession,
  type DeltaEntry,
  type FolderEntry,
  type RecentAgentSession,
  type StartSessionInput,
  type UseRoleOutput,
} from '@notarium/contract/tools'
import { buildMemoryIndex, isPathUnder, READ_SCOPE, treeChildren } from '@notarium/core'

import { AGENT_SESSION_IDLE_MS } from '../../../agentSessions'
import { type ProjectRecord } from '../../../metaDb'
import { type SpaceStore } from '../../../spaces'
import { type Ctx, type Handler, ToolFailure, toolsHelpFor } from '../../gateway'
import { handleOf, notePath, projectLabelForNote } from '../../helpers/projectAddressing'
import { renderSession } from '../../helpers/render'
import { curateRoleSummaries } from '../../helpers/roleSummaries'
import { sanitizeText } from '../../sanitize'
import { activateRole, assertRoleAvailable, roleContext, startSessionRoleSelector } from '../roles'
import { curateAgentContext } from './agentContext'

// ── start_session / dedup tuning ────────────────────────────────

/** Delta entries carried before truncating with a pointer to search. */
const DELTA_LIMIT = 20
/** Top-level folders carried in start_session's compact index. */
const INDEX_FOLDERS_LIMIT = 50

/** Known-values caps: the start_session vocabulary, kept compact. */
const KNOWN_CATEGORIES_LIMIT = 50
const KNOWN_TAGS_LIMIT = 50
/** Compact first-page discovery budget; list_roles paginates the continuation. */
const ROLE_SUMMARIES_TOKEN_BUDGET = 1_000

/** Session names are agent-supplied labels, so normalise control characters and
 * defang prompt-control pseudo-tags before storage and every wire projection. */
const safeSessionName = (name: string): string =>
  sanitizeText(name)
    // eslint-disable-next-line no-control-regex -- labels cannot carry line/control boundaries
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 160) || 'session'

/** The per-project sub-bundle (project hint only): a capped subtree index + the
 *  delta (journal) since the bound episode or unbound owner last looked;
 *  `acknowledge:false` peeks without moving the cursor.
 *  canon: docs/note-history.md#model
 *
 *  The delta CURSOR is keyed by the stable PROJECT id, not the space slug: sibling
 *  projects share a space, so a space-keyed cursor would let acking project A empty
 *  project B's delta. The delta CONTENT stays the space-wide revision stream (the
 *  journal isn't path-indexed) — each project tracks its own position over it. */
const buildProjectBundle = async (
  ctx: Ctx,
  hinted: ProjectRecord,
  acknowledge: boolean,
): Promise<{
  index: { noteCount: number; folders: FolderEntry[] }
  delta: { changes: DeltaEntry[]; total: number; truncated?: boolean }
  knownValues: { categories: string[]; tags: string[] }
  /** The folder list hit INDEX_FOLDERS_LIMIT; folded into the top-level `truncated`. */
  indexTruncated: boolean
}> => {
  const store = await ctx.spaces.store(hinted.space)
  const personal = await ctx.personalSpace()
  // Seam: hinted.space is the opaque id (store/projectsInSpace/compare on it);
  // the wire `space` label and the project labeller take the slug.
  const hintedSlug = ctx.spaces.slugOf(hinted.space) ?? hinted.space
  const projectsHere = await ctx.projectsInSpace(hinted.space)
  // Full-space note list: the index source AND the id→filePath map the delta
  // labelling needs (delta CONTENT is space-wide — a changed note can live outside
  // this project's subtree).
  const allInSpace = (await store.list({ scope: READ_SCOPE.user })).filter((m) => m.id != null)
  const fileById = new Map<string, string>()

  for (const m of allInSpace) {
    fileById.set(m.id as string, m.filePath)
  }
  // The project's own subtree (root project, path '' → the whole space).
  const visible = hinted.path
    ? allInSpace.filter((m) => isPathUnder(m.filePath, hinted.path))
    : allInSpace
  // The compact index: note COUNT + the project root's direct subfolders (with
  // subtree counts). The folder skeleton unions note-derived dirs with the directory
  // channel so empty folders show too.
  const dirs = store.listDirs ? await store.listDirs() : []
  const childFolders = treeChildren(allInSpace, dirs, {
    path: hinted.path,
    offset: 0,
    limit: 0,
  }).folders
  const folders: FolderEntry[] = childFolders
    .slice(0, INDEX_FOLDERS_LIMIT)
    .map((f) => ({ path: f.path, name: sanitizeText(f.name), count: f.count }))
  const index = { noteCount: visible.length, folders }

  const indexTruncated = childFolders.length > INDEX_FOLDERS_LIMIT

  // Journal-backed; a bare engine without it degrades to an empty delta (P5).
  const cursorKey = hinted.id
  const cursorScope = ctx.sessionOwner
    ? {
        owner: ctx.sessionOwner,
        ...(ctx.session
          ? {
              session: {
                id: ctx.session.record.id,
                parentId: ctx.session.record.parentId,
              },
            }
          : {}),
      }
    : null
  // A peek still materialises a session cursor. Without that frozen NULL/value,
  // another episode could advance the fallback between two peeks and consume the
  // change this session has not acknowledged.
  const cursor =
    ctx.agentDeltaCursors && cursorScope
      ? await ctx.agentDeltaCursors.getOrInit(cursorScope, cursorKey, ctx.now().toISOString())
      : null
  let changes: DeltaEntry[] = []
  let total = 0
  let truncated = false
  let maxRevId: string | null = null

  if (store.revisionsSince) {
    const res = await store.revisionsSince(cursor, DELTA_LIMIT)
    total = res.total
    maxRevId = res.maxRevId
    truncated = res.total > res.items.length
    // revisionsSince already excludes agent-memory, so the user-doc nearest-ancestor
    // labeller applies (the `undefined` cls passed below).
    changes = res.items.map((r) => {
      const filePath = fileById.get(r.noteId)
      const projectHandle = filePath
        ? projectLabelForNote(hintedSlug, filePath, undefined, projectsHere)
        : undefined
      const path = notePath(filePath)
      return {
        noteId: r.noteId,
        title: sanitizeText(r.title),
        kind: r.kind,
        principal: r.principal,
        ...(hinted.space === personal ? {} : { space: hintedSlug }),
        ...(projectHandle ? { project: projectHandle } : {}),
        ...(path ? { path } : {}),
        modifiedAt: r.createdAt,
      }
    })
  }
  // Advance the cursor over the WHOLE window (past the truncated cut): the acked
  // cursor is the high-water mark, not just what fit.
  if (acknowledge && maxRevId && ctx.agentDeltaCursors && cursorScope) {
    await ctx.agentDeltaCursors.advance(cursorScope, cursorKey, maxRevId, ctx.now().toISOString())
  }
  const knownValues = await buildKnownValues(store, hinted, visible)
  return {
    index,
    delta: { changes, total, ...(truncated ? { truncated: true } : {}) },
    knownValues,
    indexTruncated,
  }
}

/** Dedup + cap + trim a list of vocabulary values, preserving first-seen order. */
const dedupCap = (values: Array<string | undefined | null>, cap: number): string[] => {
  const seen = new Set<string>()
  const out: string[] = []

  for (const v of values) {
    const t = v?.trim()

    if (!t || seen.has(t)) {
      continue
    }
    seen.add(t)
    out.push(t)
    if (out.length >= cap) {
      break
    }
  }

  return out
}

/** The category/tag vocabulary already in use in a project, so an agent reuses terms
 *  instead of coining synonyms; each channel degrades to [] on a bare engine.
 */
const buildKnownValues = async (
  store: SpaceStore,
  hinted: ProjectRecord,
  visible: readonly { id?: string; tags?: string[] }[],
): Promise<{ categories: string[]; tags: string[] }> => {
  let categories: string[] = []

  try {
    const idx = await buildMemoryIndex(store, { subdir: hinted.id })
    // `muted` categories are hidden from the agent EVERYWHERE eager — the vocabulary
    // hint included, not just recall.
    categories = dedupCap(
      idx.filter((m) => !m.muted).map((m) => m.category),
      KNOWN_CATEGORIES_LIMIT,
    )
  } catch {
    categories = []
  }
  const tags = dedupCap(
    visible.flatMap((m) => m.tags ?? []),
    KNOWN_TAGS_LIMIT,
  )
  return {
    categories: categories.map(sanitizeText),
    tags: tags.map(sanitizeText),
  }
}

export const handleStartSession: Handler = async (ctx, rawArgs) => {
  const {
    project,
    role,
    name,
    session: sessionRequest,
    acknowledge,
    responseFormat,
  } = rawArgs as StartSessionInput
  const selectedRole = startSessionRoleSelector({ role, name })
  // A project hint is a handle: resolve collapses existence + reachability into one
  // 404-semantic error (anti-enumeration).
  const hinted = project !== undefined ? await ctx.resolveProject(project) : undefined
  const effectiveRoleContext = await roleContext(ctx, hinted)
  const effectiveRoleListing = ctx.roles
    ? await ctx.roles.listEffective(effectiveRoleContext)
    : { roles: [], truncated: false }
  const effectiveRoles = effectiveRoleListing.roles
  const selectedRolePackage = selectedRole
    ? await ctx.roles?.loadEffective(effectiveRoleContext, selectedRole, 4_000)
    : undefined

  if (selectedRole) {
    if (!ctx.roles) {
      throw new ToolFailure('roles are unavailable on this host')
    }
    // Reject unavailable/catalog-only selectors before opening or touching a
    // durable session: an invalid bootstrap request must have no session side effect.
    if (!selectedRolePackage) {
      assertRoleAvailable(effectiveRoles, selectedRole, effectiveRoleListing.truncated)
      throw new ToolFailure(`role "${selectedRole}" is not available in this scope`)
    }
  }
  const now = ctx.now()
  const opened =
    ctx.agentSessions && ctx.sessionOwner
      ? await ctx.agentSessions.start(
          ctx.sessionOwner,
          sessionRequest?.id
            ? { id: sessionRequest.id }
            : sessionRequest?.name
              ? { name: safeSessionName(sessionRequest.name) }
              : undefined,
          `${hinted ? handleOf(hinted, ctx.spaces.slugOf(hinted.space) ?? hinted.space) : 'personal'} · ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
        )
      : undefined
  ctx.session = opened?.session
  // A resumed episode must rehydrate its saved prompt after client/model context
  // loss. Explicit same-role selection and implicit resume both include the body.
  const savedRole = opened?.session?.record.role
  const roleToHydrate = selectedRole ?? savedRole
  const rolePackageToHydrate = selectedRolePackage
    ? selectedRolePackage
    : roleToHydrate && ctx.roles
      ? await ctx.roles.loadEffective(effectiveRoleContext, roleToHydrate, 4_000)
      : null
  const projects = await ctx.readableProjects()
  const {
    profile,
    projectAlwaysLoad,
    roleContext: activeRoleContext,
    truncated: curationTruncated,
  } = await curateAgentContext(ctx, hinted, rolePackageToHydrate)
  const bundle = hinted ? await buildProjectBundle(ctx, hinted, acknowledge) : undefined
  const curatedRoles = curateRoleSummaries(effectiveRoles, ROLE_SUMMARIES_TOKEN_BUDGET)
  const roles: RoleSummary[] = curatedRoles.roles
  const activeRole: UseRoleOutput | undefined =
    roleToHydrate && rolePackageToHydrate
      ? await activateRole(
          ctx,
          effectiveRoleContext,
          roleToHydrate,
          4_000,
          rolePackageToHydrate,
          effectiveRoleListing,
          activeRoleContext,
        )
      : undefined
  // Fold bundle-internal `indexTruncated` into the top-level signal, then drop it.
  const truncated = curationTruncated || Boolean(bundle?.indexTruncated)

  const session: AgentSession | undefined = opened?.session
    ? {
        id: opened.session.record.id,
        name: safeSessionName(opened.session.record.name),
        named: opened.session.record.named,
        state: opened.session.state,
        ...(opened.session.record.parentId ? { parentId: opened.session.record.parentId } : {}),
        hint: `Keep this session id and pass session: "${opened.session.record.id}" on every subsequent tool call.`,
      }
    : undefined
  const recentSessions: RecentAgentSession[] | undefined = opened?.recentSessions?.map(
    (record) => ({
      id: record.id,
      name: safeSessionName(record.name),
      lastActiveAt: record.lastSeenAt,
      active: record.lastSeenAt >= new Date(now.getTime() - AGENT_SESSION_IDLE_MS).toISOString(),
      calls: record.calls,
    }),
  )
  const structured = {
    ...(session ? { session } : {}),
    ...(recentSessions ? { recentSessions } : {}),
    profile,
    roles,
    ...(curatedRoles.truncated || effectiveRoleListing.truncated ? { rolesTruncated: true } : {}),
    ...(activeRole ? { activeRole } : {}),
    projects: projects.map((p) => ({ ...p, displayName: sanitizeText(p.displayName) })),
    ...(bundle
      ? {
          project: {
            index: bundle.index,
            alwaysLoad: projectAlwaysLoad ?? [],
            delta: bundle.delta,
            knownValues: bundle.knownValues,
          },
        }
      : {}),
    toolsHelp: toolsHelpFor(ctx.principal),
    ...(truncated ? { truncated: true } : {}),
  }
  const markdown = renderSession(
    structured,
    hinted ? handleOf(hinted, ctx.spaces.slugOf(hinted.space) ?? hinted.space) : undefined,
    responseFormat,
  )
  return { markdown, structured }
}
