// The seed-case catalog's neutral model (#175). One case = a named, declarative
// description of a stand's state, applied to BOTH backends by two appliers over
// this ONE source: the in-memory fake (e2e/visual — `caseToFixture` → the fake's
// `Fixture` + `POST /api/__test/reset`) and the real engine (manual QA — the
// in-process `scripts/seed.ts`, which replays the timeline through the production
// `store.write`/`remove`/`restore` with an injected clock so the #12 journal —
// the source of the heatmap/feed/trash/history — lands at the AUTHORED dates, not
// one "today" spike).
//
// The model is a chronological TIMELINE of note operations, from which both
// projections fall out: the fake reduces it to (final snapshot + activity rows),
// the real applier replays it op-by-op. Keeping the timeline (not a final
// snapshot) is what makes the seeded history honest — a note is `created` one day
// and `edited` on later days, exactly the chained revisions the dashboard reads.

import type { Axis } from './axes'

/** A note's model class (#74/#78). Mirrors core's NoteClass as a plain string so
 *  the catalog stays dependency-light (both appliers translate it). */
export type CaseNoteClass = 'user-doc' | 'agent-memory' | 'profile' | 'skill'

/** A date as an ISO instant OR a `YYYY-MM-DD` (interpreted at noon UTC). The
 *  generators emit ISO instants; hand-authored cases may use either. */
export type CaseDate = string

export type SpaceDecl = {
  slug: string
  displayName?: string
  /** Past human-facing slugs that still resolve to this space. Applied to both
   *  the fake registry and the real meta-DB/marker so alias-boundary cases are
   *  reproducible rather than hand-edited after every seed. */
  aliases?: string[]
  /** Seed this space as a user's personal domain (#21/#13): the auth user's
   *  `personalSpace` pointer is set to it, and agent-memory/profile notes land in
   *  the hidden mounts. */
  personalFor?: string
  /** Seed this space SOFT-ARCHIVED (#110): the real applier marks `archivedAt` after
   *  seeding, so it appears in the Trash (Spaces tab) with its data intact. (The fake
   *  projection seeds it live — space-archive is a real-stand concern.) */
  archived?: boolean
}

/** A marked-folder project (#13). `path: ''` is a root project owning the whole
 *  space (the auto-mark #97 already makes one — declare a root project only to
 *  rename it). */
export type ProjectDecl = {
  space: string
  path: string
  slug?: string
  displayName?: string
  status?: 'active' | 'archived'
}

export type UserDecl = {
  username: string
  /** Plaintext — scrypt-hashed at seed time by the real applier; the fake stores
   *  it for its production AuthService. */
  password?: string
  displayName?: string
  admin?: boolean
  /** The space slug that is this user's personal domain (#21). */
  personalSpace?: string
}

export type MemberDecl = { space: string; username: string; role: 'owner' | 'writer' | 'reader' }

/** One connected OAuth app (#181) the owner has authorized — so Settings → Connected
 *  apps shows real data (with per-space narrowing). The REAL applier mints an oauth
 *  client + a live access + refresh token pair (fake seeding is a follow-up — see
 *  docs/seeds.md); nothing here is a usable token, only display state. */
export type ConnectedAppDecl = {
  /** The app's display name (the OAuth client's `client_name`), e.g. "Claude". */
  appName: string
  /** Which seeded user authorized it; defaults to the primary owner. */
  owner?: string
  scope: 'read' | 'write'
  /** Space SLUGS the connection is narrowed to; null/absent = all the owner's grants
   *  (the #181 fail-open default). Each must be a space the owner is a member of. */
  spaces?: string[] | null
  /** Age of the connection (days before `now`), for a realistic "Connected" column. */
  connectedDaysAgo?: number
  /** Days-before-now of the last use; null/absent = never used ("—"). */
  lastUsedDaysAgo?: number | null
}

/** A public OAuth client registration that has not reached human consent yet.
 *  Real-applier only: it exercises the bounded pending registry/GC state,
 *  not the Connected apps UI (which intentionally lists activated apps only). */
export type PendingOAuthClientDecl = {
  kind: 'dcr' | 'cimd'
  clientName: string
  /** Stable URL id for CIMD; DCR receives a deterministic ntcli_seed_pending id. */
  clientId?: string
  redirectUris: string[]
  /** Pending age; keep below the 24h GC threshold unless a case targets expiry. */
  registeredHoursAgo?: number
}

/** The auth world (#10). Present ⇒ the stand boots in password mode with these
 *  users/memberships; the real applier also picks the FIRST user as the login it
 *  reports back. Absent ⇒ single-principal (`ui`). `connectedApps` (#181) are the
 *  owner's OAuth connections, minted by the real applier for the Connected apps UI. */
export type AuthDecl = {
  users: UserDecl[]
  members: MemberDecl[]
  connectedApps?: ConnectedAppDecl[]
  pendingOAuthClients?: PendingOAuthClientDecl[]
}

/** One captured retrieval a case declares for the agent-audit log (#243) — a meta-DB-only
 *  side-channel (like connectedApps), written by the REAL applier ONLY (the fake projection
 *  doesn't express it; see docs/seeds.md). `hits` reference seeded notes by their LOGICAL
 *  id (the handle WorldBuilder.note() returns); the applier resolves each to the note's real
 *  id/title/class AFTER the timeline replays. A retrieval with no hits is a zero-result MISS
 *  — the blind-spot signal the Sessions overview headlines. */
export type RetrievalDecl = {
  /** The username whose audit this belongs to; defaults to the bound session owner or
   * primary owner. When sessionRef is present, an explicit value must match it. */
  owner?: string
  /** The token that made the call (`pat:<name>:<id>` | `oauth:<appName>` shorthand for a
   *  declared connected app | `ui`), remapped to the seed user like every principal — the
   *  "which agent" lens. */
  principal: string
  /** Friendly agent name shown in the audit (a PAT name / connected-app name), e.g. "CLI".
   *  At runtime this is captured from the live token; a case supplies it directly. */
  agent?: string
  /** Optional episode snapshot. Absent means this row belongs to Outside sessions. */
  sessionRef?: string
  sessionAttach?: 'declared' | 'inferred'
  tool: 'search' | 'recall' | 'get_note'
  /** The search/recall query, or the get_note ref. */
  query: string
  /** The project handle the call narrowed to (display only), or absent for a whole-reach fan-out. */
  project?: string
  /** A search's class filter, if any. */
  classFilter?: 'agent-memory' | 'user-doc'
  /** The notes the retrieval returned, best first — LOGICAL ids from note(). Empty/absent =
   *  a zero-result MISS. */
  hits?: { note: string; score?: number }[]
  /** Backdate: days before `now` (fractional allowed, for distinct ordering within a day). */
  daysAgo: number
}

/** One durable agent episode. Session ids are derived deterministically from
 * `ref` by both seed projections; `parentRef` preserves fork ancestry. */
export type AgentSessionDecl = {
  ref: string
  /** Username owner; defaults to the primary seed owner. */
  owner?: string
  name: string
  /** False for the automatic project/time label; defaults to true. */
  named?: boolean
  parentRef?: string
  createdDaysAgo: number
  lastSeenDaysAgo: number
  calls: number
  /** False seeds only durable audit snapshots, modelling a lifecycle row removed by GC. */
  retained?: boolean
  /** Explicitly selected effective role; absent means the base mode. */
  role?: string
}

/** One owned fork from the read-only built-in role catalog. The declaration
 * addresses product scopes; both seed appliers resolve them to stable ids. */
export type AgentRoleTargetDecl =
  | { kind: 'personal'; user?: string }
  | { kind: 'space'; space: string }
  | { kind: 'project'; space: string; path: string }

export type AgentRoleDecl = {
  name: string
  target: AgentRoleTargetDecl
}

/** One durable delta position. `throughNote` resolves to that note's latest
 * journal revision in the cursor project's space-wide stream after replay;
 * absent sessionRef = owner fallback, present = one episode's cursor. */
export type AgentDeltaCursorDecl = {
  /** Username owner. Omit to inherit a bound session's owner, or the primary seed
   *  owner when unbound; an explicit value must match a bound session. */
  owner?: string
  sessionRef?: string
  project: { space: string; path: string }
  throughNote: string
}

/** One durable job (#105) a case declares — a meta-DB row PLUS, for a finished
 *  export, a real archive in the artifact store under `<DATA_DIR>/jobs` (#101). Like
 *  connectedApps/retrievals it is a REAL-applier-only side-channel (the fake
 *  projection has no job layer — see docs/seeds.md).
 *
 *  EXPORT only. The applier does not fabricate any of it: it enqueues, claims, and
 *  runs the PRODUCTION export handler, so a seeded archive is a real ZIP of the seeded
 *  notes and its byte count is measured, not invented. This is the surface that shipped
 *  broken (an export died on EACCES under a green boot), so seeding it means a stand
 *  exercises the artifact path end-to-end instead of only after a manual click. An
 *  `import` job is not expressible the same way — its handler needs a `params.uploadRef`
 *  pointing at a real staged upload — so the decl does not offer a `kind` it would then
 *  have to fake by running the export handler under an import label.
 *
 *  TERMINAL states only, and that is a property of the system rather than a gap in
 *  the applier: the stand runs a live job runner, so a seeded `pending` row is claimed
 *  and completed within a poll, and a seeded `running` one is reaped as stale (its
 *  lease is backdated) and re-run to completion within a maintenance tick. A
 *  non-terminal row is therefore not a stand STATE — it is a job the stand finishes
 *  for you. Measured, not assumed: a seeded `running` export came back `succeeded`
 *  with a real artifact.
 *
 *  What the Export tab adopts on mount (`useExportJob`'s reconnect): a SUCCEEDED job
 *  with a live artifact → ready-to-download. `failed`/`canceled`/expired rows are
 *  honest history the tab does not surface — they exist for the API/list and for GC. */
export type JobDecl = {
  space: string
  /** Who enqueued it; defaults to the primary owner (remapped like every principal). */
  owner?: string
  status: 'succeeded' | 'failed' | 'canceled'
  /** Backdate: days before `now` (fractional allowed, for ordering within a day). */
  daysAgo: number
  /** The REAL params the export handler reads — scope/frontmatter/folder. */
  params?: { scope?: 'user' | 'all'; frontmatter?: 'keep' | 'strip'; folder?: string }
  /** Artifact TTL in days after the job finished (succeeded only). `null` = the TTL
   *  already lapsed: the applier runs the SAME clearArtifact the GC does, so the row
   *  survives as history with a dead pointer — the state a "download it later" user
   *  actually hits. Absent = the live runner's own window (`ARTIFACT_TTL_MS`), imported
   *  by the applier rather than restated here. */
  artifactTtlDays?: number | null
  /** A failed job's message (what the tab would show on a retry). */
  error?: string
}

/** A retrying durable import under `<DATA_DIR>/jobs/imports` (#191/#268):
 *  the real staged bytes PLUS their live pending meta-DB row. Real-applier only.
 *  A far-future retry keeps this state stable for backup/manual QA while exercising
 *  the same row-aware maintenance rule that protects a real interrupted import. */
export type DurableImportDecl = {
  space: string
  /** Stable job id, also used in the staged filename. */
  jobId: string
  /** Bytes are text for declarative readability; staging itself is streamed. */
  content: string
  /** Parser-facing filename stored in the real job params. */
  filename: string
  /** ISO not-before for the next retry; choose a durable future instant. */
  retryAt: string
  /** The transient failure retained on the pending row. */
  error: string
}

/** One out-of-band rewrite made directly to a seeded markdown file, after the
 *  production write timeline has populated the engine. This models the external-
 *  editor seam (#267): the real applier replaces bytes on disk and restores the
 *  original mtime, without calling a store API. Every replacement must preserve
 *  UTF-8 byte length, so size + mtime are deliberately unchanged.
 *
 *  `note` is the logical handle returned by WorldBuilder.note(). The fake
 *  projection applies the same replacements to its final snapshot so both stands
 *  show the same content, while only the real applier exercises filesystem
 *  reconciliation. */
export type ExternalRewriteDecl = {
  note: string
  replacements: Array<{ from: string; to: string }>
}

/** One deliberately-authored journal state layered on a timeline note after its
 * ordinary lifecycle. This is the neutral seed seam for restore/read edge cases
 * that a normal write cannot produce (gap, legacy body-only, opaque bytes or a
 * receipt-bound exact source). Both appliers materialize the same codec bytes. */
export type RevisionStateDecl = {
  /** Logical note handle returned by WorldBuilder.note(). */
  note: string
  date: CaseDate
  kind?: 'write' | 'delete'
  principal?: string
  title?: string
  state:
    | { kind: 'gap' }
    | { kind: 'legacy'; content: string }
    | {
        kind: 'document'
        source: { encoding: 'utf8' | 'base64'; data: string }
        role?: 'generic' | 'skill-root' | 'skill-auxiliary' | 'opaque'
        pathFallbackTitle?: string | null
        skillDirectoryName?: string
        /** Claims are bound to deterministic synthetic receipt evidence; values
         * alone never manufacture ownership proof. */
        ownerClaims?: Array<{
          key: 'notarium-id' | 'notarium-created'
          ownership: 'value' | 'entry'
        }>
        generatedContainer?: boolean
      }
}

/** One CROSS-SPACE id collision written straight onto disk after the production
 *  write timeline (#327): `note`'s `notarium-id` frontmatter is replaced with the
 *  id `claimFrom` actually got, so two spaces' files claim one id — the shape a
 *  copied vault folder produces, and the one that used to make ownership depend
 *  on the poll order. Real applier only: the ids are not known until the timeline
 *  has run, and both are the same length, so the rewrite preserves size + mtime
 *  exactly like ExternalRewriteDecl.
 *
 *  The FAKE stand shows the converged end state (two distinct ids) and does not
 *  simulate the race — a fixture has no arbiter to run.  */
export type ExternalIdentityClaimDecl = {
  /** The claimant: the file whose frontmatter is overwritten. */
  note: string
  /** The note whose durable id the claimant will (wrongly) claim. */
  claimFrom: string
}

/** One operation on a note, at a chosen instant. `noteId` is a LOGICAL handle
 *  that correlates a note's create→edit→delete→restore across the timeline; the
 *  real applier maps it to the note's real `notarium-id` after the first create.
 *  Chronology is authored via `date` — the appliers sort by it. */
export type AgentWriteAuditDecl = {
  /** Defaults to the bound session owner or primary owner; an explicit value must
   * match a bound session. */
  owner?: string
  agent?: string
  sessionRef?: string
  sessionAttach?: 'declared' | 'inferred'
}

export type CaseEvent = (
  | {
      op: 'create'
      /** A fixture-pinned physical note id — see NoteDecl.id. */
      physicalId?: string
      date: CaseDate
      space: string
      noteId: string
      /** Space-relative storage path (e.g. `research/finding-01.md`); the folder
       *  and filename fall out of it. */
      path: string
      title: string
      content: string
      tags?: string[]
      noteType?: string
      class?: CaseNoteClass
      /** Agent-memory `summary` frontmatter (#21) — a one-line category digest. */
      summary?: string
      /** Agent-memory `muted` opt-out (#165) — kept in the audit, dropped from the
       *  eager profile. */
      muted?: boolean
      /** Pin the note: adds the #165 `always-load` tag (the pult's local context pin) AND a
       *  #42 favorite. The tag is what the agent-context pult renders as a Pinned row. */
      pin?: boolean
      /** Frontmatter the note ARRIVED with, as bare YAML lines without the `---`
       *  fences (#280) — an imported file's own keys, which Notarium keeps because
       *  they are the author's data. The two appliers reach it by their own routes:
       *  the REAL one through the production `WriteInput.frontmatter` channel, the
       *  FAKE one through `NoteSnapshot.frontmatter` → `InMemoryStore.load` (a
       *  fixture is a snapshot, not a replayed write). Both must land the SAME note.
       *  canon: docs/seeds.md */
      frontmatter?: string
      /** Journal attribution (#12): `user:<name>` | `pat:<name>:<id>` | `ui`. */
      principal?: string
    }
  | {
      op: 'edit'
      date: CaseDate
      space: string
      noteId: string
      content?: string
      title?: string
      tags?: string[]
      /** Raw authored frontmatter patch, using the same merge channel as an
       * external/imported Markdown edit. Enables metadata-only history states. */
      frontmatter?: string
      principal?: string
      /** Seed this revision as a journal GAP (#327) — the state a settled
       *  cross-space collision leaves behind. Only the FAKE stand can honour it: a
       *  quarantine is decided inside the real meta-DB's settlement transaction, so
       *  the real applier replays an ordinary edit and lets the arbiter reach the
       *  same row itself. canon: docs/seeds.md */
      unavailable?: boolean
    }
  | { op: 'delete'; date: CaseDate; space: string; noteId: string; principal?: string }
  | { op: 'restore'; date: CaseDate; space: string; noteId: string; principal?: string }
) & { agentAudit?: AgentWriteAuditDecl }

/** Where seeded context facets attach: a user's Personal scope, a Project, or one exact
 * owned role placement. Role targets deliberately reuse AgentRoleTargetDecl so a
 * same-name Personal/Space/Project fork receives an independent preset. */
export type ContextSetAttachDecl =
  | { kind: 'personal'; user: string }
  | { kind: 'project'; space: string; path: string }
  | { kind: 'role'; name: string; target: AgentRoleTargetDecl }

/** A seeded context set (#209): a named cross-space collection of notes (referenced by
 *  their LOGICAL note ids from `b.note(...)`), homed in a space, attached to scopes.
 *  Real-stand only — the fake fixture carries no stable note ids to reference. */
export type ContextSetDecl = {
  homeSpace: string
  name: string
  items: string[]
  attach?: ContextSetAttachDecl[]
}

/** A seeded LOOSE cross-space pin (#209): one note (LOGICAL id) pinned directly into a
 *  scope — the sibling of a set, without a name. Cross-space when the note's home space
 *  differs from the scope's (the point). Real-stand only, like context sets. */
export type ScopePinDecl = {
  note: string
  attach: ContextSetAttachDecl
}

/** One entry of a seeded scope order (#210): a note (its LOGICAL id) or a set (by its NAME —
 *  set ids are minted at apply, so the seed references the name). */
export type ContextOrderEntryDecl = { kind: 'pin'; note: string } | { kind: 'set'; name: string }

/** A seeded per-scope pin+set order (#210): the entries in the desired order, bound to a
 *  scope. The applier resolves each note→real id and each set name→real set id, then writes
 *  the order overlay. Real-stand only (references logical ids / set names post-apply). */
export type ContextOrderDecl = {
  scope: ContextSetAttachDecl
  entries: ContextOrderEntryDecl[]
}

/** A seeded favorite (#42) — a starred note / folder / project — so the merged
 *  Files section's favorites lens (#245) has real data to exercise the rail
 *  Files↔Favorites invariant. `ref` correlates to the entity: a note's LOGICAL id
 *  (the `note()` handle), or a folder / project space-relative PATH. The REAL
 *  applier resolves it to the entity's real id and writes the favorites facet
 *  (lazily minting a plain folder's identity, exactly like the server's add-to-
 *  favorites path). The FAKE projection is a documented follow-up — e2e/visual seed
 *  favorites through the live API instead (see docs/seeds.md, mirrors connectedApps). */
export type FavoriteDecl = {
  space: string
  kind: 'note' | 'folder' | 'project'
  /** note → logical noteId (from `note()`); folder/project → space-relative path. */
  ref: string
}

export type CaseWorld = {
  /** The determinism anchor: the case's "today". Fixed so a re-seed is byte-stable
   *  (visual snapshots) and the heatmap's window is reproducible. */
  now: string
  spaces: SpaceDecl[]
  projects?: ProjectDecl[]
  /** Named cross-space context sets (#209) + their scope attachments. */
  contextSets?: ContextSetDecl[]
  /** Loose cross-space pins (#209): individual notes pinned into a scope from another space. */
  scopePins?: ScopePinDecl[]
  /** Per-scope user-defined pin+set order (#210) — order = load priority. */
  contextOrder?: ContextOrderDecl[]
  auth?: AuthDecl
  /** Chronological note operations (the appliers sort defensively). */
  events: CaseEvent[]
  /** Starred entities (#42/#245) — real applier only (see FavoriteDecl). */
  favorites?: FavoriteDecl[]
  /** Agent-retrieval audit rows (#243) — a meta-DB-only side-channel written by the real
   *  applier after the timeline replays (so `hits` note-ids resolve). Absent = none. */
  retrievals?: RetrievalDecl[]
  /** Durable agent episodes, projected to both the fake and real meta-DB. */
  agentSessions?: AgentSessionDecl[]
  /** Owned role packages copied from the built-in catalog. */
  agentRoles?: AgentRoleDecl[]
  /** Owner/session delta positions, resolved against real journal revisions. */
  agentDeltaCursors?: AgentDeltaCursorDecl[]
  /** Durable job rows + their artifacts (#105) — real applier only, written after the
   *  timeline replays (a seeded export archives the notes it just seeded). Absent = none. */
  jobs?: JobDecl[]
  /** Retrying durable imports: staging bytes + live pending rows (#191/#268), real only. */
  durableImports?: DurableImportDecl[]
  /** Same-size, mtime-preserving direct file rewrites (#267). */
  externalRewrites?: ExternalRewriteDecl[]
  /** Exact/legacy/gap/opaque journal states shared by fake and real appliers. */
  revisionStates?: RevisionStateDecl[]
  /** Cross-space `notarium-id` collisions planted on disk (#327), real applier only. */
  externalIdentityClaims?: ExternalIdentityClaimDecl[]
}

/** What a case's `build` receives: a seeded RNG (reproducible), a scale knob
 *  (multiplies generated volume — the CLI's `SCALE`), the fixed `now`, and the
 *  content locale (the CLI's `LOCALE`). Only cases whose CONTENT is authored per
 *  language read `locale` — today that is the demo case (#256), whose bundles
 *  live in `test/cases/demo/`; every other case ignores it and stays English. */
export type BuildCtx = {
  rng: Rng
  scale: number
  now: Date
  locale?: string
}

export type CaseSpec = {
  name: string
  description: string
  /** The product axes this case drives — the coverage matrix's columns. The
   *  coverage test asserts every registered case declares at least one, and that
   *  every axis is covered by at least one case. */
  axes?: Axis[]
  build(ctx: BuildCtx): CaseWorld
}

/** A small seeded PRNG surface (see rng.ts) — deterministic given the CLI's
 *  `SEED`, so a generated case reproduces exactly. */
export type Rng = {
  /** A float in [0, 1). */
  next(): number
  /** An integer in [min, max]. */
  int(min: number, max: number): number
  /** A uniformly-picked element. */
  pick<T>(items: readonly T[]): T
  /** True with probability `p`. */
  bool(p: number): boolean
}
