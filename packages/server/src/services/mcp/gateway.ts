// The MCP gateway core: transport-agnostic tool dispatch — listTools (tools/list
// scope filter) + callTool (tools/call). All agent-facing policy is enforced here;
// each tool is a thin wrapper over the KnowledgeStore methods REST uses (P4).
// canon: docs/mcp-gateway.md#security · docs/architecture.md#p4

import type { z } from 'zod'
import { PROJECT_STATUS } from '@notarium/contract'
import {
  type ProjectSummary,
  toolActions,
  type ToolHelp,
  type ToolName,
  tools,
} from '@notarium/contract/tools'
import { asciiSlug, STORE_ERROR_REASON } from '@notarium/core'

import { clientFailureOf } from '../../libs/clientFailure'
import type { AbilitiesService } from '../abilities'
import { type AgentSessions, type BoundAgentSession, createAgentSessions } from '../agentSessions'
import type { AuthService } from '../auth'
import { type Action, agentOwnerOf, can, type Principal, scopeAllows } from '../authz'
import type { FieldSchemaStore } from '../fields'
import type {
  AgentDeltaCursorsPersistence,
  AgentSessionsPersistence,
  ContextOrderPersistence,
  ContextSetsPersistence,
  DedupResult,
  FolderIdentityPersistence,
  GatewayStatePersistence,
  ProjectRecord,
  ProjectsPersistence,
  RetrievalLogPersistence,
  ScopePinsPersistence,
} from '../metaDb'
import { type MarkerStore } from '../projects'
import type { ProviderRegistry } from '../providerRegistry'
import type { RolesService } from '../roles'
import { ensurePersonalSpace, peekPersonalSpace, type SpaceManager } from '../spaces'
import { createStoreAccess, type StoreAccess } from '../storeAccess'
import { TOOL_META, type ToolAnnotations } from './descriptions'
import { projectSummaryOf } from './helpers/projectAddressing'
import { retrievalRowOf } from './helpers/retrievalAudit'
import { sanitizeText } from './sanitize'
import {
  handleCreateAbility,
  handleDeleteAbility,
  handleEditAbility,
  handleGetAbility,
  handleListAbilities,
} from './tools/abilities'
import { handleMoveFolder, handleRenameFolder, handleRenameProject } from './tools/containers'
import { handleCreateNote, handleCreateNotes } from './tools/create'
import { handleLink, handleLinkMany } from './tools/links'
import { handleRememberProject, handleRememberUser } from './tools/memory'
import {
  handleDeleteNote,
  handleEditNote,
  handleMoveNote,
  handleRenameNote,
} from './tools/noteLifecycle'
import { handleGetMyProjects, handleWhoami } from './tools/projectsList'
import {
  handleGetNote,
  handleListNotes,
  handleRecall,
  handleRecentActivity,
  handleSearch,
} from './tools/read'
import { handleUseRole, handleUseSkill } from './tools/roles'
import { handleStartSession } from './tools/session'

export type GatewayDeps = {
  spaces: SpaceManager
  auth: AuthService
  roles?: RolesService
  abilities?: AbilitiesService
  providerRegistry?: Pick<ProviderRegistry, 'hasUsableForPrincipal'>
  /** Durable, owner-scoped agent episodes. Absent means the whole session feature
   *  degrades away: start_session emits no session and regular calls ignore it. */
  sessions?: AgentSessionsPersistence
  /** Owner fallback + per-episode/project delta positions. */
  agentDeltaCursors?: AgentDeltaCursorsPersistence
  /** Durable replay state. Absent leaves only simultaneous in-process single-flight. */
  gatewayState?: GatewayStatePersistence
  /** Agent-retrieval audit log: read-tool calls (search/recall/get_note) appended
   *  fire-and-forget. Absent → no capture (honest degradation). */
  retrievalLog?: RetrievalLogPersistence
  /** Tracks fire-and-forget persistence in the online-backup write barrier. */
  runMutation?: <T>(task: () => Promise<T>) => Promise<T>
  /** The project registry. Absent (meta-DB-less host) → no projects exist
   *  (honest degradation). */
  projects?: ProjectsPersistence
  /** Folder path-history, lazily minted on a folder's first rename so
   *  `[[oldpath/note]]` keeps resolving. Absent → move/rename still works, only the
   *  path-history isn't recorded. */
  folders?: FolderIdentityPersistence
  /** The `.notariummeta` marker store: on-disk truth, written through before the
   *  derived registry cache. Absent (the e2e fake) → registry-only, no marker file. */
  markerStore?: MarkerStore
  /** Space-owned field declarations used by field writes without exposing a
   * schema-management tool to agents. */
  fieldSchemaStore?: FieldSchemaStore
  /** The context-sets registry. Absent (meta-DB-less host) → no sets exist
   *  (honest degradation; the location-bound pin still works). */
  contextSets?: ContextSetsPersistence
  /** Cross-space scope-pins registry (notes pinned into a scope, into
   *  start_session's always-load). */
  scopePins?: ScopePinsPersistence
  /** Per-scope context-order overlay (order = load priority). Absent → the default
   *  sequence (pins then sets). */
  contextOrder?: ContextOrderPersistence
  /** Clock — injectable for tests (stamps dedup/cursor rows, computes dedup windows). */
  now?: () => Date
}

/** One tools/list row. `input`/`output` stay zod here (the gateway's own
 *  validation source); the transport renders them to JSON Schema on the wire. */
export type ToolListing = {
  name: ToolName
  description: string
  annotations: ToolAnnotations
  input: z.ZodObject
  output: z.ZodObject
  publishedInput?: z.ZodObject
  publishedOutput?: z.ZodObject
}

/** CallToolResult (structural subset): Markdown text + machine-readable
 *  structuredContent (the *Output contract shape). */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type McpGateway = {
  listTools(principal: Principal): ToolListing[]
  callTool(principal: Principal, name: string, args: unknown): Promise<ToolResult>
}

/** Per-call context handed to every handler: the principal plus the shared
 *  resolvers and derived lookups (personal domain, project registry). Facets are
 *  undefined on a meta-DB-less host (honest degradation). */
export type Ctx = {
  principal: Principal
  spaces: SpaceManager
  store: StoreAccess
  projects?: ProjectsPersistence
  /** Folder path-history + marker store, written through by the container-reorg tools. */
  folders?: FolderIdentityPersistence
  markerStore?: MarkerStore
  fieldSchemaStore?: FieldSchemaStore
  contextSets?: ContextSetsPersistence
  scopePins?: ScopePinsPersistence
  contextOrder?: ContextOrderPersistence
  agentDeltaCursors?: AgentDeltaCursorsPersistence
  gatewayState?: GatewayStatePersistence
  /** App-level active writes keyed by scope and idempotency key. */
  idempotencyInFlight?: Map<
    string,
    Promise<{ result: DedupResult; wasHit: boolean; persistenceFailed?: true }>
  >
  agentSessions?: AgentSessions
  roles?: RolesService
  abilities?: AbilitiesService
  providerRegistry?: Pick<ProviderRegistry, 'hasUsableForPrincipal'>
  /** Stable session owner: username in password mode, reserved `@system` in none mode. */
  sessionOwner: string | null
  /** Episode attached to this call. start_session fills it after opening one. */
  session?: BoundAgentSession
  now(): Date
  /** Peek the personal-domain slug; NEVER provisions (a read surface must not mint
   *  a space). none-mode → the host's first space. */
  personalSpace(): Promise<string | null>
  /** Resolve, MINTING on first touch — the write path (contrast personalSpace's
   *  read-only peek). Degrades to the host's first space when it can't mint. */
  ensurePersonalDomain(): Promise<string>
  /** Spaces this token can read, INCLUDING the personal domain (search fan-out). */
  readableSpaces(): Promise<string[]>
  /** ACTIVE projects in every space the token is a member of, INCLUDING the
   *  personal domain. [] without a registry. */
  readableProjects(): Promise<ProjectSummary[]>
  /** Resolve a handle (`space/slug` or bare `slug`) to its row, scoped to reachable
   *  spaces (anti-enumeration); 404-semantic on miss. Resolves any status (archived
   *  stays addressable). Read-reachability only — a write tool must additionally
   *  check can(space:write) on the resolved space. */
  resolveProject(handle: string): Promise<ProjectRecord>
  /** Projects living in one space. [] without a registry. */
  projectsInSpace(space: string): Promise<ProjectRecord[]>
}

export type Rendered = { markdown: string; structured: Record<string, unknown> }
export type Handler = (ctx: Ctx, args: unknown) => Promise<Rendered>

/** A tool-execution failure carrying safe, actionable guidance (404-semantics for
 *  denials — never "forbidden"). Thrown directly (not via a helper) so TS narrows
 *  the guarded value after it. */
export class ToolFailure extends Error {}

/** A tool-error result, text sanitised on the way out: most messages are static
 *  server strings, but a few embed note-derived content (edit_note's replaceSection
 *  lists the note's headings — untrusted), so defang centrally rather than trust
 *  each call site (anti tool-poisoning). */
const errorResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text: sanitizeText(text) }],
  isError: true,
})

const LOOP_GUARDED_TOOLS = new Set<ToolName>(['search', 'recall'])
const LOOP_GUARD_MAX_SESSIONS = 2_048
const CLIENT_FAILURE_ONLY_TOOLS = new Set<string>([
  'list_abilities',
  'get_ability',
  'create_ability',
  'edit_ability',
  'delete_ability',
  'use_role',
  'use_skill',
])

const loopGuardResult = (name: 'search' | 'recall'): ToolResult => {
  const structured = name === 'search' ? { results: [] } : { context: '', sources: [] }
  // Keep an error response output-shaped too: typed MCP clients must not lose
  // their contract merely because the procedural safety rail refused a repeat.
  const valid = tools[name].output.parse(structured)
  return {
    content: [
      {
        type: 'text',
        text: `identical ${name} arguments already returned a result in this session — reuse the noteId/source noteIds from the previous response and call get_note, or change the arguments`,
      },
    ],
    structuredContent: valid,
    isError: true,
  }
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'session')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

export const createGateway = (deps: GatewayDeps): McpGateway => {
  const store = createStoreAccess(deps.spaces)
  const now = deps.now ?? (() => new Date())
  const agentSessions = deps.sessions
    ? createAgentSessions({
        persistence: deps.sessions,
        now,
        onChange: deps.auth.notifyAgentSessionsChanged,
      })
    : undefined
  // A local safety rail against a model burning its turn budget on the exact
  // same procedural call. It is deliberately consecutive-only: any other tool
  // call clears the marker, so an intentional later refresh remains possible.
  const lastProceduralBySession = new Map<string, string>()
  // App-scoped: a module-level map would couple independent gateway instances.
  const idempotencyInFlight = new Map<
    string,
    Promise<{ result: DedupResult; wasHit: boolean; persistenceFailed?: true }>
  >()

  const ctxFor = (principal: Principal): Ctx => {
    // Both return the STABLE space id — the gateway addresses stores/meta-DB by id;
    // only handle/space EMISSION translates back to slug.
    // One resolve point on the read path: peek honours the space narrowing (a
    // credential narrowed away from the personal domain reads it empty) and the
    // system/first-space fallback both. canon: docs/auth.md#model
    const personalSpace = async (): Promise<string | null> =>
      peekPersonalSpace({ auth: deps.auth, spaces: deps.spaces }, principal)
    const readableSpaces = async (): Promise<string[]> =>
      deps.spaces
        .list()
        .map((s) => s.id)
        .filter((id) => can(principal, 'space:read', { space: id }))
    return {
      principal,
      spaces: deps.spaces,
      store,
      projects: deps.projects,
      folders: deps.folders,
      markerStore: deps.markerStore,
      fieldSchemaStore: deps.fieldSchemaStore,
      contextSets: deps.contextSets,
      scopePins: deps.scopePins,
      contextOrder: deps.contextOrder,
      agentDeltaCursors: deps.agentDeltaCursors,
      gatewayState: deps.gatewayState,
      idempotencyInFlight,
      agentSessions,
      roles: deps.roles,
      abilities: deps.abilities,
      providerRegistry: deps.providerRegistry,
      sessionOwner: agentOwnerOf(principal),
      now,
      personalSpace,
      ensurePersonalDomain: () =>
        ensurePersonalSpace({ auth: deps.auth, spaces: deps.spaces }, principal),
      readableSpaces,
      readableProjects: async () => {
        if (!deps.projects) {
          return []
        }
        // Membership-scoped (the same reachable set /api/spaces uses), INCLUDING the
        // personal domain — no `!= personal` filter: the personal slug in the handle
        // is the principal's own, never a cross-principal leak.
        const reachable = await readableSpaces()
        const rows = await deps.projects.listForSpaces(reachable)
        return rows
          .filter((p) => p.status === PROJECT_STATUS.active)
          .map((p) => projectSummaryOf(p, deps.spaces.slugOf(p.space) ?? p.space))
      },
      resolveProject: async (handle: string): Promise<ProjectRecord> => {
        if (!deps.projects) {
          throw new ToolFailure(`no such project: ${handle}`)
        }
        const projects = deps.projects
        const reachable = await readableSpaces()

        // Shared ambiguous-handle error; lists full handles to disambiguate, only
        // over reachable rows (anti-enumeration).
        const ambiguous = (matches: readonly ProjectRecord[]): never => {
          const handles = matches
            .map((m) => `${deps.spaces.slugOf(m.space) ?? m.space}/${m.slug}`)
            .join(', ')
          throw new ToolFailure(
            `ambiguous project "${handle}" — it matches more than one project; use the full handle (one of: ${handles}).`,
          )
        }

        // Alias-history pass, consulted ONLY after the current-slug pass misses:
        // current > alias, so a stale alias never shadows a live project's current slug.
        const byAlias = (slug: string, rows: readonly ProjectRecord[]): ProjectRecord[] => {
          const key = asciiSlug(slug)
          return key ? rows.filter((r) => r.aliases.some((a) => asciiSlug(a) === key)) : []
        }
        const slash = handle.indexOf('/')

        if (slash >= 0) {
          // Full path `space-slug/slug`: resolve the space slug (or a past-slug
          // alias) → id; an unreachable space is indistinguishable from "no such
          // project" (anti-enumeration).
          const spaceId = deps.spaces.resolveId(handle.slice(0, slash))
          // Slugify the input into the same space as stored slugs (mint/rename always
          // slug the handle axis), so a non-normalised handle still hits the live current holder
          // FIRST — else current > alias could be violated and a foreign project's
          // alias shadow it.
          const slug = asciiSlug(handle.slice(slash + 1))

          if (!spaceId || !reachable.includes(spaceId)) {
            throw new ToolFailure(`no such project: ${handle}`)
          }
          const rec = await projects.getByHandle(spaceId, slug)

          if (rec) {
            return rec
          }
          // Current-slug miss → alias history.
          const aliased = byAlias(slug, await projects.listForSpace(spaceId))

          if (aliased.length === 1) {
            return aliased[0]
          }
          if (aliased.length > 1) {
            ambiguous(aliased)
          }
          throw new ToolFailure(`no such project: ${handle}`)
        }
        // Bare token, resolved over ONLY reachable spaces (a collision message must
        // never leak a foreign space's slug). May name a project by slug OR — a ROOT
        // project's handle collapses to just `<space>` — a reachable space whose root
        // is marked; gather both and dedup. Slug is normalised; the space/root check
        // stays on the raw token (a space slug is its own canonical form).
        const bareSlug = asciiSlug(handle)
        const bySlug = await projects.findBySlug(bareSlug, reachable)
        const bareSpaceId = deps.spaces.resolveId(handle)
        const root =
          bareSpaceId && reachable.includes(bareSpaceId)
            ? (await projects.listForSpace(bareSpaceId)).find((r) => r.path === '')
            : undefined
        const matches = root ? [root, ...bySlug.filter((m) => m.id !== root.id)] : bySlug

        if (matches.length === 1) {
          return matches[0]
        }
        if (matches.length > 1) {
          ambiguous(matches)
        }
        // No current match → alias history, over the reachable spaces.
        const aliased = byAlias(bareSlug, await projects.listForSpaces(reachable))

        if (aliased.length === 1) {
          return aliased[0]
        }
        if (aliased.length > 1) {
          ambiguous(aliased)
        }
        throw new ToolFailure(`no such project: ${handle}`)
      },
      projectsInSpace: async (space: string): Promise<ProjectRecord[]> =>
        deps.projects ? deps.projects.listForSpace(space) : [],
    }
  }

  return {
    listTools: (principal) =>
      (Object.keys(HANDLERS) as ToolName[])
        // A handler without static metadata yet is simply not surfaced — never a
        // TypeError on the whole list.
        .filter((name) => name in TOOL_META)
        .filter((name) => scopeAllows(principal, toolActions[name] as Action))
        .map((name) => {
          const definition = tools[name]

          return {
            name,
            description: TOOL_META[name as keyof typeof TOOL_META].description,
            annotations: TOOL_META[name as keyof typeof TOOL_META].annotations,
            input: definition.input,
            output: definition.output,
            ...('publishedInput' in definition
              ? { publishedInput: definition.publishedInput }
              : {}),
            ...('publishedOutput' in definition
              ? { publishedOutput: definition.publishedOutput }
              : {}),
          }
        }),

    callTool: async (principal, name, args) => {
      const handler = HANDLERS[name as ToolName]

      if (!handler || !(name in TOOL_META)) {
        return errorResult(`unknown tool: ${name}`)
      }
      // Defence in depth: the tools/list filter is visibility; this is the gate — a
      // hidden tool still 404s here if called.
      const action = toolActions[name as ToolName] as Action

      if (!scopeAllows(principal, action)) {
        return errorResult(`your token cannot use the "${name}" tool`)
      }
      const parsed = tools[name as ToolName].input.safeParse(args ?? {})

      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const where = issue?.path.length ? `\`${issue.path.join('.')}\`: ` : ''
        return errorResult(
          `invalid arguments for ${name} — ${where}${issue?.message ?? 'bad input'}`,
        )
      }
      try {
        const ctx = ctxFor(principal)
        let loopGuard: { session: string; signature: string } | undefined

        if (
          agentSessions &&
          ctx.sessionOwner &&
          name !== 'start_session' &&
          name !== 'whoami' &&
          name !== 'get_my_projects'
        ) {
          const sessionId = (parsed.data as { session?: string }).session
          ctx.session =
            (await (name === 'use_skill'
              ? agentSessions.read(ctx.sessionOwner, sessionId)
              : agentSessions.attach(ctx.sessionOwner, sessionId))) ?? undefined
        }
        if (ctx.session) {
          if (LOOP_GUARDED_TOOLS.has(name as ToolName)) {
            const signature = `${name}\0${stableJson(parsed.data)}`

            if (lastProceduralBySession.get(ctx.session.record.id) === signature) {
              return loopGuardResult(name as 'search' | 'recall')
            }
            loopGuard = { session: ctx.session.record.id, signature }
          } else {
            lastProceduralBySession.delete(ctx.session.record.id)
          }
        }
        const { markdown, structured } = await handler(ctx, parsed.data)
        // Validate the machine payload against the contract before it leaves (P9
        // boundary discipline): a drift fails loudly here, never silently corrupts
        // the agent's context.
        const out = tools[name as ToolName].output.safeParse(structured)

        if (!out.success) {
          console.error(`[mcp] ${name} output drift ->`, out.error.issues[0]?.message)
          return errorResult('internal error: malformed tool response')
        }
        // start_session binds only inside its handler, after the pre-handler attach
        // seam above. A successful bootstrap is still an intervening tool call and
        // must clear a procedural marker left before compaction/reconnect.
        if (name === 'start_session' && ctx.session) {
          lastProceduralBySession.delete(ctx.session.record.id)
        }
        if (loopGuard) {
          lastProceduralBySession.delete(loopGuard.session)
          lastProceduralBySession.set(loopGuard.session, loopGuard.signature)
          if (lastProceduralBySession.size > LOOP_GUARD_MAX_SESSIONS) {
            lastProceduralBySession.delete(lastProceduralBySession.keys().next().value!)
          }
        }
        // Retrieval audit: fire-and-forget AFTER the answer is built, so capture never
        // adds latency and a failed append never fails the call.
        if (deps.retrievalLog) {
          const row = retrievalRowOf(
            name as ToolName,
            principal,
            parsed.data,
            out.data as Record<string, unknown>,
            (deps.now?.() ?? new Date()).toISOString(),
            ctx.session,
          )

          if (row) {
            const append = () => deps.retrievalLog!.append(row)
            void (deps.runMutation ? deps.runMutation(append) : append()).catch(() => {})
          }
        }

        return {
          content: [{ type: 'text', text: markdown }],
          structuredContent: out.data as Record<string, unknown>,
        }
      } catch (err) {
        return mapError(err, name)
      }
    },
  }
}

/** Mint the opaque projection of an unclassified failure: six random hex chars that
 *  appear BOTH in the client's `internal error (ref: …)` and in the server log line
 *  beside the real message, so the instance owner can find the cause without the
 *  error class or any content crossing the wire. Random by construction — a ref
 *  derived from the error or its message would be a side channel. */
const opaqueFailure = (name: string, err: unknown): string => {
  const bytes = new Uint8Array(3)

  crypto.getRandomValues(bytes)
  const ref = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

  console.error(`[mcp] ${name} [${ref}] ->`, (err as Error)?.message)
  return `internal error (ref: ${ref})`
}

/** The actionable message for a thrown error, shared by mapError and the batch
 *  handlers. Explicit client failures carry their safe projection; legacy note-tool
 *  markers retain their existing guidance. Anything else is logged and reported
 *  opaquely. NOT sanitised here — every caller defangs its own output. */
export const toolErrorMessage = (err: unknown, name: string): string => {
  if (err instanceof ToolFailure) {
    return err.message
  }
  const clientFailure = clientFailureOf(err)

  if (clientFailure) {
    return clientFailure.kind === 'not-found' ? 'not found' : clientFailure.message
  }
  const e = err as {
    isConflict?: boolean
    isNotFound?: boolean
    isToolError?: boolean
    reason?: string
    message?: string
  }

  // This reason is emitted only for a remember call without a caller-owned token.
  if (e.reason === STORE_ERROR_REASON.memoryConvergenceExhausted) {
    return `${e.message || 'that memory category is being rewritten concurrently'} — nothing was written. Repeat the same call.`
  }
  if (e.isConflict) {
    if (CLIENT_FAILURE_ONLY_TOOLS.has(name)) {
      return opaqueFailure(name, err)
    }

    return 'This note changed since you last read it. Re-read it with get_note to get the current versionToken, then retry.'
  }
  // Ability-domain errors must opt into the explicit, message-validated contract
  // above. Legacy structural flags belong to older note tools; accepting them here
  // would let a storage error bypass the new no-leak boundary with an arbitrary
  // `message` merely because it happened to carry `isToolError` or `isNotFound`.
  if (CLIENT_FAILURE_ONLY_TOOLS.has(name)) {
    return opaqueFailure(name, err)
  }
  if (e.isNotFound) {
    return e.message || 'not found'
  }
  if (e.isToolError) {
    return e.message || 'the request could not be completed'
  }

  return opaqueFailure(name, err)
}

/** Map a thrown error to an actionable tool-error result (whole-call failure). */
const mapError = (err: unknown, name: string): ToolResult =>
  errorResult(toolErrorMessage(err, name))

// ── handlers ────────────────────────────────────────────────────────────────

/** The self-describe list: the tools THIS token can see, each with a one-line
 *  summary. Cheap insurance for a weak model that skipped the server `instructions`. */
export const toolsHelpFor = (principal: Principal): ToolHelp[] =>
  (Object.keys(HANDLERS) as ToolName[])
    .filter((name) => name in TOOL_META)
    .filter((name) => scopeAllows(principal, toolActions[name] as Action))
    .map((name) => {
      const desc = TOOL_META[name as keyof typeof TOOL_META].description
      const summary = `${desc.split('. ')[0]}.`.replace(/\.\.$/, '.')
      return { name, summary }
    })

/** The live tool registry — its keys are exactly what listTools/callTool surface.
 *  canon: docs/mcp-gateway.md#tools */
const HANDLERS: Partial<Record<ToolName, Handler>> = {
  start_session: handleStartSession,
  list_abilities: handleListAbilities,
  get_ability: handleGetAbility,
  create_ability: handleCreateAbility,
  edit_ability: handleEditAbility,
  delete_ability: handleDeleteAbility,
  use_role: handleUseRole,
  use_skill: handleUseSkill,
  whoami: handleWhoami,
  get_my_projects: handleGetMyProjects,
  list_notes: handleListNotes,
  recent_activity: handleRecentActivity,
  search: handleSearch,
  get_note: handleGetNote,
  recall: handleRecall,
  remember_about_user: handleRememberUser,
  create_note: handleCreateNote,
  remember_about_project: handleRememberProject,
  edit_note: handleEditNote,
  delete_note: handleDeleteNote,
  move_note: handleMoveNote,
  rename_note: handleRenameNote,
  move_folder: handleMoveFolder,
  rename_folder: handleRenameFolder,
  rename_project: handleRenameProject,
  link: handleLink,
  create_notes: handleCreateNotes,
  link_many: handleLinkMany,
}
