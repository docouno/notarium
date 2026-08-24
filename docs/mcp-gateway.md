# Notarium MCP gateway — the contract for agents (#21)

The canon of the agent contract (#21). This is Notarium's **semantic MCP gateway**: one endpoint, twenty-eight intent-oriented tools through which an AI agent reads and writes the knowledge base — instead of direct calls to the storage engine. The tool spec (names/signatures/rationale) — the toolset-v1 spec from the gateway tool-design spike; the note ontology (classes, what goes where) — [docs/note-model.md](note-model.md#note-ontology); the threat model — the agent-security threat model from that same spike. Here — how to use it.

Why a gateway and not "just give the agent the engine." Direct access to the storage engine hands the agent generic CRUD with no boundaries: no token scope, no provenance, no poka-yoke on class/visibility, and — most importantly — it assembles the "lethal trifecta" (private data × untrusted note content × an outbound channel). The gateway gives a narrow intent set where each axis of the trifecta is broken by construction (see "Security"). This is not a wrapper for convenience — it is a trust boundary.

## Connection <a id="connect"></a>

- **Endpoint:** `POST /mcp` — the streamable-HTTP transport of the official `@modelcontextprotocol/sdk`, stateless (a fresh server per request, scoped to the token), one JSON response (not SSE). `GET`/`DELETE` → `405` (no server-initiated streams). Compatible with the Claude API MCP connector and any HTTP-MCP client.
- **Authentication:** `Authorization: Bearer <pat>`. A PAT is minted in the UI (the tokens section) or via `POST /api/me/tokens` (needs the `self:manage` scope). Without a valid token in `password` mode — `401`, **with no** SYSTEM fallback (an agent must present a token).
- **Web UI claude.ai / chatgpt.com (custom connector):** there you cannot paste a PAT — only OAuth. Notarium ships a thin **OAuth 2.1 facade** (#96, [docs/mcp-oauth.md](mcp-oauth.md)): a `401` on `/mcp` returns `WWW-Authenticate` with discovery (RFC 9728/8414), `/oauth/authorize` (login with our session + consent) → `/oauth/token` (PKCE S256) issues a token mapped to the same principal. CIMD-first + a DCR fallback. In `none` mode there is no facade — the server is added as an authless connector.
- **Token scope = the agent's ceiling.** A read-only PAT sees 11 tools; a write PAT sees all 28. Write tools do not "appear and refuse" on read credentials — they are absent. A PAT's grant set = the spaces the agent can reach; another space is unreachable in principle.
- **`none` mode** (desktop/dev, an explicit operator opt-out): a single SYSTEM principal, no auth — same as REST there.
- **`initialize`** returns the server `instructions` (the main lever for call order) — static text; note content is **never** mixed into it (anti tool-poisoning).
- **Tool arguments are closed objects.** `tools/list` publishes `additionalProperties:false` for every input. The SDK validates that same complete Zod object before the gateway callback, including nested and batch-item objects; an unknown field returns an MCP tool result with `isError:true` and an `invalid arguments` message. No session binding, retrieval audit, deduplication, revision, or note/folder mutation runs for that call. Authentication happens first, so a valid PAT/OAuth credential may still update its `lastUsedAt` heartbeat.

## Twenty-eight tools <a id="tools"></a>

The names/descriptions the agent sees in `tools/list` are static and live in [descriptions.ts](../packages/server/src/services/mcp/descriptions.ts). A summary:

**Bootstrap**
- `start_session` — call it **first** in a new session. It opens/resumes an agent episode and, when one episode binds unambiguously, returns `session.id`; retain that id and pass it as the top-level `session` argument on every later session-aware tool. In one round-trip it also returns the user profile (always-load), accessible projects and, with a `project` hint, a **compact index** of the project (a note count + top-level folders — enumerate via `list_notes`), the bound episode's own delta of changes since its last visit and `knownValues`. Without a bound episode (including ambiguous name matching), the delta follows the owner fallback. The delta is SPACE-WIDE and a **journal gap** (`unavailableReason`) travels in it like any other entry — it counts toward `total`, holds its place in the cursor, and keeps its location fields absent when the note has no current path; `recent_activity(project)` alone narrows by the current path ([identity](core.md#identity)). `acknowledge:false` peeks without advancing but still freezes a bound episode's independent starting position. An acknowledge advances the bound episode plus its owner fallback, or only that fallback when no episode binds; every write is monotonic, so a slower, older concurrent response cannot rewind the next delta window. Not calling it just means less context: the other tools work on their own. Curating WHAT lands in `profile.alwaysLoad`/`project.alwaysLoad` — the Agents → Context section ([docs/projects.md](projects.md#init-context-curation)): manual pins in place (`always-load`), **context sets + cross-space loose pins** and muting memory. A generic pin/set item that resolves to an ability package (`class: skill`) stays visible in the human REST preview but is omitted item-by-item from the MCP bundle; the set and its ordinary note items remain.
  Its `abilities` section contains compact activation-ready summaries of the roles and standalone
  skills effective for that caller — Owned placements plus the System supply; Catalog never reaches
  an agent. Pass `role` to activate one role
  in the same call. Its exact owned placement also selects the role context preset (a System role
  is not placed, so it owns no preset and its slice is empty);
  `activeRole.context.alwaysLoad` carries the role-only loaded refs before the base context.
- `list_abilities` — paginated role/skill discovery. `view:runtime` returns one by-name winner in
  the effective context; `view:authoring` returns every addressable System/Owned candidate with an
  opaque `ref`, including disabled, shadowed and out-of-reach entries. `project` selects resolution
  context; `kind`/`source`/`q` filter it. Follow `nextAction` exactly until it disappears.
- `use_role` — activate one effective role and load its instructions plus linked Agent Skills under
  `budgetTokens`. Use the same project handle as `start_session` so
  `Project > Space > Personal` precedence resolves identically. Repeating the selected name is an
  idempotent success, but resolves and reloads the effective package because a narrower fork may
  now win; an unknown or catalog-only name reports the roles actually available. `context` returns
  the same role-only always-load slice plus `replacement`, the complete surviving base profile and
  optional project slice. It replaces the base from `start_session`; omitted refs were evicted by
  the role-first shared-budget scan.
- `use_skill` — load one standalone effective skill without changing the selected role or durable
  episode state. `skill` is the canonical selector; `name` is the same compatibility alias that
  `use_role` offers, and callers provide exactly one. It fails closed instead of truncating when
  the body exceeds its runtime budget.
- `whoami` — who I am and what I may do (principal-id, the read|write ceiling, project memberships) + the engine's `capabilities` (`vector`/`trash`/`revisions`) — so as not to probe blindly.
- `get_my_projects` — the list of accessible projects with their slugs (for the `project` argument — do not guess the slug). The personal domain is **not** in the list (it is implied by the token).

**Discover / navigate**
- `list_notes` — `ls` of the knowledge base: the direct notes and subfolders of a folder (deterministic, paginated). `project` picks a space and narrows to it; `path` is a **space-relative** folder (take the `path` from a `folders` entry / a hit verbatim, do not construct it) — without it, the project root. `tag` filters by a tag. Returns `items` (direct notes: id/title/path/tags) + `folders` (direct subfolders with a subtree count) + an honest `total`; page with `cursor`/`nextCursor`. Lists the user-visible notes (not agent-memory — for it use `search`).
- `recent_activity` — the most recently edited notes (absolute freshness from the journal) — "what was touched lately, needs a review." This is **not** the delta from `start_session`: that delta follows a bound episode cursor, or the owner fallback when no episode binds; `recent_activity` ignores either cursor and always shows the latest changes. `project` narrows it; without it, the freshest across the whole reach. Each entry: who (`principal` — human/agent), how (`kind`), where (`path`/`project`), when (`modifiedAt`). `truncated:true` — there was more. An entry may instead be a **journal gap** (`unavailableReason`, a neutral title, `principal: null`): the change is real, its content and author are withheld because a cross-space id collision contaminated the note's chain ([identity](core.md#identity)). Such an entry carries no current path, so a `project` narrow keeps it only when that project IS the space root; under a sub-project it drops out — placing a path-less change in a subtree would be a guess, and the narrow is a filter on where a note is now, not on where it might have been.

**Read / recall**
- `search` — hybrid search (semantics + lexical via RRF, #81) over the reachable knowledge, with an honest degradation to FTS when the vector channel is unavailable. **It also covers the agent's own agent-memory** (#102): "search before writing" now dedupes memory too (the only class without title-collision dedup) — **always search before writing**. `project` narrows it to a project (its notes + its memory); without it, the whole reachable scope plus the personal domain. `class` filters by kind (`agent-memory` — only memory, `user-doc` — exclude it). Returns ranked snippets with a `score` and `path` (where it lives), not full notes.
- `get_note` — a full note by ref (a note-id from `search`/`recall` or an in-space wiki-ref). Returns the content, frontmatter, `path` (where it lives — for talking to a human in folder terms; reference it by id anyway), `class` (a read-only label for the model), `versionToken` (return it in `edit_note`/`create_note`/`remember_*` for a safe write) and `provenance` (who/how/when edited it). In `detailed` (the default) also: `outline` (the headings — the menu of valid `section` values for `edit_note.replaceSection`) and `links` (the graph edges `outgoing`/`incoming` — for reorg and "what points here"; in v1 `relation` = the graph edge type, not the authored label — that lives in the body, typed edges → #66).
- `recall` — assemble a context bundle under a token budget around a topic: the relevant notes **plus** their graph neighbors (`depth` hops). Richer than `search`. It pulls from knowledge **and** from personal memory. `budgetTokens` bounds the size; `maxPerSource` is the token ceiling for a single note (by default = half the budget: one large note does not eat the whole bundle, the neighbors fit).

**Write / intent**
- `get_ability` — authoring read by opaque `ref`: complete instructions, enabled/placement state and
  role attachment health. Owned carries `availability` and a CAS `versionToken`; System is read-only;
  Catalog is rejected.
- `create_ability` — create a custom role or skill at Personal/Space/Project (roles only) placement.
  Role attachments are skill refs. `idempotencyKey` replays a durable success by stable package id
  before mutable attachment resolution or package construction; a rejected attempt releases the key.
  Reusing the key with a changed canonical request reaches the durable fingerprint conflict instead
  of being hidden by the gateway cache.
  Space reach is reserved in its exact final mode before publication and finalized with the actual
  note identity inside the same admission as the required first revision, so an error never reports
  failure after exposing an addressable package.
- `edit_ability` — one ordered, resumable patch across authored document, home, availability and
  enabled state. Authored fields require CAS; each attempted step is `applied|skipped|failed` and a
  retry uses the returned current ref/token. A stale token wins over mutable attachment failure and
  yields the `get_ability` remediation. An apparently already-applied document is recognised before
  mutable attachment resolution, but `skipped` is committed only after its exact identity/token is
  rechecked inside the note mutation claim and package authority; its physical write callback is not
  invoked. A changed token conflicts, while a changed document still reaches the final storage CAS.
- `delete_ability` — move an Owned package to Trash. For this RC the agent path accepts only a
  package containing exactly one regular, direct `SKILL.md`. Any auxiliary member — Markdown,
  hidden, nested, alternate-case, symbolic-link, or non-Markdown — fails closed and directs the
  caller to Agents UI. The single tombstone is a required append: if it cannot commit after the
  atomic detach, the package is reattached and the tool returns an error. System and Catalog cannot
  be deleted. Human package delete keeps its existing multi-file behaviour.

All four authoring consumers use one stale-ref authority. With no placement-trail row, the exact
input address is current. Any recorded row retires that spelling before it is read, even if a new
package has occupied the old path; the recorded target is accepted only when kind, package, Space,
the physical owner claim and projected registry note identity each match their own recorded value;
claim arbitration may make those values different. The first admitted read captures immutable
package bytes plus both identities, and the exact note id is checked under that admission. Detail
and dependency projection use the snapshot after release, without recursively entering the fair
package gate. An authored write then follows the canonical `mutation claim → placement/package`
order and revalidates both identities around the physical CAS write; metadata updates, move and
delete revalidate at their own mutation checkpoints. A human package-root delete additionally
requires the same root note id to remain among the directory victims at detach.

Ability package roots do not pass through the generic id-addressed MCP note door. `get_note`,
`edit_note`, `delete_note`, `move_note`, `rename_note`, link sources/targets (including batch and
inline links), and MCP context pin/set projection reject or omit `class: skill` and direct the caller
to `get_ability`/`edit_ability`/`delete_ability`. Access is resolved first, so an unreachable package
still answers with ordinary 404 semantics. `edit_note` performs this preflight before both durable
and in-flight idempotency replay. This is transport-level poka-yoke and package-integrity protection,
not a credential boundary: the human-compatible REST note write remains available to the same
write PAT.
- `create_note` — create a **new shared (KB) note** in a project: class `user-doc` (visible to the user). `project` — a handle from `get_my_projects`; `body` (Markdown) **titles the note** — its leading `# H1` is the title (#156); `title?` is optional — if set, it wins and strips a duplicating leading `# title` from the body (do not write the title both as a field and as the first line); a note with no title and no first line — a rejection. `path?` — the destination folder: a project-relative folder (`research/arch`) OR a space-relative folder `path` from `list_notes` verbatim (#102 — the server does not double the project prefix). For a non-root project, do not prepend a `space/project` handle to the relative form: when those first two normalized segments resolve to the selected project, the call fails before mutation. A root project keeps the collapsed grammar. A real handle-like subfolder remains addressable through its exact space-relative `list_notes` path; escape hatch — `type?`/`tags?`. **Phase-4 channels:** `links?` — typed edges FROM the note in the same write (`{relation, to}` by id or `{relation, toTitle}` a forward-ref by title, including to a not-yet-created one); `createdAt?` (ISO) — the date of the real event (an import), not of the write moment; `fileName?` — the file name (without `.md`) independent of the title. Additive: a title collision is an error, then `edit_note` — no longer a per-tool guard but the create default every channel now shares ([note-model.md](note-model.md#create-collisions)). The response echoes the derived `title` + `path`/`space`/`outcome`/integrity + `warnings` (e.g. `possible-secret` — non-binding, does not block the write). The agent does **not** choose the class/space (poka-yoke is imposed by the tool). To create **many** notes at once — `create_notes`.
- `remember_about_user` — record a **durable fact about the user** (preferences, context, current work) into their private agent-memory. Append an observation (`observation`) under a `category` (a label, not a path). Optionally `summary` — a one-line category digest for the profile. Not for transient state and not for shared project knowledge.
- `remember_about_project` — record the **agent's private memory ABOUT A PROJECT** (class `agent-memory`, symmetric to `remember_about_user`; **not** shared knowledge — for that use `create_note`). `project` — a handle, `observation` + `category` (a label), optionally `summary`. The agent does **not** choose the class/folder/space (poka-yoke).
- `edit_note` — edit an existing note incrementally (prefer this over a full rewrite). Five word-based addressing modes, **by words, not by positions** (#102 phase 3): `append`/`prepend` (additive), `replace` (the whole body — a full rewrite), `replaceSection` (by a heading; the valid menu — `get_note.outline`), `findReplace` (an exact unique snippet; **an empty `content` = delete the snippet**). **Memory is just a note:** to correct/delete a single fact = `edit_note` by the memory note's id with the same modes (`findReplace` of its text, an empty `content` to remove; or `replace` a category). Return the `versionToken` from `get_note` (CAS) — on a conflict an honest "re-read and retry" error. A live edit echoes the `path` + the result's integrity (`bodyBytes`/`bodyHash`) — to confirm a large edit without a re-read.
- `delete_note` — move a note **to the trash** (#79): the agent's only destructive tool, **reversible by construction** — the deletion is journaled (#12), the note falls into the space's trash, from where the **user** restores it (the agent cannot; restore/purge are human actions; this is exactly the line "the agent does nothing irreversible"). `ref` — a note-id (first `search`/`list_notes`). Works on any reachable note, **including its own agent-memory** (deleted memory is visible in the trash flagged "memory"). To remove **part** of a note — not `delete_note` but `edit_note` (`findReplace` with an empty `content` / `replaceSection`).
- `link` — a typed link `from`→target, `relation` — a short label. The target is **either** `to` (the note-id of an existing note), **or** `toTitle` (a forward-ref by title: link to a not-yet-created note — it resolves automatically once a note with that title appears; a staged migration does not lose edges). An existing target is materialized as the reserved stable-ID envelope plus a readable title alias, so the selected note survives rename and same-title ambiguity. Alias metacharacters `& [ ] < >` are entity-encoded by the shared core grammar; body rendering restores the exact visible title such as `[MCP] Review` while the address remains the selected id. Forward references remain human-name links until they resolve and bracket-title `toTitle` stays outside this contract. `toTitle` must be non-empty and must survive wikilink normalization unchanged: it cannot start with the reserved `notarium-id:` namespace or end in the storage suffix `.md`, because those spellings cannot denote the eventual human-title note. Both notes in **one** space (cross-space — later, #66). Idempotent by exact case-sensitive ID for existing targets (including a safe upgrade from a legacy plain-ID link to its canonical envelope) and by the shared name key for forward refs; a stale identity envelope never suppresses a distinct human forward reference, and malformed reserved targets compare exactly. To create **many** links at once — `link_many`.

**Reorganize** (`delete_note` above). The reorg tools' grammar is `verb_entity`: a **note** is addressed by id, a **folder** by a space-relative `path` (as `list_notes` returns it; the optional `project` picks a space, without it — the personal domain), a **project** by a handle.
- `move_note` — move a note to another folder, **keeping its name**. `ref` — a note-id; `toFolder` — the **space-relative** destination folder: take the folder's `path` as `list_notes` returns it (do NOT construct the path by hand), `''` — the space root; a missing folder is created. The id and the `/n/<id>` URL are stable, **inbound links do not break** (a link by title does not depend on the folder) — only the location changes. The note stays in its space. To change the title — `rename_note`, the body — `edit_note`, to move a whole **folder** — `move_folder`. Idempotent: a move to where the note already sits is a no-op.
- `rename_note` — change a note's **title** (which also drives the file name). `ref` — a note-id, `title` — the new title. The id and URL are stable; **link-safe**: the old title goes into the alias history (#100), so inbound `[[Old Title]]` keep resolving — **the bodies of linking notes are not touched** (the resolver works, not a rewrite). `versionToken` is **not needed** — the tool reads the note itself; if it is edited in parallel — an honest conflict error, retry. The folder is changed by `move_note`, the body by `edit_note`, the whole note is removed by `delete_note`.
- `move_folder` — move a **whole folder** (with its contents) under a different parent, **keeping its name**. `folder` — the folder's `path` from `list_notes` (do NOT construct by hand); `toFolder` — the destination parent (`''`/`/` — the root; a missing one is created); `project?` — the space selector (a handle from `get_my_projects`; without it — the personal domain). The id and URL of all notes inside are stable, inbound links do not break (#100 phase 3 writes the folder's path history). To rename a folder in place — `rename_folder`. Idempotent.
- `rename_folder` — change a **folder's name** in place (the contents travel with it). `folder` — a `path` from `list_notes`; `name` — the new name (the name only, **not a path** — a path is `move_folder`); `project?` — the space selector. If the folder is a marked **project**, its files travel but the handle **does not change** (for the handle — `rename_project`).
- `rename_project` — change a project's **handle and/or human name**. `project` — the current handle (from `get_my_projects`; a former handle also resolves). `slug?` — the new addressable handle (`space/<slug>`) and/or `displayName?` — the human name (at least one). **Link-safe:** the old handle goes into an alias — everything that addresses by it keeps resolving (#100 phase 2). It changes the project's **identity**, not where its folder lives (for the folder — `move_folder`/`rename_folder`). A root project by handle = the space name cannot be renamed (that is a space rename — a human action).

**Scale / graph** (phase 4 — migration scale)
- `create_notes` — create **several** KB notes in one project in a single call (migration/import: otherwise dozens of `create_note`). `project` is shared, `notes[]` — each item like `create_note` without its own `project`. **Best-effort, non-transactional:** `results[]` marks each note with `index`+`title` and `ok:true` (+echo) or `ok:false`+`error` — retry **only** the failures. Inline `links` may forward-ref notes created **later in the same batch** (by `toTitle`).
- `link_many` — create **several** typed links in one call (edges are small and numerous — the biggest round-trip win). `links[]` — each `{from, relation, to|toTitle}` like a single `link`. Best-effort (`results[]` with `ok`/`error` by `index`). Idempotent; links from one `from` note are applied in one write.

## Working conventions <a id="conventions"></a>

- **Order.** `start_session` (optionally with `role`) → retain its `session.id` → pass it to every later tool → follow `nextAction`/page with `list_abilities` when discovery is incomplete → activate a matching `use_role`/`use_skill` → survey with `list_notes`/`recent_activity` → `search`/`recall` before writing → use note or ability authoring tools.
- **Loop guard.** A consecutive `search` or `recall` with identical arguments in one episode is rejected with an output-shaped empty `structuredContent` plus guidance to reuse the prior response's `noteId`/source ids through `get_note`. Change the arguments or use that result; another intervening **session-aware** call (including `start_session`) permits an intentional later refresh. The owner-only `whoami`/`get_my_projects` calls do not attach to or mutate an episode and therefore do not reset its guard.
- **Identity is the note-id, not the path.** The id is stable across rename/move; pass exactly it into `get_note`/`edit_note`/`link`, not the title and not the path.
- **CAS on writes.** `edit_note` requires the `versionToken` from a fresh `get_note`; a concurrent edit → `versionConflict` (the tool does not overwrite silently — the agent re-reads and retries).
- **Personal domain ⟂ project.** The agent's memory — about the user (`remember_about_user`) and about a project (`remember_about_project`) — always lands in agent-memory (hidden from discovery, visible to the user in a separate section). Shared knowledge (`create_note`) goes to the named project (class `user-doc`). The agent does not decide "where" — the tool does.
- **Memory = one file per category = just a note.** `remember_about_user(observation, category)` appends to the category's file; `category` is a label ("preferences"), **not a path**. `summary` feeds the derived profile index. To correct/delete a single recorded fact — `edit_note` by `noteId` (which `remember_*` returns): `findReplace` of the fact's text (an empty `content` to remove) or `replace` of the whole category. There is **no** separate "observation addressing" by id — memory is edited with the same word-based modes as any note (#102 phase 3).
- **Honest truncation.** Bundles (`start_session`, `recall`) under a budget set `truncated:true` — top up via `search`/`get_note`.

## Agent episodes <a id="agent-sessions"></a>

An episode belongs to the authenticated **username**, not to one PAT/OAuth token. `owner` is an
internal persistence key derived from that authenticated username; the agent never sends it. Its id is
`ses_` plus twelve URL-safe characters. `start_session.session` addresses either `{id}` or a
non-unique human `{name}`: no name match creates; one sleeping match resumes; one active match
forks with `parentId`; multiple matches return up to ten matching retained choices and require an id. Names
are sanitized before they return to the agent. The first Markdown response line carries the id
instruction so it survives compact clients.

With no address, `start_session` resumes the exact one active episode when that choice is unique.
With zero active episodes it creates an auto-named personal/project episode (`named:false`). With
two or more it also creates a fresh auto-named episode, but returns the recent alternatives so the
agent can explicitly switch by id instead of guessing.

Every tool except `whoami` and `get_my_projects` is session-aware. On an ordinary call an explicit
id is owner-checked and touched; an unknown or foreign id is a tool error. With no id, the gateway
attaches only when exactly one active episode exists — the exact-one decision and touch are one
atomic persistence operation. Batch tools bind once at the top level, never once per item.

Active means seen in the last two hours. Rows are retained for thirty days. General recent choices
cover the last 24 hours; same-name ambiguity returns the matching retained rows even when older,
so it is always resolvable. Both are capped at ten. There is deliberately no close operation. The
transport's stateless HTTP session remains unchanged: this is a transport-independent core
service carried through `Ctx.session`, ready for future chat callers. A host without a meta-DB
degrades honestly: `start_session` omits the session fields and other tools silently ignore the
argument.

Every successful episode create, touch or role mutation emits the owner-scoped named SSE nudge
`agent-sessions` on that owner's live tabs, independent of which Space each tab is viewing. Global
retention pruning returns every owner whose rows were removed and nudges each of them, including
when the triggering call then exits with a missing or ambiguous session. The event carries no
snapshot: `GET /api/me/agent-sessions` remains truth. `SyncProvider` advances the same typed
revision on every successful EventSource connection, reconciling mutations missed while the tab
was disconnected. The Agents Explorer invalidates only its Sessions dataset, without broad
store-event invalidation or a page reload.

An episode stores at most one selected role name plus its exact System/Owned locator and the project
context in which that selection was made. `null` is the base mode; there is no synthetic base role.
Selecting a role never changes grants or token scope. `use_role` resolves against the effective set
— Owned libraries narrowest-first, then the shipped System package as the final fallback — and only
then persists the exact winner. A repeated name returns `already_active`, but still reloads the
effective package.

The episode separately stores a sticky `project_id`. Only `start_session(project)` writes it;
`use_role`, `use_skill`, and `list_abilities` read it when their own `project` is absent, while an
explicit argument wins without rewriting the hint. A resume without `project` preserves it, a fork
inherits it, and a deleted or no-longer-readable project degrades to Personal resolution. Responses
say when the hint supplied the context, because episodes belong to the owner username rather than
one transport connection: parallel agents under the same owner may intentionally share and replace
the same hint. `start_session` reloads a saved role only when its exact binding is still valid in
that effective context; otherwise it returns base mode with typed remediation instead of silently
dropping or rebinding the role.

The selected owned placement also resolves an optional context preset from the three meta-DB
facets (`contextSets`, `scopePins`, `contextOrder`). Curation is one strict-prefix scan:
`Role → Project → Personal` under `Q`, or `Role → Personal` under `P`; there is no role budget.
`start_session.activeRole.context` exposes the role slice beside the already re-curated top-level
base bundle. A later `use_role.context` exposes that role slice plus `replacement`, the full
surviving base after joint dedup/trim; callers replace the earlier base rather than append another
P/Q allowance. A resumed session rehydrates both instructions and preset. A host without those
meta-DB facets returns an empty preset while the role package remains usable.

### Delta positions

When an episode binds, the `start_session` delta is scoped by `(session.id, project.id)`. Its first
call materializes an independent position even for `acknowledge:false`, so one episode can never
consume another one's window. A new root episode starts at the owner's latest acknowledged
position for that project; it does not replay changes already consumed by a previous episode. A
fork inherits the parent episode's materialized position instead, falling back to the owner
position only when the parent has never touched the project. Restoring an existing episode
continues from its own position. A call that binds no episode uses the owner/project fallback.

With a bound episode, acknowledging advances its position and the owner fallback in one meta-DB
transaction. Both writes are monotonic, so an older concurrent response cannot rewind either
cursor. Without a bound episode, only the owner-scoped fallback advances. The revision stream
itself remains space-wide: project selection chooses a cursor partition, not a narrower journal
query. Session positions cascade with their retained episode row; owner fallbacks survive episode
retention and are removed with their project. This state is meta-DB-only and does not violate the
Markdown source-of-truth boundary.

## Abilities <a id="roles"></a>

The packaged inventory contains separate immutable System and Catalog sources alongside writable
Owned libraries. System abilities are effective by default; Catalog packages are read-only
discovery templates and never participate in effective resolution. A bounded Owned
package is one valid `<note-id>/SKILL.md` plus optional `references/`, `scripts/`, and `assets/`;
the immutable directory and materialized `notarium-id` are storage identity, while manifest
`name` remains editable. The human `Add` copies every package member into `.notarium/skills`,
recording `notarium.origin` and `notarium.originRevision` in `SKILL.md`. Auxiliary package members
remain byte-identical, while the manifest is deliberately rewritten with that provenance. The server never executes package scripts. Tool activation
loads only the role and linked-skill instructions; resource delivery to clients remains a separate
progressive-disclosure channel. Complete package bytes are nevertheless present in workspace
`scope=all` export, so a client can download a ready Agent Skill without a converter. Export keeps
the entire owned package byte-for-byte even when note frontmatter stripping is requested. The owned copy
is never overwritten by a later catalog release. Add publishes a package into its library atomically, so
an occupied target — a complete package, an empty or partially restored directory, a file, a symlink — is
reported as a conflict and left byte-for-byte intact, never replaced.

**Where a package may be installed is a property of the deployment, and it is answered before
the Add.** Both library listings carry `installAvailability`: roles return
`{ personal, projects }`, keyed by project handle, while skills return `{ personal, spaces }`,
keyed by space slug. A client therefore offers only destinations this host can publish to. The
field is optional on the wire and
a missing field or key reads as unavailable, so an older response fails closed. A role is TWO
placements, its package and the home its linked skills live in, and a target is offered only
when both are publishable. A direct POST to an unavailable target answers `503` with reason
`role_install_unavailable`, before a personal space is minted or a byte is staged; the same
typed answer covers a commit the medium refuses on one pathname, and in either case nothing was
published there. It is not a rollback of the whole request: linked skills already published for
this role stay, and a retry reuses them rather than forking a second copy.

Roles may be owned at Personal, Space, or Project placement, with human effective precedence
`Owned Project > Owned Space > Owned Personal > System`; their Project packages live under the reserved
`.notarium/skills/_projects/<encoded-project-id>/<package-id>/` root. Adding a Catalog role targets
a Personal or Project home only — a Space is not an Add destination for a role, and the request
schema rejects it — so a shared default is reached by authoring one or by moving a project role up,
not by a copy. Skills have only Personal or Space homes, and a Catalog skill adds to either. Personal skills are private and available across the owner's project contexts. A Space
skill has one meta-DB policy, either `all-projects` or a stable project-id allowlist; the same package
can therefore be used in projects A/B and remain absent from C. There is no Project-owned skill
fallback. Agents → Abilities exposes a role-first routed switch and exact source-specific detail
routes. Its central library spans every readable home; the separate Explorer projection is scoped
to the current Space before the location cap and groups placements rather than creating another
Files tree. There is deliberately no mutable server-global scope. The configured
library mount may itself be a symlink, but its library-owned `_projects` namespace and encoded
Project root must be real directories; role Add fails before sweeping or writing a package if either
path is a symlink or another entry type.

Catalog role manifests keep portable name links. System roles carry exact System links. During Add
the server resolves each Catalog dependency,
publishes or reuses its Personal/Space owned fork, applies the Space availability binding, and
rewrites the role to an exact locator containing home scope,
package id, and a display-only label. Owned activation follows only that locator: rename preserves
the link, deletion produces an observable missing dependency, and a same-name replacement is not
silently adopted; a Space locator also fails closed outside its availability policy. Human REST
addresses an ability by an opaque encoding of the exact source/kind/package/location locator: one
detail route plus the compound `save` and legacy `enabled`, `availability`, `versions` and `home`
mutations hang off it. Existing legacy mutations keep their wire, while the editor uses only `save`.
System and Owned preferences are owner-scoped, default-enabled sparse overrides; Catalog is
not toggleable. Role health reports each exact attachment and activation fails closed on any
missing, disabled, unavailable, malformed, or wrong-kind dependency. Runtime resolution preserves
that typed reason plus server-computed remediation through the MCP boundary: disabled and
out-of-reach candidates retain their opaque authoring ref, System failures never suggest an Owned
edit, and unreadable packages remain indistinguishable from absence. The MCP role surface is
name-backed and serves the same effective set as the human one — Owned placements plus the System
supply, never a Catalog template — so all three agent doors report an effective System role with
`source: system` and no scope. Durable sessions additionally store the exact System or Owned locator,
the project context in which it was selected, and an independent sticky project hint. Same-context
resume survives rename; a context change, inactive binding or missing package resumes in base mode
with an actionable diagnostic and without same-name rebinding.

Role/skill discovery is bounded at both agent and settings surfaces. `start_session.abilities` has a separate
1,000-token summary budget — a summary is the machine name, the human title, the sanitized
description and source/scope, and all fields are charged against it — and raises `abilitiesTruncated:true`
when summaries were abbreviated,
omitted, or an owned-library bound was reached; continue with paginated `list_abilities`. Explicit
activation still resolves any known effective name directly, outside the discovery window, and
loads it through its own budget. The self-management `GET /api/me/agent-roles` and
`GET /api/me/agent-skills` collections share strict `q`, `source`, `home`, `availability`, `project`,
`spaceId`, `limit`, and opaque `cursor` query fields; `spaceId` is applied BEFORE the location cap,
which is what lets a scoped surface list its own Space whole instead of competing for one bounded
scan ([navigation.md](navigation.md#agents-shell-and-explorer)). They return `items` discriminated by `source` across
all three — `system`, `catalog`, `owned` — plus `filteredTotal`, `nextCursor`, and accessible-only
facets. Ordering is deterministic across duplicate
names and cursors are bound to the complete query. Discovery still scans at most 128 readable
locations and exposes at most 128 writable Project choices; `truncated:true` reports that lower
bound independently from page pagination. Create/Add waits for the ordinary note projection before
returning the exact package id. Role and Skill roots use the same typed edit/rename, whole-package
Trash delete, and strict restore path; catalog entries remain read-only until Add creates a fork.

Custom creation is a restart-recoverable cross-system transaction, not a file write followed by
best-effort metadata. The server records an ability-specific operation, stages `SKILL.md` through
the storage adapter's durable strict-publication protocol, publishes under placement admission,
then commits the settled identity, attributed origin revision, exact Space reach and operation
result in one SQLite/PostgreSQL terminal transaction. A lost acknowledgement replays that terminal
result; an interrupted physical publication is resumed before public admission on restart. The
derived engine adopts the same receipt and owner proof before ordinary reconciliation, so the
publication cannot return later as a second anonymous `external` revision. `packageId` remains the
runtime/authoring address even when global identity arbitration gives the journal note a different
`noteId`.

Committed create replay is decided before mutable role attachments are reopened. The request
fingerprint is derived from the stable MCP request, while resolved labels and eligibility belong to
the miss path. Rejected operation rows remain observable but do not own the success-only key. The
same-kind System-name refusal is an MCP caller policy persisted with durable evidence; human REST
keeps its established ability to author Personal or Project overrides, and cross-kind names remain
independent.

## Security (why the set is exactly this) <a id="security"></a>

- **The trifecta is broken by construction.** `openWorldHint:false` on **all** tools (no outbound channel). No cross-space `link`/copy (internal exfiltration — #66). The agent's destructive action is only **reversible**: `delete_note` sends to the trash (#79, the user restores), the irreversible `purge`/restore are a human (#102 phase 3 replaced the old "no delete" with "the agent does nothing **irreversible**" — this is about breaking the trifecta, not narrowness for its own sake). Container reorg (`move_folder`/`rename_folder`/`rename_project`) — `space:write`; renaming a **space** is not given to an agent (a human action).
- **Scope — on every call.** `tools/list` is filtered by the token's ceiling; `tools/call` additionally checks `can(principal, action, {space})`. A denial = 404 semantics (anti-enumeration), not 403. Before either domain path, the MCP SDK rejects unknown input fields against the complete registry schema; the gateway parses the same schema again as defence in depth for direct callers.
- **Untrusted content is defanged on output.** Title/snippet/content/frontmatter are sanitized before being handed to the agent; pseudo-control tags are neutralized. Note content is **never** reflected into tool descriptions / the server `instructions`.
- **Errors are explicit, not reflected.** An expected ability/auth refusal reaches MCP only through the symbol-backed client-failure projection (`not-found`, safe conflict, or safe actionable guidance). A raw domain/storage `Error.message` is never treated as client-safe because it happens to carry a legacy marker; the same rule applies inside `edit_ability.steps[]`. Unclassified failures are logged server-side and become opaque `internal error`. Human REST keeps its existing status/reason mapping.
- **Provenance for free.** Every write carries the `principal` (from the PAT) into the journal #12 — per-agent attribution; `get_note`/`recall` can return who edited (human vs agent).
- **Session audit (#243, #321).** Read tools (`search`/`recall`/`get_note`) are logged at the `gateway.callTool` checkpoint **fire-and-forget** (without affecting latency/correctness) — query/scope + the top hits with `score` → the owner-scoped meta-DB facet `agent_retrievals`. When an episode is bound, the row also snapshots its id/name and whether the attachment was declared or inferred. Agent writes keep the same snapshot in the revision journal; there is no parallel write log. These snapshots intentionally survive session-row GC, so Agents → Activity can show a unified read/write timeline for retained and archived episodes. Activity without a bound episode remains visible under `Outside sessions`. The tool contract does not change — this is server-side observation, not a tool.
- **Ability authoring.** Owned agent mutation requires a write-ceiling credential and a writer grant at the resolved home. The existing human Enable/Disable door is narrower state, not authoring: a reader may change only their owner-scoped preference for an exact readable Owned or System ability. System is readable only through `get_ability`; MCP create refuses a same-kind System name, while the unchanged human REST create policy may author an Owned override. Catalog is absent from MCP authoring. Generic MCP note/link/context doors exclude `class:skill`, while the human-compatible REST note door remains open — this is package-integrity poka-yoke, not a credential boundary.

## Known v1 limitations <a id="limits"></a>

Ability v1 has no `add_ability`/Catalog channel, no cross-space package move and no agent repair for
malformed legacy attachment tokens. The RC `delete_ability` contract is temporarily narrower than
the human package door: it accepts only one regular direct `SKILL.md` and refuses every auxiliary.
Full agent deletion of Markdown packages is POST-RC because it requires an exact detach roster plus
one atomic required tombstone batch across SQLite, PostgreSQL and in-memory persistence; a sequential
`recordRequired` loop is not atomic. A standalone `use_skill` is task-local and is not persisted on
the episode; bodies over the runtime activation budget are refused whole, never sliced.

Fixed by phase: coarse `recall` ranking (hybrid+hop+community; PPR/cross-encoder — later), `link` resolves the target by slug(title) (a durable typed-edge-by-id = #66), cross-space links/recall unavailable (#66), `idempotencyKey` dedup is per principal+tool, vector/hybrid are implemented (#81: a hybrid RRF over FTS5+vec0, degradation to FTS as a capability). #102 phase 2: `get_note.links.relation` = the graph edge type (in v1 the graph is mono-typed `links-to`; the authored label lives in the body, typed edges → #66) — the structure (who links to whom) is exact; `get_note.outline` lists the headings, but `edit_note.replaceSection` addresses the FIRST of same-named ones (duplicate headings are unresolvable in v1) and matches against the raw body (the outline is over the body without frontmatter: they coincide on real notes, diverging only on a pathological YAML-`#`-comment); `list_notes` lists the visible notes (user-doc; for agent-memory — `search`), the `type`/`class` facets and `recent_activity.since` are deferred (a frontmatter-/time-scan of the journal; additive later), the tag filter is exact up to ~1000 direct notes of a folder; `list_notes`/`recent_activity` under a project filter by a label over a window (the journal is not path-indexed — an honest `truncated` on an under-fill, conservative in fan-out). #102 phase 3: `delete` sends to a single trash (notes + memory, marked with `class`); the agent does **not** restore and does **not** purge (a human via UI/REST). Memory is edited like an ordinary note — there is no separate observation addressing by id (deliberately: "memory is just a note", editing with the word-based modes of `edit_note`); `replace` overwrites the whole body (CAS-protected); deleting a snippet (`findReplace` with an empty `content`) heals the seam but multiplies blocks only if the fact itself is multi-line. The `bodyHash` echo on an edit = the hash of the body we wrote (for `replace` the agent reproduces from its own `content`; for the surgical modes — a size confirmation, the engine may strip a leading fm/`# title` on store, as with `create_note`). #102 phase 4: a batch (`create_notes`/`link_many`) is **best-effort, non-transactional** — a failed item does not roll back the rest (`results[].ok/error`, retry only the failures); `create_note.bodyHash` hashes the **sent** `body`, not the final body with inlined `links` (edges are provenance from the gateway, verified via the graph/`get_note`); a forward-ref `toTitle` is materialized as `[[title]]` and resolved by slug(title) once the target appears — **durability on a target rename is given by #100** (the alias history), not by phase 4; `knownValues.relations` is **removed** (the v1 graph is mono-typed, the real relation vocabulary → #66); `warnings:['possible-secret']` is a heuristic on credential patterns (narrow, misses/false positives possible), non-binding; `createdAt` is the date channel (no `modifiedAt`: `modified` is always the real mtime by design). #102 phase 5: `move` takes a **folder** (`toFolder`, not a full path) and keeps the file name — changing the name is `rename`; both operations are within their own space (move is id-addressed, another space is inexpressible; a cross-space move = #66); the destination is cleaned by `safeRelPath` at the gateway (fail-closed: `..`, absolute, the dot-namespace `.notarium` — rejected), and moving an agent-memory note across a mount is rejected by the engine already; `move` does not break inbound links because they are **by title** (a path-form `[[folder/note]]` is rare; the durability of folders on their rename = the #100 phase 3 / phase 6 gate); `rename_note` is link-safe via the alias history (inbound `[[Old Title]]` resolve, bodies are not touched), `versionToken` is not needed (the tool reads the note itself — an internal read+CAS-write catches a parallel edit as a conflict, but does NOT protect against silently overwriting someone's parallel `rename_note`: the old name still goes into an alias then, the links stay intact). #102 phase 6: **name normalization to `verb_entity`** — the note reorg is renamed `move→move_note`/`rename→rename_note`/`delete→delete_note` (aligned with `create_note`/`get_note`/`edit_note`; the only pre-GA breaking rename, serverInfo 0.7.0); the grammar is chosen by an evidence base (an external survey of production MCP + our canon: `verb_entity` dominates, the "bare=note" asymmetry is contraindicated, an action-enum/polymorphic-ref hurt mid-tier models — see the toolset-v2 tool-naming convention). Container reorg: `move_folder`/`rename_folder` — **one engine primitive** `store.move(isDirectory)` (move changes the parent, rename the leaf; there is no separate folder-rename in the engine) + server-side path history (#100 phase 3 `recordFolderRename` + `renamePrefix` for the rows of projects under the folder) — the orchestration is the same as REST `/move-folder`; addressing is **entity-native** (note=id, folder=`path`+a `project?` space-selector, project=handle — a folder-id is lazy/server-side, we do not expose it in listings so as not to breed false uniformity); `rename_project` = an O(1) alias write of the slug (#100 phase 2), `slug?`+`displayName?` (at least one — validated in the handler so the agent receives the domain-specific guiding error), a root project = the space name cannot be renamed (`root`→error), a collision/`not_found` — guiding errors; everything is gated by `space:write`, cross-space is inexpressible by construction, **renaming a space is NOT a tool** (a human action, poka-yoke). #156: **body-first title** (serverInfo 0.8.0, additive) — `create_note`/`create_notes` `title` is now optional (the title = the leading `# H1` of the body; an explicit `title` wins and strips a duplicate leading `# title`), the echo returns the derived `title`; normalization is at a single write checkpoint, so a duplicate h1 does not reach the disk by any path (neither create nor edit/replace). The full decision/review log — the recap comments #21 (v1), #102 (v2), #156 (body-first title).

**`idempotencyKey`, simultaneously (#341).** The key collapses not only a repeat that arrives after the first call recorded, but a twin running at the same instant in the same process: the second joins the attempt already in flight instead of performing its own write, and answers the same shape a sequential replay does — same `noteId`, `outcome: 'skipped'`, no fresh echo. Without that join the two failure modes are tool-specific and none of them is a duplicate the client can see: `remember_*` records the observation twice, `create_note` answers its own retry with `note_already_exists`, `edit_note` either applies the append twice or refuses the loser with `version_conflict`. A joiner inherits the runner's outcome **including its failure** — a visible error it did not cause is the deliberate trade against a silent double write; the key is not burned by it (only a successful write is recorded), so the client's own retry goes through. The base scope is per **principal+tool**; target-sensitive tools add a `scopeKey` (`edit_note` uses its note ref, project writes use their project). That binding prevents a legacy replay for one note/class from escaping through a different note that merely passes the current preflight. Without a meta-DB only the durable half degrades: a later replay writes again, a simultaneous one still collapses. Both generic halves are per-process — two server processes on one data root can run one key twice. Custom ability creation is the exception: its ability-specific operation row arbitrates the success key and request fingerprint across processes and restart.
