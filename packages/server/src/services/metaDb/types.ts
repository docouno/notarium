import type {
  AgentSessionAttach,
  IdentityPersistence,
  RevisionKind,
  RevisionPersistence,
} from '@notarium/core'

/** Derived space registry row; the `.notariummeta` marker is the source of truth.
 *  canon: docs/spaces.md#model · docs/architecture.md#p7 */
export type SpaceRecord = {
  id: string
  slug: string
  displayName: string
  /** Physical folder under SPACES_ROOT; NOT the slug (decoupled, immutable). */
  notesDir: string
  aliases: string[]
  createdAt: string
  /** ISO archived-at, else null. */
  archivedAt: string | null
  /** Actor (`user:`|`pat:`|`ui`), null when active. */
  archivedBy: string | null
}

export type GrantMemberToActiveSpaceResult =
  | { status: 'granted'; space: SpaceRecord }
  | { status: 'missing' }
  | { status: 'archived'; space: SpaceRecord }

/** Persistence for SpaceRecord, keyed by `id`. */
export type SpacesPersistence = {
  /** A slug collision surfaces as a driver UNIQUE violation — the rename caller maps it to 409. */
  upsert(record: SpaceRecord): Promise<void>
  getById(id: string): Promise<SpaceRecord | null>
  /** CURRENT slug only; alias history resolves in SpaceManager, not here. */
  getBySlug(slug: string): Promise<SpaceRecord | null>
  list(): Promise<SpaceRecord[]>
}

// ── project registry facet ─────────────────────────────────────────────

export type ProjectStatus = 'active' | 'archived'

/** A project: a marked folder-subtree with a stable id from its `.notariummeta`
 *  marker; a derived cache row (rebuildable by a marker scan).
 *  canon: docs/projects.md#model */
export type ProjectRecord = {
  id: string
  /** → spaces.id (opaque space id, NOT the slug). */
  space: string
  path: string
  slug: string
  /** Past handle slugs still honoured; RAW, deduped; the current slug is never among them. */
  aliases: string[]
  /** Past folder paths (the analogue of `aliases`), so `[[oldpath/note]]` + old URLs resolve. */
  pathAliases: string[]
  displayName: string
  status: ProjectStatus
  /** ISO of the scan that last confirmed the marker at `path`. */
  lastSeen: string
  /** ISO of the FIRST upsert (mint time), NOT the folder ctime. */
  createdAt: string
}

/** A plain identified folder — a folder given a stable id lazily (on first
 *  rename/move) so `[[oldpath/note]]` + old URLs resolve, WITHOUT being a project
 *  (no handle, memory, or agent semantics). `type='folder'` rows of the shared
 *  `folders` table. */
export type FolderRecord = {
  id: string
  /** → spaces.id (opaque space id, NOT the slug). */
  space: string
  path: string
  /** Past paths; the resolver registers `oldpath/…` keys and the URL layer redirects. */
  pathAliases: string[]
  /** ISO of the scan that last confirmed the marker at `path`. */
  lastSeen: string
  /** ISO of the FIRST upsert (lazy mint), NOT the folder ctime. */
  createdAt: string
}

/** Persistence for marked-folder projects, keyed by `id`. OPTIONAL — a
 *  meta-DB-less host has no projects. */
export type ProjectsPersistence = {
  upsert(record: ProjectRecord): Promise<void>
  getById(id: string): Promise<ProjectRecord | null>
  /** Any status — an archived project is still addressable (archive is a list filter). */
  getByHandle(space: string, slug: string): Promise<ProjectRecord | null>
  /** `spaces` (the reachable set) is MANDATORY — ambiguity is computed only over what
   *  the principal can reach (anti-enumeration). Returns every match so the caller detects it. */
  findBySlug(slug: string, spaces: readonly string[]): Promise<ProjectRecord[]>
  listForSpaces(spaces: readonly string[]): Promise<ProjectRecord[]>
  listForSpace(space: string): Promise<ProjectRecord[]>
  delete(id: string): Promise<void>
  /** Re-prefix `path` of every row AT or UNDER oldPrefix — table-wide (project AND
   *  plain-folder rows share the table). Segment-boundary safe (`demo` ≠ `demofoo`).
   *  Best-effort; a blip self-heals at the next boot reconcile. */
  renamePrefix(space: string, oldPrefix: string, newPrefix: string): Promise<void>
}

/** Persistence for `type='folder'` rows of the shared `folders` table (a separate
 *  typed accessor from `projects`, which scopes to `type='project'`). */
export type FolderIdentityPersistence = {
  upsert(record: FolderRecord): Promise<void>
  getById(id: string): Promise<FolderRecord | null>
  /** Row AT a path; null if the path is a project or an unidentified folder. */
  byPath(space: string, path: string): Promise<FolderRecord | null>
  listForSpace(space: string): Promise<FolderRecord[]>
  delete(id: string): Promise<void>
  /** Path-history of EVERY identified folder in a space — BOTH projects and plain
   *  folders (cross-type). Only rows with a non-empty path-history. */
  aliasesForSpace(
    space: string,
  ): Promise<Array<{ id: string; path: string; pathAliases: string[] }>>
}

// ── favorites facet ───────────────────────────────────────────────────

export type FavoriteEntityKind = 'note' | 'folder' | 'project'

export type FavoriteRecord = {
  /** User-level owner key (`user:<username>`), or `ui` in auth-less mode. */
  owner: string
  /** → spaces.id, not the mutable slug. */
  space: string
  kind: FavoriteEntityKind
  /** Stable entity id: note-id, folder-id or project-id. Never a path/permalink. */
  entityId: string
  createdAt: string
  /** Reserved for future manual ordering; null means "date order". */
  rank: number | null
}

export type FavoritesPersistence = {
  list(owner: string, space: string): Promise<FavoriteRecord[]>
  ids(owner: string, space: string, kind: FavoriteEntityKind): Promise<string[]>
  has(owner: string, space: string, kind: FavoriteEntityKind, entityId: string): Promise<boolean>
  add(record: FavoriteRecord): Promise<void>
  remove(owner: string, space: string, kind: FavoriteEntityKind, entityId: string): Promise<void>
  /** Remove every favorite row for this stable id in this owner/space. Used when a
   *  plain folder favorite is later surfaced as a project with the same id. */
  removeByEntity(owner: string, space: string, entityId: string): Promise<void>
}

// ── context sets facet ────────────────────────────────────────────────

/** A cross-space note ref: `noteId` is authoritative (resolved per-reader);
 *  `space` is where it lived at add-time (display/grouping only). */
export type ContextSetItemRef = { space: string; noteId: string }

/** A named, reusable collection of cross-space note refs, owned by a home space.
 *  canon: docs/projects.md#context-sets-209-reusable-cross-space-bundles */
export type ContextSetRecord = {
  id: string
  /** → spaces.id. Membership here gates view/edit; a personal home space = a private set. */
  homeSpace: string
  name: string
  items: ContextSetItemRef[]
  createdAt: string
}

export type ContextSetTargetKind = 'personal' | 'project' | 'role'

/** Attaches a set to a scope (personal space, project or owned role placement, by stable id). `targetSpace`
 *  is denormalized so `purgeSpace` drops a space's rows with one indexed delete. */
export type ContextSetAttachmentRecord = {
  setId: string
  targetKind: ContextSetTargetKind
  targetId: string
  targetSpace: string
  createdAt: string
}

/** Persistence for context sets + their scope attachments (a delete cascades
 *  attachments). OPTIONAL — a meta-DB-less host has no sets. */
export type ContextSetsPersistence = {
  createSet(record: ContextSetRecord): Promise<void>
  getSet(id: string): Promise<ContextSetRecord | null>
  listSetsForSpace(homeSpace: string): Promise<ContextSetRecord[]>
  renameSet(id: string, name: string): Promise<void>
  /** Atomic idempotent-by-noteId add (serialized read-mutate-write so concurrent
   *  edits don't clobber); returns the updated set, `null` = gone. */
  addItem(id: string, ref: ContextSetItemRef): Promise<ContextSetRecord | null>
  /** Atomic remove by noteId (same serialization as {@link addItem}). `null` = gone. */
  removeItem(id: string, noteId: string): Promise<ContextSetRecord | null>
  /** Atomic reorder to the given note-id sequence. SLOT-PRESERVING — an item not named
   *  (deduped-out of the reader's view, or added concurrently) keeps its original slot,
   *  never moved to the tail. Unknown ids ignored. `null` = gone. */
  reorderItems(id: string, noteIds: readonly string[]): Promise<ContextSetRecord | null>
  deleteSet(id: string): Promise<void>
  attach(record: ContextSetAttachmentRecord): Promise<void>
  detach(setId: string, targetKind: ContextSetTargetKind, targetId: string): Promise<void>
  attachmentsForSet(setId: string): Promise<ContextSetAttachmentRecord[]>
  setsForTarget(targetKind: ContextSetTargetKind, targetId: string): Promise<ContextSetRecord[]>
}

// ── scope pins facet ──────────────────────────────────────────────────

/** A cross-space pin: a note pinned into a scope from a FOREIGN space (a set of one,
 *  no name). Same-space pins use the location-bound `always-load` tag instead — this is
 *  the case a tag can't express. */
export type ScopePinRecord = {
  targetKind: ContextSetTargetKind
  /** Personal space id, project id, or a stable owned-role placement key. */
  targetId: string
  /** Scope's space; denormalized so a space purge drops its pins with one indexed delete. */
  targetSpace: string
  /** → spaces.id. The pinned note's home space at pin-time (display/grouping). */
  noteSpace: string
  noteId: string
  createdAt: string
}

/** Persistence for cross-space note→scope pins, keyed by (scope, note). OPTIONAL — a
 *  meta-DB-less host has no cross-space pins. A pin degrades honestly at resolve
 *  (gone/unreachable → dropped), so there is no eager cleanup on note delete. */
export type ScopePinsPersistence = {
  /** Idempotent — re-pinning refreshes, never duplicates. */
  addPin(record: ScopePinRecord): Promise<void>
  removePin(targetKind: ContextSetTargetKind, targetId: string, noteId: string): Promise<void>
  pinsForTarget(targetKind: ContextSetTargetKind, targetId: string): Promise<ScopePinRecord[]>
}

// ── context order facet ───────────────────────────────────────────────

/** A pin (keyed by note id) or a set (keyed by set id); both share ONE rank space
 *  per scope, so a set can be dragged above a pin. */
export type ContextOrderEntryKind = 'pin' | 'set'

/** A rank OVERLAY row over a scope's heterogeneous membership (membership lives in the
 *  pin/set facets — this only RANKS). Self-healing: a stale rank (entry no longer held)
 *  is ignored; a member with no rank sorts last. */
export type ContextOrderRecord = {
  targetKind: ContextSetTargetKind
  /** Personal space id, project id, or a stable owned-role placement key. */
  targetId: string
  /** Scope's space; denormalized for a one-indexed-delete space purge. */
  targetSpace: string
  entryKind: ContextOrderEntryKind
  /** The pin's note id / the set's id. */
  entryRef: string
  /** 0-based position (dense; a reorder replaces the whole set). */
  rank: number
}

/** Persistence for the per-scope rank overlay. OPTIONAL — no overlay falls back to the
 *  default sequence (pins then sets, insertion order). */
export type ContextOrderPersistence = {
  orderForTarget(targetKind: ContextSetTargetKind, targetId: string): Promise<ContextOrderRecord[]>
  /** Replace a scope's WHOLE order atomically (drop rows, re-insert with rank = index),
   *  so ranks stay dense and a torn write can't half-order a scope. */
  setOrder(
    targetKind: ContextSetTargetKind,
    targetId: string,
    targetSpace: string,
    entries: ReadonlyArray<{ entryKind: ContextOrderEntryKind; entryRef: string }>,
  ): Promise<void>
}

// ── agent retrieval audit facet ───────────────────────────────────────

/** The read tools the audit captures — the agent's runtime retrieval surface. */
export type RetrievalTool = 'search' | 'recall' | 'get_note'

/** One hit a retrieval returned: the note surfaced + (for `search`) its
 *  engine-native score. `title` is a capture-time label; the id is the durable
 *  address. Only the top few per event are kept. */
export type RetrievalHit = { noteId: string; title?: string; score?: number; class?: string }

/** One captured retrieval call. `owner` is the username the audit belongs to
 *  (the read filter); `principal` is the full id of the token that made the call
 *  (`pat:<name>:<id>` | `oauth:…`), the "which agent" lens. `query` is the search/recall
 *  text or the get_note ref; `project` the narrowing handle (null = whole-reach fan-out);
 *  `resultCount`/`topScore` carry the zero/low-score MISS signal (topScore null for
 *  recall/get_note and for a zero-result search). */
export type RetrievalLogRecord = {
  id: string
  owner: string
  principal: string
  /** Friendly name of the acting agent — the PAT's name or the connected app's,
   *  captured at write time (robust against token rotation). null for an unnamed principal. */
  agent: string | null
  /** Bound episode snapshot. Nulls mean the call happened outside a session. */
  sessionId: string | null
  sessionName: string | null
  sessionAttach: AgentSessionAttach | null
  tool: RetrievalTool
  query: string
  project: string | null
  classFilter: string | null
  resultCount: number
  topScore: number | null
  hits: RetrievalHit[]
  createdAt: string
}

export type RetrievalLogInput = Omit<RetrievalLogRecord, 'id'>

/** A windowed history read, owner-scoped + newest-first. `tool` narrows to one
 *  tool; `missesOnly` keeps only zero-result calls (the "searched but didn't find"
 *  filter). */
export type RetrievalHistoryQuery = {
  owner: string
  offset: number
  limit: number
  tool?: RetrievalTool
  missesOnly?: boolean
  /** Keyset cursor for infinite scroll: return rows older than this rendered row in
   *  `(createdAt DESC, id DESC)` order. Keeps live appends above the list from shifting
   *  page 2 into duplicates/skips. */
  before?: { at: string; id: string }
}

/** One aggregated query line: a distinct (query, tool), how often it ran, how
 *  many of those missed (zero results), and when it last ran. */
export type RetrievalQueryStat = {
  query: string
  tool: RetrievalTool
  count: number
  misses: number
  lastAt: string
}

/** The whole-history rollup: totals + the ranked query lines (by count / by
 *  misses). Only `search`/`recall` count as queries — `get_note` is a follow-through. */
export type RetrievalAggregates = {
  totalQueries: number
  missCount: number
  top: RetrievalQueryStat[]
  misses: RetrievalQueryStat[]
}

/** The agent-retrieval audit facet: an append-only, owner-scoped log written
 *  fire-and-forget by the MCP gateway on every read-tool call, read back by the
 *  Agents → Sessions surface. Owner-keyed and cross-space (a search fans out) — so it is
 *  NOT swept by purgeSpace, exactly like the per-user oauth facet. */
export type RetrievalLogPersistence = {
  append(input: RetrievalLogInput): Promise<RetrievalLogRecord>
  history(
    q: RetrievalHistoryQuery,
  ): Promise<{ items: RetrievalLogRecord[]; total: number; hasMore: boolean }>
  aggregates(owner: string, opts?: { limit?: number }): Promise<RetrievalAggregates>
}

// ── auth facet records ─────────────────────────────────────────────────

/** One user. `username` is the immutable key (the wire's user handle);
 *  `passwordHash` is scrypt-encoded, null until an invite is accepted (and the
 *  seam an external-identity provider would leave null for good). `disabledAt`
 *  is soft: grants stay, credentials stop validating. */
export type UserRecord = {
  username: string
  displayName: string
  passwordHash: string | null
  admin: boolean
  disabledAt: string | null
  createdAt: string
  /** The user's personal domain: the space `remember_about_user`
   *  writes into and `start_session` reads the profile from. null until
   *  provisioned. A pointer on the user — not a role on the space (space and
   *  project stay disjoint). Holds the stable space ID (was the
   *  slug) — so a space rename leaves this pointer untouched. */
  personalSpace: string | null
}

/** One server-side session. `idHash` = sha-256 of the cookie token — a DB leak
 *  doesn't leak live cookies. Sliding expiry: reads refresh expiresAt. */
export type SessionRecord = {
  idHash: string
  username: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string
}

export type PatScope = 'read' | 'write'

/** One personal access token. `id` is the public half (rides inside the
 *  bearer string for O(1) lookup), `secretHash` = sha-256 of the secret half.
 *  `spaces` = JSON-decoded narrowing list of stable space IDs (was
 *  slugs; a rename leaves a PAT's narrowing intact), null = all the owner's grants. */
export type PatRecord = {
  id: string
  username: string
  name: string
  secretHash: string
  scope: PatScope
  spaces: string[] | null
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

export type SpaceRole = 'owner' | 'writer' | 'reader'

export type MemberRecord = {
  space: string
  username: string
  role: SpaceRole
  createdAt: string
}

/** One single-use credential-bootstrap link (no SMTP — the admin hands
 *  the link over out-of-band). Same mechanism for both purposes: 'invite'
 *  sets the first password, 'reset' replaces a lost one. */
export type OneTimeTokenRecord = {
  idHash: string
  username: string
  purpose: 'invite' | 'reset'
  expiresAt: string
  usedAt: string | null
  createdAt: string
}

/** The auth facet: users, sessions, PATs, memberships, one-time links.
 *  Pure persistence — hashing, expiry decisions and the can() semantics live
 *  in services/auth; this layer never sees a plaintext secret. */
export type AuthPersistence = {
  /** The first-run gate: zero users = setup is open. */
  userCount(): Promise<number>
  /** Atomic first-run claim: insert this user ONLY while the users table
   *  is still empty, reporting whether THIS call won (false = someone already
   *  set up — the race loser, mirrors useOneTime). The check and the insert are
   *  one atomic step, closing the setup TOCTOU that a plain userCount()+create
   *  leaves open (two concurrent setups, each seeing zero, minting two admins). */
  createFirstUser(user: UserRecord): Promise<boolean>
  /** Throws on a duplicate username (the unique key IS the check). */
  createUser(user: UserRecord): Promise<void>
  getUser(username: string): Promise<UserRecord | null>
  listUsers(): Promise<UserRecord[]>
  updateUser(
    username: string,
    patch: Partial<
      Pick<UserRecord, 'displayName' | 'passwordHash' | 'admin' | 'disabledAt' | 'personalSpace'>
    >,
  ): Promise<void>

  insertSession(session: SessionRecord): Promise<void>
  getSession(idHash: string): Promise<SessionRecord | null>
  touchSession(idHash: string, lastUsedAt: string, expiresAt: string): Promise<void>
  deleteSession(idHash: string): Promise<void>
  deleteSessionsFor(username: string): Promise<void>

  insertPat(pat: PatRecord): Promise<void>
  getPat(id: string): Promise<PatRecord | null>
  listPats(username: string): Promise<PatRecord[]>
  /** Patch the mutable fields of a PAT. `lastUsedAt`/`revokedAt` are the
   *  bookkeeping writes; `scope`/`spaces` make the rights axis mutable —
   *  a post-issuance level/narrowing change, applied verbatim (the service has
   *  already translated slugs→ids and validated membership). `spaces: null`
   *  widens to all grants, a list re-narrows. */
  updatePat(
    id: string,
    patch: Partial<Pick<PatRecord, 'lastUsedAt' | 'revokedAt' | 'scope' | 'spaces' | 'name'>>,
  ): Promise<void>

  grantsFor(username: string): Promise<Array<{ space: string; role: SpaceRole }>>
  /** Joined with users for the display name — what the members UI lists. */
  membersOf(
    space: string,
  ): Promise<Array<{ username: string; displayName: string; role: SpaceRole }>>
  upsertMember(space: string, username: string, role: SpaceRole, createdAt: string): Promise<void>
  removeMember(space: string, username: string): Promise<void>
  /** Distinct spaces that have at least one member — the boot rule
   *  ("a memberless space gets owner rows for every active admin") diffs
   *  against this. */
  spacesWithMembers(): Promise<string[]>

  insertOneTime(token: OneTimeTokenRecord): Promise<void>
  getOneTime(idHash: string): Promise<OneTimeTokenRecord | null>
  /** Atomic single-use claim: marks the token used and reports whether THIS
   *  call won (false = already used/unknown — the race loser). */
  useOneTime(idHash: string, usedAt: string): Promise<boolean>
  /** Invalidate outstanding links when a new one is minted or the user is
   *  disabled. */
  deleteOneTimesFor(username: string): Promise<void>
}

// ── MCP gateway state facet ─────────────────────────────────────

/** A deduplicated write's recorded outcome — what a retry of the same call gets
 *  back instead of writing a duplicate. */
export type DedupResult = { noteId: string; versionToken: string }

/** The MCP gateway's write-retry idempotency state. Pure persistence — the
 *  windowing/scope policy lives in the gateway. OPTIONAL on a host (a
 *  meta-DB-less none-mode host has no dedup), like the journal. */
export type GatewayStatePersistence = {
  /** A prior write's outcome for (scope, key) when it is still inside the window
   *  (createdAt > sinceIso), else null. */
  dedupGet(scope: string, key: string, sinceIso: string): Promise<DedupResult | null>
  /** Record a write's outcome for (scope, key). Upsert — a re-record is the
   *  same call landing again. */
  dedupPut(scope: string, key: string, result: DedupResult, createdAt: string): Promise<void>
  /** Drop dedup rows older than `beforeIso` — bounds the table; the gateway
   *  calls it opportunistically. */
  dedupPrune(beforeIso: string): Promise<void>
}

// ── Agent delta cursors facet ──────────────────────────────────

/** The owner fallback, optionally narrowed to one durable work episode. A fork
 * carries its parent so first project-touch can copy the parent's independent
 * position instead of a newer owner fallback. */
export type AgentDeltaCursorScope = {
  owner: string
  session?: { id: string; parentId: string | null }
}

/** Durable positions in each project's space-wide revision stream. A session
 * cursor is materialised on first project-touch even for a peek, freezing its
 * independent window. `advance` moves the session and owner fallback together,
 * monotonically and atomically. */
export type AgentDeltaCursorsPersistence = {
  getOrInit(
    scope: AgentDeltaCursorScope,
    project: string,
    initializedAt: string,
  ): Promise<string | null>
  advance(
    scope: AgentDeltaCursorScope,
    project: string,
    lastRev: string,
    updatedAt: string,
  ): Promise<void>
}

// ── Agent work sessions facet ──────────────────────────────────

/** One owner-scoped work episode. Activity is derived from lastSeenAt; no stored
 * status can drift. `named=false` marks a server-generated display name. */
export type AgentSessionRecord = {
  id: string
  owner: string
  name: string
  named: boolean
  parentId: string | null
  createdAt: string
  lastSeenAt: string
  calls: number
  /** Latest explicitly selected effective role, or null for the base mode. */
  role: string | null
}

export type AgentSessionRoleSet = {
  record: AgentSessionRecord
  changed: boolean
}

/** Atomic outcome of starting a named session. The persistence layer owns the
 * whole observe-and-decide sequence so concurrent starts cannot both resume a
 * sleeping row or both create unrelated roots. */
export type AgentSessionNamedStart =
  | { kind: 'ambiguous'; matches: AgentSessionRecord[] }
  | { kind: 'new' | 'resumed' | 'forked'; record: AgentSessionRecord }

/** Durable storage for agent work sessions. Policy (2h active / 30d retention,
 * resume vs fork) lives in the transport-independent agentSessions service.
 * `inferActiveAndTouch` and `startNamed` are deliberately atomic: their
 * observe-and-update decisions must remain one linearizable operation. */
export type AgentSessionsPersistence = {
  insert(session: AgentSessionRecord): Promise<void>
  touch(
    owner: string,
    id: string,
    lastSeenAt: string,
    retainedSince: string,
  ): Promise<AgentSessionRecord | null>
  inferActiveAndTouch(
    owner: string,
    activeSince: string,
    lastSeenAt: string,
  ): Promise<AgentSessionRecord | null>
  startNamed(
    candidate: AgentSessionRecord,
    activeSince: string,
    retainedSince: string,
    limit: number,
  ): Promise<AgentSessionNamedStart>
  listRecent(owner: string, since: string, limit: number): Promise<AgentSessionRecord[]>
  /** Set the active role atomically; `changed=false` is the idempotent repeat. */
  setRole(owner: string, id: string, role: string): Promise<AgentSessionRoleSet | null>
  prune(before: string): Promise<void>
}

// ── Owner session audit read model ─────────────────────────────

export type AgentSessionAuditSummary = {
  id: string
  name: string
  named: boolean | null
  parentId: string | null
  createdAt: string
  lastSeenAt: string
  /** null after the retained lifecycle row has been GC'd. */
  calls: number | null
  reads: number
  writes: number
  retained: boolean
  active: boolean
}

export type AgentSessionAuditOutside = {
  reads: number
  writes: number
  lastSeenAt: string
}

export type AgentSessionAuditSummaryCursor = { at: string; id: string }
export type AgentSessionAuditEventCursor = {
  at: string
  source: 'retrieval' | 'write'
  id: string
}

export type AgentSessionAuditRetrievalEvent = {
  type: 'retrieval'
  record: RetrievalLogRecord
}

export type AgentSessionAuditWriteEvent = {
  type: 'write'
  id: string
  at: string
  principal: string | null
  agent: string | null
  sessionAttach: AgentSessionAttach | null
  noteId: string
  space: string
  title: string
  class: string | null
  revisionKind: RevisionKind
}

export type AgentSessionAuditEvent = AgentSessionAuditRetrievalEvent | AgentSessionAuditWriteEvent

/** Cross-space, self-scoped read model over retained sessions plus the two durable
 * audit sources. It owns no writes and keeps archived session snapshots visible. */
export type AgentSessionAuditPersistence = {
  overview(q: {
    owner: string
    activeSince: string
    limit: number
    before?: AgentSessionAuditSummaryCursor
  }): Promise<{
    items: AgentSessionAuditSummary[]
    total: number
    active: number
    outside: AgentSessionAuditOutside | null
    hasMore: boolean
  }>
  find(
    owner: string,
    sessionId: string,
    activeSince: string,
  ): Promise<AgentSessionAuditSummary | null>
  events(q: {
    owner: string
    /** null addresses the explicit Outside sessions bucket. */
    sessionId: string | null
    type?: 'retrieval' | 'write'
    limit: number
    before?: AgentSessionAuditEventCursor
  }): Promise<{ items: AgentSessionAuditEvent[]; total: number; hasMore: boolean }>
}

// ── OAuth facet records ────────────────────────────────────────────────

/** How a client got its id: 'dcr' (RFC 7591 Dynamic Client Registration — we
 *  minted the id and stored its redirect_uris) or 'cimd' (RFC client-id-metadata:
 *  the client_id IS an https URL we fetched + validated; the row is a cache). */
export type OAuthClientKind = 'dcr' | 'cimd'

/** One registered OAuth client (Claude/ChatGPT connector). The redirect-URI
 *  allowlist is the load-bearing security field — the /authorize and /token
 *  flows admit ONLY an exact-match redirect_uri from here. */
export type OAuthClientRecord = {
  clientId: string
  kind: OAuthClientKind
  redirectUris: string[]
  clientName: string | null
  createdAt: string
  lastSeen: string
  /** Null until a human successfully approves this client. Only this pending
   *  state belongs to the unauthenticated registry budget; activated clients are
   *  durable integration identity and are never quota-GC'd. */
  activatedAt: string | null
}

/** A pending authorization code (RFC 6749 + PKCE RFC 7636). Stored as the
 *  sha-256 of the code; carries the PKCE challenge the /token exchange verifies,
 *  plus the client/redirect/scope/user it is bound to. Single-use, ~60s TTL. */
export type OAuthCodeRecord = {
  codeHash: string
  clientId: string
  username: string
  redirectUri: string
  scope: string
  /** Per-space narrowing carried from the consent screen to the token
   *  mint: a JSON-decoded list of stable space ids, null = all the owner's grants
   *  (like a non-narrowed PAT). The code is the only carrier between consent-approve
   *  and the /token exchange, so the selection must persist here. */
  spaces: string[] | null
  codeChallenge: string
  codeChallengeMethod: string
  expiresAt: string
  usedAt: string | null
  createdAt: string
}

export type OAuthScope = 'read' | 'write'

/** An issued access token. Shaped like a PAT (id half public, secret half
 *  hashed) so it validates through the SAME auth chokepoint. `refreshId` links
 *  the refresh token it was minted alongside (revoking one cascades). */
export type OAuthAccessRecord = {
  id: string
  tokenHash: string
  username: string
  clientId: string
  scope: OAuthScope
  /** Per-space narrowing: JSON-decoded list of stable space ids, null =
   *  all the owner's grants (like a non-narrowed PAT). Intersects with live
   *  membership at every check, so an owner losing a grant instantly narrows the
   *  connector too. */
  spaces: string[] | null
  expiresAt: string
  refreshId: string | null
  revokedAt: string | null
  createdAt: string
  lastUsedAt: string | null
}

/** A refresh token (offline_access). Rotated on use — `rotatedTo` points at the
 *  successor so a replayed old refresh is detectable and refused. */
export type OAuthRefreshRecord = {
  id: string
  tokenHash: string
  username: string
  clientId: string
  scope: OAuthScope
  /** Per-space narrowing — mirrored from the access token so it survives
   *  the hourly rotation: `refresh` mints the next family from THIS row, so the
   *  narrowing (like scope) must live here too, else a rotation would widen back
   *  to all spaces. */
  spaces: string[] | null
  expiresAt: string
  rotatedTo: string | null
  revokedAt: string | null
  createdAt: string
}

/** The OAuth facet: registered clients, pending auth codes, access +
 *  refresh tokens. Pure persistence — PKCE verification, TTLs, rotation and the
 *  token→principal mapping live in services/oauth and the auth chokepoint; this
 *  layer never sees a plaintext secret (codes/tokens arrive pre-hashed). The
 *  SEVENTH tenant of the meta-DB. OPTIONAL on a host (a meta-DB-less none-mode
 *  host has no OAuth — it serves the authless connector instead). */
export type OAuthPersistence = {
  /** Trusted/internal upsert (migration/seed and CIMD refresh of a known row).
   *  Never clears an existing activation stamp. Public registration uses the
   *  bounded method below. */
  upsertClient(client: OAuthClientRecord): Promise<void>
  /** Atomically prune expired pending rows, then insert/update a public client
   *  only while the total pending registry is below `maxPending`. An existing
   *  client may always refresh its metadata and never consumes another slot. */
  upsertPendingClient(
    client: OAuthClientRecord,
    maxPending: number,
    pendingBeforeIso: string,
  ): Promise<boolean>
  getClient(clientId: string): Promise<OAuthClientRecord | null>
  /** First successful consent crosses the trust boundary. False means the client
   *  disappeared (for example pending TTL won a race); no code may be issued. */
  activateClient(clientId: string, activatedAt: string, pendingBeforeIso: string): Promise<boolean>

  insertCode(code: OAuthCodeRecord): Promise<void>
  getCode(codeHash: string): Promise<OAuthCodeRecord | null>
  /** Atomic single-use claim (mirrors useOneTime): mark the code used and report
   *  whether THIS call won (false = already used/unknown — the race loser). */
  useCode(codeHash: string, usedAt: string): Promise<boolean>

  insertAccess(token: OAuthAccessRecord): Promise<void>
  getAccess(id: string): Promise<OAuthAccessRecord | null>
  /** `scope` and `spaces` are mutable so a connected app's access
   *  level (read↔write) and per-space narrowing can change without re-consent —
   *  patched across all the app's live access rows alongside the refresh rows (so a
   *  rotation keeps the new ceiling AND narrowing). `spaces: null` widens back to all
   *  grants, a list re-narrows. */
  updateAccess(
    id: string,
    patch: Partial<Pick<OAuthAccessRecord, 'lastUsedAt' | 'revokedAt' | 'scope' | 'spaces'>>,
  ): Promise<void>
  /** The user's NON-REVOKED access tokens — EXPIRED ones INCLUDED (callers apply
   *  their own expiry filter). The "connected apps" listing relies on the expired
   *  rows being returned to recover a connection's real last-used after its short
   *  access token lapsed; do NOT add an expiry filter here. Also a belt for
   *  cascade revoke. */
  listAccessForUser(username: string): Promise<OAuthAccessRecord[]>

  insertRefresh(token: OAuthRefreshRecord): Promise<void>
  getRefresh(id: string): Promise<OAuthRefreshRecord | null>
  /** `scope` and `spaces` mutable so a connection's level/narrowing
   *  change survives the hourly refresh rotation: `refresh` mints the next access/
   *  refresh family from THIS row, so the new ceiling AND narrowing must be written
   *  here too, not only on access. */
  updateRefresh(
    id: string,
    patch: Partial<Pick<OAuthRefreshRecord, 'rotatedTo' | 'revokedAt' | 'scope' | 'spaces'>>,
  ): Promise<void>
  /** Atomic single-use rotation claim (mirrors useCode): mark the refresh rotated
   *  ONLY while it is not already rotated or revoked, reporting whether THIS call
   *  won. The guard against a concurrent double-spend of one refresh token — a plain
   *  read-then-write lets two concurrent refreshes both mint a token family. */
  claimRefreshRotation(id: string, rotatedAt: string): Promise<boolean>
  /** The user's live (non-revoked) refresh tokens — lets the connections view and
   *  revoke reach an app whose short-lived access tokens have all expired/pruned
   *  while its long-lived refresh token is still valid. */
  listRefreshForUser(username: string): Promise<OAuthRefreshRecord[]>

  /** Drop expired codes/access/refresh rows older than `beforeIso` — bounds the
   *  tables; the service calls it opportunistically (like dedupPrune). */
  pruneExpired(beforeIso: string, pendingBeforeIso: string): Promise<void>
}

// ── durable job layer facet ─────────────────────────────────

/** A job's lifecycle. `pending` waits for a worker; `running` is held by one
 *  (locked_by/locked_at); `succeeded`/`failed`/`canceled` are terminal. A retry
 *  drops a `running` job back to `pending` with a future `runAt` (backoff). */
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'

/** One durable job. `kind` is an OPEN string (export today; import,
 *  purge, re-embed later) — the runner dispatches by it. `params`/`result`
 *  are kind-specific JSON (decoded here). The artifact triplet (ref/bytes/name) is
 *  the produced download (an export's ZIP); null for kinds that produce no file
 *  (import writes notes). `expiresAt` is the artifact's TTL — GC deletes the file
 *  past it and clears the pointer, keeping the row as history. */
export type JobRecord = {
  id: string
  space: string
  kind: string
  status: JobStatus
  /** Attribution of who enqueued it (`user:<name>` | `pat:<name>:<id>` | `ui`) —
   *  the journal/space-archive attribution scheme, reused for the "your
   *  exports" filter and the download ownership check. */
  principal: string
  /** Kind-specific input, JSON-decoded (an export's scope/frontmatter/folder). */
  params: unknown
  progressDone: number
  /** Best-effort total for the %; null when unknown upfront (a stream). */
  progressTotal: number | null
  /** Free-form current-phase label (e.g. 'archiving'); null when not set. */
  phase: string | null
  attempts: number
  maxAttempts: number
  /** ISO not-before — the claim ignores rows whose runAt is in the future (backoff). */
  runAt: string
  /** ISO of the claim / last heartbeat; null when not running. Stale ⇒ reaped. */
  lockedAt: string | null
  lockedBy: string | null
  artifactRef: string | null
  artifactBytes: number | null
  artifactName: string | null
  /** Kind-specific output summary, JSON-decoded. */
  result: unknown
  error: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  expiresAt: string | null
}

export type JobEnqueueInput = {
  id: string
  space: string
  kind: string
  principal: string
  params?: unknown
  progressTotal?: number | null
  maxAttempts?: number
  /** ISO not-before; defaults to createdAt (runnable immediately). */
  runAt?: string
  createdAt: string
}

/** Persistence for the durable job queue (driver-specific claim SQL: `FOR UPDATE SKIP
 *  LOCKED` on pg, atomic `UPDATE…RETURNING` on sqlite; dispatch/backoff/GC live in
 *  jobRunner). OPTIONAL — a meta-DB-less host degrades to the synchronous streaming export.
 *  canon: docs/jobs.md#model */
export type JobsPersistence = {
  /** Insert a `pending` job; returns the stored record. */
  enqueue(input: JobEnqueueInput): Promise<JobRecord>
  /** Atomic single-flight claim of the oldest runnable job; null when none. `workerId` is
   *  a per-run lease, so a reaped-then-reclaimed job's original run detects the changed
   *  lease on its next heartbeat and self-aborts (no same-id double-run). */
  claimNext(workerId: string, kinds: readonly string[], now: string): Promise<JobRecord | null>
  /** Heartbeat + progress, ONLY while still `running` and held by this worker.
   *  Returns false when the row is no longer ours (canceled / reaped / stolen) —
   *  the runner aborts the in-flight handler on false (cooperative cancel). */
  heartbeat(
    id: string,
    workerId: string,
    p: { done: number; total?: number | null; phase?: string | null; now: string },
  ): Promise<boolean>
  /** Terminal success with the produced artifact (any of the triplet may be null).
   *  Guarded by the lease (`locked_by = workerId AND status = 'running'`): returns
   *  false when the row is no longer ours (canceled / reaped-and-reclaimed by a peer),
   *  so a stale worker can never overwrite a cancel or a peer's run with 'succeeded'. */
  succeed(
    id: string,
    workerId: string,
    out: {
      result?: unknown
      artifactRef?: string | null
      artifactBytes?: number | null
      artifactName?: string | null
      expiresAt?: string | null
      now: string
    },
  ): Promise<boolean>
  /** Reschedule for retry (retryAt set ⇒ back to `pending` with backoff) OR fail
   *  terminally (retryAt null ⇒ `failed`). The runner picks by attempts<maxAttempts.
   *  Lease-guarded like `succeed` (returns false when the row is no longer ours), so a
   *  reviving stale worker can't flip a peer's live `running` row back to `pending`. */
  fail(
    id: string,
    workerId: string,
    f: { error: string; retryAt?: string | null; now: string },
  ): Promise<boolean>
  /** Cooperative cancel: mark `canceled` while `pending` or `running`. A pending
   *  job is simply never claimed; a running job's next heartbeat returns false and
   *  the runner aborts it. Returns false when already terminal (nothing to cancel). */
  cancel(id: string, now: string): Promise<boolean>
  /** Graceful-shutdown release: drop a job WE hold back to `pending` so a peer /
   *  the restarted process re-claims it immediately (no wait for the reaper). Refunds
   *  the attempt the claim bumped (`attempts - 1`) — a clean redeploy is not a failure,
   *  so a long job across rolling restarts keeps its full retry budget for real errors. */
  release(id: string, workerId: string, now: string): Promise<void>
  get(id: string): Promise<JobRecord | null>
  /** A space's jobs, newest first; optional principal/kind/status narrowing and
   *  a row cap (the "recent exports" list). */
  list(
    space: string,
    opts?: { principal?: string; kind?: string; statuses?: readonly JobStatus[]; limit?: number },
  ): Promise<JobRecord[]>
  /** Reaper: `running` jobs whose lockedAt < staleBefore — reopen (attempts left)
   *  or fail (exhausted). Returns the affected rows (post-update) for logging. */
  reapStale(staleBefore: string, now: string): Promise<JobRecord[]>
  /** GC candidates: terminal jobs with an artifact past its expiresAt. */
  findExpired(now: string, limit?: number): Promise<JobRecord[]>
  /** Clear the artifact pointer after the file is deleted (row stays as history). */
  clearArtifact(id: string, now: string): Promise<void>
  /** Prune terminal rows older than `before` — bounds the table. */
  prune(before: string): Promise<void>
}

/** The meta-DB: all persistence facets over one connection + one migration history.
 *  Facets self-initialize (any call runs the shared migrations first). */
export type MetaDb = {
  identity: IdentityPersistence
  revisions: RevisionPersistence
  spaces: SpacesPersistence
  auth: AuthPersistence
  gateway: GatewayStatePersistence
  /** Owner fallback + per-session/project delta positions. */
  agentDeltaCursors: AgentDeltaCursorsPersistence
  /** Owner-scoped/cross-space; retained independently of any one project or space. */
  sessions: AgentSessionsPersistence
  sessionAudit: AgentSessionAuditPersistence
  projects: ProjectsPersistence
  /** `type='folder'` rows of the same table as `projects`, not a separate tenant. */
  folders: FolderIdentityPersistence
  favorites: FavoritesPersistence
  contextSets: ContextSetsPersistence
  scopePins: ScopePinsPersistence
  contextOrder: ContextOrderPersistence
  oauth: OAuthPersistence
  jobs: JobsPersistence
  /** Owner-scoped/cross-space, so NOT swept by purgeSpace (like oauth). */
  retrievalLog: RetrievalLogPersistence
  /** Stamp pre-space-column rows ('') with the legacy single-space's id, BEFORE any
   *  registry loads so space-filtered loads see a complete world. Idempotent. */
  adoptLegacyRows(legacySlug: string): Promise<void>
  /** Atomically prove that a stable space id still exists and is active, then
   *  upsert its membership. This is the recovery-CLI TOCTOU boundary: archive
   *  and purge cannot interleave between validation and the write. */
  grantMemberToActiveSpace(
    spaceId: string,
    username: string,
    role: SpaceRole,
    createdAt: string,
  ): Promise<GrantMemberToActiveSpaceResult>
  /** Erase one space's rows across every facet in a single transaction (journal with
   *  CAS-blob GC, identity, folders/projects, favorites, sets, pins, order, memberships,
   *  delta cursors and inert legacy bookmarks) + scrub its id from every `pats.spaces`
   *  (an emptied PAT stays `[]` =
   *  no access, never widened — fail-closed). On-disk artefacts are removed by the
   *  composition root, not here (this layer owns no filesystem). Irreversible. */
  purgeSpace(spaceId: string): Promise<void>
  close(): Promise<void>
}
